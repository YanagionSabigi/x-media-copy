(function (root) {
  "use strict";
  const core = typeof module !== "undefined" && module.exports ? require("./core.js") : root.XCopyCore;
  async function writeText(data) {
    if (data.mergedImage && !data.mergedImage.dataUrl?.startsWith('data:image/png;base64,')) throw new Error('合成图不是有效的 PNG，复制未完成');
    const payload = core.buildClipboardPayload(data);
    const formats = {
      "text/plain": new Blob([payload.plain], { type: "text/plain" }),
      "text/html": new Blob([payload.html], { type: "text/html" })
    };
    // Browser clipboard success does not imply QQ can consume large HTML.
    // Keep a conservative mixed-paste bound; offer the lossless file separately.
    if (data.mergedImage && formats['text/html'].size > 16 * 1024 * 1024) {
      const error = new Error('无损合图的图文数据超过 16 MiB 兼容上限，未复制；可下载无损 PNG');
      error.code = 'MERGED_CLIPBOARD_TOO_LARGE';
      throw error;
    }
    await navigator.clipboard.write([new ClipboardItem(formats)]);
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
