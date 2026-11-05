import assert from 'node:assert/strict';
import { mkdir, mkdtemp, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
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
  assert.ok((await page.locator('#gallery-panel').textContent()).includes('画像ファイル・原本は残ります'));
  await page.locator('#gallery img').evaluateAll(images => images.forEach(image => image.loading = 'eager'));
  await page.waitForFunction(() => [...document.querySelectorAll('#gallery img')].every(image => image.complete && image.naturalWidth));
  assert.equal(await page.locator('#gallery img').first().evaluate(image => getComputedStyle(image).objectFit), 'contain');
  // Accessible previous/next and row movement buttons save immediately.
  await page.locator(`[data-photo-id="${original[0]}"] [data-move="right"]`).click();
  const afterRight = [original[1], original[0], ...original.slice(2)];
  await waitIds(afterRight);
  assert.equal(await page.locator('#gallery-status').textContent(), '保存済み・公開待ち');
  await page.locator(`[data-photo-id="${original[0]}"] [data-move="left"]`).focus();
  await page.keyboard.press('Space'); await waitIds(original);
  await page.locator(`[data-photo-id="${original[0]}"] [data-move="down"]`).click();
  const down = original.slice(); down.splice(0, 1); down.splice(3, 0, original[0]);
  await waitIds(down);
  await page.locator(`[data-photo-id="${original[0]}"] [data-move="up"]`).click(); await waitIds(original);
  await page.locator(`#gallery > [data-photo-id="${original[2]}"]`).dragTo(page.locator(`#gallery > [data-photo-id="${original[0]}"]`));
  const dragged = [original[2], original[0], original[1], ...original.slice(3)];
  await waitIds(dragged);
  // Deletion confirmation can be canceled in all three ways and retains files.
  const deleteId = dragged[0];
  const sourceRooms = JSON.parse(await readFile(join(root, 'public/data/rooms.json'), 'utf8'));
  const sourcePhoto = sourceRooms.find(room => room.id === '31A').gallery.find(photo => photo.sourceId === deleteId);
  const imagePath = join(root, 'public', sourcePhoto.src);
  const initialHash = createHash('sha256').update(await readFile(imagePath)).digest('hex');
  for (const cancel of ['outside', 'close', 'escape']) {
    await page.locator(`[data-delete-id="${deleteId}"]`).click();
    await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#confirm-action').textContent(), '削除');
    assert.equal(await page.locator('#confirm-action').evaluate(button => getComputedStyle(button).backgroundColor), 'rgb(176, 0, 32)');
    await page.locator('#confirm-title').click(); assert.equal(await page.locator('#confirm-dialog').isVisible(), true);
    if (cancel === 'outside') await page.mouse.click(5, 5);
    else if (cancel === 'close') await page.locator('#confirm-close').click();
    else await page.keyboard.press('Escape');
    await page.locator('#confirm-dialog').waitFor({ state: 'hidden' }); await waitIds(dragged);
  }
  await page.locator(`[data-delete-id="${deleteId}"]`).click(); await page.locator('#confirm-action').click();
  await waitIds(dragged.filter(id => id !== deleteId));
  assert.equal(createHash('sha256').update(await readFile(imagePath)).digest('hex'), initialHash);
  await page.locator('#deleted-photos > summary').click();
  assert.equal(await page.locator(`#deleted-gallery [data-photo-id="${deleteId}"]`).count(), 1);
  await page.locator(`[data-restore-id="${deleteId}"]`).click(); await waitIds(dragged);
  assert.equal(await page.locator('#deleted-count').textContent(), '0');
  // Another tab's newer revision wins. The failed old operation is never replayed.
  const fresh = await (await fetch(`${base}/api/bootstrap`)).json();
  const room = fresh.rooms.find(room => room.id === '31A');
  const external = room.photos.map(photo => photo.id); [external[0], external[1]] = [external[1], external[0]];
  const response = await fetch(`${base}/api/gallery`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-CSRF-Token': fresh.csrfToken }, body: JSON.stringify({ roomId: room.id, order: external, hidden: room.photos.filter(photo => photo.hidden).map(photo => photo.id), revision: room.revision }) });
  assert.equal(response.status, 200);
  await page.locator('#gallery [data-move="right"]').first().click();
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
  await page.locator('#gallery [data-move="right"]').first().click();
  await waitIds([mobileIds[1], mobileIds[0], ...mobileIds.slice(2)]);
  await page.locator('#gallery img').evaluateAll(images => images.forEach(image => image.loading = 'eager'));
  await page.waitForFunction(() => [...document.querySelectorAll('#gallery img')].every(image => image.complete && image.naturalWidth));
  await page.screenshot({ path: 'test-results/gallery-admin-mobile.png', fullPage: true });
  assert.ok(requests.every(url => url.startsWith(base) || url.startsWith('blob:') || url.startsWith('data:')));
  assert.deepEqual(errors, []);
  await writeFile('test-results/gallery-browser-report.json', JSON.stringify({ passed: true, cases: ['buttons', 'keyboard', 'drag', 'cancel', 'soft-delete', 'restore', '409', 'upload-refresh', 'publish', 'publish-reconnect', 'safe-logs', 'mobile'], errors }, null, 2));
  console.log('Gallery administrator browser tests passed. Real public data was not modified.');
} finally {
  if (browser) await browser.close();
  await app.close();
  assert.ok(root.startsWith(results + sep + 'gallery-browser-'));
  await rm(root, { recursive: true, force: true });
}
