import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';

export class GalleryError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const emptyPhotoEdits = () => ({ schemaVersion: 1, rooms: {} });
export function deletedPhotos(edits) {
  const list = edits.deleted || [];
  if (!Array.isArray(list) || list.some(photo => !photo || typeof photo.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(photo.id) || !validSrc(photo.src))) throw new GalleryError('削除記録が不正です。', 500);
  return list;
}
const own = (object, key) => Object.hasOwn(object, key);
const validSrc = value => typeof value === 'string' && /^images\/rooms\/[A-Za-z0-9-]+\.webp$/.test(value);
const clone = value => structuredClone(value);

export function roomPhotoRecords(sources, roomId) {
  if (!Array.isArray(sources?.photos)) throw new GalleryError('写真出典台帳の形式が不正です。', 500);
  const found = sources.photos.filter(photo => photo.roomId === roomId && photo.status === 'available' && photo.webp);
  const ids = new Set();
  for (const photo of found) {
    if (typeof photo.id !== 'string' || !photo.id || ids.has(photo.id) || !['interior', 'exterior'].includes(photo.kind) || !validSrc(photo.webp.src)) throw new GalleryError('写真出典台帳に不正な写真があります。', 500);
    ids.add(photo.id);
  }
  return found;
}
export function validatePhotoEdits(edits, rooms, sources) {
  if (!edits || edits.schemaVersion !== 1 || !edits.rooms || typeof edits.rooms !== 'object' || Array.isArray(edits.rooms)) throw new GalleryError('写真編集台帳の形式が不正です。', 500);
  const clean = emptyPhotoEdits();
  if (edits.deleted) clean.deleted = clone(deletedPhotos(edits));
  for (const [roomId, value] of Object.entries(edits.rooms)) {
    if (!rooms.some(room => room.id === roomId) || !value || !Array.isArray(value.order) || !Array.isArray(value.hidden)) throw new GalleryError('写真編集台帳の教室が不正です。', 500);
    const known = new Set(roomPhotoRecords(sources, roomId).map(photo => photo.id));
    for (const list of [value.order, value.hidden]) {
      if (list.length > 10_000 || new Set(list).size !== list.length || list.some(id => typeof id !== 'string' || !known.has(id))) throw new GalleryError('写真編集台帳に不正な写真IDがあります。', 500);
    }
    if (value.hidden.some(id => !value.order.includes(id))) throw new GalleryError('除外写真が並び順に含まれていません。', 500);
    clean.rooms[roomId] = { order: [...value.order], hidden: [...value.hidden] };
    if (value.comment !== undefined) {
      if (typeof value.comment !== 'string' || value.comment.length > 300) throw new GalleryError('コメントは300文字以内で入力してください。');
      clean.rooms[roomId].comment = value.comment;
    }
  }
  return clean;
}
function effectiveOrder(room, records, edit) {
  const known = new Set(records.map(photo => photo.id));
  const order = [];
  for (const id of [...(edit?.order || []), ...(room.gallery || []).map(photo => photo.sourceId), ...records.map(photo => photo.id)]) {
    if (known.has(id) && !order.includes(id)) order.push(id);
  }
  return order;
}
function galleryItem(record) {
  return { src: record.webp.src, kind: record.kind, source: record.source, ...(record.page !== undefined ? { page: record.page } : {}), sourceId: record.id, width: record.webp.width, height: record.webp.height };
}
/** Apply ordering, comments and persisted deletion tombstones. */
export function applyGalleryEdits({ rooms, sources, edits = emptyPhotoEdits() }) {
  if (!Array.isArray(rooms)) throw new GalleryError('教室台帳の形式が不正です。', 500);
  const resultRooms = clone(rooms);
  const resultSources = clone(sources);
  const deleted = new Set(deletedPhotos(edits).map(photo => photo.id));
  resultSources.photos = resultSources.photos.filter(photo => !deleted.has(photo.id));
  const clean = validatePhotoEdits(edits, resultRooms, resultSources);
  let total = 0;
  let visible = 0;
  for (const room of resultRooms) {
    const records = roomPhotoRecords(resultSources, room.id);
    const lookup = new Map(records.map(photo => [photo.id, photo]));
    const edit = clean.rooms[room.id];
    if (edit?.comment !== undefined) room.comment = edit.comment;
    const hidden = new Set(edit?.hidden || []);
    const order = effectiveOrder(room, records, edit);
    // Newly uploaded source IDs are appended and persisted on the next write.
    if (edit) clean.rooms[room.id].order = order;
    room.gallery = order.filter(id => !hidden.has(id)).map(id => galleryItem(lookup.get(id)));
    room.images ||= {};
    room.photoStatus ||= {};
    for (const kind of ['interior', 'exterior']) {
      const first = room.gallery.find(photo => photo.kind === kind);
      room.images[kind] = first ? { src: first.src, source: first.source, ...(first.page !== undefined ? { page: first.page } : {}), sourceId: first.sourceId } : null;
      room.photoStatus[kind] = first ? 'available' : 'missing';
    }
    total += records.length;
    visible += room.gallery.length;
  }
  const physical = new Map(resultSources.photos.filter(photo => photo.status === 'available' && photo.webp).map(photo => [photo.webp.src, photo.webp]));
  resultSources.summary ||= {};
  Object.assign(resultSources.summary, { roomCount: resultRooms.length, galleryPhotoCount: visible, hiddenPhotoCount: total - visible, webpCount: physical.size, webpBytes: [...physical.values()].reduce((sum, photo) => sum + photo.bytes, 0), interiorAvailable: resultRooms.filter(room => room.images.interior).length, interiorMissing: resultRooms.filter(room => !room.images.interior).map(room => room.id), exteriorAvailable: resultRooms.filter(room => room.images.exterior).length });
  return { rooms: resultRooms, sources: resultSources, edits: clean };
}
export function galleryRoomState(room, sources, edits = emptyPhotoEdits()) {
  const records = roomPhotoRecords(sources, room.id);
  const lookup = new Map(records.map(photo => [photo.id, photo]));
  const edit = edits.rooms?.[room.id];
  const order = effectiveOrder(room, records, edit);
  const hidden = new Set(edit?.hidden || []);
  const photos = order.map(id => {
    const record = lookup.get(id);
    return { id, kind: record.kind, width: record.webp.width, height: record.webp.height, source: record.source, ...(record.page !== undefined ? { page: record.page } : {}), sourceType: record.sourceType, hidden: hidden.has(id), url: `/photos/${encodeURIComponent(id)}` };
  });
  const content = records.map(photo => [photo.id, photo.webp.sha256, photo.kind, photo.webp.src]).sort((a, b) => a[0].localeCompare(b[0]));
  const comment = room.comment || '';
  const revision = createHash('sha256').update(JSON.stringify({ content, order, hidden: [...hidden].sort(), comment })).digest('hex');
  return { id: room.id, name: room.name, displayName: room.displayName || room.name, comment, photoCount: photos.filter(photo => !photo.hidden).length, photos, revision };
}
export function validateGalleryUpdate(payload, room, sources, edits) {
  if (!payload || typeof payload.roomId !== 'string' || !Array.isArray(payload.order) || !Array.isArray(payload.hidden) || typeof payload.revision !== 'string') throw new GalleryError('教室・並び順・除外写真・更新番号を指定してください。');
  const state = galleryRoomState(room, sources, edits);
  if (payload.revision !== state.revision) throw new GalleryError('写真が別の画面で更新されました。再読み込みしてからやり直してください。', 409);
  const known = new Set(state.photos.map(photo => photo.id));
  if (payload.order.length !== known.size || new Set(payload.order).size !== known.size || payload.order.some(id => typeof id !== 'string' || !known.has(id))) throw new GalleryError('並び順には、この教室の全写真を重複なく指定してください。');
  if (payload.hidden.length > known.size || new Set(payload.hidden).size !== payload.hidden.length || payload.hidden.some(id => typeof id !== 'string' || !known.has(id))) throw new GalleryError('除外写真の指定が不正です。');
  return { order: [...payload.order], hidden: [...payload.hidden] };
}
export function photoFilePath(projectRoot, record) {
  if (!record || record.status !== 'available' || !validSrc(record.webp?.src)) throw new GalleryError('写真が見つかりません。', 404);
  const root = resolve(projectRoot, 'public/images/rooms');
  const path = resolve(projectRoot, 'public', record.webp.src);
  if (!path.startsWith(root + sep)) throw new GalleryError('写真の保存先が不正です。', 404);
  return path;
}
