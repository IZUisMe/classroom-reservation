// Fetch a pinned npm-registry archive without installing dependencies.
// Then run bundled Python tools/prepare_pdf_font.py to extract/normalize the TTF.
import https from 'node:https';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const url = 'https://registry.npmjs.org/@expo-google-fonts/noto-sans-jp/-/noto-sans-jp-0.4.4.tgz';
const expected = '1vl2U7uYG5JAXGERZaLMXtfOSgyOU4Qhq30OOPrbAHjOu8AW9Pral/qN9Anta9fjd6eVRTijiNqcgy2TowzrDA==';
const archive = await new Promise((resolve, reject) => {
  const request = https.get(url, response => {
    if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  });
  request.on('error', reject);
  request.setTimeout(90000, () => request.destroy(new Error('Font download timed out')));
});
if (createHash('sha512').update(archive).digest('base64') !== expected) throw new Error('Registry archive integrity mismatch');
await writeFile(new URL('./noto-sans-jp.tgz', import.meta.url), archive);
console.log('Verified pinned Noto Sans JP archive. Run bundled Python tools/prepare_pdf_font.py next.');
