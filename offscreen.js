import { FFmpeg } from './vendor/ffmpeg/index.js';
const media = globalThis.XCopyMedia, gif = globalThis.XCopyGif;
const blobs = new Map();
let active = null;
function notify(jobId, stage) {
  chrome.runtime.sendMessage({ type: 'conversionHeartbeat', jobId, stage }).catch(() => {});
}
function release(jobId) {
  const value = blobs.get(jobId);
  if (value) { URL.revokeObjectURL(value.url); clearTimeout(value.timer); blobs.delete(jobId); }
}
async function downloadInput(url, signal) {
  if (!media.validVideoUrl(url)) throw new Error('动图 MP4 地址无效');
  const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok || (response.url && !media.validVideoUrl(response.url))) throw new Error(`读取动图原视频失败（HTTP ${response.status}）`);
  if (Number(response.headers.get('content-length')) > gif.limits.input) throw new Error('动图原视频超过 32 MiB');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > gif.limits.input) { await reader.cancel(); throw new Error('动图原视频超过 32 MiB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function probe(ffmpeg, filename, output) {
  const code = await ffmpeg.ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,duration,nb_frames:format=duration', '-of', 'json', '-o', output, filename], 20000);
  let result;
  try { result = await ffmpeg.readFile(output, 'utf8'); }
  catch { throw new Error(`无法读取视频信息（FFprobe 返回 ${code}，没有输出文件）`); }
  return gif.parseProbeOutput(code, result);
}
export async function convertGif({ jobId, url, testBytes }) {
  if (active) throw new Error('已有 GIF 正在转换，请稍候');
  const ffmpeg = new FFmpeg(), controller = new AbortController();
  const logs = [];
  ffmpeg.on('log', ({ message }) => { logs.push(message); if (logs.length > 14) logs.shift(); });
  let stage = '读取动图原视频', timedOut = false;
  active = { jobId, ffmpeg, controller };
  const heartbeat = setInterval(() => notify(jobId, stage), 15000);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); ffmpeg.terminate(); }, gif.limits.timeout);
  try {
    notify(jobId, stage);
    // testBytes is used by the isolated extension QA page; runtime callers cannot supply it.
    const bytes = testBytes || await downloadInput(url, controller.signal);
    if (bytes.length > gif.limits.input) throw new Error('动图原视频超过 32 MiB');
    const size = bytes.length;
    stage = '加载随扩展打包的 GIF 编码器'; notify(jobId, stage);
    await ffmpeg.load({ classWorkerURL: chrome.runtime.getURL('vendor/ffmpeg/worker.js'), coreURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.js'), wasmURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm') });
    await ffmpeg.writeFile('input.mp4', bytes);
    const info = gif.parseProbe(await probe(ffmpeg, 'input.mp4', 'input.json'), size);
    stage = '分析完整动图的颜色'; notify(jobId, stage);
    const paletteCode = await ffmpeg.exec(gif.paletteArguments('input.mp4'), gif.limits.timeout);
    if (paletteCode !== 0) throw new Error('GIF 调色板生成失败');
    stage = '按原尺寸转换 GIF'; notify(jobId, stage);
    const code = await ffmpeg.exec(gif.argumentsFor('input.mp4', 'output.gif'), gif.limits.timeout);
    if (code !== 0) throw new Error('GIF 转换失败或超过处理时间');
    const output = await ffmpeg.readFile('output.gif');
    if (output.length >= gif.limits.output || output[output.length - 1] !== 0x3b) throw new Error('GIF 超过 128 MiB 或输出不完整，请下载原始 MP4');
    const resultInfo = await probe(ffmpeg, 'output.gif', 'output.json');
    const duration = Number(resultInfo.streams?.[0]?.duration || resultInfo.format?.duration);
    if (!Number.isFinite(duration) || Math.abs(duration - info.duration) > Math.max(0.2, 2 / info.fps)) throw new Error('GIF 时长校验未通过，请下载原始 MP4');
    const blobUrl = URL.createObjectURL(new Blob([output], { type: 'image/gif' }));
    release(jobId);
    const expires = setTimeout(() => release(jobId), 30 * 60 * 1000);
    blobs.set(jobId, { url: blobUrl, timer: expires });
    return { ok: true, url: blobUrl, size: output.length, width: info.width, height: info.height, duration, frames: Number(resultInfo.streams?.[0]?.nb_frames) || 0 };
  } catch (error) {
    if (timedOut) throw new Error('GIF 转换超过 180 秒，请下载原始 MP4');
    if (controller.signal.aborted) throw new Error('GIF 转换已取消');
    throw new Error(`${error?.message || String(error)}${logs.length ? `（${logs.slice(-4).join(' ').slice(-500)}）` : ''}`);
  } finally {
    clearTimeout(timer); clearInterval(heartbeat); ffmpeg.terminate(); active = null;
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'offscreen') return false;
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background.js') && sender.url !== undefined) {
    respond({ ok: false, error: '转换请求来源无效' }); return false;
  }
  if (message.type === 'convertGif') {
    convertGif({ jobId: message.jobId, url: message.url }).then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'releaseBlob') { release(message.jobId); respond({ ok: true }); return false; }
  if (message.type === 'cancelConversion') {
    if (active?.jobId === message.jobId) { active.controller.abort(); active.ffmpeg.terminate(); }
    release(message.jobId); respond({ ok: true }); return false;
  }
  respond({ ok: false, error: '转换操作无效' }); return false;
});
