import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, sanitizeState, validateApplication, isValidDate, createMail, createNotice, escapeHtml, MAX_ENTRIES } from '../src/model.js';
const rooms = [{ id: '32C', name: '32C教室' }];
function valid() {
  const d = initialState();
  d.purpose = '作品制作';
  d.profile = { name: '試験 太郎', studentId: 'TEST001', phone: '090-0000-0000', emailTo: '', emailCc: '', role: '代表' };
  d.entries[0].date = '2026-11-10';
  return d;
}
test('defaults never include personal information or destinations', () => {
  const d = initialState();
  for (const k of ['name', 'studentId', 'phone', 'emailTo', 'emailCc']) assert.equal(d.profile[k], '');
});
test('valid application and nine entries', () => {
  const d = valid();
  assert.deepEqual(validateApplication(d, rooms), []);
  d.entries = Array.from({ length: 9 }, () => ({ ...d.entries[0] }));
  assert.deepEqual(validateApplication(d, rooms), []);
  d.entries.push({ ...d.entries[0] });
  assert.ok(validateApplication(d, rooms).some(x => x.field === 'entries-heading'));
  assert.equal(MAX_ENTRIES, 9);
});
test('reject impossible dates and invalid range', () => {
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('2028-02-29'), true);
  assert.equal(isValidDate('2026-13-01'), false);
  const d = valid(); d.entries[0].end = d.entries[0].start;
  assert.ok(validateApplication(d, rooms).some(x => x.field === 'entry-0-end'));
});
test('accept every minute and preserve native time input values', () => {
  const d = valid();
  for (let minute = 0; minute < 60; minute++) {
    d.entries[0].start = `18:${String(minute).padStart(2, '0')}`;
    assert.deepEqual(validateApplication(d, rooms), []);
  }
  d.entries[0].start = '18:35';
  assert.equal(sanitizeState(d).entries[0].start, '18:35');
});
test('reject invalid room, people, missing profile and email', () => {
  const d = valid(); Object.assign(d.entries[0], { roomId: 'bad', people: '0' }); d.profile.emailTo = 'invalid'; d.profile.name = '';
  const fields = validateApplication(d, rooms).map(x => x.field);
  for (const key of ['entry-0-roomId', 'entry-0-people', 'profile-emailTo', 'profile-name']) assert.ok(fields.includes(key));
});
test('sanitize unknown fields, broken shape and oversized arrays', () => {
  const d = sanitizeState({ purpose: '<script>test</script>', profile: { name: 123 }, entries: Array.from({ length: 12 }, () => ({ date: '2026-11-11', people: 123, evil: 'x' })), evil: true });
  assert.equal(d.entries.length, 9); assert.equal(d.profile.name, ''); assert.equal(d.entries[0].people, '10');
  assert.equal(d.evil, undefined); assert.equal(d.entries[0].evil, undefined);
  assert.equal(sanitizeState(null).entries.length, 1);
});
test('escape text contexts, mail includes all entries and no inherited contacts', () => {
  assert.equal(escapeHtml('<img "x">&'), '&lt;img &quot;x&quot;&gt;&amp;');
  const d = valid(); d.entries.push({ ...d.entries[0], date: '2026-11-11' });
  const mail = createMail(d, rooms);
  assert.ok(mail.includes('11月10日')); assert.ok(mail.includes('11月11日')); assert.ok(mail.includes('試験 太郎'));
  assert.ok(!mail.includes('@tcu.ac.jp'));
  assert.ok(createNotice(d, rooms, 1).includes('11月11日'));
});
