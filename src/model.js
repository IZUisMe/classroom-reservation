export const MAX_ENTRIES = 9;
export const DEFAULT_PURPOSE = '本会の対面活動を実施するため';
export const STORAGE_KEYS = { profile: 'classroom.profile.v1', draft: 'classroom.draft.v1', history: 'classroom.history.v1', settings: 'classroom.settings.v1' };
export const todayJst = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const blankProfile = () => ({ name: '', studentId: '', phone: '', emailTo: '', emailCc: '', role: '代表' });
export const newEntry = () => ({ date: '', start: '18:30', end: '20:00', roomId: '32C', people: '10', external: 'なし', remarks: '' });
export const initialState = () => ({ organization: 'デジタルコンテンツ研究会', title: '', purpose: '', issueDate: todayJst(), target: '全員', belongings: '', profile: blankProfile(), entries: [newEntry()] });
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value && Number(value.slice(0, 4)) >= 1900;
}
export const isValidTime = v => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
export function validateProfile(profile) {
  const errors = [];
  if (!profile.name.trim()) errors.push({ field: 'profile-name', message: '責任者氏名を入力してください。' });
  if (!profile.studentId.trim()) errors.push({ field: 'profile-studentId', message: '学籍番号を入力してください。' });
  if (!/^[0-9０-９+＋()（）\-ー\s]{10,24}$/.test(profile.phone) || profile.phone.replace(/[^0-9０-９]/g, '').length < 10) errors.push({ field: 'profile-phone', message: '携帯電話番号を10〜15桁の数字で入力してください。' });
  if (profile.phone.replace(/[^0-9０-９]/g, '').length > 15) errors.push({ field: 'profile-phone', message: '携帯電話番号は15桁以内で入力してください。' });
  for (const key of ['emailTo', 'emailCc']) {
    if (profile[key] && !profile[key].split(/[,;\n]/).every(v => EMAIL.test(v.trim()))) errors.push({ field: `profile-${key}`, message: `${key === 'emailTo' ? '宛先' : 'CC'}のメールアドレスを確認してください。` });
  }
  return errors;
}
export function validateApplication(data, rooms) {
  const errors = [];
  if (!data.organization.trim()) errors.push({ field: 'organization', message: '団体名を入力してください。' });
  if (!data.purpose.trim()) errors.push({ field: 'purpose', message: '使用目的を入力してください。' });
  if (!isValidDate(data.issueDate)) errors.push({ field: 'issueDate', message: '申請日を正しく入力してください。' });
  errors.push(...validateProfile(data.profile));
  if (!data.entries.length || data.entries.length > MAX_ENTRIES) errors.push({ field: 'entries-heading', message: '日時・教室は1〜9件にしてください。' });
  data.entries.forEach((e, i) => {
    const add = (key, text) => errors.push({ field: `entry-${i}-${key}`, message: `${i + 1}件目：${text}` });
    if (!isValidDate(e.date)) add('date', '使用日を正しく入力してください。');
    if (!isValidTime(e.start)) add('start', '開始時刻を入力してください。');
    if (!isValidTime(e.end)) add('end', '終了時刻を入力してください。');
    if (isValidTime(e.start) && isValidTime(e.end) && e.start >= e.end) add('end', '終了時刻は開始時刻より後にしてください（日をまたぐ使用には対応していません）。');
    if (!rooms.some(r => r.id === e.roomId)) add('roomId', '教室を選択してください。');
    if (!/^[1-9]\d{0,3}$/.test(String(e.people))) add('people', '人数を1〜9999人で入力してください。');
  });
  return errors;
}
export function formatDate(value, year = true) {
  if (!isValidDate(value)) return '日付未入力';
  const [y, m, d] = value.split('-').map(Number);
  const day = '日月火水木金土'[new Date(value + 'T00:00:00Z').getUTCDay()];
  return `${year ? `${y}年` : ''}${m}月${d}日（${day}）`;
}
export function createMail(data, rooms) {
  const name = data.profile.name.trim() || '（責任者氏名）';
  const role = data.profile.role.trim();
  const lines = data.entries.map(e => `${formatDate(e.date)} ${e.start}〜${e.end}　${rooms.find(r => r.id === e.roomId)?.name || '教室未選択'}（${e.people}人）`);
  return `学生支援課 ご担当者様\n顧問の先生\n\nいつもお世話になっております。\n${data.organization}の${role ? `${role}を務めております、` : ''}${name}です。\n\nこの度、以下の教室利用について申請書類を提出いたします。\nご確認いただけますと幸いです。\n\n活動内容：${data.purpose || '（使用目的）'}\n活動予定：\n${lines.join('\n')}\n\n必要な書類を添付しておりますので、ご査収ください。\n何卒よろしくお願い申し上げます。`;
}
export function createNotice(data, rooms, entryIndex = 0) {
  const e = data.entries[entryIndex];
  if (!e) return '';
  return `@everyone\n${e.date === todayJst() ? '本日開催' : formatDate(e.date)}『${data.title || '活動'}』\n\n時刻：${e.start} 〜 ${e.end}\n場所：${rooms.find(r => r.id === e.roomId)?.name || '教室未選択'}\n対象：${data.target || '全員'}\n持ち物：${data.belongings || '特になし'}\n\n気軽に来てね〜✌️`;
}
// Treat localStorage as untrusted input: copy only known strings and bound all lengths.
const pick = (source, defaults, limits = {}) => Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, typeof source?.[k] === 'string' ? source[k].slice(0, limits[k] || 500) : v]));
export function sanitizeState(raw) {
  const state = initialState();
  if (!raw || typeof raw !== 'object') return state;
  Object.assign(state, pick(raw, { organization: state.organization, title: '', purpose: '', issueDate: state.issueDate, target: '全員', belongings: '' }, { purpose: 500, organization: 50, title: 100, target: 100, belongings: 200 }));
  state.profile = pick(raw.profile, blankProfile(), { name: 40, studentId: 24, phone: 24, role: 40 });
  if (Array.isArray(raw.entries) && raw.entries.length) state.entries = raw.entries.slice(0, MAX_ENTRIES).map(e => pick(e, newEntry(), { date: 10, start: 5, end: 5, roomId: 80, people: 4, external: 80, remarks: 100 }));
  return state;
}
export function readStorage(key, fallback = null) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
export function writeStorage(key, value) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
