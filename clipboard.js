(function (root) {
  "use strict";
  const core = typeof module !== "undefined" && module.exports ? require("./core.js") : root.XCopyCore;
  // QQ truncates a pasted rich-text record at about 16 MiB. Above this bound,
  // save originals locally and reference them by file path instead of Base64.
  const INLINE_HTML_LIMIT = 16 * 1024 ** 2 - 128 * 1024;
  async function stageImages(images, onStage) {
    const urls = images.map(image => image?.url);
    if (urls.some(url => typeof url !== 'string' || !url)) throw new Error('原图地址缺失，无法保存本地副本');
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('扩展后台不可用，无法保存原图副本');
    onStage?.();
    const response = await chrome.runtime.sendMessage({ type: 'stageClipboardImages', urls });
    if (!response?.ok) throw new Error(response?.error || '保存原图副本失败');
    const data = response.data;
    if (typeof data?.batchId !== 'string' || !Array.isArray(data.fileUrls) || data.fileUrls.length !== urls.length) {
      throw new Error('原图副本返回无效');
    }
    return data;
  }
  async function finishBatch(type, batchId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage({ type, batchId });
        if (response?.ok) return true;
      } catch { /* The worker may be restarting. */ }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }
  function attachFiles(data, fileUrls) {
    return { ...data, images: data.images.map((image, index) => ({ ...image, fileUrl: fileUrls[index] })) };
  }
  async function writeText(data) {
    if (data.mergedImage && !data.mergedImage.dataUrl?.startsWith('data:image/png;base64,')) throw new Error('合成图不是有效的 PNG，复制未完成');
    let payload = core.buildClipboardPayload(data), staged = null;
    try {
      if (!data.mergedImage && data.images?.length && payload.html.length > INLINE_HTML_LIMIT) {
        staged = await stageImages(data.images, data.onStage);
        data = attachFiles(data, staged.fileUrls);
        payload = core.buildClipboardPayload(data);
      }
    } catch (error) {
      if (staged) await finishBatch('releaseClipboardImages', staged.batchId);
      throw error;
    }
    const formats = {
      "text/plain": new Blob([payload.plain], { type: "text/plain" }),
      "text/html": new Blob([payload.html], { type: "text/html" })
    };
    // Keep text and HTML together. The receiver chooses the pasted format.
    // This is a processing bound, not a QQ limit.
    // 36 MiB PNG expands to 48 MiB Base64; reserve space for text and markup.
    if (data.mergedImage && formats['text/html'].size > 50 * 1024 * 1024) throw new Error('无损合图的图文数据超过 50 MiB 处理上限；请用普通点击分别复制原图');
    try {
      await navigator.clipboard.write([new ClipboardItem(formats)]);
    } catch (error) {
      if (staged) await finishBatch('releaseClipboardImages', staged.batchId);
      throw error;
    }
    if (staged) await finishBatch('confirmClipboardImages', staged.batchId);
  }
  async function writeProfile(data) {
    let payload = core.buildProfilePayload(data), staged = null;
    try {
      if (data.images?.length && payload.html.length > INLINE_HTML_LIMIT) {
        staged = await stageImages(data.images, data.onStage);
        data = attachFiles(data, staged.fileUrls);
        payload = core.buildProfilePayload(data);
      }
    } catch (error) {
      if (staged) await finishBatch('releaseClipboardImages', staged.batchId);
      throw error;
    }
    const formats = {
      "text/plain": new Blob([payload.plain], { type: "text/plain" }),
      "text/html": new Blob([payload.html], { type: "text/html" })
    };
    // A profile batch is bounded by the selectable image count, not by QQ.
    if (formats["text/html"].size > 128 * 1024 * 1024) throw new Error('所选图文数据超过 128 MiB 处理上限，请少选几张原图');
    try {
      await navigator.clipboard.write([new ClipboardItem(formats)]);
    } catch (error) {
      if (staged) await finishBatch('releaseClipboardImages', staged.batchId);
      throw error;
    }
    if (staged) await finishBatch('confirmClipboardImages', staged.batchId);
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
  const api = { writeText, writeProfile, writeImage, inspectImages };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.XCopyClipboard = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
