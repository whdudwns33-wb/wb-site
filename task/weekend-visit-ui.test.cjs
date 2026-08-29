const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return html.slice(from, to);
}

test('weekend actual visits are separate from lesson checks and cover every weekend subject', () => {
  const source = block('function isWeekendVisitDate(', '/* ── 오늘 ──');
  assert.match(source, /function taskHasWeekendSchedule\(task\)/);
  assert.match(source, /day === 0 \|\| day === 6/);
  assert.doesNotMatch(source, /독해력수업|독해력훈련|국어|질답/);
  assert.match(source, /sync\.post\('\/weekend-visit'/);
  assert.match(source, /data-task=/);
  assert.match(source, /data-student-id=/);
  assert.doesNotMatch(source, /setCheck\(/);
});

test('teacher today and manager board expose check-in, checkout, correction, and live state', () => {
  assert.match(html, /if \(isWeekendVisitDate\(cursor\)\) h \+= weekendVisitTeacherHtml\(me, cursor\)/);
  const today = block('function viewToday()', 'function taskRow');
  assert.match(today, /session\.isStaffLink && !session\.isAdmin && me\.id === session\.staffId && cursor === today\(\)/);
  const receivedAt = today.indexOf('teacherReceivedAdminDirectiveHtml(me.id)');
  const composerAt = today.indexOf('teacherLiveRequestComposerHtml(me, cursor)');
  const weekendAt = today.indexOf('weekendVisitTeacherHtml(me, cursor)');
  assert.ok(receivedAt >= 0 && receivedAt < composerAt && composerAt < weekendAt,
    '두 실시간 요청 영역은 주말 실제 등하원 바로 앞에 있어야 한다');
  assert.match(html, /h \+= weekendVisitBoardHtml\(cursor\)/);
  for (const action of ['weekendcheckin', 'weekendcheckout', 'weekendedit', 'weekendsave', 'weekendcancel']) {
    assert.match(html, new RegExp("case '" + action + "'"));
  }
  assert.match(html, /예정 시간표는 그대로 두고 실제 방문 시간만 별도로 기록합니다/);
  assert.match(html, /weekendVisitLoadedKey/);
});

test('weekend visit controls use stable ids and never expose guardian contact fields', () => {
  const source = block('function weekendVisitSequenceNumber(', 'function weekendVisitTimestamp(');
  assert.match(source, /task\.studentId/);
  assert.match(source, /row\.lessonTaskId/);
  assert.match(source, /byTask\.get\(taskId\)\.push\(row\)/,
    'each lesson task must render an array of visits instead of overwriting one row');
  assert.match(source, /weekend-visit-history/);
  assert.match(source, /weekend-visit-period/);
  assert.match(source, /방문 ' \+ weekendVisitSequenceNumber/);
  assert.match(source, /오전/);
  assert.match(source, /오후/);
  assert.match(source, /if \(!active && canRecordNow && task\)/,
    'an active visit must suppress another check-in');
  assert.match(source, /추가 등원/);
  assert.match(source, /data-visit-sequence=/);
  assert.match(source, /weekendVisitNextSequences/,
    'the UI must preserve the server-computed sequence that includes cancelled history');
  assert.match(source, /등원 중 ' \+ active \+ '건 · 하원 완료 ' \+ complete \+ '건/);
  assert.doesNotMatch(source, /phone|contact|guardian|연락처/);
});

test('every weekend check-in sends the selected visit sequence to the worker', () => {
  const actions = block("case 'weekendflexcheckin':", "case 'weekendopensource':");
  assert.match(actions, /const visitSequence = Number\(el\.dataset\.visitSequence\)/);
  assert.match(actions, /visitSequence:\s*visitSequence/);
  const normal = block("case 'weekendcheckin':", "case 'weekendopensource':");
  assert.match(normal, /const visitSequence = Number\(el\.dataset\.visitSequence\)/);
  assert.match(normal, /visitSequence:\s*visitSequence/);
});
