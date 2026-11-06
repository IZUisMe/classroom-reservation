import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { workflowRunId, verifyPublishedPhotos, verifyPublishedGallery, verifyPublishedDeletions } from '../tools/publish.mjs';

test('Windows launchers retain CRLF without a UTF-8 BOM', async () => {
  for (const file of ['写真を公開.cmd', '管理画面.cmd', '起動.cmd']) {
    const bytes = await readFile(file);
    const text = bytes.toString('utf8');
    assert.equal(text.startsWith('\uFEFF'), false, file);
    assert.equal(/(?<!\r)\n/.test(text), false, `${file} must use CRLF for cmd.exe`);
    assert.ok(text.includes('\r\n'), file);
    assert.ok(bytes.every(byte => byte < 128), `${file} uses only ASCII in cmd.exe`);
    assert.ok(text.includes('powershell.exe" -NoLogo -NoProfile -NoExit'));
    assert.ok(text.includes('tools\\launch.ps1'));
    assert.equal(/\bchoice\b/i.test(text), false, 'No EOF-sensitive choice command');
  }
  assert.ok((await readFile('tools/launch.ps1')).every(byte => byte < 128), 'PowerShell 5 parses the ASCII script regardless of its default encoding');
  assert.ok(JSON.parse(await readFile('tools/launcher-ja.json', 'utf8')).adminStart.includes('管理画面'));
});
test('PowerShell launcher validates every mode without publishing or starting servers', { skip: process.platform !== 'win32' }, () => {
  const powershell = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  for (const mode of ['admin', 'publish', 'app']) {
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve('tools/launch.ps1'), '-Mode', mode, '-Check'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout.trim());
    assert.equal(data.mode, mode); assert.equal(data.persistentWindow, true);
    assert.equal(data.root.toLowerCase(), resolve('.').toLowerCase()); assert.ok(data.node.endsWith('node.exe'));
    assert.equal(result.stderr, '');
  }
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
test('live gallery verification rejects stale order and stale deleted photos', async () => {
  const expected = [{ id: '72BC', name: '72BC教室', gallery: [{ sourceId: 'b' }, { sourceId: 'a' }] }];
  assert.equal(await verifyPublishedGallery(expected, async () => Response.json(expected)), 2);
  const staleOrder = [{ ...expected[0], gallery: [{ sourceId: 'a' }, { sourceId: 'b' }] }];
  await assert.rejects(verifyPublishedGallery(expected, async () => Response.json(staleOrder)), /並び順・削除/);
  const staleDelete = [{ ...expected[0], gallery: [{ sourceId: 'b' }, { sourceId: 'a' }, { sourceId: 'deleted' }] }];
  await assert.rejects(verifyPublishedGallery(expected, async () => Response.json(staleDelete)), /並び順・削除/);
  await assert.rejects(verifyPublishedGallery(expected, async () => Response.json([])), /一覧/);
  await assert.rejects(verifyPublishedGallery([{ ...expected[0], comment: '新しいコメント' }], async () => Response.json(expected)), /コメント/);
});

test('publication checks that deleted image URLs no longer serve images', async () => {
  const edits = { deleted: [{ id: 'source-a', src: 'images/rooms/source-a.webp' }] };
  assert.equal(await verifyPublishedDeletions(edits, async (url, options) => {
    assert.ok(url.includes('?verify=')); assert.equal(options.method, 'HEAD'); assert.equal(options.cache, 'no-store');
    return new Response(null, { status: 404 });
  }), 1);
  await assert.rejects(verifyPublishedDeletions(edits, async () => new Response(null, { status: 200 })), /除去されていません/);
});
