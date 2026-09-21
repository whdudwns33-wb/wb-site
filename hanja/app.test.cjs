'use strict';
/* 한자브레인 화면 정적 검사 (node hanja/app.test.cjs)
 *
 * 화면 흐름은 사람이 눌러 봐야 알지만, "화면이 부르는 파일이 없다", "화면이 부르는 API 가 서버에 없다",
 * "서비스 워커 셸에 없는 파일이 적혔다"는 정적으로 잡힌다 — 이 셋은 배포 뒤 학생 화면에서 처음 터지는 종류라 여기서 막는다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const DIR = __dirname;
const read = (p) => fs.readFileSync(p, 'utf8');
const app = read(path.join(DIR, 'index.html'));
const sw = read(path.join(DIR, 'sw.js'));
const admin = read(path.join(DIR, '..', 'reading-server', 'public', 'hanja-admin.html'));
const print = read(path.join(DIR, '..', 'reading-server', 'public', 'hanja-print.html'));
const api = read(path.join(DIR, '..', 'reading-server', 'hanja-api.mjs'));

t('학생 앱이 부르는 스크립트가 다 있고, 인라인 코드가 파싱된다', () => {
  const refs = [...app.matchAll(/<script src="\.\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5);
  refs.forEach((f) => assert.ok(f === 'voice.js' || fs.existsSync(path.join(DIR, f)), f + ' 가 hanja/ 에 없다'));
  const js = app.slice(app.indexOf('/* APP:JS:START */'), app.indexOf('/* APP:JS:END */'));
  assert.ok(js.length > 10000);
  new Function(js);   /* 문법 오류면 여기서 던진다 */
  ['view-home', 'view-books', 'view-words', 'view-chars', 'view-train', 'view-report', 'sheetBack', 'toast', 'streakChip'].forEach((id) => assert.ok(app.includes('id="' + id + '"'), id + ' 가 없다'));
});

t('서비스 워커 셸 목록의 파일이 실제로 있고, 앱이 부르는 스크립트는 셸에 든다', () => {
  const shell = (sw.match(/const SHELL = \[([^\]]+)\]/) || [])[1];
  assert.ok(shell, 'SHELL 목록을 못 찾았다');
  const files = [...shell.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]);
  files.forEach((f) => assert.ok(f === 'voice.js' || fs.existsSync(path.join(DIR, f)), 'sw.js SHELL 의 ' + f + ' 가 없다'));
  [...app.matchAll(/<script src="\.\/([^"]+)"/g)].map((m) => m[1]).forEach((f) => assert.ok(files.includes(f), f + ' 가 SHELL 에 없다 — 오프라인에서 화면이 죽는다'));
  assert.ok(/addEventListener\('push'/.test(sw), '밤 알림 push 핸들러가 없다');
  assert.ok(!/\/api\//.test(sw.replace(/\/\*[\s\S]*?\*\//g, '').split("startsWith('/api/')")[0].slice(-2000)) || /startsWith\('\/api\/'\)/.test(sw), 'API 를 캐시하면 안 된다');
});

t('화면이 부르는 /api/hanja/* 경로가 서버 라우터에 다 있다', () => {
  const routes = new Set([...api.matchAll(/p === '(\/api\/hanja\/[^']+)'/g)].map((m) => m[1]));
  assert.ok(routes.size >= 15, '라우트가 ' + routes.size + '개뿐 — 검사가 헛돌고 있다');
  const calls = [];
  for (const m of app.matchAll(/api\('(\/[^'?]+)/g)) calls.push(m[1].startsWith('/api/') ? m[1] : '/api/hanja' + m[1]);
  for (const src of [admin, print]) for (const m of src.matchAll(/api\('(\/api\/hanja\/[^'?]+)/g)) calls.push(m[1]);
  const missing = [...new Set(calls)].filter((c) => c.startsWith('/api/hanja/') && !routes.has(c));
  assert.deepStrictEqual(missing, [], '서버에 없는 경로를 부른다');
  /* 워드브레인 연상 API 는 그쪽 라우터에 있어야 한다 */
  const vocab = read(path.join(DIR, '..', 'reading-server', 'vocab-api.mjs'));
  ['/api/vocab/mnemonic', '/api/vocab/mnemonic/check'].forEach((p) => assert.ok(vocab.includes("'" + p + "'"), p + ' 가 워드브레인 라우터에 없다'));
});

t('학생 화면은 학생 기기·단어장 값을 이스케이프해서 그린다', () => {
  /* 낱말·뜻·제목을 innerHTML 에 넣는 자리마다 esc( 가 있다 — 새 자리를 만들 때 빼먹기 쉬운 것 */
  ['esc(w.word)', 'esc(w.meaning)', 'esc(e.title)', 'esc(c.ch)', 'esc(tk.title)', 'esc(q.prompt)'].forEach((s) => assert.ok(app.includes(s), s + ' 가 없다'));
  assert.ok(!/innerHTML = w\.word|innerHTML = q\.prompt/.test(app));
});

t('관리 화면·인쇄 화면은 색인·추적을 막고, 인쇄 화면은 PIN 뒤에서만 단어장을 받는다', () => {
  for (const [name, src] of [['hanja-admin.html', admin], ['hanja-print.html', print]]) {
    assert.ok(/noindex/.test(src), name + ' 에 noindex 가 없다');
    assert.ok(/no-referrer/.test(src), name + ' 에 referrer 정책이 없다');
    /* 로그인 호출은 공용 모듈(reading-server/public/admin-login.js)로 옮겼다 — 화면은 그것을 싣고 장착하는지 본다.
       보장은 같다: 이 화면은 관리 로그인 뒤에서만 열린다. */
    assert.ok(/admin-login\.js/.test(src), name + ' 가 공용 로그인 모듈을 싣지 않는다');
    assert.ok(/WBAdminLogin\.mount/.test(src), name + ' 에 관리 로그인이 없다');
  }
  assert.ok(!/fetch\('\.\/book-sample|\/hanja\/book/.test(print), '인쇄 화면이 정적 단어장을 부른다');
});

t('AI 연상 버튼은 자체 단어장(aiAllowed)에서만 — 교재 뜻 문장이 외부 AI 로 나가지 않게', () => {
  const btnLine = app.split('\n').find((l) => l.includes('data-ai="'));
  assert.ok(btnLine && btnLine.includes('aiAllowed('), 'AI 연상 버튼이 단어장 종류를 보지 않는다');
  const fn = app.slice(app.indexOf('async function aiMnemo'), app.indexOf("'/api/vocab/mnemonic'"));
  assert.ok(fn.includes('aiAllowed('), 'aiMnemo 가 호출 직전에 종류를 다시 보지 않는다');
  assert.ok(admin.includes('id="bkSource"') && admin.includes('data-source='), '관리 웹에 종류 선택이 없다');
  assert.ok(api.includes("'/api/hanja/admin/source'"), '종류 바꾸기 라우트가 없다');
});

t('낱말과 한자가 나란히 — 탭이 둘 다 있고, 지금 단어장에 없는 쪽은 감춘다', () => {
  /* 이 앱은 한글 어휘(고유어)와 한자어를 둘 다 익히는 앱이다. 낱말이 단어장 탭 안쪽에만 있으면 한자 앱처럼 읽힌다. */
  const tabs = [...app.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.includes('words'), '낱말 탭이 없다');
  assert.ok(tabs.indexOf('words') < tabs.indexOf('chars'), '낱말 탭이 한자 탭보다 앞이어야 한다');
  assert.ok(/<b>語<\/b>낱말/.test(app) && /<b>字<\/b>한자/.test(app), '탭 이름이 낱말·한자로 갈려 있어야 한다');
  assert.ok(/function renderWords/.test(app) && /words: renderWords/.test(app), '낱말 뷰가 등록되지 않았다');
  /* 빈 탭을 띄우지 않는다 — 고유어만 있는 국어 교재에서 빈 한자 탭, 글자만 있는 급수 교재에서 빈 낱말 탭 */
  assert.ok(/function syncTabs/.test(app), '탭을 단어장에 맞춰 감추는 코드가 없다');
  const sync = app.slice(app.indexOf('function syncTabs'), app.indexOf('function render('));
  assert.ok(/words/.test(sync) && /chars/.test(sync) && /hidden/.test(sync));
  /* 낱말 탭에서 시작한 배우기·훈련은 낱말만 다룬다 */
  assert.ok(/learnStart\(book, b2\.dataset\.wlearn, 'word'\)/.test(app), '낱말 탭의 배우기가 낱말만 심지 않는다');
  assert.ok(/only: 'word'/.test(app), '낱말 탭의 훈련이 낱말만 내지 않는다');
  assert.ok(/if \(only\) items = items\.filter/.test(app) && /if \(scope\.only\)/.test(app), 'only 를 받는 쪽이 걸러 주지 않는다');
  /* 머리말이 한글 어휘를 먼저 말한다 */
  assert.ok(/한글 어휘 · 한자어/.test(app), '머리말이 한자만 내세우고 있다');
});

console.log(`\nOK — ${passed}개 통과`);
