const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} block`);
  return html.slice(from, to);
}

test('lesson contact button carries the assigned task context', () => {
  assert.match(html,
    /data-act="ctlog" data-id="' \+ esc\(t\.id\) \+ '" data-date="' \+ esc\(date\) \+ '" data-name=/);
});

test('manager roster contact buttons carry the stable student context', () => {
  const roster = block('function viewRoster()', 'function viewStaffAdmin()');
  assert.match(roster, /data-act="ctlog" data-student-id="' \+ esc\(s\.id\) \+ '"/);
  assert.match(roster, /data-act="ctlog" data-student-id="' \+ esc\(x\.s\.id\) \+ '"/);
});

test('teachers may open and save contact logs only from their assigned lesson', () => {
  const open = block("case 'ctlog':", "case 'oplog':");
  const save = block("case 'ctsave':", "case 'bkopen':");
  for (const source of [open, save]) {
    assert.match(source, /session\.isStaffLink/);
    assert.match(source, /t\.staffId === session\.staffId/);
    assert.match(source, /isLesson\(t\)/);
    assert.match(source, /!session\.isAdmin && !ownLesson/);
  }
});

test('teacher contact waits for the validated endpoint before showing success', () => {
  const save = block("case 'ctsave':", "case 'bkopen':");
  const teacherBranch = save.slice(save.indexOf('const endpointContact'), save.indexOf('setCheck(ctKey(name)'));
  assert.match(teacherBranch, /sync\.post\('\/contact-log'/);
  assert.match(teacherBranch, /sourceTaskId: t \? t\.id : ''/);
  assert.match(teacherBranch, /studentId: directStudentId/,
    'the roster path identifies the student without forging the lesson path');
  assert.doesNotMatch(teacherBranch, /studentName:|done:\s*true/,
    'the endpoint derives the student name and does not touch lesson progress');
  assert.match(teacherBranch, /expectedUpdatedAt:/);
  assert.match(teacherBranch, /contact\.date \|\| row\.date \|\| ''\) !== today\(\)/,
    'yesterday contact revisions cannot block a new daily row');
  assert.ok(teacherBranch.indexOf(".then(result =>") < teacherBranch.indexOf("기록 완료"),
    'success is shown only after the server responds');
  assert.match(teacherBranch, /state\.checks\[result\.key\] = result\.record/);
  assert.match(teacherBranch, /연락 기록을 저장하지 못했습니다/);
  assert.match(save, /session\.isAdmin && directStudentId/,
    'a manager personal link uses the same stable daily endpoint from the roster');
  assert.match(save, /setCheck\(ctKey\(name\), today\(\), \{ done: true/,
    'the root admin legacy history remains readable and writable');
});

test('server-authored contact rows retain their actor owner in the local cache', () => {
  const owner = block('function ownerOfCheck(key)', 'function onboardingReconcileChanges');
  assert.match(owner, /isContactCheckKey\(key\)/);
  assert.match(owner, /\.contact \|\| \{\}\)\.byStaffId/);
  const collect = block('collect(since) {', 'apply(changes) {');
  assert.match(collect, /if \(isContactCheckKey\(k\)\) return/,
    'server-authored contact rows are never sent to an older generic sync worker');
});

test('contact history merges legacy name records and separate stable-student records', () => {
  const source = block('function contactsOf(name, studentId)', 'function daysSinceContact');
  assert.match(source, /k\.startsWith\(pre\)/);
  assert.match(source, /isContactCheckKey\(k\)/);
  assert.match(source, /check\.contact/);
  assert.match(source, /contact\.studentId/);
  assert.match(source, /contact\.sourceTaskId/);
  assert.match(source, /sourceTask\.studentName \|\| studentOf\(sourceTask\)/);
  assert.doesNotMatch(source, /latestByDate/,
    'different authorized actors on the same day remain visible instead of being hidden');
});
