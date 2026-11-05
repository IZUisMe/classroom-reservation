const $ = id => document.getElementById(id);
let bootstrap;
let queue = [];
let processing = false;
let uploading = false;
let saving = false;
let checkingPublish = true;
let publishAvailable = false;
let publishJob = null;
let publishTimer;
let disposed = false;
let dragId = null;
const galleryMessages = new Map();
const busy = () => processing || uploading || saving || checkingPublish || publishJob?.state === 'running';
const currentRoom = () => bootstrap?.rooms.find(room => room.id === $('room').value);
const photoId = photo => String(photo.id || photo.sourceId || '');
const safePhoto = photo => /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(photoId(photo)) && photo.url === `/photos/${photoId(photo)}`;
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
async function api(path, { method = 'GET', payload } = {}) {
  const response = await fetch(path, { method, cache: 'no-store', headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap?.csrfToken || '' }, body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}) });
  const data = await response.json();
  if (!response.ok) { const failure = new Error(data.error || '操作に失敗しました。'); failure.status = response.status; failure.data = data; throw failure; }
  return data;
}
const MAX_QUEUE = 30;
const INPUT_BYTES = 20 * 1024 * 1024;
const INPUT_PIXELS = 40_000_000;
const INPUT_DIMENSION = 16384;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_WIDTH = 1440;
const MAX_HEIGHT = 1080;
const ascii = (bytes, start, end) => String.fromCharCode(...bytes.slice(start, end));
const bytesLabel = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
function error(message) {
  $('file-errors').hidden = false;
  const p = document.createElement('p'); p.textContent = message; $('file-errors').append(p);
}
function checkDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > INPUT_DIMENSION || height > INPUT_DIMENSION || width * height > INPUT_PIXELS) throw new Error('画像は4000万画素・一辺16384px以内にしてください。');
}
function originalDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG' && ascii(bytes, 12, 16) === 'IHDR') return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 20 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = ascii(bytes, offset, offset + 4); const size = view.getUint32(offset + 4, true); const start = offset + 8;
      if (type === 'VP8X' && size >= 10 && start + 10 <= bytes.length) return { width: 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16), height: 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16) };
      if (type === 'VP8 ' && size >= 10 && start + 10 <= bytes.length) return { width: view.getUint16(start + 6, true) & 0x3fff, height: view.getUint16(start + 8, true) & 0x3fff };
      if (type === 'VP8L' && size >= 5 && start + 5 <= bytes.length && bytes[start] === 0x2f) { const bits = view.getUint32(start + 1, true); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
      offset = start + size + (size & 1);
    }
    throw new Error('WebP画像の寸法を読み取れません。');
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error('JPEG画像の形式が正しくありません。');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && offset + 7 <= bytes.length) return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      offset += length;
    }
    throw new Error('JPEG画像の寸法を読み取れません。別の画像に変換してください。');
  }
  throw new Error('JPG・PNG・WebPの写真を選択してください。');
}
async function stripWebPMetadata(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP') throw new Error('WebP変換に失敗しました。');
  const chunks = []; let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, offset + 4);
    const length = view.getUint32(offset + 4, true);
    const end = offset + 8 + length + (length & 1);
    if (end > bytes.length) throw new Error('WebP変換に失敗しました。');
    if (!['ICCP', 'EXIF', 'XMP '].includes(type)) {
      const chunk = bytes.slice(offset, end);
      if (type === 'VP8X' && length === 10) chunk[8] &= ~0x2c;
      chunks.push(chunk);
    }
    offset = end;
  }
  if (offset !== bytes.length) throw new Error('WebP変換に失敗しました。');
  const output = new Uint8Array(12 + chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  output.set(bytes.slice(0, 12)); new DataView(output.buffer).setUint32(4, output.length - 8, true);
  let position = 12; for (const chunk of chunks) { output.set(chunk, position); position += chunk.length; }
  return new Blob([output], { type: 'image/webp' });
}
async function compress(file) {
  if (!file.size || file.size > INPUT_BYTES) throw new Error('元画像は1枚20MB以内にしてください。');
  const header = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
  const original = originalDimensions(header);
  checkDimensions(original.width, original.height);
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('画像を開けませんでした。JPG・PNG・WebPに変換してください。'); }
  try {
    checkDimensions(bitmap.width, bitmap.height);
    const scale = Math.min(1, MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('画像の変換機能を利用できません。Chromeで開いてください。');
    context.drawImage(bitmap, 0, 0, width, height);
    const encoded = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.82));
    canvas.width = canvas.height = 1;
    if (!encoded || encoded.type !== 'image/webp') throw new Error('WebP変換に対応したChromeで開いてください。');
    // Chrome may add an ICC profile even to a canvas result; remove every
    // metadata chunk explicitly before sending the strict still-image payload.
    const blob = await stripWebPMetadata(encoded);
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('圧縮後の画像が4MBを超えています。元画像を小さくしてください。');
    return { blob, width, height };
  } finally { bitmap.close(); }
}
function updateControls() {
  const locked = busy();
  const ready = queue.filter(item => !item.uploaded && !item.failed);
  $('add').disabled = locked || !ready.length || !$('room').value;
  $('add').textContent = uploading ? '追加中…' : processing ? '変換中…' : '追加';
  $('queue-count').textContent = processing ? '写真を変換しています…' : `${ready.length}枚を追加`;
  $('room').disabled = locked; $('default-kind').disabled = locked; $('files').disabled = locked;
  $('dropzone').setAttribute('aria-disabled', String(locked));
  $('publish').disabled = locked || !bootstrap || !publishAvailable;
  $('publish').textContent = publishJob?.state === 'running' ? '公開中…' : '公開サイトへ反映';
  $('queue').querySelectorAll('select').forEach(select => select.disabled = locked || select.dataset.uploaded === 'true');
  $('queue').querySelectorAll('button').forEach(button => button.disabled = locked);
  document.querySelectorAll('#gallery button, #deleted-gallery button').forEach(button => button.disabled = locked || button.dataset.edge === 'true');
  $('gallery').querySelectorAll('.gallery-photo').forEach(card => card.draggable = !locked);
  const room = currentRoom();
  const photos = Array.isArray(room?.photos) ? room.photos : [];
  $('room-info').textContent = room ? `${room.displayName || room.name} ／ 公開 ${photos.length ? photos.filter(photo => !photo.hidden).length : room.photoCount || 0}枚${photos.some(photo => photo.hidden) ? ` ／ 削除済み ${photos.filter(photo => photo.hidden).length}枚` : ''}` : '';
}
function renderQueue() {
  $('queue').replaceChildren();
  for (const item of queue) {
    const card = node('article', 'photo');
    const image = node('img'); image.src = item.url; image.alt = item.name;
    const body = node('div', 'photo-body');
    const name = node('p', 'filename', item.name);
    const meta = node('p', 'photo-meta', `${item.width}×${item.height} ／ ${bytesLabel(item.blob.size)}`);
    const kind = node('select'); kind.setAttribute('aria-label', `${item.name}の種類`); kind.dataset.uploaded = String(item.uploaded);
    for (const [value, label] of [['interior','室内'],['exterior','外観']]) kind.append(new Option(label, value));
    kind.value = item.kind; kind.addEventListener('change', () => { item.kind = kind.value; });
    const foot = node('div', 'photo-foot');
    const status = node('span', 'photo-status', item.uploaded ? '追加済み' : item.failed ? '追加失敗' : '準備完了');
    const remove = node('button', 'remove', '一覧から外す'); remove.type = 'button'; remove.title = 'この追加待ち一覧からのみ外します。登録済み写真は削除しません。';
    remove.addEventListener('click', () => { if (busy()) return; URL.revokeObjectURL(item.url); queue = queue.filter(candidate => candidate !== item); renderQueue(); });
    foot.append(status, remove); body.append(name, meta, kind, foot); card.append(image, body); $('queue').append(card);
  }
  updateControls();
}
function galleryMessage(message, failed = false) {
  const room = currentRoom();
  if (room) galleryMessages.set(room.id, { message, failed });
  $('gallery-status').textContent = message;
  $('gallery-status').classList.toggle('failed', failed);
}
function columns() { return Math.max(1, getComputedStyle($('gallery')).gridTemplateColumns.split(/\s+/).filter(Boolean).length); }
function renderGallery() {
  const room = currentRoom();
  $('gallery-panel').hidden = !room;
  $('gallery').replaceChildren(); $('deleted-gallery').replaceChildren();
  if (!room) { updateControls(); return; }
  const photos = Array.isArray(room.photos) ? room.photos : [];
  const visible = photos.filter(photo => !photo.hidden);
  const hidden = photos.filter(photo => photo.hidden);
  $('gallery-count').textContent = `${visible.length}枚`;
  $('deleted-count').textContent = String(hidden.length);
  if (!visible.length) $('gallery').append(node('p', 'empty-gallery', '登録写真はありません。'));
  if (!hidden.length) $('deleted-gallery').append(node('p', 'empty-gallery', '削除済みの写真はありません。'));
  for (const [list, deleted] of [[visible, false], [hidden, true]]) list.forEach((photo, index) => {
    const id = photoId(photo);
    const card = node('article', 'gallery-photo'); card.dataset.photoId = id;
    const image = node('img'); image.alt = `${room.name}の写真 ${index + 1}`; image.loading = 'lazy'; image.draggable = false;
    if (safePhoto(photo)) image.src = photo.url;
    else { image.hidden = true; card.append(node('p', 'hint', '画像を表示できません。')); }
    const body = node('div', 'gallery-body');
    body.append(node('p', 'gallery-number', deleted ? '削除済み' : `${index + 1}枚目`));
    body.append(node('p', 'gallery-source', `${photo.source || '教室資料'}${photo.page ? ` p.${photo.page}` : ''} ／ ${photo.kind === 'exterior' ? '外観' : '室内'}`));
    if (deleted) {
      const restore = node('button', 'restore-gallery', '公開ギャラリーへ復元'); restore.type = 'button'; restore.dataset.restoreId = id;
      restore.addEventListener('click', () => changeHidden(id, false)); body.append(restore);
    } else {
      const controls = node('div', 'gallery-controls');
      for (const [direction, symbol, label] of [['left','←','左'],['right','→','右'],['up','↑','上'],['down','↓','下']]) {
        const move = node('button', '', symbol); move.type = 'button'; move.dataset.move = direction; move.dataset.photoId = id;
        move.setAttribute('aria-label', `${index + 1}枚目を${label}へ移動`); move.addEventListener('click', () => movePhoto(id, direction)); controls.append(move);
      }
      const remove = node('button', 'delete-gallery', '公開ギャラリーから削除'); remove.type = 'button'; remove.dataset.deleteId = id;
      remove.addEventListener('click', async () => {
        if (busy() || !await confirmAction({ title: '公開ギャラリーから削除', message: 'この写真を公開ギャラリーから非表示にします。\n画像ファイル・原本は残り、「削除済み」から復元できます。', label: '削除', destructive: true })) return;
        await changeHidden(id, true);
      });
      body.append(controls, remove);
      card.addEventListener('dragstart', event => { if (busy()) { event.preventDefault(); return; } dragId = id; event.dataTransfer.setData('text/plain', id); event.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
      card.addEventListener('dragover', event => { if (!busy() && dragId && dragId !== id) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; card.classList.add('drop-target'); } });
      card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
      card.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); card.classList.remove('drop-target'); const source = dragId; dragId = null; if (source && source !== id && !busy()) movePhotoTo(source, id); });
      card.addEventListener('dragend', () => { dragId = null; document.querySelectorAll('.gallery-photo').forEach(item => item.classList.remove('dragging', 'drop-target')); });
    }
    card.append(image, body); (deleted ? $('deleted-gallery') : $('gallery')).append(card);
  });
  const status = galleryMessages.get(room.id);
  $('gallery-status').textContent = status?.message || '';
  $('gallery-status').classList.toggle('failed', !!status?.failed);
  updateMoveEdges(); updateControls();
}
function updateMoveEdges() {
  const count = currentRoom()?.photos?.filter(photo => !photo.hidden).length || 0;
  const width = columns();
  $('gallery').querySelectorAll('.gallery-photo').forEach((card, index) => {
    for (const button of card.querySelectorAll('[data-move]')) {
      const target = index + ({ left: -1, right: 1, up: -width, down: width }[button.dataset.move]);
      button.dataset.edge = String(target < 0 || target >= count);
      button.disabled = busy() || button.dataset.edge === 'true';
    }
  });
}
async function saveGallery(order, hidden, focusId, focusMove) {
  const room = currentRoom();
  if (!room || busy()) return;
  saving = true; galleryMessage('保存中…'); updateControls();
  try {
    const result = await api('/api/gallery', { method: 'POST', payload: { roomId: room.id, order, hidden, revision: room.revision } });
    if (!result.room || result.room.id !== room.id) throw new Error('保存結果を確認できませんでした。');
    const position = bootstrap.rooms.findIndex(item => item.id === room.id);
    bootstrap.rooms[position] = result.room;
    galleryMessages.set(room.id, { message: '保存済み・公開待ち', failed: false });
  } catch (failure) {
    try { await refresh(); } catch { /* Keep the last known local view if reconnection also fails. */ }
    galleryMessage(failure.status === 409 ? '別の画面で更新されました。最新の一覧を表示しました。もう一度操作してください。' : `${failure.message} 最新の一覧を確認してから操作してください。`, true);
  } finally {
    saving = false; renderGallery();
    if (focusId) {
      const card = $('gallery').querySelector(`[data-photo-id="${CSS.escape(focusId)}"]`);
      const preferred = focusMove && card?.querySelector(`[data-move="${focusMove}"]:not(:disabled)`);
      (preferred || card?.querySelector('button:not(:disabled)'))?.focus();
    }
  }
}
function reordered(visibleIds) {
  let index = 0;
  return currentRoom().photos.map(photo => photo.hidden ? photoId(photo) : visibleIds[index++]);
}
async function movePhoto(id, direction) {
  if (busy()) return;
  const visible = currentRoom()?.photos?.filter(photo => !photo.hidden).map(photoId) || [];
  const index = visible.indexOf(id);
  const target = index + ({ left: -1, right: 1, up: -columns(), down: columns() }[direction]);
  if (index < 0 || target < 0 || target >= visible.length) return;
  visible.splice(index, 1); visible.splice(target, 0, id);
  await saveGallery(reordered(visible), currentRoom().photos.filter(photo => photo.hidden).map(photoId), id, direction);
}
async function movePhotoTo(id, targetId) {
  if (busy()) return;
  const visible = currentRoom()?.photos?.filter(photo => !photo.hidden).map(photoId) || [];
  const index = visible.indexOf(id); const target = visible.indexOf(targetId);
  if (index < 0 || target < 0) return;
  visible.splice(index, 1); visible.splice(target, 0, id);
  await saveGallery(reordered(visible), currentRoom().photos.filter(photo => photo.hidden).map(photoId), id);
}
async function changeHidden(id, hidden) {
  if (busy()) return;
  const room = currentRoom(); if (!room?.photos?.some(photo => photoId(photo) === id)) return;
  const removed = new Set(room.photos.filter(photo => photo.hidden).map(photoId));
  if (hidden) removed.add(id); else removed.delete(id);
  await saveGallery(room.photos.map(photoId), [...removed], hidden ? null : id);
}
function confirmAction({ title, message, label, destructive = false }) {
  const dialog = $('confirm-dialog');
  if (dialog.open) return Promise.resolve(false);
  $('confirm-title').textContent = title; $('confirm-message').textContent = message;
  $('confirm-action').textContent = label; $('confirm-action').classList.toggle('destructive', destructive);
  dialog.returnValue = 'cancel';
  return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.showModal(); });
}
async function addFiles(files) {
  if (busy()) return;
  $('file-errors').replaceChildren(); $('file-errors').hidden = true;
  const selected = [...files];
  if (queue.length + selected.length > MAX_QUEUE) { error('一度に選択できる写真は30枚までです。一覧を整理してから追加してください。'); return; }
  processing = true; updateControls();
  for (const file of selected) {
    try { const result = await compress(file); queue.push({ ...result, name: file.name, kind: $('default-kind').value, url: URL.createObjectURL(result.blob), uploaded: false, failed: false }); }
    catch (failure) { error(`${file.name}：${failure.message}`); }
  }
  processing = false; renderQueue(); $('files').value = '';
}
async function dataUrl(blob) {
  return new Promise((accept, reject) => { const reader = new FileReader(); reader.onload = () => accept(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('写真を読み込めませんでした。')); reader.readAsDataURL(blob); });
}
async function refresh() {
  const data = await api('/api/bootstrap');
  if (!Array.isArray(data.rooms)) throw new Error('教室データの形式が正しくありません。');
  bootstrap = data;
  const selected = $('room').value;
  $('room').replaceChildren(new Option('選択してください', ''));
  for (const room of data.rooms) $('room').append(new Option(room.displayName || room.name, room.id));
  $('room').value = selected;
  renderGallery(); updateControls();
}
function displayPublish(job) {
  const previousState = publishJob?.state;
  publishJob = job || { state: 'idle', logs: '' };
  const state = publishJob.state;
  $('publish-status').textContent = state === 'running' ? publishJob.phase || '公開処理中…' : state === 'success' ? '公開済み' : state === 'failed' ? '公開に失敗しました。ログを確認してください。' : '保存した内容を公開できます。';
  $('publish-status').className = state === 'success' ? 'success' : state === 'failed' ? 'failed' : '';
  const logs = typeof publishJob.logs === 'string' ? publishJob.logs : '';
  const old = $('publish-logs'); const atBottom = old.scrollTop + old.clientHeight >= old.scrollHeight - 40;
  old.textContent = logs; if (atBottom) old.scrollTop = old.scrollHeight;
  $('publish-log-details').hidden = !logs;
  const safeSite = publishJob.site === 'https://izuisme.github.io/classroom-reservation/';
  $('published-site').hidden = state !== 'success' || !safeSite;
  if (state === 'success' && previousState === 'running') {
    for (const room of bootstrap?.rooms || []) galleryMessages.set(room.id, { message: '公開済み', failed: false });
    renderGallery();
  }
  updateControls();
}
async function checkPublish() {
  clearTimeout(publishTimer);
  if (disposed) return;
  try {
    const result = await api('/api/publish');
    publishAvailable = true;
    $('publish-error').hidden = true; $('publish-refresh').hidden = true;
    displayPublish(result.job);
  } catch (failure) {
    $('publish-error').textContent = `公開状態を確認できませんでした。${failure.message}`; $('publish-error').hidden = false; $('publish-refresh').hidden = false;
  } finally { checkingPublish = false; updateControls(); }
  if (publishJob?.state === 'running' && !disposed) publishTimer = setTimeout(checkPublish, 1500);
}
$('publish').addEventListener('click', async () => {
  if (busy() || !publishAvailable || !await confirmAction({ title: '公開サイトへ反映', message: '現在保存されている写真の並び順・削除・追加を公開します。\n追加待ちの写真は含まれません。', label: '公開する' })) return;
  checkingPublish = true; updateControls(); $('publish-error').hidden = true;
  try {
    const result = await api('/api/publish', { method: 'POST', payload: {} });
    publishAvailable = true; displayPublish(result.job);
  } catch (failure) {
    $('publish-error').textContent = failure.status === 409 ? '別の公開処理・更新が進行中です。最新状態を確認してから、もう一度操作してください。' : failure.message;
    $('publish-error').hidden = false;
    try { const result = await api('/api/publish'); displayPublish(result.job); } catch { $('publish-refresh').hidden = false; }
  } finally { checkingPublish = false; updateControls(); }
  if (publishJob?.state === 'running') publishTimer = setTimeout(checkPublish, 1500);
});
$('publish-refresh').addEventListener('click', () => { checkingPublish = true; updateControls(); checkPublish(); });
$('confirm-close').addEventListener('click', () => $('confirm-dialog').close('cancel'));
{
  const dialog = $('confirm-dialog'); let outsideDown = false;
  const outside = event => { const box = dialog.getBoundingClientRect(); return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom; };
  dialog.addEventListener('pointerdown', event => { outsideDown = event.target === dialog && outside(event); });
  dialog.addEventListener('pointerup', event => { if (outsideDown && event.target === dialog && outside(event)) dialog.close('cancel'); outsideDown = false; });
  dialog.addEventListener('pointercancel', () => outsideDown = false);
}
$('files').addEventListener('change', event => addFiles(event.target.files));
$('room').addEventListener('change', renderGallery);
for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, event => { event.preventDefault(); if (!busy()) $('dropzone').classList.add('dragging'); });
$('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragging'));
$('dropzone').addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('dragging'); addFiles(event.dataTransfer.files); });
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  const pending = queue.filter(item => !item.uploaded && !item.failed);
  if (busy() || !pending.length || !$('room').value) return;
  uploading = true; renderQueue();
  $('results-panel').hidden = false; $('results').replaceChildren(); $('result-summary').textContent = '追加しています…';
  const roomId = $('room').value; let success = 0; let failed = 0;
  for (const item of pending) {
    const result = node('li');
    try {
      await api('/api/photos', { method: 'POST', payload: { roomId, kind: item.kind, image: { data: await dataUrl(item.blob), width: item.width, height: item.height } } });
      item.uploaded = true; success++; result.className = 'success'; result.textContent = `${item.name}：追加しました`;
    } catch (failure) { item.failed = true; failed++; result.className = 'failed'; result.textContent = `${item.name}：${failure.message}`; }
    $('results').append(result);
  }
  $('result-summary').textContent = `${success}枚追加${failed ? ` ／ ${failed}枚失敗` : ''}`;
  if (success) galleryMessages.set(roomId, { message: '保存済み・公開待ち', failed: false });
  uploading = false; renderQueue();
  try { await refresh(); } catch (failure) { error(failure.message); }
});
new ResizeObserver(updateMoveEdges).observe($('gallery'));
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(publishTimer); queue.forEach(item => URL.revokeObjectURL(item.url)); });
window.addEventListener('pageshow', event => { if (event.persisted) { disposed = false; checkingPublish = true; updateControls(); checkPublish(); } });
try { await refresh(); $('connection').hidden = true; $('upload-form').hidden = false; await checkPublish(); }
catch (failure) { checkingPublish = false; $('connection').textContent = `${failure.message} 管理画面を起動し直してください。`; $('connection').className = 'errors'; updateControls(); }
