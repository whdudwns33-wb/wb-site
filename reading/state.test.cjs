'use strict';
/* 저장된 기록을 되살릴 때 앱이 터지지 않는가 (node reading/state.test.cjs)

   2026-09-02, 체험 학생이 "진로독서에서 워드브레인 갔다 돌아오니 활동한 게 사라졌다"고
   했다. 실제로 지워진 것은 없었다. normalizeState 가 prefs·train 같은 나중에 생긴
   필드만 채우고 정작 기본 그릇(readings·days·daily…)은 안 채워서, 그 중 하나가 없는
   상태가 들어오면 렌더 도중 S.daily[today] 에서 터졌다. 데이터는 localStorage 에
   멀쩡히 있는데 화면만 텅 빈 초기 화면 — 학생 눈에는 사라진 것과 구별이 안 된다.

   들어오는 길은 하나가 아니다. 서버에서 받아 온 상태(syncPull 의 normalizeState(j.state)),
   예전 판이 저장해 둔 상태, 백업에서 되돌린 상태가 전부 이 함수를 지나간다.
   그래서 "필드 하나가 없어도 뜬다"를 여기서 지킨다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

/* 앱에서 normalizeState 를 그대로 꺼내 온다 — 규칙을 베껴 적으면 앱과 따로 놀게 된다 */
function extract(name) {
  const head = 'function ' + name + '(';
  const i = HTML.indexOf(head);
  assert.notStrictEqual(i, -1, name + ' 를 앱에서 찾지 못했습니다');
  let depth = 0, started = false;
  for (let j = HTML.indexOf('{', i); j < HTML.length; j++) {
    const c = HTML[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return HTML.slice(i, j + 1); }
  }
  throw new Error(name + ' 의 끝을 찾지 못했습니다');
}
const dkey = (d) => { d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const normalizeState = new Function('dkey', extract('normalizeState') + '; return normalizeState;')(dkey);

/* 앱이 실제로 읽는 그릇 — 새 필드를 추가하면 여기에도 넣어야 한다 */
const OBJ = ['readings', 'scraps', 'quiz', 'days', 'daily', 'mychunks'];
const ARR = ['vocab', 'reports', 'train', 'redbook', 'speed', 'wrong'];

const full = () => ({
  v: 1, ts: Date.now(),
  profile: { grade: '초5', level: 'L2', interests: ['nat'], createdAt: Date.now() },
  readings: { 'a': { date: '2026-09-02', sec: 300 } }, scraps: {}, quiz: {}, days: {}, daily: {}, mychunks: {},
  vocab: [], reports: [], train: [], redbook: [], speed: [], wrong: [],
  prefs: {}, lab: null, diag: null, lvhint: null,
});

t('온전한 상태는 그대로 통과한다', () => {
  const s = normalizeState(full());
  assert.strictEqual(Object.keys(s.readings).length, 1, '읽기 기록이 사라졌다');
  assert.strictEqual(s.profile.level, 'L2', '프로필이 사라졌다');
});

t('그릇이 하나씩 빠져도 채워 넣는다', () => {
  OBJ.concat(ARR).forEach((k) => {
    const s = full(); delete s[k];
    const out = normalizeState(s);
    assert.ok(out[k] != null, `${k} 가 없는 상태를 되살리면 ${k} 가 비어 있다 — 렌더 도중 터진다`);
    if (OBJ.includes(k)) assert.strictEqual(typeof out[k], 'object', `${k} 는 객체여야 한다`);
    if (ARR.includes(k)) assert.ok(Array.isArray(out[k]), `${k} 는 배열이어야 한다`);
    /* 다른 기록까지 날려 먹으면 안 된다 */
    if (k !== 'readings') assert.strictEqual(Object.keys(out.readings).length, 1, `${k} 를 채우다 읽기 기록을 잃었다`);
  });
});

t('그릇이 통째로 다 빠져도 뜬다 — 아주 예전 판이 저장한 상태', () => {
  const out = normalizeState({ v: 1, profile: { grade: '초5', level: 'L2', interests: [], createdAt: 1 } });
  OBJ.forEach((k) => assert.strictEqual(typeof out[k], 'object', k + ' 가 객체가 아니다'));
  ARR.forEach((k) => assert.ok(Array.isArray(out[k]), k + ' 가 배열이 아니다'));
  assert.ok('lab' in out && 'diag' in out && 'lvhint' in out, 'null 이어야 하는 필드가 없다');
});

t('타입이 어긋난 값도 바로잡는다 — 서버·백업이 망가뜨린 경우', () => {
  const s = full();
  s.readings = null; s.days = []; s.vocab = {}; s.wrong = 'x';
  const out = normalizeState(s);
  assert.strictEqual(typeof out.readings, 'object'); assert.ok(!Array.isArray(out.readings));
  assert.ok(!Array.isArray(out.days) && typeof out.days === 'object', 'days 가 배열이면 S.days[k]=true 가 이상해진다');
  assert.ok(Array.isArray(out.vocab), 'vocab 이 객체면 push 에서 터진다');
  assert.ok(Array.isArray(out.wrong));
});

t('빈 객체도 터지지 않는다 — 최악의 경우', () => {
  const out = normalizeState({});
  assert.strictEqual(out.profile, null, '프로필이 없으면 null 이어야 온보딩으로 간다');
  OBJ.forEach((k) => assert.strictEqual(typeof out[k], 'object', k));
  ARR.forEach((k) => assert.ok(Array.isArray(out[k]), k));
});

t('새 상태를 만드는 자리와 채우는 자리가 어긋나지 않는다', () => {
  /* loadState 의 리터럴에만 있고 normalizeState 에 없는 그릇이 새로 생기면
     또 같은 사고가 난다. 리터럴에 있는 키가 전부 여기 목록에 있는지 본다. */
  const i = HTML.indexOf('return normalizeState({v:1,');
  assert.notStrictEqual(i, -1, 'loadState 의 새 상태 리터럴을 찾지 못했습니다');
  const body = HTML.slice(HTML.indexOf('{', i));
  /* 중첩된 객체 안의 키는 세지 않는다 — prefs.chunk.L2 같은 것들 */
  const keys = []; let depth = 0, word = '';
  for (const c of body) {
    if (c === '{' || c === '[') { depth++; word = ''; continue; }
    if (c === '}' || c === ']') { depth--; word = ''; if (depth === 0) break; continue; }
    if (c === ',') { word = ''; continue; }
    if (c === ':') { if (depth === 1 && word) keys.push(word); word = ''; continue; }
    if (/[a-zA-Z0-9_]/.test(c)) word += c; else word = '';
  }
  assert.ok(keys.length > 3, '리터럴에서 키를 못 읽었습니다: ' + keys.join(','));
  /* v 는 스키마 판 번호, ts 는 저장 시각 — 그릇이 아니라 채울 것이 없다 */
  const known = OBJ.concat(ARR).concat(['profile', 'prefs', 'diag', 'lab', 'lvhint', 'v', 'ts']);
  keys.forEach((k) => assert.ok(known.includes(k),
    `새 상태 리터럴의 "${k}" 가 normalizeState 에서 채워지지 않습니다 — 이 파일의 목록에도 추가하세요`));
});

/* ── 연동 안내 ──
   기록을 잃는 두 번째 길은 코드 자체가 없는 것이다. 연동을 안 하면 브라우저
   하나에만 남고, 그 브라우저가 저장소를 비우면 되살릴 방법이 없다. 그래서
   첫 걸음에서 코드를 묻고, 안 넣었으면 홈에서 계속 알린다. 조용히 사라지기
   쉬운 배선이라 여기서 지킨다. */
const VOCAB = fs.readFileSync(path.join(__dirname, '..', 'vocab', 'index.html'), 'utf8');

t('온보딩 첫 걸음이 학생 코드다', () => {
  assert.ok(/step:SYNC\.avail\?'link':'grade'/.test(HTML), '온보딩이 연동부터 시작하지 않는다');
  assert.ok(/if\(st\.step==='link'\)\{/.test(HTML), '연동 화면이 없다');
  assert.ok(/id="obCode"/.test(HTML), '코드 입력칸이 없다');
  assert.ok(/data-act="ob-link"/.test(HTML) && /act==='ob-link'/.test(HTML), '연동 버튼이 배선되지 않았다');
  assert.ok(/data-act="ob-skip-link"/.test(HTML) && /act==='ob-skip-link'/.test(HTML), '건너뛰기가 배선되지 않았다');
});

t('서버에 못 닿는 주소에서는 연동을 묻지 않는다', () => {
  /* 미러·정적 배포에는 서버가 없다. 넣을 수 없는 코드를 물으면 거기서 막힌다 */
  assert.ok(/if\(st\.step==='link'&&!SYNC\.avail\)st\.step='grade';/.test(HTML),
    'SYNC.avail 이 아닐 때 연동 화면을 건너뛰지 않는다');
});

t('연동으로 프로필이 돌아오면 글 파일을 받고 홈으로 간다', () => {
  /* 새 기기는 부팅 때 프로필이 없어 학년별 글 파일을 안 받는다.
     그대로 홈으로 보내면 DB.articles 가 없어 터진다 — 실제로 그랬다 */
  const i = HTML.indexOf('function finishSync(');
  assert.notStrictEqual(i, -1, 'finishSync 가 없다');
  const body = HTML.slice(i, i + 1400);
  assert.ok(/loadLevel\(S\.profile\.level\)/.test(body), '복원 뒤 글 파일을 받지 않는다');
  assert.ok(body.indexOf('loadLevel(S.profile.level)') < body.indexOf("go('home')"),
    '글 파일을 받기 전에 홈으로 보낸다');
});

t('미연동이면 홈에서 계속 알린다', () => {
  assert.ok(/SYNC\.avail&&!SYNC\.auth/.test(HTML), '진로독서 홈에 미연동 판정이 없다');
  assert.ok(/linkwarn/.test(HTML), '진로독서 홈에 미연동 카드가 없다');
  assert.ok(/data-act="go-settings"/.test(HTML) && /act==='go-settings'/.test(HTML),
    '미연동 카드에서 설정으로 갈 길이 없다');
  assert.ok(/VSYNC\.avail && !vsyncAuth\(\)/.test(VOCAB), '워드브레인에 미연동 배너가 없다');
});

t('워드브레인은 서버 확인이 끝난 뒤 다시 그린다', () => {
  /* VSYNC.avail 은 첫 그리기 뒤에 정해진다. 다시 안 그리면 배너가 영영 안 뜬다 */
  assert.ok(/if \(VSYNC\.avail && !vsyncAuth\(\) && curView === 'garden'\) renderGarden\(\);/.test(VOCAB),
    '서버 확인 뒤 정원을 다시 그리지 않는다 — 배너가 안 뜬다');
});

console.log(`\nOK — ${passed}개 통과. 기록이 조금 상해도 앱은 뜨고, 연동 안내가 살아 있습니다.`);
