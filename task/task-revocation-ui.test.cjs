const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const start = html.indexOf('function checkReferencesRevokedTask');
const end = html.indexOf('// 출근 로그인은 기존 기기 연결과 별개다.', start);
assert.ok(start > 0 && end > start, 'task revocation helpers must remain extractable');
const helpers = html.slice(start, end);

function runtime(overrides = {}) {
  const context = vm.createContext({});
  const initial = {
    state: { settings: { taskRevocationCursor: 0 }, tasks: [], checks: {} },
    eForm: null, lcForm: null, fbCtx: null, lessonDraft: null,
    lessonPreviewTask: null, lessonPreviewPayload: null, studentInfoRequestContext: null,
    weekendFlexibleEditor: null, weekendFlexibleSaving: false,
    lessonBriefingEditor: null, lessonBriefingSaving: false,
    lessonHandoffDraft: null, modalClosed: 0
  };
  Object.assign(initial, overrides);
  context.seed = initial;
  vm.runInContext(`
    let state = seed.state;
    let eForm = seed.eForm, lcForm = seed.lcForm, fbCtx = seed.fbCtx, lessonDraft = seed.lessonDraft;
    let lessonPreviewTask = seed.lessonPreviewTask, lessonPreviewPayload = seed.lessonPreviewPayload;
    let studentInfoRequestContext = seed.studentInfoRequestContext;
    let weekendFlexibleEditor = seed.weekendFlexibleEditor, weekendFlexibleSaving = seed.weekendFlexibleSaving;
    let lessonBriefingEditor = seed.lessonBriefingEditor, lessonBriefingSaving = seed.lessonBriefingSaving;
    let lessonHandoffDraft = seed.lessonHandoffDraft;
    const openPanels = new Set(['gone', 'keep']);
    const makeupCreateStates = new Map([['gone|2026-09-06', { sourceTaskId: 'gone' }], ['keep|2026-09-06', {}]]);
    const makeupAttendanceReconcileStates = new Map(), guardianLessonPublications = new Map();
    const guardianPublicationDrafts = new Map(), studentSelfChecks = new Map();
    const lessonHandoffMemoDrafts = new Map(), lessonHandoffSourceDrafts = new Map();
    function closeModal() { seed.modalClosed += 1; }
    ${helpers}
  `, context);
  return {
    context,
    apply(page, auth = { mode: 'person', id: 'teacher-old' }, accessRole = 'staff') {
      context.page = page; context.auth = auth; context.accessRole = accessRole;
      return vm.runInContext('applyTaskRevocationPage(page, auth, accessRole)', context);
    },
    get(expression) { return vm.runInContext(expression, context); }
  };
}

function page(overrides = {}) {
  return Object.assign({
    version: 1,
    cursor: 7,
    more: false,
    rows: [{ taskId: 'gone', formerOwner: 'teacher-old', revokedAt: 1788739200000 }]
  }, overrides);
}

test('an exact owner revocation removes the task, linked checks, and open editor state', () => {
  const app = runtime({
    state: {
      settings: { taskRevocationCursor: 0 },
      tasks: [
        { id: 'gone', staffId: 'teacher-old', studentName: '민감정보', updatedAt: Number.MAX_SAFE_INTEGER },
        { id: 'keep', staffId: 'teacher-old', studentName: '유지학생', updatedAt: 10 }
      ],
      checks: {
        'gone|2026-09-06': { taskId: 'gone', date: '2026-09-06', note: '민감 메모' },
        '__contact__opaque|2026-09-06': { taskId: '__contact__opaque', contact: { sourceTaskId: 'gone', note: '상담' } },
        'keep|2026-09-06': { taskId: 'keep', date: '2026-09-06', note: '유지' }
      }
    },
    eForm: { id: 'gone' },
    fbCtx: { id: 'gone' }
  });

  const result = app.apply(page());
  assert.equal(result.cursor, 7);
  assert.equal(result.more, false);
  assert.equal(result.removed, 3);
  assert.deepEqual(Array.from(app.get('state.tasks.map(task => task.id)')), ['keep']);
  assert.deepEqual(Array.from(app.get('Object.keys(state.checks)')), ['keep|2026-09-06']);
  assert.equal(app.get('eForm'), null);
  assert.equal(app.get('fbCtx'), null);
  assert.equal(app.get('seed.modalClosed'), 1);
  assert.equal(app.get("openPanels.has('gone')"), false);
  assert.equal(app.get("openPanels.has('keep')"), true);
  assert.equal(app.get("makeupCreateStates.has('gone|2026-09-06')"), false);
  assert.equal(app.get("makeupCreateStates.has('keep|2026-09-06')"), true);
});

test('a revocation never removes the same opaque id owned by a different current teacher', () => {
  const app = runtime({
    state: {
      settings: { taskRevocationCursor: 3 },
      tasks: [{ id: 'gone', staffId: 'teacher-new', updatedAt: 200 }],
      checks: { 'gone|2026-09-06': { taskId: 'gone', date: '2026-09-06' } }
    }
  });
  const result = app.apply(page({ cursor: 8 }), { mode: 'admin' }, '');
  assert.equal(result.cursor, 8, 'a valid page can advance even when no local old-owner row exists');
  assert.equal(result.removed, 0);
  assert.equal(app.get('state.tasks.length'), 1);
  assert.equal(app.get('Object.keys(state.checks).length'), 1);
});

test('an administrator can clear an ownerless revoked task without blocking later pages', () => {
  const app = runtime({
    state: {
      settings: { taskRevocationCursor: 0 },
      tasks: [{ id: 'gone', title: '일반 업무' }],
      checks: { 'gone|2026-09-06': { taskId: 'gone' } }
    }
  });
  const result = app.apply(page({ rows: [{ taskId: 'gone', formerOwner: '', revokedAt: 1 }] }), { mode: 'admin' }, '');
  assert.equal(result.removed, 2);
  assert.equal(app.get('state.tasks.length'), 0);
  assert.equal(app.get('Object.keys(state.checks).length'), 0);
});

test('staff ignores a row for another former owner and repeated pages are idempotent', () => {
  const app = runtime({
    state: {
      settings: { taskRevocationCursor: 0 },
      tasks: [{ id: 'gone', staffId: 'teacher-old' }],
      checks: {}
    }
  });
  let result = app.apply(page({ rows: [{ taskId: 'gone', formerOwner: 'teacher-other', revokedAt: 1 }] }));
  assert.equal(result.removed, 0);
  assert.equal(app.get('state.tasks.length'), 1);

  result = app.apply(page());
  assert.equal(result.removed, 1);
  vm.runInContext('state.settings.taskRevocationCursor = 7', app.context);
  result = app.apply(page());
  assert.equal(result.removed, 0);
  assert.equal(result.cursor, 7);
});

test('malformed or stalled pages fail before mutating local cache', () => {
  const app = runtime({
    state: {
      settings: { taskRevocationCursor: 4 },
      tasks: [{ id: 'gone', staffId: 'teacher-old' }],
      checks: { 'gone|2026-09-06': { taskId: 'gone' } }
    }
  });
  assert.throws(() => app.apply(page({ cursor: 4, more: true })), /TASK_REVOCATION_CURSOR_STALLED/);
  assert.throws(() => app.apply(page({ cursor: 5, rows: [
    { taskId: 'gone', formerOwner: 'teacher-old', revokedAt: 1 },
    { taskId: 'bad id', formerOwner: 'teacher-old', revokedAt: 1 }
  ] })), /TASK_REVOCATION_ROW_INVALID/);
  assert.equal(app.get('state.tasks.length'), 1);
  assert.equal(app.get('Object.keys(state.checks).length'), 1);
});

test('sync advertises the revocation capability, paginates separately, and resets with data generation', () => {
  assert.match(html, /capabilities:\s*\{\s*taskRevocations:\s*1\s*\}/);
  assert.match(html, /taskRevocationCursor:\s*Number\(state\.settings\.taskRevocationCursor\)\s*\|\|\s*0/);
  assert.match(html, /applyTaskRevocationPage\(d\.taskRevocations, auth, responseAccessRole\)/);
  assert.match(html, /again\s*=\s*!!d\.more\s*\|\|\s*revoked\.more\s*\|\|\s*pending\.length\s*>\s*0/);
  const mismatch = html.slice(html.indexOf("e.code === 'DATA_GENERATION_MISMATCH'"),
    html.indexOf("e.code === 'DATA_GENERATION_MISMATCH'") + 900);
  assert.match(mismatch, /state\.settings\.taskRevocationCursor\s*=\s*0/);
});
