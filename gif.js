(function (root) {
  'use strict';
  // Two streaming passes do not retain every decoded frame in memory.
  // Bound individual frames instead of rejecting cumulative pixel workloads.
  const limits = Object.freeze({ input: 128 * 1024 ** 2, output: 256 * 1024 ** 2, seconds: 60, framePixels: 3840 * 2160, timeout: 600000 });
  function validate({ size, width, height, duration, fps }) {
    if (![size, width, height, duration, fps].every(value => Number.isFinite(value) && value > 0)) throw new Error('无法验证动图的尺寸、时长或帧率');
    if (size > limits.input) throw new Error('动图原视频超过 128 MiB，请下载 MP4 备用文件');
    if (duration > limits.seconds) throw new Error('动图时长超过 60 秒，请下载 MP4 备用文件');
    if (width * height > limits.framePixels) throw new Error('视频单帧面积超过 4K（3840×2160）上限，请下载 MP4 备用文件');
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
  function samplingFilter(gifFps) {
    if (gifFps === 'source') return '';
    if (![10, 15].includes(gifFps)) throw new Error('GIF 帧率模式无效');
    return `fps=${gifFps},scale=w='min(800,iw)':h=-1:flags=lanczos,`;
  }
  function argumentsFor(input, output, gifFps = 'source') {
    const sampling = samplingFilter(gifFps);
    // Stable ordered dithering reduces frame-to-frame noise and GIF size.
    // Keep the original 256-color palette budget and source/legacy behavior.
    const use = gifFps === 10 ? 'paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle' : 'paletteuse=dither=sierra2_4a';
    const graph = sampling ? '[0:v:0]' + sampling.slice(0, -1) + '[sampled];[sampled][1:v:0]' + use : '[0:v:0][1:v:0]' + use;
    const frameOptions = gifFps === 10 ? ['-gifflags', '+offsetting+transdiff'] : [];
    return ['-i', input, '-i', 'palette.png', '-lavfi', graph, '-an', '-fps_mode', 'passthrough', ...frameOptions, '-loop', '0', '-fs', String(limits.output), output];
  }
  function paletteArguments(input, gifFps = 'source') { return ['-i', input, '-vf', samplingFilter(gifFps) + 'palettegen=stats_mode=full', '-frames:v', '1', '-update', '1', 'palette.png']; }
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
