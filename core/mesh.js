// mesh.js — RTCPeerConnection management, relayed signaling, full-mesh growth.
//
// Topology: full mesh (2-6 devices). The first connection between two devices is
// established by QR/paste (Signaling). After that, a newcomer connects to ALL
// already-connected peers by relaying offer/answer through an existing channel.
//
// Glare avoidance: for any pair, the peer with the lexicographically SMALLER
// peerId creates the offer. Both sides compute this independently from the
// roster — no coordination round-trip. Perfect-negotiation rollback is used as
// a safety net for any residual collision.
//
// Control envelopes ride the same DataChannel (Transport LAYER_CTRL). Relay is
// exact-address (to: peerId) with a TTL to prevent loops. Self-describing
// offers (carry `from`) avoid registration-order races.

const Mesh = (() => {
  const DC_ID = 0; // single negotiated control+app channel
  const ICE_TIMEOUT = 5000; // watchdog; 'complete' can stall. Generous so host
                            // candidates finish collecting instead of getting
                            // snapshotted early (which yields a candidate-less
                            // SDP that never connects).
  const ICE_MIN_WAIT = 800; // don't settle for 'complete' until at least this long,
                            // AND don't bail before we have >=1 candidate.
  const RELAY_TTL = 6;

  const selfId = Identity.id();
  const peers = new Map(); // peerId -> { pc, dc, name, status }
  const knownPeers = new Map(); // peerId -> name (roster, includes not-yet-direct)

  let handlers = {
    onPeerJoin: () => {},
    onPeerLeave: () => {},
    onPeerList: () => {},
    onLog: () => {},
  };

  // pending direct-connection negotiations: peerId -> { polite }
  const pending = new Map();
  // seen control message ids (loop/relay dedup)
  const seenCtrl = new Set();
  // diagnostic: peerId -> performance.now() when first discovered (connect timing)
  const discAt = new Map();

  // record a milestone timestamp (ms since discovery) on a peer's diag object,
  // only the FIRST time it occurs. Used to pinpoint where slow connect stalls.
  function markDiag(peerId, key) {
    const p = peers.get(peerId);
    if (!p) return;
    if (!p.diag) p.diag = {};
    if (p.diag[key] == null) p.diag[key] = Math.round(performance.now() - (discAt.get(peerId) || performance.now()));
  }
  // Trickle ICE: candidates that arrived before this peer's remote SDP was set
  // (offer/answer race). Keyed by peerId; flushed in receiveOffer/receiveAnswer
  // right after setRemoteDescription succeeds.
  const pendingCandidates = new Map(); // peerId -> RTCIceCandidate[]

  function setHandlers(h) {
    handlers = { ...handlers, ...h };
  }

  // UUID-strength id (crypto.randomUUID may be gated on file://; getRandomValues is universal).
  function randomId() {
    try {
      if (crypto.randomUUID) return crypto.randomUUID();
    } catch {}
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  // ---------- ICE gathering with watchdog ----------
  // Resolve only once we have gathered at least one candidate AND either the
  // gathering completed or the watchdog fired. This prevents emitting an
  // offer/answer with an EMPTY candidate list (the classic "stuck on
  // connecting" cause: the remote gets an SDP with no reachable address).
  function gatherIce(pc, timeout = ICE_TIMEOUT) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      let done = false;
      let candidateCount = 0;
      const start = performance.now();

      const onCandidate = () => {
        candidateCount++;
      };
      pc.addEventListener('icecandidate', onCandidate);

      const finish = () => {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', onStateChange);
        pc.removeEventListener('icecandidate', onCandidate);
        resolve();
      };
      // Only finish once we actually have a candidate (so the SDP is never
      // candidate-less), or once the hard watchdog fires.
      const onStateChange = () => {
        if (pc.iceGatheringState !== 'complete') return;
        if (candidateCount === 0 && performance.now() - start < ICE_MIN_WAIT) {
          return; // too early and empty — keep waiting for a candidate
        }
        finish();
      };
      pc.addEventListener('icegatheringstatechange', onStateChange);

      // Hard watchdog: resolve no matter what after `timeout`.
      setTimeout(finish, timeout);
    });
  }

  // ---------- RTCPeerConnection factory ----------
  // DEFAULT: host candidates (LAN-direct, always gathered) PLUS a public STUN
  // server so srflx candidates are also gathered. host candidates connect two
  // LAN devices in milliseconds; the srflx candidates give ICE an extra path to
  // choose from, which on some networks yields a higher-throughput pair than
  // host-only (host-only previously picked a suboptimal pair — IPv6/virtual
  // adapter — capping throughput at ~3 MB/s).
  //
  // Why STUN is safe again: it previously slowed FIRST CONNECT because the offer
  // path waited for ICE gathering to complete. That no longer applies — trickle
  // ICE (candidates stream as gathered, connect starts on the first pair) and
  // server roster-push (deterministic instant discovery) mean connect speed is
  // independent of how long STUN takes. A slow STUN now only delays srflx
  // candidates arriving, not first connect.
  //
  // TURN (relay) is OPTIONAL for symmetric-NAT / cellular / AP-isolation /
  // cross-network cases. Enable by setting, before this script loads:
  //   window.BT_TURN = { urls:'turn:host:port', username, credential }
  const TURN = typeof window !== 'undefined' && window.BT_TURN ? window.BT_TURN : null;
  let ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    ...(TURN ? [TURN] : []),
  ];
  function setIceServers(servers) {
    if (Array.isArray(servers) && servers.length) ICE_SERVERS = servers;
  }

  // ---------- ICE reliability: restart on failure / stuck ----------
  // When ICE never connects (no usable candidate pair — restrictive NAT with no
  // TURN, or mDNS blocked), the DataChannel never opens and Transport.broadcast
  // silently drops chat/files. To recover we drive an ICE restart: the
  // lexicographically-smaller peerId re-creates its offer with {iceRestart:true}
  // (reusing the existing PC + negotiated channel) and relays it through the
  // server; the other side answers via the normal receiveOffer path
  // (perfect-negotiation rollback handles any glare). Rate-limited per peer.
  const MAX_RESTARTS = 5;       // give up after this many restart attempts
  const FAIL_RESTART_DELAY = 1500; // debounce before issuing a restart offer
  const STUCK_WATCHDOG = 25000;     // if ICE isn't connected by now, force restart
                                  // generous: TURN candidate gathering over a slow
                                  // / unreliable path can take 10-20s before ICE
                                  // checks even begin.

  // reverse lookup so ICE handlers survive a channel remap (QR tempId -> realId)
  function peerIdForPc(pc) {
    for (const [id, p] of peers) if (p.pc === pc) return id;
    return null;
  }

  function clearWatchdog(peerId) {
    const p = peers.get(peerId);
    if (p && p._watchdog) {
      clearTimeout(p._watchdog);
      p._watchdog = null;
    }
  }
  function startWatchdog(peerId) {
    clearWatchdog(peerId);
    const p = peers.get(peerId);
    if (!p || !p.pc) return;
    p._watchdog = setTimeout(() => {
      const cur = peers.get(peerId);
      if (!cur || !cur.pc) return;
      const ice = cur.pc.iceConnectionState;
      if (ice === 'connected' || ice === 'completed' || ice === 'closed') return;
      // still stuck after negotiation — escalate to a restart
      cur.status = 'failed';
      handlers.onPeerList && handlers.onPeerList();
      scheduleRestart(peerId);
    }, STUCK_WATCHDOG);
  }

  function scheduleRestart(peerId) {
    const p = peers.get(peerId);
    if (!p || !p.pc) return;
    if (p.pc.iceConnectionState === 'closed' || p.pc.signalingState === 'closed') return;
    // don't start a restart while one is already in flight (avoids the tight
    // "ICE: new" spin where gather hasn't finished before we restart again)
    if (p._restartInFlight) return;
    p.restarts = (p.restarts || 0) + 1;
    if (p.restarts > MAX_RESTARTS) {
      p.status = 'failed';
      handlers.onPeerList && handlers.onPeerList();
      handlers.onLog && handlers.onLog('直连多次失败，可能网络受限（跨网络传输请在页面配置 TURN 服务器）');
      return;
    }
    p.status = 'restarting';
    handlers.onPeerList && handlers.onPeerList();
    // only the smaller id drives the restart offer; the other side waits and
    // answers the incoming restart offer via receiveOffer (no glare storm).
    if (isOfferer(peerId)) {
      p._restartInFlight = true;
      setTimeout(() => doRestart(peerId), FAIL_RESTART_DELAY);
    }
  }

  async function doRestart(peerId) {
    const p = peers.get(peerId);
    if (!p || !p.pc) { return; }
    const pc = p.pc;
    if (pc.signalingState === 'closed') { p._restartInFlight = false; return; }
    try {
      pc.setConfiguration({ iceServers: ICE_SERVERS }); // pick up TURN if added
      pending.set(peerId, { polite: false });
      startWatchdog(peerId);
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await gatherIce(pc);
      sendCtrl(peerId, { type: 'offer', sdp: pc.localDescription });
    } catch (err) {
      handlers.onLog && handlers.onLog('ICE 重启失败: ' + err.message);
      cleanupNegotiation(peerId);
    } finally {
      // allow the next restart (e.g. when the answer comes back and ICE still
      // fails). Cleared here so we don't stack restarts while this one is mid-flight.
      p._restartInFlight = false;
    }
  }

  // Re-attempt ICE for every connection that is NOT already open. Called when
  // the user adds/changes TURN mid-session, so a fresh ICE config (with TURN)
  // is picked up immediately instead of needing a page reload.
  function restartStuck() {
    for (const [id, p] of peers) {
      if (id.startsWith('__pending__')) continue;
      if (p.dc && p.dc.readyState === 'open') continue; // already good
      // reset the restart counter so TURN gets a fair shot
      p.restarts = 0;
      scheduleRestart(id);
    }
  }

  function attachIceHandling(pc) {
    // tally candidate TYPES we gather, so the UI can diagnose *why* a direct
    // connection fails: host=LAN-reachable, srflx=public-after-NAT, relay=TURN.
    pc.__cands = { host: 0, srflx: 0, relay: 0 };
    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) return; // null = gathering complete; nothing to trickle
      const sdp = e.candidate.candidate || '';
      // candidate string contains "typ host" / "typ srflx" / "typ relay"
      const typ = /typ (host|srflx|relay)/.exec(sdp);
      const kind = typ ? typ[1] : 'host';
      pc.__cands[kind] = (pc.__cands[kind] || 0) + 1;
      // TRICKLE: forward each candidate to the peer the moment it's produced,
      // so connectivity checks can start on the first usable pair — long
      // before gathering completes. QR `__pending__` peers carry a full SDP, so
      // we skip them (no real peerId to route to yet).
      const peerId = peerIdForPc(pc);
      if (peerId && !peerId.startsWith('__pending__')) {
        markDiag(peerId, 'firstLocalCand');
        sendCtrl(peerId, { type: 'candidate', candidate: e.candidate.toJSON() });
      }
    });
    pc.addEventListener('iceconnectionstatechange', () => {
      const peerId = peerIdForPc(pc);
      if (!peerId || peerId.startsWith('__pending__')) return;
      const p = peers.get(peerId);
      if (!p) return;
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') {
        markDiag(peerId, 'iceConnected');
        clearWatchdog(peerId);
        if (p.status !== 'connected') {
          p.status = p.dc && p.dc.readyState === 'open' ? 'connected' : 'connecting';
          handlers.onPeerList && handlers.onPeerList();
        }
      } else if (st === 'failed') {
        markDiag(peerId, 'iceFailed');
        clearWatchdog(peerId);
        p.status = 'failed';
        handlers.onPeerList && handlers.onPeerList();
        scheduleRestart(peerId);
      } else if (st === 'checking') {
        markDiag(peerId, 'iceChecking');
      } else if (st === 'disconnected') {
        // transient — the browser usually recovers; watchdog escalates if not
        if (p.status !== 'failed' && p.status !== 'restarting' && p.status !== 'connected') {
          p.status = 'disconnected';
          handlers.onPeerList && handlers.onPeerList();
        }
      }
    });
  }

  function newPC() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    attachIceHandling(pc);
    return pc;
  }

  // ---------- negotiated control channel ----------
  function setupChannel(peerId, pc) {
    const dc = pc.createDataChannel('c', { negotiated: true, id: DC_ID });
    wireChannel(peerId, dc);
    return dc;
  }

  function wireChannel(peerId, dc) {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      const p = peers.get(peerId);
      if (p) {
        p.status = 'connected';
        clearWatchdog(peerId);
        // diagnostic: time from first discovery -> DataChannel open
        const disc = discAt.get(peerId);
        if (disc && !p.connectedAt) {
          p.connectedAt = performance.now();
          p.connectMs = Math.round(p.connectedAt - disc);
          handlers.onLog && handlers.onLog('直连建立耗时: ' + p.connectMs + ' ms');
        }
      }
      // exchange hello + roster immediately on every open channel
      sendCtrl(peerId, {
        type: 'hello',
        name: Identity.displayName(),
        roster: rosterArray(),
        firstHello: true,
      });
      handlers.onPeerList && handlers.onPeerList();
    };
    dc.onclose = () => handleDisconnect(peerId);
    dc.onerror = () => handleDisconnect(peerId);
    Transport.registerChannel(peerId, dc);
    const p = peers.get(peerId);
    if (p) p.dc = dc;
  }

  function rosterArray() {
    return [...knownPeers.entries()].map(([id, name]) => ({ id, name }));
  }

  // ---------- control envelope routing ----------
  function sendCtrl(toPeerId, payload) {
    const env = {
      layer: Transport.LAYER_CTRL,
      from: selfId,
      to: toPeerId,
      ttl: RELAY_TTL,
      id: randomId(),
      data: payload,
    };
    routeEnv(env, selfId);
  }

  // Flood/relay an envelope toward its destination. to:'*' => broadcast.
  // In server mode the WebSocket relay is authoritative: relay/broadcast go
  // through it (single path -> no storm). Direct peers still use DataChannels.
  function routeEnv(env, arrivedFrom) {
    if (seenCtrl.has(env.id)) return;
    seenCtrl.add(env.id);
    if (seenCtrl.size > 5000) seenCtrl.clear(); // crude cap

    const dest = env.to;
    const nextTtl = env.ttl - 1;
    const viaServer = ServerSignaling.isServerMode();

    if (dest === '*' || dest === selfId) {
      // addressed to me (or broadcast): handle locally
      handleCtrl(env);
      if (dest === selfId) return; // unicast consumed
    } else if (peers.has(dest) && peers.get(dest).dc && peers.get(dest).dc.readyState === 'open') {
      // direct delivery ONLY over an OPEN DataChannel. A peer may be registered
      // in `peers` while its DataChannel is still negotiating (e.g. we just
      // created the offer); in that case we must fall through and relay the
      // envelope through the server (server mode) or another open link (p2p),
      // otherwise the offer/answer that BUILDS that channel would be dropped.
      Transport.send(dest, { ...env, ttl: nextTtl });
      return;
    }

    if (dest === '*') {
      if (viaServer) {
        // server fans it out; don't also flood peers (avoid storm)
        if (arrivedFrom !== ServerSignaling.SERVER_SOURCE) {
          ServerSignaling.send({ ...env, ttl: nextTtl });
        }
      } else {
        // p2p: forward to all direct peers (with an OPEN channel) except source
        for (const pid of peers.keys()) {
          if (pid === arrivedFrom) continue;
          const p = peers.get(pid);
          if (p && p.dc && p.dc.readyState === 'open') Transport.send(pid, { ...env, ttl: nextTtl });
        }
      }
    } else if (nextTtl > 0) {
      if (viaServer) {
        if (arrivedFrom !== ServerSignaling.SERVER_SOURCE) {
          ServerSignaling.send({ ...env, ttl: nextTtl });
        }
      } else {
        // unicast relay: forward toward any OPEN direct link (mesh -> any helps)
        for (const pid of peers.keys()) {
          if (pid === arrivedFrom) continue;
          const p = peers.get(pid);
          if (p && p.dc && p.dc.readyState === 'open') {
            Transport.send(pid, { ...env, ttl: nextTtl });
            break;
          }
        }
      }
    }
  }

  function handleCtrl(env) {
    const d = env.data;
    let rosterChanged = false;
    switch (d.type) {
      case 'hello':
        rosterChanged |= mergeName(env.from, d.name || '未知');
        if (Array.isArray(d.roster)) {
          for (const e of d.roster) if (e.id !== selfId) rosterChanged |= mergeName(e.id, e.name);
        }
        handlers.onPeerList && handlers.onPeerList();
        // A brand-new direct peer joined: broadcast our full roster to ALL
        // existing neighbors so everyone converges (e.g. A learns about C).
        if (d.firstHello) broadcastPeers();
        meshGrow();
        break;
      case 'peers':
        if (Array.isArray(d.roster)) {
          for (const e of d.roster) if (e.id !== selfId) rosterChanged |= mergeName(e.id, e.name);
          if (rosterChanged) {
            handlers.onPeerList && handlers.onPeerList();
            broadcastPeers(); // propagate newly learned members
          }
        }
        meshGrow();
        break;
      case 'offer':
        receiveOffer(env.from, d.sdp);
        break;
      case 'answer':
        receiveAnswer(env.from, d.sdp);
        break;
      case 'bye':
        removePeer(env.from);
        break;
      case 'peer-gone':
        removePeer(env.from);
        break;
      case 'candidate':
        receiveCandidate(env.from, d.candidate);
        break;
    }
  }

  function mergeName(id, name) {
    const prev = knownPeers.get(id);
    const clean = name || '未知';
    if (!prev) {
      knownPeers.set(id, clean);
      // record when we FIRST discovered this peer, to time how long the direct
      // connection takes (diagnostic for slow first-connect). Stored in a SEPARATE
      // map so we never pollute the roster (knownPeers drives the member list +
      // meshGrow — putting timestamps there created hundreds of fake members).
      discAt.set(id, performance.now());
      return true;
    }
    // Guard against the flicker loop: a blank/'未知' name must NOT overwrite an
    // existing real name. Roster-push and peer propagation can carry unnamed
    // entries (or a peer's stale '未知' view); without this guard, real name ->
    // '未知' -> real name bounces forever, each step triggering a re-render and a
    // re-broadcast (the visible "unknown/real" flicker). Only upgrade '未知' to a
    // real name, never the reverse.
    if (clean === '未知' && prev !== '未知') return false;
    if (prev !== clean) {
      knownPeers.set(id, clean);
      return true;
    }
    return false;
  }

  // Broadcast our current roster to every direct neighbor as a fresh message.
  function broadcastPeers() {
    for (const pid of peers.keys()) {
      if (pid.startsWith('__pending__')) continue;
      sendCtrl(pid, { type: 'peers', roster: rosterArray() });
    }
  }

  // ---------- mesh growth ----------
  function isOfferer(otherId) {
    // lexicographic rule: smaller id offers
    return selfId < otherId;
  }

  function meshGrow() {
    const viaServer = ServerSignaling.isServerMode();
    for (const otherId of knownPeers.keys()) {
      if (otherId === selfId) continue;
      if (peers.has(otherId)) continue; // already direct
      if (pending.has(otherId)) continue; // in progress
      if (isOfferer(otherId)) {
        // it's my job to create the offer; I need a relay path to it.
        // In server mode the server IS the path (a single device can offer).
        // In p2p mode only proceed once we have a direct peer to relay through.
        if (viaServer || peers.size > 0) startOfferViaRelay(otherId);
      }
      // If I'm the answerer, I wait for the offer (relayed) — do nothing.
    }
  }

  // Periodic re-broadcast of hello: serves as discovery (newcomers learn us)
  // and liveness signal. Especially important in server mode where discovery
  // is proactive, not passive.
  let helloTimer = null;
  function startHelloLoop() {
    stopHelloLoop();
    helloTimer = setInterval(() => {
      if (ServerSignaling.isServerMode()) broadcastHello();
    }, 15000);
  }
  function stopHelloLoop() {
    if (helloTimer) clearInterval(helloTimer);
    helloTimer = null;
  }
  function broadcastHello() {
    for (const pid of peers.keys()) {
      if (pid.startsWith('__pending__')) continue;
      sendCtrl(pid, { type: 'hello', name: Identity.displayName(), roster: rosterArray() });
    }
    // also push a fresh hello through the server so newcomers learn us
    if (ServerSignaling.isServerMode()) {
      ServerSignaling.send({
        layer: Transport.LAYER_CTRL,
        from: selfId,
        to: '*',
        ttl: RELAY_TTL,
        id: randomId(),
        data: { type: 'hello', name: Identity.displayName(), roster: rosterArray(), firstHello: true },
      });
    }
  }

  async function startOfferViaRelay(otherId) {
    pending.set(otherId, { polite: false });
    let pc, dc;
    try {
      pc = newPC();
      peers.set(otherId, { pc, dc: null, name: knownPeers.get(otherId) || '未知', status: 'connecting' });
      dc = setupChannel(otherId, pc);
      startWatchdog(otherId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      markDiag(otherId, 'offerSent');
      // Trickle: send the offer immediately; candidates stream as they gather
      // (forwarded in attachIceHandling's icecandidate listener).
      sendCtrl(otherId, { type: 'offer', sdp: pc.localDescription });
    } catch (err) {
      handlers.onLog && handlers.onLog('offer 失败: ' + err.message);
      cleanupNegotiation(otherId);
    }
  }

  async function receiveOffer(otherId, sdp) {
    let polite = true; // answerer is polite by default under the lex rule
    // If a collision happens (we were also offering), roll back.
    const existing = pending.get(otherId);
    if (existing && !existing.polite) {
      // collision glare; the impolite side ignores. Here we are receiving an
      // offer but thought we were the offerer. Fall back to polite behavior.
      polite = true;
    }
    pending.set(otherId, { polite });

    let pc = peers.get(otherId)?.pc;
    if (!pc) {
      pc = newPC();
      peers.set(otherId, { pc, dc: null, name: knownPeers.get(otherId) || '未知', status: 'connecting' });
      setupChannel(otherId, pc);
    }
    startWatchdog(otherId);
    try {
      if (pc.signalingState !== 'stable') {
        if (!polite) {
          // impolite: ignore incoming offer
          return;
        }
        pendingCandidates.delete(otherId); // candidates were for the old remote desc
        await pc.setLocalDescription({ type: 'rollback' });
      }
      await pc.setRemoteDescription(sdp);
      markDiag(otherId, 'answerSet');
      flushPendingCandidates(otherId); // apply any candidates that beat the offer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      markDiag(otherId, 'answerSent');
      // Trickle: send the answer immediately; candidates stream as they gather.
      sendCtrl(otherId, { type: 'answer', sdp: pc.localDescription });
    } catch (err) {
      handlers.onLog && handlers.onLog('answer 失败: ' + err.message);
      cleanupNegotiation(otherId);
    }
  }

  async function receiveAnswer(otherId, sdp) {
    const p = peers.get(otherId);
    if (!p || !p.pc) return;
    try {
      await p.pc.setRemoteDescription(sdp);
      flushPendingCandidates(otherId); // apply any trickled candidates now
      pending.delete(otherId);
    } catch (err) {
      handlers.onLog && handlers.onLog('setAnswer 失败: ' + err.message);
      cleanupNegotiation(otherId);
    }
  }

  // ---- Trickle ICE: receive + flush candidates ----
  // A trickled candidate may arrive before the relayed offer/answer. addIceCandidate
  // throws InvalidStateError if remoteDescription isn't set, so buffer until it is.
  async function receiveCandidate(otherId, candidate) {
    const p = peers.get(otherId);
    if (!p || !p.pc) return; // unknown / already torn down — drop
    const pc = p.pc;
    if (!pc.remoteDescription && !pc.currentRemoteDescription) {
      let buf = pendingCandidates.get(otherId);
      if (!buf) { buf = []; pendingCandidates.set(otherId, buf); }
      buf.push(candidate);
      return;
    }
    markDiag(otherId, 'firstRemoteCand');
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // duplicate of an embedded candidate, or stale — benign, don't tear down
    }
  }

  // Apply all candidates buffered for a peer once its remoteDescription is set.
  // Capture + clear the buffer synchronously, then apply asynchronously so a
  // candidate arriving mid-flush isn't lost.
  function flushPendingCandidates(otherId) {
    const buf = pendingCandidates.get(otherId);
    if (!buf || buf.length === 0) return;
    pendingCandidates.delete(otherId);
    const p = peers.get(otherId);
    if (!p || !p.pc) return;
    (async () => {
      for (const c of buf) {
        try { await p.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
      }
    })();
  }

  function cleanupNegotiation(otherId) {
    pending.delete(otherId);
  }

  // ---------- disconnect handling ----------
  function handleDisconnect(peerId) {
    if (!peers.has(peerId)) return;
    clearWatchdog(peerId);
    Transport.closeChannel(peerId);
    const p = peers.get(peerId);
    if (p && p.pc) {
      try {
        p.pc.close();
      } catch {}
    }
    removePeer(peerId);
  }

  function removePeer(peerId) {
    if (!peers.has(peerId) && !knownPeers.has(peerId)) return;
    clearWatchdog(peerId);
    pendingCandidates.delete(peerId); // drop buffered candidates for the old pc
    peers.delete(peerId);
    knownPeers.delete(peerId);
    Transport.dropInboundFrom(peerId);
    handlers.onPeerLeave && handlers.onPeerLeave(peerId);
    handlers.onPeerList && handlers.onPeerList();
  }

  // =====================================================
  //  Public API: create / join via QR-or-paste signaling
  // =====================================================

  // The QR/paste payload is a JSON wrapper carrying the SDP + from-id + name.
  // Signaling.encode/decode handles the compression to a scannable string.

  async function buildOfferEnvelope() {
    // Create a connection to the (yet-unknown) joiner. We mint a temporary
    // placeholder id on our side; the real peerId arrives with the answer.
    const pc = newPC();
    // We do NOT know the remote peerId yet, so store under a temp handle.
    const tempId = '__pending__' + Math.random().toString(36).slice(2);
    peers.set(tempId, { pc, dc: null, name: 'joining…', status: 'host-wait' });
    const dc = setupChannel(tempId, pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await gatherIce(pc);
    const envelope = {
      role: 'offer',
      from: selfId,
      name: Identity.displayName(),
      sdp: pc.localDescription,
    };
    // Stash so acceptAnswer can finalize when the answer arrives.
    pending.set(tempId, { isHost: true });
    Mesh._pendingHost = { tempId, pc };
    return envelope;
  }

  async function acceptAnswerEnvelope(envelope) {
    const stash = Mesh._pendingHost;
    if (!stash) throw new Error('未在创建房间状态');
    const { tempId, pc } = stash;
    // Register the real peer id, rewire maps.
    const realId = envelope.from;
    try {
      await pc.setRemoteDescription(envelope.sdp);
    } catch (err) {
      throw err;
    }
    const p = peers.get(tempId);
    peers.delete(tempId);
    peers.set(realId, { pc, dc: p?.dc || null, name: envelope.name || '未知', status: 'connected' });
    // Transport channel was registered under tempId; remap by re-registering.
    remapTransportChannel(tempId, realId);
    knownPeers.set(realId, envelope.name || '未知');
    pending.delete(tempId);
    Mesh._pendingHost = null;
    handlers.onPeerList && handlers.onPeerList();
    // Now grow toward everyone the joiner will tell us about (via hello).
    return realId;
  }

  async function buildAnswerEnvelope(offerEnvelope) {
    const hostId = offerEnvelope.from;
    const pc = newPC();
    peers.set(hostId, { pc, dc: null, name: offerEnvelope.name || '主机', status: 'connecting' });
    setupChannel(hostId, pc);
    await pc.setRemoteDescription(offerEnvelope.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await gatherIce(pc);
    knownPeers.set(hostId, offerEnvelope.name || '主机');
    const envelope = {
      role: 'answer',
      from: selfId,
      name: Identity.displayName(),
      sdp: pc.localDescription,
    };
    return envelope;
  }

  // Transport registered the channel under tempId; move it to realId.
  function remapTransportChannel(fromId, toId) {
    // Transport stores dcByPeer internally; we expose a remap via close+re-register.
    // Simpler: Transport keeps dcByPeer; we ask it to remap.
    Transport.remapPeer && Transport.remapPeer(fromId, toId);
  }

  function roster() {
    return rosterArray();
  }

  function connectedPeers() {
    return [...peers.keys()].filter((id) => !id.startsWith('__pending__'));
  }

  // Report the ACTUAL transport in use for a peer's selected ICE candidate pair
  // ('host' | 'srflx' | 'relay' | ''). The receiver relays through TURN only when
  // the selected local candidate is a relay candidate — so this tells the UI
  // whether a file transfer is going P2P or through the TURN server. Async
  // because it reads getStats(); callers (UI) may poll it.
  async function transportKind(peerId) {
    const p = peers.get(peerId);
    if (!p || !p.pc) return '';
    try {
      const stats = await p.pc.getStats();
      let kind = '';
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.selected) {
          const local = stats.get(r.localCandidateId);
          if (local && local.candidateType) kind = local.candidateType;
        }
      });
      // Some browsers mark the nominated pair without `selected`; fall back
      if (!kind) {
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.nominated) {
            const local = stats.get(r.localCandidateId);
            if (local && local.candidateType) kind = local.candidateType;
          }
        });
      }
      return kind;
    } catch {
      return '';
    }
  }

  // Live data-channel stats for throughput display: bytesSent/bytesReceived
  // (cumulative, SCTP-level), bufferedAmount (mirrors dc.bufferedAmount), state.
  // The caller diffs bytesSent over time for an instantaneous MB/s and watches
  // bufferedAmount to see if backpressure is the limiter. Filters on the
  // negotiated channel label 'c' (same as setupChannel uses).
  async function channelStats(peerId) {
    const p = peers.get(peerId);
    if (!p || !p.pc) return null;
    try {
      const stats = await p.pc.getStats();
      let out = null;
      stats.forEach((r) => {
        if (r.type === 'data-channel' && r.label === 'c') {
          out = {
            bytesSent: r.bytesSent || 0,
            bytesReceived: r.bytesReceived || 0,
            bufferedAmount: r.bufferedAmount || 0,
            state: r.state || '',
          };
        }
      });
      return out;
    } catch {
      return null;
    }
  }

  // Per-peer connection state for the UI: 'connected' | 'connecting' |
  // 'restarting' | 'failed' | 'disconnected'. Derived from our status field,
  // reconciled with the live DataChannel/ICE state so it never lies.
  function peerStates() {
    const out = [];
    for (const [id, p] of peers) {
      if (id.startsWith('__pending__')) continue;
      let state = p.status || 'connecting';
      const ice = p.pc ? p.pc.iceConnectionState : '';
      if (p.dc && p.dc.readyState === 'open') state = 'connected';
      else if (ice === 'failed') state = 'failed';
      else if (ice === 'connected' || ice === 'completed') {
        state = state === 'failed' || state === 'restarting' ? state : 'connecting';
      }
      // diagnostics: candidate types gathered + current ICE state. host=LAN,
      // srflx=public-after-NAT, relay=TURN. host=0 on a phone usually means
      // mDNS/host-candidate obfuscation; relay=0 means no TURN configured.
      const c = (p.pc && p.pc.__cands) || { host: 0, srflx: 0, relay: 0 };
      out.push({
        id,
        name: p.name || '未知',
        state,
        ice,
        cands: { host: c.host || 0, srflx: c.srflx || 0, relay: c.relay || 0 },
        connectMs: p.connectMs || null, // ms from discovery to DataChannel open
        diag: p.diag || null, // milestone ms-since-discovery (offerSent, firstLocalCand, ...)
      });
    }
    return out;
  }

  function disconnectAll() {
    for (const id of [...peers.keys()]) handleDisconnect(id);
  }

  // Best-effort: tell every direct peer we're leaving, then close.
  function sayBye() {
    for (const pid of [...peers.keys()]) {
      if (pid.startsWith('__pending__')) continue;
      sendCtrl(pid, { type: 'bye' });
    }
  }

  // ---------- server mode ----------
  let onServerState = null;

  function connectServer(url) {
    ServerSignaling.setHandlers({
      onMessage: (env) => {
        if (env && env.layer === Transport.LAYER_CTRL) routeEnv(env, ServerSignaling.SERVER_SOURCE);
      },
      onStateChange: (st, mode) => {
        if (mode === 'server' && st === 'connected') {
          // server reachable: start discovery + mesh growth
          startHelloLoop();
          broadcastHello();
          meshGrow();
        } else if (st === 'disconnected') {
          stopHelloLoop();
        }
        if (onServerState) onServerState(st, mode);
      },
    });
    ServerSignaling.connect(url);
  }

  function disconnectServer() {
    ServerSignaling.disconnect();
    stopHelloLoop();
  }

  function serverMode() {
    return ServerSignaling.isServerMode();
  }

  function setOnServerState(fn) {
    onServerState = fn;
  }

  return {
    selfId,
    setHandlers,
    routeEnv, // exposed for Transport to call on incoming ctrl envelopes
    buildOfferEnvelope,
    acceptAnswerEnvelope,
    buildAnswerEnvelope,
    roster,
    connectedPeers,
    peerStates,
    setIceServers,
    restartStuck,
    transportKind,
    channelStats,
    disconnectAll,
    sayBye,
    connectServer,
    disconnectServer,
    serverMode,
    setOnServerState,
  };
})();

// Wire Transport -> Mesh: when a control envelope arrives, route it through mesh.
