import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createAdminServer } from '../tools/admin-server.mjs';
import { applyAdminPhotos, addAdminPhoto, inspectWebP, recoverAdminPhotoTransaction, ADMIN_LIMITS } from '../tools/apply_admin_photos.mjs';

const resultsRoot = resolve('test-results');
await mkdir(resultsRoot, { recursive: true });
const imageBytes = await readFile('public/images/rooms/31a-interior.webp');
const imageSize = inspectWebP(imageBytes);
const payload = (roomId = 'R42', kind = 'interior') => ({ roomId, kind, image: { data: imageBytes.toString('base64'), ...imageSize } });
async function fixture() {
  const root = await mkdtemp(join(resultsRoot, 'admin-fixture-'));
  await mkdir(join(root, 'public/data'), { recursive: true });
  await mkdir(join(root, 'public/images/rooms'), { recursive: true });
  const rooms = Array.from({ length: 42 }, (_, index) => ({ id: `R${String(index + 1).padStart(2, '0')}`, name: `${index + 1}教室`, images: { interior: null, exterior: null }, photoStatus: { interior: 'missing', exterior: 'missing' }, gallery: [] }));
  const photos = Array.from({ length: 164 }, (_, index) => {
    const id = `base-${index}`; const src = `images/rooms/${id}.webp`;
    rooms[0].gallery.push({ src, kind: 'interior', source: index < 16 ? '既存資料' : 'roomlist.pdf', sourceId: id, width: 1, height: 1 });
    return { id, roomId: 'R01', kind: 'interior', status: 'available', sourceType: index < 16 ? 'xlsx' : 'pdf', webp: { src, sha256: 'a'.repeat(64), bytes: 100, width: 1, height: 1 } };
  });
  rooms[0].images.interior = { ...rooms[0].gallery[0] }; rooms[0].photoStatus.interior = 'available';
  photos.push({ id: 'R42-interior', roomId: 'R42', kind: 'interior', status: 'missing', reason: '元資料に写真なし' });
  const sources = { schemaVersion: 2, summary: { roomCount: 42, primaryPhotoSlots: 84, pdfPhotographs: 148, existingPhotosPreserved: 16, galleryPhotoCount: 164, webpCount: 164, webpBytes: 16400 }, photos };
  await writeFile(join(root, 'public/data/rooms.json'), JSON.stringify(rooms));
  await writeFile(join(root, 'public/data/photo-sources.json'), JSON.stringify(sources));
  return { root, rooms, sources, async cleanup() { assert.ok(root.startsWith(resultsRoot + '/admin-fixture-') || root.startsWith(resultsRoot + '\\admin-fixture-')); await rm(root, { recursive: true, force: true }); } };
}
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const missing = async path => { try { await access(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };

function adminRecord(roomId = 'R42') {
  const id = `admin-${randomUUID()}`;
  return { id, roomId, src: `images/rooms/${id}.webp`, kind: 'interior', source: '管理者追加', ...imageSize, sha256: createHash('sha256').update(imageBytes).digest('hex'), bytes: imageBytes.length, addedAt: '2026-11-05T08:00:00.000Z' };
}

test('admin merge is idempotent, preserves original missing evidence and PDF/xlsx counts', async () => {
  const data = await fixture();
  try {
    const photo = adminRecord();
    const first = applyAdminPhotos({ rooms: data.rooms, sources: data.sources, manifest: { schemaVersion: 1, photos: [photo] } });
    const second = applyAdminPhotos(first);
    assert.deepEqual(second, first);
    assert.equal(first.rooms[41].images.interior.sourceId, photo.id);
    assert.equal(first.rooms[41].gallery.length, 1);
    assert.equal(first.sources.photos.find(item => item.id === 'R42-interior').status, 'missing');
    assert.equal(first.sources.photos.filter(item => item.sourceType === 'admin').length, 1);
    assert.equal(first.sources.summary.galleryPhotoCount, 165);
    assert.equal(first.sources.summary.webpCount, 165);
    assert.equal(first.sources.summary.adminPhotographs, 1);
    assert.equal(first.sources.summary.primaryPhotoSlots, 84);
    assert.equal(first.sources.summary.pdfPhotographs, 148);
    assert.equal(first.sources.summary.existingPhotosPreserved, 16);
    assert.equal(first.sources.summary.roomCount, 42);
    assert.ok(!first.sources.summary.interiorMissing.includes('R42'));
    assert.throws(() => applyAdminPhotos({ ...data, manifest: { schemaVersion: 1, photos: [{ ...photo, roomId: 'R43' }] } }));
  } finally { await data.cleanup(); }
});

test('WebP validation rejects wrong magic, forged dimensions, metadata, animation and excessive pixels', () => {
  assert.ok(imageSize.width > 0);
  assert.throws(() => inspectWebP(Buffer.from('not an image')));
  const size = Buffer.from(imageBytes); size.writeUInt32LE(1, 4); assert.throws(() => inspectWebP(size));
  const large = Buffer.from(imageBytes);
  const imageOffset = large.indexOf(Buffer.from('VP8 '));
  if (imageOffset >= 0) { large.writeUInt16LE(16383, imageOffset + 8 + 6); assert.throws(() => inspectWebP(large)); }
  const exif = Buffer.concat([imageBytes, Buffer.from('EXIF'), Buffer.from([0,0,0,0])]); exif.writeUInt32LE(exif.length - 8, 4); assert.throws(() => inspectWebP(exif));
  const animated = Buffer.concat([imageBytes, Buffer.from('ANIM'), Buffer.from([0,0,0,0])]); animated.writeUInt32LE(animated.length - 8, 4); assert.throws(() => inspectWebP(animated));
  assert.throws(() => inspectWebP(Buffer.alloc(ADMIN_LIMITS.maxFileBytes + 1)));
});

test('transaction rolls back all canonical files and new image on write failure', async () => {
  const data = await fixture();
  try {
    const before = await Promise.all(['rooms.json', 'photo-sources.json'].map(name => readFile(join(data.root, 'public/data', name))));
    await assert.rejects(addAdminPhoto(data.root, payload(), { beforeReplace(index) { if (index === 1) throw new Error('simulated disk failure'); } }), /simulated/);
    for (const [i, name] of ['rooms.json', 'photo-sources.json'].entries()) assert.deepEqual(await readFile(join(data.root, 'public/data', name)), before[i]);
    assert.equal(await missing(join(data.root, 'public/data/admin-photos.json')), true);
    assert.deepEqual(await readdir(join(data.root, 'public/images/rooms')), []);
    assert.equal(await missing(join(data.root, 'tools/admin/.state/transaction.json')), true);
    assert.equal(await missing(join(data.root, 'tools/admin/.state/write.lock')), true);
  } finally { await data.cleanup(); }
});

test('pending journal restores previous data after an interrupted process', async () => {
  const data = await fixture();
  try {
    const before = await Promise.all(['rooms.json', 'photo-sources.json'].map(name => readFile(join(data.root, 'public/data', name))));
    const imageId = `admin-${randomUUID()}`;
    await mkdir(join(data.root, 'tools/admin/.state'), { recursive: true });
    await writeFile(join(data.root, 'public/data/rooms.json'), '[]');
    await writeFile(join(data.root, 'public/images/rooms', `${imageId}.webp`), imageBytes);
    await writeFile(join(data.root, 'tools/admin/.state/transaction.json'), JSON.stringify({ version: 1, imageId, before: [...before.map(value => value.toString('base64')), null] }));
    assert.equal(await recoverAdminPhotoTransaction(data.root), true);
    assert.equal(await recoverAdminPhotoTransaction(data.root), false);
    assert.deepEqual(await readFile(join(data.root, 'public/data/rooms.json')), before[0]);
    assert.equal(await missing(join(data.root, 'public/images/rooms', `${imageId}.webp`)), true);
  } finally { await data.cleanup(); }
});

function rawRequest(port, options, raw = '') {
  return new Promise((accept, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/api/photos', method: 'POST', ...options }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => accept({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() })); });
    request.on('error', reject); request.end(raw);
  });
}
test('loopback API enforces Host/Origin/CSRF/type/body limits and commits UUID-only metadata', async () => {
  const data = await fixture();
  const app = await createAdminServer({ projectRoot: data.root, port: 0 });
  try {
    const address = await app.listen(); const base = `http://127.0.0.1:${address.port}`;
    assert.equal(address.address, '127.0.0.1');
    const shell = await fetch(base); assert.equal(shell.status, 200); assert.ok((await shell.text()).includes('管理者PC専用'));
    assert.ok(shell.headers.get('content-security-policy').includes("connect-src 'self'"));
    assert.equal(shell.headers.get('access-control-allow-origin'), null);
    assert.ok(shell.headers.get('x-robots-tag').includes('noindex'));
    const init = await (await fetch(`${base}/api/bootstrap`)).json(); assert.equal(init.rooms.length, 42); assert.match(init.csrfToken, /^[a-f0-9]{64}$/);
    const headers = { Origin: base, 'X-CSRF-Token': init.csrfToken, 'Content-Type': 'application/json' };
    const post = async (value, change = {}) => fetch(`${base}/api/photos`, { method: 'POST', headers: { ...headers, ...change }, body: JSON.stringify(value) });
    assert.equal((await post(payload(), { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(payload(), { 'X-CSRF-Token': 'wrong' })).status, 403);
    assert.equal((await post(payload(), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await rawRequest(address.port, { headers: { ...headers, Host: 'evil.example' } }, JSON.stringify(payload()))).status, 403);
    assert.equal((await post({ ...payload(), image: { data: Buffer.from('wrong image').toString('base64'), width: 1, height: 1 } })).status, 400);
    assert.equal((await post({ ...payload(), image: { ...payload().image, width: imageSize.width + 1 } })).status, 400);
    assert.equal((await post(payload('R43'))).status, 400);
    const oversized = ' '.repeat(ADMIN_LIMITS.maxBodyBytes + 1);
    assert.equal((await rawRequest(address.port, { headers: { ...headers, 'Content-Length': Buffer.byteLength(oversized) } }, oversized)).status, 413);
    assert.equal((await rawRequest(address.port, { headers }, oversized)).status, 413);
    const response = await post({ ...payload(), filename: 'private-person-name.jpg', author: 'do not persist' });
    assert.equal(response.status, 201); const result = await response.json();
    assert.match(result.photo.id, /^admin-[a-f0-9-]+$/); assert.equal(result.photo.src, `images/rooms/${result.photo.id}.webp`);
    assert.equal(result.photo.source, '管理者追加');
    assert.deepEqual(await readFile(join(data.root, 'public', result.photo.src)), imageBytes);
    const manifest = await readJson(join(data.root, 'public/data/admin-photos.json'));
    assert.equal(manifest.photos.length, 1); assert.equal(manifest.photos[0].id, result.photo.id);
    const serialized = JSON.stringify(await Promise.all(['rooms.json', 'photo-sources.json', 'admin-photos.json'].map(name => readJson(join(data.root, 'public/data', name)))));
    assert.ok(!serialized.includes('private-person-name')); assert.ok(!serialized.includes('do not persist'));
    assert.equal(result.summary.webpCount, 165);
    const concurrent = await Promise.all([post(payload('R41', 'interior')), post(payload('R41', 'exterior'))]);
    assert.deepEqual(concurrent.map(response => response.status), [201, 201]);
    assert.equal((await readJson(join(data.root, 'public/data/admin-photos.json'))).photos.length, 3);
    assert.equal((await readJson(join(data.root, 'public/data/photo-sources.json'))).summary.webpCount, 167);
    assert.equal((await fetch(`${base}/tools/admin/.state/transaction.json`)).status, 404);
    assert.equal((await fetch(`${base}/api/photos`, { method: 'OPTIONS' })).status, 405);
  } finally { await app.close(); await data.cleanup(); }
});

test('browser GUI converts, previews, uploads multiple photos and strips source metadata', { skip: process.env.RUN_ADMIN_BROWSER_TEST !== '1' }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.playwright');
  process.env.TEMP = process.env.TMP = resolve('.build-temp');
  await mkdir(process.env.TEMP, { recursive: true });
  const { chromium } = await import('@playwright/test');
  const data = await fixture();
  const app = await createAdminServer({ projectRoot: data.root, port: 0 });
  let browser;
  try {
    const address = await app.listen(); const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = []; const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => requests.push(request.url()));
    await page.goto(base); await page.locator('#upload-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#room option').count(), 43);
    await page.locator('#room').selectOption('R42');
    await page.locator('#files').setInputFiles({ name: 'not-photo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg></svg>') });
    await page.waitForFunction(() => document.getElementById('file-errors').textContent.includes('JPG'));
    await page.evaluate(() => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'too-large.jpg', { type: 'image/jpeg' })); document.getElementById('files').files = transfer.files; document.getElementById('files').dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => document.getElementById('file-errors').textContent.includes('20MB'));
    const encoded = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 2000; canvas.height = 1200; const context = canvas.getContext('2d'); context.fillStyle = '#1464de'; context.fillRect(0, 0, 1000, 1200); return canvas.toDataURL('image/png').split(',')[1]; });
    const photo = Buffer.from(encoded, 'base64');
    await page.locator('#files').setInputFiles([{ name: 'private-name-one.png', mimeType: 'image/png', buffer: photo }, { name: 'private-name-two.png', mimeType: 'image/png', buffer: photo }]);
    await page.waitForFunction(() => document.querySelectorAll('.photo').length === 2 && !document.getElementById('add').disabled);
    assert.ok((await page.locator('.photo-meta').first().textContent()).includes('1440×864'));
    await page.locator('.photo select').nth(1).selectOption('exterior');
    await page.screenshot({ path: 'test-results/admin-ready.png', fullPage: true });
    await page.locator('#add').click();
    await page.waitForFunction(() => document.getElementById('result-summary').textContent && document.getElementById('result-summary').textContent !== '追加しています…');
    assert.equal(await page.locator('#result-summary').textContent(), '2枚追加', await page.locator('#results').textContent());
    assert.equal(await page.locator('#results li.success').count(), 2);
    const manifest = await readJson(join(data.root, 'public/data/admin-photos.json'));
    assert.equal(manifest.photos.length, 2);
    assert.deepEqual(manifest.photos.map(item => item.kind), ['interior', 'exterior']);
    for (const item of manifest.photos) {
      assert.equal(item.width, 1440); assert.equal(item.height, 864);
      const bytes = await readFile(join(data.root, 'public', item.src));
      assert.deepEqual(inspectWebP(bytes), { width: 1440, height: 864 });
      assert.equal(bytes.includes(Buffer.from('EXIF')), false);
    }
    assert.equal(JSON.stringify(manifest).includes('private-name'), false);
    await page.evaluate(encoded => { const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0)); const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'dragged-photo.png', { type: 'image/png' })); document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); }, encoded);
    await page.waitForFunction(() => document.querySelectorAll('.photo').length === 3 && !document.getElementById('add').disabled);
    await page.locator('#add').click();
    await page.waitForFunction(() => document.getElementById('result-summary').textContent === '1枚追加');
    assert.equal((await readJson(join(data.root, 'public/data/admin-photos.json'))).photos.length, 3);
    await page.screenshot({ path: 'test-results/admin-success.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.ok(requests.every(url => url.startsWith(base) || url.startsWith('blob:') || url.startsWith('data:')));
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await app.close(); await data.cleanup(); }
});
