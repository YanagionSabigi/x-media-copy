const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const zlib = require('node:zlib');

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
  assert.throws(() => merger.chooseLayout([tile(100, 200, 0, 0, 0, 0), tile(140, 250, 0, 0, 0, 0)]), /尺寸|矩形/);
  assert.throws(() => merger.chooseLayout([tile(10000, 10000, 0, 0, 0, 0), tile(10000, 10000, 0, 0, 0, 0)]), /上限/);
});

test('post 2119234009901543927 joins slightly different slices without resizing', () => {
  const layout = api().chooseLayout([
    tile(1446, 2892, 0, 40, 0, 220), tile(1446, 2892, 40, 80, 0, 220),
    tile(1417, 2835, 80, 120, 0, 220), tile(1418, 2835, 120, 160, 0, 220)
  ]);
  assert.equal(layout.width, 5727); assert.equal(layout.height, 2892);
  assert.deepEqual(Array.from(layout.placements, p => [p.x, p.y]), [[0, 0], [1446, 0], [2892, 0], [4309, 0]]);
});

test('near-matching horizontal slices join vertically with original heights', () => {
  const layout = api().chooseLayout([tile(300, 100, 0, 230, 0, 50), tile(294, 101, 0, 230, 50, 100)]);
  assert.equal(layout.width, 300); assert.equal(layout.height, 201);
  assert.deepEqual(Array.from(layout.placements, p => [p.x, p.y]), [[0, 0], [0, 100]]);
});

test('PNG recompression preserves scanline bytes, metadata and valid checksums while reducing size', async () => {
  const merger = require('../image-merge.js');
  assert.equal(typeof merger.optimizePng, 'function');
  const crc = bytes => { let value=0xffffffff; for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;}return(value^0xffffffff)>>>0; };
  const chunk = (type,bytes) => {const output=Buffer.alloc(bytes.length+12);output.writeUInt32BE(bytes.length);output.write(type,4);bytes.copy(output,8);output.writeUInt32BE(crc(output.subarray(4,-4)),output.length-4);return output;};
  const header=Buffer.alloc(13);header.writeUInt32BE(32);header.writeUInt32BE(32,4);header[8]=8;header[9]=6;
  const raw=Buffer.alloc((32*4+1)*32,50);for(let row=0;row<32;row++)raw[row*129]=0;
  const compressed=zlib.deflateSync(raw,{level:0});
  const metadata=chunk('tEXt',Buffer.from('Comment\0preserve this'));
  const input=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),metadata,chunk('IDAT',compressed.subarray(0,30)),chunk('IDAT',compressed.subarray(30)),chunk('IEND',Buffer.alloc(0))]);
  const blob=await merger.optimizePng(new Blob([input],{type:'image/png'}));
  const output=Buffer.from(await blob.arrayBuffer()),idats=[];
  assert.ok(output.length<input.length);assert.equal(blob.type,'image/png');assert.ok(output.includes(metadata));
  for(let k=8;k<output.length;){const n=output.readUInt32BE(k),type=output.toString('ascii',k+4,k+8);assert.equal(output.readUInt32BE(k+8+n),crc(output.subarray(k+4,k+8+n)));if(type==='IDAT')idats.push(output.subarray(k+8,k+8+n));k+=n+12;}
  assert.deepEqual(zlib.inflateSync(Buffer.concat(idats)),raw);
  const cancelled=new Error('page changed');
  await assert.rejects(()=>merger.optimizePng(new Blob([input]),()=>{throw cancelled;}),error=>error===cancelled);
});

test('post 2119402782662988030 keeps the four slices in one row despite flat top and bottom margins', () => {
  // Four slices of one wide illustration. The artwork has white margins, so a
  // spurious 2x2 grid joins two white edges; those joins are detail-free and
  // must not outvote the real vertical seams.
  const merger = api(); assert.ok(merger, 'image merging is available');
  const bands = (base, step) => {
    const data = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < 64; i++) {
      const value = i % 2 ? base : base + step;
      data.set([value, value, value, 255], i * 4);
    }
    return data;
  };
  const white = new Uint8ClampedArray([255, 255, 255, 255]);
  const slice = (width, height, left, right) => ({ width, height,
    edges: { left: bands(left, 40), right: bands(right, 40), top: white, bottom: white } });
  const layout = merger.chooseLayout([
    slice(646, 1620, 100, 160), slice(646, 1622, 166, 220),
    slice(646, 1621, 226, 280), slice(647, 1620, 286, 340)
  ]);
  assert.equal(layout.width, 2585);
  assert.equal(layout.height, 1622);
  assert.deepEqual(Array.from(layout.placements, p => [p.x, p.y]), [[0, 0], [646, 0], [1292, 0], [1938, 0]]);
});

test('a genuine 2 by 2 grid with detailed joins still wins over a false row', () => {
  const merger = api(); assert.ok(merger, 'image merging is available');
  const bands = base => {
    const data = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < 64; i++) {
      const value = i % 2 ? base : base + 40;
      data.set([value, value, value, 255], i * 4);
    }
    return data;
  };
  const quad = (left, right, top, bottom) => ({ width: 500, height: 500,
    edges: { left: bands(left), right: bands(right), top: bands(top), bottom: bands(bottom) } });
  const layout = merger.chooseLayout([
    quad(100, 160, 40, 70), quad(166, 220, 40, 70),
    quad(100, 160, 76, 130), quad(166, 220, 76, 130)
  ]);
  assert.equal(layout.width, 1000);
  assert.equal(layout.height, 1000);
  assert.deepEqual(Array.from(layout.placements, p => [p.x, p.y]), [[0, 0], [500, 0], [0, 500], [500, 500]]);
});

test('twenty slices merge as a 4 by 5 grid and a twenty-first is rejected', () => {
  const merger = api(); assert.ok(merger, 'image merging is available');
  const bands = base => {
    const data = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < 64; i++) {
      const value = i % 2 ? base : base + 40;
      data.set([value, value, value, 255], i * 4);
    }
    return data;
  };
  // Build exact joins for four columns and five rows. Right/bottom edges repeat
  // the neighbour's left/top edge, so other factorisations cannot score zero.
  const tiles = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 4; col++) {
    tiles.push({ width: 100, height: 100, edges: {
      left: bands(100 + row * 10 + col * 3), right: bands(100 + row * 10 + (col + 1) * 3),
      top: bands(200 + row * 10 + col * 3), bottom: bands(200 + (row + 1) * 10 + col * 3)
    } });
  }
  const layout = merger.chooseLayout(tiles);
  assert.equal(tiles.length, 20);
  assert.equal(layout.width, 400);
  assert.equal(layout.height, 500);
  assert.equal(layout.placements.length, 20);
  assert.throws(() => merger.chooseLayout([...tiles, tiles[0]]), /1–20|20 张/);
});
