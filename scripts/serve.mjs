// Local static server for development. No dependencies.
// Every response says Cache-Control: no-cache, so the browser revalidates each
// module on reload and never mixes freshly edited files with stale cached ones.
// Usage: node scripts/serve.mjs [port]   (default 8000)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2]) || 8000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path.endsWith(sep) || path.endsWith('/')) path = join(path, 'index.html');
    const file = join(root, path);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if ((await stat(file)).isDirectory()) { res.writeHead(302, { location: `${req.url.replace(/\/?$/, '/')}` }).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'cache-control': 'no-cache' }).end('Not found');
  }
}).listen(port, () => console.log(`Mission Evade on http://localhost:${port}`));
