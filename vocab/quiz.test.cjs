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

t('소리가 헷갈리는 짝을 알아본다', () => {
  /* 교재가 강마다 가르치는 것이 바로 이 짝이다. 글자로 비교하면 못 잡는다 —
     "거름"과 "걸음"은 두 글자가 다 다르지만 낱자로 풀면 ㄱㅓㄹㅡㅁ 으로 같다. */
  const pairs = [['거름', '걸음'], ['반듯이', '반드시'], ['갔다', '같다'], ['마치다', '맞히다'],
    ['부치다', '붙이다'], ['작다', '적다'], ['낫다', '낳다'], ['쫓다', '좇다'],
    ['띠다', '띄다'], ['싸다', '쌓다'], ['사흘', '나흘'], ['잇다', '잊다']];
  for (const [a, b] of pairs) assert.ok(Q.confusable(a, b), a + '/' + b + ' 를 짝으로 못 봤다');

  const far = [['초원', '응달'], ['마치다', '속삭이다'], ['작다', '뙤약볕'], ['으뜸', '버금']];
  for (const [a, b] of far) assert.strictEqual(Q.confusable(a, b), false, a + '/' + b + ' 를 짝으로 잘못 봤다');

  assert.strictEqual(Q.confusable('작다', '작다'), false, '같은 낱말은 짝이 아니다');
  assert.strictEqual(Q.confusable('', '작다'), false);
});

t('문맥 빈칸에서 헷갈리는 짝이 오답 1순위로 들어간다', () => {
  const target = { id: 'w1', type: 'native', word: '마치다', meaning: '끝내다', example: '숙제를 마치고 놀았어요.' };
  const pool = [target,
    { id: 'w2', type: 'native', word: '맞히다', meaning: '정답을 알아내다' },
    { id: 'w3', type: 'native', word: '거들다', meaning: '돕다' },
    { id: 'w4', type: 'native', word: '번갈다', meaning: '번갈아 하다' },
    { id: 'w5', type: 'native', word: '속삭이다', meaning: '작게 말하다' },
    { id: 'w6', type: 'native', word: '연결하다', meaning: '잇다' },
  ];
  for (let seed = 1; seed <= 20; seed += 1) {
    const q = Q._q.qCloze(target, pool, seeded(seed));
    assert.ok(q, '문항이 만들어져야 한다');
    assert.ok(q.choices.includes('맞히다'), '짝이 보기에 없다: ' + q.choices.join(', '));
  }
});

t('예문 빈칸 — 2음절 용언의 활용형도 가려진다', () => {
  /* 예전에는 한 글자 어간을 버려서(작다→작) 2음절 용언은 문항이 아예 안 나왔다.
     하필 교재의 헷갈리는 말이 대부분 그 꼴이다. */
  const cases = [
    ['작다', '이 신발은 너무 작아요.', '이 신발은 너무 ○○○.'],
    ['적다', '내 책이 친구보다 적어요.', '내 책이 친구보다 ○○○.'],
    ['잇다', '실을 잇다', '실을 ○○○'],
    ['마치다', '숙제를 마치고 놀았어요.', '숙제를 ○○○ 놀았어요.'],   // 어간은 '마'가 아니라 '마치'
    ['속삭이다', '비밀 이야기를 친구에게 속삭였어요.', '비밀 이야기를 친구에게 ○○○.'],
    ['관측', '별을 관측했다.', '별을 ○○○.'],
  ];
  for (const [word, example, want] of cases) {
    assert.strictEqual(Q.blankExample({ word, example }), want, word + ' 의 빈칸이 어긋났다');
  }
});

t('한 글자 어간은 남의 낱말 속에 걸리지 않는다', () => {
  /* "작다"의 어간 '작'이 "작품"의 '작'에 걸리면 엉뚱한 자리가 가려진다 —
     낱말이 시작하는 자리에서만 인정한다. */
  assert.strictEqual(Q.blankExample({ word: '작다', example: '이 작품은 훌륭해요.' }), '이 ○○○ 훌륭해요.');
  assert.strictEqual(Q.blankExample({ word: '작다', example: '내 마음이 작품 같아요.' }), '내 마음이 ○○○ 같아요.');
  assert.strictEqual(Q.blankExample({ word: '잊다', example: '숙제를 다 했어요.' }), null, '없으면 문항을 만들지 않는다');
});

t('오답은 같은 강 낱말을 먼저 쓴다', () => {
  /* 아이가 모르는 말(다른 학년 시드 단어)을 보기로 놓으면 뜻을 몰라도
     "아는 말 하나"를 골라 맞힌다. 그건 확인이 아니다. */
  const lesson = [
    { id: 'tw-a-0', assignId: 'a', type: 'native', word: '마치다', meaning: '끝내다', example: '숙제를 마치고 놀았어요.' },
    { id: 'tw-a-1', assignId: 'a', type: 'native', word: '맞히다', meaning: '정답을 알아내다' },
    { id: 'tw-a-2', assignId: 'a', type: 'native', word: '거들다', meaning: '돕다' },
    { id: 'tw-a-3', assignId: 'a', type: 'native', word: '맞대다', meaning: '닿게 하다' },
  ];
  const seeds = [
    { id: 's0', type: 'native', word: '아우르다', meaning: '여럿을 모으다' },
    { id: 's1', type: 'native', word: '가늠하다', meaning: '헤아리다' },
    { id: 's2', type: 'native', word: '드넓다', meaning: '아주 넓다' },
  ];
  const words = lesson.map((w) => w.word);
  for (let seed = 1; seed <= 20; seed += 1) {
    const q = Q._q.qCloze(lesson[0], lesson.concat(seeds), seeded(seed));
    assert.ok(q, '문항이 만들어져야 한다');
    assert.ok(q.choices.includes('맞히다'), '짝이 빠졌다: ' + q.choices.join(', '));
    for (const c of q.choices) {
      assert.ok(words.includes(c), '같은 강 낱말로 채울 수 있는데 딴 데서 가져왔다: ' + c);
    }
  }
});

t('활용한 꼴도 빈칸으로 잡는다', () => {
  /* 어간을 글자 그대로 찾는 것만으로는 절반을 놓친다 —
     예문은 「엇갈렸어요」인데 어간은 「엇갈리」다. 한국어 활용은 어간의 끝 음절만
     바꾸므로 앞부분으로 자리를 잡고 첫소리로 확인한다. 불규칙이 모두 이 안에 든다. */
  const cases = [
    ['엇갈리다', '친구와 길에서 엇갈렸어요.', '친구와 길에서 ○○○.'],
    ['가쁘다', '숨이 가빴어요.', '숨이 ○○○.'],            // ㅡ 불규칙
    ['낫다', '감기가 다 나았어요.', '감기가 다 ○○○.'],      // ㅅ 불규칙
    ['지혜롭다', '지혜로운 친구는 싸움을 피했어요.', '○○○ 친구는 싸움을 피했어요.'], // ㅂ 불규칙
    ['다르다', '생각이 달라요.', '생각이 ○○○.'],            // 르 불규칙
    ['부르다', '친구 이름을 불렀어요.', '친구 이름을 ○○○.'],
    ['가다', '엄마가 시장에 갔다.', '엄마가 시장에 ○○○.'],   // 한 글자 어간
    ['묶다', '신발 끈을 단단히 묶었어요.', '신발 끈을 단단히 ○○○.'],
  ];
  for (const [word, example, want] of cases) {
    assert.strictEqual(Q.blankExample({ word, example }), want, word + ' 의 활용형을 못 찾았다');
  }
});

t('낱말이 없는 문장은 빈칸으로 만들지 않는다', () => {
  /* 없는 자리에 구멍을 뚫으면 답이 없는 문제가 된다.
     「오늘」 속의 「늘」을 「늘이다」로 보는 따위도 막아야 한다 — 어절 첫머리여야 한다. */
  assert.strictEqual(Q.blankExample({ word: '늘이다', example: '오늘 어떤 동작을 가장 많이 했니?' }), null);
  assert.strictEqual(Q.blankExample({ word: '어절', example: '나는 학교에 갔다.' }), null);
  assert.strictEqual(Q.blankExample({ word: '애틋하다', example: '오랜만에 가족을 보면 어떤 기분이 드니?' }), null);
  /* 첫소리·가운뎃소리만 맞추면 「늘이다」가 「늦게」를 잡는다 — 받침까지 봐야 한다 */
  assert.strictEqual(Q.blankExample({ word: '늘이다', example: '엄마가 늦게 오면 나는 애간장을 태워~' }), null);
  assert.strictEqual(Q.blankExample({ word: '늘이다', example: '고무줄을 길게 늘였어요.' }), '고무줄을 길게 ○○○.');
  /* 받침이 그냥 사라지는 일은 없다 — 불규칙일 때만이다.
     이 표가 없으면 「없다」가 「어떤」을, 「걷다」가 「거름을」을, 「달이다」가 「다른」을 잡는다. */
  assert.strictEqual(Q.blankExample({ word: '없다', example: '별 하면 어떤 말이 떠올라?' }), null);
  assert.strictEqual(Q.blankExample({ word: '걷다', example: '농부가 밭에 거름을 뿌렸어요.' }), null);
  assert.strictEqual(Q.blankExample({ word: '달이다', example: '떡볶이는 맵기만 할까? 다른 느낌도 있지?' }), null);
  /* 진짜 불규칙은 잡아야 한다 */
  assert.strictEqual(Q.blankExample({ word: '걷다', example: '아이가 천천히 걸어요.' }), '아이가 천천히 ○○○.');
  assert.strictEqual(Q.blankExample({ word: '돕다', example: '친구를 도와주었어요.' }), '친구를 ○○○.');
});

console.log('\n통과 ' + passed + '개 — 문제 출제 엔진 검증 완료');
