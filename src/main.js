import './style.css';
import { MAX_ENTRIES, DEFAULT_PURPOSE, STORAGE_KEYS, initialState, blankProfile, newEntry, escapeHtml as h, sanitizeState, readStorage, writeStorage, validateApplication, validateProfile, formatDate, todayJst } from './model.js';
import { initPreview } from './preview.js';

const $ = id => document.getElementById(id);
let state = initialState();
let rooms = [];
let rememberDraft = true;
let rememberProfile = true;
let history = [];
let saveTimer;
let toastTimer;
let pdfUrl;
let busy = false;
let preview;
let activeEntry = null;
const roomById = id => rooms.find(r => r.id === id);
const safeAsset = src => typeof src === 'string' && /^images\/rooms\/[a-zA-Z0-9_./-]+$/.test(src) && !src.includes('..') ? new URL(src, document.baseURI).href : '';
// Mail-related legacy data stays in drafts, but is not part of the current UI.
const currentProfileErrors = profile => validateProfile({ ...profile, emailTo: '', emailCc: '' });

function notify(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}
function profilelessSnapshot() {
  const copy = structuredClone(state);
  delete copy.profile;
  return copy;
}
function savePreferences() {
  return writeStorage(STORAGE_KEYS.settings, { version: 1, rememberDraft, rememberProfile });
}
function persist() {
  clearTimeout(saveTimer);
  const results = [];
  if (rememberDraft) results.push(writeStorage(STORAGE_KEYS.draft, { version: 1, data: profilelessSnapshot() }));
  if (rememberProfile) results.push(writeStorage(STORAGE_KEYS.profile, { version: 1, profile: state.profile }));
  if (!results.length) return;
  const success = results.every(Boolean);
  $('storage-status').textContent = success ? '保存済み' : '保存できませんでした。';
  $('storage-status').classList.toggle('warning', !success);
}
function changed() {
  clearErrors();
  if (pdfUrl) { URL.revokeObjectURL(pdfUrl); pdfUrl = null; $('download-again').hidden = true; }
  if (!busy) $('pdf-status').textContent = '';
  updateControls();
  preview?.update(state, rooms);
  clearTimeout(saveTimer);
  if (rememberDraft || rememberProfile) saveTimer = setTimeout(persist, 350);
}
function renderCommon() {
  for (const key of ['organization', 'purpose', 'issueDate']) $(key).value = state[key];
  for (const key of ['name', 'studentId', 'phone']) $(`profile-${key}`).value = state.profile[key];
}
function roomOptions(selected) {
  const groups = new Map();
  for (const r of rooms) {
    const label = r.building ? `${r.building}号館` : 'その他';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(r);
  }
  return '<option value="">選択</option>' + [...groups].map(([name, list]) => `<optgroup label="${h(name)}">${list.map(r => `<option value="${h(r.id)}" ${r.id === selected ? 'selected' : ''}>${h(r.name)}${r.capacity ? `（定員${h(r.capacity)}人）` : ''}</option>`).join('')}</optgroup>`).join('');
}
function entryField(i, key, label, attrs = '') {
  return `<div class="field"><label for="entry-${i}-${key}">${label} <span class="required">必須</span></label><input id="entry-${i}-${key}" data-entry="${i}" data-key="${key}" value="${h(state.entries[i][key])}" ${attrs} required></div>`;
}
function roomGallery(room) {
  const gallery = Array.isArray(room?.gallery) ? room.gallery : ['interior', 'exterior'].map(kind => room?.images?.[kind] && { ...room.images[kind], kind }).filter(Boolean);
  return gallery.filter(image => safeAsset(image.src));
}
function roomPhotos(id, index) {
  const room = roomById(id);
  const images = roomGallery(room);
  return `<div class="photo-strip" tabindex="0" role="region" aria-label="${h(room ? `${room.name}の写真` : '教室写真')}">${images.length ? images.map((image, photoIndex) => {
    const label = `${room.name}の${image.kind === 'exterior' ? '外観' : '室内'}写真 ${photoIndex + 1}`;
    const dimensions = Number(image.width) > 0 && Number(image.height) > 0 ? `width="${Number(image.width)}" height="${Number(image.height)}"` : '';
    return `<figure class="photo-slide"><button type="button" class="photo-open" data-action="photo" data-index="${index}" data-photo-index="${photoIndex}" aria-label="${h(label)}を拡大"><img src="${h(safeAsset(image.src))}" alt="${h(label)}" ${dimensions} loading="lazy" decoding="async" draggable="false"></button></figure>`;
  }).join('') : `<div class="photo-empty">${room ? '写真なし' : '教室を選択'}</div>`}</div>`;
}
function capacityWarning(index) {
  const entry = state.entries[index];
  const capacity = roomById(entry.roomId)?.capacity;
  return capacity && Number(entry.people) > capacity ? '<p class="room-warning">定員超過</p>' : '';
}
function renderEntries(focusId) {
  $('entries').innerHTML = state.entries.map((entry, i) => `<article class="entry panel${activeEntry === i ? ' is-active' : ''}" aria-labelledby="entry-heading-${i}" data-card-index="${i}"><div class="entry-heading"><h3 id="entry-heading-${i}" class="entry-number">${i + 1}件目</h3><div class="entry-actions"><button type="button" class="text-button" data-action="duplicate" data-index="${i}" ${state.entries.length >= MAX_ENTRIES ? 'disabled' : ''} aria-label="${i + 1}件目を複製">複製</button><button type="button" class="text-button danger" data-action="remove" data-index="${i}" ${state.entries.length === 1 ? 'disabled' : ''} aria-label="${i + 1}件目を削除">削除</button></div></div>
    <p class="room-label">教室 <span class="required">必須</span></p><div id="photos-${i}">${roomPhotos(entry.roomId, i)}</div>
    <div class="field-grid room-people"><div class="field room-select"><label for="entry-${i}-roomId">教室 <span class="required">必須</span></label><select id="entry-${i}-roomId" data-entry="${i}" data-key="roomId" required>${roomOptions(entry.roomId)}</select></div>${entryField(i, 'people', '人数', 'type="number" min="1" max="9999" step="1" inputmode="numeric"')}</div>
    <div id="capacity-warning-${i}" aria-live="polite">${capacityWarning(i)}</div>
    <div class="field-grid date-time">${entryField(i, 'date', '使用日', 'type="date" min="1900-01-01" max="9999-12-31"')}${entryField(i, 'start', '開始', 'type="time" step="60"')}${entryField(i, 'end', '終了', 'type="time" step="60"')}</div>
    <details><summary>学外参加者・備考</summary><div class="details-body"><div class="field"><label for="entry-${i}-external">学外参加者（校）</label><input id="entry-${i}-external" data-entry="${i}" data-key="external" value="${h(entry.external)}" maxlength="80"></div><div class="field"><label for="entry-${i}-remarks">備考</label><input id="entry-${i}-remarks" data-entry="${i}" data-key="remarks" value="${h(entry.remarks)}" maxlength="100"></div></div></details></article>`).join('');
  $('add-entry').disabled = state.entries.length >= MAX_ENTRIES;
  updateControls();
  if (focusId) $(focusId)?.focus();
}
function updateControls() {
  const count = `${state.entries.length}/${MAX_ENTRIES}`;
  $('entry-count').textContent = count;
  $('mobile-count').textContent = count;
  $('student-profile').dataset.ready = String(!currentProfileErrors(state.profile).length);
}
function setActive(field) {
  const match = typeof field === 'string' && field.match(/^entry-(\d+)-/);
  activeEntry = match ? Number(match[1]) : typeof field === 'number' ? field : null;
  document.querySelectorAll('[data-card-index]').forEach(card => card.classList.toggle('is-active', Number(card.dataset.cardIndex) === activeEntry));
  preview?.setActive(activeEntry ?? (typeof field === 'string' && field.startsWith('profile-') ? field.replace('profile-', 'profile.') : field));
}
function syncFocusedField() {
  const field = document.activeElement;
  setActive(field?.matches('#application-form input:not([type=checkbox]):not([type=hidden]), #application-form select, #application-form textarea') ? field.id : null);
}
function renderHistory() {
  $('history-list').innerHTML = history.length ? history.map((item, i) => `<div class="history-item"><button type="button" data-history="${i}">${h(item.data.purpose || '申請書')}</button><small>${h(formatDate(item.createdAt?.slice(0, 10) || ''))} · ${item.data.entries?.length || 0}件</small></div>`).join('') : '<p class="hint">履歴なし</p>';
}
function clearErrors() {
  $('error-summary').hidden = true;
  document.querySelectorAll('[data-field-error]').forEach(el => el.remove());
  $('application-form').querySelectorAll('[aria-invalid]').forEach(el => { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); });
}
function showErrors(errors) {
  clearErrors();
  $('error-summary').innerHTML = `<strong>入力を確認</strong><ul>${errors.map(e => `<li><a href="#${h(e.field || 'main')}" data-error-target="${h(e.field || 'main')}">${h(e.message)}</a></li>`).join('')}</ul>`;
  $('error-summary').hidden = false;
  errors.forEach((error, i) => {
    const field = $(error.field);
    if (!field || field.closest('dialog') || !field.matches('input,select,textarea')) return;
    field.setAttribute('aria-invalid', 'true');
    const errorId = `field-error-${i}`;
    field.setAttribute('aria-describedby', [field.getAttribute('aria-describedby'), errorId].filter(Boolean).join(' '));
    const message = document.createElement('p'); message.id = errorId; message.className = 'field-error'; message.dataset.fieldError = ''; message.textContent = error.message;
    field.insertAdjacentElement('afterend', message);
  });
  $('error-summary').focus();
}
function focusError(fieldId) {
  const field = $(fieldId);
  if (field) { field.closest('details')?.setAttribute('open', ''); field.focus(); field.scrollIntoView({ block: 'center', behavior: 'instant' }); }
}
function showPhoto(index, photoIndex) {
  const room = roomById(state.entries[index]?.roomId);
  const gallery = roomGallery(room);
  const image = gallery[photoIndex];
  const src = safeAsset(image?.src);
  if (!src) return;
  $('photo-dialog-title').textContent = `${room.name} · ${photoIndex + 1}/${gallery.length}`;
  $('photo-dialog-body').innerHTML = `<figure class="photo-figure"><img src="${h(src)}" alt="${h(room.name)}の写真 ${photoIndex + 1}"><figcaption>${h(image.page ? `ROOMLIST p.${image.page}` : '既存の教室資料')}</figcaption></figure>`;
  $('photo-dialog').showModal();
}
async function confirmAction(text, { destructive = false, label = '実行' } = {}) {
  const dialog = $('confirm-dialog');
  $('confirm-text').textContent = text;
  $('confirm-submit').textContent = destructive ? '削除' : label;
  $('confirm-submit').classList.toggle('destructive', destructive);
  return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.returnValue = ''; dialog.showModal(); });
}
function setBusy(value) {
  busy = value;
  for (const id of ['download-pdf', 'mobile-download', 'clear-local', 'reset-form']) $(id).disabled = value;
  $('application-form').inert = value;
  $('storage-settings').inert = value;
  $('download-pdf').textContent = value ? '作成中…' : 'PDFを保存';
  $('mobile-download').textContent = value ? '作成中…' : 'PDFを保存';
}
async function downloadPdf() {
  if (busy) return;
  if (!state.purpose.trim()) {
    state.purpose = DEFAULT_PURPOSE;
    $('purpose').value = DEFAULT_PURPOSE;
    changed();
  }
  const data = structuredClone(state);
  // Removed email settings must not block PDF output with legacy draft values.
  data.profile.emailTo = ''; data.profile.emailCc = '';
  for (const key of ['name', 'studentId', 'phone']) data.profile[key] = data.profile[key].trim();
  data.profile.phone = data.profile.phone.replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)).replace(/[ー－]/g, '-');
  const errors = validateApplication(data, rooms);
  if (errors.length) { showErrors(errors); return; }
  clearErrors(); setBusy(true);
  $('pdf-status').textContent = '準備中…';
  try {
    const { createApplicationPdf } = await import('./pdf.js');
    const bytes = await createApplicationPdf(data, rooms);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = $('download-again');
    link.href = pdfUrl;
    link.download = `施設使用許可願_${data.issueDate.replaceAll('-', '')}_${data.entries.length}件.pdf`;
    link.hidden = false; link.click();
    $('pdf-status').textContent = '';
    if (rememberDraft) {
      history.unshift({ version: 1, createdAt: todayJst(), data: profilelessSnapshot() }); history = history.slice(0, 10);
      if (!writeStorage(STORAGE_KEYS.history, history)) notify('履歴を保存できませんでした。');
      persist(); renderHistory();
    }
    notify('PDFを保存しました');
  } catch (error) {
    console.error('PDF generation failed:', error);
    if (Array.isArray(error.errors)) showErrors(error.errors.map(e => ({ ...e, field: mapPdfField(e.field) })));
    else showErrors([{ field: 'main', message: `PDF作成に失敗しました。${error.message || ''}` }]);
    $('pdf-status').textContent = '作成に失敗しました';
    if (matchMedia('(max-width: 900px)').matches) notify('入力エラーを確認してください');
  } finally { setBusy(false); }
}
function mapPdfField(field) {
  if (!field) return 'main';
  if ($(field)) return field;
  const entry = field.match(/^entries(?:\[(\d+)\]|\.(\d+))\.(\w+)$/);
  if (entry) return `entry-${entry[1] ?? entry[2]}-${entry[3] === 'time' ? 'start' : entry[3]}`;
  if (field.startsWith('profile.')) return field.replace('profile.', 'profile-');
  return field === 'entries' ? 'entries-heading' : 'main';
}
function bindGalleryDrag() {
  let drag;
  let suppressClickUntil = 0;
  document.addEventListener('pointerdown', event => {
    const strip = event.target.closest('.photo-strip');
    if (!strip || event.pointerType !== 'mouse' || event.button !== 0) return;
    suppressClickUntil = 0;
    drag = { strip, id: event.pointerId, startX: event.clientX, scroll: strip.scrollLeft, moved: false };
  });
  document.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(delta) > 6 && drag.strip.scrollWidth > drag.strip.clientWidth) {
      drag.moved = true; drag.strip.classList.add('is-dragging'); drag.strip.setPointerCapture(event.pointerId);
    }
    if (drag.moved) { drag.strip.scrollLeft = drag.scroll - delta; event.preventDefault(); }
  });
  const finish = event => {
    if (!drag || drag.id !== event.pointerId) return;
    suppressClickUntil = drag.moved ? performance.now() + 300 : 0;
    drag.strip.classList.remove('is-dragging');
    if (drag.strip.hasPointerCapture(event.pointerId)) drag.strip.releasePointerCapture(event.pointerId);
    drag = null;
  };
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', event => { finish(event); suppressClickUntil = 0; });
  document.addEventListener('click', event => {
    if (event.detail > 0 && performance.now() < suppressClickUntil && event.target.closest('.photo-strip')) {
      suppressClickUntil = 0; event.preventDefault(); event.stopPropagation();
    }
  }, true);
  document.addEventListener('keydown', event => {
    const strip = event.target.closest('.photo-strip');
    if (!strip || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); strip.scrollBy({ left: strip.clientWidth * .7 * (event.key === 'ArrowRight' ? 1 : -1), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  });
}
function bindEvents() {
  bindGalleryDrag();
  $('application-form').addEventListener('submit', event => event.preventDefault());
  document.addEventListener('focusin', syncFocusedField);
  document.addEventListener('focusout', () => queueMicrotask(syncFocusedField));
  document.addEventListener('pointerdown', event => {
    if (!event.target.matches('#application-form input:not([type=checkbox]), #application-form select, #application-form textarea')) setActive(null);
  });
  window.addEventListener('blur', () => setActive(null));
  window.addEventListener('focus', syncFocusedField);
  for (const dialog of document.querySelectorAll('dialog')) {
    let outsideDown = false;
    const outside = event => {
      const bounds = dialog.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    dialog.addEventListener('pointerdown', event => { outsideDown = event.target === dialog && outside(event); });
    dialog.addEventListener('pointerup', event => {
      if (outsideDown && event.target === dialog && outside(event)) dialog.close('cancel');
      outsideDown = false;
    });
    dialog.addEventListener('pointercancel', () => { outsideDown = false; });
  }
  $('application-form').addEventListener('input', event => {
    const el = event.target;
    if (el.type === 'checkbox') return;
    if (el.dataset.entry !== undefined) {
      const index = Number(el.dataset.entry);
      state.entries[index][el.dataset.key] = el.value;
      if (el.dataset.key === 'roomId') $(`photos-${index}`).innerHTML = roomPhotos(el.value, index);
      if (['roomId', 'people'].includes(el.dataset.key)) $(`capacity-warning-${index}`).innerHTML = capacityWarning(index);
    } else if (el.dataset.profileKey) state.profile[el.dataset.profileKey] = el.value;
    else if (['organization', 'purpose', 'issueDate'].includes(el.name)) state[el.name] = el.value;
    changed();
  });
  $('add-entry').addEventListener('click', () => {
    if (state.entries.length >= MAX_ENTRIES) return;
    state.entries.push(newEntry());
    renderEntries(`entry-${state.entries.length - 1}-roomId`); changed();
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-action],[data-close],[data-history],[data-error-target]');
    if (!button) return;
    if (button.dataset.close) { $(button.dataset.close).close(); return; }
    if (button.dataset.errorTarget) { event.preventDefault(); focusError(button.dataset.errorTarget); return; }
    if (button.dataset.history !== undefined) {
      if (busy) return;
      const item = history[Number(button.dataset.history)];
      if (item && await confirmAction('この履歴を読み込みますか？')) {
        state = { ...sanitizeState(item.data), profile: state.profile }; activeEntry = null;
        renderCommon(); renderEntries(); changed(); $('purpose').focus();
      }
      return;
    }
    const index = Number(button.dataset.index);
    if (button.dataset.action === 'photo') { showPhoto(index, Number(button.dataset.photoIndex)); return; }
    if (button.dataset.action === 'duplicate' && state.entries.length < MAX_ENTRIES) {
      state.entries.splice(index + 1, 0, { ...state.entries[index] });
      renderEntries(`entry-${index + 1}-roomId`); changed();
    }
    if (button.dataset.action === 'remove' && state.entries.length > 1 && await confirmAction(`${index + 1}件目を削除しますか？`, { destructive: true })) {
      state.entries.splice(index, 1); activeEntry = null;
      renderEntries(`entry-${Math.min(index, state.entries.length - 1)}-roomId`); changed();
    }
  });
  $('remember-profile').addEventListener('change', event => {
    rememberProfile = event.target.checked;
    const preferenceSaved = savePreferences();
    const dataSaved = writeStorage(STORAGE_KEYS.profile, rememberProfile ? { version: 1, profile: state.profile } : null);
    if (!preferenceSaved || !dataSaved) notify('保存設定を変更できませんでした。');
  });
  $('remember-draft').addEventListener('change', event => {
    rememberDraft = event.target.checked;
    if (!savePreferences()) notify('保存設定を変更できませんでした。');
    if (rememberDraft) persist();
    else {
      clearTimeout(saveTimer);
      const removed = [STORAGE_KEYS.draft, STORAGE_KEYS.history].map(key => writeStorage(key, null));
      history = []; renderHistory();
      $('storage-status').textContent = removed.every(Boolean) ? '' : '削除できませんでした。';
    }
  });
  $('clear-local').addEventListener('click', async () => {
    if (!await confirmAction('学生責任者・下書き・履歴を削除しますか？', { destructive: true })) return;
    clearTimeout(saveTimer);
    const removed = Object.values(STORAGE_KEYS).map(key => writeStorage(key, null));
    state.profile = blankProfile(); rememberProfile = false; rememberDraft = false; history = [];
    const preferencesSaved = savePreferences();
    $('remember-draft').checked = false; $('remember-profile').checked = false; renderCommon(); renderHistory(); changed();
    $('storage-status').textContent = removed.every(Boolean) && preferencesSaved ? '削除済み' : '一部を削除できませんでした。';
  });
  $('reset-form').addEventListener('click', async () => {
    if (!await confirmAction('入力をリセットしますか？')) return;
    state = { ...initialState(), profile: state.profile }; activeEntry = null;
    renderCommon(); renderEntries(); changed(); $('purpose').focus();
  });
  $('download-pdf').addEventListener('click', downloadPdf);
  $('mobile-download').addEventListener('click', downloadPdf);
  $('toggle-preview').addEventListener('click', () => {
    const open = $('toggle-preview').getAttribute('aria-expanded') !== 'true';
    $('toggle-preview').setAttribute('aria-expanded', String(open));
    document.querySelector('.preview-pane').classList.toggle('is-open', open);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });
  window.addEventListener('pagehide', () => { persist(); if (pdfUrl) URL.revokeObjectURL(pdfUrl); });
}
async function init() {
  try {
    const response = await fetch(new URL('data/rooms.json', document.baseURI));
    if (!response.ok) throw new Error('教室データの読み込みに失敗しました。');
    const data = await response.json();
    if (!Array.isArray(data) || !data.length) throw new Error('教室データが不正です。');
    rooms = data;
    const storedProfile = readStorage(STORAGE_KEYS.profile);
    const draft = readStorage(STORAGE_KEYS.draft);
    const preferences = readStorage(STORAGE_KEYS.settings);
    rememberProfile = typeof preferences?.rememberProfile === 'boolean' ? preferences.rememberProfile : true;
    rememberDraft = typeof preferences?.rememberDraft === 'boolean' ? preferences.rememberDraft : true;
    if (rememberDraft && draft?.version === 1 && draft.data) state = sanitizeState(draft.data);
    state.profile = rememberProfile && storedProfile?.version === 1 && storedProfile.profile ? sanitizeState({ profile: storedProfile.profile }).profile : blankProfile();
    if (rememberDraft) {
      const rawHistory = readStorage(STORAGE_KEYS.history, []);
      history = Array.isArray(rawHistory) ? rawHistory.filter(x => x && x.version === 1 && x.data).slice(0, 10).map(x => ({ version: 1, createdAt: String(x.createdAt || '').slice(0, 10), data: sanitizeState(x.data) })) : [];
    }
    $('remember-draft').checked = rememberDraft; $('remember-profile').checked = rememberProfile;
    renderCommon(); renderEntries(); renderHistory(); bindEvents();
    $('app').hidden = false; $('load-status').hidden = true;
    try { preview = await initPreview($('application-preview')); preview.update(state, rooms); syncFocusedField(); }
    catch { $('application-preview').textContent = 'プレビューを表示できませんでした。'; }
  } catch (error) {
    $('load-status').className = 'notice error'; $('load-status').textContent = error.message;
  }
}
init();
