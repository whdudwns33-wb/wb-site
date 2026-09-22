'use strict';
/* 실제 학생 화면의 스크립트·이벤트를 실행한다. DOM·마이크·오디오만 대신한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const R = require('./rules.js');
const SC = require('./sched.js');
const source = fs.readFileSync(__dirname + '/index.html', 'utf8').match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

function app(family = false) {
  const nodes = new Map(), events = {}, storage = new Map(), recorders = [], sources = [], decode = deferred();
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', classList: { add() {}, remove() {} }, scrollIntoView() {} }); return nodes.get(id); };
  class Recorder {
    constructor() { this.startGate = deferred(); this.stopGate = deferred(); this.active = false; this.released = 0; recorders.push(this); }
    start() { return this.startGate.promise.then(() => { this.active = true; }); }
    stop() { return this.stopGate.promise.then((res) => { this.active = false; return res; }); }
    release() { this.active = false; this.released++; }
  }
  class AudioContext {
    decodeAudioData() { return decode.promise; }
    createBufferSource() { const src = { start() { this.started = true; }, stop() { this.stopped = true; }, connect() {} }; sources.push(src); return src; }
  }
  const context = {
    WBCHUNK: R, WBCHUNK_SCHED: SC, WBCHUNK_PASSAGES: require('./passages.js'), WBCHUNK_LESSONS: require('./lessons.js'),
    WBVoice: { Recorder, recSupported: () => true, ttsSupported: () => false, stop() {}, clock: () => '0:01' },
    document: { getElementById: node, addEventListener: (key, fn) => { events[key] = fn; }, querySelectorAll: () => [], body: { classList: { add() {} } } },
    window: { AudioContext, addEventListener() {}, scrollTo() {}, scrollY: 0 },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    location: { search: family ? '?t=abcdefghijklmnop' : '', pathname: '/chunk/', protocol: 'http:' },
    history: { pushState() {} }, navigator: {}, URLSearchParams, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, confirm: () => true,
  };
  /* 시작 시 서버 요청만 제외한다. 렌더와 클릭 처리기는 원문 그대로 사용한다. */
  vm.runInNewContext(source.slice(0, source.indexOf('    /* ── 시작 ── */')) + `
    globalThis.ui = {
      get state() { return S; }, get session() { return sess; }, rec: REC,
      recStart, recStop, recPlay, recRelease,
      start(band, q) {
        S = SC.blank(Date.now()); S.band = band;
        CUSTOM = [{ id: 'teacher-test', band, title: '테스트 글', genre: '설명', paragraphs: [['아침에 ', '햇빛이 들었다.']], q }];
        startPractice('teacher-test', 'practice');
      }
    };
  })();`, context);
  return { ui: context.ui, recorders, sources, decode, html: () => node('app').innerHTML,
    click(act, extra = {}) { events.click({ target: { closest: () => ({ dataset: { act, ...extra } }) } }); } };
}

function reachReading(a) {
  a.click('pr-to2');
  const pr = a.ui.session.pr;
  pr.units.forEach((u, i) => { pr.marks[i] = new Set(u.model); });
  if (pr.sentMode) {
    while (pr.stage === 2) { a.click('pr-check'); a.click('pr-unit-next'); }
  } else { a.click('pr-check'); a.click('pr-to3'); }
  assert.equal(pr.stage, 3);
}

(async () => {
  for (const family of [false, true]) for (const band of ['K', 'G3']) await test(`${family ? '가족' : '학생'} ${band}: 문제 없는 글도 읽기 완료 후 미측정으로 저장`, () => {
    const a = app(family); a.ui.start(band, null); reachReading(a);
    assert.doesNotMatch(a.html(), /data-act="pr-finish"/);
    a.click('pr-finish'); assert.equal(a.ui.state.log.length, 0);
    if (band === 'G3') a.click('pr-read-start');
    a.click('pr-read-done');
    assert.match(a.html(), /data-act="pr-finish"/);
    a.click('pr-finish'); a.click('pr-finish');
    assert.equal(a.ui.state.log.length, 1);
    assert.equal(a.ui.state.log[0].qOk, null);
    assert.equal(SC.summary(a.ui.state, Date.now()).qRate, null);
    assert.match(a.html(), /문제 미측정/);
  });

  await test('읽기 전·읽는 중에는 문항과 결과를 열 수 없고, 답은 한 번만 기록', () => {
    const a = app(true); a.ui.start('G3', { q: '언제?', choices: ['아침', '저녁', '밤', '새벽'], answer: 0, explain: '아침이에요.' }); reachReading(a);
    a.click('pr-read-done'); assert.equal(a.ui.session.pr.readMs, null);
    for (let step = 0; step < 2; step++) {
      assert.doesNotMatch(a.html(), /data-act="pr-pick"/);
      a.click('pr-pick', { i: '0' }); a.click('pr-finish'); a.click('pr-peek');
      assert.equal(a.ui.session.pr.picked, null); assert.equal(a.ui.state.log.length, 0);
      assert.equal(a.ui.session.pr.peek, false);
      if (!step) a.click('pr-read-start');
    }
    a.click('pr-read-done');
    a.click('pr-pick', { i: '-1' }); assert.equal(a.ui.session.pr.picked, null);
    a.click('pr-pick', { i: '0' }); a.click('pr-pick', { i: '1' }); a.click('pr-finish'); a.click('pr-finish');
    assert.equal(a.ui.state.log.length, 1); assert.equal(a.ui.state.log[0].qOk, true);
  });

  await test('직접 끊기로 이동하면 마이크·재생을 종료하고 완료한 자기 점검은 유지', async () => {
    const a = app(true); a.ui.start('G3', null);
    const pending = a.ui.recStart(), r = a.recorders[0]; r.startGate.resolve(); await pending;
    assert.equal(r.active, true);
    a.click('pr-to2'); assert.equal(r.active, false); assert.equal(a.ui.rec.on, false);
    a.ui.start('G3', null);
    const started = a.ui.recStart(), next = a.recorders[1]; next.startGate.resolve(); await started;
    const blob = { arrayBuffer: async () => new ArrayBuffer(0) };
    const stopped = a.ui.recStop(); next.stopGate.resolve({ blob, ms: 1000 }); await stopped;
    const playing = a.ui.recPlay(); a.decode.resolve({}); await playing;
    reachReading(a);
    assert.equal(next.active, false); assert.equal(a.ui.rec.on, false);
    assert.equal(a.sources[0].stopped, true); assert.equal(a.sources[0].onended, null);
    assert.equal(a.ui.rec.blob, blob);
    a.click('pr-read-start'); a.click('pr-read-done'); a.click('pr-finish');
    assert.equal(a.ui.state.log[0].self, 0); assert.equal(a.ui.rec.blob, null);
  });

  await test('늦게 허용된 이전 세션의 마이크는 닫고 새 녹음에 간섭하지 않음', async () => {
    const a = app(true); a.ui.start('G3', null);
    const oldStart = a.ui.recStart(), old = a.recorders[0];
    a.ui.recStart(); assert.equal(a.recorders.length, 1, '권한 대기 중 중복 요청 금지');
    a.ui.start('K', null); const newStart = a.ui.recStart(), current = a.recorders[1];
    old.startGate.resolve(); await oldStart;
    assert.equal(old.active, false); assert.equal(a.ui.rec.r, current); assert.equal(a.ui.rec.on, false);
    current.startGate.resolve(); await newStart; assert.equal(current.active, true);
    a.ui.recRelease(); assert.equal(current.active, false);
  });

  await test('이전 녹음의 늦은 종료 결과가 다음 세션에 나타나지 않음', async () => {
    const a = app(); a.ui.start('G3', null);
    const started = a.ui.recStart(), r = a.recorders[0]; r.startGate.resolve(); await started;
    const stopped = a.ui.recStop();
    a.ui.start('K', null);
    r.stopGate.resolve({ blob: {}, ms: 1000 }); await stopped;
    assert.equal(a.ui.rec.blob, null); assert.equal(a.ui.session.pr.stage, 1);
    assert.doesNotMatch(a.html(), /data-act="rec-play"/);
  });

  await test('디코딩 중 다음 단계로 이동하면 늦게 재생하지 않음', async () => {
    const a = app(); a.ui.start('G3', null);
    a.ui.rec.blob = { arrayBuffer: async () => new ArrayBuffer(0) };
    const playing = a.ui.recPlay();
    a.click('pr-to2'); a.decode.resolve({}); await playing;
    assert.equal(a.sources.length, 0); assert.equal(a.ui.rec.src, null);
  });
  console.log(`\n청크 화면 ${passed}개 통과`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
