const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function api() {
  const sandbox = vm.createContext({});
  const file = path.join(__dirname, '../image-merge.js');
  if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox);
  return sandbox.XCopyImageMerge;
}
// Each signature represents a distinct edge colour; only genuine joins match.
const edge = n => new Uint8ClampedArray([n, n, n, 255]);
const tile = (width, height, left, right, top, bottom) => ({ width, height,
  edges: { left: edge(left), right: edge(right), top: edge(top), bottom: edge(bottom) } });

test('four vertical slices join horizontally in attachment order at original size', () => {
  const merger = api();
  assert.ok(merger, 'image merging is available');
  const layout = merger.chooseLayout([
    tile(684, 2048, 0, 40, 0, 220), tile(684, 2048, 40, 80, 0, 220),
    tile(684, 2048, 80, 120, 0, 220), tile(684, 2048, 120, 160, 0, 220)
  ]);
  assert.equal(layout.width, 2736); assert.equal(layout.height, 2048);
  assert.deepEqual(Array.from(layout.placements, p => [p.x, p.y]), [[0, 0], [684, 0], [1368, 0], [2052, 0]]);
});

test('wide slices join vertically and retain an unequal last slice height', () => {
  const merger = api(); assert.ok(merger, 'image merging is available');
  const layout = merger.chooseLayout([tile(900, 300, 0, 230, 0, 50), tile(900, 250, 0, 230, 50, 100)]);
  assert.equal(layout.width, 900); assert.equal(layout.height, 550);
  assert.deepEqual(Array.from(layout.placements, p => [p.x, p.y]), [[0, 0], [0, 300]]);
});

test('edge evidence selects a 2 by 2 grid even when all three layouts fit', () => {
  const merger = api(); assert.ok(merger, 'image merging is available');
  const layout = merger.chooseLayout([
    tile(100, 100, 0, 40, 0, 80), tile(100, 100, 40, 250, 0, 120),
    tile(100, 100, 0, 160, 80, 250), tile(100, 100, 160, 250, 120, 250)
  ]);
  assert.equal(layout.width, 200); assert.equal(layout.height, 200);
  assert.deepEqual(Array.from(layout.placements, p => [p.x, p.y]), [[0, 0], [100, 0], [0, 100], [100, 100]]);
});

test('refuses nonrectangular attachments and oversized output instead of resizing', () => {
  const merger = api(); assert.ok(merger, 'image merging is available');
  assert.throws(() => merger.chooseLayout([tile(100, 200, 0, 0, 0, 0), tile(101, 201, 0, 0, 0, 0)]), /尺寸|矩形/);
  assert.throws(() => merger.chooseLayout([tile(10000, 10000, 0, 0, 0, 0), tile(10000, 10000, 0, 0, 0, 0)]), /上限/);
});
