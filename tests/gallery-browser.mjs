import assert from 'node:assert/strict';
import { mkdir, mkdtemp, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createAdminServer } from '../tools/admin-server.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.playwright');
process.env.TEMP = process.env.TMP = resolve('.build-temp');
await mkdir(process.env.TEMP, { recursive: true });
const { chromium } = await import('@playwright/test');
const results = resolve('test-results');
await mkdir(results, { recursive: true });
const root = await mkdtemp(join(results, 'gallery-browser-'));
assert.ok(root.startsWith(results + sep + 'gallery-browser-'));
await mkdir(join(root, 'public'), { recursive: true });
await cp('public/data', join(root, 'public/data'), { recursive: true });
await cp('public/images', join(root, 'public/images'), { recursive: true });
let sequence = 0;
let job = { id: null, state: 'idle', logs: '', site: 'https://izuisme.github.io/classroom-reservation/' };
const publisher = {
  isRunning: () => job.state === 'running',
  getStatus: () => structuredClone(job),
  start: () => { job = { id: `fixture-${++sequence}`, state: 'running', phase: 'テスト公開中', logs: 'fixture publish started\n<img src=x onerror=alert(1)>', site: 'https://izuisme.github.io/classroom-reservation/' }; return structuredClone(job); },
};
const app = await createAdminServer({ projectRoot: root, port: 0, publishController: publisher });
let browser;
const errors = [];
try {
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, hasTouch: true });
  const page = await context.newPage();
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', failure => errors.push(failure.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('409')) errors.push(message.text()); });
  await page.goto(base);
  await page.locator('#upload-form').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('room').disabled);
  assert.equal(await page.title(), '教室写真の管理｜管理者PC専用');
  await page.locator('#room').selectOption('31A');
  const ids = () => page.locator('#gallery > .gallery-photo').evaluateAll(cards => cards.map(card => card.dataset.photoId));
  const waitIds = expected => page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#gallery > .gallery-photo')].map(card => card.dataset.photoId)) === JSON.stringify(expected), expected);
  const original = await ids();
  assert.ok(original.length >= 6);
  assert.equal(await page.locator('[data-move], [data-restore-id]').count(), 0);
  await page.locator('#gallery img').evaluateAll(images => images.forEach(image => image.loading = 'eager'));
  await page.waitForFunction(() => [...document.querySelectorAll('#gallery img')].every(image => image.complete && image.naturalWidth));
  assert.equal(await page.locator('#gallery img').first().evaluate(image => getComputedStyle(image).objectFit), 'contain');
  // Keyboard fallback and pointer dragging both persist immediately.
  await page.locator(`[data-photo-id="${original[0]}"] .drag-handle`).focus();
  await page.keyboard.press('ArrowRight');
  const afterRight = [original[1], original[0], ...original.slice(2)];
  await waitIds(afterRight);
  await page.waitForFunction(() => document.getElementById('gallery-status').textContent === '保存済み・公開待ち');
  await page.keyboard.press('ArrowLeft'); await waitIds(original);
  await page.waitForFunction(() => !document.querySelector('#gallery .drag-handle').disabled);
  const drag = async (from, to) => {
    const handle = page.locator(`[data-photo-id="${from}"] .drag-handle`);
    await handle.scrollIntoViewIfNeeded();
    const start = await handle.boundingBox();
    const end = await page.locator(`[data-photo-id="${to}"] img`).boundingBox();
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById('gallery-status').textContent === '保存済み・公開待ち' && !document.querySelector('#gallery .drag-handle').disabled);
  };
  await drag(original[2], original[0]);
  const dragged = [original[2], original[0], original[1], ...original.slice(3)];
  await waitIds(dragged);
  await page.locator('#room-comment').fill('窓側にコンセント <script>\n静かな教室');
  await page.locator('#save-comment').click();
  await page.waitForFunction(() => !document.getElementById('save-comment').disabled);
  await page.reload(); await page.waitForFunction(() => !document.getElementById('room').disabled);
  await page.locator('#room').selectOption('31A');
  assert.equal(await page.locator('#room-comment').inputValue(), '窓側にコンセント <script>\n静かな教室');
  // Deletion confirmation can be canceled in all three ways and retains files.
  const deleteId = dragged[0];
  const sourceRooms = JSON.parse(await readFile(join(root, 'public/data/rooms.json'), 'utf8'));
  const sourcePhoto = sourceRooms.find(room => room.id === '31A').gallery.find(photo => photo.sourceId === deleteId);
  const imagePath = join(root, 'public', sourcePhoto.src);
  for (const cancel of ['outside', 'close', 'escape']) {
    await page.locator(`[data-delete-id="${deleteId}"]`).click();
    await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#confirm-action').textContent(), '完全に削除');
    assert.equal(await page.locator('#confirm-action').evaluate(button => getComputedStyle(button).backgroundColor), 'rgb(176, 0, 32)');
    await page.locator('#confirm-title').click(); assert.equal(await page.locator('#confirm-dialog').isVisible(), true);
    if (cancel === 'outside') await page.mouse.click(5, 5);
    else if (cancel === 'close') await page.locator('#confirm-close').click();
    else await page.keyboard.press('Escape');
    await page.locator('#confirm-dialog').waitFor({ state: 'hidden' }); await waitIds(dragged);
  }
  await page.locator(`[data-delete-id="${deleteId}"]`).click(); await page.locator('#confirm-action').click();
  await waitIds(dragged.filter(id => id !== deleteId));
  await assert.rejects(readFile(imagePath), { code: 'ENOENT' });
  assert.equal((await fetch(`${base}/photos/${deleteId}`)).status, 404);
  // Another tab's newer revision wins. The failed old operation is never replayed.
  const fresh = await (await fetch(`${base}/api/bootstrap`)).json();
  const room = fresh.rooms.find(room => room.id === '31A');
  const external = room.photos.map(photo => photo.id); [external[0], external[1]] = [external[1], external[0]];
  const response = await fetch(`${base}/api/gallery`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-CSRF-Token': fresh.csrfToken }, body: JSON.stringify({ roomId: room.id, order: external, hidden: room.photos.filter(photo => photo.hidden).map(photo => photo.id), revision: room.revision }) });
  assert.equal(response.status, 200);
  await page.locator('#gallery .drag-handle').first().focus(); await page.keyboard.press('ArrowRight');
  await waitIds(external);
  await page.waitForFunction(() => document.getElementById('gallery-status').textContent.includes('別の画面'));
  const canonical = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.deepEqual(canonical.rooms.find(room => room.id === '31A').photos.map(photo => photo.id), external);
  // Upload queue remains independent, and upload refreshes the saved gallery.
  await page.locator('#room').selectOption('72A');
  const beforeUpload = await ids();
  const encoded = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 60; canvas.height = 30; const drawing = canvas.getContext('2d'); drawing.fillStyle = '#2466d4'; drawing.fillRect(0, 0, 60, 30); return canvas.toDataURL('image/png').split(',')[1]; });
  await page.locator('#files').setInputFiles({ name: 'fixture-only.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') });
  await page.waitForFunction(() => !document.getElementById('add').disabled);
  await page.locator('#add').click();
  await page.waitForFunction(expected => document.querySelectorAll('#gallery > .gallery-photo').length === expected, beforeUpload.length + 1);
  assert.equal(await page.locator('#gallery-status').textContent(), '保存済み・公開待ち');
  await page.locator('#queue .remove').click();
  assert.equal(await page.locator('#queue .photo').count(), 0);
  assert.equal((await ids()).length, beforeUpload.length + 1, 'Removing from upload queue does not delete a saved photo');
  // Publish confirmation, operation exclusion, reload reconnect and safe logs.
  await page.locator('#publish').click(); await page.mouse.click(5, 5);
  await page.locator('#confirm-dialog').waitFor({ state: 'hidden' }); assert.equal(sequence, 0);
  await page.locator('#publish').click(); await page.locator('#confirm-action').click();
  await page.waitForFunction(() => document.getElementById('publish-status').textContent.includes('テスト公開中'));
  assert.equal(sequence, 1);
  assert.equal(await page.locator('#room').isDisabled(), true); assert.equal(await page.locator('#files').isDisabled(), true);
  assert.equal(await page.locator('#gallery [data-delete-id]').first().isDisabled(), true);
  assert.ok((await page.locator('#publish-logs').textContent()).includes('<img src=x'));
  assert.equal(await page.locator('img[src="x"]').count(), 0);
  await page.reload(); await page.locator('#upload-form').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('publish-status').textContent.includes('テスト公開中'));
  assert.equal(sequence, 1); assert.equal(await page.locator('#room').isDisabled(), true);
  job = { ...job, state: 'success', phase: '完了', logs: job.logs + '\n公開完了', finishedAt: new Date().toISOString() };
  await page.waitForFunction(() => document.getElementById('publish-status').textContent === '公開済み');
  assert.equal(await page.locator('#room').isDisabled(), false);
  assert.equal(await page.locator('#published-site').isVisible(), true);
  await page.locator('#room').selectOption('31A');
  await page.screenshot({ path: 'test-results/gallery-admin-desktop.png', fullPage: true });
  await page.locator('#publish').click(); await page.locator('#confirm-action').click();
  await page.waitForFunction(() => document.getElementById('publish-status').textContent.includes('テスト公開中'));
  assert.equal(sequence, 2);
  job = { ...job, state: 'failed', phase: 'エラー', logs: 'fixture publish failure' };
  await page.waitForFunction(() => document.getElementById('publish-status').textContent.includes('失敗'));
  assert.equal(await page.locator('#room').isDisabled(), false);
  // Touch-width editing uses the same explicit buttons and never overflows.
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const mobileIds = await ids();
  await page.locator('#gallery .gallery-photo').first().evaluate(card => card.scrollIntoView({ block: 'start' }));
  const firstHandle = await page.locator('#gallery .drag-handle').first().boundingBox();
  const secondImage = await page.locator('#gallery .gallery-photo img').nth(1).boundingBox();
  const touch = await context.newCDPSession(page);
  const x = firstHandle.x + firstHandle.width / 2;
  const y = firstHandle.y + firstHandle.height / 2;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: secondImage.x + secondImage.width / 2, y: secondImage.y + secondImage.height / 2 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitIds([mobileIds[1], mobileIds[0], ...mobileIds.slice(2)]);
  await page.waitForFunction(() => !document.querySelector('#gallery .drag-handle').disabled);
  await touch.detach();
  await page.locator('#gallery img').evaluateAll(images => images.forEach(image => image.loading = 'eager'));
  await page.waitForFunction(() => [...document.querySelectorAll('#gallery img')].every(image => image.complete && image.naturalWidth));
  await page.screenshot({ path: 'test-results/gallery-admin-mobile.png', fullPage: true });
  assert.ok(requests.every(url => url.startsWith(base) || url.startsWith('blob:') || url.startsWith('data:')));
  // Updated UI must explicitly reject an old, still-running server.
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, version: 2 } });
  });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('connection').textContent.includes('管理サーバーが旧バージョン'));
  assert.equal(await page.locator('#upload-form').isVisible(), false);
  assert.deepEqual(errors, []);
  await writeFile('test-results/gallery-browser-report.json', JSON.stringify({ passed: true, cases: ['comment', 'keyboard', 'drag', 'cancel', 'permanent-delete', '409', 'upload-refresh', 'publish', 'publish-reconnect', 'safe-logs', 'mobile'], errors }, null, 2));
  console.log('Gallery administrator browser tests passed. Real public data was not modified.');
} finally {
  if (browser) await browser.close();
  await app.close();
  assert.ok(root.startsWith(results + sep + 'gallery-browser-'));
  await rm(root, { recursive: true, force: true });
}
