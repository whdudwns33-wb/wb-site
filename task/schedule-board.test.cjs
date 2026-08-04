const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('./schedule-board-core.js');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8'));

function legacyTask(id, studentName, time, extra = {}) {
  return Object.assign({
    id,
    studentName,
    time,
    scheduleText: time,
    lessonRole: '문제풀이'
  }, extra);
}

function classify(task, occurs = true, dow = 1) {
  return core.classifyTaskSchedule(task, { date: '2026-08-03', dow, occurs });
}

test('parses Korean lesson ranges and Unicode dashes', () => {
  const ranges = core.extractLessonRanges('평일 15:30–16:20 / 17:30-18:20');
  assert.deepEqual(ranges.map(range => range.label), ['15:30–16:20', '17:30–18:20']);
  assert.equal(core.parseClockMinute('16:35'), 995);
  assert.equal(core.parseClockMinute('24:00'), null);
});

test('single ranges become schedule slots without using task date end as a clock', () => {
  const valid = classify(legacyTask('a', '학생A', '평일 15:30–16:20'));
  assert.equal(valid.slots.length, 1);
  assert.equal(valid.slots[0].startMinute, 930);
  assert.equal(valid.slots[0].endMinute, 980);

  const dateOnly = classify(legacyTask('b', '학생', '', { end: '2026-08-31' }));
  assert.equal(dateOnly.slots.length, 0);
  assert.equal(dateOnly.issues[0].code, 'missing_schedule');
});

test('split legacy ranges are held for assignment review instead of guessed', () => {
  const result = classify(legacyTask(
    'split',
    '학생B',
    '방학 중 목요일 16:00–16:50 / 17:00–17:50 (시간 분할)'
  ), false, 1);
  assert.equal(result.slots.length, 0);
  assert.equal(result.issues[0].code, 'split_assignment');
});

test('known missing Kim Namgi schedules remain visible as review issues', () => {
  const result = classify(legacyTask('namgi', '고준', '', {
    detail: '중3 · 수학 · 실제 시간표·교재·현재 진도 확인 필요'
  }), false);
  assert.equal(result.slots.length, 0);
  assert.equal(result.issues[0].code, 'needs_review');
});

test('needs-review schedules never become partial confirmed slots', () => {
  const result = classify(legacyTask('review', '학생검토', '월·수 18:00–19:50 / 금 1시간', {
    repeat: 'days',
    days: [1, 3, 5],
    scheduleStatus: 'needs_review'
  }), true, 1);
  assert.equal(result.slots.length, 0);
  assert.equal(result.issues[0].code, 'needs_review');
});

test('structured slots support future split classes without a D1 schema change', () => {
  const result = classify({
    id: 'structured',
    lessonRole: '문제풀이',
    scheduleSlots: [
      { slotId: 'first', days: [4], startTime: '16:00', endTime: '16:50', validFrom: '2026-08-01' },
      { slotId: 'second', days: [4], startTime: '17:00', endTime: '17:50', validFrom: '2026-08-01' }
    ]
  }, false, 4);
  assert.deepEqual(result.slots.map(slot => slot.label), ['16:00–16:50', '17:00–17:50']);
});

test('current time boundaries are start inclusive and end exclusive', () => {
  const slot = classify(legacyTask('a', '학생A', '15:30–16:20')).slots[0];
  assert.equal(core.clockState(slot, '2026-08-03', '2026-08-03', 930), 'current');
  assert.equal(core.clockState(slot, '2026-08-03', '2026-08-03', 979), 'current');
  assert.equal(core.clockState(slot, '2026-08-03', '2026-08-03', 980), 'ended');
});

test('Kim Deokjae real-data samples produce the expected current student counts', () => {
  const tasks = [
    legacyTask('s1', '학생A', '평일 15:30–16:20'),
    ...['학생C', '학생D', '학생E', '학생F'].map((name, i) => legacyTask('m' + i, name, '평일 16:30–17:20')),
    ...['학생G', '학생H', '학생I'].map((name, i) => legacyTask('l' + i, name, '평일 17:30–18:20'))
  ];
  const slots = tasks.map(task => ({ task, slot: classify(task).slots[0] }));
  const countAt = minute => slots.filter(item => core.clockState(item.slot, '2026-08-03', '2026-08-03', minute) === 'current').map(item => item.task.studentName);
  assert.deepEqual(countAt(15 * 60 + 40), ['학생A']);
  assert.deepEqual(countAt(16 * 60 + 35), ['학생C', '학생D', '학생E', '학생F']);
  assert.deepEqual(countAt(17 * 60 + 35), ['학생G', '학생H', '학생I']);
});

test('dashboard is admin-only, mobile responsive, and keeps multi-teacher tasks separate', () => {
  assert.match(html, /const map = \{ schedule: viewSchedule,/);
  assert.match(html, /function viewSchedule\(\) \{\s*if \(!session\.isAdmin\) return viewToday\(\);/);
  assert.match(html, /const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'roster'\]/);
  assert.match(html, /key: String\(t\.id\) \+ '\|' \+ String\(slot\.slotId \|\| index\)/);
  assert.match(html, /const key = entry\.staffId \|\| entry\.teacherName/);
  assert.match(html, /@media \(max-width: 600px\)[\s\S]{0,180}schedule-current-grid \{ grid-template-columns: 1fr;/);
});

test('task page and deployment version stay aligned', () => {
  assert.equal(version.v, '2026-08-04.3');
  assert.match(html, /const APP_VER = '2026-08-04\.3';/);
  assert.match(html, /schedule-board-core\.js\?v=2026-08-04\.3/);
});
