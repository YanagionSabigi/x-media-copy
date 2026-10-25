(function (root) {
  'use strict';
  const MAX_PIXELS = 120000000, MAX_SIDE = 32767, MAX_BYTES = 24 * 1024 * 1024;

  function validSize(width, height) {
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
      width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;
  }
  function edgeDifference(a, b) {
    let total = 0;
    // Compare premultiplied colour over white, so invisible RGB is irrelevant.
    for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) {
      total += Math.abs((a[i + c] - 255) * a[i + 3] / 255 - (b[i + c] - 255) * b[i + 3] / 255);
    }
    return total / (a.length / 4 * 3 * 255);
  }
  function chooseLayout(tiles) {
    if (!tiles.length || tiles.length > 16) throw new Error('合图需要 1–16 张静态图片');
    if (tiles.some(tile => !validSize(tile.width, tile.height)) || tiles.reduce((area, tile) => area + tile.width * tile.height, 0) > MAX_PIXELS) {
      throw new Error('合成图片尺寸超过处理上限（1.2 亿像素、单边 32767 像素）');
    }
    const layouts = [];
    // Attachments stay in post order. Try every rectangular row-major grid;
    // native dimensions must fit exactly, with no gaps, crop or resampling.
    for (let columns = 1; columns <= tiles.length; columns++) {
      if (tiles.length % columns) continue;
      const placements = []; let width = 0, height = 0, difference = 0, seams = 0, fits = true;
      for (let start = 0; start < tiles.length; start += columns) {
        const row = tiles.slice(start, start + columns), rowWidth = row.reduce((sum, tile) => sum + tile.width, 0);
        if (row.some(tile => tile.height !== row[0].height) || (start && rowWidth !== width)) { fits = false; break; }
        width = rowWidth; let x = 0;
        for (let col = 0; col < columns; col++) {
          const index = start + col, tile = tiles[index];
          placements.push({ x, y: height }); x += tile.width;
          if (col) { difference += edgeDifference(tiles[index - 1].edges.right, tile.edges.left); seams++; }
          if (start) {
            const above = tiles[index - columns];
            // Require aligned column boundaries for vertical edge comparison.
            if (above.width !== tile.width) { fits = false; break; }
            difference += edgeDifference(above.edges.bottom, tile.edges.top); seams++;
          }
        }
        if (!fits) break;
        height += row[0].height;
      }
      if (fits && validSize(width, height)) {
        // Near-identical/flat edges cannot reveal the layout. Prefer a compact
        // rectangle only as a weak tie-breaker; seam evidence dominates.
        const score = (seams ? difference / seams : 0) + 0.005 * Math.abs(Math.log(width / height));
        layouts.push({ width, height, placements, score });
      }
    }
    if (!layouts.length) throw new Error('图片尺寸无法无缝排成矩形，或合成后单边超过 32767 像素；请用普通点击分别复制');
    layouts.sort((a, b) => a.score - b.score);
    return layouts[0];
  }
  function edges(bitmap) {
    const canvas = new OffscreenCanvas(64, 64), ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('浏览器无法创建合图画布');
    const edge = (sx, sy, sw, sh, dw, dh) => {
      ctx.clearRect(0, 0, 64, 64);
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
      return ctx.getImageData(0, 0, dw, dh).data;
    };
    try {
      return { left: edge(0, 0, 1, bitmap.height, 1, 64), right: edge(bitmap.width - 1, 0, 1, bitmap.height, 1, 64),
        top: edge(0, 0, bitmap.width, 1, 64, 1), bottom: edge(0, bitmap.height - 1, bitmap.width, 1, 64, 1) };
    } finally { canvas.width = canvas.height = 1; }
  }
  function dataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('合成图片编码失败'));
      reader.readAsDataURL(blob);
    });
  }
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  async function optimizePng(blob, check = () => {}) {
    check();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    check();
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((value, index) => bytes[index] === value)) throw new Error('无损 PNG 数据无效');
    const view = new DataView(bytes.buffer), chunks = [], idats = [];
    let offset = 8, ended = false;
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset), end = offset + size + 12;
      if (end > bytes.length) throw new Error('无损 PNG 数据不完整');
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      chunks.push({ type, bytes: bytes.subarray(offset, end) });
      if (type === 'IDAT') idats.push(bytes.subarray(offset + 8, end - 4));
      offset = end;
      if (type === 'IEND') { ended = true; break; }
    }
    if (!ended || !idats.length || offset !== bytes.length) throw new Error('无损 PNG 数据不完整');
    // Recompress the exact filtered scanline stream. No pixel decoding,
    // palette reduction, colour conversion, resizing or transparency changes.
    const stream = new Blob(idats).stream().pipeThrough(new DecompressionStream('deflate')).pipeThrough(new CompressionStream('deflate'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    check();
    const idat = new Uint8Array(compressed.length + 12), outputView = new DataView(idat.buffer);
    outputView.setUint32(0, compressed.length); idat.set([73, 68, 65, 84], 4); idat.set(compressed, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < idat.length - 4; i++) crc = crcTable[(crc ^ idat[i]) & 255] ^ (crc >>> 8);
    outputView.setUint32(idat.length - 4, (crc ^ 0xffffffff) >>> 0);
    let inserted = false;
    const parts = [bytes.subarray(0, 8)];
    for (const chunk of chunks) {
      if (chunk.type !== 'IDAT') parts.push(chunk.bytes);
      else if (!inserted) { parts.push(idat); inserted = true; }
    }
    const optimized = new Blob(parts, { type: 'image/png' });
    check();
    return optimized.size < blob.size ? optimized : blob;
  }
  async function mergeImages(images, check = () => {}) {
    check();
    if (images.length < 2) return images;
    if (images.length > 16) throw new Error('一次最多合并 16 张静态图片');
    const tiles = [];
    for (const image of images) {
      const bitmap = await createImageBitmap(await (await fetch(image.dataUrl)).blob());
      try {
        check();
        if (!validSize(bitmap.width, bitmap.height)) throw new Error('原图尺寸超过合图处理上限');
        tiles.push({ width: bitmap.width, height: bitmap.height, edges: edges(bitmap) });
      } finally { bitmap.close(); }
    }
    const layout = chooseLayout(tiles);
    check();
    const canvas = new OffscreenCanvas(layout.width, layout.height), ctx = canvas.getContext('2d');
    try {
      if (!ctx) throw new Error('浏览器无法创建合图画布');
      // Decode and draw one original at a time, then release it immediately.
      for (let i = 0; i < images.length; i++) {
        check();
        const bitmap = await createImageBitmap(await (await fetch(images[i].dataUrl)).blob());
        try { check(); ctx.drawImage(bitmap, layout.placements[i].x, layout.placements[i].y); }
        finally { bitmap.close(); }
      }
      let blob = await canvas.convertToBlob({ type: 'image/png' });
      check();
      if (blob.size > MAX_BYTES) throw new Error('合成 PNG 超过 24 MiB，请用普通点击分别复制');
      blob = await optimizePng(blob, check);
      const encoded = await dataUrl(blob);
      check();
      return [{ dataUrl: encoded, width: layout.width, height: layout.height }];
    } finally { canvas.width = canvas.height = 1; }
  }
  const api = { chooseLayout, mergeImages, optimizePng };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XCopyImageMerge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
