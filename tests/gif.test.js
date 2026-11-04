const test = require('node:test');
const assert = require('node:assert/strict');
const gif = require('../gif.js');
test('GIF accepts 20 second 1080p60 and 4K60 sources within per-frame and file limits', () => {
  assert.doesNotThrow(() => gif.validate({ size: 100000, width: 800, height: 640, duration: 3, fps: 24 }));
  assert.doesNotThrow(() => gif.validate({ size: 100 * 1024 ** 2, width: 1920, height: 1080, duration: 20, fps: 60 }));
  assert.doesNotThrow(() => gif.validate({ size: 100 * 1024 ** 2, width: 3840, height: 2160, duration: 20, fps: 60 }));
  for (const patch of [{ size: 129 * 1024 ** 2 }, { duration: 61 }, { width: 4096, height: 4096, duration: 30 }, { fps: 0 }, { width: 0 }]) {
    assert.throws(() => gif.validate({ size: 1000, width: 800, height: 640, duration: 3, fps: 24, ...patch }));
  }
});

test('the default slim preset uses 10 fps / max 480 px / 128 colors on both passes', () => {
  const args = gif.argumentsFor('input.mp4', 'output.gif');
  const palette = gif.paletteArguments('input.mp4');
  const filter = "fps=10,scale=w='min(480,iw)':h=-1:flags=lanczos";
  assert.deepEqual(gif.preset, { fps: 10, maxWidth: 480, colors: 128 });
  assert.equal(palette[palette.indexOf('-vf') + 1], filter + ',palettegen=stats_mode=full:max_colors=128');
  assert.equal(args[args.indexOf('-lavfi') + 1], '[0:v:0]' + filter + '[sampled];[sampled][1:v:0]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle');
  assert.equal(args[args.indexOf('-gifflags') + 1], '+offsetting+transdiff');
  assert.ok(args.includes('-an'));
  assert.doesNotMatch(args.join(' '), /setpts=|-r /);
  assert.equal(args.at(-1), 'output.gif');
  assert.ok(args.includes('0'));
  assert.match([...palette, ...args].join(' '), /palettegen.*paletteuse/);
  assert.doesNotMatch(args.join(' '), /sierra2_4a/);
});

test('source GIF preserves dimensions and frame timing with a full palette', () => {
  const args = gif.argumentsFor('a.mp4', 'b.gif', 'source');
  const palette = gif.paletteArguments('a.mp4', 'source');
  assert.equal(palette[palette.indexOf('-vf') + 1], 'palettegen=stats_mode=full');
  assert.equal(args[args.indexOf('-lavfi') + 1], '[0:v:0][1:v:0]paletteuse=dither=sierra2_4a');
  assert.doesNotMatch([...palette, ...args].join(' '), /fps=|scale=|setpts=|-r /);
  assert.equal(args[args.indexOf('-fps_mode') + 1], 'passthrough');
  assert.ok(args.includes('-an'));
  assert.equal(args[args.indexOf('-loop') + 1], '0');
});

test('unknown GIF modes are rejected', () => {
  for (const mode of [15, 'fast', null]) {
    assert.throws(() => gif.argumentsFor('a.mp4', 'b.gif', mode), /模式/);
    assert.throws(() => gif.paletteArguments('a.mp4', mode), /模式/);
  }
});
test('GIF probe handles rational frame rates and rejects broken probe data', () => {
  assert.deepEqual(gif.parseProbe({ streams: [{ width: 100, height: 90, avg_frame_rate: '30000/1001' }], format: { duration: '1.5' } }, 1000), { size: 1000, width: 100, height: 90, fps: 30000 / 1001, duration: 1.5 });
  assert.throws(() => gif.parseProbe({ streams: [] }, 100));
});
test('FFprobe legacy unset exit status requires valid structured output', () => {
  assert.equal(gif.parseProbeOutput(-1, '{"streams":[{"width":96}]}').streams[0].width, 96);
  assert.throws(() => gif.parseProbeOutput(1, '{"streams":[{}]}'));
  assert.throws(() => gif.parseProbeOutput(-1, ''));
  assert.throws(() => gif.parseProbeOutput(-1, '{"streams":[]}'));
});
test('palette generation runs in a separate pass to avoid buffering every decoded frame', () => {
  assert.match(gif.paletteArguments('input.mp4').join(' '), /palettegen/);
  assert.doesNotMatch(gif.argumentsFor('input.mp4', 'output.gif').join(' '), /split\[/);
});
