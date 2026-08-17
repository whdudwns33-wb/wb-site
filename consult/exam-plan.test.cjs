const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function between(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'source block not found: ' + start);
  return html.slice(from, to);
}

function statementSource(marker) {
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, marker + ' statement must exist');
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '(' || char === '[' || char === '{') depth++;
    if (char === ')' || char === ']' || char === '}') depth--;
    if (char === ';' && depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(marker + ' statement is incomplete');
}

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start + marker.length);
  let depth = 0;
  let quote = '';
  let escaped = false;
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

function eventCase(name) {
  const marker = "case '" + name + "':";
  const start = html.indexOf(marker);
  if (start < 0) return '';
  const tail = html.slice(start + marker.length);
  const next = tail.match(/\n\s*case '[^']+':/);
  return html.slice(start, next ? start + marker.length + next.index : html.length);
}

const dateHelpers = `
  const ING_WEEK_DAYS = [1, 2, 3, 4, 5, 6, 0];
  function ymd(d) { const p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
  function parseYmd(s) { const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }
  function addDays(s,n) { const d=parseYmd(s); d.setDate(d.getDate()+n); return ymd(d); }
  function dowOf(s) { return parseYmd(s).getDay(); }
  function ingMinHm(value) { const n=Math.max(0,Math.min(1439,Math.round(value))); return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0'); }
  function ingLectureSpan(lecture) { return Number(lecture._span) || Number(lecture.min) || 50; }
  function academicDateOf(item) { return item.dueDate || item.examDate || item.start || ''; }
`;

function createPreview(configured, slots) {
  const phases = statementSource('const EXAM_PLAN_PHASES');
  const sessions = functionSource('examPlanSessions');
  const pack = between('function ingPackSchedule(', '\nfunction ingBuildSchedule(');
  const preview = functionSource('examPlanPreview');
  return Function(`${dateHelpers}
    ${phases}
    ${sessions}
    ${pack}
    const calls=[];
    const slots=${JSON.stringify(slots || {})};
    function today() { return '2026-08-22'; }
    function ingAvail() { return { configured:${configured ? 'true' : 'false'} }; }
    function ingFreeForDate(sid,date,includePlan) {
      calls.push({sid,date,includePlan});
      return (slots && slots[date]) || [];
    }
    function ingPlan() { return []; }
    ${preview}
    return { examPlanPreview, calls };`)();
}

const settings = {
  conceptCount: 1,
  practiceCount: 1,
  correctionCount: 1,
  reviewCount: 1,
  sessionMin: 50,
  perDay: 2
};

const exam = {
  id: 'exam-1', staffId: 'student-1', academicType: 'exam', title: '2학기 중간고사',
  studySubject: 'math', range: '일차함수', periodStart: '2026-08-22',
  dueDate: '2026-08-24', examDate: '2026-08-24'
};

test('exam plan keeps consult identity and the four learning phases in order', () => {
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);

  const phasesSource = statementSource('const EXAM_PLAN_PHASES');
  const sessionsSource = functionSource('examPlanSessions');
  const api = Function(`${phasesSource}\n${sessionsSource}\nreturn { EXAM_PLAN_PHASES, examPlanSessions };`)();
  assert.deepEqual(api.EXAM_PLAN_PHASES.map(item => item.key), [
    'concept', 'practice', 'correction', 'review'
  ]);
  [/개념/, /문제/, /오답/, /최종/].forEach((pattern, index) =>
    assert.match(api.EXAM_PLAN_PHASES[index].label, pattern));

  const sessions = api.examPlanSessions(settings);
  assert.deepEqual(sessions.map(item => item.phase), [
    'concept', 'practice', 'correction', 'review'
  ]);
  assert.equal(new Set(sessions.map(item => item.planItemKey)).size, sessions.length,
    'each generated session needs a stable key for safe replanning');
  sessions.forEach(item => assert.equal(item._span, 50));
});

test('preview reuses the occupied-time grid and schedules Saturday and Sunday before the exam', () => {
  const api = createPreview(true, {
    // 10:00~11:00 is already removed: Saturday fixed schedule, Sunday lecture plan.
    '2026-08-22': [{s:540,e:600}, {s:660,e:720}],
    '2026-08-23': [{s:540,e:600}, {s:660,e:720}]
  });
  const draft = api.examPlanPreview('student-1', exam, settings);

  assert.equal(draft.complete, true);
  assert.equal(draft.remaining, 0);
  assert.equal(draft.warning, '');
  assert.deepEqual(draft.items.map(item => item.date), [
    '2026-08-22', '2026-08-22', '2026-08-23', '2026-08-23'
  ]);
  assert.deepEqual(draft.items.map(item => item.phase), [
    'concept', 'practice', 'correction', 'review'
  ]);
  assert.ok(draft.items.every(item => item.date < exam.examDate),
    'nothing may be assigned on or after the exam date');
  assert.deepEqual(draft.items.map(item => [item.s, item.e]), [
    ['09:00', '09:50'], ['11:00', '11:50'], ['09:00', '09:50'], ['11:00', '11:50']
  ]);
  assert.ok(api.calls.length >= 2);
  assert.ok(api.calls.every(call => call.sid === 'student-1' && call.includePlan === true),
    'fixed schedules, one-off blocks, and existing lecture plans must stay occupied');
});

test('preview blocks an unconfigured week and warns when free-time capacity is insufficient', () => {
  const blocked = createPreview(false, {});
  const noAvailability = blocked.examPlanPreview('student-1', exam, settings);
  assert.deepEqual(noAvailability.items, []);
  assert.equal(noAvailability.reason, '주간 일정 미설정');
  assert.equal(blocked.calls.length, 0);

  const shortExam = Object.assign({}, exam, { dueDate: '2026-08-23', examDate: '2026-08-23' });
  const limited = createPreview(true, {
    '2026-08-22': [{s:540,e:600}]
  }).examPlanPreview('student-1', shortExam, settings);
  assert.equal(limited.complete, false);
  assert.equal(limited.remaining, 3);
  assert.match(limited.warning, /가용시간|시간.*부족|부족.*시간/);
  assert.ok(limited.items.every(item => item.date < shortExam.examDate));

  const tooShort = createPreview(true, {}).examPlanPreview('student-1', exam, Object.assign({}, settings, {
    sessionMin: 90, totalHours: 2
  }));
  assert.match(tooShort.reason, /4단계|준비시간/);
  const tooMany = createPreview(true, {}).examPlanPreview('student-1', exam, Object.assign({}, settings, {
    sessionMin: 30, totalHours: 100
  }));
  assert.match(tooMany.reason, /100회/);
  assert.doesNotMatch(functionSource('examPlanPreview'), /date => ingPlan\(/,
    'lecture count must not be subtracted twice after its time is already occupied');
});

test('the director previews first and confirms before normal admin tasks are written', () => {
  const card = functionSource('academicItemCard');
  const modal = functionSource('examPlanModal');
  const renderPreview = functionSource('renderExamPlanPreview');
  const open = eventCase('examplanopen');
  const preview = eventCase('examplanpreview');
  const confirm = eventCase('examplanconfirm');
  const remove = eventCase('academicdelete');
  const moveCases = ['weekmove', 'monthmove', 'monthnext'].map(eventCase);

  assert.match(card, /session\.isAdmin/);
  assert.match(card, /item\.academicType === 'exam'/);
  assert.match(card, /data-act="examplanopen"/);
  assert.match(modal, /data-act="examplanpreview"/);
  assert.match(renderPreview, /data-act="examplanconfirm"/);
  [open, preview, confirm].forEach(source => assert.match(source, /if \(!session\.isAdmin\) break/));
  assert.match(preview, /renderExamPlanPreview\(/);
  assert.doesNotMatch(preview, /state\.tasks\.push|commitExamPlan\(|save\(\)|queueSync\(\)/);
  assert.match(confirm, /commitExamPlan\(/);
  assert.match(confirm, /const fresh = examPlanPreview\(/);
  assert.match(confirm, /save\(\)/);
  assert.match(confirm, /queueSync\(\)/);
  assert.match(remove, /examPlanReplaceable\(/,
    'deleting an exam must stop only its future untouched generated sessions');
  moveCases.forEach(source => assert.match(source, /auto === 'exam-plan-v1'/,
    'generated exam sessions must be rescheduled only from academic management'));
});

test('confirmation replaces only future incomplete generated tasks and keeps normal task shape', () => {
  const replaceable = functionSource('examPlanReplaceable');
  const source = functionSource('commitExamPlan');
  const api = Function(`
    let serial=0, saves=0, syncs=0;
    const state={tasks:[
      {id:'past',staffId:'student-1',examId:'exam-1',auto:'exam-plan-v1',start:'2026-08-17',deleted:false},
      {id:'done',staffId:'student-1',examId:'exam-1',auto:'exam-plan-v1',start:'2026-08-20',deleted:false},
      {id:'before-start',staffId:'student-1',examId:'exam-1',auto:'exam-plan-v1',start:'2026-08-20',deleted:false},
      {id:'future',staffId:'student-1',examId:'exam-1',auto:'exam-plan-v1',start:'2026-08-21',deleted:false},
      {id:'manual',staffId:'student-1',examId:'exam-1',start:'2026-08-21',deleted:false},
      {id:'other-exam',staffId:'student-1',examId:'exam-2',auto:'exam-plan-v1',start:'2026-08-21',deleted:false}
    ]};
    function today() { return '2026-08-18'; }
    function isDone(id) { return id === 'done'; }
    function uid() { return 'new-' + (++serial); }
    function now() { return 123456; }
    function save() { saves++; }
    function queueSync() { syncs++; }
    ${replaceable}
    ${source}
    return { commitExamPlan, state, counts:()=>({saves,syncs}) };`)();
  const draft = { items: [{
    date: '2026-08-22', phase: 'concept', planItemKey: 'concept-1',
    title: '개념 정리', min: 50, s: '09:00', e: '09:50'
  }], from: '2026-08-21' };

  api.commitExamPlan('student-1', exam, draft);
  const byId = id => api.state.tasks.find(task => task.id === id);
  assert.equal(byId('past').deleted, false);
  assert.equal(byId('done').deleted, false);
  assert.equal(byId('before-start').deleted, false, 'items before the chosen replanning start stay fixed');
  assert.equal(byId('future').deleted, true);
  assert.equal(byId('manual').deleted, false);
  assert.equal(byId('other-exam').deleted, false);

  const made = api.state.tasks.find(task => task.id === 'exam-plan-exam-1-concept-1');
  assert.ok(made);
  assert.equal(made.kind, undefined, 'generated study stays an existing normal task');
  assert.equal(made.staffId, 'student-1');
  assert.equal(made.origin, 'admin');
  assert.equal(made.auto, 'exam-plan-v1');
  assert.equal(made.examId, 'exam-1');
  assert.equal(made.examPhase, 'concept');
  assert.equal(made.planItemKey, 'concept-1');
  assert.equal(made.estimateMin, 50);
  assert.equal(made.slotStart, '09:00');
  assert.equal(made.slotEnd, '09:50');
  assert.equal(made.repeat, 'once');
  assert.equal(made.start, '2026-08-22');
  assert.ok(!made.deleted);

  api.commitExamPlan('student-1', exam, draft);
  assert.equal(api.state.tasks.filter(task => task.id === made.id).length, 1,
    'the same logical session keeps one deterministic task id across replans and devices');
});
