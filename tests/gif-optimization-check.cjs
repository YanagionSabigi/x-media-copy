// Local research harness. Never uploads the supplied media.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'test-results', 'gif-optimize-2114222672704147600');
const input = path.join(directory, 'input.mp4');
const sample = "fps=10,scale=w='min(800,iw)':h=-1:flags=lanczos";
const cases = [
  { name: 'baseline', palette: 'stats_mode=full', use: 'dither=sierra2_4a' },
  { name: 'rectangle', palette: 'stats_mode=full', use: 'dither=sierra2_4a:diff_mode=rectangle' },
  { name: 'bayer2', palette: 'stats_mode=full', use: 'dither=bayer:bayer_scale=2:diff_mode=rectangle' },
  { name: 'bayer3', palette: 'stats_mode=full', use: 'dither=bayer:bayer_scale=3:diff_mode=rectangle' },
  { name: 'bayer4', palette: 'stats_mode=full', use: 'dither=bayer:bayer_scale=4:diff_mode=rectangle' },
  { name: 'none', palette: 'stats_mode=full', use: 'dither=none:diff_mode=rectangle' },
  { name: 'diff-bayer3', palette: 'stats_mode=diff', use: 'dither=bayer:bayer_scale=3:diff_mode=rectangle' },
  { name: '128-bayer3', palette: 'stats_mode=full:max_colors=128', use: 'dither=bayer:bayer_scale=3:diff_mode=rectangle' }
];
async function command(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let output = '', error = '';
    child.stdout.on('data', data => output += data);
    child.stderr.on('data', data => error += data);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ output, error }) : reject(new Error(executable + ' failed: ' + error.slice(-4000))));
  });
}
(async () => {
  const results = [];
  for (const item of cases) {
    const palette = path.join(directory, item.name + '-palette.png');
    const output = path.join(directory, item.name + '.gif');
    const started = performance.now();
    await command('ffmpeg', ['-v','error','-y','-threads','2','-i',input,'-vf',sample + ',palettegen=' + item.palette,'-frames:v','1','-update','1',palette]);
    await command('ffmpeg', ['-v','error','-y','-threads','2','-i',input,'-i',palette,'-lavfi','[0:v:0]' + sample + '[sampled];[sampled][1:v:0]paletteuse=' + item.use,'-an','-fps_mode','passthrough','-loop','0',output]);
    const probe = JSON.parse((await command('ffprobe', ['-v','error','-min_delay','0','-count_frames','-select_streams','v:0','-show_entries','stream=width,height,duration,nb_frames,nb_read_frames','-of','json',output])).output).streams[0];
    const metric = await command('ffmpeg', ['-v','info','-threads','2','-i',input,'-min_delay','0','-i',output,'-lavfi','[0:v:0]' + sample + ',format=rgb24,setpts=PTS-STARTPTS[ref];[1:v:0]format=rgb24,setpts=PTS-STARTPTS[out];[ref][out]ssim','-an','-f','null','-']);
    const result = { ...item, bytes: (await fs.stat(output)).size, mib: (await fs.stat(output)).size / 1024 ** 2, seconds: (performance.now() - started) / 1000, ...probe, ssim: Number(metric.error.match(/All:([0-9.]+)/)?.[1]) };
    if (Number(result.nb_read_frames) !== 156 || Math.abs(Number(result.duration) - 15.6) > 0.03 || result.width !== 608 || result.height !== 640) throw new Error('Frame/duration/size mismatch: ' + JSON.stringify(result));
    results.push(result);
    console.log(JSON.stringify(result));
    await fs.writeFile(path.join(directory, 'native-results.json'), JSON.stringify(results, null, 2));
    await command('ffmpeg', ['-v','error','-y','-min_delay','0','-ss','5','-i',output,'-frames:v','1',path.join(directory,item.name + '-frame.png')]);
  }
  await command('ffmpeg', ['-v','error','-y','-ss','5','-i',input,'-frames:v','1',path.join(directory,'source-frame.png')]);
})().catch(error => { console.error(error); process.exitCode = 1; });
