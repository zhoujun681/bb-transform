const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const projectRoot = path.resolve(__dirname, '..');
const requireFromServer = createRequire(path.join(projectRoot, 'server', 'package.json'));
const WebSocket = requireFromServer('ws');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitFor(check, timeout = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() - started >= timeout) return reject(new Error('timed out waiting for condition'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function openClient(url, id, messages) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('error', reject);
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.once('open', () => {
      ws.send(JSON.stringify({
        layer: 0,
        from: id,
        to: '__server__',
        ttl: 6,
        id: 'register-' + id + '-' + Math.random(),
        data: { type: 'register', id, name: id },
      }));
      resolve(ws);
    });
  });
}

test('broadcasts peer-gone once and ignores stale socket replacement', { timeout: 10000 }, async () => {
  const port = await reservePort();
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (data) => output.push(data.toString()));
  child.stderr.on('data', (data) => output.push(data.toString()));

  const sockets = [];
  try {
    await waitFor(() => output.join('').includes(`listening on :${port}`));
    const aMessages = [];
    const bMessages = [];
    const a = await openClient(`ws://127.0.0.1:${port}`, 'peer-a', aMessages);
    sockets.push(a);
    const b1 = await openClient(`ws://127.0.0.1:${port}`, 'peer-b', bMessages);
    sockets.push(b1);
    await waitFor(() => aMessages.some((message) => message.data && message.data.type === 'peers'));

    const b2 = await openClient(`ws://127.0.0.1:${port}`, 'peer-b', []);
    sockets.push(b2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      aMessages.filter((message) => message.from === 'peer-b' && message.data.type === 'peer-gone').length,
      0,
      'replacing a stale socket must not announce the live peer as gone'
    );

    b2.close();
    await waitFor(() => aMessages.some(
      (message) => message.from === 'peer-b' && message.data && message.data.type === 'peer-gone'
    ));
    assert.equal(
      aMessages.filter((message) => message.from === 'peer-b' && message.data.type === 'peer-gone').length,
      1
    );
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch {}
    }
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});
