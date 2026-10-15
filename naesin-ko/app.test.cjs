'use strict';
/* 국어브레인 학생 화면 정적 검사 (node naesin-ko/app.test.cjs)
 *
 * 화면 흐름은 사람이 눌러 봐야 알지만, 아래 세 가지는 "눌러 봐도 바로는 안 보이는" 종류다 —
 * 배경 재시도가 **공부 도중에 팩을 갈아 끼우면** 화면은 체험 문항을 계속 내는데 기록은 실제 단원
 * 칸에 쌓이고 서버로도 올라간다. 몇 분 뒤에야 일어나니 손으로 눌러서는 못 만난다.
 * 그래서 그 설계(받아 두고, 안전한 순간에만 끼운다)를 코드 모양으로 못 박아 둔다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const R = require('./render.js');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const DIR = __dirname;
const app = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const js = app.slice(app.indexOf('<script>', app.indexOf('</style>')) + 8, app.lastIndexOf('</script>'));
/* 함수 하나만 떼어 본다 — 중괄호 균형으로 끝을 찾는다 */
function body(name) {
  const at = js.indexOf('function ' + name + '(');
  assert.ok(at >= 0, name + ' 함수를 못 찾았다');
  let i = js.indexOf('{', at), d = 0;
  for (let k = i; k < js.length; k += 1) {
    if (js[k] === '{') d += 1;
    else if (js[k] === '}') { d -= 1; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error(name + ' 의 끝을 못 찾았다');
}

t('인라인 코드가 파싱되고 화면 틀이 다 있다', () => {
  assert.ok(js.length > 20000, '스크립트를 제대로 못 떼어 냈다(' + js.length + '자)');
  new Function(js);   /* 문법 오류면 여기서 던진다 */
  ['tabs', 'wrap', 'hstat', 'wm'].forEach((id) => assert.ok(app.includes('id="' + id + '"'), id + ' 가 없다'));
});

t('소설 읽기는 문단을 안전하게 표시하고 낭독한다', () => {
  const paragraphs = ['지도에 <새 길>을 그렸다.', '친구와 길을 다시 확인했다.'];
  let html, click, spoken;
  const voice = { speak: (text) => { spoken = text; } };
  vm.runInNewContext('function startRead() ' + body('startRead') + '; startRead();', {
    S: { workId: 'novel' }, work: () => ({ title: '체험 소설', text: { paragraphs } }), R,
    esc: (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    full: (text) => { html = text; }, $: () => ({ addEventListener: (_, fn) => { click = fn; } }),
    document: { querySelectorAll: () => [] }, window: { WBVOICE: voice }, WBVOICE: voice
  });
  assert.ok(html.includes('지도에 &lt;새 길&gt;을 그렸다.'), '소설 문단이 표시되지 않는다');
  assert.ok(html.includes('친구와 길을 다시 확인했다.'));
  assert.ok(!html.includes('이 팩은 본문을 싣지 않습니다'));
  click({ target: { closest: (selector) => selector === '[data-tts]' } });
  assert.strictEqual(spoken, paragraphs.join(' '));
});

t('팩은 applyPack 한 곳에서만 끼운다 — 받아 온 자리에서 바로 갈지 않는다', () => {
  /* S.pack 에 값을 넣는 곳은 applyPack(실제 단원)과 demo(체험 팩) 둘뿐이어야 한다.
     loadPack 이 받은 자리에서 바로 넣으면 그 순간이 공부 도중일 수 있다. */
  const sites = [...js.matchAll(/S\.pack\s*=/g)].length;
  assert.strictEqual(sites, 2, 'S.pack 에 대입하는 곳이 ' + sites + '군데 — applyPack 과 demo 둘이어야 한다');
  assert.ok(/S\.pack\s*=/.test(body('applyPack')), 'applyPack 이 팩을 끼우지 않는다');
  assert.ok(!/S\.pack\s*=/.test(body('loadPack')), 'loadPack 이 받은 자리에서 팩을 갈아 끼운다');
  assert.ok(/S\.pending\s*=\s*\{/.test(body('loadPack')), 'loadPack 이 받은 팩을 S.pending 에 두지 않는다');
});

t('받아 둔 팩은 공부 중이면 끼우지 않는다', () => {
  const ap = body('applyPending');
  assert.ok(/busy\(/.test(ap), 'applyPending 이 busy() 를 묻지 않는다');
  assert.ok(/return false/.test(ap), 'applyPending 이 못 끼운 경우를 알려 주지 않는다');
  const b = body('busy');
  assert.ok(/S\.session/.test(b) && /S\.paperWork/.test(b), 'busy() 가 세션·종이 채점을 보지 않는다');
  /* 주석 복원·서술형 입력은 플래그가 없고 textarea 로만 산다 — 적어 둔 글도 '공부 중'이다 */
  assert.ok(/textarea/.test(b), 'busy() 가 적어 둔 글(textarea)을 보지 않는다');
  assert.ok(/applyPending\(/.test(body('setTab')), 'setTab 이 받아 둔 팩을 끼울 기회를 주지 않는다');
});

t('배경 재시도는 끼웠을 때만 다시 그리고, 늦게 온 재시도는 끼어들지 않는다', () => {
  const pf = body('packFail');
  assert.ok(/if \(!S\.demo \|\| S\.retryId !== id\) return;/.test(pf),
    '늦게 온 재시도가 이미 열린 다른 단원을 체험 팩으로 덮을 수 있다');
  assert.ok(/then\(function \(ok\) \{ if \(ok\) render\(\); \}\)/.test(pf),
    '재시도가 끼우지 못했는데도 다시 그린다 — 보고 있던 화면·적어 둔 글이 날아간다');
  /* 404 는 기다려도 안 바뀌고, 403 은 범위 변경이 퍼지는 1분을 위해 두 번은 다시 묻는다 */
  assert.ok(/status !== 404/.test(pf), '404 에도 재시도를 건다');
  assert.ok(/retries403/.test(pf), '403 에 한 번도 다시 묻지 않는다 — 범위를 방금 바꾼 학생이 갇힌다');
});

t('단원 전환 버튼은 체험 모드에서도 남는다 — 돌아갈 길이 그것뿐이다', () => {
  const at = js.indexOf('data-unit="');
  assert.ok(at > 0, '단원 전환 버튼이 없다');
  const bn = body('banner');
  assert.ok(/\(S\.packIds \|\| \[\]\)\.length > 1/.test(bn), '단원 버튼 조건을 못 찾았다');
  assert.ok(!/!S\.demo && \(S\.packIds/.test(bn),
    '체험 모드에서 단원 버튼이 사라진다 — 전환이 실패해 체험 팩으로 떨어지면 되돌아갈 수 없다');
  /* 전환은 학생이 누른 것이라 바로 갈아 준다 */
  assert.ok(/loadPack\(id, true\)/.test(js), '단원 전환이 즉시 반영되지 않는다');
});

/* ── 라이선스 자료가 학생 기록에 베껴지지 않는가 ──
   오답노트가 발문 원문(it.stem)을 담아 localStorage·KV·야간 백업까지 복제하고 있었다.
   자료를 금고(원장 PC)에만 두는 결정의 전제가 "자료는 라이선스 칸에만 있다"인데
   이 한 줄이 그 전제를 깨고 있었다 — 코드 모양으로 못 박는다. */
t('오답노트는 좌표만 적는다 — 발문 원문을 담지 않는다', () => {
  const mw = body('markWrong');
  assert.ok(!/\bit\.stem\b/.test(mw) && !/\bit\.context\b/.test(mw),
    'markWrong 이 발문·지문을 기록에 넣는다 — 그 글이 KV·야간 백업까지 복제된다');
  ['workId', 'kind', 'no'].forEach((f) => assert.ok(new RegExp(f + ':').test(mw), mw + ' 에 ' + f + ' 좌표가 없다'));
  assert.ok(!/label:/.test(mw), 'markWrong 이 아직 label 을 적는다');
  /* 합성 객체로 부르는 자리도 글을 넘기면 안 된다 */
  assert.ok(!/markWrong\([^)]*stem\s*:/.test(js), '어느 호출부가 아직 stem 을 넘긴다');
  /* 화면 이름은 좌표로 그때그때 만든다 */
  assert.ok(/function wrongLabel\(/.test(js), 'wrongLabel 이 없다');
  assert.ok(/esc\(wrongLabel\(x\)/.test(js), '오답 표가 아직 저장된 글을 그린다');
});

t('옛 버전이 적어 둔 발문을 불러올 때 지우고, 지웠으면 올려 보낸다', () => {
  const sc = body('scrubWrong');
  assert.ok(/delete w\[k\]\.label/.test(sc), 'scrubWrong 이 label 을 지우지 않는다');
  /* 불러오는 길이 둘이다 — 기기(localStorage)와 서버 기록. 둘 다 걸려야 한다 */
  assert.ok(/scrubWrong\(j\)/.test(body('load')), 'localStorage 를 불러올 때 지우지 않는다');
  assert.ok(/scrubWrong\(sv\)/.test(body('online')), '서버 기록을 받을 때 지우지 않는다');
  /* 수도를 잠그는 것과 흘러나온 물을 닦는 것은 다른 일이다 — 지운 것을 올려 서버에서도 없애야 한다 */
  assert.ok(/if \(S\.scrubbed\) persist\(\)/.test(js), '지운 기록을 서버로 올려 보내지 않는다');
});

t('관리 웹의 루브릭 초안은 기한이 있다 — 브라우저에 영구히 남지 않는다', () => {
  const admin = fs.readFileSync(path.join(DIR, '..', 'reading-server', 'public', 'naesin-ko-admin.html'), 'utf8');
  assert.ok(/RB_DRAFT_TTL_MS/.test(admin), '초안 기한이 없다 — 저작을 중간에 그만둔 단원이 영구히 남는다');
  assert.ok(/function rbSweep\(/.test(admin), '기한 지난 초안을 훑어 지우는 길이 없다');
  assert.ok(/localStorage\.removeItem\(rbStore\(\)\)/.test(admin), '초안이 비었을 때 칸을 비우지 않는다');
  assert.ok(/at: Date\.now\(\)/.test(admin), '초안에 적은 시각이 없으면 나이를 알 수 없다');
  assert.ok(/rbSweep\(\);/.test(admin), 'rbSweep 을 부르는 곳이 없다');
  /* 내려받기는 남기고 경고만 띄운다(원장 결정 2026-10-11) — 누르기 전에 보이는 고정 안내와
     누른 뒤의 확인, 둘 다 있어야 한다. 확인만 있으면 늦고, 안내만 있으면 지나친다. */
  assert.ok(/금고/.test(admin), '다운로드 파일을 어디 둬야 하는지 화면에 적혀 있지 않다');
  const dl = admin.slice(admin.indexOf("$('#btnRbSave').onclick"), admin.indexOf("$('#btnRbSave').onclick") + 1400);
  assert.ok(/confirm\(/.test(dl), '내려받기 전에 묻지 않는다 — 라이선스 자료가 섞인 파일이다');
  assert.ok(dl.indexOf('confirm(') < dl.indexOf('a.click()'), '묻기 전에 이미 내려받는다');
  assert.ok(/return;/.test(dl.slice(dl.indexOf('confirm('), dl.indexOf('a.click()'))),
    '아니오를 눌러도 내려받는다');
});

console.log('OK — ' + passed + '개 통과');
