'use strict';
/* WB 공통 음성 모듈 검증 (node shared/voice.test.cjs)
   브라우저 없이도 안전한지와 음성 엔진의 시작·종료·오류·취소 흐름을 본다. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
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

t('speak — onstart를 넘겨도 엔진이 없으면 조용히 넘어간다', () => {
  let started = 0, ended = 0;
  V.speak('가나다', { onstart: () => { started += 1; }, onend: () => { ended += 1; } });
  assert.strictEqual(ended, 1);
  assert.strictEqual(started, 0, '소리가 안 났으면 onstart도 오면 안 된다 — 이걸로 실패를 잡는다');
});

/* 실제 소리를 대신하지 않는다. 클릭 안의 speak 호출, 늦은 이벤트와 예약만 재현한다. */
function browser() {
  const sent = [], timers = new Map();
  let timerId = 0;
  const engine = {
    voices: [], cancels: 0, resumes: 0,
    getVoices() { return this.voices; },
    speak(u) { sent.push(u); },
    cancel() { this.cancels += 1; },
    resume() { this.resumes += 1; },
  };
  const context = {
    window: { speechSynthesis: engine },
    SpeechSynthesisUtterance: function (text) { this.text = text; },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./voice.js'), 'utf8'), context);
  return { voice: context.WBVoice, engine, sent, timers, context, flush() {
    for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); }
  } };
}

t('첫 클릭에서 실제 문장을 즉시 요청한다 — 빈 발화·취소·목소리 대기·지연 예약 없음', () => {
  const b = browser();
  assert.strictEqual(b.voice.unlock(), true);
  assert.strictEqual(b.sent.length, 0, 'unlock이 빈 발화를 큐에 넣으면 안 된다');
  const u = b.voice.speak('관측', { lang: 'ko-KR', rate: 0.95 });
  assert.strictEqual(b.sent[0], u, '호출이 돌아오기 전에 실제 문장을 엔진에 넘겨야 한다');
  assert.strictEqual(u.text, '관측');
  assert.strictEqual(u.lang, 'ko-KR');
  assert.strictEqual(u.rate, 0.95);
  assert.strictEqual(b.engine.cancels, 0, '아무 말도 없는데 취소부터 하지 않는다');
  assert.strictEqual(b.timers.size, 0, '발화 예약을 남기지 않는다');
  assert.ok(b.engine.resumes > 0);
  assert.strictEqual(b.voice.isSpeaking(), true);
});

t('연속 클릭 뒤 옛 시작·종료·오류는 새 발화와 콜백을 건드리지 않는다', () => {
  const b = browser();
  let oldCalls = 0, started = 0, ended = 0;
  const old = b.voice.speak('첫 낱말', { onstart: () => oldCalls++, onend: () => oldCalls++, onerror: () => oldCalls++ });
  b.engine.cancel = () => old.onerror({ error: 'interrupted' });
  const next = b.voice.speak('다음 낱말', { onstart: () => started++, onend: () => ended++ });
  old.onstart(); old.onend(); old.onerror({ error: 'audio-busy' });
  assert.strictEqual(oldCalls, 0);
  assert.strictEqual(b.voice.isSpeaking(), true);
  next.onstart(); next.onstart();
  assert.strictEqual(started, 1);
  next.onend(); next.onerror({ error: 'failed' }); next.onend();
  assert.strictEqual(ended, 1);
  assert.strictEqual(b.voice.isSpeaking(), false);
});

t('즉시 중지하면 나중에 발화가 살아나거나 완료 콜백이 오지 않는다', () => {
  const b = browser();
  let calls = 0;
  const u = b.voice.speak('멈출 낱말', { startTimeout: 5000, onstart: () => calls++, onend: () => calls++, onerror: () => calls++ });
  b.engine.cancel = () => u.onerror({ error: 'canceled' });
  b.voice.stop(); b.flush(); u.onstart(); u.onend();
  assert.strictEqual(b.sent.length, 1);
  assert.strictEqual(b.timers.size, 0);
  assert.strictEqual(calls, 0);
  assert.strictEqual(b.voice.isSpeaking(), false);
});

t('엔진 미지원·생성·재개·발화의 동기 예외를 오류 콜백으로 한 번 알린다', () => {
  const unsupported = browser();
  unsupported.context.SpeechSynthesisUtterance = undefined;
  let reason;
  assert.strictEqual(unsupported.voice.speak('낱말', { onerror: (why) => { reason = why; } }), null);
  assert.strictEqual(reason, 'unsupported');
  for (const where of ['constructor', 'resume', 'speak']) {
    const b = browser(), errors = [];
    const fail = () => { throw new Error('engine failure'); };
    if (where === 'constructor') b.context.SpeechSynthesisUtterance = function () { fail(); };
    else b.engine[where] = fail;
    assert.doesNotThrow(() => b.voice.speak('낱말', { startTimeout: 5000, onerror: (why) => errors.push(why), onend: () => assert.fail('실패를 성공으로 알리지 않는다') }));
    assert.deepStrictEqual(errors, ['failed'], where);
    assert.strictEqual(b.voice.isSpeaking(), false, where);
    assert.strictEqual(b.timers.size, 0, where);
  }
});

t('비동기 엔진 오류는 원래 오류 코드를 알리고 재생 상태·감시를 정리한다', () => {
  for (const why of ['language-unavailable', 'not-allowed', 'audio-busy', 'interrupted']) {
    const b = browser(), errors = [];
    const u = b.voice.speak('낱말', { startTimeout: 5000, onerror: (error) => errors.push(error), onend: () => assert.fail('오류 뒤 다음 문장으로 넘어가면 안 된다') });
    u.onerror({ error: why }); u.onend(); u.onerror({ error: why });
    assert.deepStrictEqual(errors, [why]);
    assert.strictEqual(b.voice.isSpeaking(), false);
    assert.strictEqual(b.timers.size, 0);
  }
});

t('선택한 시작 제한시간은 무응답을 알리고, 시작·완료·교체 뒤에는 오작동하지 않는다', () => {
  const b = browser(), errors = [];
  const silent = b.voice.speak('무응답', { startTimeout: 5000, onerror: (why) => errors.push(why) });
  assert.strictEqual([...b.timers.values()][0].ms, 5000);
  b.flush(); silent.onstart(); silent.onend();
  assert.deepStrictEqual(errors, ['start-timeout']);
  assert.strictEqual(b.voice.isSpeaking(), false);
  assert.strictEqual(b.engine.cancels, 1);
  const started = b.voice.speak('읽는 중', { startTimeout: 5000, onerror: (why) => errors.push(why) });
  started.onstart(); b.flush();
  assert.strictEqual(b.voice.isSpeaking(), true);
  started.onend();
  const old = b.voice.speak('교체 전', { startTimeout: 5000, onerror: (why) => errors.push(why) });
  const late = [...b.timers.values()][0].fn;
  let ended = 0;
  const next = b.voice.speak('교체 뒤', { startTimeout: 5000, onend: () => ended++ });
  late(); old.onend();
  assert.strictEqual(b.voice.isSpeaking(), true);
  assert.strictEqual(b.timers.size, 1, '옛 콜백이 새 시작 감시를 지우면 안 된다');
  next.onend(); b.flush();
  assert.strictEqual(ended, 1, '시작 이벤트 없이 완료하는 엔진도 완료를 전달한다');
  assert.deepStrictEqual(errors, ['start-timeout']);
});

t('초기 목소리 목록은 비어 있어도 읽고, 다음 클릭에서는 로드된 언어 음성을 고른다', () => {
  const b = browser();
  const first = b.voice.speak('Hello', { lang: 'en-US' });
  assert.strictEqual(first.lang, 'en-US', '긴 언어 코드가 한국어로 바뀌면 안 된다');
  first.onend();
  const korean = { lang: 'ko-KR', name: '한국어', default: true };
  b.engine.voices = [{ lang: 'en-US' }, korean];
  const next = b.voice.speak('관측', { lang: 'ko' });
  assert.strictEqual(next.voice, korean);
  assert.strictEqual(next.lang, 'ko-KR');
});

t('순차 발화는 완료마다 이어지고 중지·옛 핸들 취소는 새 발화를 끊지 않는다', () => {
  const b = browser();
  let ended = 0, errors = 0;
  const seq = b.voice.speakSeq(['낱말', '', '뜻'], { onend: () => ended++, onerror: () => errors++ });
  assert.deepStrictEqual(b.sent.map((u) => u.text), ['낱말']);
  b.sent[0].onend();
  assert.deepStrictEqual(b.sent.map((u) => u.text), ['낱말', '뜻']);
  b.sent[1].onend(); b.sent[1].onend();
  assert.strictEqual(ended, 1);
  const next = b.voice.speak('새 낱말');
  seq.cancel();
  assert.strictEqual(b.voice.isSpeaking(), true, '끝난 순차 발화의 핸들이 새 발화를 취소하면 안 된다');
  next.onend();
  const canceled = b.voice.speakSeq(['중지할 말', '나오면 안 되는 말'], { onend: () => ended++, onerror: () => errors++ });
  const last = b.sent[b.sent.length - 1], count = b.sent.length;
  canceled.cancel(); last.onend(); last.onerror({ error: 'canceled' }); b.flush();
  assert.strictEqual(b.sent.length, count);
  assert.strictEqual(ended, 1);
  assert.strictEqual(errors, 0);
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
