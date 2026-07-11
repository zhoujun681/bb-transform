// Discovery test for server mode: spawns the real server, connects two clients,
// and asserts they learn each other's id through the relay (no QR, auto-mesh).
// Run: node test/server.test.js  (from project root)
// Requires server/node_modules to be installed (npm install in server/).

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const PORT = 8099;
const SERVER = spawn(process.execPath, ['server/server.js'], {
  cwd: __dirname + '/..',
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

function mkClient(id) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const learned = new Set();
    ws.on('open', () => {
      // register + immediately broadcast hello (models a simultaneous refresh:
      // the other client may not be registered yet when this hello fans out —
      // the race the server's roster-push must now fix deterministically).
      ws.send(JSON.stringify({ data: { type: 'register', id } }));
      ws.send(
        JSON.stringify({
          layer: 0, from: id, to: '*', ttl: 6, id: 'h-' + id,
          data: { type: 'hello', name: id, roster: [{ id, name: id }] },
        })
      );
    });
    ws.on('message', (d) => {
      const env = JSON.parse(d.toString());
      if (!env.data) return;
      // learn peers from EITHER a hello broadcast OR the server's roster-push
      // (synthetic 'peers' messages on register).
      if (env.data.type === 'hello') {
        learned.add(env.from);
        if (env.data.roster) for (const e of env.data.roster) learned.add(e.id);
      } else if (env.data.type === 'peers') {
        if (env.data.roster) for (const e of env.data.roster) learned.add(e.id);
      }
    });
    setTimeout(() => resolve([...learned]), 900);
  });
}

(async () => {
  // wait for server boot
  await new Promise((r) => setTimeout(r, 1200));
  try {
    const [a, b] = await Promise.all([mkClient('peerA'), mkClient('peerB')]);
    console.log('A learned:', a.join(','));
    console.log('B learned:', b.join(','));
    const pass = a.includes('peerB') && b.includes('peerA');
    console.log(pass ? '\nPASS: mutual discovery via relay' : '\nFAIL');
    process.exit(pass ? 0 : 1);
  } finally {
    SERVER.kill();
  }
})();
