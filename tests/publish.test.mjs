import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { workflowRunId, verifyPublishedPhotos } from '../tools/publish.mjs';

test('Windows launchers retain CRLF without a UTF-8 BOM', async () => {
  for (const file of ['写真を公開.cmd', '管理画面.cmd', '起動.cmd']) {
    const bytes = await readFile(file);
    const text = bytes.toString('utf8');
    assert.equal(text.startsWith('\uFEFF'), false, file);
    assert.equal(/(?<!\r)\n/.test(text), false, `${file} must use CRLF for cmd.exe`);
    assert.ok(text.includes('\r\n'), file);
  }
});
test('the actual Windows publish launcher parses and cancellation does not publish', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo N|call "写真を公開.cmd"'], { encoding: 'utf8', timeout: 10_000, windowsVerbatimArguments: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('公開を開始しますか'), result.stdout);
  assert.ok(!result.stdout.includes('[1/6]'));
  assert.equal(result.stderr, '');
});
test('workflow run IDs are extracted only for the configured repository', () => {
  assert.equal(workflowRunId('https://github.com/IZUisMe/classroom-reservation/actions/runs/12345\n'), '12345');
  assert.equal(workflowRunId('https://github.com/another/repository/actions/runs/12345'), null);
});
test('publication verification checks both remote metadata and every actual image hash', async () => {
  const bytes = Buffer.from('verified test image');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const manifest = { photos: [{ id: 'admin-test', roomId: '72BC', src: 'images/rooms/admin-test.webp', sha256: hash }] };
  const requests = [];
  const fetcher = async url => {
    requests.push(url);
    return url.includes('admin-photos.json') ? Response.json(manifest) : new Response(bytes);
  };
  assert.equal(await verifyPublishedPhotos(manifest, fetcher), 1);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => url.startsWith('https://izuisme.github.io/classroom-reservation/') && url.includes('?verify=')));
  await assert.rejects(verifyPublishedPhotos(manifest, async () => Response.json({ photos: [] })), /反映されていません/);
  await assert.rejects(verifyPublishedPhotos(manifest, async url => url.includes('admin-photos.json') ? Response.json(manifest) : new Response('wrong bytes')), /一致しません/);
  await assert.rejects(verifyPublishedPhotos(manifest, async () => new Response('', { status: 404 })), /404/);
});
