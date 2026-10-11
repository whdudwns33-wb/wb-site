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

console.log('OK — ' + passed + '개 통과');
