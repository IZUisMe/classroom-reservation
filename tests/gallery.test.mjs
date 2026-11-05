import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { applyGalleryEdits, emptyPhotoEdits, galleryRoomState, validateGalleryUpdate, photoFilePath } from '../tools/photo_gallery_edits.mjs';
import { applyAdminPhotos, addAdminPhoto, updatePhotoGallery, recoverAdminPhotoTransaction, inspectWebP } from '../tools/apply_admin_photos.mjs';
import { createAdminServer } from '../tools/admin-server.mjs';

const root = resolve('test-results');
await mkdir(root, { recursive: true });
const bytes = await readFile('public/images/rooms/31a-interior.webp');
const dimensions = inspectWebP(bytes);
const hash = createHash('sha256').update(bytes).digest('hex');
const files = ['rooms.json', 'photo-sources.json', 'admin-photos.json', 'photo-edits.json'];
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
async function fixture() {
  const path = await mkdtemp(join(root, 'gallery-fixture-'));
  await mkdir(join(path, 'public/data'), { recursive: true });
  await mkdir(join(path, 'public/images/rooms'), { recursive: true });
  const photo = (id, roomId, kind) => ({ id, roomId, roomName: roomId, kind, status: 'available', sourceType: 'pdf', source: 'roomlist.pdf', page: 5, webp: { src: `images/rooms/${id}.webp`, sha256: hash, bytes: bytes.length, ...dimensions } });
  const photos = [photo('source-a', 'R1', 'interior'), photo('source-b', 'R1', 'interior'), photo('source-c', 'R1', 'exterior'), photo('source-d', 'R2', 'interior')];
  const makeRoom = id => ({ id, name: id, images: { interior: null, exterior: null }, photoStatus: { interior: 'missing', exterior: 'missing' }, gallery: photos.filter(photo => photo.roomId === id).map(photo => ({ src: photo.webp.src, kind: photo.kind, source: photo.source, page: photo.page, sourceId: photo.id, width: photo.webp.width, height: photo.webp.height })) });
  const sources = { schemaVersion: 2, summary: { pdfPhotographs: 148, existingPhotosPreserved: 16, primaryPhotoSlots: 84 }, photos };
  const state = applyAdminPhotos({ rooms: [makeRoom('R1'), makeRoom('R2')], sources, manifest: { schemaVersion: 1, photos: [] }, edits: emptyPhotoEdits() });
  for (const photo of photos) await writeFile(join(path, 'public', photo.webp.src), bytes);
  for (const [index, value] of [state.rooms, state.sources, state.manifest, state.edits].entries()) await json(join(path, 'public/data', files[index]), value);
  return { path, ...state, async cleanup() { assert.ok(path.startsWith(root + '/gallery-fixture-') || path.startsWith(root + '\\gallery-fixture-')); await rm(path, { recursive: true, force: true }); } };
}
function updatePayload(state, order = ['source-c', 'source-b', 'source-a'], hidden = ['source-b']) {
  const room = state.rooms.find(room => room.id === 'R1');
  return { roomId: 'R1', order, hidden, revision: galleryRoomState(room, state.sources, state.edits).revision };
}
const uploadPayload = () => ({ roomId: 'R1', kind: 'interior', image: { data: bytes.toString('base64'), ...dimensions } });

test('source photos reorder, hide and restore without changing ledger or raw bytes', async () => {
  const data = await fixture();
  try {
    const before = structuredClone(data.sources);
    const edited = applyGalleryEdits({ ...data, edits: { schemaVersion: 1, rooms: { R1: { order: ['source-c', 'source-b', 'source-a'], hidden: ['source-b'] } } } });
    assert.deepEqual(edited.rooms[0].gallery.map(photo => photo.sourceId), ['source-c', 'source-a']);
    assert.equal(edited.rooms[0].images.interior.sourceId, 'source-a');
    assert.equal(edited.rooms[0].images.exterior.sourceId, 'source-c');
    assert.equal(edited.sources.summary.hiddenPhotoCount, 1);
    assert.equal(edited.sources.summary.galleryPhotoCount, 3);
    assert.equal(edited.sources.summary.webpCount, 4);
    assert.equal(edited.sources.summary.primaryPhotoSlots, 84);
    assert.deepEqual(edited.sources.photos, before.photos);
    const allHidden = applyGalleryEdits({ ...edited, edits: { schemaVersion: 1, rooms: { R1: { order: ['source-c', 'source-b', 'source-a'], hidden: ['source-a', 'source-b', 'source-c'] } } } });
    assert.deepEqual(allHidden.rooms[0].gallery, []);
    assert.deepEqual(allHidden.rooms[0].images, { interior: null, exterior: null });
    assert.equal(allHidden.rooms[0].photoStatus.interior, 'missing');
    const restored = applyGalleryEdits({ ...allHidden, edits: { schemaVersion: 1, rooms: { R1: { order: ['source-c', 'source-b', 'source-a'], hidden: [] } } } });
    assert.deepEqual(restored.rooms[0].gallery.map(photo => photo.sourceId), ['source-c', 'source-b', 'source-a']);
    assert.equal(restored.rooms[0].images.interior.sourceId, 'source-b');
    assert.deepEqual(applyGalleryEdits(restored), restored);
    for (const record of data.sources.photos) assert.deepEqual(await readFile(join(data.path, 'public', record.webp.src)), bytes);
  } finally { await data.cleanup(); }
});
test('gallery validation requires a full permutation, subset and current room revision', async () => {
  const data = await fixture();
  try {
    const room = data.rooms[0]; const valid = updatePayload(data);
    for (const invalid of [ { ...valid, order: ['source-a', 'source-b'] }, { ...valid, order: ['source-a', 'source-a', 'source-c'] }, { ...valid, order: ['source-a', 'source-b', 'source-d'] }, { ...valid, hidden: ['source-d'] }, { ...valid, hidden: ['source-a', 'source-a'] } ]) assert.throws(() => validateGalleryUpdate(invalid, room, data.sources, data.edits), error => error.status === 400);
    assert.throws(() => validateGalleryUpdate({ ...valid, revision: 'old' }, room, data.sources, data.edits), error => error.status === 409);
    assert.throws(() => photoFilePath(data.path, { status: 'available', webp: { src: '../../secret.webp' } }), error => error.status === 404);
  } finally { await data.cleanup(); }
});
test('source edit persists across administrator upload, appending new photo and changing revision', async () => {
  const data = await fixture();
  try {
    const first = await updatePhotoGallery(data.path, updatePayload(data));
    const previous = first.room.revision;
    const added = await addAdminPhoto(data.path, uploadPayload());
    assert.notEqual(added.room.revision, previous);
    assert.deepEqual(added.room.photos.map(photo => photo.id), ['source-c', 'source-b', 'source-a', added.photo.id]);
    assert.equal(added.room.photos.find(photo => photo.id === 'source-b').hidden, true);
    assert.equal(added.summary.hiddenPhotoCount, 1);
    assert.equal(added.summary.webpCount, 5);
    const stored = await readJson(join(data.path, 'public/data/photo-edits.json'));
    assert.deepEqual(stored.rooms.R1.order, ['source-c', 'source-b', 'source-a', added.photo.id]);
    await assert.rejects(updatePhotoGallery(data.path, { ...updatePayload(data), revision: previous, order: [...updatePayload(data).order, added.photo.id] }), error => error.status === 409);
    const state = Object.fromEntries(await Promise.all(files.map(async (file, index) => [['rooms','sources','manifest','edits'][index], await readJson(join(data.path, 'public/data', file))])));
    assert.deepEqual(applyAdminPhotos(state), state);
  } finally { await data.cleanup(); }
});
test('four-file gallery/upload failure rolls back every JSON and never removes originals', async () => {
  const data = await fixture();
  try {
    const before = await Promise.all(files.map(file => readFile(join(data.path, 'public/data', file))));
    const names = await readdir(join(data.path, 'public/images/rooms'));
    for (const operation of [() => updatePhotoGallery(data.path, updatePayload(data), { beforeReplace(index) { if (index === 3) throw new Error('fourth write failure'); } }), () => addAdminPhoto(data.path, uploadPayload(), { beforeReplace(index) { if (index === 3) throw new Error('fourth write failure'); } })]) {
      await assert.rejects(operation(), /fourth write/);
      for (const [index, file] of files.entries()) assert.deepEqual(await readFile(join(data.path, 'public/data', file)), before[index]);
      assert.deepEqual(await readdir(join(data.path, 'public/images/rooms')), names);
    }
  } finally { await data.cleanup(); }
});
test('journal v2 supports image-free edits while v1 recovery leaves the fourth file unchanged', async () => {
  const data = await fixture();
  try {
    await mkdir(join(data.path, 'tools/admin/.state'), { recursive: true });
    const journal = join(data.path, 'tools/admin/.state/transaction.json');
    const before = await Promise.all(files.map(file => readFile(join(data.path, 'public/data', file))));
    await json(join(data.path, 'public/data/rooms.json'), []);
    await json(join(data.path, 'public/data/photo-edits.json'), { broken: true });
    await json(journal, { version: 2, imageId: null, before: before.map(value => value.toString('base64')) });
    assert.equal(await recoverAdminPhotoTransaction(data.path), true);
    for (const [index, file] of files.entries()) assert.deepEqual(await readFile(join(data.path, 'public/data', file)), before[index]);
    const imageId = `admin-${randomUUID()}`;
    await writeFile(join(data.path, `public/images/rooms/${imageId}.webp`), bytes);
    const fourth = Buffer.from('{"schemaVersion":1,"rooms":{}}\n');
    await writeFile(join(data.path, 'public/data/photo-edits.json'), fourth);
    await json(journal, { version: 1, imageId, before: before.slice(0, 3).map(value => value.toString('base64')) });
    assert.equal(await recoverAdminPhotoTransaction(data.path), true);
    assert.deepEqual(await readFile(join(data.path, 'public/data/photo-edits.json')), fourth);
    assert.equal((await readdir(join(data.path, 'public/images/rooms'))).includes(`${imageId}.webp`), false);
  } finally { await data.cleanup(); }
});
test('gallery API serves hidden thumbnails, rejects stale updates and enforces CSRF/publish exclusion', async () => {
  const data = await fixture(); let publishing = false;
  const app = await createAdminServer({ projectRoot: data.path, port: 0, isPublishing: () => publishing });
  try {
    const address = await app.listen(); const base = `http://127.0.0.1:${address.port}`;
    const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
    const room = bootstrap.rooms.find(room => room.id === 'R1');
    assert.equal(room.photos.length, 3); assert.match(room.revision, /^[a-f0-9]{64}$/);
    const headers = { Origin: base, 'X-CSRF-Token': bootstrap.csrfToken, 'Content-Type': 'application/json' };
    const post = (payload, changed = {}) => fetch(`${base}/api/gallery`, { method: 'POST', headers: { ...headers, ...changed }, body: JSON.stringify(payload) });
    const payload = { roomId: 'R1', order: ['source-c','source-b','source-a'], hidden: ['source-b'], revision: room.revision };
    assert.equal((await post(payload, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(payload, { 'X-CSRF-Token': 'wrong' })).status, 403);
    assert.equal((await post({ ...payload, order: ['source-a','source-b','source-d'] })).status, 400);
    const response = await post(payload); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.room.photoCount, 2);
    assert.equal(result.room.photos.find(photo => photo.id === 'source-b').hidden, true);
    assert.equal((await post(payload)).status, 409);
    const hiddenPhoto = await fetch(`${base}/photos/source-b`); assert.equal(hiddenPhoto.status, 200); assert.equal(hiddenPhoto.headers.get('content-type'), 'image/webp'); assert.deepEqual(Buffer.from(await hiddenPhoto.arrayBuffer()), bytes);
    for (const route of ['/photos/no-such-photo','/photos/..%2f..%2fsecret','/photos/source-b?path=secret']) assert.equal((await fetch(base + route)).status, 404);
    publishing = true;
    assert.equal((await post({ ...payload, revision: result.room.revision })).status, 409);
    assert.equal((await fetch(`${base}/api/photos`, { method: 'POST', headers, body: JSON.stringify(uploadPayload()) })).status, 409);
    publishing = false;
    const restore = await post({ ...payload, hidden: [], revision: result.room.revision }); assert.equal(restore.status, 200);
    assert.equal((await restore.json()).room.photoCount, 3);
  } finally { await app.close(); await data.cleanup(); }
});
