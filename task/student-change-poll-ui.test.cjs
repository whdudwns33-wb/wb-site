const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function sourceBlock(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `${startText} 구간을 찾을 수 있어야 한다`);
  return source.slice(start, end);
}

function studentChangeHarness() {
  const functionSource = sourceBlock(
    'async function loadStudentChanges(force)',
    'async function acknowledgeStudentChanges'
  );
  const create = new Function('deps', `
    let studentChangeEvents = [], studentChangeLoaded = false, studentChangeLoading = false, studentChangeError = '';
    const sync = deps.sync, SYNC_APP = 'task', session = deps.session, state = deps.state;
    const save = deps.save, loadRoster = deps.loadRoster, loadBookIssues = deps.loadBookIssues;
    const renderAfterSync = deps.renderAfterSync;
    let rosterDb = { students: [{ id: 'student-a', name: '학생' }] }, rosterErr = 'old error';
    let rosterLoadGeneration = 0, rosterReloadAfterCurrent = false;
    let privateBookStudents = [{ studentId: 'student-a' }];
    let privateBookOrderStudents = [{ id: 'student-a' }];
    let bookDb = { students: [{ studentId: 'student-a' }] };
    let bookIssueLoaded = true, bookIssueRows = [{ studentId: 'student-a' }];
    let bookOrderRows = [{ studentId: 'student-a' }], bookIssueError = 'old error';
    let bookIssueLoading = false, bookIssueLoadGeneration = 0, bookIssueReloadAfterCurrent = false;
    ${functionSource}
    return {
      loadStudentChanges,
      snapshot: () => ({ studentChangeEvents, studentChangeLoaded, studentChangeLoading,
        rosterDb, rosterErr, privateBookStudents, privateBookOrderStudents, bookDb,
        rosterLoadGeneration, rosterReloadAfterCurrent,
        bookIssueLoaded, bookIssueRows, bookOrderRows, bookIssueError,
        bookIssueLoadGeneration, bookIssueReloadAfterCurrent })
    };
  `);

  let currentEvents = [];
  let firstResolve = null;
  let deferFirst = true;
  const counters = { post: 0, save: 0, roster: 0, books: 0, render: 0 };
  const deps = {
    sync: {
      auth: () => ({ mode: 'person', id: 'teacher-old', token: 'test-token' }),
      post: async () => {
        counters.post += 1;
        if (deferFirst) {
          deferFirst = false;
          return await new Promise(resolve => { firstResolve = resolve; });
        }
        return { events: currentEvents };
      }
    },
    session: { isStaffLink: true, isAdmin: false, staffId: 'teacher-old' },
    state: { tasks: [{ id: 'lesson-a', staffId: 'teacher-old', studentId: 'student-a', deleted: false }] },
    save: () => { counters.save += 1; },
    loadRoster: () => { counters.roster += 1; },
    loadBookIssues: force => { assert.equal(force, false); counters.books += 1; },
    renderAfterSync: () => { counters.render += 1; }
  };
  return {
    ...create(deps), deps, counters,
    resolveFirst(events) { firstResolve({ events }); },
    setEvents(events) { currentEvents = events; }
  };
}

function scopedReloadHarness(deps) {
  const invalidateSource = sourceBlock(
    'function invalidateReassignedStudentScopeCaches()',
    'async function acknowledgeStudentChanges'
  );
  const rosterSource = sourceBlock('function loadRoster()', 'function ymNext');
  const bookIssueSource = sourceBlock('async function loadBookIssues(force)', 'function bookIssueMatches');
  const create = new Function('deps', `
    const sync = deps.sync, SYNC_APP = 'task', session = { isStaffLink: true };
    const route = 'today', validRosterPayload = value => !!value && Array.isArray(value.students);
    const loadStudentChanges = deps.loadStudentChanges, renderAfterSync = deps.renderAfterSync;
    let rosterDb = { students: [{ id: 'stale-before' }] }, rosterErr = '', rosterLoading = false;
    let rosterLoadGeneration = 0, rosterReloadAfterCurrent = false, rosterStudentSelectionScope = 'lesson_students';
    let privateBookStudents = [{ studentId: 'stale-before' }], privateBookOrderStudents = [{ id: 'stale-before' }];
    let bookDb = { students: [{ studentId: 'stale-before' }] };
    let bookIssueRows = [{ studentId: 'stale-before' }], bookOrderRows = [{ studentId: 'stale-before' }];
    let bookIssueLoaded = true, bookIssueLoading = false, bookIssueError = '';
    let bookIssueLoadGeneration = 0, bookIssueReloadAfterCurrent = false;
    ${bookIssueSource}
    ${rosterSource}
    ${invalidateSource}
    return {
      loadRoster, loadBookIssues, invalidateReassignedStudentScopeCaches,
      snapshot: () => ({ rosterDb, rosterLoading, rosterLoadGeneration, rosterReloadAfterCurrent,
        privateBookStudents, privateBookOrderStudents, bookDb,
        bookIssueRows, bookOrderRows, bookIssueLoaded, bookIssueLoading,
        bookIssueLoadGeneration, bookIssueReloadAfterCurrent })
    };
  `);
  return create(deps);
}

test('보이는 개인 링크는 15초마다 학생 변경을 확인하고 visibilitychange 갱신도 유지한다', () => {
  const interval = sourceBlock('startSyncSession();', '/* ── 새 버전 감지');
  assert.match(interval, /const auth = sync\.auth\(\)/);
  assert.match(interval, /document\.visibilityState === 'visible'/);
  assert.match(interval, /session\.isStaffLink && !session\.isAdmin && auth\.mode === 'person'/);
  assert.match(interval, /loadStudentChanges\(true\)/);
  assert.match(interval, /}, 15000\);/);

  const visibility = sourceBlock("document.addEventListener('visibilitychange'", '/* ══');
  assert.match(visibility, /loadStudentChanges\(true\)/);
});

test('학생 변경 폴링은 중복 요청과 무변경 렌더를 막고 담당 이전 캐시를 즉시 비운다', async () => {
  const harness = studentChangeHarness();

  const first = harness.loadStudentChanges(true);
  const duplicate = harness.loadStudentChanges(true);
  assert.equal(harness.counters.post, 1);
  harness.resolveFirst([]);
  await Promise.all([first, duplicate]);
  assert.equal(harness.counters.render, 1);

  harness.setEvents([]);
  await harness.loadStudentChanges(true);
  assert.equal(harness.counters.post, 2);
  assert.equal(harness.counters.render, 1, '같은 응답의 주기 폴링은 전체 화면을 다시 그리지 않는다');

  harness.setEvents([{
    eventType: 'teacher_assignment', taskId: 'lesson-a', studentId: 'student-a',
    details: { beforeStaffId: 'teacher-old', afterStaffId: 'teacher-new' }
  }]);
  await harness.loadStudentChanges(true);

  const snapshot = harness.snapshot();
  assert.equal(harness.deps.state.tasks[0].deleted, true);
  assert.equal(harness.deps.state.tasks[0].reassigned, true);
  assert.equal(harness.counters.save, 1);
  assert.equal(snapshot.rosterDb, null);
  assert.deepEqual(snapshot.privateBookStudents, []);
  assert.deepEqual(snapshot.privateBookOrderStudents, []);
  assert.deepEqual(snapshot.bookDb.students, []);
  assert.deepEqual(snapshot.bookIssueRows, []);
  assert.deepEqual(snapshot.bookOrderRows, []);
  assert.equal(harness.counters.roster, 1);
  assert.equal(harness.counters.books, 1);
  assert.equal(harness.counters.render, 2);
});

test('담당 이전 중 이미 진행 중인 원생·교재 응답은 폐기하고 최신 범위를 다시 조회한다', async () => {
  const pending = { roster: [], books: [] };
  const calls = { roster: 0, books: 0 };
  const harness = scopedReloadHarness({
    sync: {
      auth: () => ({ mode: 'person', id: 'teacher-old', token: 'test-token' }),
      post: (requestPath) => new Promise(resolve => {
        if (requestPath === '/roster') { calls.roster += 1; pending.roster.push(resolve); }
        else if (requestPath === '/book-issue') { calls.books += 1; pending.books.push(resolve); }
        else throw new Error('unexpected path ' + requestPath);
      })
    },
    loadStudentChanges: () => {},
    renderAfterSync: () => {}
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));

  harness.loadRoster();
  const oldBookRequest = harness.loadBookIssues(true);
  assert.deepEqual(calls, { roster: 1, books: 1 });

  harness.invalidateReassignedStudentScopeCaches();
  let snapshot = harness.snapshot();
  assert.equal(snapshot.rosterDb, null);
  assert.deepEqual(snapshot.bookIssueRows, []);

  pending.roster.shift()({
    roster: { students: [{ id: 'stale-response', name: '이전 범위 학생' }] },
    bookStudents: [{ studentId: 'stale-response' }], bookOrderStudents: [{ id: 'stale-response' }], updatedAt: 1
  });
  pending.books.shift()({
    issues: [{ studentId: 'stale-response' }], orders: [{ studentId: 'stale-response' }]
  });
  await oldBookRequest;
  await flush();

  snapshot = harness.snapshot();
  assert.equal(snapshot.rosterDb, null, '이전 세대 원생 응답을 다시 캐시에 넣지 않는다');
  assert.deepEqual(snapshot.bookIssueRows, [], '이전 세대 교재 응답을 다시 캐시에 넣지 않는다');
  assert.deepEqual(calls, { roster: 2, books: 2 });

  pending.roster.shift()({
    roster: { students: [{ id: 'current-scope', name: '현재 담당 학생' }] },
    bookStudents: [{ studentId: 'current-scope' }], bookOrderStudents: [{ id: 'current-scope' }], updatedAt: 2
  });
  pending.books.shift()({
    issues: [{ studentId: 'current-scope' }], orders: [{ studentId: 'current-scope' }]
  });
  await flush();
  await flush();

  snapshot = harness.snapshot();
  assert.deepEqual(snapshot.rosterDb.students.map(row => row.id), ['current-scope']);
  assert.deepEqual(snapshot.privateBookOrderStudents.map(row => row.id), ['current-scope']);
  assert.deepEqual(snapshot.bookIssueRows.map(row => row.studentId), ['current-scope']);
  assert.deepEqual(snapshot.bookOrderRows.map(row => row.studentId), ['current-scope']);
});
