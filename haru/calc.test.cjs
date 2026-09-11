'use strict';
/* 생성기 검증 — 정답 유일성(값 기준) · 선택지 4개 상이 · 오답 태깅 · 렌더 가능 문자만 · 시드 재현 · 값 재계산 */
const assert = require('node:assert/strict');
const C = require('./calc.js');
const ATOMS = require('./atoms.json');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const IDS = Object.keys(C.TEMPLATES);
const sum = a => a.reduce((s, v) => s + v, 0);
const recompute = (it) => {
  const p = it.params;
  switch (it.tpl) {
    case 'frac-addsub': return p.plus ? p.nA / p.dA + p.nB / p.dB : p.nA / p.dA - p.nB / p.dB;
    case 'frac-mul': return (p.n1 / p.d1) * (p.n2 / p.d2);
    case 'frac-div': return p.n / (p.d * p.k);
    case 'convert': return p.mode === 'pct' ? p.n / p.d * 100 : p.n / p.d;
    case 'pct-apply': return p.up ? p.base * (1 + p.p / 100) : p.base * (1 - p.p / 100);
    case 'pct-inverse': return p.part * 100 / p.p;
    case 'pct-chain': return p.base * (1 - p.p1 / 100) * (1 - p.p2 / 100);
    case 'ratio-base': return p.a / p.b * 100;
    case 'unit': return p.toSmall ? p.n * p.f : p.n / p.f;
    case 'dec-remainder': return Math.round((p.dv - Math.floor(p.dv * 10 / p.k) / 10 * p.k) * 100) / 100;
    case 'dec-div': return p.dividend / p.k;
    case 'gcd-lcm': return p.wantG ? C.gcd(p.a, p.b) : C.lcm(p.a, p.b);
    case 'avg-inverse': return p.avg * p.n - sum(p.known);
    case 'prism': return { 면: p.isPrism ? p.n + 2 : p.n + 1, 모서리: p.isPrism ? 3 * p.n : 2 * p.n, 꼭짓점: p.isPrism ? 2 * p.n : p.n + 1 }[p.what];
    case 'surface-volume': return p.wantS ? 2 * (p.a * p.b + p.b * p.c + p.c * p.a) : p.a * p.b * p.c;
  }
  throw new Error('unknown tpl ' + it.tpl);
};

t('템플릿 16개 전부 atoms.json 의 원자를 가리킨다', () => {
  const ids = new Set(ATOMS.atoms.map(a => a.id));
  IDS.forEach(id => assert.ok(ids.has(id), id));
  IDS.forEach(id => assert.ok(ATOMS.atoms.find(a => a.id === id).gen.includes('calc'), id + ' gen 에 calc'));
});
t('150 시드 × 16 템플릿 — 선택지 4개 상이 · 정답 유일 · 값 재계산 일치 · 오답 태깅 · 렌더 가능 문자', () => {
  const bad = /[\\^$_{}]|\\frac|<[a-z]/;
  let count = 0;
  IDS.forEach(id => {
    const rnd = C.seeded(C.strHash(id) + 3);
    for (let i = 0; i < 150; i++) {
      const it = C.generate(id, rnd); count++;
      const w = id + '#' + i + ' ' + it.instructionKo;
      assert.equal(it.choices.length, 4, w + ' 선택지 수');
      assert.equal(new Set(it.choices.map(c => c.text)).size, 4, w + ' 텍스트 중복: ' + it.choices.map(c => c.text).join('|'));
      const ans = it.choices.find(c => c.key === it.answerKey);
      assert.ok(ans, w + ' answerKey');
      assert.ok(!('atomId' in ans) && !('errKind' in ans), w + ' 정답에 태그');
      assert.ok(it.choices.filter(c => c.key !== it.answerKey).some(c => c.atomId || c.errKind), w + ' 오답 태깅 없음');
      assert.ok(Math.abs(recompute(it) - it.answerValue) < 1e-6, w + ' 값 ' + it.answerValue + ' vs ' + recompute(it));
      assert.ok(!bad.test(it.instructionKo + it.choices.map(c => c.text).join('') + it.explanationKo), w + ' 렌더 불가 문자');
      assert.ok(it.itemId.startsWith('calc:'), w + ' itemId');
    }
  });
  console.log('   생성 ' + count + '문항');
});
t('같은 시드 → 같은 문항 (재현)', () => {
  const a = C.generate('m-pct-inverse', C.seeded(42)), b = C.generate('m-pct-inverse', C.seeded(42));
  assert.deepEqual(a, b);
  assert.notDeepEqual(C.generate('m-pct-inverse', C.seeded(43)).instructionKo, a.instructionKo);
});
t('나머지는 0 이 아니고 나뉘는 수와 같은 자리(소수 첫째)', () => {
  const rnd = C.seeded(9);
  for (let i = 0; i < 100; i++) { const it = C.generate('m-dec-remainder', rnd); assert.ok(it.answerValue > 0 && it.answerValue < it.params.k * 0.1, it.instructionKo); assert.equal(Math.round(it.params.dv * 10) / 10, it.params.dv); }
});
t('분수 표기 — 기약·대분수, 같은 값의 다른 표기가 선택지에 둘 없다', () => {
  assert.equal(C.fmtFrac({ n: 6, d: 8 }), '3/4');
  assert.equal(C.fmtFrac({ n: 7, d: 4 }), '1 3/4');
  assert.equal(C.fmtFrac({ n: 4, d: 2 }), '2');
  const rnd = C.seeded(5);
  for (let i = 0; i < 100; i++) { const it = C.generate('n-frac-basic', rnd); const vals = it.choices.map(c => { const m = /^(\d+) (\d+)\/(\d+)$|^(\d+)\/(\d+)$|^(\d+)$/.exec(c.text); assert.ok(m, c.text); return m[1] ? +m[1] + m[2] / m[3] : m[4] ? m[4] / m[5] : +m[6]; }); assert.equal(new Set(vals.map(v => Math.round(v * 1e6))).size, 4, it.choices.map(c => c.text).join('|')); }
});
t('원장 검수 표본 30장', () => {
  const sheet = C.sampleSheet('m-ratio-base', 30, 1);
  assert.equal(sheet.length, 30);
  assert.ok(new Set(sheet.map(s => s.instructionKo)).size >= 20, '표본이 너무 겹친다');
});
t('개념 혼동 오답은 다른 원자를 가리킨다 (③ 판정의 관측 근거)', () => {
  const rnd = C.seeded(3); let tagged = 0;
  for (let i = 0; i < 50; i++) { const it = C.generate('m-ratio-base', rnd); if (it.choices.some(c => c.atomId === 'm-pct-inverse')) tagged++; }
  assert.ok(tagged >= 40, String(tagged));
});
console.log(n + ' tests passed');
