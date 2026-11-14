const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const media = require('../media.js');
const extractor = require('../extractor.js');

test('original photos use orig only, preserve native format and reject unrelated URLs', () => {
  assert.equal(media.originalImageUrl('https://pbs.twimg.com/media/ABC.png:small'), 'https://pbs.twimg.com/media/ABC?format=png&name=orig');
  assert.equal(media.originalImageUrl('https://pbs.twimg.com/media/ABC?format=jpg&name=4096x4096'), 'https://pbs.twimg.com/media/ABC?format=jpg&name=orig');
  for (const url of ['https://evil.test/media/X', 'https://pbs.twimg.com/profile_images/X.jpg', 'http://pbs.twimg.com/media/X.jpg']) assert.equal(media.originalImageUrl(url), '');
});

test('GraphQL records bind variants to their own tweet, including quoted tweets', () => {
  const mp4 = bitrate => ({ content_type: 'video/mp4', bitrate, url: `https://video.twimg.com/ext_tw_video/11/pu/vid/avc1/${bitrate}.mp4?tag=1` });
  const data = { data: { result: { rest_id: '123', legacy: { extended_entities: { media: [{ id_str: '11', type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/11/pu/img/a.jpg', video_info: { variants: [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/a.m3u8' }, mp4(256000), mp4(832000)] } }] } }, quoted_status_result: { result: { rest_id: '456', legacy: { extended_entities: { media: [{ id_str: '22', type: 'photo', media_url_https: 'https://pbs.twimg.com/media/PHOTO.jpg' }] } } } } } } };
  const records = media.collectRecords(data);
  assert.equal(records.length, 2);
  assert.equal(records[0].postId, '123');
  assert.match(records[0].media[0].url, /832000\.mp4/);
  assert.equal(records[1].postId, '456');
  assert.equal(records[1].media[0].type, 'photo');
});

test('GIF classification uses media type and never video loop or mute attributes', () => {
  assert.equal(media.normalizeMedia({ type: 'animated_gif', video_info: { variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/tweet_video/A.mp4' }] } }).type, 'animated_gif');
  assert.equal(media.normalizeMedia({ type: 'video', video_info: { variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/12/a.mp4' }] } }).type, 'video');
  assert.equal(media.validVideoUrl('https://evil.test/a.mp4'), '');
  assert.equal(media.validVideoUrl('https://video.twimg.com/a.m3u8'), '');
});

test('DOM excludes quotes, emoji, avatars and video covers, and infers tweet_video GIF', () => {
  const dom = new JSDOM('<article><img src="https://pbs.twimg.com/media/OWN?format=png&name=small"><div data-testid="quoteTweet"><img src="https://pbs.twimg.com/media/QUOTE.jpg"></div><img src="https://pbs.twimg.com/profile_images/a.jpg"><video muted loop poster="https://pbs.twimg.com/ext_tw_video_thumb/11/pu/img/a.jpg"></video><video poster="https://pbs.twimg.com/tweet_video_thumb/GIFKEY.jpg"></video></article>');
  const article = dom.window.document.querySelector('article');
  const own = (root, node) => !node.closest('[data-testid="quoteTweet"]');
  const result = media.collectDom(article, own);
  assert.equal(result.filter(item => item.type === 'photo').length, 1);
  assert.equal(result.find(item => item.type === 'animated_gif').url, 'https://video.twimg.com/tweet_video/GIFKEY.mp4');
  assert.equal(result.find(item => item.type === 'video').url, '');
  dom.window.close();
});

test('DOM ownership of a real quote card drops the quoted video without a status anchor', () => {
  const dom = new JSDOM(`<article data-testid="tweet">
    <div data-testid="User-Name"><span>Clara</span><span>@Clara1587151</span></div>
    <div data-testid="tweetText" lang="hi">घर पर चूहा</div>
    <video src="https://video.twimg.com/amplify_video/111/vid/avc1/606x764/own.mp4"></video>
    <div role="link" tabindex="0">
      <div data-testid="User-Name"><span>Harum</span><span>@arr4m</span></div>
      <video src="https://video.twimg.com/amplify_video/222/vid/avc1/1080x1920/quoted.mp4"></video>
    </div>
    <a href="/Clara1587151/status/2120411821920383303"><time>now</time></a>
  </article>`);
  const article = dom.window.document.querySelector('article');
  const result = media.collectDom(article, extractor.owns);
  assert.deepEqual(result.filter(item => item.type === 'video').map(item => item.url),
    ['https://video.twimg.com/amplify_video/111/vid/avc1/606x764/own.mp4']);
  assert.equal(extractor.postUrl(article), 'https://x.com/Clara1587151/status/2120411821920383303');
  dom.window.close();
});

test('Cat Catch matches exact media identity and never the last video in the tab', () => {
  const evidence = [{ type: 'video', id: '11', poster: 'https://pbs.twimg.com/ext_tw_video_thumb/11/pu/img/a.jpg', url: '' }];
  const captured = [{ url: 'https://video.twimg.com/ext_tw_video/99/pu/vid/a.mp4' }, { url: 'https://video.twimg.com/ext_tw_video/11/pu/vid/640x480/a.mp4' }];
  const result = media.matchCaptured(evidence, captured);
  assert.equal(result.length, 1);
  assert.match(result[0].url, /\/11\//);
  assert.equal(media.matchCaptured([{ type: 'video', url: '', poster: '' }], captured).length, 0);
});

test('a twenty-photo post keeps every attachment instead of stopping at sixteen', () => {
  const photos = Array.from({ length: 20 }, (unused, index) => ({
    id_str: String(1000 + index), type: 'photo',
    media_url_https: `https://pbs.twimg.com/media/TWENTY${index}.jpg`
  }));
  const records = media.collectRecords({ data: { result: { rest_id: '2121344852608884839', legacy: { extended_entities: { media: photos } } } } });
  assert.equal(records.length, 1);
  assert.equal(records[0].media.length, 20);
  assert.deepEqual(records[0].media.map(item => item.url),
    photos.map(photo => media.originalImageUrl(photo.media_url_https)));
});

test('invalid metadata and false MIME cannot turn external links into downloads', () => {
  assert.equal(media.normalizeMedia({ type: 'video', video_info: { variants: [{ content_type: 'video/mp4', url: 'https://evil.test/a.mp4' }] } }).url, '');
  assert.deepEqual(media.collectRecords({ nonsense: true }), []);
});
