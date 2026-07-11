// server-signaling.js — optional server-mode transport.
//
// When the user points the page at a signaling server, this module opens a
// WebSocket to it. The server is a DUMB relay: it forwards control envelopes
// (offer/answer/hello/peers/bye) between clients by their `to` field. Files and
// chat never go through the server — they stay P2P over DataChannels.
//
// Wire-up: incoming WS messages -> Mesh.routeEnv(env, SERVER_SOURCE). Outgoing
// control envelopes that need relaying -> ServerSignaling.send(env).
//
// Lifecycle: connect with exponential backoff; on drop, DO NOT tear down
// DataChannels (they're independent) — just flip to p2p mode and keep retrying.

const ServerSignaling = (() => {
  const SERVER_SOURCE = '__server__'; // sentinel "arrivedFrom" for routeEnv
  let ws = null;
  let url = null;
  let mode = 'p2p'; // 'p2p' | 'server'
  let state = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
  let backoff = 1000;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let missedPongs = 0;
  let wantConnect = false;
  let onMessage = null; // (env) => void
  let onStateChange = null; // (state, mode) => void

  const PING_INTERVAL = 20000;
  const MAX_BACKOFF = 30000;

  function setHandlers(h) {
    onMessage = h.onMessage || onMessage;
    onStateChange = h.onStateChange || onStateChange;
  }

  function setState(s) {
    state = s;
    if (onStateChange) onStateChange(state, mode);
  }

  function connect(serverUrl) {
    url = normalizeUrl(serverUrl);
    wantConnect = true;
    backoff = 1000;
    openSocket();
  }

  // If the user opened the page FROM the server, default ws URL is the page's
  // own origin (zero-config). Otherwise an explicit host:port is required.
  function defaultUrl() {
    if (typeof location !== 'undefined' && location.protocol.startsWith('http')) {
      const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProto}//${location.host}`;
    }
    return '';
  }

  // Pick the WebSocket scheme from the PAGE's protocol so the WS actually
  // connects: an https:// page blocks insecure ws:// (mixed content), so we
  // must use wss:// there. An explicit ws:// or wss:// prefix is honored as-is.
  function schemeForPage() {
    if (typeof location !== 'undefined' && location.protocol === 'https:') return 'wss://';
    return 'ws://';
  }

  function normalizeUrl(serverUrl) {
    if (!serverUrl) return defaultUrl();
    let u = serverUrl.trim();
    if (!u) return defaultUrl();
    if (!/^wss?:\/\//.test(u)) {
      // bare host[:port] -> use the page's scheme (LAN+http -> ws, https -> wss)
      u = schemeForPage() + u;
    }
    return u;
  }

  function openSocket() {
    if (!url) {
      setState('disconnected');
      return;
    }
    setState('connecting');
    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      backoff = 1000;
      missedPongs = 0;
      // register our identity before anything else
      ws.send(
        JSON.stringify({
          layer: 0,
          from: Identity.id(),
          to: '__server__',
          ttl: 6,
          id: 'reg-' + Math.random().toString(36).slice(2),
          data: { type: 'register', id: Identity.id(), name: Identity.displayName() },
        })
      );
      mode = 'server';
      setState('connected');
      startHeartbeat();
    };

    ws.onmessage = (ev) => {
      let env;
      try {
        env = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (onMessage) onMessage(env);
    };

    ws.onclose = () => {
      stopHeartbeat();
      ws = null;
      // revert to p2p relay mode (DataChannels, if any, keep working)
      mode = 'p2p';
      setState('disconnected');
      if (wantConnect) scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow; nothing to do here
    };

    // native ping/pong via ws; browser WS has no app-level pong, so we rely on
    // the connection close for liveness. (Server-side ping sweep still runs.)
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      // browsers don't expose ping(); send an app-level noop that the server's
      // generic relay will drop (to: a sentinel nobody owns -> no delivery, but
      // the message itself exercises the socket). Cheaper: just check readyState.
      if (ws.readyState !== 1) {
        missedPongs++;
        if (missedPongs > 2) {
          try { ws.close(); } catch {}
        }
      }
    }, PING_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (wantConnect) openSocket();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  }

  function send(env) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(env));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  function disconnect() {
    wantConnect = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopHeartbeat();
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    mode = 'p2p';
    setState('disconnected');
  }

  function isServerMode() {
    return mode === 'server' && state === 'connected';
  }

  function getState() {
    return { mode, state };
  }

  return {
    SERVER_SOURCE,
    setHandlers,
    connect,
    disconnect,
    send,
    isServerMode,
    getState,
    defaultUrl,
  };
})();
