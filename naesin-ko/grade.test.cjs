'use strict';
/* WB 국어브레인 — 채점 모듈 검증 (node naesin-ko/grade.test.cjs)
   정본: 기획서 §5.3 채점 5모드 · §9.4 한국어 정규화 · §4.4 주석 복원 */
const assert = require('assert');
const G = require('./grade.js');
const EN = require('../naesin/grade.js');   // 영어 앱 — 조사 목록을 공유한다(§9.4)

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ✓ ' + name); }

console.log('WBKOGRADE');

/* ── 정규화(§9.4) ── */
t('띄어쓰기·문장부호는 무시한다', () => {
  assert.strictEqual(G.normalizeKo('은 유 법.'), '은유법');
  assert.strictEqual(G.normalizeKo('  자유시,  '), '자유시');
});
t('영어 normalizeEn과 달리 한글이 살아남는다', () => {
  assert.strictEqual(EN.normalizeEn('은유법'), '', '영어 정규화는 한글을 지운다 — 그래서 못 쓴다');
  assert.strictEqual(G.normalizeKo('은유법'), '은유법');
});
t('괄호 병기는 지워지고 양쪽 다 인정답이 된다', () => {
  assert.strictEqual(G.normalizeKo('화장(점액질)'), '화장');
  const acc = G.parseAccepted('화장(점액질)');
  assert.ok(acc.indexOf('화장') >= 0 && acc.indexOf('점액질') >= 0);
});
t('슬래시·또는로 묶인 복수 정답을 편다', () => {
  assert.deepStrictEqual(G.parseAccepted('자유시 / 서정시'), ['자유시', '서정시']);
  assert.deepStrictEqual(G.parseAccepted('반어 또는 반어법'), ['반어', '반어법']);
});
t('가운뎃점은 기본으로 나누지 않는다 — 시어 나열과 구별이 안 되므로', () => {
  assert.deepStrictEqual(G.parseAccepted('비린내·향기'), ['비린내·향기']);
  assert.deepStrictEqual(G.parseAccepted('비린내·향기', { splitDot: true }), ['비린내', '향기']);
});
t('조사 목록은 영어 앱과 같은 것을 쓴다', () => {
  assert.deepStrictEqual(G.JOSA, EN.JOSA, '두 앱의 조사 목록이 어긋나면 채점이 갈린다');
  assert.strictEqual(G.stripJosa('가족은'), '가족');
  assert.strictEqual(G.stripEnding('은유법이다'), '은유법', '서술격 조사는 국어 앱에서만 뗀다');
  assert.strictEqual(G.stripEnding('바다'), '바다', "한 글자 '다'는 떼지 않는다");
});

/* ── 단답 채점 ── */
t('끝 조사가 붙어도 단답은 인정한다', () => {
  assert.strictEqual(G.gradeAnswer('은유법을', '은유법').correct, true);
  assert.strictEqual(G.gradeAnswer('은유법이다', ['은유법']).correct, true);
});
t('다른 답은 틀린다', () => {
  assert.strictEqual(G.gradeAnswer('직유법', '은유법').correct, false);
});
t('빈 답은 틀린다', () => {
  assert.strictEqual(G.gradeAnswer('', '은유법').correct, false);
  assert.strictEqual(G.gradeAnswer('   ', '은유법').correct, false);
});
t('matched로 어느 표기가 인정됐는지 알려 준다', () => {
  assert.strictEqual(G.gradeAnswer('서정시', '자유시 / 서정시').matched, '서정시');
});
t('gradeBlanks는 칸별로 판정한다', () => {
  const r = G.gradeBlanks({ a: '자유시', b: '틀림' },
    [{ id: 'a', answers: ['자유시'] }, { id: 'b', answers: ['의자'] }]);
  assert.strictEqual(r.right, 1);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.allCorrect, false);
});

/* ── 문장 완결·조건(§1.4-5) ── */
t('종결 어미가 없으면 완결이 아니다', () => {
  assert.strictEqual(G.isComplete('역설, 그리움'), false, '핵심어 나열은 서술이 아니다');
  assert.strictEqual(G.isComplete('㉢에는 역설이 쓰여 그리움을 드러낸다.'), true);
});
t('두세 낱말짜리 답은 완결로 보지 않는다', () => {
  assert.strictEqual(G.isComplete('역설이다.'), false);
});
t('포함 조건은 빠진 어구를 알려 준다', () => {
  const r = G.checkConditions('편견을 버려야 한다.', [{ kind: 'include', value: ['편견', '존중'] }]);
  assert.strictEqual(r[0].pass, false);
  assert.ok(r[0].detail.indexOf('존중') >= 0);
});
t('문장 수 조건을 센다', () => {
  const one = G.checkConditions('한 문장이다.', [{ kind: 'sentences', value: 1 }]);
  assert.strictEqual(one[0].pass, true);
  const two = G.checkConditions('첫 문장이다. 둘째 문장이다.', [{ kind: 'sentences', value: 1 }]);
  assert.strictEqual(two[0].pass, false);
});
t('글자 수·어절 수 조건을 센다', () => {
  assert.strictEqual(G.checkConditions('짧다.', [{ kind: 'chars', value: [10, 20] }])[0].pass, false);
  assert.strictEqual(G.checkConditions('한 두 세', [{ kind: 'words', value: 3 }])[0].pass, true);
});
t('형식 조건은 물결로 자른 조각이 순서대로 있는지 본다', () => {
  const c = [{ kind: 'form', value: '~하여 운율을 형성하고 있다' }];
  assert.strictEqual(G.checkConditions('같은 말을 반복하여 운율을 형성하고 있다.', c)[0].pass, true);
  assert.strictEqual(G.checkConditions('운율이 느껴진다.', c)[0].pass, false);
});
t('인용 조건은 자동 판정하지 않고 사람 확인으로 넘긴다', () => {
  const r = G.checkConditions('아무 말', [{ kind: 'quote', value: '본문 인용' }]);
  assert.strictEqual(r[0].manual, true);
  assert.strictEqual(r[0].pass, true);
});

/* ── 서술형 루브릭 3층의 1층(§5.3) ── */
const ITEM = {
  totalPoints: 2,
  rubric: [
    { element: '표현 방법', keywords: ['역설'], acceptedVariants: ['역설법'], points: 1 },
    { element: '화자의 마음', keywords: ['그리움'], acceptedVariants: ['그리워하는 마음'], points: 1 }
  ],
  conditions: [{ kind: 'sentences', value: 1 }]
};
t('요소를 다 갖춘 완결 문장은 확정 통과', () => {
  const r = G.gradeRubric('㉢에는 역설이 쓰여 화자의 그리움을 드러낸다.', ITEM);
  assert.strictEqual(r.verdict, 'pass');
  assert.strictEqual(r.score, 2);
});
t('핵심어만 나열한 답은 통과하지 않는다 — 이 층의 존재 이유', () => {
  const r = G.gradeRubric('역설, 그리움', ITEM);
  assert.strictEqual(r.verdict, 'hold');
  assert.strictEqual(r.complete, false);
});
t('일부 요소만 있으면 보류', () => {
  const r = G.gradeRubric('㉢에는 역설이 쓰였다고 생각한다.', ITEM);
  assert.strictEqual(r.verdict, 'hold');
  assert.strictEqual(r.score, 1);
});
t('조건을 어기면 내용이 맞아도 미달 — 학교 채점 관행과 같다', () => {
  const r = G.gradeRubric('㉢에는 역설이 쓰였다. 그리움을 드러낸다.', ITEM);
  assert.strictEqual(r.verdict, 'fail');
  assert.ok(r.conditions[0].pass === false);
});
t('요소가 하나도 없으면 미달', () => {
  assert.strictEqual(G.gradeRubric('잘 모르겠다.', ITEM).verdict, 'fail');
  assert.strictEqual(G.gradeRubric('', ITEM).verdict, 'fail');
});
t('인정 변형도 요소로 센다', () => {
  const r = G.gradeRubric('㉢에는 역설법이 쓰여 그리워하는 마음을 드러낸다.', ITEM);
  assert.strictEqual(r.score, 2);
});
t('요소 안의 키워드는 하나만 맞아도 충족이다', () => {
  const item = { totalPoints: 1, rubric: [{ element: '깨달음', keywords: ['끝', '가 본 적'], points: 1 }] };
  assert.strictEqual(G.gradeRubric('골목의 끝까지 가 본 적이 없다는 것을 알았다.', item).score, 1);
});

/* ── 주석 복원(§4.4) ── */
const TARGETS = [
  { id: 'a', label: '㉠ 표현법', keywords: ['의인법', '온기'] },
  { id: 'b', label: '㉢ 의미', keywords: ['그리움'] },
  { id: 'c', label: '2연 내용', keywords: ['볕'] }
];
t('항목별 완성·부분·누락을 낸다', () => {
  const r = G.gradeRestore({ a: '의인법이 쓰여 온기를 준다', b: '그리움', c: '' }, TARGETS);
  assert.strictEqual(r.perTarget[0].status, 'full');
  assert.strictEqual(r.perTarget[1].status, 'full');
  assert.strictEqual(r.perTarget[2].status, 'missing');
  assert.strictEqual(r.full, 2);
});
t('일부 키워드만 있으면 부분', () => {
  const r = G.gradeRestore({ a: '의인법이다' }, [TARGETS[0]]);
  assert.strictEqual(r.perTarget[0].status, 'partial');
});
t('커버리지는 부분을 절반으로 센다', () => {
  const r = G.gradeRestore({ a: '의인법이다', b: '그리움', c: '볕' }, TARGETS);
  assert.strictEqual(r.coverage, (2 + 0.5) / 3);
});

/* ── 브레인덤프(§4.4) — 판정 없이 diff만 ── */
t('브레인덤프는 무엇을 안 썼는지만 표시한다', () => {
  const r = G.dumpDiff('의인법과 그리움에 대해 썼다', TARGETS);
  assert.strictEqual(r.present, 2);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.perTarget[2].present, false);
});

/* ── 키워드 매칭의 관대함 ── */
t('활용·조사가 붙어도 키워드를 찾는다', () => {
  assert.strictEqual(G.hasKeyword(G.normalizeKo('그리움이 커진다'), '그리움'), true);
  assert.strictEqual(G.hasKeyword(G.normalizeKo('그리워하는 마음'), '그리워하는 마음'), true);
});
t('아예 다른 말은 찾지 않는다', () => {
  assert.strictEqual(G.hasKeyword(G.normalizeKo('즐거움이 크다'), '그리움'), false);
});

console.log('\n' + passed + '개 검증 통과');
