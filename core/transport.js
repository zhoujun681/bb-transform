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
  const HEADER_BYTES = 21;

  // Tuning overrides remain available for diagnostics. Defaults adapt to the
  // sender: constrained/mobile devices keep small queues, while desktop
  // Chromium can keep a larger LAN pipe full.
  const T = (typeof window !== 'undefined' && window.BT_TUNING) || {};
  const MiB = 1024 * 1024;

  function detectProfile() {
    if (typeof navigator === 'undefined') return 'constrained';
    const memory = Number(navigator.deviceMemory || 0);
    let mobile = null;
    if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
      mobile = navigator.userAgentData.mobile;
    } else if (navigator.userAgent) {
      mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    }
    if (mobile === true || (memory > 0 && memory <= 4) || mobile === null) return 'constrained';
    return 'desktop';
  }

  function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
  }

  const PROFILE = detectProfile();
  const PROFILE_FRAME = PROFILE === 'desktop' ? 256 * 1024 : 128 * 1024;
  const DEFAULT_HIGH_WATER = PROFILE === 'desktop' ? 12 * MiB : 4 * MiB;
  const DEFAULT_LOW_WATER = PROFILE === 'desktop' ? 3 * MiB : 1 * MiB;
  const HIGH_WATER = clampNumber(T.highWater, DEFAULT_HIGH_WATER, 1 * MiB, 16 * MiB);
  const LOW_WATER = Math.min(
    clampNumber(T.lowWater, DEFAULT_LOW_WATER, 256 * 1024, 8 * MiB),
    Math.max(256 * 1024, HIGH_WATER / 2)
  );
  // `chunk` remains a payload-byte override for backward compatibility.
  const LOCAL_MAX_FRAME = clampNumber(
    T.chunk ? Number(T.chunk) + HEADER_BYTES : PROFILE_FRAME,
    PROFILE_FRAME,
    16 * 1024,
    256 * 1024
  );

  let dcByPeer = new Map(); // peerId -> RTCDataChannel
  const capsByPeer = new Map(); // peerId -> negotiated/advertised transfer caps
  let onEnvelope = null; // (env, fromPeerId) => void  for JSON messages
  let onFileMeta = null;
  let onFileChunk = null;
  let onFileEnd = null;
  let onFileCancel = null;
  let onChat = null;

  // incoming file reassembly: fileId -> { meta, chunks:[], received }
  const inbound = new Map();
  // outbound state: fileId -> { aborted, abortResolvers:Set }. Each receiver has
  // its own pump and can be waiting on backpressure independently.
  const outbound = new Map();

  function registerChannel(peerId, dc, capabilities) {
    dcByPeer.set(peerId, dc);
    capsByPeer.set(peerId, { ...(capsByPeer.get(peerId) || {}), ...(capabilities || {}) });
    dc.binaryType = 'arraybuffer';
    // Backpressure: tell the channel to fire 'bufferedamountlow' once the
    // queued bytes drain below LOW_WATER, so the active pump can refill the
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
    capsByPeer.delete(peerId);
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
    const caps = capsByPeer.get(fromId);
    if (caps) {
      capsByPeer.delete(fromId);
      capsByPeer.set(toId, caps);
    }
  }

  function setPeerCapabilities(peerId, capabilities) {
    if (!peerId || !capabilities) return;
    const prev = capsByPeer.get(peerId) || {};
    const next = { ...prev };
    const maxFrameBytes = Number(capabilities.maxFrameBytes);
    const maxMessageSize = Number(capabilities.maxMessageSize);
    if (Number.isFinite(maxFrameBytes) && maxFrameBytes >= 16 * 1024) {
      next.maxFrameBytes = Math.min(maxFrameBytes, 256 * 1024);
    }
    if (Number.isFinite(maxMessageSize) && maxMessageSize > 0) {
      next.maxMessageSize = maxMessageSize;
    }
    capsByPeer.set(peerId, next);
  }

  function localCapabilities() {
    return { profile: PROFILE, maxFrameBytes: LOCAL_MAX_FRAME, highWaterBytes: HIGH_WATER };
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
      try {
        dc.send(JSON.stringify(env));
        return true;
      } catch {}
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

  function drainGate(dc, ob) {
    return new Promise((resolve) => {
      if (dc.readyState !== 'open' || dc.bufferedAmount <= HIGH_WATER) {
        return resolve(dc.readyState === 'open');
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (dc.onbufferedamountlow === onLow) dc.onbufferedamountlow = null;
        if (dc.removeEventListener) dc.removeEventListener('close', onClose);
        ob.abortResolvers.delete(finish);
        resolve(!ob.aborted && dc.readyState === 'open');
      };
      const onLow = () => finish();
      const onClose = () => finish();
      ob.abortResolvers.add(finish);
      dc.onbufferedamountlow = onLow;
      if (dc.addEventListener) dc.addEventListener('close', onClose, { once: true });
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

  function effectiveChunkSize(peerId) {
    const caps = capsByPeer.get(peerId) || {};
    const remoteFrame = Number(caps.maxFrameBytes) > 0 ? Number(caps.maxFrameBytes) : 128 * 1024;
    const sctpFrame = Number(caps.maxMessageSize) > 0 ? Number(caps.maxMessageSize) : 256 * 1024;
    const frameSize = Math.max(16 * 1024, Math.min(LOCAL_MAX_FRAME, remoteFrame, sctpFrame, 256 * 1024));
    return Math.max(1024, frameSize - HEADER_BYTES);
  }

  function makeFrame(file, fileIdBytes, seq, chunkSize) {
    const offset = seq * chunkSize;
    const end = Math.min(offset + chunkSize, file.size);
    const header = new Uint8Array(HEADER_BYTES);
    header[0] = LAYER_FILE;
    header.set(fileIdBytes, 1);
    header[17] = (seq >>> 24) & 0xff;
    header[18] = (seq >>> 16) & 0xff;
    header[19] = (seq >>> 8) & 0xff;
    header[20] = seq & 0xff;
    return { frame: new Blob([header, file.slice(offset, end)]), bytes: end - offset };
  }

  // ---- file send (one independent backpressure pump per open peer) ----
  // fileId is an OPTIONAL caller-supplied id (pre-generate via randomFileId) so
  // the caller can wire a cancel button BEFORE the pump starts. Resolves to
  // { fileId, cancelled } — cancelled is true if cancelSend(id) ran mid-transfer.
  async function sendFile(file, name, progressCb, fileId) {
    const id = fileId || randomFileId();
    const fileIdBytes = fileIdToBytes(id);
    const ob = { aborted: false, abortResolvers: new Set() };
    outbound.set(id, ob);
    try {
      const peers = [...dcByPeer.entries()].filter(([, dc]) => dc.readyState === 'open');
      const progress = new Map(peers.map(([peerId]) => [peerId, 0]));
      const emitProgress = (peerId, sentBytes) => {
        progress.set(peerId, sentBytes);
        if (!progressCb || ob.aborted) return;
        const peerProgress = [...progress].map(([id, bytes]) => ({ peerId: id, sentBytes: bytes }));
        const minSent = peerProgress.length ? Math.min(...peerProgress.map((p) => p.sentBytes)) : 0;
        progressCb({ fileId: id, sentBytes: minSent, totalBytes: file.size, peers: peerProgress });
      };

      const pumpPeer = async (peerId, dc) => {
        const chunkSize = effectiveChunkSize(peerId);
        const total = Math.ceil(file.size / chunkSize);
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
        if (!send(peerId, meta)) return { peerId, ok: false };

        let sentBytes = 0;
        for (let seq = 0; seq < total; seq++) {
          if (ob.aborted || dc.readyState !== 'open') return { peerId, ok: false };
          if (dc.bufferedAmount > HIGH_WATER && !(await drainGate(dc, ob))) {
            return { peerId, ok: false };
          }
          const built = makeFrame(file, fileIdBytes, seq, chunkSize);
          if (!(await sendFrame(dc, built.frame))) return { peerId, ok: false };
          sentBytes += built.bytes;
          emitProgress(peerId, sentBytes);
        }
        if (ob.aborted || !send(peerId, { layer: LAYER_FILE, kind: 'end', fileId: id, total })) {
          return { peerId, ok: false };
        }
        return { peerId, ok: true };
      };

      const results = await Promise.all(peers.map(([peerId, dc]) => pumpPeer(peerId, dc)));
      return {
        fileId: id,
        cancelled: ob.aborted,
        deliveredPeerIds: results.filter((r) => r.ok).map((r) => r.peerId),
        failedPeerIds: results.filter((r) => !r.ok).map((r) => r.peerId),
      };
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
      for (const resolve of [...ob.abortResolvers]) resolve();
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
  async function sendFrame(dc, frame) {
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
    try {
      const ab = await frame.arrayBuffer();
      if (dc.readyState !== 'open') return false;
      dc.send(ab);
      return true;
    } catch {
      return false;
    }
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
    setPeerCapabilities,
    localCapabilities,
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
