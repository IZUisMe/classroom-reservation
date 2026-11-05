// This module is intentionally loaded with import('./pdf.js') only on PDF export.
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const BASE = import.meta.env?.BASE_URL || '/';
let assetsPromise;
const string = value => String(value ?? '').normalize('NFC').replace(/\r\n?/g, '\n');

export class PdfTextError extends Error {
  constructor(errors) {
    super(errors.map(error => error.message).join('\n'));
    this.name = 'PdfTextError';
    this.errors = errors;
  }
}

async function getAssets(onProgress) {
  if (!assetsPromise) {
    onProgress?.('PDF様式と日本語フォントを読み込んでいます…');
    assetsPromise = (async () => {
      const fetchAsset = async path => {
        const response = await fetch(`${BASE}${path}`);
        if (!response.ok) throw new Error(`PDF用ファイルを読み込めません (${response.status}): ${path}`);
        return response;
      };
      const [templateResponse, fontResponse, mapResponse] = await Promise.all([
        fetchAsset('templates/application.pdf'),
        fetchAsset('fonts/NotoSansJP-Regular.ttf'),
        fetchAsset('templates/application.fields.json'),
      ]);
      const [template, font, map] = await Promise.all([
        templateResponse.arrayBuffer(), fontResponse.arrayBuffer(), mapResponse.json(),
      ]);
      const fontBytes = new Uint8Array(font);
      return { template: new Uint8Array(template), fontBytes, map, metrics: fontkit.create(fontBytes) };
    })().catch(error => { assetsPromise = undefined; throw error; });
  }
  return assetsPromise;
}

// pdf-lib's custom-font widths use glyph advanceWidth, not canvas/browser fonts.
// Actual glyph bounds also protect ascenders, descenders and side overhangs.
function measure(text, font) {
  const glyphs = font.layout(text).glyphs;
  let advance = 0;
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  for (const glyph of glyphs) {
    const box = glyph.bbox;
    left = Math.min(left, advance + box.minX);
    right = Math.max(right, advance + box.maxX);
    top = Math.max(top, box.maxY);
    bottom = Math.min(bottom, box.minY);
    advance += glyph.advanceWidth;
  }
  return { width: Math.max(advance, right) - left, left, top, bottom };
}

function wrapText(text, width, font, scale, wrap) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (!wrap) {
      lines.push(paragraph);
      continue;
    }
    let line = '';
    // Grapheme clusters prevent splitting combining characters or surrogate pairs.
    const segments = typeof Intl.Segmenter === 'function'
      ? Array.from(new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(paragraph), item => item.segment)
      : Array.from(paragraph);
    for (const segment of segments) {
      if (line && measure(line + segment, font).width * scale > width) {
        lines.push(line);
        line = segment;
      } else {
        line += segment;
      }
    }
    lines.push(line);
  }
  return lines;
}

function fitText(text, field, font) {
  if (!text) return { lines: [], size: field.size, height: 0 };
  // Bounds are inset from the original lines; nothing is erased or clipped.
  const padding = 1.5;
  const width = field.width - padding * 2;
  const height = field.height - padding * 2;
  for (let step = Math.round(field.size * 10); step >= Math.round(field.minSize * 10); step--) {
    const size = step / 10;
    const scale = size / font.unitsPerEm;
    const lines = wrapText(text, width, font, scale, field.wrap).map(value => ({ value, ...measure(value, font) }));
    if (lines.some(line => line.width * scale > width + 0.001)) continue;
    const lineGap = size * 0.18;
    const textHeight = lines.reduce((total, line) => total + Math.max(line.top - line.bottom, font.unitsPerEm * 0.8) * scale, 0)
      + Math.max(0, lines.length - 1) * lineGap;
    if (textHeight <= height + 0.001) return { lines, size, scale, lineGap, height: textHeight, padding };
  }
  return null;
}

function parseDate(value) {
  const text = string(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) return null;
  return { year: Number(text.slice(0, 4)), month: Number(text.slice(5, 7)), day: Number(text.slice(8, 10)), weekday: '日月火水木金土'[date.getUTCDay()] };
}

function buildLayout(data, rooms, assets) {
  const { map, metrics: font } = assets;
  const errors = [];
  const layout = [];
  const addError = (field, message) => errors.push({ field, message });
  const add = (key, value, field) => {
    const text = string(value);
    // Missing glyphs must be reported, never emitted as tofu or silently removed.
    const missing = [...new Set(Array.from(text).filter(char => char !== '\n' && !font.hasGlyphForCodePoint(char.codePointAt(0))))];
    if (missing.length) {
      addError(key, `${field.label}にPDFで表示できない文字があります: ${missing.map(char => `${char} (U+${char.codePointAt(0).toString(16).toUpperCase()})`).join('、')}`);
      return;
    }
    if (!field.wrap && text.includes('\n')) {
      addError(key, `${field.label}は改行せずに入力してください。`);
      return;
    }
    const fitted = fitText(text, field, font);
    if (!fitted) {
      addError(key, `${field.label}がPDFの記入欄に収まりません。短くしてください（最小${field.minSize}pt）。`);
      return;
    }
    layout.push({ key, field, ...fitted });
  };
  const issueDate = parseDate(data?.issueDate);
  if (!issueDate) addError('issueDate', '発行日を正しい日付で入力してください。');
  else {
    add('issueDate', issueDate.year, map.fields.issueYear);
    add('issueDate', issueDate.month, map.fields.issueMonth);
    add('issueDate', issueDate.day, map.fields.issueDay);
  }
  const profile = data?.profile || {};
  add('organization', data?.organization, map.fields.organization);
  add('profile.studentId', profile.studentId, map.fields.studentId);
  add('profile.name', profile.name, map.fields.name);
  add('profile.phone', profile.phone, map.fields.phone);
  add('purpose', data?.purpose, map.fields.purpose);
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  if (entries.length < 1 || entries.length > 9) addError('entries', 'PDFに記入できる予約は1〜9件です。');
  entries.slice(0, 9).forEach((entry, index) => {
    const row = index + 1;
    const date = parseDate(entry.date);
    if (!date) addError(`entries.${index}.date`, `${row}件目の日付が正しくありません。`);
    const room = (rooms || []).find(room => string(room.id) === string(entry.roomId));
    if (!room) addError(`entries.${index}.roomId`, `${row}件目の教室が見つかりません。`);
    const validTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(string(value));
    if (!validTime(entry.start) || !validTime(entry.end)) addError(`entries.${index}.time`, `${row}件目の時刻が正しくありません。`);
    const values = {
      date: date ? `${date.month}月${date.day}日(${date.weekday})` : '',
      time: `${string(entry.start)} 〜 ${string(entry.end)}`,
      place: room?.name || '',
      people: string(entry.people) ? `${string(entry.people)}人` : '',
      external: entry.external,
      remarks: entry.remarks,
    };
    const paths = { date: 'date', time: 'time', place: 'roomId', people: 'people', external: 'external', remarks: 'remarks' };
    for (const [column, value] of Object.entries(values)) {
      const field = { ...map.table.columns[column], y: map.table.rowBottoms[index], height: map.table.rowTops[index] - map.table.rowBottoms[index] };
      field.label = `${row}件目の${field.label}`;
      add(`entries.${index}.${paths[column]}`, value, field);
    }
  });
  return { errors, layout };
}

/** Exact asynchronous font/box validation. UI validation remains the caller's job.
 * @returns {Promise<Array<{field: string, message: string}>>}
 */
export async function validatePdfText(data, rooms) {
  const assets = await getAssets();
  return buildLayout(data, rooms, assets).errors;
}

/** Create one A4 portrait page; no uploads, browser print or canvas conversion.
 * @param {object} data Application form data (1–9 entries).
 * @param {Array<{id:string,name:string}>} rooms Room catalog.
 * @param {(message:string)=>void} [onProgress] Human-readable progress.
 * @returns {Promise<Uint8Array>}
 */
export async function createApplicationPdf(data, rooms, onProgress) {
  const assets = await getAssets(onProgress);
  onProgress?.('記入欄と日本語文字を確認しています…');
  const { errors, layout } = buildLayout(data, rooms, assets);
  if (errors.length) throw new PdfTextError(errors);
  const document = await PDFDocument.load(assets.template, { updateMetadata: false });
  if (document.getPageCount() !== 1) throw new Error('PDF様式は1ページである必要があります。');
  const page = document.getPage(0);
  const size = page.getSize();
  if (Math.abs(size.width - assets.map.page.width) > 0.1 || Math.abs(size.height - assets.map.page.height) > 0.1) {
    throw new Error('PDF様式と記入位置の版が一致しません。');
  }
  document.registerFontkit(fontkit);
  onProgress?.('日本語フォントを埋め込み、PDFを作成しています…');
  const font = await document.embedFont(assets.fontBytes, { subset: true });
  for (const item of layout) {
    const { field, lines, scale, size: fontSize, lineGap, height } = item;
    let top = field.y + (field.height + height) / 2;
    for (const line of lines) {
      const actualHeight = Math.max(line.top - line.bottom, assets.metrics.unitsPerEm * 0.8) * scale;
      const y = top - line.top * scale;
      const x = field.x + (field.width - line.width * scale) / 2 - line.left * scale;
      if (line.value) page.drawText(line.value, { x, y, font, size: fontSize, color: rgb(0, 0, 0) });
      top -= actualHeight + lineGap;
    }
  }
  // Only deliberate application metadata; no source workbook author or user PII.
  document.setTitle('学内施設使用許可願');
  document.setAuthor('');
  document.setSubject('学内施設使用申請');
  document.setKeywords([]);
  document.setCreator('Classroom application');
  document.setProducer('Classroom application / pdf-lib');
  document.setCreationDate(new Date());
  document.setModificationDate(new Date());
  const bytes = await document.save();
  onProgress?.('PDFを作成しました。');
  return bytes;
}
