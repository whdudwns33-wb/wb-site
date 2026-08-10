const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const consultHtml = fs.readFileSync(path.join(__dirname, '..', 'consult', 'index.html'), 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8'));

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

test('report modal preserves detailed copy and separates the privacy-safe director summary', () => {
  assert.match(html, /data-act="report">오늘 수행 보고 알림톡/);
  assert.match(html, /상세 내부 보고/);
  assert.match(html, /원장님 카카오 알림톡용 요약/);
  assert.match(html, /data-act="copytext">상세 보고 복사하기/);
  assert.match(html, /const canSend = date === today\(\) && \(session\.isStaffLink \|\| session\.isAdmin\)/);
  assert.match(html, /과거 날짜는 상세 내부 보고 복사만 할 수 있습니다/);
  assert.match(html, /data-act="directorreportsend"/);
});

test('director summary contains only adult teacher name, aggregate counts, and the task link', () => {
  const source = functionSource('reportCounts') + '\n' + functionSource('directorReportSummaryText');
  const run = new Function('tasksFor', 'statusOf', 'staffById', 'DIRECTOR_REPORT_TASK_URL',
    source + '; return { counts: reportCounts("teacher-a", "2026-08-04"), text: directorReportSummaryText("teacher-a", "2026-08-04") };');
  const tasks = [
    { state: 'done', title: '[수업] 민감학생A', note: '민감 메모 A' },
    { state: 'doing', title: '[수업] 민감학생B', note: '민감 메모 B' },
    { state: 'todo', title: '[수업] 민감학생C', note: '민감 메모 C' },
    { state: 'blocked', title: '[수업] 민감학생D', note: '민감 메모 D' }
  ];
  const result = run(() => tasks, task => task.state, () => ({ name: '염다솜' }),
    'https://whdudwns33-wb.github.io/wb-site/task/');
  assert.deepEqual(result.counts, { done: 1, total: 4, doing: 1, pending: 1, blocked: 1 });
  assert.match(result.text, /염다솜 선생님/);
  assert.match(result.text, /완료 1\/4건 · 진행 1건 · 미완료 1건 · 막힘 1건/);
  assert.match(result.text, /업무지시서: https:\/\/whdudwns33-wb\.github\.io\/wb-site\/task\//);
  for (const forbidden of ['민감학생', '민감 메모', '[수업]']) assert.ok(!result.text.includes(forbidden));
  assert.doesNotMatch(functionSource('directorReportSummaryText'), /\.title|\.note|studentOf|reportText/);
});

test('request payload lets the server derive private identity and contains no content or recipient fields', () => {
  const source = functionSource('directorReportRequestPayload');
  const make = isAdmin => new Function('SYNC_APP', 'sync', 'session',
    source + '; return directorReportRequestPayload({ staffId: "teacher-a", date: "2026-08-04" });')(
      'task', { auth: () => ({ mode: isAdmin ? 'admin' : 'person', token: 'opaque' }) }, { isAdmin });
  const personal = make(false);
  const admin = make(true);
  assert.deepEqual(personal, { app: 'task', auth: { mode: 'person', token: 'opaque' }, reportDate: '2026-08-04' });
  assert.deepEqual(admin, { app: 'task', auth: { mode: 'admin', token: 'opaque' }, reportDate: '2026-08-04', staffId: 'teacher-a' });
  const forbidden = ['phone', 'to', 'from', 'message', 'recipient', 'guardian', 'summary'];
  for (const key of forbidden) {
    assert.equal(Object.hasOwn(personal, key), false, key);
    assert.equal(Object.hasOwn(admin, key), false, key);
  }
});

test('send action requires confirmation, blocks duplicate clicks, and reports only request acceptance', () => {
  const send = functionSource('submitDirectorReport');
  assert.match(send, /if \(directorReportSending\) return/);
  assert.match(send, /confirm\('원장님께 오늘 수행 보고 알림톡 1건을 접수할까요/);
  assert.match(send, /button\.disabled = true/);
  assert.match(send, /await settleSync\(\)/);
  assert.match(send, /sync\.post\('\/director-report-send', directorReportRequestPayload\(context\)\)/);
  assert.match(send, /result && result\.send && result\.send\.status/);
  assert.match(send, /sendStatus === 'accepted'/);
  assert.match(send, /result && result\.idempotent/);
  assert.match(send, /같은 수행 보고가 이미 접수됨\(기존 발송 포함\)/);
  assert.match(send, /원장님 알림톡 발송 요청이 접수됨/);
  assert.match(send, /결과 확인 필요 — 다시 누르지 말고 원장 발송 내역을 확인해 주세요/);
  assert.match(send, /button\.textContent = '결과 확인 필요'/);
  assert.doesNotMatch(send, /전달 완료|발송 완료|recipient|phone|message\s*:/i);
  assert.match(send, /directorReportErrorText\(error\)/);
});

test('bounded sync settlement blocks send when latest checks are not confirmed', () => {
  const settle = functionSource('settleSync');
  assert.match(settle, /attempt < 60/);
  assert.match(settle, /setTimeout\(resolve, 50\)/);
  assert.match(settle, /if \(sync\.busy\) throw new Error\('SYNC_BUSY'\)/);
  assert.match(settle, /await sync\.run\(\)/);
  assert.match(settle, /if \(sync\.dirty \|\| sync\.err\) throw new Error\('SYNC_FAILED'\)/);
});

test('report send UI contains no embedded phone number or secret and versions remain aligned', () => {
  const summary = functionSource('directorReportSummaryText');
  const payload = functionSource('directorReportRequestPayload');
  const send = functionSource('submitDirectorReport');
  const addedSurface = summary + payload + send;
  assert.doesNotMatch(addedSurface, /01[016789][ -]?\d{3,4}[ -]?\d{4}|SOLAPI_(?:API_)?(?:KEY|SECRET)|TASK_ADMIN_SECRET/);
  /* version.json 은 task 와 consult 가 함께 쓴다. 한쪽만 올리면
     다른 쪽 사용자에게 '새 버전' 배너가 영구히 뜬다. */
  assert.match(version.v, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.ok(html.includes("const APP_VER = '" + version.v + "'"), 'task APP_VER');
  assert.ok(consultHtml.includes("const APP_VER = '" + version.v + "'"), 'consult APP_VER');
  assert.ok(html.includes('lesson-form-core.js?v=' + version.v), 'lesson-form-core 캐시버스터');
  assert.ok(html.includes('schedule-board-core.js?v=' + version.v), 'schedule-board-core 캐시버스터');
});
