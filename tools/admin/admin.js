const $ = id => document.getElementById(id);
let bootstrap;
let queue = [];
let processing = false;
let uploading = false;
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
  const ready = queue.filter(item => !item.uploaded && !item.failed);
  $('add').disabled = processing || uploading || !ready.length || !$('room').value;
  $('add').textContent = uploading ? '追加中…' : processing ? '変換中…' : '追加';
  $('queue-count').textContent = processing ? '写真を変換しています…' : `${ready.length}枚を追加`;
  $('room').disabled = uploading; $('default-kind').disabled = uploading; $('files').disabled = uploading || processing;
  const room = bootstrap?.rooms.find(room => room.id === $('room').value);
  $('room-info').textContent = room ? `${room.displayName} ／ 登録済み ${room.photoCount}枚` : '';
}
function renderQueue() {
  $('queue').replaceChildren();
  for (const item of queue) {
    const card = document.createElement('article'); card.className = 'photo';
    const image = document.createElement('img'); image.src = item.url; image.alt = item.name;
    const body = document.createElement('div'); body.className = 'photo-body';
    const name = document.createElement('p'); name.className = 'filename'; name.textContent = item.name;
    const meta = document.createElement('p'); meta.className = 'photo-meta'; meta.textContent = `${item.width}×${item.height} ／ ${bytesLabel(item.blob.size)}`;
    const kind = document.createElement('select'); kind.setAttribute('aria-label', `${item.name}の種類`);
    for (const [value, label] of [['interior','室内'],['exterior','外観']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; kind.append(option); }
    kind.value = item.kind; kind.disabled = uploading || item.uploaded;
    kind.addEventListener('change', () => { item.kind = kind.value; });
    const foot = document.createElement('div'); foot.className = 'photo-foot';
    const status = document.createElement('span'); status.className = 'photo-status'; status.textContent = item.uploaded ? '追加済み' : item.failed ? '追加失敗' : '準備完了';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove'; remove.textContent = '一覧から外す'; remove.disabled = uploading;
    remove.addEventListener('click', () => { URL.revokeObjectURL(item.url); queue = queue.filter(candidate => candidate !== item); renderQueue(); });
    foot.append(status, remove); body.append(name, meta, kind, foot); card.append(image, body); $('queue').append(card);
  }
  updateControls();
}
async function addFiles(files) {
  if (processing || uploading) return;
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
  const response = await fetch('/api/bootstrap', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '管理用データを読み込めませんでした。');
  bootstrap = data;
  const selected = $('room').value;
  $('room').replaceChildren(new Option('選択してください', ''));
  for (const room of data.rooms) $('room').append(new Option(room.displayName || room.name, room.id));
  $('room').value = selected;
  updateControls();
}
$('files').addEventListener('change', event => addFiles(event.target.files));
$('room').addEventListener('change', updateControls);
for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, event => { event.preventDefault(); if (!uploading && !processing) $('dropzone').classList.add('dragging'); });
$('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragging'));
$('dropzone').addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('dragging'); addFiles(event.dataTransfer.files); });
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  const pending = queue.filter(item => !item.uploaded && !item.failed);
  if (uploading || processing || !pending.length || !$('room').value) return;
  uploading = true; renderQueue();
  $('results-panel').hidden = false; $('results').replaceChildren(); $('result-summary').textContent = '追加しています…';
  const roomId = $('room').value; let success = 0; let failed = 0;
  for (const item of pending) {
    const result = document.createElement('li');
    try {
      const response = await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap.csrfToken }, body: JSON.stringify({ roomId, kind: item.kind, image: { data: await dataUrl(item.blob), width: item.width, height: item.height } }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '追加できませんでした。');
      item.uploaded = true; success++; result.className = 'success'; result.textContent = `${item.name}：追加しました`;
    } catch (failure) { item.failed = true; failed++; result.className = 'failed'; result.textContent = `${item.name}：${failure.message}`; }
    $('results').append(result);
  }
  $('result-summary').textContent = `${success}枚追加${failed ? ` ／ ${failed}枚失敗` : ''}`;
  uploading = false; renderQueue();
  try { await refresh(); } catch (failure) { error(failure.message); }
});
window.addEventListener('pagehide', () => queue.forEach(item => URL.revokeObjectURL(item.url)));
try { await refresh(); $('connection').hidden = true; $('upload-form').hidden = false; }
catch (failure) { $('connection').textContent = `${failure.message} 管理画面を起動し直してください。`; $('connection').className = 'errors'; }
