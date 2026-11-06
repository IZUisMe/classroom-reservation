import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink, mkdir, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { applyGalleryEdits, emptyPhotoEdits, galleryRoomState, validateGalleryUpdate, photoFilePath, GalleryError } from './photo_gallery_edits.mjs';

export const ADMIN_LIMITS = Object.freeze({ maxFileBytes: 4 * 1024 * 1024, maxBodyBytes: 6 * 1024 * 1024, maxWidth: 1440, maxHeight: 1080, maxPixels: 1440 * 1080 });
const ADMIN_ID = /^admin-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const adminPhoto = photo => typeof photo?.sourceId === 'string' && photo.sourceId.startsWith('admin-');
const clone = value => structuredClone(value);
export class AdminError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

/** Parse still WebP headers, reject metadata/animation, and enforce canvas bounds. */
export function inspectWebP(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 20 || bytes.length > ADMIN_LIMITS.maxFileBytes) throw new AdminError('WebP画像は4MB以内にしてください。');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new AdminError('WebP画像の形式が正しくありません。');
  let offset = 12;
  let extended;
  let dimensions;
  let imageChunks = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new AdminError('WebP画像が途中で切れています。');
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length || end + (length & 1) > bytes.length) throw new AdminError('WebP画像のチャンクが不正です。');
    if (type === 'VP8X') {
      if (length !== 10 || extended || bytes[start] & 0x2e) throw new AdminError('アニメーション・メタデータ付きの画像は使用できません。');
      extended = { width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1 };
    } else if (type === 'VP8 ') {
      if (length < 10 || (bytes[start] & 1) || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) throw new AdminError('WebP画像の本体が不正です。');
      dimensions = { width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff }; imageChunks++;
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[start] !== 0x2f) throw new AdminError('WebP画像の本体が不正です。');
      const bits = bytes.readUInt32LE(start + 1);
      if (bits >>> 29) throw new AdminError('未対応のWebP形式です。');
      dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; imageChunks++;
    } else if (type !== 'ALPH') throw new AdminError('メタデータ等を含まないWebP画像に変換してください。');
    offset = end + (length & 1);
  }
  if (offset !== bytes.length || imageChunks !== 1 || !dimensions) throw new AdminError('静止WebP画像を指定してください。');
  if (extended && (extended.width !== dimensions.width || extended.height !== dimensions.height)) throw new AdminError('WebP画像の寸法が一致しません。');
  const { width, height } = dimensions;
  if (!width || !height || width > ADMIN_LIMITS.maxWidth || height > ADMIN_LIMITS.maxHeight || width * height > ADMIN_LIMITS.maxPixels) throw new AdminError('画像は最大1440×1080以内にしてください。');
  return dimensions;
}

export function validateManifest(manifest, rooms) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.photos)) throw new AdminError('管理写真台帳の形式が不正です。', 500);
  const roomIds = new Set(rooms.map(room => room.id));
  const ids = new Set();
  return { schemaVersion: 1, photos: manifest.photos.map(photo => {
    if (!photo || !ADMIN_ID.test(photo.id) || ids.has(photo.id) || !roomIds.has(photo.roomId) || !['interior', 'exterior'].includes(photo.kind) || photo.src !== `images/rooms/${photo.id}.webp` || photo.source !== '管理者追加' || !/^[a-f0-9]{64}$/.test(photo.sha256) || !Number.isInteger(photo.bytes) || photo.bytes < 20 || photo.bytes > ADMIN_LIMITS.maxFileBytes || !Number.isInteger(photo.width) || !Number.isInteger(photo.height) || photo.width < 1 || photo.height < 1 || photo.width > 1440 || photo.height > 1080 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(photo.addedAt) || !Number.isFinite(Date.parse(photo.addedAt))) throw new AdminError('管理写真台帳に不正な項目があります。', 500);
    ids.add(photo.id);
    return Object.fromEntries(['id', 'roomId', 'src', 'kind', 'source', 'width', 'height', 'sha256', 'bytes', 'addedAt'].map(key => [key, photo[key]]));
  }) };
}

/** Pure, repeatable merge. Original-source missing records remain as history. */
export function applyAdminPhotos({ rooms, sources, manifest, edits = emptyPhotoEdits() }) {
  if (!Array.isArray(rooms) || !Array.isArray(sources?.photos)) throw new AdminError('教室・写真データの形式が不正です。', 500);
  const resultRooms = clone(rooms);
  const resultSources = clone(sources);
  const cleanManifest = validateManifest(manifest, resultRooms);
  for (const room of resultRooms) {
    room.gallery = (room.gallery || []).filter(photo => !adminPhoto(photo));
    room.images ||= { interior: null, exterior: null };
    room.photoStatus ||= {};
    for (const kind of ['interior', 'exterior']) {
      if (adminPhoto(room.images[kind])) {
        const original = room.gallery.find(photo => photo.kind === kind);
        room.images[kind] = original ? { src: original.src, source: original.source, ...(original.page ? { page: original.page } : {}), sourceId: original.sourceId } : null;
      }
    }
  }
  resultSources.photos = resultSources.photos.filter(photo => photo.sourceType !== 'admin' && !String(photo.id || '').startsWith('admin-'));
  for (const photo of cleanManifest.photos) {
    const room = resultRooms.find(room => room.id === photo.roomId);
    const image = { src: photo.src, kind: photo.kind, source: photo.source, sourceId: photo.id, width: photo.width, height: photo.height };
    room.gallery.push(image);
    if (!room.images[photo.kind]) room.images[photo.kind] = { src: photo.src, source: photo.source, sourceId: photo.id };
    resultSources.photos.push({ id: photo.id, roomId: photo.roomId, roomName: room.name, kind: photo.kind, status: 'available', sourceType: 'admin', source: photo.source, addedAt: photo.addedAt, webp: { src: photo.src, sha256: photo.sha256, bytes: photo.bytes, width: photo.width, height: photo.height } });
  }
  for (const room of resultRooms) for (const kind of ['interior', 'exterior']) room.photoStatus[kind] = room.images[kind] ? 'available' : 'missing';
  const available = new Map(resultSources.photos.filter(photo => photo.status === 'available' && photo.webp).map(photo => [photo.webp.src, photo.webp]));
  resultSources.summary ||= {};
  Object.assign(resultSources.summary, {
    roomCount: resultRooms.length,
    adminPhotographs: cleanManifest.photos.length,
    galleryPhotoCount: resultRooms.reduce((sum, room) => sum + room.gallery.length, 0),
    webpCount: available.size,
    webpBytes: [...available.values()].reduce((sum, photo) => sum + photo.bytes, 0),
    interiorAvailable: resultRooms.filter(room => !!room.images.interior).length,
    interiorMissing: resultRooms.filter(room => !room.images.interior).map(room => room.id),
    exteriorAvailable: resultRooms.filter(room => !!room.images.exterior).length,
  });
  const overlaid = applyGalleryEdits({ rooms: resultRooms, sources: resultSources, edits });
  return { ...overlaid, manifest: cleanManifest };
}

const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const optionalRead = async file => { try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
async function atomicWrite(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { flag: 'wx' });
  try { await rename(temp, file); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
function paths(root) {
  const projectRoot = resolve(root);
  return { projectRoot, state: resolve(projectRoot, 'tools/admin/.state'), data: resolve(projectRoot, 'public/data'), images: resolve(projectRoot, 'public/images/rooms') };
}
async function lockStore(store) {
  await mkdir(store.state, { recursive: true });
  const lockPath = resolve(store.state, 'write.lock');
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await open(lockPath, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try { const lock = JSON.parse(await readFile(lockPath, 'utf8')); try { process.kill(lock.pid, 0); } catch (check) { stale = check.code === 'ESRCH'; } } catch { /* Do not delete a lock of unknown ownership. */ }
      if (!stale) throw new AdminError('写真データを別の処理が更新中です。少し待ってから再試行してください。', 409);
      await unlink(lockPath);
    }
  }
  if (!handle) throw new AdminError('写真データのロックを取得できません。', 409);
  await handle.writeFile(JSON.stringify({ pid: process.pid }));
  return async () => { await handle.close(); await unlink(lockPath).catch(() => {}); };
}
const DATA_FILES = ['rooms.json', 'photo-sources.json', 'admin-photos.json', 'photo-edits.json'];
async function recoverLocked(store) {
  const journalPath = resolve(store.state, 'transaction.json');
  const raw = await optionalRead(journalPath);
  if (!raw) return false;
  const journal = JSON.parse(raw);
  const legacy = journal.version === 1;
  const count = legacy ? 3 : 4;
  if ((!legacy && ![2, 3].includes(journal.version)) || !Array.isArray(journal.before) || journal.before.length !== count || !(ADMIN_ID.test(journal.imageId) || (!legacy && journal.imageId === null)) || journal.before.some(value => value !== null && (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value))) throw new AdminError('回復用記録が不正です。管理用サーバーを停止して確認してください。', 500);
  if (journal.version === 3) {
    if (!Array.isArray(journal.removed) || journal.removed.some(photo => !/^images\/rooms\/[A-Za-z0-9-]+\.webp$/.test(photo.src) || typeof photo.bytes !== 'string' || Buffer.from(photo.bytes, 'base64').toString('base64') !== photo.bytes)) throw new AdminError('画像の回復用記録が不正です。', 500);
    for (const photo of journal.removed) await atomicWrite(resolve(store.projectRoot, 'public', photo.src), Buffer.from(photo.bytes, 'base64'));
  }
  for (let i = 0; i < count; i++) {
    const file = resolve(store.data, DATA_FILES[i]);
    if (journal.before[i] === null) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    else await atomicWrite(file, Buffer.from(journal.before[i], 'base64'));
  }
  if (journal.imageId) await unlink(resolve(store.images, `${journal.imageId}.webp`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await unlink(journalPath);
  return true;
}
export async function recoverAdminPhotoTransaction(projectRoot) {
  const store = paths(projectRoot);
  const release = await lockStore(store);
  try { return await recoverLocked(store); } finally { await release(); }
}
async function mutateStore(projectRoot, mutate, hooks = {}) {
  const store = paths(projectRoot);
  const release = await lockStore(store);
  let journalWritten = false;
  try {
    await recoverLocked(store);
    const before = await Promise.all(DATA_FILES.map(name => optionalRead(resolve(store.data, name))));
    if (!before[0] || !before[1]) throw new AdminError('教室・写真データが見つかりません。', 500);
    const state = { rooms: JSON.parse(before[0].toString('utf8')), sources: JSON.parse(before[1].toString('utf8')), manifest: before[2] ? JSON.parse(before[2].toString('utf8')) : { schemaVersion: 1, photos: [] }, edits: before[3] ? JSON.parse(before[3].toString('utf8')) : emptyPhotoEdits() };
    const { merged, image, result, removed = [] } = await mutate(state);
    const backups = await Promise.all(removed.map(async record => ({ src: record.webp.src, bytes: (await readFile(photoFilePath(projectRoot, record))).toString('base64') })));
    const journalPath = resolve(store.state, 'transaction.json');
    await atomicWrite(journalPath, jsonBytes({ version: 3, imageId: image?.id || null, removed: backups, before: before.map(value => value?.toString('base64') ?? null) }));
    journalWritten = true;
    if (image) { await mkdir(store.images, { recursive: true }); await writeFile(resolve(store.images, `${image.id}.webp`), image.bytes, { flag: 'wx' }); }
    const after = [merged.rooms, merged.sources, merged.manifest, merged.edits];
    for (let i = 0; i < DATA_FILES.length; i++) {
      await hooks.beforeReplace?.(i, DATA_FILES[i]);
      await atomicWrite(resolve(store.data, DATA_FILES[i]), jsonBytes(after[i]));
    }
    for (const record of removed) await unlink(photoFilePath(projectRoot, record));
    await unlink(journalPath);
    journalWritten = false;
    return result;
  } catch (error) {
    if (journalWritten) {
      try { await recoverLocked(store); }
      catch { throw new AdminError('更新に失敗し、回復処理が必要です。管理用サーバーを再起動してください。', 500); }
    }
    throw error;
  } finally { await release(); }
}

/** Commit image + four canonical JSON files; old version-1 journals remain recoverable. */
export async function addAdminPhoto(projectRoot, payload, hooks = {}) {
  if (!payload || typeof payload.roomId !== 'string' || !['interior', 'exterior'].includes(payload.kind) || typeof payload.image?.data !== 'string') throw new AdminError('教室・写真の種類・画像を指定してください。');
  const base64 = payload.image.data;
  if (!base64.length || base64.length > Math.ceil(ADMIN_LIMITS.maxFileBytes / 3) * 4 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new AdminError('画像データの形式またはサイズが不正です。');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) throw new AdminError('画像データの形式が不正です。');
  const dimensions = inspectWebP(bytes);
  if (payload.image.width !== dimensions.width || payload.image.height !== dimensions.height) throw new AdminError('画像の寸法が一致しません。');
  return mutateStore(projectRoot, state => {
    if (!state.rooms.some(room => room.id === payload.roomId)) throw new AdminError('登録されていない教室です。');
    const id = `admin-${randomUUID()}`;
    const photo = { id, roomId: payload.roomId, src: `images/rooms/${id}.webp`, kind: payload.kind, source: '管理者追加', ...dimensions, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, addedAt: new Date().toISOString() };
    state.manifest.photos.push(photo);
    const merged = applyAdminPhotos(state);
    const room = merged.rooms.find(room => room.id === payload.roomId);
    return { merged, image: { id, bytes }, result: { photo, room: galleryRoomState(room, merged.sources, merged.edits), summary: merged.sources.summary } };
  }, hooks);
}
export async function updatePhotoGallery(projectRoot, payload, hooks = {}) {
  return mutateStore(projectRoot, state => {
    if (!payload || !state.rooms.some(room => room.id === payload.roomId)) throw new GalleryError('登録されていない教室です。');
    const current = applyAdminPhotos(state);
    const room = current.rooms.find(room => room.id === payload.roomId);
    const edit = validateGalleryUpdate(payload, room, current.sources, current.edits);
    if (current.edits.rooms[payload.roomId]?.comment !== undefined) edit.comment = current.edits.rooms[payload.roomId].comment;
    current.edits.rooms[payload.roomId] = edit;
    const merged = applyAdminPhotos(current);
    const updated = merged.rooms.find(room => room.id === payload.roomId);
    return { merged, result: { room: galleryRoomState(updated, merged.sources, merged.edits), summary: merged.sources.summary } };
  }, hooks);
}

export async function updateRoomContent(projectRoot, payload, hooks = {}) {
  return mutateStore(projectRoot, state => {
    const current = applyAdminPhotos(state);
    const room = current.rooms.find(room => room.id === payload?.roomId);
    if (!room) throw new GalleryError('登録されていない教室です。');
    const snapshot = galleryRoomState(room, current.sources, current.edits);
    if (payload.revision !== snapshot.revision) throw new GalleryError('別の画面で更新されました。再読み込みしてください。', 409);
    const edit = current.edits.rooms[room.id] ||= { order: snapshot.photos.map(photo => photo.id), hidden: snapshot.photos.filter(photo => photo.hidden).map(photo => photo.id) };
    let removed = [];
    if (payload.action === 'comment') {
      if (typeof payload.comment !== 'string' || payload.comment.length > 300) throw new GalleryError('コメントは300文字以内で入力してください。');
      edit.comment = payload.comment.trim();
    } else if (payload.action === 'delete') {
      const record = current.sources.photos.find(photo => photo.id === payload.photoId && photo.roomId === room.id && photo.webp);
      if (!record) throw new GalleryError('写真が見つかりません。', 404);
      // Remove aliases together so no other record points at a deleted file.
      removed = current.sources.photos.filter(photo => photo.webp?.src === record.webp.src);
      const ids = new Set(removed.map(photo => photo.id));
      current.edits.deleted ||= [];
      current.edits.deleted.push(...removed.map(photo => ({ id: photo.id, src: photo.webp.src, roomId: photo.roomId, sourceType: photo.sourceType, preservedExisting: !!photo.preservedExisting, ...(photo.page !== undefined ? { page: photo.page, pdfImageIndex: photo.pdfImageIndex } : {}) })));
      current.sources.photos = current.sources.photos.filter(photo => !ids.has(photo.id));
      current.manifest.photos = current.manifest.photos.filter(photo => !ids.has(photo.id));
      for (const value of Object.values(current.edits.rooms)) {
        value.order = value.order.filter(id => !ids.has(id));
        value.hidden = value.hidden.filter(id => !ids.has(id));
      }
    } else throw new GalleryError('操作が不正です。');
    const merged = applyAdminPhotos(current);
    const updated = merged.rooms.find(item => item.id === room.id);
    return { merged, removed: [...new Map(removed.map(photo => [photo.webp.src, photo])).values()], result: { room: galleryRoomState(updated, merged.sources, merged.edits), summary: merged.sources.summary } };
  }, hooks);
}
