// SPDX-License-Identifier: GPL-3.0-or-later
// Audit only the Git index, or an explicitly selected unpacked release tree.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const rules = [
  ['windows-user-directory', /[A-Za-z]:[\\/]Users[\\/][^\s"'<>]+/g],
  ['unix-user-directory', /\/(?:Users|home)\/(?!web_user\b|runner\b)[^\s/"'<>]+\//g],
  ['cloud-user-directory', /OneDrive\s*-\s*[^\s"'<>]+/gi],
  ['github-token', /(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{40,}/g],
  ['credential-in-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/g]
];
function inspectText(text) {
  const findings = [];
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.push({ rule, line: text.slice(0, match.index).split('\n').length });
  }
  return findings;
}
function walk(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Publication symlink is not allowed');
    return item.isDirectory() ? walk(file, base) : [path.relative(base, file).replaceAll('\\', '/')];
  });
}
function main() {
  const root = path.resolve(__dirname, '..');
  const directoryArg = process.argv.indexOf('--directory');
  const base = directoryArg < 0 ? root : path.resolve(process.argv[directoryArg + 1]);
  const files = directoryArg < 0 ? execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean) : walk(base);
  if (!files.length) throw new Error('No publication files selected');
  const indexData = new Map();
  if (directoryArg < 0) {
    // Read the staged blobs, not working-tree files: a fixed local file may
    // still have an older sensitive version in the index awaiting publication.
    const output = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: files.map(file => ':' + file).join('\n') + '\n', maxBuffer: 256 * 1024 ** 2 });
    let cursor = 0;
    for (const file of files) {
      const end = output.indexOf(10, cursor);
      const header = output.subarray(cursor, end).toString('utf8').match(/^[a-f0-9]+ blob (\d+)$/);
      if (!header) throw new Error('Cannot inspect staged blob');
      const size = Number(header[1]);
      indexData.set(file, output.subarray(end + 1, end + 1 + size));
      cursor = end + 1 + size + 1;
    }
  }
  const findings = [];
  for (const file of files) {
    if (/(?:^|\/)(?:node_modules|test-results|\.release-work|\.git|\.codex|\.agents)(?:\/|$)|^docs\/superpowers\/|(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|log|zip|tgz|crx)$/i.test(file)) findings.push({ file, rule: 'private-or-generated-file' });
    const data = directoryArg < 0 ? indexData.get(file) : fs.readFileSync(path.join(base, file));
    const text = data.toString(/\.(?:wasm|png)$/i.test(file) ? 'latin1' : 'utf8');
    for (const finding of inspectText(text)) findings.push({ file, ...finding });
    const home = process.env.USERPROFILE;
    if (home && (data.includes(Buffer.from(home)) || data.includes(Buffer.from(home, 'utf16le')))) findings.push({ file, rule: 'current-user-profile' });
  }
  // Findings deliberately omit matched values to avoid leaking secrets to logs.
  console.log(JSON.stringify({ filesChecked: files.length, findings }, null, 2));
  if (findings.length) process.exitCode = 1;
}
module.exports = { inspectText };
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
