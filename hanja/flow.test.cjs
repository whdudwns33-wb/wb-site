'use strict';
/* 학생 흐름 회귀 검사: 실제 inline 앱을 실행한다. 부팅의 통신만 빼고 필요한 closure를 노출한다.
   DOM은 id·문자열·클릭만 흉내 낸다. 화면 배치·캔버스 판정은 이 검사의 범위가 아니다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('./srs.js');
const Q = require('./quiz.js');
const B = require('./book-check.js');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const inline = html.split('/* APP:JS:START */')[1].split('/* APP:JS:END */')[0];
assert.strictEqual((inline.match(/^  boot\(\);$/gm) || []).length, 1, '앱 부팅 지점을 찾지 못했다');
const source = inline.replace(/^  boot\(\);$/m, `  globalThis.flow = {
    installBook, itemsOf, unitsOf, selectUnit, trainItems, trainStart, scoreAnswer, finishCheck,
    learnStart, learnPlant, learnDone, learnRender, renderTrain, renderChars, renderBooks, renderReport,
    curBookId, selectBook, render, trainMenu, sessionDomains, migrateIds, pendingIds, putCheck, lastCheck, LIB,
    setOpenBook(fn) { openBook = fn; },
    get db() { return db; }, get train() { return TRAIN; }, get learn() { return LEARN; },
    get trace() { return TRACE; }, set trace(value) { TRACE = value; }
  };`);
const copy = (x) => JSON.parse(JSON.stringify(x));
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

function harness() {
  const nodes = new Map(), storage = new Map(), cancelled = [], confirmation = { answer: true, count: 0 };
  function element(id) {
    let content = '';
    const children = [], listeners = {}, choices = [];
    const el = {
      dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, fn) { listeners[type] = fn; },
      click() { assert.ok(listeners.click, id + '에 클릭 동작이 없다'); listeners.click(); },
      change() { assert.ok(listeners.change); listeners.change(); },
      querySelectorAll(selector) { return selector === '.choice' ? choices : []; }, focus() {},
      get innerHTML() { return content; },
      set innerHTML(value) {
        children.splice(0).forEach((key) => nodes.delete(key));
        content = value;
        choices.splice(0);
        for (const match of value.matchAll(/class="choice[^"]*" data-i="(\d+)"/g)) {
          const choice = element(id + ':choice' + match[1]); choice.dataset.i = match[1]; choices.push(choice);
        }
        for (const match of value.matchAll(/\bid="([^"]+)"/g)) {
          const key = '#' + match[1]; children.push(key); nodes.set(key, element(key));
        }
      },
      insertAdjacentHTML(where, value) { assert.strictEqual(where, 'beforeend'); this.innerHTML += value; },
    };
    return el;
  }
  ['sheetBack', 'sheet', 'toast', 'streakChip', ...['home', 'books', 'curriculum', 'words', 'chars', 'train', 'report'].map((v) => 'view-' + v)]
    .forEach((id) => nodes.set('#' + id, element(id)));
  const tabs = Array.from(html.matchAll(/<button data-view="([^"]+)"/g), (match) => {
    const button = element('tab:' + match[1]); button.dataset.view = match[1]; return button;
  });
  const quiz = { ...Q };
  const sandbox = {
    WBHSRS: S, WBHQUIZ: quiz, WBBOOKCHECK: B,
    WBHBRIDGE: require('./bridge.js'), WBHTRACE: require('./trace.js'),
    document: { querySelector: (s) => nodes.get(s) || null, querySelectorAll: (s) => s === '.tabbar button' ? tabs : [], documentElement: {} },
    window: { addEventListener() {}, scrollTo() {} },
    getComputedStyle: () => ({ getPropertyValue: () => 'serif' }),
    localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    setTimeout() { return 0; }, clearTimeout() {},
    cancelAnimationFrame(id) { cancelled.push(id); },
    confirm() { confirmation.count += 1; return confirmation.answer; },
    fetch() { throw new Error('회귀 검사에서 통신하면 안 된다'); },
  };
  vm.runInNewContext(source, sandbox, { filename: 'hanja/index.html', timeout: 1000 });
  const app = sandbox.flow;
  /* 자체 생성 시험 자료: 실제 교재·학생 데이터가 아니다. */
  const chars = [
    { ch: '日', hun: '날', eum: '일', strokes: 4 }, { ch: '月', hun: '달', eum: '월', strokes: 4 },
    { ch: '山', hun: '메', eum: '산', strokes: 3 }, { ch: '水', hun: '물', eum: '수', strokes: 4 },
  ];
  const mixed = app.installBook({
    id: 'flow-mixed', title: '흐름 검사 어휘', source: 'own',
    units: [{ id: 'only-char', title: '보조 글자' }, { id: 'words', title: '낱말 단원' }],
    words: Array.from({ length: 24 }, (_, i) => ({ word: '테스트낱말' + (i + 1), meaning: '흐름 검사용 뜻 ' + (i + 1), unit: 'words' })),
    chars: chars.map((c) => ({ ...c, unit: 'words' })).concat({ ch: '木', hun: '나무', eum: '목', strokes: 4, unit: 'only-char' }),
  });
  const pure = app.installBook({
    id: 'flow-hanja', title: '흐름 검사 한자', source: 'own',
    units: [{ id: 'first', title: '첫 단원' }, { id: 'second', title: '둘째 단원' }], words: [],
    chars: chars.map((c, i) => ({ ...c, unit: i < 2 ? 'first' : 'second' })),
  });
  assert.ok(mixed && pure, '자체 시험 단어장을 설치하지 못했다');
  app.LIB.index = [mixed, pure].map(B.bookMeta);
  app.selectUnit(mixed, 'words');
  return { app, mixed, pure, nodes, quiz, cancelled, tabs, confirmation };
}

t('미학습 단원 시험은 낱말 24개 중 20개 — 명시한 한자도 어휘 점수에서 제외', () => {
  const { app, mixed } = harness();
  assert.deepStrictEqual(copy(app.unitsOf(mixed).map((u) => u.id)), ['words']);
  const items = app.itemsOf(mixed, 'words');
  assert.strictEqual(items.length, 24);
  assert.ok(items.every((it) => it.kind === 'word'));
  assert.strictEqual(Object.keys(app.db.states).length, 0);
  app.trainStart({ mode: 'check', book: mixed.id, unit: 'words' });
  const session = app.train;
  assert.strictEqual(session.list.length, 20);
  assert.strictEqual(session.scope.total, 24);
  assert.ok(session.list.every(({ item, q }) => item.kind === 'word' && ['w-meaning', 'w-word', 'w-cloze', 'w-type', 'w-syn'].includes(q.kind)));
  session.list.forEach((entry, i) => app.scoreAnswer(entry, i !== 0, i === 1));
  app.finishCheck(session);
  const result = app.lastCheck(mixed.id, 'words');
  assert.strictEqual(result.n, 20);
  assert.strictEqual(result.total, 24);
  assert.strictEqual(result.right, 19);
  assert.strictEqual(result.hinted, 1);
  assert.deepStrictEqual(copy(app.pendingIds(result)).sort(), copy(session.list.slice(0, 2).map(({ item }) => item.sid)).sort());
  Object.values(app.db.states).forEach((s) => {
    assert.strictEqual(s.step, 0); assert.strictEqual(s.reps, 0); assert.strictEqual(s.graduated, false);
  });
});

t('보조 한자 확인은 어휘 점수를 보존하고 한자 전용 교재는 자체 점수를 기록', () => {
  const { app, mixed, pure } = harness();
  app.putCheck(mixed.id, 'words', '낱말 단원', 20, 12, 24, 1, []);
  const original = copy(app.lastCheck(mixed.id, 'words'));
  app.trainStart({ mode: 'check', book: mixed.id, unit: 'words', chars: true });
  assert.ok(app.train.list.every(({ item }) => item.kind === 'char'));
  const entry = app.train.list[0];
  app.db.states[entry.item.sid] = { ...S.plant(entry.item.sid, 0), step: 3, reps: 4 };
  const state = copy(app.db.states[entry.item.sid]);
  app.scoreAnswer(entry, false, false);
  assert.deepStrictEqual(copy(app.db.states[entry.item.sid]), state, '시험 오답이 SRS를 바꿨다');
  assert.strictEqual(app.finishCheck(app.train), true);
  assert.deepStrictEqual(copy(app.lastCheck(mixed.id, 'words')), original);
  app.trainStart({ mode: 'check', book: pure.id, unit: null });
  assert.strictEqual(app.train.list.length, 4);
  app.train.list.forEach((cur) => app.scoreAnswer(cur, true, false));
  assert.strictEqual(app.finishCheck(app.train), false);
  assert.strictEqual(app.lastCheck(pure.id, null).right, 4);
});

t('오답 재확인은 원점수·SRS를 보존하고 힌트·실패·출제 불가 항목을 미해결로 남김', () => {
  const { app, mixed, quiz } = harness();
  const items = app.itemsOf(mixed, 'words').slice(0, 4), ids = items.map((it) => it.sid);
  items.forEach((it) => { app.db.states[it.sid] = { ...S.plant(it.sid, 0), step: 3, reps: 4 }; });
  const states = copy(app.db.states);
  app.putCheck(mixed.id, 'words', '낱말 단원', 20, 17, 24, 1, ids);
  const key = mixed.id + '|words', original = copy(app.lastCheck(mixed.id, 'words'));
  /* 문항 자료가 사라지는 경우를 한 항목에 한정한다. 나머지는 실제 출제 엔진으로 만든다. */
  quiz.makeQuestion = (it, ctx, opts) => it.sid === ids[3] ? null : Q.makeQuestion(it, ctx, opts);
  app.trainStart({ mode: 'retry', book: mixed.id, unit: 'words', ids, check: key });
  assert.strictEqual(app.train.skipped, 1);
  assert.strictEqual(app.train.list.length, 3);
  app.train.list.forEach((cur) => app.scoreAnswer(cur, cur.item.sid !== ids[2], cur.item.sid === ids[1]));
  app.finishCheck(app.train);
  const result = app.lastCheck(mixed.id, 'words');
  const { retry, ...first } = copy(result);
  assert.deepStrictEqual(first, original);
  assert.strictEqual(retry.total, 3);
  assert.strictEqual(retry.right, 1);
  assert.deepStrictEqual(copy(app.pendingIds(result)).sort(), copy(ids.slice(1)).sort());
  assert.deepStrictEqual(copy(app.db.states), states, '재확인이 SRS 단계나 복습 시각을 바꿨다');
});

t('이미 기록이 있는 낱말도 8개씩 다시 배우고 다음 묶음에서 빠지지 않는다', () => {
  const { app, mixed, nodes } = harness();
  app.itemsOf(mixed, 'words').forEach((it) => { app.db.states[it.sid] = { ...S.plant(it.sid, 0), step: 3, reps: 4 }; });
  const states = copy(app.db.states), seen = [];
  app.learnStart(mixed, 'words');
  [16, 8, 0].forEach((remaining) => {
    assert.ok(app.learn, '기존 기록 때문에 낱말 학습을 막았다');
    assert.strictEqual(app.learn.items.length, 8);
    assert.strictEqual(app.learn.remaining.length, remaining);
    app.learn.items.forEach((it) => { seen.push(it.sid); app.learnPlant(it, true); });
    app.learnDone(nodes.get('#view-train'));
    nodes.get('#lnMore').click();
  });
  assert.strictEqual(new Set(seen).size, 24);
  assert.strictEqual(app.train.scope.mode, 'check');
  assert.strictEqual(app.train.scope.total, 24);
  assert.deepStrictEqual(copy(app.db.states), states, '즉시 학습이 간격 복습 상태를 바꿨다');
});

t('캐시 교재를 바꿀 때 유효한 선택 단원만 유지하고 이전 교재 단원은 제거', () => {
  const { app, mixed, pure } = harness();
  assert.strictEqual(app.selectUnit(pure, 'words').id, 'first');
  assert.strictEqual(app.db.settings.book, pure.id);
  assert.strictEqual(app.selectUnit(pure, 'second').id, 'second');
  assert.strictEqual(app.db.settings.unit, 'second');
  assert.strictEqual(app.selectUnit(mixed, 'second').id, 'words');
  assert.strictEqual(app.db.settings.book, mixed.id);
  assert.strictEqual(app.db.settings.unit, 'words');
  assert.strictEqual(app.selectUnit(mixed, 'only-char').id, 'words', '어휘 교재에 보조 한자 단원을 골랐다');
});

t('도움 화면을 다녀와 문항을 다시 그려도 답변과 점수는 한 번만 기록', () => {
  const { app, mixed, nodes, quiz } = harness();
  quiz.makeQuestion = (it, ctx, opts) => Q.makeQuestion(it, ctx, { ...opts, kinds: ['w-type'] });
  app.trainStart({ mode: 'check', book: mixed.id, unit: 'words' });
  nodes.get('#qIn').value = app.train.list[0].q.answer;
  nodes.get('#qSubmit').click();
  const logs = app.db.log.length;
  assert.strictEqual(app.train.right, 1);
  app.renderTrain();
  assert.strictEqual(app.train.right, 1);
  assert.strictEqual(app.db.log.length, logs);
  assert.ok(nodes.get('#qNext'), '이미 답한 문항의 다음 버튼이 복원되지 않았다');
  nodes.get('#qIn').value = app.train.list[0].q.answer;
  nodes.get('#qSubmit').click();
  assert.strictEqual(app.train.right, 1);
  app.learnStart(mixed, 'words');
  nodes.get('#lnNext').click();
  nodes.get('#qIn').value = app.learn.q.answer;
  nodes.get('#qSubmit').click();
  const learningLogs = app.db.log.length;
  app.learnRender(nodes.get('#view-train'));
  assert.strictEqual(app.learn.ok, 1);
  assert.strictEqual(app.db.log.length, learningLogs);
  assert.ok(nodes.get('#lnContinue'));
  nodes.get('#lnContinue').click();
  assert.strictEqual(app.learn.q, null, '다음 낱말에 이전 문항이 남았다');
});

t('교재 id 재매핑은 학습 상태가 없어도 저장된 오답과 재확인 목록에 적용', () => {
  const { app, mixed } = harness();
  const from = S.wordId(mixed.id, 'old'), to = S.wordId(mixed.id, 'new');
  app.putCheck(mixed.id, 'words', '낱말 단원', 20, 18, 24, 0, [from, to]);
  const c = app.lastCheck(mixed.id, 'words');
  c.retry = { at: c.at, total: 2, right: 0, wrongIds: [from, to] };
  app.migrateIds(mixed.id, { old: 'new' });
  assert.deepStrictEqual(copy(c.wrongIds), [to]);
  assert.deepStrictEqual(copy(c.retry.wrongIds), [to]);
});

t('한자 집중 교재 선택과 복습은 어휘 교재·단원·기록을 섞지 않는다', () => {
  const { app, mixed, pure, nodes } = harness();
  const selected = [app.db.settings.book, app.db.settings.unit];
  const word = app.itemsOf(mixed, 'words')[0];
  app.db.states[word.sid] = S.plant(word.sid, 0);
  app.db.states['c:日'] = S.plant('c:日', 0, { book: pure.id });
  app.putCheck(mixed.id, 'words', '어휘 시험', 1, 0, 24, 0, [word.sid]);
  app.putCheck(pure.id, 'first', '한자 시험', 1, 0, 2, 0, ['c:日']);
  app.renderChars();
  assert.ok(nodes.get('#view-chars').innerHTML.includes('한자 집중 학습'));
  assert.ok(!nodes.get('#view-chars').innerHTML.includes('틀렸거나 도움받은 낱말 배우기'));
  nodes.get('#chBook').value = mixed.id; nodes.get('#chBook').change();
  assert.ok(nodes.get('#view-chars').innerHTML.includes('보조 글자'), '어휘 책의 한자 전용 단원이 사라졌다');
  assert.deepStrictEqual([app.db.settings.book, app.db.settings.unit], selected);
  assert.strictEqual(app.curBookId(), mixed.id);
  assert.deepStrictEqual(copy(app.trainItems({ mode: 'due' }).map((it) => it.sid)), [word.sid]);
  assert.deepStrictEqual(copy(app.trainItems({ mode: 'due', only: 'char' }).map((it) => it.sid)), ['c:日']);
  app.renderBooks();
  assert.ok(!nodes.get('#view-books').innerHTML.includes(pure.title), '어휘 교재 선택에 한자 전용 책이 섞였다');
  assert.ok(nodes.get('#view-books').innerHTML.includes('어휘 단원 1'), '교재의 어휘 단원 수에 한자 전용 단원을 더했다');
  app.renderReport();
  assert.ok(!nodes.get('#view-report').innerHTML.includes('한자 시험'), '어휘 시험 기록에 한자 시험이 섞였다');
});

t('뜻 확인 뒤 별도 상황을 풀고 해설을 보며 화면 복원에도 적용 기록은 한 번만 남긴다', () => {
  const { app, mixed, nodes } = harness();
  const word = mixed.words[0];
  word.context = { prompt: '새로운 상황에서 골라 보세요.', choices: ['알맞은 상황', '다른 상황'], answer: '알맞은 상황', explanation: '낱말의 뜻을 이 상황에 적용했어요.' };
  app.learnStart(mixed, 'words', 'word', { items: app.itemsOf(mixed, 'words').slice(0, 1) });
  nodes.get('#lnNext').click();
  let q = app.learn.q;
  nodes.get('#view-train').querySelectorAll('.choice')[q.choices.indexOf(q.answer)].click();
  assert.strictEqual(app.learn.ok, 1);
  assert.ok(nodes.get('#qFeed').innerHTML.includes('새로운 상황에 적용하기'));
  nodes.get('#lnContinue').click();
  q = app.learn.q;
  assert.strictEqual(q.kind, 'w-context');
  assert.strictEqual(app.learn.i, 0);
  nodes.get('#view-train').querySelectorAll('.choice')[q.choices.indexOf(q.answer)].click();
  assert.ok(nodes.get('#qFeed').innerHTML.includes(word.context.explanation));
  assert.strictEqual(app.learn.applied, 1);
  app.learnRender(nodes.get('#view-train'));
  assert.strictEqual(app.learn.applied, 1);
  assert.strictEqual(app.learn.contextN, 1);
  assert.strictEqual(app.db.log.filter((entry) => entry.k === 'apply').length, 1);
  nodes.get('#lnContinue').click();
  assert.ok(nodes.get('#view-train').innerHTML.includes('새로운 상황에 적용 1 / 1'));
});

t('한자 시범 중 교재를 바꾸면 패널을 지우기 전에 애니메이션을 취소한다', () => {
  const { app, mixed, nodes, cancelled } = harness();
  app.renderChars();
  app.trace = { anim: 77 };
  nodes.get('#chBook').value = mixed.id; nodes.get('#chBook').change();
  assert.strictEqual(app.trace, null);
  assert.deepStrictEqual(cancelled, [77]);
});

t('처음 보는 교재 시험도 뜻·상황·회상을 출제하고 영역별로 힌트 정답을 제외한다', () => {
  const { app, mixed } = harness();
  mixed.words.forEach((w) => { w.context = { prompt: w.word + ' 적용 상황', choices: ['상황 하나', '상황 둘'], answer: '상황 하나', explanation: '뜻에 맞는 상황입니다.' }; });
  app.trainStart({ mode: 'check', book: mixed.id, unit: 'words' });
  const session = app.train;
  assert.strictEqual(session.list.filter((e) => e.q.kind === 'w-context').length, 10);
  assert.strictEqual(session.list.filter((e) => e.q.kind === 'w-type').length, 5);
  session.list.forEach((entry, i) => app.scoreAnswer(entry, i !== 0, i === 1));
  app.finishCheck(session);
  const domains = copy(app.lastCheck(mixed.id, 'words').domains);
  assert.deepStrictEqual(domains, { meaning: { n: 5, right: 4 }, context: { n: 10, right: 9 }, recall: { n: 5, right: 5 } });
});

t('새 표본 시험은 이전 오답을 먼저 내고 미출제·출제 실패·힌트 오답도 20개를 넘어 보존', () => {
  const { app, mixed, quiz } = harness();
  const items = app.itemsOf(mixed, 'words'), ids = items.slice(0, 3).map((it) => it.sid);
  const missing = ['w:' + mixed.id + ':removed-a', 'w:' + mixed.id + ':removed-b'];
  items.slice(0, 3).forEach((it) => { app.db.states[it.sid] = S.plant(it.sid, 0); });
  app.putCheck(mixed.id, 'words', '낱말 단원', 5, 0, 24, 0, ids.concat(missing));
  const chosen = app.trainItems({ mode: 'check', book: mixed.id, unit: 'words' });
  assert.deepStrictEqual(copy(chosen.slice(0, 3).map((it) => it.sid)).sort(), copy(ids).sort());
  quiz.makeQuestion = (it, ctx, opts) => it.sid === ids[2] ? null : Q.makeQuestion(it, ctx, opts);
  app.trainStart({ mode: 'check', book: mixed.id, unit: 'words' });
  assert.strictEqual(app.train.skipped, 1);
  app.train.list.forEach((cur) => app.scoreAnswer(cur, ids.slice(0, 2).includes(cur.item.sid), cur.item.sid === ids[1]));
  app.finishCheck(app.train);
  let result = app.lastCheck(mixed.id, 'words');
  assert.strictEqual(result.n, 19);
  assert.strictEqual(result.right, 2);
  assert.strictEqual(result.hinted, 1);
  assert.strictEqual(app.pendingIds(result).length, 21, '이전 미해결 오답을 회차 20개 한도로 잘랐다');
  assert.ok(!app.pendingIds(result).includes(ids[0]), '혼자 맞힌 이전 오답을 해소하지 않았다');
  [ids[1], ids[2], ...missing].forEach((sid) => assert.ok(app.pendingIds(result).includes(sid), sid + ' 보충 기록이 사라졌다'));
  const pending = copy(app.pendingIds(result));
  app.trainStart({ mode: 'retry', book: mixed.id, unit: 'words', ids: pending, check: mixed.id + '|words' });
  app.train.list.forEach((cur) => app.scoreAnswer(cur, false, false));
  app.finishCheck(app.train);
  result = app.lastCheck(mixed.id, 'words');
  assert.deepStrictEqual(copy(app.pendingIds(result)), pending, '재확인이 20개 밖의 미해결 오답을 버렸다');
  assert.strictEqual(result.n, 19, '재확인이 원래 시험 점수를 덮었다');
});

t('시험을 탭 이동 뒤 이어 풀고 새 시험·학습으로 덮기와 그만두기는 확인받는다', () => {
  const { app, mixed, nodes, tabs, confirmation } = harness();
  app.trainStart({ mode: 'check', book: mixed.id, unit: 'words' });
  const session = app.train, q = session.list[0].q;
  nodes.get('#view-train').querySelectorAll('.choice')[q.choices.findIndex((value) => value !== q.answer)].click();
  assert.ok(nodes.get('#view-train').innerHTML.includes('낱말 단원'), '시험 범위의 단원명이 보이지 않는다');
  tabs.find((b) => b.dataset.view === 'home').click();
  tabs.find((b) => b.dataset.view === 'train').click();
  assert.strictEqual(app.train, session);
  assert.strictEqual(session.wrong.length, 1);
  assert.strictEqual(app.db.log.length, 1, '이어서 보기에서 답을 다시 채점했다');
  confirmation.answer = false;
  app.trainStart({ mode: 'check', book: mixed.id, unit: 'words' });
  app.learnStart(mixed, 'words');
  nodes.get('#studyQuit').click();
  assert.strictEqual(app.train, session, '취소했는데 진행하던 시험을 버렸다');
  assert.strictEqual(confirmation.count, 3);
  confirmation.answer = true;
  nodes.get('#studyQuit').click();
  assert.strictEqual(app.train, null);
  assert.strictEqual(app.learn, null);
  assert.strictEqual(app.lastCheck(mixed.id, 'words'), null, '미완료 시험을 완료로 저장했다');
  app.learnStart(mixed, 'words');
  const lesson = app.learn;
  nodes.get('#lnNext').click();
  tabs.find((b) => b.dataset.view === 'home').click();
  tabs.find((b) => b.dataset.view === 'train').click();
  assert.strictEqual(app.learn, lesson);
  nodes.get('#studyQuit').click();
  assert.strictEqual(app.learn, null);
});

async function checkCurriculumSelection() {
  const { app, mixed, nodes } = harness();
  const curriculum = app.installBook({ ...mixed, id: 'flow-curriculum', title: 'WB 교과 어휘 초3 수학', curriculum: { grade: '초3', subject: '수학' } });
  const older = app.installBook({ ...mixed, id: 'flow-legacy-curriculum', title: 'WB 교과 어휘 초등 4학년' });
  app.LIB.index.unshift(B.bookMeta(curriculum), B.bookMeta(older));
  app.db.settings.book = '';
  assert.strictEqual(app.curBookId(), mixed.id, '교과 책이 앞에 올라와도 첫 교재 시험을 차지하면 안 된다');
  app.selectUnit(mixed, 'words');
  app.render('curriculum');
  await app.selectBook(curriculum.id);
  t('교과 학습은 학년별로 고르며 기존 종이 교재·단원 선택을 유지한다', () => {
    assert.strictEqual(app.db.settings.book, mixed.id);
    assert.strictEqual(app.db.settings.unit, 'words');
    assert.strictEqual(app.db.settings.curriculumBook, curriculum.id);
    assert.strictEqual(app.db.settings.curriculumUnit, 'words');
    const content = nodes.get('#view-curriculum').innerHTML;
    assert.ok(content.includes('낱말 학습 시작'));
    assert.ok(content.includes('data-book="flow-curriculum"') && content.includes('data-book="flow-legacy-curriculum"'));
    assert.ok(!content.includes('data-book="flow-mixed"'));
    nodes.get('#bkGrade').value = '초3'; nodes.get('#bkGrade').change();
    assert.ok(nodes.get('#view-curriculum').innerHTML.includes('data-book="flow-curriculum"'));
    assert.ok(!nodes.get('#view-curriculum').innerHTML.includes('data-book="flow-legacy-curriculum"'));
    nodes.get('#bkGrade').value = '초4'; nodes.get('#bkGrade').change();
    assert.ok(nodes.get('#view-curriculum').innerHTML.includes('data-book="flow-legacy-curriculum"'), '기존 교과 책 제목의 학년을 필터에서 놓쳤다');
    app.render('books');
    assert.strictEqual(nodes.get('#view-curriculum').innerHTML, '', '숨겨진 교과 폼의 중복 id가 남았다');
    assert.ok(nodes.get('#view-books').innerHTML.includes('data-book="flow-mixed"'));
    assert.ok(!nodes.get('#view-books').innerHTML.includes('data-book="flow-curriculum"'));
    app.render('train');
    assert.ok(!nodes.get('#view-train').innerHTML.includes('value="flow-curriculum"'));
    app.LIB.task = { bookId: curriculum.id, unitId: 'words' };
    app.render('home'); nodes.get('#tkPick').click();
    assert.ok(nodes.get('#view-curriculum').innerHTML.includes('data-book="flow-curriculum"'), '이전 학년 필터가 선생님 지정 교재를 숨겼다');
    assert.ok(nodes.get('#view-curriculum').innerHTML.includes('낱말 학습 시작'));
  });
}

async function checkBookSwitches() {
  const { app, mixed, nodes } = harness();
  mixed.units.push({ id: 'second-word', title: '둘째 낱말 단원' });
  mixed.words[23].unit = 'second-word';
  let complete;
  const cachedLoad = new Promise((resolve) => { complete = resolve; });
  app.setOpenBook(() => cachedLoad);
  const selecting = app.selectBook(mixed.id);
  app.selectUnit(mixed, 'second-word');
  complete(mixed);
  await selecting;
  t('캐시 교재 갱신 응답은 기다리는 동안 학생이 고른 단원을 덮지 않는다', () => {
    assert.strictEqual(app.db.settings.unit, 'second-word');
  });

  const next = app.installBook({ ...mixed, id: 'flow-next', title: '다음 종이 교재' });
  app.LIB.index.push(B.bookMeta(next));
  delete app.LIB.books[next.id];
  const uncachedLoad = new Promise((resolve) => { complete = resolve; });
  app.setOpenBook(() => uncachedLoad);
  app.render('train');
  const oldExam = nodes.get('#tmCk'), oldLearn = nodes.get('#tmCkLearn');
  nodes.get('#tmCkUnit').value = 'second-word';
  nodes.get('#tmCkBook').value = next.id;
  nodes.get('#tmCkBook').change();
  t('캐시 없는 교재를 받는 동안 이전 교재 시험·학습을 시작할 수 없다', () => {
    assert.ok(!nodes.has('#tmCk') && !nodes.has('#tmCkLearn'));
    assert.ok(nodes.get('#view-train').innerHTML.includes('value="flow-next" selected'));
    oldExam.click(); oldLearn.click();
    assert.strictEqual(app.train, null);
    assert.strictEqual(app.learn, null);
  });
  app.LIB.books[next.id] = next;
  complete(next);
  await uncachedLoad;
  t('교재 수신 뒤 새 교재의 단원 시험을 바로 시작한다', () => {
    nodes.get('#tmCkUnit').value = app.db.settings.unit;
    nodes.get('#tmCk').click();
    assert.strictEqual(app.train.scope.book, next.id);
    assert.strictEqual(app.train.scope.unit, 'words');
  });

  const rapid = harness(), loads = new Map();
  rapid.mixed.units.push({ id: 'second-word', title: '둘째 낱말 단원' });
  rapid.mixed.words[23].unit = 'second-word';
  const other = rapid.app.installBook({ ...rapid.mixed, id: 'flow-other', title: '다른 종이 교재' });
  rapid.app.LIB.index.push(B.bookMeta(other));
  rapid.app.setOpenBook((id) => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    loads.set(id, { promise, resolve });
    return promise;
  });
  rapid.app.render('train');
  rapid.nodes.get('#tmCkBook').value = other.id; rapid.nodes.get('#tmCkBook').change();
  rapid.nodes.get('#tmCkBook').value = rapid.mixed.id; rapid.nodes.get('#tmCkBook').change();
  rapid.nodes.get('#tmCkUnit').value = 'second-word'; rapid.nodes.get('#tmCkUnit').change();
  loads.get(other.id).resolve(other);
  await loads.get(other.id).promise;
  loads.get(rapid.mixed.id).resolve(rapid.mixed);
  await loads.get(rapid.mixed.id).promise;
  t('교재를 빠르게 두 번 바꿔도 늦은 응답은 마지막 교재·단원 선택을 유지한다', () => {
    assert.strictEqual(rapid.app.db.settings.book, rapid.mixed.id);
    assert.strictEqual(rapid.app.db.settings.unit, 'second-word');
    rapid.nodes.get('#tmCkUnit').value = 'second-word'; rapid.nodes.get('#tmCk').click();
    assert.strictEqual(rapid.app.train.scope.book, rapid.mixed.id);
    assert.strictEqual(rapid.app.train.scope.unit, 'second-word');
  });
}

/* 새 기기의 교재 미리 받기는 통신 대신 실제 함수의 요청 대상만 기록한다. */
const preloadSource = inline.slice(inline.indexOf('  async function fetchDueBooks()'), inline.indexOf('  /* 진로독서 어휘장 →'));
const requested = [];
Promise.all([checkBookSwitches(), checkCurriculumSelection(), vm.runInNewContext(preloadSource + '\nfetchDueBooks()', {
  WBHSRS: S, now: () => 86400000, db: { states: {
    word: S.plant('w:word-book:w1', 0, { book: 'word-book' }),
    char: S.plant('c:日', 0, { book: 'char-book' }),
    missing: S.plant('c:月', 0, { book: 'inaccessible' }),
  } },
  LIB: { index: [{ id: 'word-book' }, { id: 'char-book' }] }, bookOf: () => null,
  openBook: async (id) => { requested.push(id); },
})]).then(() => {
  t('새 기기는 만기 낱말·한자의 교재를 모두 미리 받고 접근할 수 없는 교재는 요청하지 않는다', () => {
    assert.deepStrictEqual(requested.sort(), ['char-book', 'word-book']);
  });
  console.log(`\nOK — ${passed}개 통과`);
}).catch((e) => { console.error(e); process.exitCode = 1; });
