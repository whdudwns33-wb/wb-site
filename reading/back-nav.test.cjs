'use strict';
/* 학생 앱 두 개의 안드로이드 뒤로 가기 처리 (node reading/back-nav.test.cjs)

   방문 기록을 남기지 않으면 뒤로 가기가 곧 앱 종료다. 글을 읽는 중에도,
   낱말을 심는 중에도 한 번에 닫혀 버린다. 배선이 네 군데 다 걸려 있어야
   동작하므로(첫 화면 replace · 화면 이동 push · popstate 수신 · 오버레이),
   하나라도 빠지면 조용히 예전처럼 닫힌다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const VOCAB = read('vocab/index.html');
const READING = read('reading/index.html');

t('워드브레인 — 화면을 옮기면 방문 기록을 남긴다', () => {
  assert.ok(/function navSet\(v, replace\)/.test(VOCAB), 'navSet 이 없다');
  assert.ok(/history\.pushState\(st, ''\)/.test(VOCAB), '화면 이동이 기록을 쌓지 않는다');
  assert.ok(/if \(!fromPop\) navSet\(v\);/.test(VOCAB), 'show 가 기록을 남기지 않는다');
});

t('워드브레인 — 첫 화면은 기록을 쌓지 않고 얹는다', () => {
  /* 첫 화면에서 쌓아 버리면 뒤로 가기를 두 번 눌러야 앱이 닫힌다 */
  assert.ok(/navSet\('garden', true\);\s*\n\s*show\('garden', true\);/.test(VOCAB),
    '첫 화면이 replace 가 아니다');
});

t('워드브레인 — 뒤로 가기가 오버레이를 먼저 닫는다', () => {
  /* 심기·물 주기가 오버레이다. 이걸 건너뛰고 탭을 되돌리면 세션이 날아간다 */
  assert.ok(/history\.pushState\(\{ wb: 'ov' \}, ''\)/.test(VOCAB), '오버레이가 기록을 차지하지 않는다');
  assert.ok(/window\.addEventListener\('popstate'/.test(VOCAB), 'popstate 를 듣지 않는다');
  const h = VOCAB.slice(VOCAB.indexOf("addEventListener('popstate'"));
  const body = h.slice(0, h.indexOf('});'));
  assert.ok(body.indexOf('closeOverlay(true)') < body.indexOf("st.wb === 'view'"),
    '오버레이 닫기가 탭 되돌리기보다 앞서지 않는다');
});

t('워드브레인 — ✕ 로 닫아도 기록이 헛돌지 않는다', () => {
  /* 오버레이 기록을 그대로 두면 다음 뒤로 가기가 아무 일도 안 한 것처럼 보인다 */
  assert.ok(/function closeOverlay\(fromPop\)/.test(VOCAB), 'closeOverlay 가 호출 출처를 구분하지 않는다');
  assert.ok(/if \(!fromPop\) navSet\(curView, true\);/.test(VOCAB),
    '✕ 로 닫을 때 오버레이 기록을 지금 탭 기록으로 바꾸지 않는다');
});

t('진로독서 — 화면을 옮기면 방문 기록을 남긴다', () => {
  assert.ok(/function navSet\(v,replace\)/.test(READING), 'navSet 이 없다');
  assert.ok(/function go\(name,extra,fromPop\)/.test(READING), 'go 가 호출 출처를 구분하지 않는다');
  assert.ok(/if\(!fromPop\)navSet\(view\);/.test(READING), 'go 가 기록을 남기지 않는다');
  assert.ok(/window\.addEventListener\('popstate'/.test(READING), 'popstate 를 듣지 않는다');
});

t('진로독서 — 첫 화면은 기록을 쌓지 않고 얹는다', () => {
  assert.ok(/navSet\(view,true\);/.test(READING), '첫 화면이 replace 가 아니다');
});

t('두 앱 모두 기록을 못 써도 죽지 않는다', () => {
  /* 사생활 보호 모드 등에서 pushState 가 막히는 브라우저가 있다.
     거기서 예외가 새면 화면 이동 자체가 멈춘다 — 앱이 통째로 먹통이 된다. */
  for (const [name, src] of [['워드브레인', VOCAB], ['진로독서', READING]]) {
    /* 진로독서 쪽은 한 줄로 붙어 있어 줄바꿈으로 함수 끝을 못 찾는다 — 앞쪽 한 토막만 본다 */
    const i = src.indexOf('function navSet');
    const fn = src.slice(i, i + 400);
    assert.ok(/try\s*\{/.test(fn) && /catch/.test(fn), name + ': navSet 이 try/catch 로 감싸여 있지 않다');
  }
});

console.log('\n통과 ' + passed + '개 — 학생 앱 뒤로 가기 검증 완료');
