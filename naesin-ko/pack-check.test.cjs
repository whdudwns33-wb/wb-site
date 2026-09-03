'use strict';
/* WB 국어브레인 — 팩 검증 규칙 검증 (node naesin-ko/pack-check.test.cjs)
   정본: 기획서 §7[3] 자동 검증 · §8 데이터 모델. pack-check.js가 스키마의 실행 가능한 정의다. */
const assert = require('assert');
const C = require('./pack-check.js');
const sample = require('./pack-sample.json');
const dict = require('./concepts.json');

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ✓ ' + name); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const hasErr = (r, frag) => r.errors.some((e) => e.indexOf(frag) >= 0);
const hasWarn = (r, frag) => r.warns.some((e) => e.indexOf(frag) >= 0);

console.log('WBKOCHECK');

t('체험 팩은 오류·경고 없이 통과한다', () => {
  const r = C.checkPack(sample, { concepts: dict });
  assert.strictEqual(r.ok, true, r.errors.join(' / '));
  assert.deepStrictEqual(r.warns, []);
});

t('packId 형식을 지킨다', () => {
  const p = clone(sample); p.packId = '짧';
  assert.ok(hasErr(C.checkPack(p), 'packId'));
});

t('counts 선언과 실제가 다르면 오류 — 추출 누락의 첫 방어선', () => {
  const p = clone(sample); p.counts.blanks = 99;
  assert.ok(hasErr(C.checkPack(p), 'counts.blanks'));
});

t('빈칸 id가 중복이면 오류 — 상태 키가 겹친다', () => {
  const p = clone(sample); p.works[0].blanks[1].id = p.works[0].blanks[0].id;
  assert.ok(hasErr(C.checkPack(p), '빈칸 id 중복'));
});

t('빈칸 정답이 비면 오류', () => {
  const p = clone(sample); p.works[0].blanks[0].answers = [];
  assert.ok(hasErr(C.checkPack(p), 'answers가 비었'));
});

t('같은 핵심어 빈칸 중복은 병합 경고(§2.2-2)', () => {
  const p = clone(sample);
  const b = clone(p.works[0].blanks[0]); b.id = 'bl-dup';
  p.works[0].blanks.push(b); p.counts.blanks += 1;
  assert.ok(hasWarn(C.checkPack(p), '병합 대상'));
});

t('정본 보유 작품에 빈칸이 없으면 오류 — 2·4단계가 성립하지 않는다', () => {
  const p = clone(sample); p.works[0].blanks = []; p.counts.blanks = 0;
  assert.ok(hasErr(C.checkPack(p), 'blanks가 없어요'));
});

t('기호 앵커가 본문에 없으면 오류 — 하이라이트가 깨진다', () => {
  const p = clone(sample); p.works[0].marks[0].anchorText = '본문에 없는 구절';
  assert.ok(hasErr(C.checkPack(p), 'anchorText가 본문에 없어요'));
});

t('표현법에 근거 구절이 없으면 오류 — 적용 문항의 원천', () => {
  const p = clone(sample); delete p.works[0].rhetoric[0].quote;
  assert.ok(hasErr(C.checkPack(p), 'quote(근거 구절) 없음'));
});

t('발췌 세트에 본문이 없으면 오류(§2.2-5)', () => {
  const p = clone(sample); delete p.sets[1].works[0].text;
  assert.ok(hasErr(C.checkPack(p), '발췌 세트인데 text가 없어요'));
});

t('없는 작품·세트를 참조하면 오류', () => {
  const p1 = clone(sample); p1.sets[0].works[0].workId = 'w-없음';
  assert.ok(hasErr(C.checkPack(p1), '없는 workId'));
  const p2 = clone(sample); p2.items[0].setId = 's-없음';
  assert.ok(hasErr(C.checkPack(p2), '없는 setId'));
});

t('객관식 정답이 선지 범위를 벗어나면 오류', () => {
  const p = clone(sample); p.items[0].answer = 9;
  assert.ok(hasErr(C.checkPack(p), 'answer가 선지 범위'));
});

t('선지별 해설이 빠지면 경고 — 오답 피드백의 재료(§5.2)', () => {
  const p = clone(sample); delete p.items[0].explanation.perChoice['3'];
  assert.ok(hasWarn(C.checkPack(p), '선지별 해설 누락'));
});

t('서술형에 루브릭이 없으면 오류 — 검수에서 저작해야 한다(§7[3])', () => {
  const p = clone(sample); p.items[1].rubric = [];
  const r = C.checkPack(p);
  assert.ok(hasErr(r, 'rubric이 없어요'));
  assert.ok(r.summary.some((s) => s.indexOf('루브릭 미저작') >= 0), '요약에 개수가 뜬다');
});

t('루브릭 배점 합과 totalPoints가 어긋나면 오류', () => {
  const p = clone(sample); p.items[1].totalPoints = 5;
  assert.ok(hasErr(C.checkPack(p), '요소 배점 합'));
});

t('알 수 없는 조건 kind는 오류', () => {
  const p = clone(sample); p.items[1].conditions[0].kind = '이상한조건';
  assert.ok(hasErr(C.checkPack(p), '알 수 없는 kind'));
});

t('없는 빈칸을 targetRefs로 가리키면 오류', () => {
  const p = clone(sample); p.items[0].targetRefs = ['b-없는빈칸'];
  assert.ok(hasErr(C.checkPack(p), '없는 빈칸 id'));
});

t('정본 있는 작품의 문항에 targetRefs가 없으면 경고(§5.4)', () => {
  const p = clone(sample); p.items[0].targetRefs = [];
  assert.ok(hasWarn(C.checkPack(p), 'targetRefs가 비었'));
});

t('사전에 없는 conceptId를 참조하면 오류', () => {
  const p = clone(sample); p.works[0].rhetoric[0].conceptId = 'c-없는개념';
  assert.ok(hasErr(C.checkPack(p, { concepts: dict }), '사전에 없는 conceptId'));
});

t('메타가 비면 오류가 아니라 경고다 — 자료에 인쇄돼 있지 않을 수 있다(§2.2-7)', () => {
  const p = clone(sample); p.revision = ''; p.publisher = '';
  const r = C.checkPack(p);
  assert.strictEqual(r.ok, true);
  assert.ok(hasWarn(r, 'revision'));
  assert.ok(hasWarn(r, 'publisher'));
});

t('assemble은 분리 파일을 하나로 합치고 counts를 다시 센다', () => {
  const meta = { packId: 'x-y-z', publisher: '체험' };
  const w1 = { work: clone(sample.works[0]) };
  const w2 = { work: clone(sample.works[1]) };
  const sets = { sets: clone(sample.sets) };
  const items = { items: clone(sample.items) };
  const { pack } = C.assemble([
    { name: 'meta.json', json: meta }, { name: 'w1.json', json: w1 },
    { name: 'w2.json', json: w2 }, { name: 'sets.json', json: sets }, { name: 'items.json', json: items }
  ]);
  assert.strictEqual(pack.packId, 'x-y-z');
  assert.strictEqual(pack.works.length, 2);
  assert.strictEqual(pack.counts.blanks, 12);
  assert.strictEqual(pack.counts.items, 5);
});

t('assemble 결과도 같은 규칙으로 검증된다', () => {
  const { pack } = C.assemble([
    { name: 'meta.json', json: { packId: sample.packId, source: sample.source, revision: '데모', publisher: '체험', grade: '중2', unit: '0. 체험 단원' } },
    { name: 'w1.json', json: { work: clone(sample.works[0]) } },
    { name: 'w2.json', json: { work: clone(sample.works[1]) } },
    { name: 'sets.json', json: { sets: clone(sample.sets) } },
    { name: 'items.json', json: { items: clone(sample.items) } }
  ]);
  const r = C.checkPack(pack, { concepts: dict });
  assert.strictEqual(r.ok, true, r.errors.join(' / '));
});

console.log('\n' + passed + '개 검증 통과');
