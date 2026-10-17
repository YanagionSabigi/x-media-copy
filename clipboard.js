(function (root) {
  "use strict";
  const core = typeof module !== "undefined" && module.exports ? require("./core.js") : root.XCopyCore;
  async function writeText(data) {
    const payload = core.buildClipboardPayload(data);
    await navigator.clipboard.write([new ClipboardItem({
      "text/plain": new Blob([payload.plain], { type: "text/plain" }),
      "text/html": new Blob([payload.html], { type: "text/html" })
    })]);
  }
  async function inspectImages(images) {
    const result = [];
    for (const image of images) {
      const blob = await (await fetch(image.dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      try {
        if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 120000000) throw new Error('原图尺寸超过剪贴板处理上限');
        result.push({ ...image, width: bitmap.width, height: bitmap.height });
      } finally { bitmap.close(); }
    }
    return result;
  }
  async function writeImage(image) {
    const source = await (await fetch(image.dataUrl)).blob();
    let png = source;
    if (source.type !== 'image/png') {
      const bitmap = await createImageBitmap(source);
      try {
        if (bitmap.width * bitmap.height > 120000000) throw new Error('原图尺寸超过剪贴板处理上限');
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        png = await canvas.convertToBlob({ type: 'image/png' });
      } finally { bitmap.close(); }
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  }
  const api = { writeText, writeImage, inspectImages };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.XCopyClipboard = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
