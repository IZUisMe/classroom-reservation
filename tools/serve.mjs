import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
const root = resolve('dist');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };
const cache = new Map();
await stat(resolve(root, 'index.html')).catch(() => { console.error('Build first: pnpm build'); process.exit(1); });
const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const file = resolve(root, `.${pathname.endsWith('/') ? pathname + 'index.html' : pathname}`);
    if (!file.startsWith(root + sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    const meta = await stat(file);
    if (!meta.isFile()) throw new Error('Not a file');
    const type = types[extname(file)] || 'application/octet-stream';
    const compress = /text|javascript|json|svg|font/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    let bytes;
    const key = `${file}:${compress}`;
    if (cache.has(key) && cache.get(key).modified === meta.mtimeMs) bytes = cache.get(key).bytes;
    else { bytes = await readFile(file); if (compress) bytes = gzipSync(bytes); cache.set(key, { modified: meta.mtimeMs, bytes }); }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "frame-ancestors 'none'", 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Vary': 'Accept-Encoding', ...(compress ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
});
server.listen(port, host, () => console.log(`Classroom app: http://${host}:${port}\nServing only ${root}\nStop: Ctrl+C`));
