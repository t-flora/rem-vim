// Serve the built plugin (dist/) to RemNote without webpack-dev-server.
//
// RemNote's "Develop from localhost" loads a plugin from any localhost URL,
// so a plain static server is enough once `npm run build` (or
// `npm run watch`) has produced dist/. Listens on loopback only.
//
//   node scripts/serve.mjs            # http://localhost:7171/
//   PORT=7272 node scripts/serve.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PORT ?? 7171);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// The same cross-origin headers webpack-dev-server sends (webpack.config.js),
// plus no-store so a rebuilt dist/ shows up on the next RemNote reload.
const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'baggage, sentry-trace',
  'Cache-Control': 'no-store',
};

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, HEADERS).end();
    return;
  }
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = normalize(join(root, path.endsWith('/') ? `${path}index.html` : path));
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
    res.writeHead(403, HEADERS).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, HEADERS).end('not found — run `npm run build` first?');
  }
}

// "localhost" can resolve to either loopback address; listen on both.
for (const host of ['127.0.0.1', '::1']) {
  createServer(handle)
    .on('error', (e) => console.error(`[rem-vim] ${host}:${port}: ${e.message}`))
    .listen(port, host, () => console.log(`[rem-vim] serving ${root} on http://${host.includes(':') ? `[${host}]` : host}:${port}/`));
}
