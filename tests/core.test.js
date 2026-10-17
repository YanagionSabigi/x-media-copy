const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test("clipboard output contains source text, translation, links and escaped HTML", () => {
  const result = core.buildClipboardPayload({
    original: "Hello <world>",
    translation: "你好 & 世界",
    postUrl: "https://x.com/a/status/123"
  });
  assert.equal(result.plain, "Hello <world>\n\n你好 & 世界\nhttps://x.com/a/status/123");
  assert.doesNotMatch(result.html, /<strong>|X \/ Grok 译文|原文|原帖/);
  assert.match(result.html, /Hello &lt;world&gt;<br><br>你好 &amp; 世界<br><a /);
  assert.match(result.html, /Hello &lt;world&gt;/);
  assert.match(result.html, /你好 &amp; 世界/);
  assert.doesNotMatch(result.html, /<img|data:image/);
});

test("removes all share query parameters, hashes and photo suffixes", () => {
  for (const raw of [
    "https://x.com/author/status/123?=19",
    "https://x.com/author/status/123?=20#share",
    "https://twitter.com/author/status/123?s=20&t=tracking",
    "https://x.com/author/status/123/photo/2?s=19"
  ]) assert.equal(core.canonicalPostUrl(raw), "https://x.com/author/status/123");
  assert.equal(core.canonicalPostUrl("https://x.com/i/web/status/123?s=20"), "https://x.com/i/web/status/123");
  assert.equal(core.canonicalPostUrl("https://x.com/ishikinurunuru/status/2105253266728862199?s=20"), "https://x.com/ishikinurunuru/status/2105253266728862199");
  assert.equal(core.canonicalPostUrl("https://x.com/lets_lam3nt/status/2105027034070339689?=19"), "https://x.com/lets_lam3nt/status/2105027034070339689");
  assert.equal(core.canonicalPostUrl("https://evil.example/author/status/123?s=20"), "");
  const payload = core.buildClipboardPayload({ original: "text", translation: "译文", postUrl: "https://x.com/a/status/123?s=20", images: [] });
  assert.doesNotMatch(payload.plain + payload.html, /\?s=20/);
  assert.match(payload.html, />https:\/\/x.com\/a\/status\/123<\/a>/);
});

test("does not fabricate a translation when it is unavailable", () => {
  const result = core.buildClipboardPayload({ original: "Only source", translation: "", postUrl: "", images: [] });
  assert.equal(result.plain, "Only source");
  assert.doesNotMatch(result.html, /译文/);
});

test("omits missing sections without labels or extra blank lines in either format", () => {
  const payload = core.buildClipboardPayload({ original: "\n Source \n", translation: "  ", postUrl: "https://x.com/a/status/123?=19" });
  assert.equal(payload.plain, "Source\nhttps://x.com/a/status/123");
  assert.equal(payload.html, '<div>Source<br><a href="https://x.com/a/status/123">https://x.com/a/status/123</a></div>');
});

 test("removes Unicode hashtags from both sections, including adjacent tags and tag-only lines", () => {
  const result = core.buildClipboardPayload({
    original: "Hello #art #夏日\nSecond line\n\n#猫#ねこ ＃作品",
    translation: "你好 #艺术 #café #e\u0301\n第二行\n\n#2026 #tag_name",
    postUrl: "https://x.com/a/status/123?s=20"
  });
  assert.equal(result.plain, "Hello\nSecond line\n\n你好\n第二行\nhttps://x.com/a/status/123");
  assert.doesNotMatch(result.html, /#|＃/);
});

test("preserves paragraphs, URL fragments and C# while omitting hashtag-only sections", () => {
  assert.equal(core.stripHashtags("C# tutorial #coding\n\nhttps://example.com/a#section #link"), "C# tutorial\n\nhttps://example.com/a#section");
  const result = core.buildClipboardPayload({ original: "#art #绘画", translation: "#艺术", postUrl: "https://x.com/a/status/123?s=20" });
  assert.equal(result.plain, "https://x.com/a/status/123");
});

test('cleans punctuated hashtags and empty wrappers without consuming sentence punctuation', () => {
  assert.equal(core.stripHashtags('作品 #foo-bar #作品・新作（#限定）'), '作品');
  assert.equal(core.stripHashtags('保留 #tag，正文继续。 C# https://a.test/#part'), '保留 ，正文继续。 C# https://a.test/#part');
  assert.equal(core.stripHashtags('正文\n（#art）【#猫】\n#foo.bar！'), '正文');
});

test('HTML embeds original bytes before the source link without changing plain text', () => {
  const result = core.buildClipboardPayload({ original: 'Source', translation: '译文', postUrl: 'https://x.com/a/status/1', images: [{ dataUrl: 'data:image/png;base64,AAAA', width: 2048, height: 1024 }] });
  assert.equal(result.plain, 'Source\n\n译文\nhttps://x.com/a/status/1');
  assert.match(result.html, /译文[\s\S]*<img[^>]+data:image\/png;base64,AAAA[\s\S]*https:\/\/x.com\/a\/status\/1/);
  assert.doesNotMatch(result.html, /width="1600"/);
});

test('compact layout has one blank line only between languages and no breaks between images', () => {
  const images = ['AAAA','BBBB','CCCC'].map(value => ({ dataUrl: `data:image/png;base64,${value}` }));
  const result = core.buildClipboardPayload({ original: 'Source', translation: '中文', postUrl: 'https://x.com/a/status/1?s=20', images });
  assert.equal(result.plain, 'Source\n\n中文\nhttps://x.com/a/status/1');
  assert.match(result.html, /^<div>Source<br><br>中文<br><img/);
  assert.equal((result.html.match(/<img/g)||[]).length, 3);
  assert.match(result.html, /><img[^>]+BBBB[^>]*><img[^>]+CCCC[^>]*><br><a /);
  assert.doesNotMatch(result.html, /<img[^>]*><br>(?:<br>)?<img|中文<br><br>|<br><br><a /);
});
