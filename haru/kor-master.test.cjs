'use strict';
const assert = require('node:assert/strict');
const KM = require('./kor-master.js');
const DATA = require('./kor-master-data.json');
const ATOMS = require('./atoms.json');
const S = require('./strings.js');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const seeded = (s) => () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };

t('템플릿 5개가 atoms.json 원자를 가리킨다', () => {
  const ids = new Set(ATOMS.atoms.map(a => a.id));
  Object.keys(KM.TEMPLATES).forEach(id => assert.ok(ids.has(id), id));
});
t('200 시드 × 5 템플릿 — 선택지 4개 상이 · 정답 유일 · 오답 태깅 · 정답이 데이터와 일치', () => {
  const byWord = {}; DATA.wordBuild.forEach(w => { byWord[w.word] = w.kind; });
  const figOf = {}; DATA.figure.forEach(f => { figOf[f.line] = f.figure; });
  const rights = new Set(DATA.concord.map(c => c.right)), wrongs = new Set(DATA.concord.map(c => c.wrong));
  let made = 0;
  Object.keys(KM.TEMPLATES).forEach(id => {
    const rnd = seeded(KM.strHash(id) + 1);
    for (let i = 0; i < 200; i++) {
      const it = KM.generate(id, DATA, rnd); if (!it) continue; made++;
      const w = id + '#' + i + ' ' + it.instructionKo;
      assert.equal(it.choices.length, 4, w);
      assert.equal(new Set(it.choices.map(c => c.text)).size, 4, w + ' ' + it.choices.map(c => c.text).join('|'));
      const ans = it.choices.find(c => c.key === it.answerKey); assert.ok(ans, w);
      assert.ok(!('errKind' in ans), w);
      it.choices.filter(c => c.key !== it.answerKey).forEach(c => assert.ok(c.errKind || c.atomId, w + ' 오답 태깅'));
      if (it.tpl === 'word-build-odd') { const kinds = it.choices.map(c => byWord[c.text]); assert.equal(kinds.filter(k => k === byWord[ans.text]).length, 1, w); }
      if (it.tpl === 'word-build-kind') { const word = /'(.+?)'/.exec(it.instructionKo)[1]; assert.equal(ans.text, byWord[word], w); }
      if (it.tpl === 'figure-id') assert.equal(ans.text, figOf[it.stemKo], w);
      if (it.tpl === 'figure-same') { const line = /'(.+?)'/.exec(it.instructionKo)[1]; assert.equal(figOf[ans.text], figOf[line], w); it.choices.filter(c => c.key !== it.answerKey).forEach(c => assert.notEqual(figOf[c.text], figOf[line], w)); }
      if (it.tpl === 'concord-pick') { assert.ok(rights.has(ans.text), w); it.choices.filter(c => c.key !== it.answerKey).forEach(c => assert.ok(wrongs.has(c.text), w)); }
      if (it.tpl === 'poly-context') { assert.ok(it.stemKo && it.stemKo !== ans.text, w); }
      assert.deepEqual(S.findForbidden(it.instructionKo, 'student'), [], w);
    }
  });
  assert.ok(made >= 900, String(made));
  console.log('   생성 ' + made + '문항');
});
t('다의어 — 같은 뜻의 예문끼리 짝, 다른 뜻은 오답', () => {
  const rnd = seeded(5);
  for (let i = 0; i < 50; i++) {
    const it = KM.generate('k-poly', DATA, rnd);
    const word = /'(.+?)'/.exec(it.instructionKo)[1];
    const entry = DATA.poly.find(p => p.word === word);
    const senseOf = (ex) => entry.senses.findIndex(s => s.examples.includes(ex));
    const ans = it.choices.find(c => c.key === it.answerKey).text;
    assert.equal(senseOf(ans), senseOf(it.stemKo), it.stemKo + ' | ' + ans);
    it.choices.filter(c => c.key !== it.answerKey).forEach(c => assert.notEqual(senseOf(c.text), senseOf(it.stemKo), c.text));
  }
});
t('데이터 상태 표기 — 원장 검수 전 초안', () => { assert.ok(/검수/.test(DATA.status)); });
t('다의어 오답은 같은 낱말의 다른 뜻 예문에서만 나온다(뜻 3개여도 다른 낱말 예문을 섞지 않는다)', function () {
  var rnd = seeded(7);
  for (var i = 0; i < 60; i++) {
    var it = KM.generate('k-poly', DATA, rnd); if (!it) continue;
    var m = /'(.+?)'와\(과\)/.exec(it.instructionKo), w = DATA.poly.filter(function (x) { return x.word === m[1]; })[0];
    var all = w.senses.reduce(function (a, s) { return a.concat(s.examples); }, []);
    it.choices.forEach(function (c) { assert.ok(all.indexOf(c.text) >= 0, c.text); });
  }
});
console.log(n + ' tests passed');
