const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(startText, endText) {
  const start = html.indexOf(startText);
  assert.ok(start >= 0, startText + ' block exists');
  const end = html.indexOf(endText, start + startText.length);
  assert.ok(end > start, endText + ' block ends');
  return html.slice(start, end);
}

function studentLabelHelperSource() {
  return block('function schoolLevelLabel(school)', 'function taskRosterStudent(t)');
}

test('lesson attendance offers present, late, absent, and early leave', () => {
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');
  assert.match(panel, /\['P', '출석'\]/);
  assert.match(panel, /\['L', '지각'\]/);
  assert.match(panel, /\['A', '결석'\]/);
  assert.match(panel, /\['E', '조퇴'\]/);
  assert.match(html, /E: \['조퇴', 'doing'\]/);
});

test('only quick first-time present skips confirmation; corrections and absences confirm', () => {
  const click = block("case 'latt':", "case 'fbtext':");
  assert.match(click, /if \(!attendanceLabel \|\| !\['P', 'L', 'A', 'E', ''\]\.includes\(v\)\) break;/);
  assert.match(click, /quick && v === 'P' && !\(getCheck\(id, date\) \|\| \{\}\)\.att/);
  assert.match(click, /&& !confirm\(attendanceLabel \+ ' 상태로 저장하겠습니까\?'\)\) break;/);
  assert.match(click, /const next = v;/);
  assert.doesNotMatch(click, /c && c\.att === v/);
});

test('schedule attendance uses early leave and the exact incomplete label', () => {
  const source = block('function scheduleAttendance(entry, date)', 'const SCHEDULE_VIEWS');
  const getCheck = (_id, date) => date === 'early' ? { att: 'E' } : null;
  const scheduleAttendance = new Function('getCheck', 'const session={isAdmin:true};' + source + '; return scheduleAttendance;')(getCheck);
  assert.deepEqual(scheduleAttendance({ task: { id: 'lesson-a' } }, 'early'), {
    value: 'E', label: '조퇴', cls: 'warn'
  });
  assert.deepEqual(scheduleAttendance({ task: { id: 'lesson-a' } }, 'pending'), {
    value: '', label: '미완료', cls: 'warn'
  });
});

test('teacher flow keeps student-by-student attendance while the redundant overview stays hidden', () => {
  const source = block('function scheduleAttendance(entry, date)', 'const SCHEDULE_VIEWS');
  const checks = { present: { att: 'P' }, late: { att: 'L' }, absent: { att: 'A' }, early: { att: 'E' } };
  const helpers = new Function('getCheck', 'esc', 'rosterDb', 'const session={isAdmin:true};' + studentLabelHelperSource() + source +
    '; return { scheduleAttendanceOverviewHtml, scheduleAttendanceSummaryText };')(
    taskId => checks[taskId] || null, String, { students: [] }
  );
  const session = {
    label: '16:00–17:00', entries: [
      ['present', '가학생'], ['late', '나학생'], ['absent', '다학생'], ['early', '라학생'], ['pending', '마학생']
    ].map(([id, studentName]) => ({ task: { id }, studentName }))
  };
  const output = helpers.scheduleAttendanceOverviewHtml({
    rows: [{ teacherName: '김선생', sessions: [session] }]
  }, '2026-08-19');
  for (const text of ['가학생 · 출석', '나학생 · 지각', '다학생 · 결석', '라학생 · 조퇴', '마학생 · 미완료']) {
    assert.match(output, new RegExp(text));
  }
  assert.equal(helpers.scheduleAttendanceSummaryText(session, '2026-08-19'),
    '출석 1 · 지각 1 · 결석 1 · 조퇴 1 · 미완료 1');

  const overview = block('function scheduleAttendanceOverviewHtml(timeline, date)', 'const SCHEDULE_VIEWS');
  const timeline = block('function scheduleTimelineHtml(timeline, date, nowKst)', 'function scheduleTimelineModal');
  assert.match(overview, /schedule-attendance-overview/);
  assert.match(overview, /schedule-attendance-pill/);
  assert.match(overview, /staffStudentCompactLabelById\(entry\.studentId, entry\.studentName, entry\.grade\)/);
  assert.match(overview, /esc\(att\.label\)/);
  assert.match(timeline, /scheduleAttendanceSummaryText\(session, date\)/);
  assert.doesNotMatch(timeline, /scheduleAttendanceOverviewHtml\(timeline, date\)/);
  assert.match(timeline, /scheduleSessionAttendanceRows\(session, date\)/);
  assert.match(timeline, /visual\.attendanceRows\.map/);
  assert.match(timeline, /scheduleAttendanceBlockHeight\(attendanceRows, width, prefix\)/);
  assert.match(html, /\.schedule-flow-attendance \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(html, /\.schedule-flow-attendance b \{[^}]*overflow: visible;[^}]*text-overflow: clip;[^}]*white-space: nowrap;/);
  assert.match(html, /\.schedule-flow-attendance i \{[^}]*display: block;[^}]*white-space: nowrap;/);
  for (const cls of ['is-present', 'is-late', 'is-absent', 'is-early', 'is-pending']) {
    assert.match(html, new RegExp('\\.schedule-flow-attendance\\.' + cls));
  }
});

test('attendance reset preserves lesson notes and progress, and requires confirmation', async () => {
  const click = block("case 'latt':", "case 'fbtext':");
  const setters = block('function setCheck(taskId, date, patch)', '/* ═');
  for (const before of ['P', 'L', 'A', 'E']) {
    for (const accepted of [false, true]) {
      const original = { taskId:'lesson-a',date:'2026-11-05',att:before,absenceType:'unexcused',note:'메모',steps:{a:true},done:true,updatedAt:1 };
      const state={checks:{'lesson-a|2026-11-05':original}};
      const reconciled=[];let confirmations=0;
      const env={state, ckey:(id,date)=>id+'|'+date, now:()=>2,save:()=>{},queueSync:()=>{},
        el:{dataset:{v:''}},task:()=>({id:'lesson-a'}),id:'lesson-a',date:'2026-11-05',
        ATT_LABEL:{P:['출석'],L:['지각'],A:['결석'],E:['조퇴']},
        makeupCreateKey:(id,date)=>id+'|'+date,makeupAttendanceReconcileStates:new Map(),
        sessionPackAttendanceState:()=>null,confirm:()=>{confirmations++;return accepted;},
        getCheck:(id,date)=>state.checks[id+'|'+date],isMakeupLessonTask:()=>true,
        reconcileMakeupAfterAttendanceCorrection:(...args)=>reconciled.push(args),
        settleSync:async()=>{},makeupCreateStates:new Map(),toast:()=>{},render:()=>{}
      };
      const run=new Function(...Object.keys(env),setters+'\nreturn async()=>{ switch("latt"){'+click+'} };')(...Object.values(env));
      await run();
      assert.equal(confirmations,1);
      const current=state.checks['lesson-a|2026-11-05'];
      assert.equal(current.att,accepted?'':before);
      assert.equal(current.note,'메모');assert.deepEqual(current.steps,{a:true});assert.equal(current.done,true);
      assert.equal(reconciled.length,accepted&&before==='A'?1:0);
      if(reconciled.length) assert.equal(reconciled[0][3],'');
    }
  }
});

test('incomplete action is available in quick attendance, lesson panel, and admin correction', () => {
  assert.match(block('function quickAttendanceHtml', 'async function saveQuickAttendanceBatch'), /button\('', '미완료'\)/);
  assert.match(block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */'), /\['', '미완료'\]/);
  assert.match(block('async function openSessionAttendanceCorrection', 'async function saveSessionAttendanceCorrection'), /\['','미완료'\]/);
});
