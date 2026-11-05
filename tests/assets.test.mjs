import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const rooms = JSON.parse(await readFile('public/data/rooms.json', 'utf8'));
const sources = JSON.parse(await readFile('public/data/photo-sources.json', 'utf8'));
const custom = JSON.parse(await readFile('public/data/custom-rooms.json', 'utf8'));
const admin = JSON.parse(await readFile('public/data/admin-photos.json', 'utf8'));
const missingInteriors = ['22A', '22F', '72D', '72A', '72BC'].filter(id =>
  !admin.photos.some(photo => photo.roomId === id && photo.kind === 'interior'));

test('42 rooms retain all 40 source-backed rooms and explicit photo gaps', () => {
  assert.equal(rooms.length, 42);
  assert.equal(new Set(rooms.map(r => r.id)).size, 42);
  assert.equal(rooms.filter(room => room.source.xlsx).length, 37);
  assert.deepEqual(rooms.filter(r => !r.images.interior).map(r => r.id), missingInteriors);
  for (const id of ['21A', '22H', '33J']) {
    const room = rooms.find(r => r.id === id);
    assert.ok(room && room.gallery.length > 0);
    assert.ok(room.source.pdfPages.length > 0);
  }
  assert.equal(sources.summary.roomCount, 42);
  assert.equal(sources.summary.primaryPhotoSlots, 84);
  assert.equal(sources.summary.originalWorkbookRoomCount, 37);
  assert.equal(sources.summary.workbookRowSlots, 38);
  assert.deepEqual(sources.summary.blankWorkbookRows, [38]);
  assert.deepEqual(sources.summary.interiorMissing, missingInteriors);
  assert.equal(sources.photos.length, 198 + admin.photos.length);
});

test('72A and 72BC persist as user-provided rooms without invented source data', () => {
  assert.equal(custom.schemaVersion, 1);
  assert.deepEqual(custom.rooms.map(room => room.id), ['72A', '72BC']);
  assert.deepEqual(sources.summary.addedUserRooms, ['72A', '72BC']);
  for (const entry of custom.rooms) {
    const room = rooms.find(room => room.id === entry.id);
    assert.ok(room);
    for (const field of ['id', 'name', 'displayName', 'building', 'floor', 'code', 'description', 'comment', 'capacity', 'equipment', 'source']) {
      assert.deepEqual(room[field], entry[field]);
    }
    assert.equal(room.name, `${room.id}教室`);
    assert.equal(room.displayName, `${room.name}(7号館2階)`);
    assert.equal(room.building, '7');
    assert.equal(room.floor, '2');
    assert.equal(room.code, room.id.slice(2));
    assert.equal(room.source.type, 'user-provided');
    assert.equal(room.source.addedFromUser, true);
    assert.equal(room.source.xlsx, null);
    assert.deepEqual(room.source.pdfPages, []);
    assert.equal(room.source.pdfLabel, null);
    assert.deepEqual(room.source.locationEvidence, { source: 'user-provided', building: '7', floor: '2' });
    assert.equal(room.capacity, null);
    assert.equal(room.equipment, null);
    assert.deepEqual(entry.images, { interior: null, exterior: null });
    assert.deepEqual(entry.photoStatus, { interior: 'missing', exterior: 'missing' });
    assert.deepEqual(entry.gallery, []);
    const additions = admin.photos.filter(photo => photo.roomId === room.id);
    if (!additions.length) {
      assert.deepEqual(room.images, entry.images);
      assert.deepEqual(room.photoStatus, entry.photoStatus);
      assert.deepEqual(room.gallery, []);
    }
    for (const kind of ['interior', 'exterior']) {
      const slot = sources.photos.find(photo => photo.id === `${room.id}-${kind}`);
      assert.equal(slot.status, 'missing');
      assert.equal(slot.sourceType, 'user-provided');
      assert.equal(slot.source, 'user-provided');
      assert.equal(slot.webp, undefined);
    }
  }
});

test('all 164 source photos plus admin additions preserve hashes and dimensions', async () => {
  const available = sources.photos.filter(p => p.status === 'available');
  assert.equal(available.length, 164 + admin.photos.length);
  assert.equal(available.filter(p => p.preservedExisting).length, 16);
  assert.equal(available.filter(p => p.sourceType === 'pdf').length, 148);
  assert.equal(available.filter(p => p.sourceType === 'admin').length, admin.photos.length);
  const gallery = rooms.flatMap(room => room.gallery.map(image => ({ ...image, roomId: room.id })));
  assert.equal(gallery.length, 164 + admin.photos.length);
  assert.equal(new Set(gallery.map(image => image.src)).size, gallery.length);
  for (const p of available) {
    const image = gallery.find(image => image.sourceId === p.id);
    assert.equal(image?.roomId, p.roomId);
    assert.equal(image?.src, p.webp.src);
    assert.equal(image.width, p.webp.width);
    assert.equal(image.height, p.webp.height);
    assert.match(p.webp.src, /^images\/rooms\/[a-zA-Z0-9-]+\.webp$/);
    const bytes = await readFile(`public/${p.webp.src}`);
    assert.equal(bytes.length, p.webp.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), p.webp.sha256);
  }
  for (const room of rooms) for (const image of Object.values(room.images).filter(Boolean)) {
    assert.ok(room.gallery.some(item => item.src === image.src));
  }
});

test('admin manifest additions remain distinct and only fill missing primaries', () => {
  assert.equal(admin.schemaVersion, 1);
  assert.equal(new Set(admin.photos.map(photo => photo.id)).size, admin.photos.length);
  assert.equal(sources.summary.adminPhotographs, admin.photos.length);
  assert.equal(sources.summary.galleryPhotoCount, 164 + admin.photos.length);
  for (const photo of admin.photos) {
    assert.match(photo.id, /^admin-[A-Za-z0-9-]+$/);
    assert.equal(photo.src, `images/rooms/${photo.id}.webp`);
    assert.equal(photo.source, '管理者追加');
    assert.ok(['interior', 'exterior'].includes(photo.kind));
    const room = rooms.find(room => room.id === photo.roomId);
    const record = sources.photos.find(record => record.id === photo.id);
    assert.ok(room && record);
    assert.equal(record.sourceType, 'admin');
    assert.equal(record.source, '管理者追加');
    assert.equal(record.addedAt, photo.addedAt);
    for (const key of ['src', 'sha256', 'bytes', 'width', 'height']) assert.equal(record.webp[key], photo[key]);
    const original = sources.photos.find(record => record.id === `${room.id}-${photo.kind}`);
    const first = admin.photos.find(item => item.roomId === room.id && item.kind === photo.kind);
    assert.equal(room.images[photo.kind].sourceId, original.status === 'available' ? original.id : first.id);
    assert.equal(room.photoStatus[photo.kind], 'available');
  }
});
