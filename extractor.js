(function (root) {
  "use strict";
  const core = typeof module !== "undefined" && module.exports ? require("./core.js") : root.XCopyCore;
  const labels = {
    original: /^(?:show|view|see) original$|^(?:显示|查看|顯示|查看)原文$|^原文を表示$|^원문 보기$/i,
    translation: /^(?:(?:show|view|see) translation|translate (?:post|tweet))$|^(?:显示|查看|顯示|翻译|翻譯)(?:翻译|翻譯|帖子|推文|貼文)$|^翻訳(?:する|を表示)$|^게시물 번역$/i
  };
  const excluded = '[data-testid="card.wrapper"], [data-testid="quoteTweet"], [data-testid="User-Name"], [data-testid="socialContext"], [data-testid="birdwatch-pivot"], [data-x-copy-ui]';
  const metadata = /^(?:translated (?:by|from)|translation by|翻译自|翻譯自|由.{0,30}翻[译譯]|grok\s*(?:翻译|翻譯)|(?:翻译|翻譯)(?:由|提供)|正在翻译|翻译中|translating|loading)/i;

  function owns(article, node) {
    if (node.closest("article") !== article || node.closest(excluded)) return false;
    // X quote cards are often role=link containers inside the parent article.
    for (let parent = node.parentElement; parent && parent !== article; parent = parent.parentElement) {
      if (parent.matches('[role="link"][tabindex]') && parent.querySelector('a[href*="/status/"]')) return false;
    }
    return true;
  }
  function text(node) {
    function walk(current) {
      if (current.nodeType === 3) return current.nodeValue;
      if (current.nodeType !== 1) return "";
      if (current.tagName === 'A') {
        const href = current.getAttribute('href') || '';
        // X's own tag boundary is more reliable than guessing punctuation.
        if (/^(?:https:\/\/(?:www\.)?(?:x|twitter)\.com)?\/hashtag\//i.test(href) || current.dataset?.entityType === 'hashtag') return '\u0000';
      }
      if (current.tagName === "IMG") return current.getAttribute("alt") || "";
      if (current.tagName === "BR") return "\n";
      return [...current.childNodes].map(walk).join("");
    }
    const pairs = { '(': ')', '（': '）', '[': ']', '【': '】', '「': '」', '『': '』' };
    const value = walk(node).replace(/([（(\[【「『])[\t ]*(?:\u0000[\t ]*)+([）)\]】」』])/g,
      (match, open, close) => pairs[open] === close ? '' : match).replace(/\u0000/g, '');
    return core.cleanText(value);
  }
  function visible(node) {
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      const style = current.ownerDocument.defaultView?.getComputedStyle(current);
      if (style?.display === "none" || style?.visibility === "hidden") return false;
    }
    return true;
  }
  function control(article, type) {
    const matches = [...article.querySelectorAll('button, [role="button"], a, span, div')].filter(node => {
      const values = [node.textContent || "", node.getAttribute("aria-label") || ""];
      if (!values.some(value => value.length < 100 && labels[type].test(value.replace(/\s+/g, " ").trim()))) return false;
      return owns(article, node) && visible(node) && !node.closest('[data-testid="tweetText"]');
    });
    // Choose the innermost label, then its clickable ancestor when present.
    const node = matches.find(candidate => !matches.some(other => other !== candidate && candidate.contains(other)));
    if (!node) return null;
    const clickable = node.closest('button, [role="button"], a');
    return clickable && owns(article, clickable) ? clickable : node;
  }
  function readState(article) {
    const primaryNodes = [...article.querySelectorAll('[data-testid="tweetText"]')]
      .filter(node => owns(article, node) && visible(node));
    const primary = primaryNodes.map(text).filter(Boolean);
    const markers = [...article.querySelectorAll('span, div')].filter(node => {
      const value = (node.textContent || "").trim();
      return value.length < 100 && metadata.test(value) && owns(article, node) &&
        ![...node.children].some(child => metadata.test((child.textContent || "").trim()));
    });
    const markedNodes = genericTextNodes(article).filter(node => markers.some(marker =>
      marker.parentElement.parentElement?.contains(node) && (marker.compareDocumentPosition(node) & 4)));
    const extraNodes = [...new Set([...article.querySelectorAll('div[lang], span[lang], [data-testid*="translation" i], [data-testid*="translated" i], [data-testid*="translat" i] [dir="auto"]'), ...markedNodes])]
      .filter(node => owns(article, node) && visible(node) &&
        !primaryNodes.some(main => main === node || main.contains(node) || node.contains(main)) &&
        !node.closest('button, [role="button"], [role="group"]'));
    const extras = extraNodes.filter(node => !extraNodes.some(other => other !== node && node.contains(other)))
      .map(text).filter(value => value && !primary.includes(value) && !metadata.test(value) &&
        !labels.original.test(value) && !labels.translation.test(value));
    return { primary: [...new Set(primary)], extras: [...new Set(extras)] };
  }
  function genericTextNodes(article) {
    const nodes = [...article.querySelectorAll('[dir="auto"], div[lang], span[lang]')].filter(node =>
      owns(article, node) && visible(node) && !node.closest('button, [role="button"], [role="group"], time') &&
      !node.closest('[data-testid="tweetText"]') && !node.querySelector('[data-testid="tweetText"]'));
    return nodes.filter(node => !nodes.some(other => other !== node && node.contains(other))).filter(node => {
      const value = text(node);
      return value && !metadata.test(value) && !labels.original.test(value) && !labels.translation.test(value) &&
        !/^[\d\s,.万萬千KMB]+$/.test(value) && !/^(?:翻译失败|无法翻译|重试|translation failed|try again)$/i.test(value);
    });
  }
  function postUrl(article) {
    const links = [...article.querySelectorAll('a[href*="/status/"]')].filter(node => owns(article, node));
    const link = links.find(node => node.querySelector("time")) || links.find(node => !/\/photo\/|\/video\//.test(node.href)) || links[0];
    return core.canonicalPostUrl(link?.getAttribute("href") || "");
  }

  function findTranslation(state, original) {
    return [...state.primary.slice(1), ...state.extras, ...state.primary]
      .find(value => value && value !== original) || "";
  }

  async function waitForValue(read, timeoutMs, settleMs) {
    const start = Date.now();
    let previous = "", stableSince = 0;
    while (Date.now() - start < timeoutMs) {
      const value = read();
      if (value && value === previous && Date.now() - stableSince >= settleMs) return value;
      if (value !== previous) { previous = value; stableSince = Date.now(); }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return read();
  }

  async function captureTexts(article, options = {}) {
    const getArticle = options.getArticle || (() => article);
    const timeoutMs = options.timeoutMs ?? 12000;
    const settleMs = options.settleMs ?? 500;
    const includeTranslation = options.includeTranslation !== false;
    const initial = readState(article);
    const beforeGeneric = new Set(genericTextNodes(article).map(text));
    if (initial.primary.length >= 2) return { original: initial.primary[0], translation: includeTranslation ? initial.primary[1] : '' };
    let original = core.cleanText(options.cachedOriginal || "");
    let translation = "";
    const showOriginal = control(article, "original");
    if (showOriginal) {
      translation = initial.primary[0] || initial.extras[0] || "";
      if (!original) {
        showOriginal.click();
        original = await waitForValue(() => {
          const current = readState(getArticle());
          return [...current.primary, ...current.extras].find(value => value !== translation) || "";
        }, timeoutMs, settleMs);
        control(getArticle(), "translation")?.click();
        if (!original) throw new Error('未能读取源语言原文，请在 X 页面显示原文后重试');
      }
    } else {
      original = initial.primary[0] || original || initial.extras[0] || "";
      translation = findTranslation(initial, original);
      const showTranslation = control(article, "translation");
      if (includeTranslation && !translation && showTranslation) {
        showTranslation.click();
        translation = await waitForValue(() => {
          const current = getArticle();
          return findTranslation(readState(current), original) || genericTextNodes(current).map(text)
            .find(value => value !== original && !beforeGeneric.has(value)) || "";
        }, timeoutMs, settleMs);
        if (!translation) throw new Error("X 的译文尚未生成，请展开“显示翻译”后重试");
      }
    }
    return { original, translation: includeTranslation ? translation : '' };
  }

  const api = { owns, text, control, readState, postUrl, captureTexts };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.XCopyExtractor = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
