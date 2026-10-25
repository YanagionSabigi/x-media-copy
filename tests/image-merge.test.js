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
  assert.throws(() => merger.chooseLayout([tile(100, 200, 0, 0, 0, 0), tile(101, 201, 0, 0, 0, 0)]), /尺寸|矩形/);
  assert.throws(() => merger.chooseLayout([tile(10000, 10000, 0, 0, 0, 0), tile(10000, 10000, 0, 0, 0, 0)]), /上限/);
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
