import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
const SITE = 'https://izuisme.github.io/classroom-reservation/';
const LIMIT = 64 * 1024;
const cleanLog = text => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]');
export function createPublishController(projectRoot, { spawnProcess = spawn, now = () => new Date().toISOString() } = {}) {
  const root = resolve(projectRoot);
  const bundled = resolve(process.env.USERPROFILE || homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe');
  const node = process.platform === 'win32' && existsSync(bundled) ? bundled : process.execPath;
  let job = { id: null, state: 'idle', logs: '', site: SITE, phase: '', startedAt: null, finishedAt: null };
  const status = () => ({ ...job });
  function append(text, target = job) {
    if (target !== job) return;
    const safe = cleanLog(text);
    job.logs = cleanLog(job.logs + safe).slice(-LIMIT);
    const phases = [...safe.matchAll(/\[(\d)\/6\]\s*([^\r\n]+)/g)];
    if (phases.length) job.phase = phases.at(-1)[2];
  }
  return {
    getStatus: status,
    isRunning: () => job.state === 'running',
    start() {
      if (job.state === 'running') { const error = new Error('公開処理は実行中です。'); error.status = 409; throw error; }
      job = { id: randomUUID(), state: 'running', logs: '公開処理を開始しました。\n', site: SITE, phase: '準備中', startedAt: now(), finishedAt: null };
      const activeJob = job;
      let child;
      try {
        child = spawnProcess(node, [resolve(root, 'tools/publish.mjs')], {
          cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
          env: { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
        });
      } catch (error) {
        append(`公開を開始できませんでした: ${error.message}\n`); job.state = 'failed'; job.finishedAt = now();
        return status();
      }
      const out = new StringDecoder('utf8'); const err = new StringDecoder('utf8');
      child.stdout?.on('data', chunk => append(out.write(chunk), activeJob));
      child.stderr?.on('data', chunk => append(err.write(chunk), activeJob));
      child.once('error', error => {
        if (job !== activeJob) return;
        append(`公開を開始できませんでした: ${error.message}\n`); job.state = 'failed'; job.phase = '失敗'; job.finishedAt = now();
      });
      child.once('close', code => {
        append(out.end(), activeJob); append(err.end(), activeJob);
        if (job !== activeJob || job.state !== 'running') return;
        job.state = code === 0 ? 'success' : 'failed';
        job.phase = code === 0 ? '公開完了' : '失敗'; job.finishedAt = now();
        if (code !== 0) append(`\n公開処理は停止しました（終了コード ${code}）。写真データはこのPCに残っています。\n`);
      });
      return status();
    },
  };
}
