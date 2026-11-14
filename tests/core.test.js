const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test('merged HTML references the staged local PNG once and retains prose and source', () => {
  const image={dataUrl:'data:image/png;base64,AAAA'};
  const result=core.buildClipboardPayload({original:'Source',translation:'译文',postUrl:'https://x.com/a/status/1',images:[image],mergedImage:image,mergedImageFileUrl:'file:///C:/Downloads/X/clipboard/1.png'});
  assert.equal(result.plain,'Source\n\n译文\nhttps://x.com/a/status/1');
  assert.match(result.html,/src="file:\/\/\/C:\/Downloads\/X\/clipboard\/1.png"/);
  assert.doesNotMatch(result.html,/base64/);assert.match(result.html,/译文.*<img.*https:\/\/x.com\/a\/status\/1/);
  assert.ok(result.html.length<1000);
});

test('local merged clipboard references reject remote hosts and unrelated image bindings', () => {
  const image={dataUrl:'data:image/png;base64,AAAA'};
  for(const mergedImageFileUrl of ['https://evil.test/a.png','file://server/share/a.png','file:///C:/a.html','javascript:alert(1)']){
    assert.throws(()=>core.buildClipboardPayload({images:[image],mergedImage:image,mergedImageFileUrl}),/本地/);
  }
  assert.throws(()=>core.buildClipboardPayload({images:[image],mergedImageFileUrl:'file:///C:/a.png'}),/本地/);
});

test('each original can use its own staged local file when HTML would exceed QQ limits', () => {
  const images = [
    { dataUrl: 'data:image/jpeg;base64,AAAA', fileUrl: 'file:///C:/Downloads/X/clipboard/batch_1.jpg' },
    { dataUrl: 'data:image/png;base64,BBBB', fileUrl: 'file:///C:/Downloads/X/clipboard/batch_2.png' }
  ];
  const result = core.buildClipboardPayload({ original: 'Source', translation: '译文', postUrl: 'https://x.com/a/status/1', images });
  assert.match(result.html, /src="file:\/\/\/C:\/Downloads\/X\/clipboard\/batch_1.jpg"/);
  assert.match(result.html, /src="file:\/\/\/C:\/Downloads\/X\/clipboard\/batch_2.png"/);
  assert.doesNotMatch(result.html, /base64/);
  assert.ok(result.html.length < 1000);
  for (const fileUrl of ['https://evil.test/a.jpg', 'file://server/share/a.jpg', 'file:///C:/a.html', 'file:///C:/a.jpg?x=1', 'javascript:alert(1)']) {
    assert.throws(() => core.buildClipboardPayload({ images: [{ dataUrl: 'data:image/jpeg;base64,AAAA', fileUrl }] }), /本地/);
  }
});

test('profile images can use staged local files without losing the author block order', () => {
  const result = core.buildProfilePayload({
    name: 'rabi', handle: '@rabiadraw', bio: 'Bio', profileUrl: 'https://x.com/rabiadraw',
    images: [{ dataUrl: 'data:image/jpeg;base64,AAAA', fileUrl: 'file:///C:/Downloads/X/clipboard/p_1.jpg' }]
  });
  assert.match(result.html, /src="file:\/\/\/C:\/Downloads\/X\/clipboard\/p_1.jpg"/);
  assert.doesNotMatch(result.html, /base64/);
  assert.ok(result.html.indexOf('@rabiadraw') < result.html.indexOf('<img'));
});

test('GIF clipboard leaves one empty insertion line before the source in both formats', () => {
  const result = core.buildClipboardPayload({ original: 'Source <text> #art', translation: '中文 & 译文 #艺术', postUrl: 'https://x.com/a/status/123?s=20', reserveGifLine: true });
  assert.equal(result.plain, 'Source <text>\n\n中文 & 译文\n\nhttps://x.com/a/status/123');
  assert.equal(result.html, '<div>Source &lt;text&gt;<br><br>中文 &amp; 译文<br><br><a href="https://x.com/a/status/123">https://x.com/a/status/123</a></div>');
});

test('GIF insertion spacing omits absent sections without fabricating translation or trailing lines', () => {
  for (const [input, plain, html] of [
    [{ original: 'Source', postUrl: 'https://x.com/a/status/1' }, 'Source\n\nhttps://x.com/a/status/1', '<div>Source<br><br><a href="https://x.com/a/status/1">https://x.com/a/status/1</a></div>'],
    [{ postUrl: 'https://x.com/a/status/1' }, 'https://x.com/a/status/1', '<div><a href="https://x.com/a/status/1">https://x.com/a/status/1</a></div>'],
    [{ original: 'Source', translation: '译文' }, 'Source\n\n译文', '<div>Source<br><br>译文</div>']
  ]) {
    const result = core.buildClipboardPayload({ ...input, reserveGifLine: true });
    assert.equal(result.plain, plain); assert.equal(result.html, html);
  }
});

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

test('profile payload lists the author block, bio, translation, page link and images', () => {
  const images = ['AAAA', 'BBBB'].map(value => ({ dataUrl: `data:image/jpeg;base64,${value}` }));
  const result = core.buildProfilePayload({
    name: 'rabi 🌸', handle: '@rabiadraw',
    bio: 'I draw whatever I like at the moment. NO A*I.',
    bioTranslation: '我画当下喜欢的任何东西。不用AI。',
    profileUrl: 'https://x.com/rabiadraw?ref=profile', images
  });
  assert.equal(result.plain, 'rabi 🌸\n@rabiadraw\n\nI draw whatever I like at the moment. NO A*I.\n\n我画当下喜欢的任何东西。不用AI。\n\nhttps://x.com/rabiadraw');
  assert.match(result.html, /^<div>rabi 🌸<br>@rabiadraw<br><br>I draw whatever I like at the moment\. NO A\*I\.<br><br>我画当下喜欢的任何东西。不用AI。/);
  assert.match(result.html, /不用AI。<br><br><a href="https:\/\/x\.com\/rabiadraw">/);
  assert.ok(result.html.indexOf('<a href="https://x.com/rabiadraw">') < result.html.indexOf('<img'), 'the profile link precedes the images');
  assert.equal((result.html.match(/<img/g) || []).length, 2);
});

test('profile payload omits a missing translation and skips unsafe images', () => {
  const result = core.buildProfilePayload({
    name: 'rabi', handle: '@rabiadraw', bio: 'Line one\n\nLine two', bioTranslation: '',
    profileUrl: 'https://x.com/rabiadraw', images: [{ dataUrl: 'data:image/svg+xml;base64,AAAA' }, { dataUrl: 'data:image/png;base64,CCCC' }]
  });
  assert.equal(result.plain, 'rabi\n@rabiadraw\n\nLine one\n\nLine two\n\nhttps://x.com/rabiadraw');
  assert.equal((result.html.match(/<img/g) || []).length, 1);
  assert.match(result.html, /Line one<br><br>Line two/);
});

test('profile URLs stay restricted to a plain handle', () => {
  assert.equal(core.canonicalProfileUrl('https://x.com/rabiadraw'), 'https://x.com/rabiadraw');
  assert.equal(core.canonicalProfileUrl('https://twitter.com/rabiadraw/media'), 'https://x.com/rabiadraw');
  for (const raw of ['https://x.com/rabiadraw/status/1', 'https://x.com/i/lists/1', 'https://evil.test/rabiadraw', 'javascript:alert(1)']) {
    assert.equal(core.canonicalProfileUrl(raw), '');
  }
});
