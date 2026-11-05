// Lightweight screen-only approximation. The export module remains the authority
// for font/glyph/overflow validation and is deliberately never imported here.
const BASE = import.meta.env?.BASE_URL || '/';
const SVG_NS = 'http://www.w3.org/2000/svg';
const FONT = 'sans-serif';
let previewInstance = 0;
const normalize = value => String(value ?? '').normalize('NFC').replace(/\r\n?/g, '\n');
const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : null;
const graphemes = text => segmenter
  ? Array.from(segmenter.segment(text), item => item.segment) : Array.from(text);

function element(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function parseDate(value) {
  const text = normalize(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) return null;
  return { year: Number(text.slice(0, 4)), month: Number(text.slice(5, 7)), day: Number(text.slice(8, 10)), weekday: '日月火水木金土'[date.getUTCDay()] };
}

// Match the PDF's box padding, font-size search, wrapping and centered layout,
// while measuring the local browser font rather than downloading the PDF font.
function fitText(context, text, field) {
  const width = field.width - 3;
  const height = field.height - 3;
  const measure = value => {
    const metrics = context.measureText(value);
    const left = Math.max(0, metrics.actualBoundingBoxLeft || 0);
    const right = Math.max(metrics.width, metrics.actualBoundingBoxRight || 0);
    return {
      value, left, width: left + right,
      ascent: Math.max(0, metrics.actualBoundingBoxAscent ?? currentSize * 0.8),
      descent: Math.max(0, metrics.actualBoundingBoxDescent ?? currentSize * 0.2),
    };
  };
  let currentSize = field.size;
  const layout = size => {
    currentSize = size;
    context.font = `${size}px ${FONT}`;
    const lines = [];
    for (const paragraph of text.split('\n')) {
      if (!field.wrap) { lines.push(measure(paragraph)); continue; }
      let line = '';
      for (const segment of graphemes(paragraph)) {
        if (line && measure(line + segment).width > width) {
          lines.push(measure(line));
          line = segment;
        } else line += segment;
      }
      lines.push(measure(line));
    }
    for (const line of lines) line.height = Math.max(size * 0.8, line.ascent + line.descent);
    return { size, lines, gap: size * 0.18, height: lines.reduce((sum, line) => sum + line.height, 0) + Math.max(0, lines.length - 1) * size * 0.18 };
  };
  let fitted;
  for (let step = Math.round(field.size * 10); step >= Math.round(field.minSize * 10); step--) {
    fitted = layout(step / 10);
    if (fitted.height <= height && fitted.lines.every(line => line.width <= width)) return fitted;
  }
  // Screen preview only: signal overflow with an ellipsis, never mutate data.
  // Real PDF export rejects text that cannot fit instead of truncating it.
  const visible = [];
  let used = 0;
  for (const line of fitted.lines) {
    const next = used + (visible.length ? fitted.gap : 0) + line.height;
    if (next > height && visible.length) break;
    visible.push(line);
    used = next;
    if (next > height) break;
  }
  const truncated = visible.length < fitted.lines.length || fitted.height > height;
  for (let i = 0; i < visible.length; i++) {
    if (visible[i].width > width || (truncated && i === visible.length - 1)) {
      const parts = graphemes(visible[i].value);
      while (parts.length && measure(parts.join('') + '…').width > width) parts.pop();
      visible[i] = measure(parts.join('') + '…');
      visible[i].height = Math.max(fitted.size * 0.8, visible[i].ascent + visible[i].descent);
    }
  }
  fitted.lines = visible;
  fitted.height = visible.reduce((sum, line) => sum + line.height, 0) + Math.max(0, visible.length - 1) * fitted.gap;
  return fitted;
}

/**
 * Initialize an official-form preview without loading PDF libraries or fonts.
 * @param {HTMLElement} container The #application-preview host.
 * @returns {Promise<{update(data: object, rooms: Array): void, setActive(fieldOrIndex: string|number|null): void, destroy(): void}>}
 */
export async function initPreview(container) {
  if (!container?.append) throw new TypeError('プレビューの表示先が見つかりません。');
  const response = await fetch(`${BASE}templates/application.fields.json`);
  if (!response.ok) throw new Error(`プレビューの記入位置を読み込めません (${response.status})。`);
  const map = await response.json();
  const { width, height } = map.page;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) throw new Error('プレビューの文字計測を利用できません。');
  const svg = element('svg', {
    viewBox: `0 0 ${width} ${height}`, width, height,
    role: 'img', 'aria-label': '学内施設使用許可願のプレビュー',
    class: 'application-preview-svg',
  });
  svg.style.cssText = 'display:block;width:100%;height:auto;background:white;';
  const title = element('title');
  title.textContent = '学内施設使用許可願 — 入力内容のプレビュー';
  const description = element('desc');
  description.textContent = '公式様式の上に入力内容を表示しています。画面のフォントはPDFと異なります。収まらない文字は画面上のみ省略され、PDF出力時に検証されます。';
  const image = element('image', {
    href: `${BASE}templates/application-preview.webp`, x: 0, y: 0,
    width, height, preserveAspectRatio: 'none',
  });
  // A per-instance luminance mask leaves the union of all active boxes clear.
  // The spotlight is painted after both the background and dynamic text, so
  // text outside the active boxes dims too; text inside the holes is untouched.
  const maskId = `preview-spotlight-${++previewInstance}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
  const definitions = element('defs');
  const mask = element('mask', {
    id: maskId, maskUnits: 'userSpaceOnUse', maskContentUnits: 'userSpaceOnUse',
    x: 0, y: 0, width, height, 'mask-type': 'luminance',
  });
  const maskHoles = element('g', { fill: '#000' });
  mask.append(element('rect', { x: 0, y: 0, width, height, fill: '#fff' }), maskHoles);
  definitions.append(mask);
  const textLayer = element('g', { 'font-family': FONT, fill: '#111', 'pointer-events': 'none' });
  const highlight = element('g', { 'aria-hidden': 'true', 'pointer-events': 'none' });
  highlight.style.opacity = '0';
  const spotlight = element('rect', {
    x: 0, y: 0, width, height, fill: '#000', 'fill-opacity': '0.42',
    mask: `url(#${maskId})`, 'data-preview-spotlight': 'true',
  });
  const activeBoxes = element('g');
  svg.append(title, description, definitions, image, textLayer, highlight);
  container.append(svg);
  let destroyed = false;
  let highlightAnimation = null;
  let highlightTarget = 0;
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const clearHighlight = () => {
    highlight.replaceChildren();
    activeBoxes.replaceChildren();
    maskHoles.replaceChildren();
  };
  const fadeHighlight = target => {
    // Repeated blur events must not restart (or postpone) the pending cleanup.
    if (target === highlightTarget && !reducedMotion?.matches) return;
    highlightTarget = target;
    // Sample the presentation value before canceling, so reversing a fade never
    // jumps to an endpoint, including focusout/focusin in the same event turn.
    const opacity = Number.parseFloat(getComputedStyle(highlight).opacity);
    highlightAnimation?.cancel();
    highlightAnimation = null;
    highlight.style.opacity = String(target);
    if (reducedMotion?.matches || !highlight.animate || opacity === target) {
      if (!target) clearHighlight();
      return;
    }
    const animation = highlight.animate([{ opacity }, { opacity: target }], {
      duration: 200, easing: 'ease-out',
    });
    highlightAnimation = animation;
    animation.onfinish = () => {
      if (destroyed || highlightAnimation !== animation) return;
      highlightAnimation = null;
      if (!target) clearHighlight();
    };
  };

  const draw = (value, field) => {
    const text = normalize(value);
    if (!text) return;
    const fitted = fitText(context, text, field);
    let top = height - field.y - (field.height + fitted.height) / 2;
    for (const line of fitted.lines) {
      if (line.value) {
        const node = element('text', {
          x: field.x + (field.width - line.width) / 2 + line.left,
          y: top + line.ascent, 'font-size': fitted.size,
          'xml:space': 'preserve',
        });
        node.style.whiteSpace = 'pre';
        node.textContent = line.value;
        textLayer.append(node);
      }
      top += line.height + fitted.gap;
    }
  };

  const columns = Object.values(map.table.columns);
  const tableX = Math.min(...columns.map(column => column.x));
  const tableRight = Math.max(...columns.map(column => column.x + column.width));
  const rowBox = index => ({
    x: tableX, y: map.table.rowBottoms[index], width: tableRight - tableX,
    height: map.table.rowTops[index] - map.table.rowBottoms[index],
  });
  function setActive(fieldOrIndex) {
    if (destroyed) return;
    let boxes = [];
    const field = typeof fieldOrIndex === 'string' ? fieldOrIndex : '';
    const rowMatch = /^entries\.(\d+)(?:\.|$)/.exec(field);
    const row = typeof fieldOrIndex === 'number' ? fieldOrIndex : rowMatch ? Number(rowMatch[1]) : null;
    if (Number.isInteger(row) && row >= 0 && row < map.table.rowTops.length) boxes = [rowBox(row)];
    else if (field === 'entries') {
      const last = map.table.rowBottoms.length - 1;
      // The official header is approximately 24 PDF points high (shorter
      // than the 27.891pt entry rows); measured against the retained raster.
      const headerTop = map.table.rowTops[0] + 24;
      boxes = [{ x: tableX, y: map.table.rowBottoms[last], width: tableRight - tableX, height: headerTop - map.table.rowBottoms[last] }];
    } else if (field === 'issueDate') boxes = [map.fields.issueYear, map.fields.issueMonth, map.fields.issueDay];
    else if (field === 'profile') boxes = [map.fields.studentId, map.fields.name, map.fields.phone];
    else {
      const key = field.startsWith('profile.') ? field.slice(8) : field;
      if (Object.hasOwn(map.fields, key)) boxes = [map.fields[key]];
    }
    if (!boxes.length) {
      fadeHighlight(0);
      return;
    }
    // Keep the overlay and its opacity timeline when switching active fields.
    // Only the clear holes and the soft red boxes need new geometry.
    maskHoles.replaceChildren();
    activeBoxes.replaceChildren();
    if (!spotlight.parentNode) highlight.append(spotlight, activeBoxes);
    for (const box of boxes) {
      const bounds = { x: box.x, y: height - box.y - box.height, width: box.width, height: box.height };
      maskHoles.append(element('rect', bounds));
      activeBoxes.append(element('rect', {
        ...bounds, fill: '#f43f5e', 'fill-opacity': '0.055',
        stroke: '#e65b72', 'stroke-opacity': '0.65', 'stroke-width': '1', rx: '1',
        'vector-effect': 'non-scaling-stroke', 'data-preview-active': 'true',
      }));
    }
    fadeHighlight(1);
  }

  function update(data = {}, rooms = []) {
    if (destroyed) return;
    textLayer.replaceChildren();
    const issueDate = parseDate(data?.issueDate);
    if (issueDate) {
      draw(issueDate.year, map.fields.issueYear);
      draw(issueDate.month, map.fields.issueMonth);
      draw(issueDate.day, map.fields.issueDay);
    }
    const profile = data?.profile || {};
    draw(data?.organization, map.fields.organization);
    draw(profile.studentId, map.fields.studentId);
    draw(profile.name, map.fields.name);
    draw(profile.phone, map.fields.phone);
    draw(data?.purpose, map.fields.purpose);
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    entries.slice(0, 9).forEach((entry, index) => {
      if (!entry) return;
      const date = parseDate(entry.date);
      const room = (Array.isArray(rooms) ? rooms : []).find(room => normalize(room.id) === normalize(entry.roomId));
      const start = normalize(entry.start);
      const end = normalize(entry.end);
      const values = {
        date: date ? `${date.month}月${date.day}日(${date.weekday})` : '',
        // Unlike a completed PDF, an empty live row has no decorative fake time.
        time: start || end ? `${start} 〜 ${end}` : '',
        place: room?.name || '',
        people: normalize(entry.people) ? `${normalize(entry.people)}人` : '',
        external: entry.external, remarks: entry.remarks,
      };
      for (const [column, value] of Object.entries(values)) draw(value, {
        ...map.table.columns[column], y: map.table.rowBottoms[index],
        height: map.table.rowTops[index] - map.table.rowBottoms[index],
      });
    });
  }

  return {
    update, setActive,
    destroy() {
      destroyed = true;
      highlightAnimation?.cancel();
      highlightAnimation = null;
      clearHighlight();
      svg.remove();
    },
  };
}
