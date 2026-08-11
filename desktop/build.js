// build.js — package the signaling server into a single Windows .exe.
//
// Output: desktop/dist/bb-transform-server.exe  (self-contained: embeds the
// Node.js runtime + server.js + the `ws` dependency; no Docker / Node install
// needed on the target machine).
//
// Static assets (index.html, styles.css, app.js, core/, vendor/) are NOT baked
// into the exe — they are copied to desktop/dist/ and sit BESIDE the exe, so the
// same exe serves any updated web files without a rebuild. At runtime server.js
// resolves ROOT to its own directory (process.pkg branch) and serves them.
//
// Usage:  node desktop/build.js
//           (run from project root; needs npm/npx + internet once to fetch the
//            pkg base binary, cached afterwards)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP = __dirname;
const STAGE = path.join(DESKTOP, 'stage');
const DIST = path.join(DESKTOP, 'dist');

const EXE_NAME = 'bb-transform-server.exe';

// Web assets copied beside the exe at runtime.
const STATIC_ASSETS = ['index.html', 'styles.css', 'app.js', 'core', 'vendor'];

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    mkdirp(dest);
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

console.log('[build] cleaning stage + dist');
rmrf(STAGE);
rmrf(DIST);
mkdirp(STAGE);
mkdirp(DIST);

// 1) server source + deps
console.log('[build] staging server/ (server.js + package.json + node_modules)');
copyRecursive(path.join(ROOT, 'server', 'server.js'), path.join(STAGE, 'server.js'));
copyRecursive(
  path.join(ROOT, 'server', 'windows-clipboard.js'),
  path.join(STAGE, 'windows-clipboard.js')
);
copyRecursive(
  path.join(ROOT, 'server', 'package.json'),
  path.join(STAGE, 'package.json')
);
// pkg needs the installed `ws` to bundle it into the binary.
copyRecursive(
  path.join(ROOT, 'server', 'node_modules'),
  path.join(STAGE, 'node_modules')
);

// 2) package.json with a `bin` entry + pkg asset list.
//    pkg auto-detects require()'d deps (ws), so we keep assets minimal — only
//    things loaded dynamically at runtime that the bundler can't see. server.js
//    reads static files from disk at runtime (not require), so it needs no
//    baked assets; everything beside the exe is served from ROOT.
const pkgJson = {
  name: 'bb-transform-server-bin',
  version: '1.0.0',
  private: true,
  bin: 'server.js',
  pkg: {
    targets: ['node22-win-x64'],
    outputPath: DIST,
    // keep sources readable for easier debugging; tiny size cost
    // (the real bulk is the Node runtime)
  },
};
fs.writeFileSync(
  path.join(STAGE, 'package.json'),
  JSON.stringify(pkgJson, null, 2)
);

// 3) run pkg
console.log('[build] invoking @yao-pkg/pkg (downloads Node base binary on first run)...');
execSync('npx --yes @yao-pkg/pkg@latest . --output ' + path.join(DIST, EXE_NAME), {
  cwd: STAGE,
  stdio: 'inherit',
});

const exePath = path.join(DIST, EXE_NAME);
if (!fs.existsSync(exePath)) {
  throw new Error('[build] exe not produced at ' + exePath);
}
const sizeMB = (fs.statSync(exePath).size / (1024 * 1024)).toFixed(1);
console.log(`[build] exe ok: ${EXE_NAME} (${sizeMB} MB)`);

// 4) copy static web assets beside the exe (runtime ROOT).
console.log('[build] copying static assets beside the exe');
for (const name of STATIC_ASSETS) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) {
    console.warn(`[build] WARN: ${name} not found, skipping`);
    continue;
  }
  copyRecursive(src, path.join(DIST, name));
}

// 5) copy the launcher .bat beside the exe.
copyRecursive(
  path.join(DESKTOP, 'start-server.bat'),
  path.join(DIST, 'start-server.bat')
);
copyRecursive(
  path.join(DESKTOP, 'windows-clipboard.ps1'),
  path.join(DIST, 'windows-clipboard.ps1')
);

console.log('\n[build] done.');
console.log('  -> ' + path.relative(ROOT, path.join(DIST, EXE_NAME)));
console.log('  -> ' + path.relative(ROOT, path.join(DIST, 'start-server.bat')));
console.log('  + native clipboard helper (windows-clipboard.ps1)');
console.log('  + static assets (index.html, app.js, core/, vendor/, styles.css)');
console.log('\nDistribute the whole desktop/dist/ folder. Double-click start-server.bat.');
