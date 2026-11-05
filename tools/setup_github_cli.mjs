// Download the official GitHub CLI portable archive and verify its checksum.
import https from 'node:https';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
function fetchBytes(url, redirects = 0) {
  if (redirects > 8) throw new Error('Too many redirects');
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'classroom-reservation-setup', Accept: 'application/vnd.github+json' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume(); resolve(fetchBytes(new URL(response.headers.location, url), redirects + 1)); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode}: ${url}`)); return; }
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', reject);
    }).on('error', reject);
  });
}
const release = JSON.parse((await fetchBytes('https://api.github.com/repos/cli/cli/releases/latest')).toString('utf8'));
const archive = release.assets.find(asset => /^gh_[\d.]+_windows_amd64\.zip$/.test(asset.name));
const checksums = release.assets.find(asset => /^gh_[\d.]+_checksums\.txt$/.test(asset.name));
if (!archive || !checksums) throw new Error('Official Windows CLI archive not found');
const [bytes, sums] = await Promise.all([fetchBytes(archive.browser_download_url), fetchBytes(checksums.browser_download_url)]);
const entry = sums.toString('utf8').split(/\r?\n/).find(line => line.trim().endsWith(archive.name));
const expected = entry?.trim().split(/\s+/)[0];
const actual = createHash('sha256').update(bytes).digest('hex');
if (!expected || actual !== expected) throw new Error('GitHub CLI checksum mismatch');
await mkdir('tools/github-cli', { recursive: true });
await writeFile('tools/github-cli/gh.zip', bytes);
await writeFile('tools/github-cli/verified.json', JSON.stringify({ version: release.tag_name, archive: archive.name, source: archive.browser_download_url, sha256: actual }, null, 2));
console.log(`Verified official GitHub CLI ${release.tag_name}, ${bytes.length} bytes`);
