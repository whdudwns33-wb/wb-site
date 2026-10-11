'use strict';
/* 내신브레인 관리 웹 — 교과서별 자료 준비 카드 정적 검사 (node naesin/admin-coverage.test.cjs)
 *
 * 카드 본체는 naesin/coverage.js(순수 로직, coverage.test.cjs)가 판정하고, 화면에 남는 로직은
 * 입력칸 ↔ 지정표 변환 둘뿐이다. 그 둘이 여기 있는 이유: **지정표 전체를 덮어쓰는 입력**이라
 * 파서가 한 줄을 잘못 읽으면 그 학생의 교과서가 조용히 풀린다. 되돌릴 방법은 원장의 기억뿐이다.
 * 그리고 "화면이 부르는 파일·API 가 배포본에 없다"는 배포 뒤 처음 터지는 종류라 정적으로 막는다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const read = (p) => fs.readFileSync(p, 'utf8');
const ROOT = path.join(__dirname, '..');
const admin = read(path.join(ROOT, 'reading-server', 'public', 'naesin-admin.html'));
const api = read(path.join(ROOT, 'reading-server', 'naesin-api.mjs'));
const build = read(path.join(ROOT, 'reading-server', 'build-dist.mjs'));
const server = read(path.join(ROOT, 'reading-server', 'server.mjs'));
const worker = read(path.join(ROOT, 'reading-server', 'worker.mjs'));

/* 인라인 스크립트에서 파서 둘만 떼어 온다 — 화면 전역(DOM·TOKEN)에 기대지 않는 조각이라 그대로 돈다.
   복사해서 테스트에 다시 쓰면 화면이 바뀌어도 테스트는 통과하므로, 반드시 원본에서 읽는다. */
function lift() {
  const js = admin.slice(admin.indexOf('function booksToText('), admin.indexOf('function renderBooks('));
  assert.ok(js.length > 500 && js.includes('function parseBooksText('), '파서를 화면에서 못 떼어 냈다 — 함수 이름이 바뀌었나?');
  const f = new Function(js + '\nreturn {booksToText,parseBooksText};');
  return f();
}

t('화면이 부르는 커버리지 모듈이 로컬·배포 양쪽에서 서빙된다', () => {
  assert.ok(/<script src="\/admin\/coverage\.js"><\/script>/.test(admin), '화면이 /admin/coverage.js 를 안 부른다');
  assert.ok(fs.existsSync(path.join(__dirname, 'coverage.js')), 'naesin/coverage.js 가 없다');
  /* 배포본: dist/admin/ 으로 복사해야 운영에서 404 가 안 난다(dist-cache.test.mjs 가 결과물도 확인한다) */
  assert.ok(/coverage\.js'\), path\.join\(DIST, 'admin', 'coverage\.js'\)/.test(build), 'build-dist.mjs 가 coverage.js 를 dist/admin/ 으로 복사하지 않는다');
  /* 로컬 서버: public/ 에 없는 파일이라 전용 라우트가 필요하다(qr.js·letter.js 와 같은 자리) */
  assert.ok(/'\/admin\/coverage\.js'\).*NAESIN_DIR, 'coverage\.js'/.test(server), 'server.mjs 가 /admin/coverage.js 를 서빙하지 않는다');
});

t('화면이 부르는 지정표 API 가 서버·워커 저장소에 다 있다', () => {
  assert.ok(admin.includes("api('/naesin/admin/books')"), '화면이 지정표를 불러오지 않는다');
  assert.ok(/'\/naesin\/admin\/books',\{method:'PUT'/.test(admin), '화면이 지정표를 저장하지 않는다');
  for (const m of ["'/api/naesin/admin/books' && method === 'GET'", "'/api/naesin/admin/books' && method === 'PUT'"])
    assert.ok(api.includes(m), 'naesin-api.mjs 에 ' + m + ' 라우트가 없다');
  /* 두 저장소 모두 같은 칸을 알아야 한다 — 한쪽만 고치면 로컬에서만 되는 기능이 된다 */
  for (const [name, src] of [['server.mjs', server], ['worker.mjs', worker]])
    assert.ok(/getBooks/.test(src) && /putBooks/.test(src), name + ' 의 naesinStore 에 getBooks/putBooks 가 없다');
  /* 지정표는 학생에게 나가지 않는다 — 명부가 섞인 값이라 관리 라우트 안쪽에만 있어야 한다 */
  const studentPart = api.slice(0, api.indexOf("/api/naesin/admin/"));
  assert.ok(!/getBooks|naesin:books/.test(studentPart), '학생 라우트 쪽에서 교과서 지정표를 읽는다');
});

t('한 줄에 코드와 교과서 — 메모(#)는 버리고, 빈 칸은 지정 해제다', () => {
  const { parseBooksText } = lift();
  const r = parseBooksText('A123  ne-kimgitaek   # 김OO · 중2 · A반\nB456                # 이OO · 중3\n\n  C789 , kumsung-choeincheol  ');
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.map, { A123: 'ne-kimgitaek', B456: '', C789: 'kumsung-choeincheol' });
});

t('틀린 줄이 하나라도 있으면 지정표를 저장하지 않는다 — 부분 저장이 더 위험하다', () => {
  const { parseBooksText } = lift();
  const bad = [
    'A1 ne-kimgitaek',                    /* 학생 코드가 너무 짧다 */
    'A123 NE-KimGiTaek',                  /* 교과서 코드는 소문자·숫자·하이픈 */
    'A123 ne-kimgitaek m2',               /* 한 줄에 둘만 */
    'A123 ne-kimgitaek\nA123 kumsung',    /* 같은 학생, 다른 교과서 */
  ];
  bad.forEach((text) => {
    const r = parseBooksText(text);
    assert.ok(r.errors.length > 0, '못 걸렀다: ' + JSON.stringify(text));
    assert.ok(/^\d+행: /.test(r.errors[0]), '몇 행인지 말해 주지 않는다: ' + r.errors[0]);
  });
  /* 같은 학생이 두 번 나와도 값이 같으면 오타가 아니라 중복이다 — 막을 이유가 없다 */
  assert.deepStrictEqual(parseBooksText('A123 ne-kimgitaek\nA123 ne-kimgitaek').errors, []);
});

t('명부 전체가 입력칸에 깔리고, 다시 읽으면 같은 지정표가 나온다', () => {
  const { booksToText, parseBooksText } = lift();
  const roster = [
    { code: 'A123', name: '김OO', grade: '중2', cls: 'A' },
    { code: 'B456', name: '이OO', grade: '중3', cls: '' },
    { code: 'C789', name: '', grade: '', cls: '' },
  ];
  const text = booksToText(roster, { A123: 'ne-kimgitaek' });
  assert.strictEqual(text.split('\n').length, 3, '명부에 있는 학생이 한 줄씩 깔려야 빈 칸이 곧 할 일 목록이 된다');
  assert.ok(text.includes('# 김OO · 중2 · A'), '사람이 알아볼 메모가 없다');
  assert.ok(!/#\s*$/m.test(text), '메모가 없는 학생 줄에 빈 # 가 남는다');
  /* 왕복해도 같아야 한다 — 저장이 지정표 전체를 덮으므로 여기서 어긋나면 지정이 조용히 풀린다 */
  assert.deepStrictEqual(parseBooksText(text).map, { A123: 'ne-kimgitaek', B456: '', C789: '' });
  /* 학교명은 메모에도 안 들어간다(절대 규칙 1) — 명부가 주는 칸만 쓴다 */
  assert.ok(!/school|학교/.test(booksToText([{ code: 'D012', name: '박OO', grade: '중1', cls: 'B', school: '○○중' }], {})), '학교명이 입력칸에 새어 나온다');
});

t('지정표 전체를 덮는 저장이라 두 자리에서 되묻고, 명부가 없으면 아예 막는다', () => {
  const card = admin.slice(admin.indexOf('function renderBooks('), admin.indexOf('console.log') > 0 ? admin.indexOf('/* ── 팩 커버리지 ──') : admin.length);
  const save = admin.slice(admin.indexOf('async function saveBooks('), admin.indexOf('/* ── 팩 커버리지 ──'));
  /* 명부를 못 받으면 입력칸이 비는데, 그대로 저장하면 지정표가 통째로 날아간다 */
  assert.ok(/ROSTER\.length\?''\:' disabled'/.test(card), '명부가 없을 때 저장 버튼이 열려 있다');
  assert.ok(/if\(!ROSTER\.length\)\$\('#bkMsg'\)/.test(card), '명부를 못 받은 이유를 화면이 말하지 않는다');
  /* 줄을 지우거나 일부만 붙여넣으면 그만큼 지정이 풀린다 — 숫자로 보여 주고 되물어야 한다 */
  assert.ok(/const drop=Object\.keys\(BOOKS\|\|\{\}\)\.filter\(c=>!map\[c\]\)/.test(save), '지정이 풀리는 학생을 세지 않는다');
  assert.ok(/drop\.length&&!confirm\(/.test(save), '지정이 풀리는데 되묻지 않는다');
  assert.ok(/strangers\.length&&!confirm\(/.test(save), '명부에 없는 코드를 되묻지 않는다');
});

t('고등 조합은 먼저 만들 목록에 섞지 않는다 — 채울 수 있는 폴더 이름이 없다', () => {
  const card = admin.slice(admin.indexOf('function renderBooks('), admin.indexOf('async function saveBooks('));
  /* desk 의 REVISIONS 에 고등이 없어 h 학년 packId 는 만들어질 수 없다 — 섞으면 못 채우는 줄이 1위로 올라간다 */
  assert.ok(/c\.empty&&c\.folderPrefix/.test(card), '고등 조합이 먼저 만들 목록에 섞인다');
  assert.ok(/const highs=rep\.combos\.filter\(c=>!c\.folderPrefix\)/.test(card), '고등 조합을 따로 세지 않는다');
  assert.ok(/고등 조합/.test(card), '고등 조합을 왜 안 셌는지 화면이 말하지 않는다');
});

t('카드가 과(Lesson)를 단정하지 않는다 — 그 판정은 팩 커버리지 몫이다', () => {
  const card = admin.slice(admin.indexOf('function renderBooks('), admin.indexOf('/* ── 팩 커버리지 ──'));
  assert.ok(card.length > 1000);
  /* 조합·보류·어긋남은 전부 coverage.js 가 센다 — 화면이 다시 계산하면 테스트와 갈라진다 */
  assert.ok(/COV\.report\(/.test(card), '화면이 coverage.js 를 쓰지 않고 직접 센다');
  assert.ok(!/needOf|examFor\(/.test(card), '화면이 시험 범위를 직접 판정한다 — 팩 커버리지 카드의 일이다');
});

console.log('통과 ' + passed);
