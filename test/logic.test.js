// Node-based logic tests for transport.js: file chunk reassembly + binary header.
// No WebRTC/browser — we shim a virtual DataChannel wire between two Transport
// instances (a sender and a receiver).
// Run: node test/logic.test.js

const assert = require('assert');
const fs = require('fs');
global.crypto = require('crypto').webcrypto;

const transportSrc = fs.readFileSync(__dirname + '/../core/transport.js', 'utf8');
const makeTransport = () => new Function(transportSrc + '\nreturn Transport;')();

// Virtual wire: A.send -> B.onmessage, B.send -> A.onmessage (mirrors real DC).
// A real DataChannel with binaryType='arraybuffer' delivers Blob sends as an
// ArrayBuffer on the receiver — so convert Blobs back here. Strings pass through.
function makeWire() {
  const deliver = (target, d) => {
    if (d instanceof Blob) {
      d.arrayBuffer().then((ab) => target.onmessage && target.onmessage({ data: ab }));
    } else {
      target.onmessage && target.onmessage({ data: d });
    }
  };
  const A = { readyState: 'open', bufferedAmount: 0, binaryType: 'arraybuffer', onmessage: null, onbufferedamountlow: null };
  const B = { readyState: 'open', bufferedAmount: 0, binaryType: 'arraybuffer', onmessage: null, onbufferedamountlow: null };
  A.send = (d) => queueMicrotask(() => deliver(B, d));
  B.send = (d) => queueMicrotask(() => deliver(A, d));
  return { A, B };
}

const flush = (ms = 150) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const TS = makeTransport(); // sender
  const TR = makeTransport(); // receiver
  const { A, B } = makeWire();
  TS.registerChannel('R', A); // sender's view: channel to receiver
  TR.registerChannel('S', B); // receiver's view: channel to sender

  const received = { meta: null, done: null, chunks: 0 };
  TR.setHandlers({
    fileMeta: (env, from) => {
      received.meta = env;
      TR.ensureInbound(env, from);
    },
    fileChunk: (info) => {
      const st = TR.addChunk(info.fileId, info.seq, info.payload);
      if (st) received.chunks++;
    },
    fileEnd: (env) => {
      // Blob sends arrive async; the 'end' control msg may beat the last chunk.
      // Retry like the real app does (app.js tryFinalize), waiting for stragglers.
      const tryFin = (attempt) => {
        const res = TR.finalizeInbound(env.fileId);
        if (res) { received.done = res; return; }
        if (attempt < 20) setTimeout(() => tryFin(attempt + 1), 20);
      };
      tryFin(0);
    },
  });

  const fullPayload = Buffer.from('Hello, LAN! This is a test payload. '.repeat(60));
  const fullU8 = new Uint8Array(fullPayload); // stable buffer for zero-copy slicing
  const fakeFile = {
    name: 'test.txt',
    type: 'text/plain',
    size: fullPayload.length,
    // Returns a REAL Blob (like a File.slice does in the browser), so the
    // transport's zero-copy dc.send(Blob) path gets a genuine Blob to send.
    slice: (start, end) => new Blob([fullU8.subarray(start, end)]),
  };

  await TS.sendFile(fakeFile, 'test.txt');
  await flush();

  assert.ok(received.meta, 'file meta should arrive');
  assert.strictEqual(received.meta.name, 'test.txt');
  assert.ok(received.done, 'file should finalize');
  assert.strictEqual(received.done.meta.fileId, received.meta.fileId);
  const buf = Buffer.from(await received.done.blob.arrayBuffer());
  assert.strictEqual(buf.length, fullPayload.length, 'reassembled size matches');
  assert.strictEqual(buf.toString(), fullPayload.toString(), 'content matches byte-for-byte');
  const expectedChunks = Math.ceil(fullPayload.length / (16 * 1024));
  assert.strictEqual(received.chunks, expectedChunks, 'chunk count matches');

  console.log(`✓ file transfer reassembly OK: ${fullPayload.length} bytes, ${received.chunks} chunks`);

  // ===== TEST 2: chat broadcast + dedup is exercised by sender->receiver =====
  const chatGot = [];
  TR.setHandlers({
    chat: (env) => chatGot.push(env.msg),
  });
  // re-set (setHandlers replaces all) — re-add file handlers too for safety
  TR.setHandlers({
    chat: (env) => chatGot.push(env.msg),
    fileMeta: () => {},
    fileChunk: () => {},
    fileEnd: () => {},
  });
  TS.sendChat({ id: 'm1', msg: 'hello', name: 'S', from: 'S' });
  await flush(20);
  assert.deepStrictEqual(chatGot, ['hello'], 'chat arrives once');
  console.log('✓ chat delivery OK');

  // ===== TEST 3: cancel an in-flight send mid-transfer =====
  // Pre-generate a fileId, start sendFile, cancel it on the next tick, and
  // assert the pump exits cleanly with cancelled:true (and never sends 'end').
  const bigPayload = Buffer.from('x'.repeat(2 * 1024 * 1024)); // 2 MiB -> ~16 chunks @128KB
  const bigFile = {
    name: 'big.bin', type: 'application/octet-stream', size: bigPayload.length,
    slice: (start, end) => new Blob([new Uint8Array(bigPayload).subarray(start, end)]),
  };
  const fid = TS.randomFileId();
  const sentKinds = [];
  TR.setHandlers({
    chat: () => {},
    fileMeta: (e) => sentKinds.push(e.kind),
    fileChunk: () => {},
    fileEnd: (e) => sentKinds.push(e.kind),
    fileCancel: (e) => sentKinds.push('cancel:' + e.fileId),
  });
  const p = TS.sendFile(bigFile, 'big.bin', null, fid);
  queueMicrotask(() => TS.cancelSend(fid)); // cancel before it finishes
  const r = await p;
  await flush(50);
  assert.strictEqual(r.cancelled, true, 'cancelled flag set on cancel');
  assert.strictEqual(r.fileId, fid, 'fileId echoed back');
  assert.ok(!sentKinds.includes('end'), 'no end signal on cancel');
  assert.ok(sentKinds.includes('cancel:' + fid), 'cancel signal broadcast');
  console.log('✓ file cancel OK');

  console.log('\nALL LOGIC TESTS PASSED');
})().catch((e) => {
  console.error('TEST FAILED:', e.message);
  process.exit(1);
});
