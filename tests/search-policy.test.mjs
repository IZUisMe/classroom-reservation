import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve, join, sep } from 'node:path';

test('application and host-root landing page request exclusion from search and image previews', async () => {
  for (const file of ['index.html', 'docs/search-policy/index.html']) {
    const html = await readFile(file, 'utf8');
    const policy = html.match(/<meta name="robots" content="([^"]+)"/)[1].split(/,\s*/);
    for (const rule of ['noindex', 'nofollow', 'noimageindex', 'nosnippet', 'max-image-preview:none']) assert.ok(policy.includes(rule), `${file}: ${rule}`);
    assert.match(html, /<meta name="referrer" content="no-referrer"/);
  }
});

test('robots policies block actual image URLs while leaving HTML crawlable for noindex', async () => {
  const rooms = JSON.parse(await readFile('public/data/rooms.json', 'utf8'));
  for (const file of ['public/robots.txt', 'docs/search-policy/robots.txt']) {
    const text = await readFile(file, 'utf8');
    assert.match(text, /^User-agent: \*$/m);
    const denied = [...text.matchAll(/^Disallow:\s*(\S+)$/gm)].map(match => match[1]);
    const blocked = path => denied.some(prefix => path.startsWith(prefix));
    for (const path of ['/classroom-reservation/', '/classroom-reservation/index.html', '/classroom-reservation/assets/main.js']) assert.equal(blocked(path), false, `${file}: ${path}`);
    for (const image of rooms.flatMap(room => room.gallery)) assert.equal(blocked(`/classroom-reservation/${image.src}`), true, `${file}: ${image.src}`);
    assert.equal(blocked('/classroom-reservation/templates/application.pdf'), true);
    if (file.startsWith('docs/')) assert.equal(blocked('/another-project/images/example.webp'), false);
    else assert.equal(blocked('/images/rooms/example.webp'), true);
  }
});

test('direct HTML, image, PDF and JSON access works with noindex headers, including HEAD and errors', async t => {
  const parent = resolve('test-results');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'search-policy-'));
  const bytes = await readFile('public/images/rooms/31a-interior.webp');
  await mkdir(join(root, 'dist'));
  for (const [name, body] of [['index.html', '<!doctype html><title>Test</title>'], ['photo.webp', bytes], ['document.pdf', '%PDF-1.7'], ['data.json', '{}']]) await writeFile(join(root, 'dist', name), body);
  const child = spawn(process.execPath, [resolve('tools/serve.mjs')], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    assert.ok(root.startsWith(parent + sep + 'search-policy-'));
    await rm(root, { recursive: true, force: true });
  });
  const base = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10_000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); accept(match[0]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
  });
  for (const path of ['/', '/photo.webp', '/document.pdf', '/data.json', '/missing']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, path === '/missing' ? 404 : 200);
      assert.ok(response.headers.get('x-robots-tag').includes('noindex'));
      const body = Buffer.from(await response.arrayBuffer());
      if (method === 'HEAD') assert.equal(body.length, 0);
      else if (path === '/photo.webp') assert.deepEqual(body, bytes);
    }
  }
});
