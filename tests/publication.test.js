const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectText } = require('../scripts/audit-publication.cjs');

test('publication privacy checker detects user paths and credentials without echoing values', () => {
  const home = ['C:', 'Users', 'PRIVATE_USER', 'workspace'].join('\\');
  const token = ['gho', 'x'.repeat(36)].join('_');
  const url = ['https:', '//user:', 'private@', 'example.invalid/path'].join('');
  const results = inspectText(home + '\n' + token + '\n' + url);
  assert.deepEqual(results.map(item => item.rule), ['windows-user-directory', 'github-token', 'credential-in-url']);
  assert.ok(results.every(item => !JSON.stringify(item).includes(token)));
});

test('publication privacy checker accepts public credits and generic browser install paths', () => {
  assert.deepEqual(inspectText('Copyright upstream@example.org\nhttps://github.com/YanagionSabigi/x-media-copy\nC:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n/home/web_user/'), []);
});

test('source distribution records the actual bundled binaries and immutable dependency sources', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor/source-manifest.json')));
  assert.equal(manifest.upstreamCommit, '71aa99d37c02a7b4c435275ca9ef50e612f6efa1');
  assert.equal(manifest.version, require('../package.json').version);
  assert.equal(manifest.components.length, 21);
  for (const binary of manifest.binaries) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, binary.file))).digest('hex'), binary.sha256);
  for (const component of manifest.components) {
    assert.match(component.sha, /^[a-f0-9]{40}$/);
    assert.match(component.archiveSha256, /^[a-f0-9]{64}$/);
    assert.ok(component.notices.length);
    for (const notice of component.notices) assert.ok(fs.statSync(path.join(root, notice.bundledNotice)).size > 0);
  }
  for (const name of ['LICENSE', 'NOTICE.md', 'PRIVACY.md']) assert.ok(fs.statSync(path.join(root, name)).size > 0);
  assert.equal(require('../package.json').license, 'GPL-3.0-or-later');
});
