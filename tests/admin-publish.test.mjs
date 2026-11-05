import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createPublishController } from '../tools/admin_publish.mjs';
import { createAdminServer } from '../tools/admin-server.mjs';
function fakeChild() { return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }); }
test('publish controller uses a fixed command, reports progress and prevents concurrent jobs', () => {
  const child = fakeChild(); let invocation;
  const controller = createPublishController('.', { spawnProcess: (...args) => { invocation = args; return child; } });
  assert.equal(controller.getStatus().state, 'idle');
  const initial = controller.start();
  assert.equal(initial.state, 'running'); assert.ok(initial.id);
  assert.ok(invocation[1][0].endsWith('tools' + sep + 'publish.mjs'));
  assert.equal(invocation[2].cwd, resolve('.'));
  assert.equal(invocation[2].env.GIT_TERMINAL_PROMPT, '0');
  assert.throws(() => controller.start(), error => error.status === 409);
  child.stdout.write('[2/6] 写真を検査中\n');
  child.stderr.write('gho_' + 'x'.repeat(30) + '\n');
  assert.equal(controller.getStatus().phase, '写真を検査中');
  assert.ok(!controller.getStatus().logs.includes('x'.repeat(30)));
  child.stdout.write('公開完了\n'); child.emit('close', 0);
  assert.equal(controller.isRunning(), false); assert.equal(controller.getStatus().state, 'success');
  assert.ok(controller.getStatus().finishedAt);
});
test('publisher logs are bounded and stale child events cannot change a newer job', () => {
  const first = fakeChild(); const second = fakeChild(); let calls = 0;
  const controller = createPublishController('.', { spawnProcess: () => calls++ ? second : first });
  controller.start(); first.emit('error', new Error('spawn blocked'));
  assert.equal(controller.getStatus().state, 'failed');
  const fresh = controller.start();
  first.stdout.write('stale output'); first.emit('close', 1);
  assert.equal(controller.getStatus().id, fresh.id); assert.equal(controller.getStatus().state, 'running');
  assert.ok(!controller.getStatus().logs.includes('stale output'));
  second.stdout.write('a'.repeat(100_000)); assert.ok(controller.getStatus().logs.length <= 65536);
  second.emit('close', 1); assert.equal(controller.getStatus().state, 'failed');
});
test('publish API protects launch with CSRF, exposes progress and blocks writes while publishing', async () => {
  const parent = resolve('test-results'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'publish-api-'));
  await mkdir(join(root, 'public/data'), { recursive: true });
  for (const name of ['rooms.json', 'photo-sources.json', 'admin-photos.json', 'photo-edits.json']) {
    let value;
    try { value = await readFile(`public/data/${name}`); }
    catch (error) { if (name === 'photo-edits.json' && error.code === 'ENOENT') value = JSON.stringify({ schemaVersion: 1, rooms: {} }); else throw error; }
    await writeFile(join(root, 'public/data', name), value);
  }
  let state = 'idle'; let starts = 0;
  const controller = { isRunning: () => state === 'running', getStatus: () => ({ id: starts || null, state, logs: '', site: 'https://izuisme.github.io/classroom-reservation/' }), start() { starts++; state = 'running'; return this.getStatus(); } };
  const app = await createAdminServer({ projectRoot: root, port: 0, publishController: controller });
  const address = await app.listen(); const base = `http://127.0.0.1:${address.port}`;
  try {
    const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
    const headers = { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap.csrfToken };
    assert.equal((await fetch(`${base}/api/publish`)).status, 200);
    assert.equal((await fetch(`${base}/api/publish`, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/publish`, { method: 'POST', headers, body: '{"command":"not allowed"}' })).status, 400);
    assert.equal(starts, 0);
    const responses = await Promise.all([1, 2].map(() => fetch(`${base}/api/publish`, { method: 'POST', headers, body: '{}' })));
    assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]); assert.equal(starts, 1);
    const current = await (await fetch(`${base}/api/publish`)).json(); assert.equal(current.job.state, 'running');
    for (const path of ['photos', 'gallery']) assert.equal((await fetch(`${base}/api/${path}`, { method: 'POST', headers, body: '{}' })).status, 409);
    assert.equal((await fetch(`${base}/api/bootstrap`)).status, 200);
  } finally {
    await app.close(); assert.ok(root.startsWith(parent + sep + 'publish-api-')); await rm(root, { recursive: true, force: true });
  }
});
