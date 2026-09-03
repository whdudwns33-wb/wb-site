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

function timelineEntry(teacherName, studentName, startMinute, endMinute, grade = '', extra = {}) {
  return Object.assign({
    staffId: teacherName,
    teacherName,
    studentName,
    grade,
    slot: { startMinute, endMinute, label: startMinute + '–' + endMinute }
  }, extra);
}

function functionSource(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' function is present');
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < html.length; index++) {
    if (html[index] === '{') depth++;
    else if (html[index] === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error('unterminated function: ' + name);
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
  const result = classify(legacyTask('namgi', '확인학생', '', {
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

test('structured slots never escape the parent task date range', () => {
  const result = core.classifyTaskSchedule({
    id: 'bounded',
    scheduleSlots: [{ slotId: 'monday', days: [1], startTime: '16:00', endTime: '17:00' }]
  }, { date: '2026-08-03', dow: 1, occurs: false, withinRange: false });
  assert.equal(result.slots.length, 0);
});

test('effective flexible weekend lessons never create ghost slots from reference weekdays', () => {
  const task = {
    id: 'lesson-flex-1',
    studentId: 'student-00000001',
    weekendAttendanceMode: 'flexible',
    weekendFlexibleFrom: '2026-08-29',
    scheduleSlots: [{ slotId: 'reference-sun', days: [0], startTime: '10:00', endTime: '11:20' }]
  };

  const referenceSunday = core.classifyTaskSchedule(task, {
    date: '2026-08-30', dow: 0, occurs: false, withinRange: true, flexibleVisit: null
  });
  assert.deepEqual(referenceSunday, { slots: [], issues: [], sourceType: 'flexible' });
});

test('effective flexible weekend lessons use the exact actual visit even on a different reference weekday', () => {
  const task = {
    id: 'lesson-flex-1',
    studentId: 'student-00000001',
    lessonRole: '클리닉',
    weekendAttendanceMode: 'flexible',
    weekendFlexibleFrom: '2026-08-29',
    scheduleSlots: [{ slotId: 'reference-sun', days: [0], startTime: '10:00', endTime: '11:20' }]
  };
  const visit = {
    visitId: 'visit-stable-1',
    lessonTaskId: task.id,
    studentId: task.studentId,
    visitDate: '2026-08-29',
    status: 'completed',
    startTime: '12:05',
    endTime: '13:17'
  };

  const actualSaturday = core.classifyTaskSchedule(task, {
    date: '2026-08-29', dow: 6, occurs: true, withinRange: true, flexibleVisit: visit
  });
  assert.equal(actualSaturday.sourceType, 'flexible');
  assert.deepEqual(actualSaturday.slots.map(slot => slot.label), ['12:05–13:17']);
  assert.equal(actualSaturday.slots[0].slotId, 'weekend-visit:visit-stable-1');

  const activeSaturday = core.classifyTaskSchedule(task, {
    date: '2026-08-29', dow: 6, occurs: true, withinRange: true,
    flexibleVisit: Object.assign({}, visit, {
      status: 'active', projectedEnd: true, startTime: '12:05', endTime: '13:25'
    })
  });
  assert.equal(activeSaturday.slots[0].label, '12:05–등원 중');
  assert.equal(activeSaturday.slots[0].endMinute, 13 * 60 + 25,
    'projected end remains available only for timeline placement');
  assert.equal(activeSaturday.slots[0].scheduleStatus, 'actual_visit_active');

  for (const invalidVisit of [
    Object.assign({}, visit, { studentId: 'student-00000002' }),
    Object.assign({}, visit, { lessonTaskId: 'lesson-flex-2' }),
    Object.assign({}, visit, { visitDate: '2026-08-30' }),
    Object.assign({}, visit, { status: 'cancelled' })
  ]) {
    const rejected = core.classifyTaskSchedule(task, {
      date: '2026-08-29', dow: 6, occurs: true, withinRange: true, flexibleVisit: invalidVisit
    });
    assert.equal(rejected.slots.length, 0);
  }
});

test('a future flexible effective date keeps the existing fixed schedule behavior', () => {
  const result = core.classifyTaskSchedule({
    id: 'lesson-before-flex',
    studentId: 'student-00000003',
    weekendAttendanceMode: 'flexible',
    weekendFlexibleFrom: '2026-08-30',
    scheduleSlots: [{ slotId: 'reference-sat', days: [6], startTime: '10:00', endTime: '11:20' }]
  }, { date: '2026-08-29', dow: 6, occurs: true, withinRange: true });
  assert.deepEqual(result.slots.map(slot => slot.label), ['10:00–11:20']);
  assert.equal(result.sourceType, 'structured');
});

test('legacy review issues never escape the parent task date range', () => {
  const result = core.classifyTaskSchedule(legacyTask('bounded-review', '학생', '', {
    scheduleStatus: 'needs_review', detail: '실제 시간표 확인 필요'
  }), { date: '2026-08-03', dow: 1, occurs: true, withinRange: false });
  assert.deepEqual(result, { slots: [], issues: [], sourceType: 'legacy' });
});

test('legacy review issues appear only on dates when the task occurs', () => {
  const result = core.classifyTaskSchedule(legacyTask('once-review', '학생', '', {
    repeat: 'once', scheduleStatus: 'needs_review', detail: '실제 시간표 확인 필요'
  }), { date: '2026-08-10', dow: 1, occurs: false, withinRange: true });
  assert.deepEqual(result, { slots: [], issues: [], sourceType: 'legacy' });
});

test('current time boundaries are start inclusive and end exclusive', () => {
  const slot = classify(legacyTask('a', '학생A', '15:30–16:20')).slots[0];
  assert.equal(core.clockState(slot, '2026-08-03', '2026-08-03', 930), 'current');
  assert.equal(core.clockState(slot, '2026-08-03', '2026-08-03', 979), 'current');
  assert.equal(core.clockState(slot, '2026-08-03', '2026-08-03', 980), 'ended');
});

test('an active actual visit stays current and occupies the timeline through now', () => {
  const active = timelineEntry('김선생', '학생A', 12 * 60 + 5, 13 * 60 + 25, '중1', {
    date: '2026-08-29', studentId: 'student-active-1'
  });
  active.slot.scheduleStatus = 'actual_visit_active';
  active.slot.label = '12:05–등원 중';
  const overlapping = timelineEntry('박선생', '학생A', 13 * 60 + 30, 14 * 60 + 10, '중1', {
    date: '2026-08-29', studentId: 'student-active-1'
  });
  const now = 14 * 60;

  assert.equal(core.clockState(active.slot, '2026-08-29', '2026-08-29', now), 'current');
  assert.equal(core.clockState(active.slot, '2026-08-28', '2026-08-29', now), 'ended');
  assert.equal(core.clockState({ startMinute: 12 * 60 + 5, endMinute: 13 * 60 + 25 },
    '2026-08-29', '2026-08-29', now), 'ended', 'regular slots retain their end boundary');

  const rows = core.timelineRows([active, overlapping], {
    date: '2026-08-29', todayDate: '2026-08-29', nowMinute: now
  });
  const activeSession = rows.find(row => row.teacherName === '김선생').sessions[0];
  const otherSession = rows.find(row => row.teacherName === '박선생').sessions[0];
  assert.equal(activeSession.endMinute, now + 1);
  assert.equal(activeSession.label, '12:05–등원 중');
  assert.ok(activeSession.studentConflict);
  assert.ok(otherSession.studentConflict);

  const range = core.timelineRange([active], {
    date: '2026-08-29', todayDate: '2026-08-29', nowMinute: now
  });
  assert.ok(range.endMinute > now);
});

test('student grouping separates same-name students by grade', () => {
  assert.equal(core.studentGroupKey(' 김 민수 ', '초 3'), core.studentGroupKey('김민수', '초3'));
  assert.notEqual(core.studentGroupKey('김민수', '초3'), core.studentGroupKey('김민수', '중1'));
  assert.notEqual(core.studentGroupKey('김민수', '초3', 'student-1'), core.studentGroupKey('김민수', '초3', 'student-2'));
  assert.equal(core.studentGroupKey('예전 이름', '초3', 'student-1'), core.studentGroupKey('새 이름', '초4', 'student-1'));
  assert.notEqual(core.studentGroupKey('김민수', '초3', 'Student-X'), core.studentGroupKey('김민수', '초3', 'student-x'));
});

test('timeline combines same-time group students into one block', () => {
  const rows = core.timelineRows([
    timelineEntry('김선생', '학생A', 900, 950),
    timelineEntry('김선생', '학생B', 900, 950),
    timelineEntry('김선생', '학생C', 900, 950)
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessions.length, 1);
  assert.equal(rows[0].sessions[0].entries.length, 3);
  assert.equal(rows[0].laneCount, 1);
  assert.equal(rows[0].sessions[0].teacherConflict, false);
});

test('timeline separates partial teacher overlaps but accepts touching boundaries', () => {
  const overlap = core.timelineRows([
    timelineEntry('김선생', '학생A', 900, 960),
    timelineEntry('김선생', '학생B', 950, 1010)
  ])[0];
  assert.equal(overlap.laneCount, 2);
  assert.ok(overlap.sessions.every(session => session.teacherConflict));

  const boundary = core.timelineRows([
    timelineEntry('김선생', '학생A', 900, 950),
    timelineEntry('김선생', '학생B', 950, 1000)
  ])[0];
  assert.equal(boundary.laneCount, 1);
  assert.ok(boundary.sessions.every(session => !session.teacherConflict));
});

test('same-time lessons with different class identities stay separate and warn', () => {
  const row = core.timelineRows([
    timelineEntry('김선생', '학생A', 900, 960, '중1', { task: { subject: '영어', className: '문법' }, role: '문법' }),
    timelineEntry('김선생', '학생B', 900, 960, '중1', { task: { subject: '수학', className: '대수' }, role: '개념' })
  ])[0];
  assert.equal(row.sessions.length, 2);
  assert.equal(row.laneCount, 2);
  assert.notEqual(row.sessions[0].lessonIdentity, row.sessions[1].lessonIdentity);
  assert.ok(row.sessions.every(session => session.teacherConflict));
});

test('same-time makeup lessons stay separate from regular classes and from other makeup cases', () => {
  const row = core.timelineRows([
    timelineEntry('김선생', '학생A', 900, 960, '중1', {
      task: { id: 'lesson-a', subject: '수학', className: '대수' }, role: '개념'
    }),
    timelineEntry('김선생', '학생B', 900, 960, '중1', {
      task: { id: 'makeup-a', subject: '수학', className: '대수', lessonInstanceType: 'makeup', makeupCaseId: 'mu-a' },
      role: '개념'
    }),
    timelineEntry('김선생', '학생C', 900, 960, '중1', {
      task: { id: 'makeup-b', subject: '수학', className: '대수', lessonInstanceType: 'makeup', makeupCaseId: 'mu-b' },
      role: '개념'
    })
  ])[0];
  assert.equal(row.sessions.length, 3);
  assert.equal(new Set(row.sessions.map(session => session.lessonIdentity)).size, 3);
  assert.ok(row.sessions.every(session => session.teacherConflict));
});

test('timeline flags one student booked with overlapping teachers', () => {
  const rows = core.timelineRows([
    timelineEntry('김선생', '학생A', 900, 960, '중1'),
    timelineEntry('박선생', '학생A', 930, 990, '중1')
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.sessions[0].studentConflict));
  assert.ok(rows.every(row => !row.sessions[0].teacherConflict));
});

test('a group session identifies only the students who overlap another teacher', () => {
  const rows = core.timelineRows([
    timelineEntry('김선생', '학생A', 900, 960, '중1', { studentId: 'student-a' }),
    timelineEntry('김선생', '학생B', 900, 960, '중1', { studentId: 'student-b' }),
    timelineEntry('김선생', '학생C', 900, 960, '중1', { studentId: 'student-c' }),
    timelineEntry('박선생', '학생A', 930, 990, '중1', { studentId: 'student-a' })
  ]);
  const group = rows.find(row => row.teacherName === '김선생').sessions[0];
  assert.equal(group.studentConflict, true);
  assert.deepEqual(group.studentConflictEntries.map(entry => entry.studentId), ['student-a']);
});

test('stable student ids keep same-name students separate', () => {
  const rows = core.timelineRows([
    timelineEntry('김선생', '김민수', 900, 960, '초3', { studentId: 'student-1' }),
    timelineEntry('박선생', '김민수', 930, 990, '초3', { studentId: 'student-2' })
  ]);
  assert.ok(rows.every(row => !row.sessions[0].studentConflict));
});

test('duplicate same-student entries in one group session do not warn', () => {
  const session = core.timelineRows([
    timelineEntry('김선생', '학생A', 900, 960, '중1'),
    timelineEntry('김선생', '학생A', 900, 960, '중1')
  ])[0].sessions[0];
  assert.equal(session.entries.length, 2);
  assert.equal(session.studentConflict, false);
});

test('one student in different overlapping classes still warns under the same teacher', () => {
  const sessions = core.timelineRows([
    timelineEntry('김선생', '학생A', 900, 960, '중1', { task: { subject: '영어', className: '문법' } }),
    timelineEntry('김선생', '학생A', 930, 990, '중1', { task: { subject: '수학', className: '대수' } })
  ])[0].sessions;
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every(session => session.studentConflict));
});

test('timeline range adds context and keeps at least four hours visible', () => {
  assert.deepEqual(core.timelineRange([timelineEntry('김선생', '학생A', 930, 980).slot]), {
    startMinute: 900,
    endMinute: 1140
  });
  assert.deepEqual(core.timelineRange([]), { startMinute: 840, endMinute: 1200 });
  assert.deepEqual(core.timelineRange([{ startMinute: 10, endMinute: 50 }]), { startMinute: 0, endMinute: 240 });
  assert.deepEqual(core.timelineRange([{ startMinute: 1410, endMinute: 1430 }]), { startMinute: 1200, endMinute: 1440 });
});

test('weekly teacher summary counts a four-student group as one timed session', () => {
  const entries = ['학생A', '학생B', '학생C', '학생D'].map(studentName =>
    timelineEntry('김선생', studentName, 900, 960, '중1', {
      date: '2026-08-03',
      task: { subject: '영어', className: '문법' },
      role: '문제풀이'
    }));
  const summary = core.weeklyTeacherSummary(entries);

  assert.equal(summary.teachers.length, 1);
  assert.equal(summary.teachers[0].sessionCount, 1);
  assert.equal(summary.teachers[0].durationMinutes, 60);
  assert.equal(summary.teachers[0].studentCount, 4);
  assert.equal(summary.teachers[0].sessions[0].entries.length, 4);
  assert.equal(summary.teachers[0].sessions[0].lessonIdentity, '영어|문법|문제풀이');
  assert.deepEqual(summary.totals, {
    sessionCount: 1,
    studentCount: 4,
    teacherCount: 1,
    durationMinutes: 60,
    conflictCount: 0
  });
});

test('weekly teacher summary preserves conflicts, unique students, and date-time order', () => {
  const entries = [
    timelineEntry('김선생', '학생A', 1020, 1080, '중1', { date: '2026-08-04', role: '독해' }),
    timelineEntry('박선생', '김민수', 930, 990, '초3', { date: '2026-08-03', role: '개념' }),
    timelineEntry('김선생', '김민수', 900, 960, '초3', { date: '2026-08-03', role: '문법' }),
    timelineEntry('김선생', '학생B', 950, 1010, '중2', { date: '2026-08-03', role: '문제풀이' }),
    timelineEntry('김선생', '김민수', 1080, 1140, '중1', { date: '2026-08-04', role: '독해' })
  ];
  const summary = core.weeklyTeacherSummary(entries);
  const kim = summary.teachers.find(teacher => teacher.teacherName === '김선생');
  const park = summary.teachers.find(teacher => teacher.teacherName === '박선생');

  assert.deepEqual(kim.sessions.map(session => [session.date, session.startMinute]), [
    ['2026-08-03', 900], ['2026-08-03', 950], ['2026-08-04', 1020], ['2026-08-04', 1080]
  ]);
  assert.ok(kim.sessions[0].teacherConflict && kim.sessions[0].studentConflict);
  assert.ok(kim.sessions[1].teacherConflict);
  assert.ok(park.sessions[0].studentConflict);
  assert.equal(kim.conflictCount, 1);
  assert.equal(park.conflictCount, 1);
  assert.equal(kim.studentCount, 4);
  assert.equal(summary.totals.studentCount, 4);
  assert.equal(summary.totals.sessionCount, 5);
  assert.equal(summary.totals.durationMinutes, 300);
  assert.equal(summary.totals.conflictCount, 2);
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
  assert.match(html, /const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'transport', 'roster'\]/);
  assert.match(html, /key: String\(t\.id\) \+ '\|' \+ String\(slot\.slotId \|\| index\)/);
  assert.match(html, /weeklyTeacherSummary\(weekly\.entries\)/);
  assert.match(html, /\.schedule-timeline-scroll \{[^}]*overflow-x: auto;/);
  assert.match(html, /@media \(max-width: 600px\)/);
  assert.match(html, /\.schedule-timeline-grid \{ --teacher-w: 72px;/);
});

test('dashboard offers weekly day, teacher, and student views with authenticated roster loading', () => {
  assert.match(html, /\['schedule', '현황판', managerRequestInboxCount\(\)\]/);
  assert.match(html, /\['day', '오늘 보드'\], \['week', '요일별'\], \['teacher', '선생님별'\], \['student', '학생별'\]/);
  assert.match(html, /function weeklyLessonSchedule\(anchor\)/);
  assert.match(html, /function scheduleWeekCardsHtml\(weekly\)/);
  assert.match(html, /function scheduleTeacherCardsHtml\(weekly\)/);
  assert.match(html, /function scheduleStudentCardsHtml\(weekly\)/);
  assert.match(html, /function scheduleTimelineHtml\(timeline, date, nowKst\)/);
  assert.match(html, /requestAnimationFrame\(\(\) => \{\s*scheduleFocusTimeline\(\);/);
  assert.match(html, /data-act="scheduleblock"/);
  assert.match(html, /data-lesson="' \+ esc\(session\.lessonIdentity\)/);
  assert.match(html, /const currentStudentCount = new Set\(current\.map\(entry => core\.studentGroupKey/);
  assert.match(html, /<div id="modalHost" class="modal" data-act="closemodal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" hidden><\/div>/);
  assert.match(html, /host\.hidden = false/);
  assert.match(html, /#modalHost button\[data-act="closemodal"\]/);
  assert.match(html, /element\.inert = value/);
  assert.match(html, /ev\.key === 'Escape' && !\$\('#modalHost'\)\.hidden/);
  assert.match(html, /data-schedule-search/);
  assert.match(html, /function scheduleStudentSources\(group\)/);
  assert.match(html, /lessonFormStudents\(\)[\s\S]{0,160}String\(student\.id\) === String\(draft\.studentId\)/);
  assert.match(html, /conflictEntries\.has\(entry\.date \+ '\|' \+ entry\.key\)/);
  assert.match(html, /rosterStudentId\(studentName, grade, date\)/);
  assert.match(html, /const names = scheduleSessionNames\(session\);/);
  assert.match(html, /aria-pressed="' \+/);
  assert.match(html, /data-schedule-search aria-label="시간표 검색"/);
  assert.match(html, /data-schedule-timeline role="region" aria-label="선생님별 일간 시간표" tabindex="0"/);
  assert.match(html, /const noSchedule = weekly\.monday >= mondayOf\(today\(\)\)/);
  assert.match(html, /if \(!session\.studentConflict\) return;/);
  assert.match(html, /const conflict = session\.studentConflict;/);
  assert.doesNotMatch(html, /const conflict = session\.teacherConflict \|\| session\.studentConflict;/);
  assert.match(html, /aria-label="이전 ' \+ navUnit/);
  assert.match(html, /aria-label="다음 ' \+ navUnit/);
  assert.match(html, /\['교재·진도', task\.materials\]/);
  assert.match(html, /sync\.post\('\/roster', \{ app: SYNC_APP, auth: auth, action: 'get' \}\)/);
  assert.doesNotMatch(html, /fetch\('roster\.json/);
  assert.match(html, /data-act="rosterretry"/);
});

test('daily teacher flow shows every student with five distinct attendance colors and no redundant overview', () => {
  const timelineStart = html.indexOf('function scheduleTimelineHtml(');
  const timelineEnd = html.indexOf('function scheduleTimelineModal(', timelineStart);
  const timeline = html.slice(timelineStart, timelineEnd);
  const rowStart = html.indexOf('function scheduleSessionRow(');
  const rowEnd = html.indexOf('function scheduleWeekCardsHtml(', rowStart);
  const row = html.slice(rowStart, rowEnd);
  assert.match(timeline, /scheduleSessionAttendanceRows\(session, date\)/);
  assert.match(timeline, /is-present[\s\S]*is-late[\s\S]*is-absent[\s\S]*is-early[\s\S]*is-pending/);
  assert.doesNotMatch(timeline, /scheduleAttendanceOverviewHtml\(/);
  assert.match(row, /const shown = names\.join\(', '\)/);
  assert.doesNotMatch(row, /외 ' \+ \(names\.length/);
  assert.match(html, /\.schedule-flow-attendance\.is-pending \{ background: #FEE2E2; color: #B91C1C; \}/);
});

test('internal schedule views use the stable student compact school-grade label', () => {
  const names = functionSource('scheduleSessionNames');
  const timeline = functionSource('scheduleTimelineHtml');
  const modal = functionSource('scheduleTimelineModal');
  const cards = functionSource('scheduleStudentCardsHtml');

  assert.match(names, /staffStudentCompactLabelById\(entry\.studentId, entry\.studentName, entry\.grade\)/);
  assert.match(timeline, /staffStudentCompactLabelById\(entry\.studentId, entry\.studentName, entry\.grade\)/);
  assert.match(modal, /studentDisplayGradeLabel\(rosterStudentByStableId\(entry\.studentId\), entry\.grade\)/);
  assert.match(cards, /studentDisplayGradeLabel\(student, grade\)/);
});

test('schedule search keeps aggregate teacher matches spread across multiple rows', () => {
  const source = functionSource('scheduleSearchPlan');
  const match = (value, terms) => terms.every(term => String(value || '').toLowerCase().includes(term));
  const any = (value, terms) => terms.some(term => String(value || '').toLowerCase().includes(term));
  const run = new Function('scheduleSearchMatch', 'scheduleSearchAny', source +
    '; return scheduleSearchPlan("김선생", "김선생 학생a 학생b", ["월 학생a", "화 학생b"], ["학생a", "학생b"]);');
  assert.deepEqual(run(match, any), { card: true, rows: [true, true] });
});

test('schedule UI prioritizes warnings and collapses secondary detail without breaking search', () => {
  assert.match(html, /\.schedule-card-grid \{[^}]*align-items: start;/);
  assert.match(html, /\.schedule-week-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(html, /schedule-person-card' \+ \(warnings \? ' is-attention'/);
  assert.match(html, /<details class="card schedule-roster-only" data-schedule-collapsible>/);
  assert.match(html, /function scheduleRowsHtml\(rows\)/);
  assert.match(html, /추가 수업 ' \+\s*\(rows\.length - 4\) \+ '개 보기/);
  assert.match(html, /전체 지표는 유지됩니다 · ' \+ shown \+ '개 카드가 검색되었습니다\./);
  assert.match(html, /data-act="lessonedit" data-id="' \+ esc\(task\.id\)/);
  assert.match(html, /\[pendingCount \+ ' · ' \+ conflictCount, '미확정 · 학생 겹침'/);
  assert.match(html, /scheduleView === 'day' && session\.isAdmin && cursor === seoulNowParts\(\)\.date/);
});

test('student warning priority uses the actual warning count', () => {
  const source = functionSource('scheduleStudentWarningCount');
  const count = new Function(source + '; return scheduleStudentWarningCount;')();
  const conflicts = new Set(['2026-08-10|a', '2026-08-10|b', '2026-08-10|c']);
  const multiple = { entries: ['a', 'b', 'c'].map(key => ({ date: '2026-08-10', key })), issues: [] };
  const pending = { entries: [], issues: [{}] };
  assert.equal(count(multiple, conflicts, false), 3);
  assert.equal(count(pending, conflicts, false), 1);
});

test('weekly dashboard walks Monday through Sunday and deduplicates repeated review issues', () => {
  const source = functionSource('weeklyLessonSchedule');
  const run = new Function('mondayOf', 'addDays', 'dailyLessonSchedule', 'occursOn',
    source + '; return weeklyLessonSchedule("anchor");');
  const dates = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const result = run(() => 'mon', (date, offset) => dates[offset], date => ({
    entries: [{ key: date }],
    issues: [{ task: { id: 'same-task' }, code: 'needs_review', source: '확인 필요' }]
  }), () => true);
  assert.deepEqual(result.days, dates);
  assert.deepEqual(result.entries.map(entry => entry.date), dates);
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.issues[0].dates, dates);
});

test('roster identity lookup only uses students active in the requested period', () => {
  const source = functionSource('rosterStudentMatches');
  const run = new Function('window', 'rosterDb', 'activeDuringWeek', 'activeIn', 'today',
    source + '; return rosterStudentMatches("동명학생", "중1", "2026-08-03");');
  const former = { id: 'former', name: '동명학생', grade: '중1' };
  const current = { id: 'current', name: '동명학생', grade: '중1' };
  const result = run({ WBScheduleCore: core }, { students: [former, current] }, () => [former, current],
    month => month === '2026-08' ? [current] : [former], () => '2026-08-10');
  assert.deepEqual(result.map(student => student.id), ['current']);
});

/* 버전을 안 올리면 앱이 '새 버전이 있습니다' 배너를 띄우지 못해, 원장님은
   파일을 올려도 옛 화면을 계속 보게 된다. 실제로 한 번 그렇게 놓쳤다.
   특정 파일 하나만 검사하면 새로 추가한 스크립트가 빠져나가므로 전부 본다. */
test('task page and deployment version stay aligned', () => {
  assert.match(version.v, /^\d{4}-\d{2}-\d{2}\.\d+$/, 'version.json 형식');

  const appVer = html.match(/const APP_VER = '([^']+)';/);
  assert.ok(appVer, 'APP_VER 선언을 찾지 못했습니다');
  assert.equal(appVer[1], version.v, 'APP_VER 와 version.json 이 어긋나면 새로고침 안내가 안 뜬다');

  const localScripts = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map(m => m[1]);
  assert.ok(localScripts.length >= 4, '로컬 스크립트를 찾지 못했습니다');
  localScripts.forEach(src => {
    assert.ok(src.includes('?v=' + version.v),
      src + ' 에 현재 버전의 캐시버스터가 없습니다 — 브라우저가 옛 파일을 씁니다');
  });
});
