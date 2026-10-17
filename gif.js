(function (root) {
  'use strict';
  const limits = Object.freeze({ input: 32 * 1024 ** 2, output: 128 * 1024 ** 2, seconds: 60, pixels: 300000000, timeout: 180000 });
  function validate({ size, width, height, duration, fps }) {
    if (![size, width, height, duration, fps].every(value => Number.isFinite(value) && value > 0)) throw new Error('无法验证动图的尺寸、时长或帧率');
    if (size > limits.input) throw new Error('动图原视频超过 32 MiB，请下载 MP4 备用文件');
    if (duration > limits.seconds) throw new Error('动图时长超过 60 秒，请下载 MP4 备用文件');
    if (width * height * Math.ceil(duration * fps) > limits.pixels) throw new Error('动图解码量超过安全上限，请下载 MP4 备用文件');
  }
  function parseProbe(probe, size) {
    const stream = probe.streams?.[0];
    if (!stream) throw new Error('媒体没有可解码的视频流');
    const parts = String(stream.avg_frame_rate || stream.r_frame_rate || '').split('/').map(Number);
    const fps = parts.length === 2 ? parts[0] / parts[1] : parts[0];
    const result = { size, width: Number(stream.width), height: Number(stream.height), fps, duration: Number(stream.duration || probe.format?.duration) };
    validate(result);
    return result;
  }
  function argumentsFor(input, output) {
    return ['-i', input, '-i', 'palette.png', '-lavfi', 'paletteuse=dither=sierra2_4a', '-an', '-fps_mode', 'passthrough', '-loop', '0', '-fs', String(limits.output), output];
  }
  function paletteArguments(input) { return ['-i', input, '-vf', 'palettegen=stats_mode=full', '-frames:v', '1', '-update', '1', 'palette.png']; }
  function parseProbeOutput(code, text) {
    // @ffmpeg/core 0.12.10 can leave Module.ret at -1 after successful ffprobe.
    if (code !== 0 && code !== -1) throw new Error(`视频信息读取失败（${code}）`);
    const result = JSON.parse(text);
    if (!Array.isArray(result.streams) || !result.streams.length) throw new Error('媒体没有可解码的视频流');
    return result;
  }
  const api = { limits, validate, parseProbe, argumentsFor, paletteArguments, parseProbeOutput };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XCopyGif = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
