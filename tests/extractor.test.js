const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const extractor = require("../extractor.js");

function fixture(html) {
  const dom = new JSDOM(`<article>${html}</article>`, { url: "https://x.com/author/status/123?s=20" });
  return { dom, article: dom.window.document.querySelector("article"), document: dom.window.document };
}
const fast = { timeoutMs: 600, settleMs: 0 };

test('structural hashtag links remove the entire marked label including punctuation', () => {
  const { dom, article } = fixture('<div data-testid="tweetText">正文 <a href="/hashtag/foo">#foo+bar!</a> 继续 <a href="https://example.com/a#section">链接</a></div>');
  assert.equal(extractor.readState(article).primary[0], '正文  继续 链接');
  dom.window.close();
});
test('removing structured tags also removes their otherwise-empty wrapping brackets', () => {
  const { dom, article } = fixture('<div data-testid="tweetText">正文（<a href="/hashtag/art">#art</a>）\n【<a href="/hashtag/cat">#猫</a>】</div>');
  assert.equal(extractor.readState(article).primary[0], '正文');
  dom.window.close();
});

test("keeps original and translation when both are tweetText blocks", async () => {
  const { dom, article } = fixture('<div data-testid="tweetText">Original</div><div data-testid="tweetText">独立译文</div><span>显示原文</span>');
  assert.deepEqual(await extractor.captureTexts(article, fast), { original: "Original", translation: "独立译文" });
  dom.window.close();
});

test("clicks a plain span 显示翻译 and waits for an independent lang text block", async () => {
  const { dom, article, document } = fixture('<div data-testid="tweetText">Original<br>second line<img alt="🐱"></div><div><span id="toggle">显示翻译</span></div>');
  document.getElementById("toggle").onclick = () => {
    setTimeout(() => {
      const translated = document.createElement("div");
      translated.lang = "zh";
      translated.dir = "auto";
      translated.textContent = "中文译文";
      article.append(translated);
    }, 40);
  };
  assert.deepEqual(await extractor.captureTexts(article, fast), { original: "Original\nsecond line🐱", translation: "中文译文" });
  dom.window.close();
});

test("reads an already expanded translation without another click", async () => {
  const { dom, article } = fixture('<div data-testid="tweetText" lang="en">Original</div><span>由 Grok 翻译</span><div lang="zh">已经生成的译文</div>');
  assert.deepEqual(await extractor.captureTexts(article, fast), { original: "Original", translation: "已经生成的译文" });
  dom.window.close();
});

test("captures a newly generated dir=auto translation without lang or testid", async () => {
  const { dom, article, document } = fixture('<div data-testid="tweetText">Original</div><span id="toggle">显示翻译</span>');
  document.getElementById("toggle").onclick = () => {
    const block = document.createElement("div");
    block.dir = "auto"; block.textContent = "不带语言属性的译文"; article.append(block);
  };
  assert.deepEqual(await extractor.captureTexts(article, fast), { original: "Original", translation: "不带语言属性的译文" });
  dom.window.close();
});

test("uses Grok attribution to recognize an already visible untagged translation", async () => {
  const { dom, article } = fixture('<div><div data-testid="tweetText">Original</div><span>由 Grok 翻译</span><div dir="auto">已显示的不带语言属性的译文</div></div>');
  assert.deepEqual(await extractor.captureTexts(article, fast), { original: "Original", translation: "已显示的不带语言属性的译文" });
  dom.window.close();
});

test("handles translation replacing original text", async () => {
  const { dom, article, document } = fixture('<div data-testid="tweetText">Original</div><button id="toggle">显示翻译</button>');
  document.getElementById("toggle").onclick = function () {
    document.querySelector('[data-testid="tweetText"]').textContent = "替换后的译文";
    this.textContent = "显示原文";
  };
  assert.deepEqual(await extractor.captureTexts(article, fast), { original: "Original", translation: "替换后的译文" });
  dom.window.close();
});

test("recovers original when translation was displayed before extension loaded", async () => {
  const { dom, article, document } = fixture('<div data-testid="tweetText">已有译文</div><button id="toggle">显示原文</button>');
  document.getElementById("toggle").onclick = function () {
    const translated = this.textContent === "显示原文";
    document.querySelector('[data-testid="tweetText"]').textContent = translated ? "Actual original" : "已有译文";
    this.textContent = translated ? "显示翻译" : "显示原文";
  };
  assert.deepEqual(await extractor.captureTexts(article, fast), { original: "Actual original", translation: "已有译文" });
  dom.window.close();
});

test("ignores quote text and quote status links in the same article", async () => {
  const { dom, article } = fixture(`
    <div data-testid="tweetText">Main post</div><div lang="zh">主帖译文</div>
    <div role="link" tabindex="0"><a href="https://x.com/quoted/status/456"><time>quote</time></a><div data-testid="tweetText">Quote</div><div lang="zh">引用译文</div><img src="https://pbs.twimg.com/media/Quote?format=jpg&name=small"></div>
    <a href="https://x.com/author/status/123?s=20"><time>main</time></a>
    <img src="https://pbs.twimg.com/media/A?format=jpg&name=small"><img src="https://pbs.twimg.com/media/B?format=png&name=large">
  `);
  assert.deepEqual(await extractor.captureTexts(article, fast), { original: "Main post", translation: "主帖译文" });
  assert.equal(extractor.postUrl(article), "https://x.com/author/status/123");
  dom.window.close();
});

test("reads a translation container without lang attributes and skips its attribution", async () => {
  const { dom, article } = fixture('<div data-testid="tweetText">Original</div><div data-testid="translation"><span>Translated by Grok</span><div dir="auto">Translation without lang</div></div>');
  assert.deepEqual(await extractor.captureTexts(article, fast), { original: "Original", translation: "Translation without lang" });
  dom.window.close();
});

test("translation timeout fails visibly rather than silently copying source only", async () => {
  const { dom, article } = fixture('<div data-testid="tweetText">Original</div><span>显示翻译</span>');
  await assert.rejects(extractor.captureTexts(article, { timeoutMs: 120, settleMs: 0 }), /译文尚未生成/);
  dom.window.close();
});

test('original-only capture never requests translation', async () => {
  const { dom, article, document } = fixture('<div data-testid="tweetText">Original</div><button id="translate">显示翻译</button>');
  let clicks = 0; document.querySelector('#translate').onclick = () => clicks++;
  assert.deepEqual(await extractor.captureTexts(article, { ...fast, includeTranslation: false }), { original: 'Original', translation: '' });
  assert.equal(clicks, 0); dom.window.close();
});

test('original-only capture recovers source from replaced translation and restores display', async () => {
  const { dom, article, document } = fixture('<div data-testid="tweetText">已有译文</div><button id="toggle">显示原文</button>');
  document.querySelector('#toggle').onclick = function () {
    const translated = this.textContent === '显示原文';
    document.querySelector('[data-testid="tweetText"]').textContent = translated ? 'Actual source' : '已有译文';
    this.textContent = translated ? '显示翻译' : '显示原文';
  };
  assert.deepEqual(await extractor.captureTexts(article, { ...fast, includeTranslation: false }), { original: 'Actual source', translation: '' });
  assert.equal(document.querySelector('[data-testid="tweetText"]').textContent, '已有译文');
  dom.window.close();
});

test('original-only capture fails if X cannot reveal the real source', async () => {
  const { dom, article } = fixture('<div data-testid="tweetText">Only translation</div><button>显示原文</button>');
  try {
    await assert.rejects(extractor.captureTexts(article, { timeoutMs: 120, settleMs: 0, includeTranslation: false }), /未能读取源语言原文/);
  } finally { dom.window.close(); }
});
