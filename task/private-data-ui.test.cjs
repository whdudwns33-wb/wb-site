const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const textbooks = JSON.parse(fs.readFileSync(path.join(__dirname, 'textbooks.json'), 'utf8'));

test('static textbook catalog starts empty for the rebuilt database', () => {
  assert.deepEqual(textbooks.books, []);
});

test('student private data is never shipped as a Pages static file', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'roster.json')), false);
  assert.equal(Object.prototype.hasOwnProperty.call(textbooks, 'students'), false);
  assert.doesNotMatch(html, /fetch\(['"]roster\.json/);
  assert.match(html, /sync\.post\('\/roster', \{ app: SYNC_APP, auth: auth, action: 'get' \}\)/);
  assert.match(html, /d\.students = privateBookStudents\.slice\(\)/);
  assert.match(html, /if \(rosterErr\) return '<div class="card alert">[\s\S]{0,500}data-act="rosterretry"/);
  assert.match(html, /학생 배정과 진도를 0명으로 잘못 표시하지 않도록/);
  assert.match(html, /if \(bookDbErr\) return '<div class="card alert">[\s\S]{0,500}data-act="bookretry"/);
  assert.match(html, /rosterErr = '';[\s\S]{0,100}renderAfterSync\(\)/);
});

test('Acaflow contact import is admin-only and keeps source data in memory', () => {
  const nameStart = html.indexOf('function acaflowSpreadsheetName(file)');
  const nameEnd = html.indexOf('\nconst ACAFLOW_IMPORT_STATUS', nameStart);
  const nameSource = html.slice(nameStart, nameEnd);
  const viewStart = html.indexOf('function viewAcaflowImport()');
  const viewEnd = html.indexOf('\nfunction viewRoster()', viewStart);
  const view = html.slice(viewStart, viewEnd);
  const changeStart = html.indexOf("const acaflowFile = ev.target.closest('[data-acaflow-file]')");
  const changeEnd = html.indexOf("const field = ev.target.closest('[data-lesson-field]')", changeStart);
  const change = html.slice(changeStart, changeEnd);
  const clickStart = html.indexOf("case 'acaflowcontactimport':");
  const clickEnd = html.indexOf("case 'managetasks':", clickStart);
  const click = html.slice(clickStart, clickEnd);

  assert.ok(viewStart >= 0 && viewEnd > viewStart);
  assert.match(view, /if \(!session\.isAdmin \|\| session\.isStaffLink\) return ''/);
  assert.match(view, /type="file"/);
  for (const extension of ['.xls', '.csv']) assert.match(view, new RegExp('\\' + extension));
  assert.doesNotMatch(view, /\bmultiple\b|FormData|fetch\(/);
  assert.match(view, /파일은 이 화면의 메모리에서만 읽고 업로드·기기 저장하지 않으며/);
  assert.match(view, /동의 자동 설정 없음/);
  assert.match(change, /if \(!session\.isAdmin \|\| session\.isStaffLink\) return/);
  assert.match(change, /await prepareAcaflowContacts\(file\)/);
  assert.match(click, /importAcaflowContacts\(el\)/);
  assert.match(html, /<div id="toast" role="status" aria-live="polite" aria-atomic="true"><\/div>/);
  assert.doesNotMatch(html, /localStorage\.setItem\([^\n]*acaflow/i);

  const spreadsheetName = new Function(nameSource + '; return acaflowSpreadsheetName;')();
  for (const name of ['students.XLS', 'students.csv']) assert.equal(spreadsheetName({ name }), name);
  for (const name of ['students.xlsx', 'students.json', 'students.csv.exe', '']) assert.equal(spreadsheetName({ name }), '');
});

test('Acaflow import uses stable roster identity and never enables consent automatically', () => {
  const start = html.indexOf('async function importAcaflowContacts(button)');
  const end = html.indexOf('\nfunction viewAcaflowImport()', start);
  const source = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(source, /studentId: row\.studentId/);
  assert.match(source, /studentName: row\.studentName/);
  assert.match(source, /phone: row\.phone,[\s\S]{0,100}consent: row\.status === 'link_needed' \? row\.currentConsent : false/);
  assert.match(source, /\['new', 'changed', 'link_needed'\]\.includes/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\./);
});

/* 이관 학생 이름의 재등장을 막는 검사.

   해시 목록은 저장소에 두지 않는다(task/private-names.json, .gitignore).
   목록이 salt 없는 SHA-256 인데, 한글 이름은 경우의 수가 적어 사실상 복원된다 —
   공개 저장소에 두면 "이름을 지웠다는 증거"가 지운 학생 35명의 완전한 명단이 된다.

   이 검사는 모든 파일의 2~4자 한글 조각을 전부 해시해 대조하는 구조라
   느린 KDF 로는 바꿀 수 없고(수백만 번 돈다), 패턴 검사로는 평범한 한글 단어와
   구분이 안 된다. 그래서 목록을 저장소 밖으로 빼는 쪽을 골랐다.

   목록 파일이 없으면 이 검사만 건너뛴다 — 새로 클론한 사람이 막히지 않게.
   원내 기기에서는 파일을 두고 돌리면 예전과 똑같이 동작한다.
   형식은 task/private-names.sample.json 참고. */
test('migrated student names never reappear in public source or documentation', () => {
  const listPath = path.join(__dirname, 'private-names.json');
  if (!fs.existsSync(listPath)) {
    console.log('  ↷ 건너뜀: task/private-names.json 이 없습니다 (형식은 private-names.sample.json 참고)');
    return;
  }
  const forbidden = new Set(JSON.parse(fs.readFileSync(listPath, 'utf8')).hashes || []);
  assert.ok(forbidden.size > 0, 'private-names.json 에 hashes 배열이 있어야 합니다');
  const root = path.join(__dirname, '..');
  const leaks = [];
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(file);
    if (!entry.isFile() || fs.statSync(file).size > 2_000_000) return;
    if (file === listPath) return;            // 목록 자신은 대조 대상이 아니다
    const text = fs.readFileSync(file, 'utf8');
    for (const token of text.match(/[가-힣]{2,}/g) || []) {
      for (let size = 2; size <= 4; size++) for (let at = 0; at + size <= token.length; at++) {
        const hash = crypto.createHash('sha256').update(token.slice(at, at + size)).digest('hex');
        if (forbidden.has(hash)) leaks.push(path.relative(root, file));
      }
    }
  });
  ['consult', 'docs', 'sync', 'task'].forEach(name => walk(path.join(root, name)));
  assert.deepEqual([...new Set(leaks)], []);
});
