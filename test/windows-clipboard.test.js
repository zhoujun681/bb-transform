const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const {
  isLocalAddress,
  sanitizeFileName,
} = require('../server/windows-clipboard');

test('sanitizes clipboard file names for Windows', () => {
  assert.equal(sanitizeFileName('../report?.txt'), 'report_.txt');
  assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFileName('trailing. '), 'trailing');
  assert.equal(sanitizeFileName(''), 'download');
});

test('recognizes loopback and this computer network addresses', () => {
  assert.equal(isLocalAddress('127.0.0.1'), true);
  assert.equal(isLocalAddress('::1'), true);
  assert.equal(isLocalAddress('::ffff:127.0.0.1'), true);

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      assert.equal(isLocalAddress(entry.address), true, entry.address);
    }
  }
  assert.equal(isLocalAddress('203.0.113.99'), false);
});
