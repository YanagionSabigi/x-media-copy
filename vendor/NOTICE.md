# Bundled conversion libraries

- `ffmpeg/`: @ffmpeg/ffmpeg 0.12.15, MIT, Copyright (c) 2019 Jerome Wu. Source: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/71aa99d37c02a7b4c435275ca9ef50e612f6efa1/packages/ffmpeg (tag v12.15). One local modification replaces the default CDN core URL with a packaged URL in const.js.
- `core/`: @ffmpeg/core 0.12.10, single-thread WebAssembly FFmpeg, GPL-2.0-or-later, distributed upstream at https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10 . Corresponding source/build scripts: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/71aa99d37c02a7b4c435275ca9ef50e612f6efa1 (2025-01-07 release commit), especially packages/core, src/bind, src/fftools, build, Dockerfile and Makefile. The compiled core includes FFmpeg and external codec libraries; their GPL/LGPL/native terms apply. The older tag v0.12.10 contains core 0.12.6 and is not the source of this binary.
- FFmpeg source and licensing: https://ffmpeg.org/legal.html ; https://github.com/FFmpeg/FFmpeg . The extension does not distribute or install a native executable.

The extension loads all JS and WASM from its own package. No media is uploaded for conversion. To reproduce the bundled files, install the exact versions in package-lock.json (`npm ci --ignore-scripts`) and run `node scripts/vendor.cjs`.

## Complete source distribution

The same GitHub Release provides `x-media-copy-upstream-sources-1.0.1.tar.gz`: immutable archives for ffmpeg.wasm, FFmpeg n5.1.4, all 15 libraries referenced by its Dockerfile, linked SDL 2.24.2, Emscripten/emsdk 3.1.40, and zimg's test-only Googletest submodule. Native licenses and notices are preserved inside every archive, with additional copies under `licenses/components/`. Exact commits, archive hashes, binary hashes and notice locations are in `source-manifest.json`. Source/archive reconstruction and build instructions are included with the source bundle; the optimized upstream single-thread build target is `make prd`.

Download binary and corresponding sources from the same page: https://github.com/YanagionSabigi/x-media-copy/releases/tag/v1.0.1 . Project source is at https://github.com/YanagionSabigi/x-media-copy/tree/v1.0.1 . No promise of byte-identical compiler output is made; the packaged core itself is unchanged from the locked npm artifact.

Cat Catch is an optional external-extension integration, not bundled software. Full project credits and the scope of the project's GPL-3.0-or-later license are in `../NOTICE.md` and `../LICENSE`. Individual third-party terms remain in effect.
