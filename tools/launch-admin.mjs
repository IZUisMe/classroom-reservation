import { spawn } from 'node:child_process';
import { createAdminServer } from './admin-server.mjs';
const url = 'http://127.0.0.1:4174';
async function existingServer() {
  try {
    const response = await fetch(`${url}/api/bootstrap`, { signal: AbortSignal.timeout(1000) });
    const data = await response.json();
    return response.ok && Array.isArray(data.rooms) && typeof data.csrfToken === 'string' ? data : null;
  } catch { return false; }
}
function openBrowser() {
  if (process.env.CLASSROOM_NO_BROWSER === '1') return;
  if (process.platform === 'win32') {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', url], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.log(`ブラウザで ${url} を開いてください。`)); child.unref();
  } else console.log(`ブラウザで ${url} を開いてください。`);
}
try {
  const existing = await existingServer();
  if (existing && existing.version !== 3) throw new Error('旧バージョンの管理サーバーが起動中です。以前の管理画面の起動用ウィンドウで Ctrl+C を押して終了してから、もう一度「管理画面.cmd」を起動してください。');
  if (existing) {
    console.log(`管理画面は起動済みです: ${url}`); openBrowser();
  } else {
    const app = await createAdminServer();
    await app.listen();
    console.log(`写真管理画面: ${url}\nこのPC専用です。停止: Ctrl+C`); openBrowser();
    process.once('SIGINT', async () => { await app.close(); process.exit(0); });
    process.once('SIGTERM', async () => { await app.close(); process.exit(0); });
  }
} catch (error) {
  console.error(`管理画面を起動できませんでした: ${error.message}`);
  process.exitCode = 1;
}
