// SPDX-License-Identifier: GPL-3.0-or-later
// Download public, immutable corresponding sources without executing upstream code.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
async function copyTree(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}
async function main() {
  const version = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')).version;
  const components = JSON.parse(await fs.readFile(path.join(root, 'vendor/upstream-components.json'), 'utf8'));
  const stage = path.join(root, 'release/upstream-source');
  await fs.mkdir(path.join(stage, 'archives'), { recursive: true });
  const results = new Array(components.length);
  let next = 0;
  async function worker() {
    while (next < components.length) {
      const index = next++, item = components[index];
      if (!/^[\w.-]+$/.test(item.id) || !/^[\w.-]+\/[\w.-]+$/.test(item.repo) || !/^[a-f0-9]{40}$/.test(item.sha)) throw new Error('Invalid immutable source entry');
      const archive = `archives/${item.id}-${item.sha}.tar.gz`;
      const file = path.join(stage, archive);
      const sourceUrl = `https://codeload.github.com/${item.repo}/tar.gz/${item.sha}`;
      let bytes;
      try { bytes = await fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!bytes) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120000) });
            if (!response.ok) throw new Error('Source HTTP ' + response.status);
            bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > 256 * 1024 ** 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Invalid source archive');
            await fs.writeFile(file + '.part', bytes);
            await fs.rename(file + '.part', file);
            break;
          } catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 1500)); }
        }
      }
      const listing = (await run('tar', ['-tzf', file], { maxBuffer: 64 * 1024 ** 2 })).stdout.trim().split(/\r?\n/);
      const prefix = listing[0].split('/')[0] + '/';
      if (!listing.every(name => name.startsWith(prefix) && !name.split('/').includes('..'))) throw new Error('Unexpected source archive layout');
      const chosen = listing.filter(name => {
        if (name.endsWith('/')) return false;
        const relative = name.slice(prefix.length), base = path.posix.basename(relative);
        return (item.licenseFiles || []).includes(relative) || /^(?:LICENSE|COPYING|COPYRIGHT|PATENTS)(?:[._-].*)?$/i.test(base);
      });
      const notices = [];
      const noticeDirectory = path.join(root, 'vendor/licenses/components', item.id);
      await fs.mkdir(noticeDirectory, { recursive: true });
      for (const name of chosen) {
        const relative = name.slice(prefix.length);
        const text = (await run('tar', ['-xOzf', file, name], { encoding: 'buffer', maxBuffer: 2 * 1024 ** 2 })).stdout;
        if (text.includes(0) || text.length > 1024 ** 2) continue;
        const notice = relative.replaceAll('/', '__');
        await fs.writeFile(path.join(noticeDirectory, notice), text);
        notices.push({ sourceFile: relative, bundledNotice: `vendor/licenses/components/${item.id}/${notice}` });
      }
      if (!notices.length) throw new Error('No upstream license material: ' + item.id);
      results[index] = { ...item, sourceUrl, archive, archiveSha256: digest(bytes), archiveBytes: bytes.length, notices };
      console.log(`${item.id}: ${bytes.length} bytes; ${notices.length} notice files`);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  const binaryFiles = ['vendor/core/ffmpeg-core.js', 'vendor/core/ffmpeg-core.wasm'];
  const binaries = [];
  for (const file of binaryFiles) binaries.push({ file, sha256: digest(await fs.readFile(path.join(root, file))) });
  const manifest = { project: 'YanagionSabigi/x-media-copy', version, corePackage: '@ffmpeg/core@0.12.10', wrapperPackage: '@ffmpeg/ffmpeg@0.12.15', upstreamCommit: components[0].sha, binaries, components: results };
  const json = JSON.stringify(manifest, null, 2) + '\n';
  await fs.writeFile(path.join(root, 'vendor/source-manifest.json'), json);
  await fs.writeFile(path.join(stage, 'source-manifest.json'), json);
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(stage, 'PROJECT-LICENSE'));
  await fs.copyFile(path.join(root, 'NOTICE.md'), path.join(stage, 'PROJECT-NOTICE.md'));
  await fs.writeFile(path.join(stage, 'SHA256SUMS'), results.map(item => `${item.archiveSha256}  ${item.archive}`).join('\n') + '\n');
  await fs.writeFile(path.join(stage, 'README.md'), `# Corresponding upstream source for x-media-copy ${version}\n\nAll archives preserve complete upstream source trees and their native license notices. Immutable commits and archive checksums are in source-manifest.json and SHA256SUMS. Project source is available at https://github.com/YanagionSabigi/x-media-copy/tree/v${version}.\n\n## Recover the build inputs\n\nExtract each archive under a component-named directory, stripping its single top-level prefix (for example: mkdir ffmpegwasm && tar -xzf archives/ffmpegwasm-<sha>.tar.gz -C ffmpegwasm --strip-components=1). Component ids, repositories, refs and exact commits are recorded in the manifest. Restore the googletest tree under zimg/test/extra/googletest for the recursive checkout expected by the upstream Dockerfile. The googletest source is test-only.\n\nThe ffmpegwasm tree contains Dockerfile, Makefile, build/*.sh, src/bind and src/fftools. Its packages/core/package.json is 0.12.10 and packages/ffmpeg/package.json is 0.12.15. It builds FFmpeg n5.1.4 and linked libraries with emscripten/emsdk:3.1.40. The complete sources of every Dockerfile library, SDL2 release-2.24.2 and the Emscripten/emsdk configuration are included here. The optimized single-thread target is make prd (not the default development target); consult the pinned Dockerfile and Makefile for all flags.\n\nThe original Dockerfile downloads source refs. For an offline-source rebuild, first place extracted dependency trees inside the ffmpegwasm Docker build context, for example ffmpegwasm/sources/<id>. Replace each Dockerfile ADD git URL with COPY sources/<id> /src (and replace the zimg git clone similarly); keep source contents unchanged. Point the Emscripten SDL2 port at the included SDL source, or repopulate its source cache as documented by tools/ports/sdl2.py. The general compiler binaries, Docker engine/base images and system build tools are not bundled; install the exact SDK version through the included emsdk installer or obtain the documented upstream image. Compiler/runtime source and licenses are included.\n\nThe distributed core binary is the unmodified npm @ffmpeg/core 0.12.10 artifact. npm ci --ignore-scripts and npm run vendor in the project obtain that same locked artifact; its JS/WASM SHA256 hashes are in the manifest. This is the release's exact binary reproduction path. Compiling sources can produce different byte sequences depending on toolchain/environment.\n\nThe JS API wrapper has one local patch: vendor/ffmpeg/const.js uses a packaged URL instead of the CDN default; scripts/vendor.cjs documents and reproduces it. No native application is required to run the extension. This source archive is for source redistribution/build work; install the separate extension ZIP instead.\n`);
  await copyTree(path.join(root, 'vendor/licenses/components'), path.join(stage, 'licenses/components'));
  const output = path.join(root, `release/x-media-copy-upstream-sources-${version}.tar.gz`);
  await run('tar', ['-czf', output, '-C', path.join(root, 'release'), 'upstream-source'], { maxBuffer: 8 * 1024 ** 2 });
  console.log(JSON.stringify({ output: path.relative(root, output), components: results.length, sha256: digest(await fs.readFile(output)) }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
