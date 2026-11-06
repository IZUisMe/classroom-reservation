import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.playwright');
process.env.TEMP = process.env.TMP = resolve('.build-temp');
const { chromium } = await import('@playwright/test');
const catalog = JSON.parse(await readFile('public/data/rooms.json', 'utf8'));
let current = structuredClone(catalog);
const requests = [];
const root = resolve('dist');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/data/rooms.json') {
    requests.push(url.search);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify(current)); return;
  }
  try {
    const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    assert.ok(file.startsWith(root + sep));
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  for (const width of [1280, 390]) {
    current = structuredClone(catalog);
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.locator('#entry-0-roomId').selectOption('31A');
    await page.locator('#profile-name').fill('入力を保持');
    const ids = await page.locator('#entry-0-roomId option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
    for (const prefix of ['22', '32', '33', '72']) {
      const group = ids.filter(id => id.startsWith(prefix));
      assert.deepEqual(group, [...group].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));
    }
    await page.locator('#photos-0 .photo-open').first().click();
    assert.equal(await page.locator('#photo-dialog').isVisible(), true);
    const room = current.find(room => room.id === '31A');
    const previous = room.gallery.length;
    room.gallery = room.gallery.slice(1);
    room.comment = '更新されたコメント <script>\n2行目';
    await page.waitForFunction(() => document.querySelector('.room-comment')?.textContent === '更新されたコメント <script>\n2行目', null, { timeout: 15000 });
    assert.equal(await page.locator('#photos-0 img').count(), previous - 1);
    assert.equal(await page.locator('#profile-name').inputValue(), '入力を保持');
    assert.equal(await page.locator('#photo-dialog').isVisible(), false);
    assert.equal(await page.locator('#photos-0 script').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: `test-results/catalog-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  assert.ok(requests.length >= 4 && requests.every(query => query.startsWith('?updated=')));
  console.log('Catalog refresh, alphabetical order, comments, and preserved inputs passed on desktop/mobile.');
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
