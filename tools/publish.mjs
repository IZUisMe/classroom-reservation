// Publish only administrator photo data; application source edits need a normal review/commit.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = 'IZUisMe/classroom-reservation';
const site = 'https://izuisme.github.io/classroom-reservation/';
const portable = resolve('tools/github-cli/portable/bin/gh.exe');
const gh = process.env.GH_PATH || (existsSync(portable) ? portable : 'gh');
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})${capture ? `\n${result.stderr}` : ''}`);
  return capture ? result.stdout.trim() : '';
}
export function workflowRunId(output) {
  return output.match(/github\.com\/IZUisMe\/classroom-reservation\/actions\/runs\/(\d+)/i)?.[1] || null;
}
/** Check both the public manifest and actual uploaded image bytes. No local files are changed. */
export async function verifyPublishedPhotos(manifest, fetcher = fetch) {
  const stamp = Date.now();
  const response = await fetcher(`${site}data/admin-photos.json?verify=${stamp}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`公開写真台帳を確認できません (${response.status})`);
  const published = await response.json();
  if (!Array.isArray(published.photos)) throw new Error('公開写真台帳の形式が不正です。');
  for (const photo of manifest.photos) {
    const remote = published.photos.find(item => item.id === photo.id);
    if (!remote || remote.sha256 !== photo.sha256 || remote.src !== photo.src || remote.roomId !== photo.roomId) throw new Error(`写真が公開台帳へまだ反映されていません: ${photo.id}`);
    const image = await fetcher(`${site}${photo.src}?verify=${stamp}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    if (!image.ok) throw new Error(`公開画像を取得できません (${image.status}): ${photo.id}`);
    const hash = createHash('sha256').update(Buffer.from(await image.arrayBuffer())).digest('hex');
    if (hash !== photo.sha256) throw new Error(`公開画像の内容が一致しません: ${photo.id}`);
  }
  return manifest.photos.length;
}
export async function publish() {
  const dataFiles = ['public/data/admin-photos.json', 'public/data/rooms.json', 'public/data/photo-sources.json'];
  const remote = run('git', ['remote', 'get-url', 'origin'], true);
  if (!/^https:\/\/github\.com\/IZUisMe\/classroom-reservation(?:\.git)?\/?$/i.test(remote)) throw new Error('公開先が設定と異なります。Gitのoriginを確認してください。');
  if (run('git', ['branch', '--show-current'], true) !== 'main') throw new Error('mainブランチへ切り替えてください。');
  const snapshot = readFileSync(dataFiles[0], 'utf8');
  const manifest = JSON.parse(snapshot);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.photos)) throw new Error('写真台帳の形式が不正です。');
  const photoFiles = manifest.photos.map(photo => {
    if (!/^images\/rooms\/admin-[0-9a-f-]+\.webp$/i.test(photo.src)) throw new Error('管理者写真の保存先が不正です。');
    return `public/${photo.src}`;
  });
  const allowed = new Set([...dataFiles, ...photoFiles]);
  const staged = run('git', ['diff', '--cached', '--name-only'], true).split('\n').filter(Boolean);
  if (staged.some(path => !allowed.has(path))) throw new Error('写真以外のファイルがステージされています。別途コミットするか、ステージから外してください。');
  console.log(`実行環境: Node ${process.version}`);
  console.log('\n[1/6] GitHub認証を確認しています…');
  run(gh, ['auth', 'status', '--hostname', 'github.com']);
  console.log('\n[2/6] 写真データとアプリを検査しています…');
  run(process.execPath, ['--test', 'tests/model.test.mjs', 'tests/assets.test.mjs', 'tests/admin.test.mjs', 'tests/publish.test.mjs']);
  run(process.execPath, ['tools/build.mjs']);
  if (readFileSync(dataFiles[0], 'utf8') !== snapshot) throw new Error('公開準備中に写真が追加されました。追加を終えてから、もう一度実行してください。');
  console.log('\n[3/6] 写真の変更を保存しています…');
  run('git', ['add', '--', ...allowed]);
  const changed = run('git', ['diff', '--cached', '--name-only'], true);
  if (changed) {
    run('git', ['diff', '--cached', '--stat']);
    run('git', ['commit', '-m', 'Update administrator classroom photos']);
  } else console.log('写真の変更は保存済みです。公開状態を確認します。');
  console.log('\n[4/6] GitHubへ送信しています…');
  const helperPath = gh.replaceAll('\\', '/');
  run('git', ['-c', 'credential.helper=', '-c', `credential.helper=!"${helperPath}" auth git-credential`, 'push', 'origin', 'main']);
  console.log('\n[5/6] 公開処理が完了するまで待機しています。ウィンドウを閉じないでください…');
  const dispatched = run(gh, ['workflow', 'run', 'pages.yml', '--ref', 'main', '--repo', repo], true);
  console.log(dispatched);
  let runId = workflowRunId(dispatched);
  if (!runId) {
    const sha = run('git', ['rev-parse', 'HEAD'], true);
    const runs = JSON.parse(run(gh, ['run', 'list', '--workflow', 'pages.yml', '--branch', 'main', '--limit', '5', '--json', 'databaseId,headSha,event', '--repo', repo], true));
    runId = runs.find(item => item.headSha === sha && item.event === 'workflow_dispatch')?.databaseId;
  }
  if (!runId) throw new Error(`公開処理の開始はできましたが、実行IDを取得できませんでした。https://github.com/${repo}/actions を確認してください。`);
  run(gh, ['run', 'watch', String(runId), '--repo', repo, '--exit-status', '--interval', '5']);
  console.log('\n[6/6] 公開サイトの写真を確認しています…');
  const count = await verifyPublishedPhotos(manifest);
  console.log(`\n公開が完了しました。管理者追加写真 ${count} 枚の反映を確認しました。\n${site}\nブラウザで再読み込みしてください。`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await publish(); }
  catch (error) { console.error(`\n公開を中止しました: ${error.message}\n追加済みの写真はこのPCに残っています。画面のエラーを確認してください。`); process.exitCode = 1; }
}
