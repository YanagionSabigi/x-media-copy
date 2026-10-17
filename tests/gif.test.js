const test = require('node:test');
const assert = require('node:assert/strict');
const gif = require('../gif.js');
test('GIF validates real media dimensions, duration and decoded frame budget', () => {
  assert.doesNotThrow(() => gif.validate({ size: 100000, width: 800, height: 640, duration: 3, fps: 24 }));
  for (const patch of [{ size: 33 * 1024 ** 2 }, { duration: 61 }, { width: 4096, height: 4096, duration: 30 }, { fps: 0 }, { width: 0 }]) {
    assert.throws(() => gif.validate({ size: 1000, width: 800, height: 640, duration: 3, fps: 24, ...patch }));
  }
});
test('GIF conversion keeps dimensions and frame cadence and creates an infinite loop', () => {
  const args = gif.argumentsFor('input.mp4', 'output.gif');
  assert.equal(args.at(-1), 'output.gif');
  assert.ok(args.includes('0'));
  assert.match([...gif.paletteArguments('input.mp4'), ...args].join(' '), /palettegen.*paletteuse/);
  assert.doesNotMatch(args.join(' '), /scale=|fps=|-t |crop=/);
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
