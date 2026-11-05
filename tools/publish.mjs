// Publish only administrator photo data; application source edits need a normal review/commit.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const repo = 'IZUisMe/classroom-reservation';
const portable = resolve('tools/github-cli/portable/bin/gh.exe');
const gh = process.env.GH_PATH || (existsSync(portable) ? portable : 'gh');
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})${capture ? `\n${result.stderr}` : ''}`);
  return capture ? result.stdout.trim() : '';
}
const dataFiles = ['public/data/admin-photos.json', 'public/data/rooms.json', 'public/data/photo-sources.json'];
try {
  const remote = run('git', ['remote', 'get-url', 'origin'], true);
  if (!/^https:\/\/github\.com\/IZUisMe\/classroom-reservation(?:\.git)?\/?$/i.test(remote)) throw new Error('Unexpected GitHub remote. Check origin before publishing.');
  if (run('git', ['branch', '--show-current'], true) !== 'main') throw new Error('Switch to main before publishing.');
  const manifest = JSON.parse(readFileSync('public/data/admin-photos.json', 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.photos)) throw new Error('Invalid administrator photo manifest');
  const photoFiles = manifest.photos.map(photo => {
    if (!/^images\/rooms\/admin-[0-9a-f-]+\.webp$/i.test(photo.src)) throw new Error('Unexpected administrator photo path');
    return `public/${photo.src}`;
  });
  const allowed = new Set([...dataFiles, ...photoFiles]);
  const staged = run('git', ['diff', '--cached', '--name-only'], true).split('\n').filter(Boolean);
  if (staged.some(path => !allowed.has(path))) throw new Error('Other files are staged. Commit or unstage them separately first.');
  run(gh, ['auth', 'status', '--hostname', 'github.com']);
  console.log('\nValidating photos and application…');
  run(process.execPath, ['--test', 'tests/model.test.mjs', 'tests/assets.test.mjs', 'tests/admin.test.mjs']);
  run(process.execPath, ['tools/build.mjs']);
  run('git', ['add', '--', ...allowed]);
  const changed = run('git', ['diff', '--cached', '--name-only'], true);
  if (changed) {
    run('git', ['diff', '--cached', '--stat']);
    run('git', ['commit', '-m', 'Update administrator classroom photos']);
  } else console.log('No new photo changes. Checking the published build.');
  const helperPath = gh.replaceAll('\\', '/');
  run('git', ['-c', 'credential.helper=', '-c', `credential.helper=!"${helperPath}" auth git-credential`, 'push', 'origin', 'main']);
  run(gh, ['workflow', 'run', 'pages.yml', '--ref', 'main', '--repo', repo]);
  console.log(`\nDeployment started: https://github.com/${repo}/actions\nSite: https://izuisme.github.io/classroom-reservation/`);
} catch (error) { console.error(`\nPublication stopped: ${error.message}`); process.exitCode = 1; }
