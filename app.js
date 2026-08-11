// app.js — UI controller, glue between Identity / Mesh / Transport / Signaling.
//
// UI state machine for pairing:
//   [lobby] -> Create: build offer -> show offer QR + copy + show "scan answer" UI
//                     -> (scan/paste answer) -> acceptAnswer -> [connected]
//   [lobby] -> Join:  (scan/paste offer) -> build answer -> show answer QR + copy
//                     -> (host scans this) -> [connected]
// Manual paste is a first-class path everywhere (file:// camera is fragile).

(function () {
  'use strict';

  // ----- bridge Transport -> Mesh for control envelopes -----
  Transport.setHandlers({
    envelope: (env, fromPeerId) => {
      if (env.layer === Transport.LAYER_CTRL && env.from) Mesh.routeEnv(env, fromPeerId);
    },
    chat: (env) => handleIncomingChat(env),
    fileMeta: (env, fromPeerId) => handleFileMeta(env, fromPeerId),
    fileChunk: (info, fromPeerId) => handleFileChunk(info, fromPeerId),
    fileEnd: (env, fromPeerId) => handleFileEnd(env, fromPeerId),
    fileCancel: (env, fromPeerId) => handleFileCancel(env.fileId, fromPeerId),
  });

  Mesh.setHandlers({
    onPeerJoin: () => {},
    onPeerLeave: (id) => {
      toast(`${peerLabel(id)} 已离开`);
    },
    onPeerList: () => renderPeers(),
    onLog: (msg) => toast(msg),
  });

  // ----- DOM refs -----
  const $ = (id) => document.getElementById(id);
  const els = {};

  function cacheEls() {
    [
      'nameInput',      'saveName',
      'lobby',
      'roomView',
      'btnCreate',
      'btnJoin',
      'btnServer',
      'serverUrl',
      'serverHint',
      'turnUrl',
      'turnUser',
      'turnPass',
      'saveTurn',
      'turnHint',
      'joinSection',
      'btnScanOffer',
      'pasteOffer',
      'pasteOfferGo',
      'createSection',
      'offerCanvas',
      'offerString',
      'copyOffer',
      'answerScanSection',
      'btnScanAnswer',
      'pasteAnswer',
      'pasteAnswerGo',
      'answerScanVideo',
      'scanOfferVideo',
      'offerPhotoInput',
      'answerPhotoInput',
      'answerCanvas',
      'answerString',
      'copyAnswer',
      'answerShow',
      'cancelPair',
      'peerList',
      'chatLog',
      'chatInput',
      'chatSend',
      'fileInput',
      'status',
      'imgLightbox',
      'imgLightboxImg',
      'btnSaveMessages',
      'btnHistory',
      'saveOverlay',
      'saveSummary',
      'saveIncludeFiles',
      'saveCancel',
      'saveConfirm',
      'historyOverlay',
      'historyList',
      'maxKeepInput',
      'historyClearAll',
      'historyClose',
      'historyViewOverlay',
      'historyViewTitle',
      'historyViewLog',
      'historyViewClose',
    ].forEach((id) => (els[id] = $(id)));
  }

  // ----- name -----
  function initName() {
    els.nameInput.value = Identity.displayName();
    els.nameInput.placeholder = Identity.defaultName();
    els.saveName.addEventListener('click', () => {
      const n = Identity.setName(els.nameInput.value);
      els.nameInput.value = n;
      toast('已保存昵称: ' + n);
    });
  }

  // ----- pairing UI -----
  function show(el) {
    if (el) el.hidden = false;
  }
  function hide(el) {
    if (el) el.hidden = true;
  }

  function goRoomView() {
    hide(els.lobby);
    show(els.roomView);
    setStatus('已连接，可发送消息/文件');
  }

  // The "show your answer code" panel only matters for a JOINER right after they
  // generated their answer (the host needs to scan/paste it back). Hide by default.
  function showAnswerPanel() {
    show(els.answerShow);
  }

  // ---- SERVER mode (no QR) ----
  // Prefill the server URL with the page's own origin when the page was opened
  // FROM a server (http/https). Most users open the page by visiting the
  // server's URL directly, so the address they need is the one in the address
  // bar. They can still edit or clear it. On file:// we leave it blank.
  function prefillServerUrl() {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      if (!els.serverUrl.value.trim()) {
        els.serverUrl.value = location.host; // host = hostname:port (no scheme)
      }
    }
  }

  function onConnectServer() {
    const url = els.serverUrl.value.trim();
    Mesh.setOnServerState((st, mode) => {
      if (mode === 'server' && st === 'connected') {
        els.serverHint.textContent = '✓ 已连接服务器，正在自动组网…（无需扫码）';
        els.serverHint.style.color = '#22c55e';
        goRoomView();
        setStatus('服务器模式 · 已连接，正在自动发现设备');
      } else if (st === 'connecting') {
        els.serverHint.textContent = '正在连接服务器…';
        els.serverHint.style.color = '#94a3b8';
      } else if (st === 'disconnected') {
        if (Mesh.serverMode()) {
          // transient
        } else {
          els.serverHint.textContent = '⚠ 服务器连接断开，已切回对等模式（现有连接不受影响）。正在重试…';
          els.serverHint.style.color = '#f59e0b';
        }
      }
    });
    els.serverHint.textContent = '正在连接服务器…';
    els.serverHint.style.color = '#94a3b8';
    Mesh.connectServer(url);
  }

  // ---- TURN relay config (makes phones connect when host/srflx candidates fail) ----
  // Stored in localStorage. Default to the bundled coturn on the SAME host that
  // served this page (turn:<host>:3478) so it "just works" with the Docker image.
  const TURN_KEY = 'bt_turn';
  const TURN_DEFAULT_USER = 'bbuser';
  const TURN_DEFAULT_PASS = 'bbpass123';

  function turnFromStorage() {
    try {
      const raw = localStorage.getItem(TURN_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  }

  function defaultTurnUrl() {
    if (typeof location !== 'undefined' && location.protocol.startsWith('http')) {
      return 'turn:' + location.hostname + ':3478';
    }
    return '';
  }

  // load saved TURN (or prefill the default for the bundled coturn) into mesh.
  function initTurn() {
    const t = turnFromStorage();
    if (t && t.urls) {
      // user explicitly saved TURN -> use it
      els.turnUrl.value = t.urls;
      els.turnUser.value = t.username || '';
      els.turnPass.value = t.credential || '';
      applyTurn(t);
    } else {
      // The Docker image bundles coturn on the same host. Enable it by default
      // as a fallback; ICE still prefers host/srflx direct candidates.
      const url = defaultTurnUrl();
      els.turnUrl.value = url;
      els.turnUser.value = TURN_DEFAULT_USER;
      els.turnPass.value = TURN_DEFAULT_PASS;
      applyTurn(url ? {
        urls: url,
        username: TURN_DEFAULT_USER,
        credential: TURN_DEFAULT_PASS,
      } : null);
    }
  }

  function applyTurn(t) {
    if (t && t.urls) {
      // TURN configured: STUN (for srflx path quality) + TURN (cross-network relay).
      Mesh.setIceServers([
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: t.urls, username: t.username, credential: t.credential },
      ]);
      els.turnHint.textContent = '✓ 已启用 TURN: ' + t.urls + '（直连失败时自动走中转）';
      els.turnHint.style.color = '#22c55e';
    } else {
      // STUN-only: host candidates (LAN-direct, fastest) + srflx (a second path
      // so ICE can pick a higher-throughput pair). With trickle ICE + server
      // roster-push, STUN gather slowness no longer delays first connect.
      Mesh.setIceServers([{ urls: 'stun:stun.l.google.com:19302' }]);
      els.turnHint.textContent = '同网直连（host + STUN）；跨网连接请在页面配置 TURN';
      els.turnHint.style.color = '#94a3b8';
    }
  }

  function onSaveTurn() {
    const urls = els.turnUrl.value.trim();
    const username = els.turnUser.value.trim();
    const credential = els.turnPass.value.trim();
    if (!urls) {
      localStorage.removeItem(TURN_KEY);
      applyTurn(null);
      toast('已清除 TURN 配置');
      return;
    }
    const t = { urls, username, credential };
    try {
      localStorage.setItem(TURN_KEY, JSON.stringify(t));
    } catch {}
    applyTurn(t);
    // nudge any stuck connections to retry now that TURN is available
    Mesh.restartStuck && Mesh.restartStuck();
    toast('已保存 TURN 配置，正在用 TURN 重试连接…');
  }

  // ---- CREATE room ----
  async function onCreate() {
    try {
      setStatus('正在生成邀请码…');
      const envelope = await Mesh.buildOfferEnvelope();
      const encoded = await Signaling.encode(envelope);
      Signaling.renderQR(els.offerCanvas, encoded);
      els.offerString.value = encoded;
      hide(els.lobby);
      show(els.createSection);
      show(els.answerScanSection);
      setStatus('等待对方加入：让对方扫码或粘贴邀请码，然后把对方的回执码扫/粘回来');
    } catch (e) {
      setStatus('创建失败: ' + e.message);
    }
  }

  async function onPasteAnswerGo() {
    const str = els.pasteAnswer.value.trim();
    if (!str) return;
    await acceptAnswerString(str);
  }

  async function onScanAnswerStart() {
    try {
      setStatus('请将摄像头对准对方显示的回执二维码…');
      show(els.answerScanVideo);
      await Signaling.startScan(els.answerScanVideo, async (data) => {
        Signaling.stopScan();
        hide(els.answerScanVideo);
        await acceptAnswerString(data);
      });
    } catch (e) {
      hide(els.answerScanVideo);
      setStatus('无法启动摄像头: ' + e.message + '（可改用粘贴或拍照识别）');
    }
  }

  // Static-photo scan path: works on plain HTTP (no camera permission). The phone
  // takes one photo of the QR; decodeImage runs jsQR on that still image.
  async function onPickAnswerPhoto() {
    const file = els.answerPhotoInput.files && els.answerPhotoInput.files[0];
    els.answerPhotoInput.value = '';
    if (!file) return;
    setStatus('正在识别回执码照片…');
    const data = await Signaling.decodeImage(file);
    if (!data) {
      setStatus('未能识别二维码，请重拍清晰些，或改用“粘贴码”。');
      toast('未识别到二维码');
      return;
    }
    await acceptAnswerString(data);
  }

  async function acceptAnswerString(str) {
    try {
      const envelope = await Signaling.decode(str);
      if (envelope.role !== 'answer') {
        setStatus('这不是回执码');
        return;
      }
      await Mesh.acceptAnswerEnvelope(envelope);
      hide(els.createSection);
      hide(els.answerScanSection);
      hide(els.answerScanVideo);
      goRoomView();
      toast('已连接到 ' + (envelope.name || '对方'));
    } catch (e) {
      setStatus('解析回执失败: ' + e.message);
    }
  }

  // ---- JOIN room ----
  async function onPasteOfferGo() {
    const str = els.pasteOffer.value.trim();
    if (!str) return;
    await buildAnswerFromOffer(str);
  }

  async function onScanOfferStart() {
    try {
      setStatus('请将摄像头对准邀请二维码…');
      show(els.scanOfferVideo);
      await Signaling.startScan(els.scanOfferVideo, async (data) => {
        Signaling.stopScan();
        hide(els.scanOfferVideo);
        await buildAnswerFromOffer(data);
      });
    } catch (e) {
      hide(els.scanOfferVideo);
      setStatus('无法启动摄像头: ' + e.message + '（可改用粘贴或拍照识别）');
    }
  }

  // Static-photo scan path: works on plain HTTP (no camera permission).
  async function onPickOfferPhoto() {
    const file = els.offerPhotoInput.files && els.offerPhotoInput.files[0];
    els.offerPhotoInput.value = '';
    if (!file) return;
    setStatus('正在识别邀请码照片…');
    const data = await Signaling.decodeImage(file);
    if (!data) {
      setStatus('未能识别二维码，请重拍清晰些，或改用“粘贴码”。');
      toast('未识别到二维码');
      return;
    }
    await buildAnswerFromOffer(data);
  }

  async function buildAnswerFromOffer(str) {
    try {
      const envelope = await Signaling.decode(str);
      if (envelope.role !== 'offer') {
        setStatus('这不是邀请码');
        return;
      }
      const answer = await Mesh.buildAnswerEnvelope(envelope);
      const encoded = await Signaling.encode(answer);
      Signaling.renderQR(els.answerCanvas, encoded);
      els.answerString.value = encoded;
      hide(els.lobby);
      show(els.joinSection);
      setStatus('已生成回执码：让对方扫码或粘贴，连接即将建立…');
      // After handing the answer back, the channel opens when host accepts it.
      // We can already enter room view; messages/peers will populate via hello.
      goRoomView();
      showAnswerPanel();
    } catch (e) {
      setStatus('解析邀请码失败: ' + e.message);
    }
  }

  function cancelPairing() {
    Signaling.stopScan();
    Mesh.disconnectServer();
    Mesh.disconnectAll();
    hide(els.roomView);
    hide(els.createSection);
    hide(els.answerScanSection);
    hide(els.answerScanVideo);
    hide(els.joinSection);
    hide(els.scanOfferVideo);
    if (els.offerPhotoInput) els.offerPhotoInput.value = '';
    if (els.answerPhotoInput) els.answerPhotoInput.value = '';
    // leaving the room ends this conversation — clear the in-memory log so the
    // next pairing starts a fresh one (saved history already persists in IDB).
    conversationLog.length = 0;
    show(els.lobby);
    setStatus('已取消');
  }

  // ----- peers list -----
  function renderPeers() {
    const roster = Mesh.roster();
    els.peerList.innerHTML = '';
    const self = document.createElement('li');
    self.className = 'peer self';
    self.textContent = Identity.displayName() + ' (我)';
    els.peerList.appendChild(self);
    // direct (P2P) connection state per peer — drives the status text + dot color
    const states = new Map(Mesh.peerStates().map((s) => [s.id, s]));
    let connectedCount = 0;
    let failedCount = 0;
    for (const p of roster) {
      const info = states.get(p.id);
      const state = info ? info.state : 'connecting';
      if (state === 'connected') connectedCount++;
      if (state === 'failed') failedCount++;
      const li = document.createElement('li');
      li.className = 'peer ' + stateClass(state);
      let text = `${p.name} ${stateLabel(state)}`;
      if (state === 'connected' && info && info.connectMs != null) {
        text += `\n连接耗时: ${info.connectMs} ms`;
        if (info.diag) {
          // milestone timeline (ms since discovery) — pinpoints where stalls are
          const d = info.diag;
          const parts = [];
          if (d.offerSent != null) parts.push('offer发' + d.offerSent);
          if (d.answerSent != null) parts.push('answer发' + d.answerSent);
          if (d.firstLocalCand != null) parts.push('本端候选' + d.firstLocalCand);
          if (d.firstRemoteCand != null) parts.push('对端候选' + d.firstRemoteCand);
          if (d.iceChecking != null) parts.push('ICE检查' + d.iceChecking);
          if (d.iceConnected != null) parts.push('ICE通' + d.iceConnected);
          if (parts.length) text += '\n' + parts.join(' ');
        }
      } else if (state !== 'connected' && info) {
        const c = info.cands || {};
        text += `\n候选: host=${c.host} srflx=${c.srflx} relay=${c.relay} · ICE: ${info.ice || '?'}`;
        if (info.ice === 'disconnected' || info.ice === 'failed') {
          if (!c.relay) {
            text += '\n未启用 TURN：请检查 Linux 防火墙/网络隔离，或配置可用 TURN 服务';
          } else {
            text += '\n直连失败，正在尝试 TURN 中继…';
          }
        }
      }
      li.textContent = text;
      els.peerList.appendChild(li);
    }
    const n = roster.length;
    if (!n) {
      setStatus('等待成员加入…');
    } else if (connectedCount === n) {
      setStatus(`房间内 ${n} 位成员 · 全部已直连，可发送消息/文件`);
    } else {
      const retryingCount = failedCount + roster.reduce((count, peer) => {
        const info = states.get(peer.id);
        return count + (info && info.state === 'disconnected' ? 1 : 0);
      }, 0);
      const connectingCount = n - connectedCount - retryingCount;
      const pendingLabels = [];
      if (retryingCount) pendingLabels.push(`${retryingCount} 连接异常重试中`);
      if (connectingCount > 0) pendingLabels.push(`${connectingCount} 直连中`);
      setStatus(`房间内 ${n} 位成员 · 已直连 ${connectedCount}，${pendingLabels.join('、')}…`);
    }
  }

  function stateClass(state) {
    switch (state) {
      case 'connected':
        return 'online';
      case 'failed':
        return 'failed';
      case 'restarting':
        return 'restarting';
      default:
        return '';
    }
  }

  function stateLabel(state) {
    switch (state) {
      case 'connected':
        return '✓ 已直连';
      case 'failed':
        return '· 直连失败，重试中';
      case 'restarting':
        return '· 重新直连中…';
      case 'disconnected':
        return '· 连接已断开，重试中…';
      default:
        return '· 直连中…';
    }
  }

  function peerLabel(id) {
    const roster = Mesh.roster();
    const found = roster.find((p) => p.id === id);
    return found ? found.name : id.slice(0, 6);
  }

  // ----- chat -----
  const seenMsg = new Set();
  // Source-of-truth for the current session's conversation, so it can be saved
  // to history (core/storage.js). Reset on cancelPairing (a fresh pairing = a
  // new conversation). Entries are normalized: {type:'text'|'file', ...}.
  const conversationLog = [];
  function pushLog(entry) {
    conversationLog.push(entry);
  }
  function sendChat() {
    const text = els.chatInput.value.trim();
    if (!text) return;
    const env = {
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      msg: text,
      name: Identity.displayName(),
      ts: Date.now(),
      from: Identity.id(),
    };
    seenMsg.add(env.id);
    Transport.sendChat(env);
    renderChat(env, true);
    els.chatInput.value = '';
  }

  function handleIncomingChat(env) {
    if (seenMsg.has(env.id)) return;
    seenMsg.add(env.id);
    renderChat(env, false);
  }

  function renderChat(env, mine) {
    pushLog({
      type: 'text',
      id: env.id,
      msg: env.msg,
      name: mine ? Identity.displayName() : (env.name || peerLabel(env.from)),
      ts: env.ts,
      from: env.from,
      mine,
    });
    const div = document.createElement('div');
    div.className = 'msg' + (mine ? ' mine' : '');
    const head = document.createElement('div');
    head.className = 'msg-head';
    head.textContent = (mine ? '我' : env.name || peerLabel(env.from)) + ' · ' + fmtTime(env.ts);
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = env.msg;
    div.appendChild(head);
    div.appendChild(body);
    els.chatLog.appendChild(div);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ----- files -----
  function handleFileMeta(env, fromPeerId) {
    Transport.ensureInbound(env, fromPeerId);
    addFileEntry(env, fromPeerId, 0);
  }

  function handleFileChunk(info, fromPeerId) {
    const st = Transport.addChunk(info.fileId, info.seq, info.payload);
    if (!st) return;
    updateFileProgress(info.fileId, st.received, st.total);
  }

  function handleFileEnd(env) {
    // Large files can deliver the 'end' signal BEFORE the last data chunks
    // arrive (control vs binary queueing, or late backpressure-drained sends).
    // If we finalize immediately and a chunk is missing, finalizeInbound
    // returns null and we'd silently leave a placeholder card with NO download
    // button forever. So: try now; if incomplete, wait briefly for stragglers.
    tryFinalize(env.fileId, 0);
  }

  // Attempt to finalize; if chunks are still missing, retry a few times with a
  // short delay before giving up (and telling the user it failed).
  const END_MAX_WAITS = 6; // ~ up to 6s total waiting for stragglers
  const END_WAIT_MS = 1000;
  // files cancelled by either side — guards tryFinalize from firing a spurious
  // "接收不完整" toast after a cancel races the end/retry loop.
  const cancelledFiles = new Set();
  function tryFinalize(fileId, attempt) {
    if (cancelledFiles.has(fileId)) return; // cancelled — don't toast/finalize
    const res = Transport.finalizeInbound(fileId);
    if (res) {
      finalizeReceived(fileId, res);
      return;
    }
    const prog = Transport.inboundProgress(fileId);
    if (prog && prog.received < prog.total && attempt < END_MAX_WAITS) {
      // still missing some chunks — wait and retry
      setStatus(`正在收齐文件… ${prog.received}/${prog.total} 块`);
      setTimeout(() => tryFinalize(fileId, attempt + 1), END_WAIT_MS);
      return;
    }
    if (cancelledFiles.has(fileId)) return; // cancelled during the wait
    // genuinely incomplete: surface it instead of silently leaving a dead card
    setStatus('文件接收不完整，未能生成下载');
    toast('文件接收不完整（可能网络抖动），请重新发送');
  }

  // A peer (sender or another receiver) signalled cancel for this file. If I'm
  // the sender, cancelSend tears down my pump (the queued sender UI cleans up).
  // Otherwise I'm a receiver (or already dropped) — drop local state + UI.
  function handleFileCancel(fileId, fromPeerId) {
    if (Transport.isOutbound(fileId)) {
      Transport.cancelSend(fileId); // flag the pump; the queued sender branch cleans UI
      return;
    }
    cancelReceivedFile(fileId);
  }

  // Receiver-side cleanup: drop reassembly state, remove the bubble's bar/button,
  // mark it cancelled. Idempotent.
  function cancelReceivedFile(fileId) {
    Transport.dropInbound(fileId);
    fileBars.delete(fileId);
    cancelledFiles.add(fileId);
    const bubble = document.getElementById('file-' + fileId) || document.getElementById('file-pending');
    if (bubble && bubble.id === 'file-' + fileId) {
      const body = bubble.querySelector('.msg-body');
      const bar = body && body.querySelector('.file-bar');
      if (bar) bar.remove();
      const cb = body && body.querySelector('.file-cancel');
      if (cb) cb.remove();
      if (body) {
        const tag = document.createElement('div');
        tag.className = 'file-cancelled-tag';
        tag.textContent = '已取消';
        body.appendChild(tag);
      }
    }
    setStatus('文件传输已取消');
  }

  function finalizeReceived(fileId, res) {
    pushLog({
      type: 'file',
      fileId,
      name: res.meta.name,
      mime: res.meta.type || '',
      size: res.meta.size,
      ts: res.meta.ts || Date.now(),
      from: res.fromPeerId,
      mine: false,
      blob: res.blob, // retained here so "include files" saves the real bytes
    });
    finishFileEntry(fileId, res);
    toast(`收到文件: ${res.meta.name}`);
  }

  function addFileEntry(meta, fromPeerId, received) {
    let bubble = document.getElementById('file-' + meta.fileId);
    if (!bubble) {
      // render this incoming file as a message bubble in the shared timeline
      const built = appendMsgBubble(false,
        `${peerLabel(fromPeerId)} · ${fmtTime(meta.ts || Date.now())}`);
      bubble = built.div;
      bubble.id = 'file-' + meta.fileId; // keep id so finish/progress lookups resolve
      // placeholder card: name + size, no download link yet (still transferring)
      built.body.appendChild(buildFileCard(meta, null));
      // receiver-side cancel: stop accepting + tell sender to stop sending
      const recvCancel = document.createElement('button');
      recvCancel.className = 'file-cancel';
      recvCancel.textContent = '取消';
      recvCancel.addEventListener('click', () => {
        Transport.dropInbound(meta.fileId);
        Transport.cancelSend(meta.fileId); // broadcast cancel to sender + others
        cancelReceivedFile(meta.fileId);
      });
      built.body.appendChild(recvCancel);
    }
    // append (or refresh) a progress bar inside the bubble body
    let bar = bubble.querySelector('.file-bar');
    if (!bar) {
      bar = document.createElement('progress');
      bar.className = 'file-bar';
      bubble.querySelector('.msg-body').appendChild(bar);
    }
    bar.max = meta.total;
    bar.value = received;
    // cache the throttle state exactly as updateFileProgress expects: { bar, lastPaint, lastVal }
    fileBars.set(meta.fileId, { bar, lastPaint: 0, lastVal: -1 });
  }

  // Per-file progress throttle state: fileId -> { bar, lastPaint, lastVal }
  const fileBars = new Map();
  const PROGRESS_INTERVAL = 120; // ms — paint progress at most ~8x/sec, not per-chunk

  function updateFileProgress(fileId, received, total) {
    let st = fileBars.get(fileId);
    if (!st) {
      // not cached yet: query once and cache
      const bar = document.querySelector('#file-' + fileId + ' .file-bar');
      if (!bar) return;
      st = { bar, lastPaint: 0, lastVal: -1, maxSet: false };
      fileBars.set(fileId, st);
    }
    // bar.max is constant per file — set it ONCE, not on every chunk (the
    // per-chunk property write is pure overhead at high throughput).
    if (!st.maxSet) {
      st.bar.max = total;
      st.maxSet = true;
    }
    // update the latest value, but only repaint on the throttle interval
    // (or when the file completes). This keeps the receiver's main thread off
    // the per-chunk hot path.
    if (received >= total) {
      st.bar.value = received;
      st.lastPaint = performance.now();
      st.lastVal = received;
      return;
    }
    const now = performance.now();
    if (now - st.lastPaint >= PROGRESS_INTERVAL) {
      st.bar.value = received;
      st.lastPaint = now;
      st.lastVal = received;
    } else {
      st.lastVal = received; // remember so the final paint is accurate
    }
  }

  async function finishFileEntry(fileId, res) {
    fileBars.delete(fileId);
    const bubble = document.getElementById('file-' + fileId);
    if (!bubble) return;
    const body = bubble.querySelector('.msg-body');
    const bar = body.querySelector('.file-bar');
    if (bar) bar.remove();
    const kind = classify(res.meta);

    if (kind === 'image') {
      const thumbUrl = await makeThumbnail(res.blob);
      if (thumbUrl) {
        body.innerHTML = '';
        const img = document.createElement('img');
        img.className = 'msg-img';
        img.src = thumbUrl; // dataURL — no revoke needed
        img.alt = res.meta.name;
        img.addEventListener('click', () => {
          if (lightboxUrl) URL.revokeObjectURL(lightboxUrl);
          lightboxUrl = URL.createObjectURL(res.blob); // full-resolution original
          openLightbox(lightboxUrl);
        });
        body.appendChild(img);
        els.chatLog.scrollTop = els.chatLog.scrollHeight;
        return;
      }
      // thumbnail decode failed → fall through to a download card
    }

    // video / other file (or image-thumbnail failure): a download card
    body.innerHTML = '';
    body.appendChild(buildFileCard(res.meta, res.blob));
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  // classify a file meta by its MIME type into one of: 'image' | 'video' | 'file'
  function classify(meta) {
    const t = (meta && meta.type) || '';
    if (t.startsWith('image/')) return 'image';
    if (t.startsWith('video/')) return 'video';
    return 'file';
  }

  // Downscale an image blob to a JPEG dataURL (long side ~480px) for inline display.
  // Returns null on decode failure. Object URL is always revoked.
  function makeThumbnail(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const MAX = 480;
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          const scale = Math.min(1, MAX / Math.max(w, h));
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.8));
        } catch {
          resolve(null);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  // Robustly trigger a browser "Save / download" for an in-memory Blob.
  // Mobile Chrome/Edge often fail a plain <a href="blob:..." download> click —
  // they try to open the blob: URL in a new tab and show "network problem".
  // We instead programmatically append a temp anchor, click it, and remove it;
  // plus fall back to navigator.msSaveBlob (old Edge) and to opening the URL.
  function downloadBlob(blob, filename) {
    const safeName = (filename || 'download').replace(/[/\\:*?"<>|]/g, '_');
    if (navigator.msSaveBlob) {
      try { return navigator.msSaveBlob(blob, safeName); } catch {}
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    // target + rel help some mobile browsers treat it as a download, not nav
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    // give the browser a tick to start the download before revoking
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 4000);
  }

  // Build a file card (icon + name + size + optional download). `blob` is the
  // received/sent Blob; we wire the download button to downloadBlob() instead
  // of a passive <a download>, which is unreliable on mobile browsers.
  function buildFileCard(meta, blob) {
    const card = document.createElement('div');
    card.className = 'msg-file';
    const ico = document.createElement('span');
    ico.className = 'file-ico';
    ico.textContent = classify(meta) === 'video' ? '🎬' : '📄';
    const metaDiv = document.createElement('div');
    metaDiv.className = 'file-meta';
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = meta.name;
    const size = document.createElement('div');
    size.className = 'file-size';
    size.textContent = fmtSize(meta.size);
    metaDiv.appendChild(name);
    metaDiv.appendChild(size);
    card.appendChild(ico);
    card.appendChild(metaDiv);
    if (blob) {
      const a = document.createElement('a');
      a.className = 'file-link';
      a.href = '#';
      a.textContent = '下载';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        downloadBlob(blob, meta.name);
      });
      card.appendChild(a);
    }
    return card;
  }

  // Image lightbox: full-res URL is created on open, revoked on close.
  let lightboxUrl = null;
  function openLightbox(fullBlobUrl) {
    els.imgLightboxImg.src = fullBlobUrl;
    els.imgLightbox.hidden = false;
  }
  function closeLightbox() {
    if (els.imgLightbox.hidden) return;
    els.imgLightbox.hidden = true;
    els.imgLightboxImg.src = '';
    if (lightboxUrl) {
      URL.revokeObjectURL(lightboxUrl);
      lightboxUrl = null;
    }
  }

  // ----- save / history -----
  // object URLs created while rendering a history view, revoked on close
  const historyUrls = new Set();

  function countEntries(entries) {
    let msgs = 0, files = 0;
    for (const e of entries) {
      if (e.type === 'file') files++;
      else msgs++;
    }
    return { msgs, files };
  }

  function makeTitle(entries) {
    const { msgs, files } = countEntries(entries);
    const parts = [];
    if (msgs) parts.push(msgs + ' 条消息');
    if (files) parts.push(files + ' 个文件');
    return '会话 · ' + (parts.join(' + ') || '空') + ' · ' + fmtTime(Date.now());
  }

  function openSaveOverlay() {
    const { msgs, files } = countEntries(conversationLog);
    if (!conversationLog.length) {
      toast('当前没有可保存的消息');
      return;
    }
    els.saveSummary.textContent =
      `将保存 ${msgs} 条消息${files ? '、' + files + ' 个文件' : ''}到历史记录。`;
    els.saveIncludeFiles.checked = true;
    show(els.saveOverlay);
  }
  function closeSaveOverlay() { hide(els.saveOverlay); }

  async function onConfirmSave() {
    const includeFiles = els.saveIncludeFiles.checked;
    const entries = conversationLog.map((e) => {
      if (e.type === 'file' && !includeFiles) {
        // strip the blob; keep metadata only
        const { blob, ...rest } = e;
        return rest;
      }
      return e;
    });
    const { msgs, files } = countEntries(entries);
    closeSaveOverlay();
    try {
      await Storage.saveConversation({
        savedAt: Date.now(),
        title: makeTitle(conversationLog),
        includeFiles,
        messages: entries,
      });
      toast(`已保存 ${msgs} 条消息${includeFiles && files ? ' + ' + files + ' 个文件' : ''}`);
    } catch (e) {
      toast('保存失败: ' + (e && e.message ? e.message : e));
    }
  }

  async function openHistory() {
    els.maxKeepInput.value = Storage.getMaxKeep();
    await renderHistoryList();
    show(els.historyOverlay);
  }
  function closeHistory() { hide(els.historyOverlay); }

  async function renderHistoryList() {
    const list = await Storage.listConversations();
    els.historyList.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '还没有保存的历史记录。';
      els.historyList.appendChild(empty);
      return;
    }
    for (const rec of list) {
      const { msgs, files } = countEntries(rec.messages || []);
      const item = document.createElement('div');
      item.className = 'history-item';
      const main = document.createElement('div');
      main.className = 'hi-main';
      const title = document.createElement('div');
      title.className = 'hi-title';
      title.textContent = rec.title || '未命名会话';
      const meta = document.createElement('div');
      meta.className = 'hi-meta';
      meta.textContent =
        `${fmtTime(rec.savedAt)} · ${msgs} 条消息` +
        (files ? ` · ${files} 个文件${rec.includeFiles ? '（含文件）' : ''}` : '');
      main.appendChild(title);
      main.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'hi-actions';
      const view = document.createElement('button');
      view.textContent = '查看';
      view.addEventListener('click', () => openHistoryView(rec.id));
      const del = document.createElement('button');
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        await Storage.deleteConversation(rec.id);
        await renderHistoryList();
        toast('已删除');
      });
      actions.appendChild(view);
      actions.appendChild(del);
      item.appendChild(main);
      item.appendChild(actions);
      els.historyList.appendChild(item);
    }
  }

  async function onClearAllHistory() {
    if (!confirm('确定清空全部历史记录？此操作不可撤销。')) return;
    await Storage.clearAll();
    await renderHistoryList();
    toast('已清空全部历史记录');
  }

  async function openHistoryView(id) {
    const rec = await Storage.getConversation(id);
    if (!rec) { toast('记录不存在'); return; }
    els.historyViewTitle.textContent = rec.title || '会话详情';
    const log = els.historyViewLog;
    log.innerHTML = '';
    // reuse the live rendering helpers, but point them at the history container
    const savedChatLog = els.chatLog;
    els.chatLog = log;
    for (const e of (rec.messages || [])) {
      if (e.type === 'file') {
        const built = appendMsgBubble(e.mine, (e.mine ? '我' : (e.name || peerLabel(e.from) || '对方')) + ' · ' + fmtTime(e.ts));
        const meta = { name: e.name, size: e.size, type: e.mime || '' };
        if (e.blob) {
          await renderHistoryFileBody(built.body, meta, e.blob);
        } else {
          // file metadata only (saved without bytes) — just a card, no download
          built.body.appendChild(buildFileCard(meta, null));
        }
      } else {
        renderChatInto(e);
      }
    }
    els.chatLog = savedChatLog;
    log.scrollTop = log.scrollHeight;
    hide(els.historyOverlay);
    show(els.historyViewOverlay);
  }

  // render a single text entry into the active chat log (history view)
  function renderChatInto(e) {
    const built = appendMsgBubble(e.mine, (e.mine ? '我' : (e.name || peerLabel(e.from) || '对方')) + ' · ' + fmtTime(e.ts));
    built.body.textContent = e.msg;
  }

  // render a stored file blob into a bubble body (thumbnail for images, card otherwise)
  async function renderHistoryFileBody(body, meta, blob) {
    const kind = classify(meta);
    if (kind === 'image') {
      const thumbUrl = await makeThumbnail(blob);
      if (thumbUrl) {
        const img = document.createElement('img');
        img.className = 'msg-img';
        img.src = thumbUrl;
        img.alt = meta.name;
        const fullUrl = URL.createObjectURL(blob);
        historyUrls.add(fullUrl);
        img.addEventListener('click', () => {
          if (lightboxUrl) URL.revokeObjectURL(lightboxUrl);
          lightboxUrl = fullUrl;
          openLightbox(fullUrl);
        });
        body.appendChild(img);
        return;
      }
    }
    const url = URL.createObjectURL(blob);
    historyUrls.add(url);
    body.appendChild(buildFileCard(meta, blob));
  }

  function closeHistoryView() {
    hide(els.historyViewOverlay);
    for (const u of historyUrls) URL.revokeObjectURL(u);
    historyUrls.clear();
    show(els.historyOverlay);
  }

  // Shared message-bubble shell for both text and file messages.
  // Appends a .msg[.mine] bubble to the chat log and returns {div, body}.
  function appendMsgBubble(mine, headText) {
    const div = document.createElement('div');
    div.className = 'msg' + (mine ? ' mine' : '');
    const head = document.createElement('div');
    head.className = 'msg-head';
    head.textContent = headText;
    const body = document.createElement('div');
    body.className = 'msg-body';
    div.appendChild(head);
    div.appendChild(body);
    els.chatLog.appendChild(div);
    return { div, body };
  }

  // Files from the picker and clipboard share one sequential UI queue. The
  // transport fans each item out to peers independently once it starts.
  let isSending = false;
  const fileQueue = [];

  function onPickSendFiles() {
    const files = [...(els.fileInput.files || [])];
    els.fileInput.value = ''; // reset so the same file can be picked again
    enqueueFiles(files, 'picker');
  }

  function onPasteFiles(e) {
    const data = e.clipboardData;
    if (!data) return;
    let files = [...(data.items || [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length && data.files) files = [...data.files];
    if (!files.length) return; // ordinary text paste keeps its native behavior

    e.preventDefault();
    enqueueFiles(files, 'clipboard');
  }

  function fallbackClipboardName(file, index) {
    if (file.name) return file.name;
    const extByType = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
    };
    const ext = extByType[file.type] || 'bin';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    return `clipboard-${stamp}${index ? '-' + (index + 1) : ''}.${ext}`;
  }

  function enqueueFiles(files, source) {
    if (!files.length) return;
    if (Mesh.connectedPeers().length === 0) {
      toast('当前没有已连接的设备');
      return;
    }
    const wasBusy = isSending || fileQueue.length > 0;
    files.forEach((file, index) => {
      fileQueue.push({ file, name: source === 'clipboard' ? fallbackClipboardName(file, index) : file.name });
    });
    if (wasBusy) toast(`已加入发送队列（${fileQueue.length} 个待发送）`);
    else if (source === 'clipboard') toast(files.length > 1 ? `正在发送 ${files.length} 个粘贴文件` : '正在发送粘贴文件');
    processFileQueue();
  }

  async function processFileQueue() {
    if (isSending) return;
    isSending = true;
    els.chatInput.setAttribute('aria-busy', 'true');
    try {
      while (fileQueue.length) {
        if (Mesh.connectedPeers().length === 0) {
          fileQueue.length = 0;
          toast('连接已断开，发送队列已停止');
          break;
        }
        await sendQueuedFile(fileQueue.shift());
      }
    } finally {
      isSending = false;
      els.chatInput.removeAttribute('aria-busy');
      renderPeers();
    }
  }

  async function sendQueuedFile(item) {
    const { file, name } = item;
    // pre-generate the fileId so the cancel button works DURING the transfer
    const fileId = Transport.randomFileId();

    const meta = { name, size: file.size, type: file.type || 'application/octet-stream' };
    const built = appendMsgBubble(true, `我 · ${fmtTime(Date.now())}`);
    const bubble = built.div;
    const body = built.body;
    bubble.id = 'file-' + fileId; // real id from the start (cancel lookup resolves)
    const kind = classify(meta);

    // instant local preview — sender has the File already, no need to wait
    let imgEl = null;
    if (kind === 'image') {
      const thumbUrl = await makeThumbnail(file);
      if (thumbUrl) {
        imgEl = document.createElement('img');
        imgEl.className = 'msg-img';
        imgEl.src = thumbUrl;
        imgEl.alt = meta.name;
        body.appendChild(imgEl);
      }
    }
    if (!imgEl) {
      body.appendChild(buildFileCard(meta, null)); // no download link while sending
    }

    // progress bar under the content during transfer
    const bar = document.createElement('progress');
    bar.className = 'file-bar';
    bar.max = 1;
    bar.value = 0;
    body.appendChild(bar);

    // sender-side cancel: flag the pump + wake drainGate + broadcast to receivers
    const sendCancelBtn = document.createElement('button');
    sendCancelBtn.className = 'file-cancel';
    sendCancelBtn.textContent = '取消';
    sendCancelBtn.addEventListener('click', () => Transport.cancelSend(fileId));
    body.appendChild(sendCancelBtn);

    els.chatLog.scrollTop = els.chatLog.scrollHeight;

    // throttle the sender-side progress paint too: sendFile calls us per chunk,
    // repainting every chunk burns the main thread and feeds back into backpressure.
    let lastPaint = 0;
    // show whether the active path is direct (P2P) or via TURN relay
    let transportLabel = '';
    const peers0 = Mesh.connectedPeers();
    if (peers0.length === 1) {
      Mesh.transportKind(peers0[0]).then((k) => {
        transportLabel = k === 'relay' ? '（经 TURN 中转）' : k ? '（直连）' : '';
      });
    }

    // Feature 2: getStats live speed (bytesSent delta) + backpressure diagnostic.
    // Polls every 500ms; cleared in finally. Falls back to the chunk-based bar.
    let statsTimer = null;
    const lastStats = new Map();
    const highWater = Transport.localCapabilities().highWaterBytes || 4 * 1024 * 1024;
    if (peers0.length) {
      statsTimer = setInterval(async () => {
        const samples = await Promise.all(peers0.map(async (peerId) => ({ peerId, stats: await Mesh.channelStats(peerId) })));
        const now = performance.now();
        let bytesDelta = 0;
        let elapsed = 0;
        let draining = false;
        for (const sample of samples) {
          const s = sample.stats;
          if (!s) continue;
          const prev = lastStats.get(sample.peerId);
          if (prev) {
            elapsed = Math.max(elapsed, (now - prev.t) / 1000);
            bytesDelta += Math.max(0, s.bytesSent - prev.bytesSent);
          }
          draining ||= s.bufferedAmount > highWater;
          lastStats.set(sample.peerId, { t: now, bytesSent: s.bytesSent });
        }
        if (elapsed > 0) {
          const mbps = (bytesDelta / (1024 * 1024)) / elapsed;
          const peerLabel = peers0.length > 1 ? ` · ${peers0.length} 台总计` : '';
          const gate = draining ? ' · 排空队列' : '';
          setStatus(`发送中 · ${mbps.toFixed(1)} MB/s${peerLabel}${transportLabel}${gate}`);
        }
      }, 500);
    }

    try {
      const result = await Transport.sendFile(
        file,
        name,
        ({ sentBytes, totalBytes }) => {
          const now = performance.now();
          bar.max = totalBytes || 1;
          if (sentBytes >= totalBytes || now - lastPaint >= PROGRESS_INTERVAL) {
            bar.value = sentBytes;
            lastPaint = now;
          }
        },
        fileId
      );

      if (result.cancelled) {
        bar.remove();
        sendCancelBtn.remove();
        const tag = document.createElement('div');
        tag.className = 'file-cancelled-tag';
        tag.textContent = '已取消';
        body.appendChild(tag);
        setStatus('已取消');
        cancelledFiles.add(fileId);
        return;
      }

      if (!result.deliveredPeerIds.length) {
        bar.remove();
        sendCancelBtn.remove();
        const tag = document.createElement('div');
        tag.className = 'file-cancelled-tag';
        tag.textContent = '发送失败';
        body.appendChild(tag);
        setStatus('文件发送失败，连接可能已断开');
        toast('文件未能发送到任何设备');
        return;
      }

      bar.value = bar.max; // ensure it lands at 100%
      bar.remove();
      sendCancelBtn.remove();
      pushLog({
        type: 'file',
        fileId,
        name: meta.name,
        mime: meta.type || '',
        size: meta.size,
        ts: Date.now(),
        from: Identity.id(),
        mine: true,
        blob: file, // the sender keeps the original File reference
      });

      if (result.failedPeerIds.length) {
        toast(`已发送至 ${result.deliveredPeerIds.length} 台，${result.failedPeerIds.length} 台失败`);
      }

      // finalize sender-side interactivity using the original File reference
      if (imgEl) {
        imgEl.addEventListener('click', () => {
          if (lightboxUrl) URL.revokeObjectURL(lightboxUrl);
          lightboxUrl = URL.createObjectURL(file); // full-resolution original
          openLightbox(lightboxUrl);
        });
      } else {
        const card = body.querySelector('.msg-file');
        if (card) {
          const a = document.createElement('a');
          a.className = 'file-link';
          a.href = '#';
          a.textContent = '下载';
          a.addEventListener('click', (e) => {
            e.preventDefault();
            downloadBlob(file, meta.name);
          });
          card.appendChild(a);
        }
      }
    } catch (err) {
      if (bar.isConnected) bar.remove();
      if (sendCancelBtn.isConnected) sendCancelBtn.remove();
      const tag = document.createElement('div');
      tag.className = 'file-cancelled-tag';
      tag.textContent = '发送失败';
      body.appendChild(tag);
      setStatus('文件发送失败');
      toast('文件发送失败，请重试');
    } finally {
      if (statsTimer) clearInterval(statsTimer);
    }
  }

  // ----- misc UI -----
  function setStatus(t) {
    els.status.textContent = t;
  }
  let toastTimer = null;
  function toast(msg) {
    let t = $('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), 2500);
  }

  function copyText(text, btn) {
    if (!text) {
      toast('没有可复制的内容');
      return;
    }
    const onSuccess = () => {
      toast('已复制，去粘贴给对方');
      if (btn) {
        const old = btn.textContent;
        btn.textContent = '✓ 已复制';
        setTimeout(() => (btn.textContent = old), 1500);
      }
    };
    // Preferred path: async Clipboard API. Only available on secure contexts
    // (https / localhost); on plain http://LAN-IP it is undefined.
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard
        .writeText(text)
        .then(onSuccess)
        .catch(() => fallbackCopy(text, btn, onSuccess));
      return;
    }
    fallbackCopy(text, btn, onSuccess);
  }

  // Synchronous fallback for non-secure contexts (http LAN): a transient
  // <textarea> + document.execCommand('copy'). Deprecated but still works
  // everywhere and is the only option without HTTPS.
  function fallbackCopy(text, btn, onSuccess) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) {
        onSuccess();
      } else {
        toast('复制失败，请手动选中文字框内容复制');
      }
    } catch {
      toast('复制失败，请手动选中文字框内容复制');
    }
  }

  // ----- wire events -----
  function wire() {
    els.btnCreate.addEventListener('click', onCreate);
    els.btnJoin.addEventListener('click', () => {
      hide(els.lobby);
      show(els.joinSection);
      els.pasteOffer.focus();
    });
    els.btnServer.addEventListener('click', onConnectServer);
    els.saveTurn.addEventListener('click', onSaveTurn);
    els.pasteOfferGo.addEventListener('click', onPasteOfferGo);
    els.btnScanOffer.addEventListener('click', onScanOfferStart);
    els.offerPhotoInput.addEventListener('change', onPickOfferPhoto);
    els.copyOffer.addEventListener('click', () => copyText(els.offerString.value, els.copyOffer));
    els.btnScanAnswer.addEventListener('click', onScanAnswerStart);
    els.answerPhotoInput.addEventListener('change', onPickAnswerPhoto);
    els.pasteAnswerGo.addEventListener('click', onPasteAnswerGo);
    els.copyAnswer.addEventListener('click', () => copyText(els.answerString.value, els.copyAnswer));
    els.cancelPair.addEventListener('click', cancelPairing);

    els.chatSend.addEventListener('click', sendChat);
    els.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChat();
    });
    els.fileInput.addEventListener('change', onPickSendFiles);
    els.chatInput.addEventListener('paste', onPasteFiles);

    els.imgLightbox.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });

    // save / history
    els.btnSaveMessages.addEventListener('click', openSaveOverlay);
    els.saveConfirm.addEventListener('click', onConfirmSave);
    els.saveCancel.addEventListener('click', closeSaveOverlay);
    els.btnHistory.addEventListener('click', openHistory);
    els.historyClose.addEventListener('click', closeHistory);
    els.historyClearAll.addEventListener('click', onClearAllHistory);
    els.historyViewClose.addEventListener('click', closeHistoryView);
    els.maxKeepInput.addEventListener('change', (e) => {
      const n = Storage.setMaxKeep(parseInt(e.target.value, 10));
      e.target.value = n;
    });

    window.addEventListener('beforeunload', () => {
      try {
        Mesh.sayBye();
      } catch {}
    });
  }

  // ----- boot -----
  document.addEventListener('DOMContentLoaded', () => {
    cacheEls();
    initName();
    prefillServerUrl();
    initTurn(); // push TURN (saved or bundled-coturn default) into mesh before connecting
    wire();
    renderPeers();
    // Auto-connect to the signaling server when the page was served FROM a
    // server (http/https), so two devices can discover each other without a
    // manual button press. On file:// (no address) we stay in the lobby and
    // let the user pair via QR/paste, or type an address and click connect.
    const addr = els.serverUrl.value.trim();
    if (addr) onConnectServer();
  });
})();
