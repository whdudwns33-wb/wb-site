'use strict';
/* 실제 쓰기 화면 함수를 실행해 시범·학습·기록 경계를 검사한다. 캔버스의 픽셀 판정은 trace.test.cjs에서 다룬다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const T = require('./trace.js');
const S = require('./srs.js');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const source = html.slice(html.indexOf('  function tracePanelHtml()'), html.indexOf("  window.addEventListener('resize', function () { if (TRACE"));
assert.ok(source.includes('function traceAnimate()'), '실제 쓰기 화면 함수를 찾지 못했다');
const cross = [[[0.1, 0.5], [0.9, 0.5]], [[0.5, 0.1], [0.5, 0.9]]];
const points = (line) => line.map(([x, y]) => ({ x, y }));
const copy = (value) => JSON.parse(JSON.stringify(value));
let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

function harness() {
  const nodes = new Map(), frames = new Map();
  let frameId = 0, clock = 0, saves = 0, returned = 0;
  const glyph = T.rasterize(cross.map(points), 48, 2);
  const context2d = new Proxy({}, { get(target, key) {
    if (key === 'getImageData') return () => ({ data: Uint8ClampedArray.from({ length: 48 * 48 * 4 }, (_, i) => i % 4 === 3 && glyph[Math.floor(i / 4)] ? 255 : 0) });
    return target[key] || (() => {});
  }});
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '', hidden: false, disabled: false, events: {},
      addEventListener(event, cb) { this.events[event] = cb; },
      getBoundingClientRect() { return { width: 300, height: 300, left: 0, top: 0 }; },
      getContext() { return context2d; }, setPointerCapture() {}, scrollIntoView() {},
    });
    return nodes.get(id);
  }
  const app = {
    TRACE: null, curView: 'chars', TRACE_FONT: 'serif', MASK_N: 48,
    LIB: { chars: {
      十: { ch: '十', hun: '열', eum: '십', strokes: 2, medians: cross, _sid: 'c:十', _book: 'own' },
      土: { ch: '土', hun: '흙', eum: '토', strokes: 2, _sid: 'c:土', _book: 'own' },
    } },
    db: { trace: {}, states: {} }, WBHTRACE: T, WBHSRS: S,
    $: node, document: { createElement: () => node('offscreen') }, window: { devicePixelRatio: 1 },
    now: () => 1000, save: () => { saves++; }, logEvent() {}, bumpStreak() {}, toast() {}, render() {}, renderChars() {}, esc: (v) => String(v),
    requestAnimationFrame(cb) { const id = ++frameId; frames.set(id, cb); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  vm.createContext(app); vm.runInContext(source, app);
  return {
    app, node, frames,
    open(ch = '十') { app.traceOpen([ch], () => { returned++; }); },
    click(id) { const el = node('#' + id); if (!el.disabled && !el.hidden) el.events.click.call(el); },
    draw(line) { const stroke = points(line); app.TRACE.strokes.push(stroke); app.traceJudgeStroke(stroke); },
    finishDemo() { let left = 100; while (frames.size && left--) { const [id, cb] = frames.entries().next().value; frames.delete(id); cb(clock); clock += 100; } assert.ok(left > 0, '시범이 끝나지 않는다'); },
    get saves() { return saves; }, get returned() { return returned; },
  };
}

t('시범을 다 본 뒤 안내→흐릿→혼자 쓰기, 실제 성공 3회만 기록한다', () => {
  const h = harness(), a = h.app;
  h.open();
  assert.strictEqual(a.TRACE.phase, 'demo');
  assert.ok(a.TRACE.anim && h.node('#trNext').disabled && h.node('#trClear').disabled);
  a.traceNext(); a.traceRepDone();
  assert.strictEqual(a.TRACE.step, 0); assert.strictEqual(h.saves, 0);
  h.finishDemo();
  assert.strictEqual(a.TRACE.demoSeen, true); assert.strictEqual(h.saves, 0);
  h.click('trNext');
  assert.strictEqual(a.TRACE.phase, 'write');
  assert.ok(/한 획씩/.test(h.node('#trRep').textContent));
  for (let rep = 0; rep < 3; rep++) {
    assert.strictEqual(a.TRACE.cur.rep, rep);
    assert.ok(new RegExp(['한 획씩', '흐릿한', '혼자'][rep]).test(h.node('#trRep').textContent));
    cross.forEach(h.draw);
    a.traceRepDone();
    assert.strictEqual(a.db.trace['十'].reps, rep + 1, '중복 완료가 회차를 늘렸다');
    h.click('trNext');
  }
  assert.strictEqual(a.TRACE, null); assert.strictEqual(h.saves, 3);
  assert.ok(/획순·방향에 맞게 쓴 횟수 3회/.test(h.node('#trPanelWrap').innerHTML));
  h.click('trClose'); assert.strictEqual(h.returned, 1);
});

t('순서·방향이 틀린 획은 남기지 않고 현재 획을 다시 쓰게 한다', () => {
  const h = harness(), a = h.app; h.open(); h.finishDemo(); h.click('trNext');
  h.draw(cross[1]);
  assert.strictEqual(a.TRACE.done.length, 0); assert.strictEqual(a.TRACE.strokes.length, 0);
  assert.ok(/순서가 달라요/.test(h.node('#trTip').textContent));
  h.draw(cross[0].slice().reverse());
  assert.strictEqual(a.TRACE.done.length, 0); assert.strictEqual(h.saves, 0);
  assert.ok(/방향이 반대/.test(h.node('#trTip').textContent));
  h.draw(cross[0]);
  assert.strictEqual(a.TRACE.done.length, 1);
  assert.ok(/2 \/ 2획/.test(h.node('#trStroke').textContent));
  h.draw(cross[1]); assert.strictEqual(a.db.trace['十'].reps, 1);
  h.click('trClear'); cross.forEach(h.draw);
  assert.strictEqual(a.db.trace['十'].reps, 1, '같은 회차에서 지우고 다시 쓴 것을 중복 기록했다');
});

t('시범 재생 중 쓰기·지우기·넘기기는 막고 끝나면 쓰던 획을 보존한다', () => {
  const h = harness(), a = h.app; h.open(); h.finishDemo(); h.click('trNext'); h.draw(cross[0]);
  const before = copy(a.TRACE.strokes); h.click('trAnim');
  a.traceNext(); h.click('trClear');
  h.node('#trCv').events.pointerdown({ isPrimary: true, clientX: 40, clientY: 40, preventDefault() { throw Error('시범 중 쓰기를 받았다'); } });
  assert.strictEqual(a.TRACE.step, 0); assert.deepStrictEqual(copy(a.TRACE.strokes), before);
  h.finishDemo(); assert.strictEqual(a.TRACE.done.length, 1); assert.strictEqual(h.saves, 0);
  h.draw(cross[1]); assert.strictEqual(a.db.trace['十'].reps, 1);
});

t('시범 중 취소 후 늦은 콜백과 이전 캔버스 입력은 새 화면을 바꾸지 않는다', () => {
  const h = harness(), a = h.app; h.open();
  const oldFrame = h.frames.values().next().value, oldCanvas = { ...h.node('#trCv').events };
  h.click('trQuit'); assert.strictEqual(a.TRACE, null); assert.strictEqual(h.returned, 1); assert.strictEqual(h.frames.size, 0);
  h.open('土'); const session = a.TRACE;
  oldFrame(9999);
  oldCanvas.pointerdown({ isPrimary: true, preventDefault() { throw Error('이전 캔버스 입력을 받았다'); } });
  oldCanvas.pointermove({ isPrimary: true }); oldCanvas.pointerup();
  assert.strictEqual(a.TRACE, session); assert.strictEqual(a.TRACE.mode, 'shape'); assert.strictEqual(h.saves, 0);
});

t('획순 자료가 없는 글자는 모양 연습이며 강제 넘김은 성공·학습 기록이 아니다', () => {
  const h = harness(), a = h.app; h.open('土');
  assert.strictEqual(a.TRACE.phase, 'write'); assert.strictEqual(h.frames.size, 0);
  assert.ok(/획순 자료 없음/.test(h.node('#trMode').innerHTML));
  assert.ok(h.node('#trAnim').hidden);
  for (let rep = 0; rep < 3; rep++) {
    a.TRACE.strokes = [points([[0.1, 0.1], [0.9, 0.1]])];
    h.click('trNext'); h.click('trNext');
    assert.ok(a.TRACE.judged.forced); assert.strictEqual(a.TRACE.judged.level, 'retry');
    a.traceRepDone(); assert.strictEqual(h.saves, 0);
    h.click('trNext');
  }
  assert.strictEqual(a.TRACE, null); assert.strictEqual(h.saves, 0);
  assert.strictEqual(Object.keys(a.db.states).length, 0);
  assert.ok(/완료로 세지 않은 연습 3회/.test(h.node('#trPanelWrap').innerHTML));
  assert.ok(/모양 연습은 획순을 확인한 결과가 아니/.test(h.node('#trPanelWrap').innerHTML));
});

t('모양을 성공적으로 쓴 회차는 모양 연습으로 한 번만 기록한다', () => {
  const h = harness(), a = h.app; h.open('土');
  a.TRACE.strokes = cross.map(points);
  h.click('trNext'); a.traceRepDone();
  assert.strictEqual(a.db.trace['土'].reps, 1); assert.strictEqual(h.saves, 1);
  assert.strictEqual(a.TRACE.completed.order, 0); assert.strictEqual(a.TRACE.completed.shape, 1);
  h.click('trNext'); assert.strictEqual(a.TRACE.cur.rep, 1);
  assert.strictEqual(h.saves, 1);
});

console.log('\nOK — ' + passed + '개 통과');
