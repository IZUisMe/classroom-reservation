import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.playwright');
process.env.TEMP = process.env.TMP = resolve('.build-temp');
const { chromium } = await import('@playwright/test');
const { PDFDocument } = await import('pdf-lib');
const origin = process.env.TEST_URL || 'http://127.0.0.1:4173';
const catalog = JSON.parse(await readFile('public/data/rooms.json', 'utf8'));
assert.equal(catalog.length, 42, 'All 42 catalog rooms are available, including PDF-only and user-provided rooms');
for (const id of ['72A', '72BC']) assert.ok(catalog.some(room => room.id === id), `${id} is present`);
const galleryFor = room => room.gallery || Object.entries(room.images || {}).map(([kind, image]) => ({ ...image, kind }));
await mkdir('test-results/downloads', { recursive: true });
await mkdir(process.env.TEMP, { recursive: true });
// The default headless shell cancels Downloads on this Windows installation.
const browser = await chromium.launch({ headless: true, channel: 'chromium', downloadsPath: resolve('test-results/downloads') });
const errors = [];
const metrics = {};
const allRequests = [];
const heavyAsset = url => /\/fonts\/|\.(?:pdf|ttf|otf|woff2?)(?:[?#]|$)|\/assets\/(?:pdf|fontkit|pdf-lib)[-.]/i.test(url);
const keys = { draft: 'classroom.draft.v1', profile: 'classroom.profile.v1', history: 'classroom.history.v1', settings: 'classroom.settings.v1' };
const activeRect = '#application-preview svg rect[data-preview-active]';
const spotlightRect = '#application-preview svg rect[data-preview-spotlight]';
const title = '学内施設使用許可願生成マシーン（横浜キャンパス）';
const defaultPurpose = '本会の対面活動を実施するため';

function observe(context) {
  const requests = [];
  context.on('request', request => { requests.push(request.url()); allRequests.push(request.url()); });
  context.on('page', page => {
    page.setDefaultTimeout(20_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  });
  return requests;
}
async function ready(page) {
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#application-preview svg text'));
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => /application-preview\.webp/.test(entry.name) && entry.responseEnd > 0));
}
async function checkShell(page) {
  assert.equal(await page.title(), title);
  assert.equal(await page.locator('h1').textContent(), title);
  assert.equal(await page.locator('#entry-0-roomId option').count(), catalog.length + 1);
  assert.deepEqual(await page.locator('#entry-0-roomId option[value]:not([value=""])').evaluateAll(options => options.map(option => option.value).sort()), catalog.map(room => room.id).sort());
  assert.equal(await page.locator('#entry-count').textContent(), '1/9');
  assert.equal(await page.locator('#mobile-count').textContent(), '1/9');
  assert.equal((await page.locator('#add-entry').textContent()).replace(/\s/g, '').replace('＋', '+'), '+追加');
  assert.equal(await page.locator('#student-profile').getAttribute('data-ready'), 'false');
  assert.equal(await page.locator('#intro, .intro, #open-profile, #profile-dialog, #profile-form, #messages-details, #summary-profile, #profile-summary, #summary-count, #summary-entries, .summary-panel, #mail-output, #notice-output, #copy-mail, #copy-notice, #notice-entry, #mail-addresses, #title, #target, #belongings, #profile-emailTo, #profile-emailCc, #profile-role, a[href^="mailto:"]').count(), 0, 'Removed intro, summary, profile modal, mail/notice and legacy inputs must not exist');
  assert.equal(await page.getByRole('button', { name: '反映', exact: true }).count(), 0, 'Inline identity inputs apply immediately');
  assert.equal(await page.locator('#storage-settings').evaluate(element => element.tagName === 'DETAILS' && !element.open), true);
  for (const selector of ['#remember-draft', '#history-list', '#reset-form', '#clear-local']) assert.equal(await page.locator(`#storage-settings ${selector}`).count(), 1);
  assert.equal(await page.locator('#application-form > #student-profile.panel').count(), 1);
  assert.equal(await page.locator('#application-form > :last-child').getAttribute('id'), 'student-profile');
  for (const key of ['name', 'studentId', 'phone']) {
    assert.equal(await page.locator(`#student-profile #profile-${key}[data-profile-key="${key}"]`).inputValue(), '', 'No default PII');
  }
  assert.equal(await page.locator('#student-profile input:not([type="checkbox"])').count(), 3);
  assert.equal(await page.locator('#remember-profile').isChecked(), true, 'Identity saving is enabled by default');
  assert.equal(await page.locator('#remember-draft').isChecked(), true, 'Draft/history saving is enabled by default');
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('classroom.')).length), 0, 'Do not save empty defaults before editing');
  await noSpotlight(page);
  await checkCards(page, 1);
  assert.equal(await page.locator('#purpose').getAttribute('placeholder'), defaultPurpose);
  assert.equal(await page.locator('#purpose').getAttribute('required'), null);
  assert.equal(await page.locator('label[for="purpose"] .required').count(), 0);
  assert.equal(await page.locator('label[for="purpose"]').textContent(), '使用目的');
  assert.equal(await page.locator('#purpose').inputValue(), '', 'Default purpose is a placeholder, not prefilled before PDF export');
  await checkTimeOptions(page);
}
async function checkCards(page, count) {
  const cards = page.locator('#entries > article.entry.panel');
  assert.equal(await cards.count(), count, 'Every entry must be its own panel/card');
  assert.equal(await page.locator('#entries .entry .entry').count(), 0);
  assert.equal(await cards.evaluateAll(elements => elements.every((element, index) => {
    const style = getComputedStyle(element);
    const heading = element.querySelector('.entry-number');
    const previous = elements[index - 1];
    const room = element.querySelector('[data-key="roomId"]');
    const date = element.querySelector('[data-key="date"]');
    return parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none'
      && heading.textContent === `${index + 1}件目` && parseFloat(getComputedStyle(heading).fontSize) >= 18
      && (!previous || element.getBoundingClientRect().top > previous.getBoundingClientRect().bottom)
      && Boolean(room.compareDocumentPosition(date) & Node.DOCUMENT_POSITION_FOLLOWING);
  })), true, 'Cards have separate borders/gaps, prominent numbered headings, and room/people before date/time');
}
async function checkTimeOptions(page) {
  for (const key of ['start', 'end']) {
    assert.equal(await page.locator(`#entry-0-${key}`).getAttribute('type'), 'time');
    assert.equal(await page.locator(`#entry-0-${key}`).getAttribute('step'), '60', 'Native time input allows one-minute increments');
    assert.equal(await page.locator(`#entry-0-${key}-hour, #entry-0-${key}-minute`).count(), 0);
  }
}
async function noSpotlight(page) {
  // The overlay remains during its 200ms fade-out instead of disappearing at blur.
  await page.waitForFunction(() => !document.querySelector('#application-preview rect[data-preview-active], #application-preview rect[data-preview-spotlight]'), null, { timeout: 1000 });
  assert.equal(await page.locator(activeRect).count(), 0, 'No active preview box after the blur transition');
  assert.equal(await page.locator(spotlightRect).count(), 0, 'No dimming after the blur transition');
}
async function checkSpotlightTransitions(page) {
  await page.locator('#purpose').evaluate(element => element.blur()); await noSpotlight(page);
  const fadeIn = await page.locator('#purpose').evaluate(element => {
    element.focus();
    const spotlight = document.querySelector('#application-preview rect[data-preview-spotlight]');
    const overlay = spotlight.parentElement;
    const animation = overlay.getAnimations()[0];
    const active = document.querySelector('#application-preview rect[data-preview-active]');
    return {
      duration: animation?.effect.getTiming().duration,
      target: animation?.effect.getKeyframes().at(-1).opacity,
      active: Object.fromEntries(['fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width', 'rx'].map(key => [key, active.getAttribute(key)])),
      haloCount: overlay.querySelectorAll('rect[stroke="#fff"], rect[stroke="white"]').length,
    };
  });
  assert.equal(fadeIn.duration, 200, 'Surrounding dimming fades in over 200ms');
  assert.equal(Number(fadeIn.target), 1);
  assert.deepEqual(fadeIn.active, { fill: '#f43f5e', 'fill-opacity': '0.055', stroke: '#e65b72', 'stroke-opacity': '0.65', 'stroke-width': '1', rx: '1' }, 'Active input keeps the original soft-red treatment');
  assert.equal(fadeIn.haloCount, 0, 'Active area has no white halo');
  await page.waitForFunction(() => { const overlay = document.querySelector('#application-preview rect[data-preview-spotlight]')?.parentElement; return overlay && Number(getComputedStyle(overlay).opacity) > .99; });
  const fadeOut = await page.locator('#purpose').evaluate(async element => {
    element.blur(); await Promise.resolve();
    const spotlight = document.querySelector('#application-preview rect[data-preview-spotlight]');
    const animation = spotlight?.parentElement.getAnimations()[0];
    return { present: Boolean(spotlight), duration: animation?.effect.getTiming().duration, target: animation?.effect.getKeyframes().at(-1).opacity };
  });
  assert.equal(fadeOut.present, true, 'Blur starts a fade rather than immediately deleting the overlay');
  assert.equal(fadeOut.duration, 200);
  assert.equal(Number(fadeOut.target), 0);
  await noSpotlight(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.locator('#purpose').evaluate(async element => {
    element.focus();
    const overlay = document.querySelector('#application-preview rect[data-preview-spotlight]')?.parentElement;
    const result = { opacity: overlay && getComputedStyle(overlay).opacity, animations: overlay?.getAnimations().length };
    element.blur(); await Promise.resolve();
    result.removedImmediately = !document.querySelector('#application-preview rect[data-preview-active], #application-preview rect[data-preview-spotlight]');
    return result;
  });
  assert.deepEqual(reduced, { opacity: '1', animations: 0, removedImmediately: true }, 'Reduced-motion preference disables both fades');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}
async function outsideDialog(page, id) {
  const bounds = await page.locator(id).boundingBox();
  assert.ok(bounds.x > 2 || bounds.y > 2, 'Backdrop test point is outside the dialog');
  await page.mouse.click(2, 2);
  await page.locator(id).waitFor({ state: 'hidden' });
}
async function checkPhotos(page, mouseDrag = false) {
  await page.locator('#entry-0-roomId').selectOption('32C');
  const strip = page.locator('#entries > article').first().locator('.photo-strip');
  const images = galleryFor(catalog.find(room => room.id === '32C'));
  assert.ok(images.length >= 3, '32C includes new ROOMLIST photos');
  assert.equal(await strip.locator('img').count(), images.length);
  assert.deepEqual(await strip.locator('[data-action="photo"][data-index="0"][data-photo-index]').evaluateAll(buttons => buttons.map(button => Number(button.dataset.photoIndex))), images.map((_, index) => index));
  assert.equal(await strip.locator('.photo-caption, figcaption').count(), 0, 'Inline gallery has no lower-left annotation overlays');
  await strip.locator('img').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => { const image = document.querySelector('#entries > article:first-child .photo-strip img'); return image.complete && image.naturalWidth > 0; });
  assert.equal(await strip.evaluate(element => element.scrollWidth > element.clientWidth), true, 'Photo strip scrolls independently');
  assert.equal(await strip.locator('img').first().evaluate(image => Math.abs(image.getBoundingClientRect().width / image.getBoundingClientRect().height - image.naturalWidth / image.naturalHeight) < .015), true, 'Inline photos preserve their natural aspect ratio');
  if (mouseDrag) {
    assert.equal(await strip.locator('img').first().evaluate(image => Math.round(image.getBoundingClientRect().height)), 285);
    await strip.scrollIntoViewIfNeeded();
    const box = await strip.boundingBox();
    await page.mouse.move(box.x + box.width * .65, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .65 - 150, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('#entries > article:first-child .photo-strip').scrollLeft > 0);
    assert.equal(await page.locator('#photo-dialog').isVisible(), false, 'Dragging scrolls without opening a photo');
    await strip.evaluate(element => element.scrollTo({ left: 0, behavior: 'instant' }));
    await strip.focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('#entries > article:first-child .photo-strip').scrollLeft > 0);
    assert.equal(await page.locator('#photo-dialog').isVisible(), false, 'Keyboard scrolling does not open a photo');
    await strip.evaluate(element => element.scrollTo({ left: 0, behavior: 'instant' }));
  }
  for (const index of [0, images.length - 1]) {
    const button = strip.locator('[data-action="photo"]').nth(index);
    const source = await button.locator('img').getAttribute('src');
    assert.equal(new URL(source, origin).pathname, new URL(images[index].src, origin.endsWith('/') ? origin : `${origin}/`).pathname);
    await button.click();
    await page.locator('#photo-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#photo-dialog img').count(), 1, 'Open only the clicked full-size image');
    assert.equal(await page.locator('#photo-dialog img').evaluate((image, expected) => image.src === new URL(expected, document.baseURI).href, source), true);
    await page.waitForFunction(() => { const image = document.querySelector('#photo-dialog img'); return image.complete && image.naturalWidth > 0; });
    await page.locator('#photo-dialog-title').click();
    assert.equal(await page.locator('#photo-dialog').isVisible(), true, 'Clicking inside a modal must not dismiss it');
    if (index === 0) await outsideDialog(page, '#photo-dialog');
    else {
      await page.screenshot({ path: 'test-results/room-photo.png', scale: 'css' });
      await page.keyboard.press('Escape');
      await page.locator('#photo-dialog').waitFor({ state: 'hidden' });
    }
  }
  await strip.evaluate(element => element.scrollTo({ left: 0, behavior: 'instant' }));
  // A second room has a different gallery length; rendering is not hard-coded to two photos.
  await page.locator('#entry-0-roomId').selectOption('32B');
  assert.equal(await page.locator('#photos-0 .photo-strip img').count(), galleryFor(catalog.find(room => room.id === '32B')).length);
  for (const id of ['72A', '72BC']) {
    await page.locator('#entry-0-roomId').selectOption(id);
    await previewIncludes(page, catalog.find(room => room.id === id).name);
    assert.equal(await page.locator('#photos-0 .photo-strip img').count(), galleryFor(catalog.find(room => room.id === id)).length);
  }
  await page.locator('#entry-0-roomId').selectOption('');
  assert.equal(await page.locator('#photos-0 .photo-strip img').count(), 0);
  assert.equal(await page.locator('#photos-0 .photo-empty').textContent(), '教室を選択');
  await page.locator('#entry-0-roomId').selectOption('32C');
  await page.locator('#entry-0-roomId').evaluate(element => element.blur());
  await noSpotlight(page);
}
async function setProfile(page, name = '試験 太郎', remember) {
  if (remember !== undefined) await page.locator('#remember-profile').setChecked(remember);
  await page.locator('#profile-name').fill(name); await previewIncludes(page, name);
  await page.locator('#profile-studentId').fill('TEST001'); await previewIncludes(page, 'TEST001');
  await page.locator('#profile-phone').fill('090-0000-0000'); await previewIncludes(page, '090-0000-0000');
  assert.equal(await page.locator('#student-profile').getAttribute('data-ready'), 'true', 'Inline identity is ready without submitting another form');
}
async function previewIncludes(page, value) {
  await page.waitForFunction(expected => [...document.querySelectorAll('#application-preview svg text')].map(node => node.textContent).join('').includes(expected), value);
}
async function openStorage(page) {
  if (!await page.locator('#storage-settings').evaluate(element => element.open)) await page.locator('#storage-settings > summary').click();
}
async function confirm(page, destructive = false) {
  if (destructive) {
    assert.equal(await page.locator('#confirm-submit').textContent(), '削除');
    assert.equal(await page.locator('#confirm-submit').evaluate(button => button.classList.contains('destructive') && getComputedStyle(button).backgroundColor === 'rgb(176, 0, 32)'), true, 'Deletion must use a red destructive action');
  }
  await page.locator('#confirm-submit').click();
  await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
}
async function download(page, button, path, metric) {
  const started = Date.now();
  const pending = page.waitForEvent('download', { timeout: 120_000 });
  await page.locator(button).click();
  const result = await pending;
  assert.equal(await result.failure(), null, 'PDF download must complete');
  await result.saveAs(path); metrics[metric] = Date.now() - started;
  const document = await PDFDocument.load(await readFile(path));
  assert.equal(document.getPageCount(), 1, 'All 1–9 entries fit one PDF page');
  assert.ok(Math.abs(document.getPage(0).getWidth() - 595.3) < 1);
  assert.ok(Math.abs(document.getPage(0).getHeight() - 841.89) < 1);
  await page.waitForFunction(() => !document.getElementById('download-pdf').disabled);
}
async function rejectPdf(page, value, expected) {
  await page.locator('#purpose').fill(value);
  const beforeErrors = errors.length;
  let downloads = 0;
  const onDownload = () => { downloads++; }; page.on('download', onDownload);
  try {
    await page.locator('#download-pdf').click();
    await page.waitForFunction(text => !document.getElementById('error-summary').hidden && document.getElementById('error-summary').textContent.includes(text), expected, { timeout: 120_000 });
    await page.waitForFunction(() => !document.getElementById('download-pdf').disabled);
    assert.equal(downloads, 0, 'Unsupported/overflow text must reject, never download clipped text');
    assert.equal(await page.locator('#purpose').getAttribute('aria-invalid'), 'true');
    const expectedErrors = errors.slice(beforeErrors);
    assert.equal(expectedErrors.length, 1);
    assert.ok(expectedErrors[0].includes('PDF generation failed:'), `Unexpected rejection error: ${expectedErrors}`);
    errors.splice(beforeErrors, 1); // Deliberately caught PdfTextError is not a runtime failure.
  } finally { page.off('download', onDownload); }
}
async function assertNoHeavy(requests) {
  assert.deepEqual(requests.filter(heavyAsset), [], 'PDF code, template PDF and font must remain lazy until export');
  assert.ok(requests.some(url => /\/templates\/application\.fields\.json/.test(url)));
  assert.ok(requests.some(url => /\/templates\/application-preview\.webp/.test(url)));
}
async function noOverflow(page, width) {
  await page.setViewportSize({ width, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal document overflow at ${width}px`);
}
async function checkTimeEditing(page) {
  await page.locator('#entry-0-start').fill('19:41');
  await page.locator('#entry-0-end').fill('20:13');
  await previewIncludes(page, '19:41 〜 20:13');
  assert.equal(await page.locator('#entry-0-start').evaluate(input => input.validity.stepMismatch), false, 'Non-ten-minute start is valid');
  assert.equal(await page.locator('#entry-0-end').evaluate(input => input.validity.stepMismatch), false, 'Non-ten-minute end is valid');
  await page.locator('#entry-0-end').fill('19:30');
  await page.locator('#download-pdf').click();
  assert.ok((await page.locator('#error-summary').textContent()).includes('終了時刻は開始時刻より後'));
  assert.equal(await page.locator('#entry-0-end').getAttribute('aria-invalid'), 'true');
  await page.locator('#entry-0-end').fill('20:13');
  await previewIncludes(page, '19:41 〜 20:13');
}

try {
  const desktop = await browser.newContext({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true });
  const requests = observe(desktop);
  const page = await desktop.newPage();
  await page.goto(origin); await ready(page); await checkShell(page); await checkPhotos(page, true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/desktop-initial.png' });
  await assertNoHeavy(requests); metrics.initialRequests = requests.length;
  await page.locator('#download-pdf').click();
  await page.locator('#error-summary').waitFor({ state: 'visible' });
  for (const selector of ['#profile-name', '#profile-studentId', '#profile-phone']) assert.equal(await page.locator(selector).getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#purpose').getAttribute('aria-invalid'), null);
  assert.equal(await page.locator('#purpose').inputValue(), defaultPurpose, 'PDF action fills an empty purpose before validating other fields');
  await previewIncludes(page, defaultPurpose);
  await assertNoHeavy(requests); await setProfile(page);
  await page.locator('#purpose').fill('<img src=x onerror=alert(1)>');
  await previewIncludes(page, '<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('img[src="x"]').count(), 0, 'Preview escapes untrusted text');
  assert.equal(await page.locator(activeRect).count(), 1);
  assert.equal(await page.locator(spotlightRect).count(), 1, 'Input focus dims only the other preview regions');
  await checkSpotlightTransitions(page);
  await page.locator('#purpose').fill('研究会の作品制作と発表準備');
  await previewIncludes(page, '研究会の作品制作と発表準備');
  await page.locator('#entry-0-date').fill('2026-11-10'); await previewIncludes(page, '11月10日(火)');
  await page.locator('#entry-0-people').fill('5');
  await page.locator('#entry-0-roomId').selectOption('31A');
  await previewIncludes(page, catalog.find(room => room.id === '31A').name);
  await page.locator('#entry-0-roomId').selectOption('32C');
  await checkTimeEditing(page); await assertNoHeavy(requests);
  await page.locator('#entry-0-date').focus();
  const firstRowY = await page.locator(activeRect).getAttribute('y');
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/desktop-filled.png' });
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.profile.name === '試験 太郎', keys.profile);
  await download(page, '#download-pdf', 'test-results/browser-one.pdf', 'firstPdfMs');
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.length === 1, keys.history);
  await page.reload(); await ready(page);
  assert.equal(await page.locator('#profile-name').inputValue(), '試験 太郎', 'Default-on identity saving restores edits without a submit button');
  assert.equal(await page.locator('#purpose').inputValue(), '研究会の作品制作と発表準備');
  assert.equal(await page.locator('#entry-0-date').inputValue(), '2026-11-10');
  await noSpotlight(page);
  await page.locator('#remember-profile').uncheck();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), keys.profile), null, 'Opting out removes saved PII immediately');
  await openStorage(page);
  let stored = await page.evaluate(() => ({ ...localStorage }));
  assert.ok(!JSON.stringify(stored[keys.draft]).includes('試験 太郎'));
  assert.ok(!JSON.stringify(stored[keys.history]).includes('試験 太郎'), 'Draft/history never embed the profile');
  for (let index = 1; index < 9; index++) await page.locator('[data-action="duplicate"]').last().click();
  await checkCards(page, 9);
  assert.equal(await page.locator('#entry-count').textContent(), '9/9');
  assert.equal(await page.locator('#mobile-count').textContent(), '9/9');
  assert.equal(await page.locator('#add-entry').isDisabled(), true);
  assert.equal(await page.locator('[data-action="duplicate"]:disabled').count(), 9);
  await page.locator('#entry-1-people').fill('7'); await page.locator('#entry-1-date').fill('2026-11-11');
  assert.equal(await page.locator('#entry-0-people').inputValue(), '5', 'Duplicated cards edit independently');
  assert.equal(await page.locator('#entry-0-date').inputValue(), '2026-11-10');
  await previewIncludes(page, '11月11日(水)'); await page.locator('#entry-1-date').focus();
  assert.notEqual(await page.locator(activeRect).getAttribute('y'), firstRowY, 'Highlight follows the focused entry row');
  await download(page, '#download-pdf', 'test-results/browser-nine.pdf', 'repeatPdfMs');
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.length === 2, keys.history);
  assert.equal(await page.locator('#history-list [data-history]').count(), 2);
  assert.ok(!JSON.stringify(await page.evaluate(() => ({ ...localStorage }))).includes('試験 太郎'), 'Opted-out PII is never persisted by draft/history');
  await page.locator('#reset-form').click(); await confirm(page);
  await page.waitForFunction(() => document.querySelectorAll('.entry').length === 1);
  await page.locator('#history-list [data-history="0"]').click(); await confirm(page);
  await page.waitForFunction(() => document.querySelectorAll('.entry').length === 9);
  assert.equal(await page.locator('#profile-name').inputValue(), '試験 太郎', 'History restore preserves in-memory identity');
  await page.locator('[data-action="remove"]').last().click();
  await page.locator('#confirm-title').click();
  assert.equal(await page.locator('#confirm-dialog').isVisible(), true, 'Inside confirmation clicks must not cancel');
  await outsideDialog(page, '#confirm-dialog');
  assert.equal(await page.locator('.entry').count(), 9, 'Backdrop dismissal cancels deletion');
  await page.locator('[data-action="remove"]').last().click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.entry').count(), 9, 'Escape cancels deletion');
  await page.locator('[data-action="remove"]').last().click();
  await page.locator('#confirm-dialog [data-close="confirm-dialog"]').click();
  assert.equal(await page.locator('.entry').count(), 9, 'Close button cancels deletion');
  await page.locator('[data-action="remove"]').last().click(); await confirm(page, true);
  assert.equal(await page.locator('.entry').count(), 8); assert.equal(await page.locator('#add-entry').isDisabled(), false);
  await page.locator('#history-list [data-history="0"]').click(); await confirm(page);
  await page.reload(); await ready(page);
  assert.equal(await page.locator('.entry').count(), 9); assert.equal(await page.locator('#entry-1-people').inputValue(), '7');
  assert.equal(await page.locator('#profile-name').inputValue(), '', 'Explicit identity opt-out survives reload');
  assert.equal(await page.locator('#remember-profile').isChecked(), false);
  await openStorage(page); await page.locator('#remember-draft').uncheck();
  for (const key of [keys.history, keys.draft, keys.profile]) assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
  await page.reload(); await ready(page);
  assert.equal(await page.locator('.entry').count(), 1); assert.equal(await page.locator('#purpose').inputValue(), '');
  assert.equal(await page.locator('#remember-profile').isChecked(), false); assert.equal(await page.locator('#remember-draft').isChecked(), false);
  await setProfile(page, '保存しない 太郎', false); await page.locator('#purpose').fill('保存しない下書き');
  await page.reload(); await ready(page);
  assert.equal(await page.locator('#profile-name').inputValue(), ''); assert.equal(await page.locator('#purpose').inputValue(), '', 'Editing does not silently re-enable storage');
  await setProfile(page, '試験 太郎', true);
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.profile.name === '試験 太郎', keys.profile);
  await page.reload(); await ready(page);
  assert.equal(await page.locator('#profile-name').inputValue(), '試験 太郎');
  assert.equal(await page.locator('#remember-draft').isChecked(), false, 'Identity and draft preferences are independent');
  await page.locator('#entry-0-date').fill('2026-11-10');
  await rejectPdf(page, '非対応文字\u{10FFFF}', '表示できない文字');
  await rejectPdf(page, '長い目的'.repeat(100), '収まりません');
  await openStorage(page); await page.locator('#clear-local').click(); await confirm(page, true);
  await page.waitForFunction(key => Object.keys(localStorage).filter(key => key.startsWith('classroom.')).length === 1 && localStorage.getItem(key), keys.settings);
  stored = await page.evaluate(() => ({ ...localStorage }));
  assert.deepEqual(Object.keys(stored).filter(key => key.startsWith('classroom.')), [keys.settings]);
  assert.deepEqual(JSON.parse(stored[keys.settings]), { version: 1, rememberDraft: false, rememberProfile: false });
  for (const key of ['name', 'studentId', 'phone']) assert.equal(await page.locator(`#profile-${key}`).inputValue(), '');
  await page.reload(); await ready(page);
  assert.equal(await page.locator('#remember-profile').isChecked(), false); assert.equal(await page.locator('#remember-draft').isChecked(), false);
  assert.equal(await page.locator('#student-profile').getAttribute('data-ready'), 'false');
  await desktop.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
  const mobileRequests = observe(mobile);
  const mp = await mobile.newPage(); await mp.goto(origin); await ready(mp); await checkShell(mp);
  for (const width of [320, 360, 768, 390]) await noOverflow(mp, width);
  await mp.screenshot({ path: 'test-results/mobile-initial.png', scale: 'css' });
  await mp.screenshot({ path: 'test-results/mobile-full.png', scale: 'css', fullPage: true });
  await checkPhotos(mp); await mp.locator('#toggle-preview').click();
  assert.equal(await mp.locator('#toggle-preview').getAttribute('aria-expanded'), 'true');
  await mp.locator('#application-preview').waitFor({ state: 'visible' });
  for (const width of [320, 360, 768, 390]) await noOverflow(mp, width);
  await mp.locator('#toggle-preview').click(); await assertNoHeavy(mobileRequests);
  await mp.locator('#mobile-download').click(); await mp.locator('#error-summary').waitFor({ state: 'visible' });
  assert.equal(await mp.locator('#purpose').getAttribute('aria-invalid'), null);
  assert.equal(await mp.locator('#purpose').inputValue(), defaultPurpose);
  assert.equal(await mp.locator('#profile-name').getAttribute('aria-invalid'), 'true');
  await setProfile(mp, '試験 花子');
  await mp.locator('#purpose').fill('作品制作ミーティング'); await mp.locator('#entry-0-date').fill('2026-11-12');
  await previewIncludes(mp, '作品制作ミーティング'); await previewIncludes(mp, '11月12日(木)');
  await mp.locator('#entry-0-start').fill('18:43');
  assert.equal(await mp.locator('#entry-0-start').inputValue(), '18:43'); await previewIncludes(mp, '18:43 〜 20:00');
  await assertNoHeavy(mobileRequests);
  await mp.locator('#purpose').fill('  \n  ');
  await download(mp, '#mobile-download', 'test-results/browser-mobile.pdf', 'mobileFirstPdfMs');
  assert.equal(await mp.locator('#purpose').inputValue(), defaultPurpose, 'Whitespace-only purpose is filled before a valid PDF export');
  await previewIncludes(mp, defaultPurpose);
  assert.equal(await mp.evaluate(key => JSON.parse(localStorage.getItem(key))[0].data.purpose, keys.history), defaultPurpose, 'The exported/history state uses the same default purpose as the input');
  await mp.locator('#purpose').fill('作品制作ミーティング');
  for (let index = 1; index < 9; index++) await mp.locator('[data-action="duplicate"]').last().click();
  await checkCards(mp, 9); assert.equal(await mp.locator('#mobile-count').textContent(), '9/9'); assert.equal(await mp.locator('#add-entry').isDisabled(), true);
  for (const width of [320, 360, 768, 390]) await noOverflow(mp, width);
  await download(mp, '#mobile-download', 'test-results/browser-mobile-nine.pdf', 'mobileRepeatPdfMs');
  await mp.reload(); await ready(mp);
  assert.equal(await mp.locator('.entry').count(), 9); assert.equal(await mp.locator('#profile-name').inputValue(), '試験 花子');
  assert.equal(await mp.locator('#entry-0-start').inputValue(), '18:43');
  await noSpotlight(mp); await mobile.close();
  const requestBase = origin.endsWith('/') ? origin : `${origin}/`;
  assert.ok(allRequests.every(url => url.startsWith(requestBase) || url.startsWith('blob:') || url.startsWith('data:')), 'No external network requests');
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('\n')}`);
  await writeFile('test-results/browser-report.json', JSON.stringify({ passed: true, metrics, errors }, null, 2));
  console.log('Browser integration tests passed:', JSON.stringify(metrics));
} finally { await browser.close(); }
