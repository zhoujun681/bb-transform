// routing-repro.test.js — isolate the server-mode signaling ROUTING logic.
//
// Reproduces the "connected to server, but stuck on 'connecting', can't send"
// bug: in server mode, when device A sends an offer/answer UNICAST to B, the
// routeEnv "direct DataChannel" branch fires (because A pre-registered B in its
// peers map) even though the DataChannel is NOT open yet. The envelope is sent
// to a closed channel -> silently dropped -> B never gets the offer -> the
// P2P connection never completes.
//
// This test drives routeEnv with controllable Transport/ServerSignaling stubs
// and asserts the offer/answer actually reach the server (the only viable path
// before a DataChannel opens in server mode).
//
// Run: node test/routing-repro.test.js   (from project root)

const assert = require('assert');

// ---- minimal harness: mirrors what Mesh.routeEnv depends on ----
// A "device" is an object holding its own peers map + sent log.
function makeDevice(selfId) {
  return {
    selfId,
    peers: new Map(),      // peerId -> {dc open?}
    sentToServer: [],      // envelopes handed to ServerSignaling.send
    sentOnDc: [],          // envelopes handed to Transport.send (per peer)
    seenCtrl: new Set(),
    receivedCtrl: [],      // envelopes delivered to handleCtrl
    serverMode: false,
  };
}

// Transport.send: only succeeds if that peer's dc is OPEN.
function transportSend(dev, peerId, env) {
  const p = dev.peers.get(peerId);
  if (p && p.dcOpen) {
    dev.sentOnDc.push({ peerId, env });
    return true;
  }
  return false; // closed / unknown -> dropped (this is the bug surface)
}

// ServerSignaling.send: records; always "works" (server reachable).
function serverSend(dev, env) {
  dev.sentToServer.push(env);
}

// The routeEnv under test — copied VERBATIM in logic from mesh.js (server path).
function routeEnv(dev, env, arrivedFrom, SERVER_SOURCE) {
  if (dev.seenCtrl.has(env.id)) return;
  dev.seenCtrl.add(env.id);

  const dest = env.to;
  const nextTtl = env.ttl - 1;
  const viaServer = dev.serverMode;

  if (dest === '*' || dest === dev.selfId) {
    dev.receivedCtrl.push(env);
    if (dest === dev.selfId) return;
  } else if (dev.peers.has(dest) && dev.peers.get(dest).dcOpen) {
    // direct delivery to an OPEN channel (real direct peer)
    transportSend(dev, dest, { ...env, ttl: nextTtl });
    return;
  }

  if (dest === '*') {
    if (viaServer) {
      if (arrivedFrom !== SERVER_SOURCE) serverSend(dev, { ...env, ttl: nextTtl });
    } else {
      for (const pid of dev.peers.keys()) {
        if (pid !== arrivedFrom && dev.peers.get(pid).dcOpen) transportSend(dev, pid, { ...env, ttl: nextTtl });
      }
    }
  } else if (nextTtl > 0) {
    if (viaServer) {
      if (arrivedFrom !== SERVER_SOURCE) serverSend(dev, { ...env, ttl: nextTtl });
    } else {
      for (const pid of dev.peers.keys()) {
        if (pid !== arrivedFrom && dev.peers.get(pid).dcOpen) { transportSend(dev, pid, { ...env, ttl: nextTtl }); break; }
      }
    }
  }
}

const SERVER_SOURCE = '__server__';
const id = () => 'm' + Math.random().toString(36).slice(2);

// ============================================================
// SCENARIO: A and B both connected to server, neither has an open DC to the
// other. A registers B in peers (as mesh.startOfferViaRelay does) but the DC is
// NOT open yet, then sends the offer. The offer MUST reach the server.
// (This mirrors the OLD buggy routeEnv too, so we run both.)
// ============================================================

function runOfferFlow(useFixedRouter) {
  const A = makeDevice('A');
  const B = makeDevice('B');
  A.serverMode = true; B.serverMode = true;
  // A pre-registers B (status connecting), dc NOT open — exactly as startOfferViaRelay does
  A.peers.set('B', { dcOpen: false });
  B.peers.set('A', { dcOpen: false });

  const offer = { layer: 0, from: 'A', to: 'B', ttl: 6, id: id(), data: { type: 'offer' } };
  const router = useFixedRouter ? routeEnv : routeEnv_OLD;
  router(A, offer, 'A', SERVER_SOURCE); // A emits locally

  // server relays A's offer to B (server swaps nothing here; B receives from server)
  const relayed = A.sentToServer[0];
  if (relayed) router(B, relayed, SERVER_SOURCE, SERVER_SOURCE);
  return { A, B };
}

// ---- OLD (buggy) router: uses peers.has(dest) regardless of open state ----
function routeEnv_OLD(dev, env, arrivedFrom, SERVER_SOURCE) {
  if (dev.seenCtrl.has(env.id)) return;
  dev.seenCtrl.add(env.id);
  const dest = env.to;
  const nextTtl = env.ttl - 1;
  const viaServer = dev.serverMode;
  if (dest === '*' || dest === dev.selfId) {
    dev.receivedCtrl.push(env);
    if (dest === dev.selfId) return;
  } else if (dev.peers.has(dest)) {                 // <-- BUG: fires even when DC closed
    transportSend(dev, dest, { ...env, ttl: nextTtl });
    return;                                          // <-- and returns, never hits server
  }
  if (dest === '*') {
    if (viaServer && arrivedFrom !== SERVER_SOURCE) serverSend(dev, { ...env, ttl: nextTtl });
  } else if (nextTtl > 0) {
    if (viaServer && arrivedFrom !== SERVER_SOURCE) serverSend(dev, { ...env, ttl: nextTtl });
  }
}

// ---- assertions ----
let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}  ${detail || ''}`);
    failures++;
  }
}

console.log('\n[OLD router — should demonstrate the bug]');
const oldRes = runOfferFlow(false);
check('OLD: A does NOT send offer to server', oldRes.A.sentToServer.length === 0, `sentToServer=${oldRes.A.sentToServer.length}`);
check('OLD: B never receives the offer', oldRes.B.receivedCtrl.length === 0, `received=${oldRes.B.receivedCtrl.length}`);

console.log('\n[FIXED router — offer must relay via server]');
const newRes = runOfferFlow(true);
check('FIXED: A sends offer to server', newRes.A.sentToServer.length === 1, `sentToServer=${newRes.A.sentToServer.length}`);
check('FIXED: B receives the offer', newRes.B.receivedCtrl.length === 1, `received=${newRes.B.receivedCtrl.length}`);
check('FIXED: received offer is the offer', newRes.B.receivedCtrl[0]?.data?.type === 'offer');

console.log('\n[FIXED router — answer (B->A) must also relay via server]');
// Now B replies with an answer to A (A's DC still closed on B's side)
const answer = { layer: 0, from: 'B', to: 'A', ttl: 6, id: id(), data: { type: 'answer' } };
routeEnv(newRes.B, answer, 'B', SERVER_SOURCE);
const relayedAns = newRes.B.sentToServer[newRes.B.sentToServer.length - 1];
if (relayedAns) routeEnv(newRes.A, relayedAns, SERVER_SOURCE, SERVER_SOURCE);
check('FIXED: B sends answer to server', newRes.B.sentToServer.some(e => e.data.type === 'answer'));
check('FIXED: A receives the answer', newRes.A.receivedCtrl.some(e => e.data.type === 'answer'));

console.log('\n[FIXED router — p2p mode unchanged: unicast hops over an open direct link]');
{
  // p2p: A has an OPEN dc to C; unicast to D (unknown) should hop A->C
  const A = makeDevice('A'); A.peers.set('C', { dcOpen: true });
  const msg = { layer: 0, from: 'A', to: 'D', ttl: 6, id: id(), data: { type: 'offer' } };
  routeEnv(A, msg, 'A', SERVER_SOURCE);
  check('P2P: A forwards to open peer C', A.sentOnDc.some(x => x.peerId === 'C'), `sentOnDc=${JSON.stringify(A.sentOnDc.map(x=>x.peerId))}`);
  check('P2P: A does NOT touch server (not server mode)', A.sentToServer.length === 0);
}

console.log('\n[FIXED router — broadcast (to=*) in server mode goes to server only]');
{
  const A = makeDevice('A'); A.serverMode = true; A.peers.set('C', { dcOpen: true });
  const hello = { layer: 0, from: 'A', to: '*', ttl: 6, id: id(), data: { type: 'hello' } };
  routeEnv(A, hello, 'A', SERVER_SOURCE);
  check('BCAST: A sends hello to server', A.sentToServer.length === 1);
  check('BCAST: A does NOT also flood open peer in server mode', A.sentOnDc.length === 0, `sentOnDc=${A.sentOnDc.length}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
