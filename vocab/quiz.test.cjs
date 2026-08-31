'use strict';
/* 문제 출제 엔진 검증 (node vocab/quiz.test.cjs) */
const assert = require('assert');
const Q = require('./quiz.js');
const { WB_WORDS } = require('./words.js');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const byId = {}; WB_WORDS.forEach(w => { byId[w.id] = w; });
const seeded = (s) => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

t('모든 시드 단어가 문항 생성에 성공한다 (3단계 전부)', () => {
  WB_WORDS.forEach((w) => {
    for (let step = 0; step < 3; step++) {
      const q = Q.makeQuestion(w, WB_WORDS, step, seeded(step + 7));
      assert.ok(q, w.id + ' step' + step + ' 문항 생성 실패');
      assert.strictEqual(q.id, w.id);
      if (!q.input) {
        assert.ok(q.choices.length === 4, w.id + ' 보기 4개 아님: ' + q.choices.length);
        assert.ok(q.choices.includes(q.answer), w.id + ' 정답이 보기에 없음');
        assert.strictEqual(new Set(q.choices).size, 4, w.id + ' 보기 중복');
      }
    }
  });
});

t('어종별로 계획된 유형이 나온다', () => {
  const kinds = { hanja: new Set(), english: new Set(), native: new Set() };
  WB_WORDS.forEach((w) => {
    for (let step = 0; step < 3; step++) {
      const q = Q.makeQuestion(w, WB_WORDS, step, seeded(step * 13 + 3));
      kinds[w.type].add(q.kind);
    }
  });
  assert.ok(kinds.hanja.has('assemble'), '한자어에 조립 문항');
  assert.ok(kinds.english.has('spell'), '영어에 철자 문항');
  assert.ok(kinds.english.has('listen'), '영어에 듣기 문항');
  assert.ok(kinds.native.has('cloze') || kinds.native.has('syn'), '고유어에 빈칸/유의어 문항');
});

t('오답 보기는 정답과 겹치지 않고 같은 어종에서 나온다', () => {
  const w = byId['h-gwancheuk'];
  const q = Q._q.qMeaning4(w, WB_WORDS.filter(x => x.type === 'hanja'), seeded(5));
  assert.strictEqual(q.answer, w.meaning);
  const meanings = new Set(WB_WORDS.filter(x => x.type === 'hanja').map(x => x.meaning));
  q.choices.forEach(c => assert.ok(meanings.has(c), '보기가 한자어 뜻이 아님: ' + c));
});

t('예문 빈칸 — 활용형도 가려진다', () => {
  assert.strictEqual(
    Q.blankExample({ word: '가늠하다', example: '하늘빛을 보고 비가 올지 가늠해 보았다.' }),
    '하늘빛을 보고 비가 올지 ○○○ 보았다.');
  assert.strictEqual(
    Q.blankExample({ word: '갈무리', example: '오늘 배운 내용을 공책에 갈무리했다.' }),
    '오늘 배운 내용을 공책에 ○○○.');
  assert.strictEqual(Q.blankExample({ word: 'x', example: '없는 단어입니다.' }), null);
  assert.strictEqual(Q.blankExample({ word: 'x' }), null);
});

t('한자 조립 — 한 글자를 가리고 훈음을 묻는다', () => {
  const q = Q._q.qAssemble(byId['h-gwancheuk'], WB_WORDS.filter(x => x.type === 'hanja'), seeded(2));
  assert.strictEqual(q.kind, 'assemble');
  assert.ok(q.prompt.includes('\u25a1'), '가려진 글자 표시');
  // 마스크를 '?'로 쓰면 문장 끝 물음표와 겹쳐 무엇을 묻는지 읽히지 않는다
  assert.strictEqual((q.prompt.match(/\?/g) || []).length, 1, '물음표는 문장 끝 하나뿐: ' + q.prompt);
  assert.ok(['볼 관', '잴 측'].includes(q.answer), '정답이 훈음: ' + q.answer);
  assert.strictEqual(q.choices.length, 4);
});

t('철자 입력 — 첫 글자 힌트, 대소문자·공백 무시 채점', () => {
  const q = Q._q.qSpell(byId['e-observe']);
  assert.strictEqual(q.input, true);
  assert.ok(q.hint.startsWith('o'), '첫 글자 힌트');
  assert.ok(Q.check(q, 'observe'));
  assert.ok(Q.check(q, '  OBSERVE '));
  assert.ok(!Q.check(q, 'observ'));
});

t('선택형 채점 — 정확히 일치할 때만 정답', () => {
  const q = Q._q.qMeaning4(byId['n-ganeum'], WB_WORDS.filter(x => x.type === 'native'), seeded(9));
  assert.ok(Q.check(q, q.answer));
  assert.ok(!Q.check(q, q.choices.find(c => c !== q.answer)));
});

t('등급 — 첫 시도 정답 good / 재시도·힌트 hard / 오답 fail', () => {
  assert.strictEqual(Q.grade(true, 1, false), 'good');
  assert.strictEqual(Q.grade(true, 2, false), 'hard');
  assert.strictEqual(Q.grade(true, 1, true), 'hard');
  assert.strictEqual(Q.grade(false, 1, false), 'fail');
  assert.strictEqual(Q.grade(false, 3, true), 'fail');
});

t('풀이 후보가 적어도 문항이 만들어진다 (진로독서 단어 1개만 있을 때)', () => {
  const lone = { id: 'rd-x', type: 'hanja', word: '분석', meaning: '자세히 살펴봄', hanja: '分析',
    parts: [{ ch: '分', hun: '나눌', eum: '분' }, { ch: '析', hun: '가를', eum: '석' }] };
  const q = Q.makeQuestion(lone, [lone].concat(WB_WORDS), 0, seeded(11));
  assert.ok(q, '혼합 풀에서 문항 생성');
  assert.strictEqual(q.id, 'rd-x');
});

t('문맥 빈칸 오답은 정답과 같은 꼴이다', () => {
  /* 정답만 명사이고 오답이 모두 '~다'이면 낱말을 몰라도 문법으로 답이 보인다.
     "회오리바람에 ○○○ 날아갔어요"에 눈부시다·미덥다·가득하다를 놓으면 문제가 성립하지 않는다. */
  const nouns = [
    { id: 'n1', type: 'native', word: '나뭇잎', meaning: '나무에 달린 잎', example: '회오리바람에 나뭇잎이 날아갔어요.' },
    { id: 'n2', type: 'native', word: '초원', meaning: '넓은 들판' },
    { id: 'n3', type: 'native', word: '응달', meaning: '그늘진 곳' },
    { id: 'n4', type: 'native', word: '뙤약볕', meaning: '강한 햇볕' },
  ];
  const verbs = [
    { id: 'v1', type: 'native', word: '눈부시다', meaning: '빛이 세다' },
    { id: 'v2', type: 'native', word: '미덥다', meaning: '믿음직하다' },
    { id: 'v3', type: 'native', word: '가득하다', meaning: '꽉 차다' },
  ];
  for (let seed = 1; seed <= 20; seed += 1) {
    const q = Q._q.qCloze(nouns[0], nouns.concat(verbs), seeded(seed));
    assert.ok(q, '문항이 만들어져야 한다');
    const bad = q.choices.filter((c) => /다$/.test(c));
    assert.deepStrictEqual(bad, [], '명사 정답에 용언 오답이 섞였다: ' + q.choices.join(', '));
  }
});

t('용언이 정답이면 오답도 용언이다', () => {
  const target = { id: 'v0', type: 'native', word: '속삭이다', meaning: '작게 말하다', example: '비밀 이야기를 속삭였어요.' };
  const pool = [target,
    { id: 'v1', type: 'native', word: '눈부시다', meaning: '빛이 세다' },
    { id: 'v2', type: 'native', word: '미덥다', meaning: '믿음직하다' },
    { id: 'v3', type: 'native', word: '가득하다', meaning: '꽉 차다' },
    { id: 'n1', type: 'native', word: '초원', meaning: '넓은 들판' },
    { id: 'n2', type: 'native', word: '응달', meaning: '그늘진 곳' },
    { id: 'n3', type: 'native', word: '뙤약볕', meaning: '강한 햇볕' },
  ];
  for (let seed = 1; seed <= 20; seed += 1) {
    const q = Q._q.qCloze(target, pool, seeded(seed));
    assert.ok(q, '문항이 만들어져야 한다');
    const bad = q.choices.filter((c) => !/다$/.test(c));
    assert.deepStrictEqual(bad, [], '용언 정답에 명사 오답이 섞였다: ' + q.choices.join(', '));
  }
});

t('같은 꼴이 모자라면 나머지로 채운다 — 문항을 못 내는 것보다 낫다', () => {
  const target = { id: 'n1', type: 'native', word: '나뭇잎', meaning: '잎', example: '나뭇잎이 날아갔어요.' };
  const pool = [target,
    { id: 'v1', type: 'native', word: '눈부시다', meaning: 'a' },
    { id: 'v2', type: 'native', word: '미덥다', meaning: 'b' },
    { id: 'v3', type: 'native', word: '가득하다', meaning: 'c' },
  ];
  const q = Q._q.qCloze(target, pool, seeded(5));
  assert.ok(q, '같은 꼴이 없어도 문항은 나와야 한다');
  assert.strictEqual(q.choices.length, 4);
});

console.log('\n통과 ' + passed + '개 — 문제 출제 엔진 검증 완료');
