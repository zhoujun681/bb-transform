const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const API_PATH = '/api/clipboard/file';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLIPBOARD_DIR = path.join(os.tmpdir(), 'bb-transform-clipboard');

function normalizeAddress(address) {
  return String(address || '').toLowerCase().replace(/^::ffff:/, '');
}

function localAddresses() {
  const addresses = new Set(['127.0.0.1', '::1']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) addresses.add(normalizeAddress(entry.address));
  }
  return addresses;
}

function isLocalAddress(address) {
  const normalized = normalizeAddress(address);
  return normalized.startsWith('127.') || localAddresses().has(normalized);
}

function sanitizeFileName(value) {
  let name = path.basename(String(value || 'download'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[ .]+$/g, '')
    .trim();
  if (!name) name = 'download';

  const stem = name.split('.')[0];
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) name = '_' + name;

  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 32);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function cleanupOldFiles() {
  let entries;
  try {
    entries = await fs.promises.readdir(CLIPBOARD_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Clipboard temp cleanup failed:', error.message);
    return;
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return;
    const target = path.join(CLIPBOARD_DIR, entry.name);
    try {
      const stat = await fs.promises.stat(target);
      if (stat.mtimeMs < cutoff) await fs.promises.rm(target, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Clipboard temp cleanup failed:', error.message);
    }
  }));
}

function receiveFile(req, destination, maxBytes) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination, { flags: 'wx' });
    let received = 0;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(received);
    };

    output.on('error', finish);
    output.on('finish', () => finish());
    req.on('aborted', () => output.destroy(new Error('upload aborted')));
    req.on('error', (error) => output.destroy(error));
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        const error = new Error('file is too large for clipboard');
        error.code = 'LIMIT';
        req.unpipe(output);
        output.destroy(error);
        req.resume();
      }
    });
    req.pipe(output);
  });
}

function runPowerShell(helperPath, filePath, mimeType) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-File', helperPath,
      '-FilePath', filePath,
      '-MimeType', mimeType || 'application/octet-stream',
    ], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `clipboard helper exited with code ${code}`));
    });
  });
}

function helperPathFor(root) {
  return process.pkg
    ? path.join(root, 'windows-clipboard.ps1')
    : path.join(root, 'desktop', 'windows-clipboard.ps1');
}

async function handleRequest(req, res, root) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    return false;
  }
  if (url.pathname !== API_PATH) return false;

  if (process.platform !== 'win32') {
    json(res, 501, { ok: false, error: 'Native file clipboard is only available on Windows' });
    return true;
  }
  if (!isLocalAddress(req.socket && req.socket.remoteAddress) ||
      req.headers['x-bb-clipboard'] !== '1') {
    json(res, 403, { ok: false, error: 'Native clipboard is restricted to this computer' });
    return true;
  }

  const helperPath = helperPathFor(root);
  if (!fs.existsSync(helperPath)) {
    json(res, 503, { ok: false, error: 'Native clipboard helper is not installed' });
    return true;
  }
  if (req.method === 'GET') {
    json(res, 200, { ok: true });
    return true;
  }
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'Method Not Allowed' });
    return true;
  }

  const configuredMax = Number.parseInt(process.env.CLIPBOARD_MAX_BYTES || '', 10);
  const maxBytes = Number.isFinite(configuredMax) && configuredMax > 0
    ? configuredMax
    : DEFAULT_MAX_BYTES;
  const contentLength = Number.parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > maxBytes) {
    json(res, 413, { ok: false, error: 'File is too large for clipboard' });
    req.resume();
    return true;
  }

  const directory = path.join(CLIPBOARD_DIR, crypto.randomUUID());
  const filePath = path.join(directory, sanitizeFileName(url.searchParams.get('name')));
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    await receiveFile(req, filePath, maxBytes);
    await runPowerShell(helperPath, filePath, req.headers['content-type']);
    cleanupOldFiles().catch(() => {});
    json(res, 200, { ok: true });
  } catch (error) {
    try { await fs.promises.rm(directory, { recursive: true, force: true }); } catch {}
    const status = error.code === 'LIMIT' ? 413 : 500;
    console.warn('Native clipboard copy failed:', error.message);
    json(res, status, { ok: false, error: error.message });
  }
  return true;
}

module.exports = {
  API_PATH,
  handleRequest,
  isLocalAddress,
  sanitizeFileName,
};
