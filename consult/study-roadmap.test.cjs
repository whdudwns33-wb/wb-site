const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start + marker.length);
  let depth = 0, quote = '', escaped = false;
  for (let i = open; i < html.length; i++) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(name + ' function is incomplete');
}

function section(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'source block not found: ' + start);
  return html.slice(from, to);
}

const dates = `
  function ymd(d) { const p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
  function parseYmd(s) { const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }
  function addDays(s,n) { const d=parseYmd(s); d.setDate(d.getDate()+n); return ymd(d); }
  function dowOf(s) { return parseYmd(s).getDay(); }
`;

test('roadmap divides an inclusive range evenly across selected study days', () => {
  const schedule = Function(`${dates}${functionSource('studyRoadmapSchedule')}\nreturn studyRoadmapSchedule;`)();
  const item = {
    rangeStart: 30, rangeEnd: 44,
    startDate: '2026-09-21', endDate: '2026-09-25', days: [1, 3, 5]
  };
  assert.deepEqual(schedule(item, 30, item.startDate, new Set()), [
    { date: '2026-09-21', start: 30, end: 34, amount: 5 },
    { date: '2026-09-23', start: 35, end: 39, amount: 5 },
    { date: '2026-09-25', start: 40, end: 44, amount: 5 }
  ]);
  assert.deepEqual(schedule({ ...item, rangeStart: 44, rangeEnd: 30 }, 44, item.startDate, new Set()), []);
  assert.deepEqual(schedule({ ...item, days: [] }, 30, item.startDate, new Set()), []);
  assert.deepEqual(schedule({ ...item, startDate: '2026-09-26', endDate: '2026-09-25' }, 30, '2026-09-26', new Set()), []);
});

test('roadmap exists only for selected students and is managed by the director', () => {
  const source = section('const STUDY_ROADMAP_AUTO', '/* ══════════════════════════════════════════════════════\n   회독');
  const study = section('function viewStudy()', 'function rdAddModal(');
  const week = section('function viewWeek()', '/* ── 월간 플래너 ── */');
  const staff = section('function staffAccessPanels(', 'function viewStaffAdmin(');
  const handlers = section("case 'roadmapopen':", '/* 회독 */');

  const active = Function(`${functionSource('studyRoadmapOf')}\n${functionSource('studyRoadmapActive')}\nreturn studyRoadmapActive;`)();
  assert.equal(active({ name: '일반 학생' }), false);
  assert.equal(active({ studyRoadmap: { targetSchool: '목표고', items: [] } }), false);
  assert.equal(active({ studyRoadmap: { targetSchool: '목표고', items: [{ id: 'r1', book: '수학책' }] } }), true);

  assert.match(source, /if \(!roadmap\.targetSchool \|\| !roadmap\.items\.length\) return ''/);
  assert.match(source, /esc\(roadmap\.targetSchool\)/);
  assert.match(source, /esc\(item\.book\)/);
  assert.match(study, /studyRoadmapCard\(me\)/);
  assert.match(week, /studyRoadmapWeekCard\(me, mon, days\)/);
  assert.match(staff, /data-act="roadmapopen"/);
  assert.match(handlers, /if \(!session\.isAdmin \|\| session\.isStaffLink\) break/);
  assert.match(handlers, /student\.studyRoadmap =/);
  assert.match(handlers, /student\.updatedAt = now\(\)/);
  assert.match(handlers, /save\(\)/);
  assert.match(handlers, /queueSync\(\)/);
});

test('generated roadmap study reuses checklist, carry, and completion records without duplicates', () => {
  const api = Function(`${dates}
    const STUDY_ROADMAP_AUTO='study-roadmap-v1';
    const STUDY_ROADMAP_UNITS={page:'쪽',chapter:'단원',lecture:'강',problem:'문제',word:'단어'};
    let state={tasks:[],checks:{}};
    function now(){return 1000;}
    function today(){return '2026-09-21';}
    ${functionSource('studyRoadmapOf')}
    ${functionSource('studyRoadmapRangeText')}
    ${functionSource('studyRoadmapSchedule')}
    ${functionSource('studyRoadmapTasks')}
    ${functionSource('studyRoadmapTaskHasCheck')}
    ${functionSource('studyRoadmapTaskDone')}
    ${functionSource('studyRoadmapTaskReplaceable')}
    ${functionSource('studyRoadmapProgress')}
    ${functionSource('commitStudyRoadmapItem')}
    return { state, commitStudyRoadmapItem, studyRoadmapProgress };
  `)();
  const student = { id: 'student-a', studyRoadmap: { targetSchool: '목표고등학교', items: [] } };
  const item = {
    id: 'book-a', subject: 'math', book: '쎈 중3-1', unit: 'page', rangeStart: 30, rangeEnd: 44,
    startDate: '2026-09-21', endDate: '2026-09-25', days: [1, 3, 5], estimatedMin: 40
  };
  student.studyRoadmap.items = [item];
  api.commitStudyRoadmapItem(student, item);
  assert.equal(api.state.tasks.length, 3);
  assert.deepEqual(api.state.tasks.map(task => task.start), ['2026-09-21', '2026-09-23', '2026-09-25']);
  api.state.tasks.forEach(task => {
    assert.equal(task.staffId, 'student-a');
    assert.equal(task.studySubject, 'math');
    assert.equal(task.requiresClaim, false);
    assert.equal(task.carry, true);
    assert.equal(task.repeat, 'once');
    assert.match(task.detail, /목표고등학교 목표/);
  });

  api.commitStudyRoadmapItem(student, item);
  assert.equal(api.state.tasks.filter(task => !task.deleted).length, 3, 'resaving must keep one task per planned range');

  const first = api.state.tasks.find(task => !task.deleted && task.roadmapRangeStart === 30);
  api.state.checks[first.id + '|' + first.start] = { done: true };
  api.commitStudyRoadmapItem(student, item);
  assert.equal(first.deleted, false, 'completed study must survive replanning');
  assert.deepEqual(api.studyRoadmapProgress(student, item), { done: 5, total: 15, pct: 33 });

  api.state.tasks.push({ ...first, id: 'daily-carry-' + first.id, start: '2026-09-22', dailyCarryFrom: first.id + '|' + first.start });
  api.state.checks['daily-carry-' + first.id + '|2026-09-22'] = { done: true };
  assert.deepEqual(api.studyRoadmapProgress(student, item), { done: 5, total: 15, pct: 33 },
    'a carried copy must not count the same range twice');

  item.rangeStart = 20;
  api.commitStudyRoadmapItem(student, item);
  const assigned = new Set();
  api.state.tasks.filter(task => !task.deleted && task.roadmapItemId === item.id).forEach(task => {
    for (let unit = task.roadmapRangeStart; unit <= task.roadmapRangeEnd; unit++) assigned.add(unit);
  });
  assert.deepEqual([...assigned].sort((a, b) => a - b), Array.from({ length: 25 }, (_, index) => index + 20),
    'moving the start earlier after completion must still schedule the newly added front range');
});

test('roadmap tasks cannot be manually edited or moved outside roadmap settings', () => {
  const permissions = section('function canEditTask(', 'function paintStatus(');
  const week = section("case 'weekmove':", "case 'weekmoveto':");
  const month = section("case 'monthmove':", "case 'monthdrop':");
  assert.match(permissions, /t\.auto === STUDY_ROADMAP_AUTO/);
  assert.match(week, /교재 로드맵 설정/);
  assert.match(month, /교재 로드맵 설정/);
  assert.match(month, /하루 마무리에서 이월/);
});
