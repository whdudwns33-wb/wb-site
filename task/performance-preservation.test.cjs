'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
function block(start, end) { return html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start))); }

test('memo index preserves inherited records, comments and three most recent dates after edits and account changes', () => {
  const state = {tasks:[{id:'new',studentId:'s',predecessorTaskId:'old',start:'2026-11-10',
    inheritedLessonMemos:{studentId:'s',sourceTaskId:'old',records:[{taskId:'old',date:'2026-11-09',note:'inherited'}]}}],
    checks:{one:{taskId:'new',date:'2026-11-11',lessonMemo:{comment:'comment only'}},
      other:{taskId:'other',date:'2026-11-12',note:'private'}}};
  const ctx = vm.createContext({state, invalidateTaskQueryIndex(){}, localStorage:{setItem(){}}, LS_KEY:'test', toast(){}});
  vm.runInContext(block('function previousTaskMemos(', 'function previousTaskMemosProgressHtml(') +
    block('function save()', 'function ymd'),ctx);
  assert.deepEqual(Array.from(ctx.previousTaskMemos('new','2026-11-13'),r=>r.date), ['2026-11-11','2026-11-09']);
  const index=ctx.previousTaskMemos.checkIndex;
  ctx.previousTaskMemos('new','2026-11-13'); assert.equal(ctx.previousTaskMemos.checkIndex,index);
  state.checks.two={taskId:'new',date:'2026-11-12',note:'new note'};
  ctx.save(); assert.equal(ctx.previousTaskMemos('new','2026-11-13').length,3);
  state.checks.one={taskId:'new',date:'2026-11-11',note:''}; ctx.save();
  assert.equal(ctx.previousTaskMemos('new','2026-11-13').length,2);
  state.tasks=[];state.checks={}; assert.equal(ctx.previousTaskMemos('new','2026-11-13').length,0);
});

test('batch persists immediately once and preserves every non-attendance field', () => {
  const old={taskId:'a',date:'2026-11-26',note:'keep',steps:{x:true},lessonMemo:{comment:'keep'},count:2};
  const state={checks:{'a|2026-11-26':old,other:{note:'untouched'}}};
  let saves=0, syncs=0, saved;
  const ctx=vm.createContext({state,ckey:(id,date)=>id+'|'+date,now:()=>123,
    save(){saves++;saved=JSON.parse(JSON.stringify(state));},queueSync(){syncs++;}});
  vm.runInContext(block('function setAttendanceBatch(', '/* ═'),ctx);
  ctx.setAttendanceBatch([{task:{id:'a'},recordDate:'2026-11-26'},{task:{id:'b'},recordDate:'2026-11-25'}]);
  assert.equal(saves,1);assert.equal(syncs,1);assert.equal(saved.checks['a|2026-11-26'].att,'P');
  assert.equal(saved.checks['b|2026-11-25'].date,'2026-11-25');
  assert.deepEqual(saved.checks['a|2026-11-26'].lessonMemo,old.lessonMemo);
  assert.equal(saved.checks['a|2026-11-26'].note,'keep'); assert.equal(old.att,undefined);
  assert.equal(saved.checks.other.note,'untouched');ctx.setAttendanceBatch([]);assert.equal(saves,1);
});

test('quiet polling is bounded to 60 seconds and pending work remains 15 seconds', () => {
  const ctx=vm.createContext({});vm.runInContext(block('const quietRequestPoll =', 'startSyncSession();'),ctx);
  assert.equal(ctx.requestPollDue('a',false,0),true);
  assert.equal(ctx.requestPollDue('a',false,15000),false);
  assert.equal(ctx.requestPollDue('a',false,45000),false);
  assert.equal(ctx.requestPollDue('a',false,60000),true);
  assert.equal(ctx.requestPollDue('a',true,75000),true);
  assert.equal(ctx.requestPollDue('b',false,75000),true);
  assert.equal(ctx.requestPollDue('a',false,100),true);
  assert.equal(ctx.requestPollDue('jitter-active',true,0),true);
  assert.equal(ctx.requestPollDue('jitter-active',true,14997),true);
  assert.equal(ctx.requestPollDue('jitter-quiet',false,0),true);
  assert.equal(ctx.requestPollDue('jitter-quiet',false,59997),true);
});

test('publication save reenables the live button after repeated identical failures', async () => {
  const date = '2026-11-27';
  const task = { id: 'lesson', studentId: 'student' };
  const drafts = new Map(), errors = new Map();
  const ctx = vm.createContext({
    state: { tasks: [task] }, canEditGuardianPublication: () => true, guardianContactEnabledFor: () => true,
    guardianPublicationKey: (id, date) => id + '|' + date, guardianLessonPublications: new Map(),
    guardianPublicationDrafts: drafts, guardianPublicationErrors: errors, guardianPublicationSaving: new Set(),
    sync: { auth: () => ({}), post: async () => { throw new Error('offline'); } },
    SYNC_APP: 'task', route: 'today', renderAfterSync() {},
  });
  vm.runInContext(block('async function saveGuardianPublication(', 'function acaflowLessonSummary('), ctx);
  const editor = { dataset: { task: task.id, date }, querySelector: () => ({ value: 'draft' }) };
  const button = { disabled: false, textContent: '숙제 · 준비물 저장' };
  for (let attempt = 0; attempt < 2; attempt++) {
    await ctx.saveGuardianPublication(editor, button);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, '숙제 · 준비물 저장');
    assert.equal(drafts.get('lesson|' + date).publicReadiness, 'draft');
    assert.match(errors.get('lesson|' + date), /다시 시도/);
  }
});
