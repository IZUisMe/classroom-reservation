import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_LIMITS, AdminError, addAdminPhoto, recoverAdminPhotoTransaction, updatePhotoGallery, updateRoomContent } from './apply_admin_photos.mjs';
import { GalleryError, applyGalleryEdits, emptyPhotoEdits, galleryRoomState, photoFilePath } from './photo_gallery_edits.mjs';
import { createPublishController } from './admin_publish.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
const STATIC = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']], ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
const safeEqual = (value, expected) => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
function json(res, status, value) { const bytes = Buffer.from(JSON.stringify(value)); res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length }); res.end(bytes); }
async function body(req) {
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > ADMIN_LIMITS.maxBodyBytes)) { req.resume(); throw new AdminError('送信データが大きすぎます（画像は1枚ずつ・4MB以内）。', 413); }
  const raw = await new Promise((accept, reject) => {
    const parts = []; let size = 0; let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > ADMIN_LIMITS.maxBodyBytes) { rejected = true; parts.length = 0; reject(new AdminError('送信データが大きすぎます。', 413)); return; }
      parts.push(chunk);
    });
    req.once('end', () => { if (!rejected) accept(Buffer.concat(parts)); });
    req.once('aborted', () => reject(new AdminError('送信が中断されました。')));
    req.once('error', reject);
  });
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new AdminError('JSONの形式が正しくありません。'); }
}

/** Testable factory. Production CLI always listens on 127.0.0.1:4174 only. */
export async function createAdminServer({ projectRoot = resolve(HERE, '..'), port = 4174, commitHooks, isPublishing = () => false, publishController } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port');
  const root = resolve(projectRoot);
  const publisher = publishController || createPublishController(root);
  const nonce = randomBytes(32).toString('hex');
  await recoverAdminPhotoTransaction(root);
  let queue = Promise.resolve();
  const enqueue = operation => { const pending = queue.then(operation); queue = pending.catch(() => {}); return pending; };
  const assertNotPublishing = () => { if (publisher.isRunning() || isPublishing()) throw new AdminError('公開処理中です。完了してから写真を更新してください。', 409); };
  const assertWriteRequest = (req, actualPort) => {
    if (!new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]).has(req.headers.origin) || !safeEqual(req.headers['x-csrf-token'], nonce)) throw new AdminError('画面を再読み込みしてから追加してください。', 403);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw new AdminError('application/jsonで送信してください。', 415);
  };
  function snapshot() {
    return enqueue(async () => {
      try { await readFile(resolve(root, 'tools/admin/.state/transaction.json')); throw new AdminError('データの回復が必要です。管理用サーバーを再起動してください。', 500); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const [rooms, sources, edits] = await Promise.all(['rooms.json', 'photo-sources.json', 'photo-edits.json'].map(async name => {
        try { return JSON.parse(await readFile(resolve(root, 'public/data', name), 'utf8')); }
        catch (error) { if (name === 'photo-edits.json' && error.code === 'ENOENT') return emptyPhotoEdits(); throw error; }
      }));
      return applyGalleryEdits({ rooms, sources, edits });
    });
  }
  const server = http.createServer(async (req, res) => {
    try {
      const actualPort = server.address()?.port;
      const hosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      if (!hosts.has(req.headers.host)) throw new AdminError('この管理画面は管理者PCからのみ利用できます。', 403);
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw new AdminError('ローカル接続だけが許可されています。', 403);
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      if (url.search || url.hash) throw new AdminError('指定されたURLは利用できません。', 404);
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        const state = await snapshot();
        return json(res, 200, { appId: 'classroom-photo-admin', version: 3, rooms: state.rooms.map(room => galleryRoomState(room, state.sources, state.edits)), csrfToken: nonce, limits: { inputBytes: 20 * 1024 * 1024, inputPixels: 40_000_000, inputDimension: 16384, ...ADMIN_LIMITS } });
      }
      if (req.method === 'GET' && url.pathname === '/api/publish') {
        return json(res, 200, { ok: true, job: publisher.getStatus() });
      }
      if (req.method === 'POST' && url.pathname === '/api/publish') {
        assertWriteRequest(req, actualPort);
        assertNotPublishing();
        const payload = await body(req);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) throw new AdminError('公開処理に追加の引数は指定できません。');
        const job = await enqueue(async () => {
          assertNotPublishing();
          try { await readFile(resolve(root, 'tools/admin/.state/transaction.json')); throw new AdminError('データの回復が必要です。管理用サーバーを再起動してください。', 500); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          return publisher.start();
        });
        return json(res, 202, { ok: true, job });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/photos/')) {
        let id;
        try { id = decodeURIComponent(url.pathname.slice('/photos/'.length)); } catch { throw new AdminError('写真が見つかりません。', 404); }
        const state = await snapshot();
        const record = state.sources.photos.find(photo => photo.id === id);
        const file = photoFilePath(root, record);
        let bytes;
        try { bytes = await readFile(file); } catch (error) { if (error.code === 'ENOENT') throw new AdminError('写真が見つかりません。', 404); throw error; }
        if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new AdminError('写真がWebP形式ではありません。', 500);
        res.writeHead(200, { ...HEADERS, 'Content-Type': 'image/webp', 'Content-Length': bytes.length });
        res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      if (req.method === 'POST' && ['/api/photos', '/api/gallery', '/api/room'].includes(url.pathname)) {
        assertWriteRequest(req, actualPort);
        assertNotPublishing();
        const payload = await body(req);
        const result = await enqueue(() => {
          assertNotPublishing();
          return url.pathname === '/api/photos' ? addAdminPhoto(root, payload, commitHooks) : url.pathname === '/api/room' ? updateRoomContent(root, payload, commitHooks) : updatePhotoGallery(root, payload, commitHooks);
        });
        return json(res, url.pathname === '/api/photos' ? 201 : 200, { ok: true, ...result });
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const item = STATIC.get(url.pathname);
        if (item) {
          const bytes = await readFile(resolve(HERE, 'admin', item[0]));
          res.writeHead(200, { ...HEADERS, 'Content-Type': item[1], 'Content-Length': bytes.length });
          res.end(req.method === 'HEAD' ? undefined : bytes); return;
        }
        throw new AdminError('見つかりません。', 404);
      }
      throw new AdminError('この操作は利用できません。', 405);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (!req.complete) req.resume();
      const known = error instanceof AdminError || error instanceof GalleryError;
      const status = known ? error.status : 500;
      if (status >= 500) console.error('Photo admin:', error.message);
      json(res, status, { ok: false, error: status >= 500 && !known ? '保存に失敗しました。管理画面の起動用ウィンドウを確認してください。' : error.message });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  return {
    server, enqueue,
    async listen() { await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept(); }); }); return server.address(); },
    async close() { server.closeIdleConnections(); await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())); },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = await createAdminServer();
    await app.listen();
    console.log('写真追加 管理画面: http://127.0.0.1:4174\nこのPC専用です。停止: Ctrl+C\n追加後は pnpm build で公開アプリへ反映してください。');
  } catch (error) { console.error(error.code === 'EADDRINUSE' ? '4174番は使用中です。既に起動した管理画面を利用するか、先に停止してください。' : error.message); process.exitCode = 1; }
}
