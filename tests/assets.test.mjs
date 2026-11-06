import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { applyGalleryEdits } from '../tools/photo_gallery_edits.mjs';
const rooms = JSON.parse(await readFile('public/data/rooms.json', 'utf8'));
const sources = JSON.parse(await readFile('public/data/photo-sources.json', 'utf8'));
const custom = JSON.parse(await readFile('public/data/custom-rooms.json', 'utf8'));
const admin = JSON.parse(await readFile('public/data/admin-photos.json', 'utf8'));
const edits = JSON.parse(await readFile('public/data/photo-edits.json', 'utf8'));
const overlaid = applyGalleryEdits({ rooms, sources, edits });
const hiddenIds = new Set(Object.values(overlaid.edits.rooms).flatMap(edit => edit.hidden));
const missingInteriors = overlaid.rooms.filter(room => !room.images.interior).map(room => room.id);
const deletedOriginals = (edits.deleted || []).filter(photo => !photo.id.startsWith('admin-'));

test('42 rooms retain original source facts and overlay-aware primary slots', () => {
  assert.equal(rooms.length, 42);
  assert.equal(new Set(rooms.map(room => room.id)).size, 42);
  assert.equal(rooms.filter(room => room.source.xlsx).length, 37);
  assert.deepEqual(rooms.filter(room => !room.images.interior).map(room => room.id), missingInteriors);
  for (const id of ['21A', '22H', '33J']) assert.ok(rooms.find(room => room.id === id)?.source.pdfPages.length);
  assert.equal(sources.summary.roomCount, 42);
  assert.equal(sources.summary.primaryPhotoSlots, 84);
  assert.equal(sources.summary.originalWorkbookRoomCount, 37);
  assert.equal(sources.summary.workbookRowSlots, 38);
  assert.deepEqual(sources.summary.blankWorkbookRows, [38]);
  assert.deepEqual(sources.summary.interiorMissing, missingInteriors);
  assert.equal(sources.photos.length, 198 - deletedOriginals.length + admin.photos.length);
  for (const room of rooms) {
    const expected = overlaid.rooms.find(item => item.id === room.id);
    assert.deepEqual(room.gallery.map(photo => photo.sourceId), expected.gallery.map(photo => photo.sourceId));
    for (const kind of ['interior', 'exterior']) {
      assert.equal(room.images[kind]?.sourceId, expected.images[kind]?.sourceId);
      assert.equal(room.photoStatus[kind], expected.photoStatus[kind]);
    }
  }
});
test('72A and 72BC remain user-provided and never acquire invented source facts', () => {
  assert.equal(custom.schemaVersion, 1);
  assert.deepEqual(custom.rooms.map(room => room.id), ['72A', '72BC']);
  assert.deepEqual(sources.summary.addedUserRooms, ['72A', '72BC']);
  for (const entry of custom.rooms) {
    const room = rooms.find(room => room.id === entry.id);
    for (const field of ['id', 'name', 'displayName', 'building', 'floor', 'code', 'description', 'capacity', 'equipment', 'source']) assert.deepEqual(room[field], entry[field]);
    assert.equal(room.comment, edits.rooms[entry.id]?.comment ?? entry.comment);
    assert.equal(room.displayName, `${room.name}(7号館2階)`);
    assert.equal(room.source.type, 'user-provided');
    assert.equal(room.source.xlsx, null);
    assert.deepEqual(room.source.pdfPages, []);
    assert.equal(room.capacity, null);
    assert.equal(room.equipment, null);
    for (const kind of ['interior', 'exterior']) {
      const slot = sources.photos.find(photo => photo.id === `${room.id}-${kind}`);
      assert.equal(slot.status, 'missing');
      assert.equal(slot.sourceType, 'user-provided');
      assert.equal(slot.webp, undefined);
    }
  }
});
test('all physical photos, including hidden originals, retain hashes and dimensions', async () => {
  const available = sources.photos.filter(photo => photo.status === 'available');
  assert.equal(available.length, 164 - deletedOriginals.length + admin.photos.length);
  assert.equal(available.filter(photo => photo.preservedExisting).length, 16 - deletedOriginals.filter(photo => photo.preservedExisting).length);
  assert.equal(available.filter(photo => photo.sourceType === 'pdf').length, 148 - deletedOriginals.filter(photo => photo.sourceType === 'pdf').length);
  assert.equal(available.filter(photo => photo.sourceType === 'admin').length, admin.photos.length);
  const gallery = rooms.flatMap(room => room.gallery.map(photo => ({ ...photo, roomId: room.id })));
  assert.equal(gallery.length, available.length - hiddenIds.size);
  assert.equal(new Set(gallery.map(photo => photo.src)).size, gallery.length);
  for (const photo of available) {
    const image = gallery.find(image => image.sourceId === photo.id);
    if (hiddenIds.has(photo.id)) assert.equal(image, undefined);
    else {
      assert.equal(image?.roomId, photo.roomId); assert.equal(image?.src, photo.webp.src);
      assert.equal(image.width, photo.webp.width); assert.equal(image.height, photo.webp.height);
    }
    assert.match(photo.webp.src, /^images\/rooms\/[a-zA-Z0-9-]+\.webp$/);
    const bytes = await readFile(`public/${photo.webp.src}`);
    assert.equal(bytes.length, photo.webp.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), photo.webp.sha256);
  }
  assert.equal(sources.summary.galleryPhotoCount, gallery.length);
  assert.equal(sources.summary.hiddenPhotoCount ?? 0, hiddenIds.size);
  assert.equal(sources.summary.webpCount, available.length);
});
test('administrator additions preserve their independent source manifest', () => {
  assert.equal(admin.schemaVersion, 1);
  assert.equal(new Set(admin.photos.map(photo => photo.id)).size, admin.photos.length);
  assert.equal(sources.summary.adminPhotographs, admin.photos.length);
  for (const photo of admin.photos) {
    assert.match(photo.id, /^admin-[A-Za-z0-9-]+$/);
    assert.equal(photo.src, `images/rooms/${photo.id}.webp`);
    assert.equal(photo.source, '管理者追加');
    const record = sources.photos.find(record => record.id === photo.id);
    assert.equal(record.sourceType, 'admin'); assert.equal(record.roomId, photo.roomId);
    assert.equal(record.addedAt, photo.addedAt);
    for (const key of ['src', 'sha256', 'bytes', 'width', 'height']) assert.equal(record.webp[key], photo[key]);
  }
});
