// server.js — dumb WebSocket signaling relay + static file host.
//
// Role: route control envelopes {layer:'ctrl', type, from, to, ttl, id, data}
// between connected clients so they can auto-mesh WITHOUT QR scanning.
//
// IMPORTANT: signaling is relay-only. It never inspects/forwards file or chat
// data — those travel peer-to-peer over WebRTC DataChannels. On Windows, a
// local-only HTTP endpoint can materialize a received Blob in the temp folder
// when the user explicitly copies it, so Explorer can consume CF_HDROP.
//
// Security on a trusted LAN (still applied):
//   - clients register their id; the server STAMPS `from` from the socket's
//     registered id (never trusts the client-supplied `from` -> no spoofing)
//   - maxPayload 64KB (an SDP is ~2-4KB)
//   - per-connection rate limit (~50 msg/s)
//   - ping/pong liveness, drop dead sockets
//   - malformed JSON and missing `to` are dropped

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const WindowsClipboard = require('./windows-clipboard');

const HTTP_PORT = parseInt(process.env.PORT || '8080', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '8443', 10);
// ROOT = where index.html / styles.css / app.js / core / vendor live.
//   - packaged exe (process.pkg set): same dir as the .exe (assets sit beside it)
//   - dev / Docker: project root (parent of server/)
const ROOT = process.pkg
  ? path.dirname(process.execPath)
  : path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

// ---------- static file server ----------
async function staticHandler(req, res) {
  if (await WindowsClipboard.handleRequest(req, res, ROOT)) return;

  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  // never serve server-side files
  if (urlPath.startsWith('/server/')) {
    res.writeHead(404);
    return res.end('Not Found');
  }
  let filePath = path.join(ROOT, urlPath);
  // prevent path traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // fallback to index.html (SPA-ish)
      filePath = path.join(ROOT, 'index.html');
    }
    fs.readFile(filePath, (e, data) => {
      if (e) {
        res.writeHead(404);
        return res.end('Not Found');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
}

const server = http.createServer(staticHandler);

// ---------- WebSocket signaling relay ----------
// socket <-> client id. Each ws carries its registered id as ws.__clientId.
const clients = new Map(); // clientId -> ws

function heartbeat() {
  this.isAlive = true;
}

function unregisterClient(ws) {
  const id = ws.__clientId;
  if (!id || clients.get(id) !== ws) return false;

  clients.delete(id);
  const payload = JSON.stringify({
    layer: 0,
    from: id,
    to: '*',
    ttl: 6,
    id: 'gone-' + Math.random().toString(36).slice(2),
    data: { type: 'peer-gone' },
  });
  for (const peer of clients.values()) {
    if (peer.readyState !== 1) continue;
    try { peer.send(payload); } catch {}
  }
  return true;
}

// Shared connection handler — used by BOTH the http and https WebSocketServers.
function onWsConnection(ws) {
  ws.isAlive = true;
  ws.__clientId = null;
  ws.__msgTimes = []; // rolling timestamps for rate limiting
  ws.on('pong', heartbeat);

  ws.on('message', (raw) => {
    // rate limit: >50 messages in the last 1s -> drop & warn
    const now = Date.now();
    ws.__msgTimes = ws.__msgTimes.filter((t) => now - t < 1000);
    ws.__msgTimes.push(now);
    if (ws.__msgTimes.length > 50) {
      return; // silently drop bursts
    }

    let env;
    try {
      env = JSON.parse(raw.toString());
    } catch {
      return; // malformed
    }

    // First message must register an id.
    if (!ws.__clientId) {
      if (env && env.data && env.data.type === 'register' && env.data.id) {
        const id = String(env.data.id);
        // replace any stale socket for this id
        const old = clients.get(id);
        if (old && old !== ws && old.readyState === 1) {
          try { old.close(); } catch {}
        }
        ws.__clientId = id;
        // store the display name (if provided) so roster-push can carry it —
        // otherwise members would briefly show as "未知" until a hello arrives,
        // which flickered the member list. In-memory only; never persisted.
        ws.__clientName = (env.data && env.data.name) ? String(env.data.name) : null;
        clients.set(id, ws);

        // --- Discovery race fix ---
        // Discovery is otherwise driven by client hello broadcasts on a 15s
        // timer. When two devices refresh at once, each fires its first hello
        // BEFORE the other has registered, so neither receives the other's
        // hello -> both wait up to 15s for the next tick (the ~7s first-connect
        // users saw). Fix it deterministically: on register the server hands the
        // newcomer the roster of already-registered peers, and tells each of
        // those peers about the newcomer. Both pushes reuse the 'peers' control
        // message the client already understands (handleCtrl merges it into
        // knownPeers and triggers meshGrow). from:'__server__' is inert — the
        // 'peers' handler never reads env.from. The roster carries each peer's
        // name so the member list is correct immediately (no "未知" flicker).
        // Transient snapshot only; the server still stores nothing persistent.
        const roster = [];
        for (const [cid, peer] of clients) {
          if (cid !== id && peer.readyState === 1) {
            const entry = { id: cid };
            if (peer.__clientName) entry.name = peer.__clientName;
            roster.push(entry);
          }
        }
        if (roster.length && ws.readyState === 1) {
          try {
            ws.send(
              JSON.stringify({
                layer: 0,
                from: '__server__',
                to: id, // unicast to this newcomer
                ttl: 6,
                id: 'roster-' + Math.random().toString(36).slice(2),
                data: { type: 'peers', roster },
              })
            );
          } catch {}
        }
        // tell each already-registered peer about the newcomer (unicast), so
        // discovery is independent of the newcomer's own broadcastHello.
        for (const [cid, peer] of clients) {
          if (cid === id || peer.readyState !== 1) continue;
          try {
            const entry = { id };
            if (ws.__clientName) entry.name = ws.__clientName;
            peer.send(
              JSON.stringify({
                layer: 0,
                from: '__server__',
                to: cid,
                ttl: 6,
                id: 'join-' + Math.random().toString(36).slice(2),
                data: { type: 'peers', roster: [entry] },
              })
            );
          } catch {}
        }
      }
      return; // nothing else accepted until registered
    }

    if (!env || typeof env.to !== 'string') return; // require explicit `to`

    // Stamp authoritative sender id (do NOT trust client `from`).
    env.from = ws.__clientId;

    const payload = JSON.stringify(env);

    if (env.to === '*') {
      // broadcast to everyone except sender
      for (const [cid, peer] of clients) {
        if (cid !== ws.__clientId && peer.readyState === 1) {
          peer.send(payload);
        }
      }
    } else {
      const target = clients.get(env.to);
      if (target && target.readyState === 1) target.send(payload);
    }
  });

  ws.on('close', () => {
    unregisterClient(ws);
  });
}

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
wss.on('connection', onWsConnection);

// ---------- optional HTTPS listener (enables live camera scan over LAN) ----------
// Plain HTTP disables getUserMedia, so the camera-based scanner only works on
// HTTPS / localhost. If self-signed certs are present beside the project, also
// listen on HTTPS_PORT so users can open https://<host>:8443/ for live scanning.
// (Photo-based scanning works on plain HTTP regardless — see app.js.)
let httpsServer = null;
let wsss = null;
const certPath = path.join(ROOT, '_cert.pem');
const keyPath = path.join(ROOT, '_key.pem');
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  try {
    const tlsOpts = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };
    httpsServer = https.createServer(tlsOpts, staticHandler);
    wsss = new WebSocketServer({ server: httpsServer, maxPayload: 64 * 1024 });
    wsss.on('connection', onWsConnection);
    // A bind failure (e.g. HTTPS_PORT already taken) must NOT crash the process.
    // HTTPS is optional; HTTP + photo-scan already cover plain HTTP use.
    const onHttpsListenError = (e) => {
      if (!httpsServer) return; // already handled (both server + wss fire this)
      console.warn(
        e.code === 'EADDRINUSE'
          ? `HTTPS listener disabled (port ${HTTPS_PORT} in use).`
          : 'HTTPS listener error: ' + (e && e.message ? e.message : e)
      );
      try { wsss.close(); } catch {}
      try { httpsServer.close(); } catch {}
      httpsServer = null;
      wsss = null;
    };
    httpsServer.on('error', onHttpsListenError);
    wsss.on('error', onHttpsListenError);
  } catch (e) {
    console.warn('HTTPS listener disabled (failed to read certs):', e.message);
    httpsServer = null;
    wsss = null;
  }
} else {
  console.warn('HTTPS listener disabled (_cert.pem / _key.pem not found). Live camera scan needs HTTPS.');
}

// liveness sweep
const interval = setInterval(() => {
  for (const [cid, ws] of clients) {
    if (ws.isAlive === false) {
      unregisterClient(ws);
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

wss.on('close', () => clearInterval(interval));
if (wsss) wsss.on('close', () => clearInterval(interval));

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`bb-transform server listening on :${HTTP_PORT}`);
  console.log(`  static:   http://<this-host>:${HTTP_PORT}/`);
  console.log(`  websocket: ws://<this-host>:${HTTP_PORT}/`);
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`bb-transform HTTPS listening on :${HTTPS_PORT}`);
    console.log(`  static:   https://<this-host>:${HTTPS_PORT}/  (self-signed; live camera scan works here)`);
    console.log(`  websocket: wss://<this-host>:${HTTPS_PORT}/`);
  });
}
