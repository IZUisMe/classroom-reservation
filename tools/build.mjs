import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
// Keep compiler scratch files in the project, not an unrelated Windows TEMP.
const temp = resolve('.build-temp');
mkdirSync(temp, { recursive: true });
const result = spawnSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build'], {
  stdio: 'inherit', env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
});
if (result.error) { console.error(result.error); process.exit(1); }
if (result.status !== 0) {
  console.error(`ビルドに失敗しました（Node ${process.version}）。Windowsでは起動用CMDから再実行してください。解決しない場合はNode.jsの最新24系へ更新してください。`);
}
process.exit(result.status === 0 ? 0 : 1);
