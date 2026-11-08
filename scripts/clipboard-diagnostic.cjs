// Local, manual QQ clipboard comparison. Never sends messages or uploads media.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const sample = path.resolve(process.argv[2] || path.join(root, 'test-results/issue-2119234009901543927'));
const port = Number(process.argv[3] || 8769);
const files = new Map([
  ['/', [path.join(__dirname, 'clipboard-diagnostic.html'), 'text/html; charset=utf-8']],
  ['/core.js', [path.join(root, 'core.js'), 'text/javascript; charset=utf-8']],
  ['/clipboard.js', [path.join(root, 'clipboard.js'), 'text/javascript; charset=utf-8']],
  ['/merged.png', [path.join(sample, 'merged.png'), 'image/png']],
  ...[1,2,3,4].map(n => ['/'+n+'.jpg', [path.join(sample, n+'.jpg'), 'image/jpeg']])
]);
http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.method === 'GET' && req.url === '/sample-location.json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({fileUrl:pathToFileURL(path.join(sample,'merged.png')).href}));
      return;
    }
    const file = files.get(req.url);
    if (req.method !== 'GET' || !file) { res.writeHead(404); res.end(); return; }
    const data = await fs.readFile(file[0]);
    res.setHeader('Content-Type', file[1]); res.end(data);
  } catch { res.writeHead(500); res.end('Local test asset unavailable'); }
}).listen(port, '127.0.0.1', () => console.log(`QQ clipboard comparison: http://127.0.0.1:${port}/`));
