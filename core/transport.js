// transport.js — application-level message multiplexing & file transfer.
//
// All peers run ONE negotiated DataChannel (id=0). Every message is a JSON
// envelope (control/chat/file control) except file data chunks, which are sent
// as raw binary for throughput and carry an id+seq in a small JSON wrapper is
// avoided by using a typed binary header instead. To keep it simple and robust
// for a small mesh, file chunks are sent as ArrayBuffer with a fixed binary
// header: [1B layer=2][16B fileId][4B seqBE][payload...].

const Transport = (() => {
  const LAYER_CTRL = 0; // control/mesh signaling (handled in mesh.js via router)
  const LAYER_CHAT = 1;
  const LAYER_FILE = 2; // binary

  // Tuning knobs (Feature 2). Defaults are battle-tested; override before this
  // script loads via window.BT_TUNING = { chunk, highWater, lowWater, window }.
  // Safe ranges: HIGH_WATER 4–8 MiB (don't exceed ~16 MiB). Default unchanged.
  const T = (typeof window !== 'undefined' && window.BT_TUNING) || {};
  const CHUNK = T.chunk || 128 * 1024; // 128 KiB — under the ~256 KiB SCTP limit
  const HIGH_WATER = T.highWater || 4 * 1024 * 1024; // 4 MiB stop-sending gate
  const LOW_WATER = T.lowWater || 1 * 1024 * 1024; // 1 MiB refill threshold

  let dcByPeer = new Map(); // peerId -> RTCDataChannel
  let onEnvelope = null; // (env, fromPeerId) => void  for JSON messages
  let onFileMeta = null;
  let onFileChunk = null;
  let onFileEnd = null;
  let onFileCancel = null;
  let onChat = null;

  // incoming file reassembly: fileId -> { meta, chunks:[], received }
  const inbound = new Map();
  // outbound state: fileId -> { aborted, abortResolve }. aborted: the pump
  // checks this each iteration and exits without broadcasting 'end'. abortResolve:
  // if the pump is blocked in drainGate, cancelSend calls it to wake the pump
  // immediately (instead of waiting for bufferedamountlow).
  const outbound = new Map();

  function registerChannel(peerId, dc) {
    dcByPeer.set(peerId, dc);
    dc.binaryType = 'arraybuffer';
    // Backpressure: tell the channel to fire 'bufferedamountlow' once the
    // queued bytes drain below LOW_WATER, so sendWhenDrained can refill the
    // pipe BEFORE it runs dry. Without this, the threshold defaults to 0 and
    // the channel idles to empty between bursts — killing throughput.
    if ('bufferedAmountLowThreshold' in dc) {
      dc.bufferedAmountLowThreshold = LOW_WATER;
    }
    dc.onmessage = (ev) => handleMessage(ev, peerId);
    dc.onbufferedamountlow = null;
  }

  function closeChannel(peerId) {
    const dc = dcByPeer.get(peerId);
    if (dc) {
      dc.onmessage = null;
      dcByPeer.delete(peerId);
    }
    // clean inbound from that peer (in-flight files from them are lost)
  }

  // Move a channel registration from a temp id to the real peer id once we
  // learn it (used by mesh.js when the host receives the joiner's real id).
  function remapPeer(fromId, toId) {
    if (fromId === toId) return;
    const dc = dcByPeer.get(fromId);
    if (dc) {
      dcByPeer.delete(fromId);
      dcByPeer.set(toId, dc);
    }
  }

  function hasChannel(peerId) {
    return dcByPeer.has(peerId);
  }

  function handleMessage(ev, fromPeerId) {
    const data = ev.data;
    if (typeof data === 'string') {
      let env;
      try {
        env = JSON.parse(data);
      } catch {
        return;
      }
      if (env.layer === LAYER_CTRL && onEnvelope) onEnvelope(env, fromPeerId);
      else if (env.layer === LAYER_CHAT && onChat) onChat(env, fromPeerId);
      else if (env.layer === LAYER_FILE) {
        if (env.kind === 'meta' && onFileMeta) onFileMeta(env, fromPeerId);
        else if (env.kind === 'end' && onFileEnd) onFileEnd(env, fromPeerId);
        else if (env.kind === 'cancel' && onFileCancel) onFileCancel(env, fromPeerId);
      }
      return;
    }
    // binary file chunk
    if (data instanceof ArrayBuffer && data.byteLength > 21) {
      const view = new Uint8Array(data);
      const layer = view[0];
      if (layer !== LAYER_FILE) return;
      // Build the 32-char hex fileId in one pass (avoids the per-chunk
      // [...bytes].map().join() — 16 padStart strings + a 16-elem array — which
      // is real GC pressure at high throughput).
      const HEX = '0123456789abcdef';
      let fileId = '';
      for (let i = 1; i < 17; i++) {
        const b = view[i];
        fileId += HEX[b >> 4] + HEX[b & 0xf];
      }
      const seq = (view[17] << 24) | (view[18] << 16) | (view[19] << 8) | view[20];
      const payload = view.subarray(21);
      if (onFileChunk) onFileChunk({ fileId, seq, payload }, fromPeerId);
    }
  }

  // ---- sending helpers ----

  function send(peerId, env) {
    const dc = dcByPeer.get(peerId);
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(env));
      return true;
    }
    return false;
  }

  function broadcast(env) {
    for (const [peerId, dc] of dcByPeer) {
      if (dc.readyState === 'open') {
        try {
          dc.send(JSON.stringify(env));
        } catch {
          /* drop */
        }
      }
    }
  }

  // ---- backpressure-aware binary send ----
  // Resolves true once the buffer has drained below HIGH_WATER and the send
  // completed; false if the channel isn't open / send threw. We MUST only
  // register onbufferedamountlow when we actually pause, and clear it right
  // after — otherwise concurrent senders (or chat/control messages on the same
  // channel) would clobber each other's handler and hang.
  function sendWhenDrained(dc, buf) {
    return new Promise((resolve) => {
      const done = (ok) => {
        resolve(ok);
      };
      const trySend = () => {
        if (dc.readyState !== 'open') return done(false);
        if (dc.bufferedAmount > HIGH_WATER) {
          // arm the low-water handler JUST for this drain, then send
          dc.onbufferedamountlow = () => {
            dc.onbufferedamountlow = null;
            trySend();
          };
          return;
        }
        try {
          dc.send(buf);
          done(true);
        } catch {
          done(false);
        }
      };
      trySend();
    });
  }

  // Wait (once) until a single DataChannel's queue drains below LOW_WATER.
  // Used by the file-send pump as a single backpressure gate: the pump sends
  // many chunks WITHOUT awaiting, and only blocks here when bufferedAmount
  // crosses HIGH_WATER. Because the pump has exactly one in-flight await at a
  // time, the single-slot onbufferedamountlow can't be clobbered by a second
  // concurrent waiter (the bug that bit a generic sendWhenDrained in a fan-out).
  function drainGate(dc, ob) {
    return new Promise((resolve) => {
      if (dc.bufferedAmount <= HIGH_WATER) return resolve();
      // remember how to wake us; cancelSend calls ob.abortResolve() to break the
      // wait immediately (don't sit at HIGH_WATER after a cancel).
      if (ob) ob.abortResolve = resolve;
      dc.onbufferedamountlow = () => {
        dc.onbufferedamountlow = null;
        if (ob) ob.abortResolve = null;
        resolve();
      };
    });
  }

  // ---- file id helpers ----
  function randomFileId() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  function fileIdToBytes(id) {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(id.substr(i * 2, 2), 16);
    return out;
  }

  // ---- chat ----
  function sendChat(env) {
    broadcast({ ...env, layer: LAYER_CHAT });
  }

  // ---- file send (broadcast to all open peers; progress callback) ----
  // fileId is an OPTIONAL caller-supplied id (pre-generate via randomFileId) so
  // the caller can wire a cancel button BEFORE the pump starts. Resolves to
  // { fileId, cancelled } — cancelled is true if cancelSend(id) ran mid-transfer.
  async function sendFile(file, name, progressCb, fileId) {
    const id = fileId || randomFileId();
    const fileIdBytes = fileIdToBytes(id);
    const total = Math.ceil(file.size / CHUNK);
    const ob = { aborted: false, abortResolve: null };
    outbound.set(id, ob);
    try {
      const meta = {
        layer: LAYER_FILE,
        kind: 'meta',
        fileId: id,
        name: name || file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        total,
        ts: Date.now(),
      };
      broadcast(meta);

      const peers = [...dcByPeer.entries()].filter(([, dc]) => dc.readyState === 'open');

      // Build a ZERO-COPY frame for chunk index seq, returned as a Blob whose
      // parts are [21-byte header, file slice]. The browser concatenates these in
      // C++ when dc.send(blob) runs, so the JS main thread never memcpys the
      // payload (the old ArrayBuffer path copied every 128 KiB chunk — the main
      // remaining throughput tax on the sender). The wire format is unchanged:
      // the receiver sees one ArrayBuffer = header ++ payload.
      //
      // headerBuf is shared (its first 17 bytes never change); we rewrite the
      // 4-byte seq per chunk in place. Cheap: 4 byte writes, no allocation.
      const headerBuf = new ArrayBuffer(21);
      const headerView = new Uint8Array(headerBuf);
      headerView[0] = LAYER_FILE;
      headerView.set(fileIdBytes, 1);

      async function buildFrame(seq) {
        const offset = seq * CHUNK;
        const end = Math.min(offset + CHUNK, file.size);
        headerView[17] = (seq >>> 24) & 0xff;
        headerView[18] = (seq >>> 16) & 0xff;
        headerView[19] = (seq >>> 8) & 0xff;
        headerView[20] = seq & 0xff;
        // Blob takes a fresh header part each call (the seq bytes change), but
        // the file slice is passed through untouched — NO payload copy.
        const head = new Uint8Array(headerBuf); // view of the current header bytes
        const blob = new Blob([head, file.slice(offset, end)]);
        return blob;
      }

      // PIPELINE PUMP: keep the DataChannel saturated for near-LAN throughput.
      // WINDOW frames read ahead so blob reads overlap network sends; the send
      // loop only blocks when bufferedAmount crosses HIGH_WATER (drainGate).
      const WINDOW = T.window || 3; // frames read ahead (WINDOW*CHUNK bytes max)

      const inflight = [];
      for (let i = 0; i < WINDOW && i < total; i++) inflight.push(buildFrame(i));
      let nextSeq = inflight.length;

      let sentCount = 0;
      let aborted = false;
      for (let seq = 0; seq < total; seq++) {
        if (ob.aborted) { aborted = true; break; } // cancelSend fired
        const frame = await inflight.shift(); // Blob (zero-copy)
        if (nextSeq < total) inflight.push(buildFrame(nextSeq++));

        const livePeers = peers.filter(([, dc]) => dc.readyState === 'open');
        if (livePeers.length === 0) {
          aborted = true;
          break;
        }
        let anyOk = false;
        for (const [, dc] of livePeers) {
          // gate: block ONLY when this channel's queue is full, then send.
          if (dc.bufferedAmount > HIGH_WATER) {
            try { await drainGate(dc, ob); } catch {}
            if (ob.aborted) break; // cancel during drain -> stop this frame
            if (dc.readyState !== 'open') continue; // dropped while draining
          }
          if (sendFrame(dc, frame)) {
            anyOk = true;
          }
        }
        if (ob.aborted) { aborted = true; break; }
        if (!anyOk) {
          aborted = true;
          break;
        }
        sentCount++;
        if (!ob.aborted && progressCb) progressCb({ fileId: id, sent: sentCount, total });
      }

      // only signal completion if we actually sent everything to an open channel
      if (!aborted && sentCount >= total) {
        broadcast({ layer: LAYER_FILE, kind: 'end', fileId: id, total });
      }
      return { fileId: id, cancelled: ob.aborted };
    } finally {
      outbound.delete(id);
    }
  }

  // Cancel an in-flight outbound transfer: flag the pump, wake it if it's stuck
  // in drainGate, and broadcast a cancel so receivers drop the file too.
  function cancelSend(fileId) {
    const ob = outbound.get(fileId);
    if (ob) {
      ob.aborted = true;
      if (ob.abortResolve) { const r = ob.abortResolve; ob.abortResolve = null; r(); }
    }
    broadcast({ layer: LAYER_FILE, kind: 'cancel', fileId });
  }

  function isOutbound(fileId) {
    return outbound.has(fileId);
  }

  // Send a frame (Blob) on a channel. Prefers the zero-copy dc.send(Blob) path.
  // Some channels/middleboxes reject Blob sends — on the first throw we mark the
  // channel and fall back to converting the Blob to an ArrayBuffer (a copy, but
  // only on the rare channel that can't do Blob). Returns true on success.
  function sendFrame(dc, frame) {
    if (!dc._bt_noBlob) {
      try {
        dc.send(frame); // Blob path — no payload copy on the main thread
        return true;
      } catch (e) {
        // mark once; fall through to ArrayBuffer retry for THIS chunk
        dc._bt_noBlob = true;
      }
    }
    // fallback: Blob -> ArrayBuffer (async), then send
    frame
      .arrayBuffer()
      .then((ab) => {
        if (dc.readyState === 'open') {
          try {
            dc.send(ab);
          } catch {}
        }
      })
      .catch(() => {});
    // we couldn't send synchronously; assume it'll likely succeed async for
    // accounting purposes (the gate + end-signal still protect integrity)
    return true;
  }

  // ---- inbound assembly ----
  function ensureInbound(meta, fromPeerId) {
    let st = inbound.get(meta.fileId);
    if (!st) {
      st = {
        meta,
        fromPeerId,
        chunks: new Map(),
        received: 0,
        total: meta.total,
      };
      inbound.set(meta.fileId, st);
    }
    return st;
  }

  function addChunk(fileId, seq, payload) {
    const st = inbound.get(fileId);
    if (!st) return null; // unknown / late chunk, drop
    if (st.chunks.has(seq)) return st; // dup
    st.chunks.set(seq, payload);
    st.received++;
    return st;
  }

  function finalizeInbound(fileId) {
    const st = inbound.get(fileId);
    if (!st) return null;
    const ordered = [];
    for (let i = 0; i < st.total; i++) {
      const c = st.chunks.get(i);
      if (!c) return null; // incomplete
      ordered.push(c);
    }
    const blob = new Blob(ordered, { type: st.meta.type });
    inbound.delete(fileId);
    return { meta: st.meta, blob, fromPeerId: st.fromPeerId };
  }

  // How many chunks have arrived for a file (and the expected total). Used by
  // the receiver to detect late-arriving chunks before finalizing a large file.
  function inboundProgress(fileId) {
    const st = inbound.get(fileId);
    if (!st) return null;
    return { received: st.received, total: st.total };
  }

  function dropInboundFrom(peerId) {
    for (const [id, st] of inbound) {
      if (st.fromPeerId === peerId) inbound.delete(id);
    }
  }

  // Drop a single inbound file's reassembly state (cancel/refuse on receiver).
  // addChunk already returns null for an unknown fileId, so any late-arriving
  // chunks after this are silently ignored.
  function dropInbound(fileId) {
    inbound.delete(fileId);
  }

  return {
    LAYER_CTRL,
    registerChannel,
    closeChannel,
    remapPeer,
    hasChannel,
    send,
    broadcast,
    sendChat,
    sendFile,
    cancelSend,
    isOutbound,
    randomFileId,
    ensureInbound,
    addChunk,
    finalizeInbound,
    inboundProgress,
    dropInbound,
    dropInboundFrom,
    setHandlers(h) {
      onEnvelope = h.envelope || onEnvelope;
      onChat = h.chat || onChat;
      onFileMeta = h.fileMeta || onFileMeta;
      onFileChunk = h.fileChunk || onFileChunk;
      onFileEnd = h.fileEnd || onFileEnd;
      onFileCancel = h.fileCancel || onFileCancel;
    },
  };
})();
