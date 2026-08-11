const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

global.crypto = require('node:crypto').webcrypto;

const transportSrc = fs.readFileSync(__dirname + '/../core/transport.js', 'utf8');
const makeTransport = () => new Function(transportSrc + '\nreturn Transport;')();

function fakeFile(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  return {
    name: 'payload.bin',
    type: 'application/octet-stream',
    size,
    slice: (start, end) => new Blob([bytes.subarray(start, end)]),
  };
}

function recordingChannel(options = {}) {
  const records = [];
  const dc = {
    readyState: 'open',
    bufferedAmount: options.bufferedAmount || 0,
    bufferedAmountLowThreshold: 0,
    binaryType: 'arraybuffer',
    onmessage: null,
    onbufferedamountlow: null,
    send(data) {
      if (options.rejectBlob && data instanceof Blob) throw new Error('Blob unsupported');
      records.push(data);
    },
  };
  return { dc, records };
}

function controlRecords(records) {
  return records
    .filter((record) => typeof record === 'string')
    .map((record) => JSON.parse(record));
}

test('honors peer and SCTP frame limits', async () => {
  const transport = makeTransport();
  const { dc, records } = recordingChannel();
  transport.registerChannel('receiver', dc, { maxMessageSize: 64 * 1024 });
  transport.setPeerCapabilities('receiver', { maxFrameBytes: 64 * 1024 });

  const file = fakeFile(220 * 1024);
  const result = await transport.sendFile(file, file.name);
  const controls = controlRecords(records);
  const meta = controls.find((record) => record.kind === 'meta');
  const frames = records.filter((record) => record instanceof Blob);

  assert.deepEqual(result.deliveredPeerIds, ['receiver']);
  assert.equal(meta.total, Math.ceil(file.size / (64 * 1024 - 21)));
  assert.equal(frames.length, meta.total);
  assert.ok(frames.every((frame) => frame.size <= 64 * 1024));
});

test('awaits ArrayBuffer fallback before sending end', async () => {
  const transport = makeTransport();
  const { dc, records } = recordingChannel({ rejectBlob: true });
  transport.registerChannel('receiver', dc);

  const result = await transport.sendFile(fakeFile(300 * 1024), 'fallback.bin');
  const endIndex = records.findIndex(
    (record) => typeof record === 'string' && JSON.parse(record).kind === 'end'
  );
  const lastFrameIndex = records.reduce(
    (last, record, index) => (record instanceof ArrayBuffer ? index : last),
    -1
  );

  assert.deepEqual(result.failedPeerIds, []);
  assert.ok(lastFrameIndex >= 0, 'fallback should emit ArrayBuffer frames');
  assert.ok(endIndex > lastFrameIndex, 'end must be queued after the final fallback frame');
});

test('a backpressured peer does not stall a fast peer', async () => {
  const transport = makeTransport();
  const highWater = transport.localCapabilities().highWaterBytes;
  const fast = recordingChannel();
  const slow = recordingChannel({ bufferedAmount: highWater + 1 });
  transport.registerChannel('fast', fast.dc);
  transport.registerChannel('slow', slow.dc);

  const sending = transport.sendFile(fakeFile(180 * 1024), 'fanout.bin');
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.ok(controlRecords(fast.records).some((record) => record.kind === 'end'));
  assert.ok(!controlRecords(slow.records).some((record) => record.kind === 'end'));

  slow.dc.bufferedAmount = 0;
  assert.equal(typeof slow.dc.onbufferedamountlow, 'function');
  slow.dc.onbufferedamountlow();
  const result = await sending;
  assert.deepEqual(new Set(result.deliveredPeerIds), new Set(['fast', 'slow']));
});
