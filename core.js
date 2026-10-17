(function (root) {
  "use strict";

  function cleanText(value) {
    return String(value || "").replace(/\r\n?/g, "\n").replace(/[\t ]+\n/g, "\n").trim();
  }

  function stripHashtags(value) {
    // Keep URL fragments and ordinary uses such as C# intact. Unicode covers
    // Chinese/Japanese tags, combining marks, digits and underscores.
    const parts = cleanText(value).split(/(https?:\/\/[^\s]+)/gi);
    const tag = /(?<![\p{L}\p{M}\p{N}_])(?:[#＃][\p{L}\p{M}\p{N}_]+(?:[.\-・･'’＆&][\p{L}\p{M}\p{N}_]+)*)+/gu;
    const pairs = [['(', ')'], ['（', '）'], ['[', ']'], ['【', '】'], ['「', '」'], ['『', '』']];
    const cleaned = parts.map((part, index) => {
      if (index % 2) return part;
      return part.split('\n').map(line => {
        const hadTag = new RegExp(tag.source, 'u').test(line);
        // Remove brackets only when their entire content consists of tags.
        for (const [open, close] of pairs) {
          let start = line.indexOf(open);
          while (start !== -1) {
            const end = line.indexOf(close, start + 1);
            if (end === -1) break;
            const inside = line.slice(start + 1, end);
            if (new RegExp(tag.source, 'u').test(inside) && !inside.replace(tag, '').trim()) {
              line = line.slice(0, start) + line.slice(end + 1);
            } else start = end;
            start = line.indexOf(open, start);
          }
        }
        line = line.replace(tag, '');
        return hadTag && /^[\s\p{P}\p{S}]*$/u.test(line) ? '' : line;
      }).join('\n');
    }).join("");
    return cleanText(cleaned.replace(/[\t ]{2,}/g, " ")
      .replace(/^[\t ]+|[\t ]+$/gm, "").replace(/\n{3,}/g, "\n\n"));
  }

  function canonicalPostUrl(raw) {
    try {
      const url = new URL(raw, "https://x.com");
      if (!/^(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)$/.test(url.hostname)) return "";
      if (!["https:", "http:"].includes(url.protocol)) return "";
      const path = url.pathname.match(/^\/(?:i\/web|i|[a-zA-Z0-9_]+)\/status\/[0-9]+/);
      return path ? `https://x.com${path[0]}` : "";
    } catch { return ""; }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[char]);
  }

  function htmlText(value) {
    return escapeHtml(value).replace(/\n/g, "<br>");
  }

  function buildClipboardPayload({ original, translation, postUrl, images = [] }) {
    original = stripHashtags(original);
    translation = stripHashtags(translation);
    postUrl = canonicalPostUrl(postUrl);
    const sections = [];
    if (original) sections.push(original);
    if (translation) sections.push(translation);
    const text = sections.join("\n\n");
    const plain = [text, postUrl].filter(Boolean).join('\n');

    const htmlSections = [];
    if (original) htmlSections.push(htmlText(original));
    if (translation) htmlSections.push(htmlText(translation));
    let imageHtml = '';
    for (const item of images) {
      if (/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(item.dataUrl || '')) {
        imageHtml += `<img src="${escapeHtml(item.dataUrl)}" alt="" style="max-width:100%;height:auto;vertical-align:bottom">`;
      }
    }
    const body = htmlSections.join('<br><br>');
    const link = postUrl ? `<a href="${escapeHtml(postUrl)}">${escapeHtml(postUrl)}</a>` : '';
    return { plain, html: `<div>${[body, imageHtml, link].filter(Boolean).join('<br>')}</div>` };
  }

  const api = { cleanText, stripHashtags, canonicalPostUrl, buildClipboardPayload };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.XCopyCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
