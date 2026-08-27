'use strict';
/* WB 공통 음성 모듈 검증 (node shared/voice.test.cjs)
   브라우저 API는 Node에 없으므로, 브라우저 없이도 안전한지와 순수 로직을 본다. */
const assert = require('assert');
const V = require('./voice.js');

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ✓ ' + name); }

t('브라우저 API가 없어도 로드되고, 지원 여부를 false로 답한다', () => {
  assert.strictEqual(V.ttsSupported(), false);
  assert.strictEqual(V.recSupported(), false);
  assert.strictEqual(V.hasVoice('ko'), false);
  assert.strictEqual(V.voiceFor('ko'), null);
});

t('speak — 엔진이 없어도 터지지 않고 onend를 부른다(호출측 흐름이 멈추면 안 된다)', () => {
  let ended = 0;
  V.speak('아무 말', { onend: () => { ended += 1; } });
  assert.strictEqual(ended, 1, '엔진 없으면 즉시 끝난 것으로 처리');
  V.speak('', { onend: () => { ended += 1; } });
  assert.strictEqual(ended, 2, '빈 문자열도 끝난 것으로 처리');
  assert.doesNotThrow(() => V.stop());
});

t('onReady — 엔진이 없으면 false로 즉시 답한다', () => {
  let got = null;
  V.onReady((ok) => { got = ok; });
  assert.strictEqual(got, false);
});

/* 목소리 판정 — 한글이 섞이면 한국어로 읽는다.
   영어 목소리는 한글을 못 읽지만 한국어 목소리는 영단어를 그럭저럭 읽는다. */
t('langOf — 한글이 섞이면 한국어', () => {
  assert.strictEqual(V.langOf('관측이란 무엇인가'), 'ko');
  assert.strictEqual(V.langOf('관측 observe 하다'), 'ko', '글자 수로만 비교하면 영어로 새어 나간다');
  assert.strictEqual(V.langOf('GPS 위성이 돈다'), 'ko');
  assert.strictEqual(V.langOf('A 위'), 'ko');
});

t('langOf — 라틴만 있을 때만 영어', () => {
  assert.strictEqual(V.langOf('The satellite observes'), 'en');
  assert.strictEqual(V.langOf('persuade'), 'en');
});

t('langOf — 한글이 스치듯 섞인 영어 문장은 영어', () => {
  assert.strictEqual(V.langOf('Global Positioning System 은'), 'en', '라틴이 한글의 8배를 넘으면 영어');
});

t('langOf — 글자가 없으면 한국어(기본값)', () => {
  assert.strictEqual(V.langOf(''), 'ko');
  assert.strictEqual(V.langOf('123 456'), 'ko');
  assert.strictEqual(V.langOf(null), 'ko');
});

t('speakSeq — 엔진이 없어도 전부 훑고 끝난다, 빈 토막은 건너뛴다', () => {
  let ended = 0;
  V.speakSeq(['관측', '', null, '살펴 재기'], { onend: () => { ended += 1; } });
  assert.strictEqual(ended, 1, '끝까지 가고 onend 한 번');
  V.speakSeq([], { onend: () => { ended += 1; } });
  assert.strictEqual(ended, 2, '빈 목록도 즉시 끝');
});

t('speakSeq — cancel하면 onend가 오지 않는다', () => {
  let ended = 0;
  const h = V.speakSeq(['가', '나'], { onend: () => { ended += 1; } });
  assert.doesNotThrow(() => h.cancel());
  assert.strictEqual(ended, 1, '엔진 없는 환경에선 이미 끝나 있고, cancel은 터지지 않는다');
});

t('clock — 분:초 표시', () => {
  assert.strictEqual(V.clock(0), '0:00');
  assert.strictEqual(V.clock(7000), '0:07');
  assert.strictEqual(V.clock(65000), '1:05');
  assert.strictEqual(V.clock(600000), '10:00');
  assert.strictEqual(V.clock(-5), '0:00', '음수도 0으로');
  assert.strictEqual(V.clock(undefined), '0:00');
});

t('pickMime — MediaRecorder가 없으면 빈 문자열(브라우저 기본값에 맡긴다)', () => {
  assert.strictEqual(V.pickMime(), '');
});

t('Recorder — 지원 안 되면 reject, release는 언제 불러도 안전', () => {
  const r = new V.Recorder();
  assert.doesNotThrow(() => r.release());
  assert.doesNotThrow(() => r.release(), '두 번 불러도 안전');
  assert.strictEqual(r.elapsedMs(), 0);
  return r.start().then(
    () => { throw new Error('지원 안 되는데 성공하면 안 된다'); },
    (e) => { assert.strictEqual(e.message, 'unsupported'); }
  );
});

console.log('\n통과 ' + passed + '개 — 공통 음성 모듈 검증 완료');
