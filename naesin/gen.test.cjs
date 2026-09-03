'use strict';
/* 문항 생성 모듈 검증 (node naesin/gen.test.cjs) — 시드 고정 rnd로 결정적 검사 */
const assert = require('assert');
const G = require('./gen.js');
const E = require('./engine.js');
const pack = require('./pack-sample.json');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const seeded = (s) => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const scripted = (vals) => { let i = 0; return () => vals[Math.min(i, vals.length - 1, i++)]; };

const byId = {}; pack.words.forEach((w) => { byId[w.id] = w; });
const bySeq = {}; pack.sentences.forEach((s) => { bySeq[s.seq] = s; });
/* 파트 재조립 — 텍스트는 text, 빈칸은 표층형(answers[0]). 원문과 같아야 한다. */
const rebuild = (parts) => parts.map((p) => (p.text != null ? p.text : p.blank.answers[0])).join('');

t('shuffle — 순열이고 원본을 훼손하지 않으며, rnd()가 1.0 이어도 undefined 가 섞이지 않는다', () => {
  const src = [1, 2, 3, 4];
  const a = G.shuffle(src, seeded(5));
  assert.deepStrictEqual(a.slice().sort(), [1, 2, 3, 4]);
  assert.deepStrictEqual(src, [1, 2, 3, 4]);
  assert.deepStrictEqual(G.shuffle([1, 2, 3], () => 1).slice().sort(), [1, 2, 3], 'G5: rnd 상한 가드');
  assert.ok(G.shuffle([1, 2, 3], () => 1).every((x) => x != null));
});

t('vocabMcq — 보기 4개, 키 1~4, 정답 포함, 중복 금지', () => {
  const q = G.vocabMcq(byId['w-001'], pack.words, seeded(7));
  assert.strictEqual(q.type, 'mcq');
  assert.strictEqual(q.wordId, 'w-001');
  assert.strictEqual(q.prompt, 'seagull');
  assert.deepStrictEqual(q.choices.map((c) => c.key), ['1', '2', '3', '4']);
  const answerText = q.choices.find((c) => c.key === q.answerKey).text;
  assert.strictEqual(answerText, '갈매기');
  assert.strictEqual(new Set(q.choices.map((c) => c.text)).size, 4, '보기 중복');
});

t('vocabMcq — 같은 시드는 같은 문항(결정성), 풀 부족이면 null', () => {
  const a = G.vocabMcq(byId['w-002'], pack.words, seeded(11));
  const b = G.vocabMcq(byId['w-002'], pack.words, seeded(11));
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  assert.strictEqual(G.vocabMcq(byId['w-001'], [byId['w-001']], seeded(1)), null, '오답 3개를 못 채우면 null');
});

t('vocabMcq — 오답은 같은 section·같은 품사 단어에서 먼저 뽑는다', () => {
  /* seagull(reading, n.)의 같은 section+품사 후보는 tide·castle·wave 딱 3개 —
     우선순위가 지켜지면 어떤 시드에서도 이 셋이 오답이다. */
  const wantSet = ['밀물과 썰물, 조수', '성', '파도'].sort();
  for (let seed = 1; seed <= 10; seed++) {
    const q = G.vocabMcq(byId['w-001'], pack.words, seeded(seed));
    const wrong = q.choices.filter((c) => c.key !== q.answerKey).map((c) => c.text).sort();
    assert.deepStrictEqual(wrong, wantSet, 'seed ' + seed + ': ' + wrong.join(', '));
  }
});

t('E15 오답 보기 — 정답 단어의 다른 뜻·유의어와 겹치는 단어는 보기로 쓰지 않는다(정·역방향)', () => {
  const keep = { id: 'k', headword: 'keep', pos: 'v.', meaningKo: ['간직하다', '유지하다'], sections: ['reading'], synonyms: [] };
  const maintain = { id: 'm', headword: 'maintain', pos: 'v.', meaningKo: ['유지하다'], sections: ['reading'], synonyms: [] };
  const hold = { id: 'h', headword: 'hold', pos: 'v.', meaningKo: ['쥐다', '보관하다'], sections: ['reading'],
    senses: [{ senseNo: 1, meaningKo: '쥐다' }, { senseNo: 2, meaningKo: '간직하다, 보관하다' }], synonyms: [] };
  const store = { id: 'st', headword: 'store', pos: 'v.', meaningKo: ['저장하다'], sections: ['reading'], synonyms: ['keep'] };
  const pool = [keep, maintain, hold, store,
    { id: 'a', headword: 'arrive', pos: 'v.', meaningKo: ['도착하다'], sections: ['reading'], synonyms: [] },
    { id: 'b', headword: 'build', pos: 'v.', meaningKo: ['짓다'], sections: ['reading'], synonyms: [] },
    { id: 'c', headword: 'climb', pos: 'v.', meaningKo: ['오르다'], sections: ['reading'], synonyms: [] },
    { id: 'd', headword: 'draw', pos: 'v.', meaningKo: ['그리다'], sections: ['reading'], synonyms: [] }];
  const banned = ['유지하다', '쥐다', '보관하다', '저장하다', 'maintain', 'hold', 'store'];
  for (let seed = 1; seed <= 12; seed++) {
    const q = G.vocabMcq(keep, pool, seeded(seed));
    q.choices.filter((c) => c.key !== q.answerKey).forEach((c) => assert.ok(banned.indexOf(c.text) < 0, 'seed ' + seed + ' 정방향 보기: ' + c.text));
    const r = G.vocabMcqReverse(maintain, pool, seeded(seed));   // '유지하다' → keep 도 정답이므로 금지
    r.choices.filter((c) => c.key !== r.answerKey).forEach((c) => assert.ok(c.text !== 'keep', 'seed ' + seed + ' 역방향 보기: keep'));
    const s = G.vocabMcqReverse(store, pool, seeded(seed));      // synonyms: ['keep'] — 유의어도 금지
    s.choices.filter((c) => c.key !== s.answerKey).forEach((c) => assert.ok(c.text !== 'keep', '유의어 보기: keep'));
    const h = G.vocabMcq(store, pool, seeded(seed));
    h.choices.filter((c) => c.key !== h.answerKey).forEach((c) => assert.ok(['간직하다', '유지하다'].indexOf(c.text) < 0, '유의어의 뜻: ' + c.text));
  }
  assert.strictEqual(G.vocabMcq(keep, [keep, maintain, hold, store], seeded(1)), null, '겹치는 단어를 빼면 보기가 모자라 null');
});

t('vocabMcq — withUnknown이면 모름(0) 선택지가 붙는다 (§14-1)', () => {
  const q = G.vocabMcq(byId['w-005'], pack.words, seeded(3), { withUnknown: true });
  assert.strictEqual(q.choices.length, 5);
  assert.strictEqual(q.unknownKey, '0');
  assert.strictEqual(q.choices[4].key, '0');
  assert.strictEqual(q.choices[4].text, '모름');
  const plain = G.vocabMcq(byId['w-005'], pack.words, seeded(3));
  assert.strictEqual(plain.unknownKey, undefined, 'withUnknown 없으면 모름도 없다');
  assert.strictEqual(plain.choices.length, 4);
});

t('vocabMcq — 다의어는 senses[0] 뜻을 쓴다', () => {
  const q = G.vocabMcq(byId['w-007'], pack.words, seeded(5));
  const answerText = q.choices.find((c) => c.key === q.answerKey).text;
  assert.strictEqual(answerText, '간직하다, 보관하다');
});

t('vocabMcqReverse — 한국어 뜻 제시, 영어 4지선다', () => {
  const q = G.vocabMcqReverse(byId['w-001'], pack.words, seeded(9));
  assert.strictEqual(q.prompt, '갈매기');
  const answerText = q.choices.find((c) => c.key === q.answerKey).text;
  assert.strictEqual(answerText, 'seagull');
  const headwords = new Set(pack.words.map((w) => w.headword));
  q.choices.forEach((c) => assert.ok(headwords.has(c.text), '보기가 팩 단어가 아님: ' + c.text));
});

t('spelling — 첫 글자 + 글자 수 힌트, hinted 플래그, 정답은 headword만', () => {
  const q = G.spelling(byId['w-001']);
  assert.strictEqual(q.type, 'spell');
  assert.strictEqual(q.hint, 's _ _ _ _ _ _');
  assert.strictEqual(q.hinted, true);
  assert.strictEqual(q.promptKo, '갈매기');
  assert.deepStrictEqual(q.answers, ['seagull']);
  /* 불규칙 동사도 headword만 — kept를 받아 주면 "썼다"는 착각만 남는다 */
  assert.deepStrictEqual(G.spelling(byId['w-007']).answers, ['keep']);
  /* 구 표제어는 낱말 경계를 남긴다 */
  assert.strictEqual(G.spelling({ id: 'p', headword: 'take a walk', meaningKo: ['산책하다'] }).hint, 't _ _ _ / _ / _ _ _ _');
  assert.strictEqual(G.spelling({ id: 'x', headword: '' }), null);
});

t('E8 spelling — {hint:false} 는 무힌트 완전 인출(hint null·hinted false)', () => {
  const q = G.spelling(byId['w-001'], seeded(1), { hint: false });
  assert.strictEqual(q.hint, null);
  assert.strictEqual(q.hinted, false);
  assert.deepStrictEqual(q.answers, ['seagull']);
  assert.strictEqual(q.promptKo, '갈매기');
  assert.strictEqual(G.spelling(byId['w-001'], seeded(1), { hint: true }).hinted, true);
});

t('exampleCloze — headword가 그대로 있으면 그 자리를 가린다', () => {
  const q = G.exampleCloze(byId['w-003']); // "The children built a castle out of wet sand."
  assert.strictEqual(q.type, 'cloze');
  assert.deepStrictEqual(q.textParts, ['The children built a ', ' out of wet sand.']);
  assert.deepStrictEqual(q.answers, ['castle']);
  assert.strictEqual(q.textParts[0] + q.answers[0] + q.textParts[1], byId['w-003'].example.en);
});

t('exampleCloze — 표층형 탐색: 불규칙형(took·kept)을 찾는다', () => {
  const take = { id: 'x-take', headword: 'take', irregularForms: ['take', 'took', 'taken'],
    example: { en: 'My family took a slow train to the sea.', ko: '우리 가족은 느린 기차를 탔다.' } };
  const q = G.exampleCloze(take);
  assert.deepStrictEqual(q.answers, ['took', 'take'], '표층형이 먼저, headword가 뒤');
  assert.deepStrictEqual(q.textParts, ['My family ', ' a slow train to the sea.']);
  const kept = { id: 'x-keep', headword: 'keep', irregularForms: ['keep', 'kept', 'kept'],
    example: { en: 'She kept the letter in a small box.', ko: '' } };
  assert.strictEqual(G.exampleCloze(kept).answers[0], 'kept');
});

t('exampleCloze — 단순 파생(s/es/ed/ing)도 찾고, 남의 단어 속에는 걸리지 않는다', () => {
  const call = { id: 'x-call', headword: 'call', pos: 'v.', example: { en: 'Seagulls were calling above the waves.', ko: '' } };
  assert.deepStrictEqual(G.exampleCloze(call).answers, ['calling', 'call']);
  /* 'keep'이 'keeper' 속에 걸리면 문장이 망가진다 — 어절 경계 필수. 동사의 -er 은 굴절이 아니다 */
  const keeper = { id: 'x-k2', headword: 'keep', pos: 'v.', example: { en: 'The keeper smiled at us.', ko: '' } };
  assert.strictEqual(G.exampleCloze(keeper), null);
  assert.strictEqual(G.exampleCloze(byId['w-006']), null, '예문 없으면 null');
});

t('G4 exampleCloze — 규칙 굴절(y→ies/ied, e탈락 -ing, 자음중복, 비교급)을 찾는다', () => {
  const cases = [
    ['try', 'v.', 'She tries hard every day.', 'tries'],
    ['study', 'v.', 'They studied for the test.', 'studied'],
    ['city', 'n.', 'Many cities are by the sea.', 'cities'],
    ['make', 'v.', 'We are making a sand castle.', 'making'],
    ['like', 'v.', 'He liked the salty wind.', 'liked'],
    ['run', 'v.', 'The boy was running to the sea.', 'running'],
    ['stop', 'v.', 'The train stopped at noon.', 'stopped'],
    ['big', 'a.', 'It was bigger than my house.', 'bigger'],
    ['happy', 'adj.', 'She was the happiest girl there.', 'happiest'],
    ['slow', 'a.', 'The slowest train left first.', 'slowest'],
  ];
  cases.forEach(([headword, pos, en, surface]) => {
    const q = G.exampleCloze({ id: 'x', headword, pos, example: { en } });
    assert.ok(q, headword + ' / ' + en + ' → null');
    assert.strictEqual(q.answers[0], surface, headword);
    assert.strictEqual(q.textParts[0] + surface + q.textParts[1], en);
  });
  /* 품사를 모르면 비교급도 허용, 동사·명사는 -er 금지(teach→teacher 는 다른 낱말) */
  assert.ok(G.exampleCloze({ id: 'x', headword: 'big', example: { en: 'It was bigger.' } }));
  assert.strictEqual(G.exampleCloze({ id: 'x', headword: 'teach', pos: 'v.', example: { en: 'My teacher smiled.' } }), null);
  assert.ok(G.surfaceCandidates({ headword: 'take a walk' }).length === 1, '구 표제어는 굴절을 안 만든다');
});

t('definitionPick — 영영풀이 제시, 단어 4지선다 / definition 없으면 null', () => {
  const q = G.definitionPick(byId['w-005'], pack.words, seeded(4));
  assert.strictEqual(q.type, 'defpick');
  assert.strictEqual(q.prompt, 'a moving line of water on the sea');
  assert.strictEqual(q.choices.find((c) => c.key === q.answerKey).text, 'wave');
  assert.strictEqual(new Set(q.choices.map((c) => c.text)).size, 4);
  assert.strictEqual(G.definitionPick(byId['w-003'], pack.words, seeded(4)), null);
});

t('keywordBlanks — 파트 재조립 = 원문, 힌트는 ko (전체 5문장)', () => {
  pack.sentences.forEach((s) => {
    const q = G.keywordBlanks(s, 'en');
    assert.ok(q, 'seq ' + s.seq + ' 문항 생성 실패');
    assert.strictEqual(q.type, 'kwblank');
    assert.strictEqual(rebuild(q.parts), s.en, 'seq ' + s.seq + ' 재조립이 원문과 다르다');
    assert.strictEqual(q.koFull, s.ko);
    const blanks = q.parts.filter((p) => p.blank);
    assert.strictEqual(blanks.length, s.keywords.length, 'seq ' + s.seq + ' 빈칸 수');
    blanks.forEach((p) => assert.ok(typeof p.blank.hintKo === 'string' && p.blank.hintKo, 'ko 힌트 누락'));
  });
});

t('keywordBlanks — 대소문자 무시 매칭, 못 찾는 키워드는 조용히 건너뛴다', () => {
  const s = { seq: 99, en: 'When we arrived, we built a castle.', ko: '도착해서 성을 만들었다.',
    keywords: [{ en: 'when', ko: '~할 때' }, { en: 'sand', ko: '모래' }, { en: 'castle', ko: '성' }] };
  const q = G.keywordBlanks(s, 'en');
  const blanks = q.parts.filter((p) => p.blank);
  assert.strictEqual(blanks.length, 2, 'sand는 문장에 없다 — 건너뛴다');
  assert.strictEqual(blanks[0].blank.answers[0], 'When', '문장의 표층 대문자를 보존');
  assert.ok(blanks[0].blank.answers.includes('when'), '키워드 원형도 정답으로 허용');
  assert.strictEqual(rebuild(q.parts), s.en);
  assert.strictEqual('notes' in q, false, '건너뛴 키워드를 notes에 담지 않는다');
});

t('clozeWide — 키워드 빈칸 + 내용어 1~2개 확대, 재조립 = 원문', () => {
  const s = bySeq[2]; // 키워드 3개: heard, seagulls, above
  for (let seed = 1; seed <= 10; seed++) {
    const q = G.clozeWide(s, seeded(seed));
    assert.strictEqual(rebuild(q.parts), s.en, 'seed ' + seed + ' 재조립 실패');
    const blanks = q.parts.filter((p) => p.blank);
    const extra = blanks.filter((p) => p.blank.hintKo == null);
    assert.strictEqual(blanks.length - extra.length, 3, '키워드 빈칸은 3개');
    assert.ok(extra.length >= 1 && extra.length <= 2, '추가 빈칸 1~2개: ' + extra.length);
    extra.forEach((p) => assert.ok(p.blank.answers[0].length >= 4, '내용어는 4자 이상: ' + p.blank.answers[0]));
  }
});

t('G7 clozeWide — 4자 기능어(When·will·that)는 추가 빈칸 후보가 아니다', () => {
  const seen = {};
  [2, 5].forEach((seq) => {
    for (let seed = 1; seed <= 60; seed++) {
      const q = G.clozeWide(bySeq[seq], seeded(seed));
      q.parts.filter((p) => p.blank && p.blank.hintKo == null).forEach((p) => { seen[p.blank.answers[0].toLowerCase()] = 1; });
    }
  });
  ['when', 'will', 'that'].forEach((w) => assert.ok(!seen[w], '기능어가 빈칸으로: ' + w));
  assert.ok(seen.doors && seen.morning, '내용어는 나온다: ' + Object.keys(seen).join(','));
});

t('tokenOrder — 셔플은 순열이고, 원답과 같게 나오면 재셔플', () => {
  const s = bySeq[1];
  const q = G.tokenOrder(s, seeded(13));
  assert.strictEqual(q.type, 'order');
  assert.deepStrictEqual(q.answer, s.tokens);
  assert.deepStrictEqual(q.shuffled.slice().sort(), s.tokens.slice().sort(), '같은 토큰의 순열이어야 한다');
  /* 항등 셔플을 강제하는 rnd(0.9999…×4) 뒤 0을 주면 — 재셔플 한 번으로 비항등이 된다 */
  const forced = G.tokenOrder(s, scripted([0.9999, 0.9999, 0.9999, 0.9999, 0, 0, 0, 0]));
  assert.notDeepStrictEqual(forced.shuffled, forced.answer, '재셔플 후에도 원답 그대로면 실패');
  assert.deepStrictEqual(forced.shuffled.slice().sort(), s.tokens.slice().sort());
  assert.deepStrictEqual(s.tokens, q.answer, '원본 tokens를 훼손하지 않는다');
});

t('G6 tokenOrder — 토큰 2개는 null, 어떤 시드에서도 원답 그대로 나오지 않는다', () => {
  assert.strictEqual(G.tokenOrder({ seq: 1, tokens: ['I agree', 'with you.'], ko: '' }, seeded(1)), null);
  const dup = { seq: 2, tokens: ['I', 'want', 'I'], ko: '' };
  for (let s = 1; s <= 300; s++) {
    const r = G.tokenOrder(dup, seeded(s));
    assert.ok(r && r.shuffled.join('|') !== r.answer.join('|'), 'seed ' + s + ' 항등 셔플');
  }
  for (let s = 1; s <= 300; s++) {
    const r = G.tokenOrder(bySeq[5], seeded(s));
    assert.ok(r.shuffled.join('|') !== r.answer.join('|'), 'seed ' + s + ' 항등 셔플');
  }
  assert.strictEqual(G.tokenOrder({ seq: 3, tokens: ['a', 'a', 'a'] }, seeded(1)), null, '전부 같은 토큰이면 문제가 아니다');
});

t('writingPrompt — 한글 + writingKeywords + 영어 정답', () => {
  const q = G.writingPrompt(bySeq[3]);
  assert.strictEqual(q.type, 'write');
  assert.strictEqual(q.ko, bySeq[3].ko);
  assert.deepStrictEqual(q.keywords, ['build', 'castle', 'sand']);
  assert.deepStrictEqual(q.answers, [bySeq[3].en]);
});

t('skeleton — 문장당 keywords[0].en 한 개만 제시 (§14-3 발판)', () => {
  const q = G.skeleton(bySeq[5]);
  assert.strictEqual(q.type, 'skeleton');
  assert.strictEqual(q.hint, 'always');
  assert.deepStrictEqual(q.answers, [bySeq[5].en]);
});

t('diagnosticSet — 전 단어 진단 문항, 전부 모름 버튼 포함 (§14-1)', () => {
  const set = G.diagnosticSet(pack, seeded(17));
  assert.strictEqual(set.length, pack.words.length, '8단어 전부 문항이 나와야 한다');
  assert.deepStrictEqual(set.map((q) => q.wordId), pack.words.map((w) => w.id));
  set.forEach((q) => {
    assert.strictEqual(q.unknownKey, '0');
    assert.strictEqual(q.choices.length, 5);
  });
});

t('G9 diagnosticSet — 보기가 모자라는 작은 팩도 남은 단어로 낸다(빠지는 단어 없음)', () => {
  const small = { words: [{ id: 'a', headword: 'a', meaningKo: ['가'] }, { id: 'b', headword: 'b', meaningKo: ['나'] }, { id: 'c', headword: 'c', meaningKo: ['다'] }] };
  const set = G.diagnosticSet(small, seeded(1));
  assert.strictEqual(set.length, 3);
  set.forEach((q) => {
    assert.strictEqual(q.choices.length, 4, '정답 + 오답 2개 + 모름');
    assert.strictEqual(q.choices[q.choices.length - 1].key, '0');
    assert.ok(q.choices.some((c) => c.key === q.answerKey));
  });
  assert.strictEqual(G.vocabMcq(small.words[0], small.words, seeded(1)), null, '일반 문항은 여전히 오답 3개 필요');
});

t('verbFormDrill — 동사형 빈칸: base 제시·문장형 정답, 재조립 = 원문', () => {
  const s = bySeq[2];
  const q = G.verbFormDrill(s);
  assert.strictEqual(q.type, 'verb');
  assert.deepStrictEqual(q.blanks.map((b) => b.base), ['open', 'hear', 'call']);
  q.blanks.forEach((b, i) => assert.ok(b.answers.includes(s.verbForms[i].answer), b.base + ' 정답 누락'));
  assert.strictEqual(rebuild(q.parts), s.en);
  assert.strictEqual(G.verbFormDrill({ seq: 9, en: 'No verbs here.', ko: '', verbForms: [] }), null, 'verbForms 비면 null');
});

t('grammarChoiceDrill — 2지선다 배열, 정답 어구가 가려진다', () => {
  const s = bySeq[4];
  const arr = G.grammarChoiceDrill(s);
  assert.strictEqual(arr.length, 1);
  const q = arr[0];
  assert.strictEqual(q.type, 'grammar');
  assert.deepStrictEqual(q.choices.map((c) => c.text), ['why the tide comes in', 'why does the tide come in']);
  assert.strictEqual(q.answerKey, '1');
  assert.strictEqual(rebuild(q.parts), s.en);
  assert.strictEqual(G.grammarChoiceDrill(bySeq[1]), null, 'grammarChoices 비면 null');
});

t('E19 dailySet — fresh(재인→힌트 철자)·review(로테이션)·relearn(무힌트 철자)·문장(정수 단계) 조립', () => {
  const plan = {
    words: { fresh: ['w-001'], review: ['w-002', 'w-003', 'w-005'], relearn: ['w-004'] },
    sentences: [{ seq: 1, stage: 3 }, { seq: 2, stage: 4 }, { seq: 4, stage: 5 }, { seq: 3, stage: 6 }, { seq: 5, stage: 1 }, { seq: 5, stage: 2 }],
  };
  const set = G.dailySet(pack, plan, seeded(21));
  assert.strictEqual(set.length, 10, '단어 6 + 문장 4(3단계 1 + 4단계 2 + 5단계 1; 1·2·6단계는 없음)');
  /* fresh: 4지선다로 만나고 힌트 철자로 굳힌다 — 힌트 철자는 도달이 아니다 */
  assert.deepStrictEqual([set[0].type, set[0].wordId, set[0].kind], ['mcq', 'w-001', 'word']);
  assert.deepStrictEqual([set[1].type, set[1].wordId, set[1].hinted], ['spell', 'w-001', true]);
  /* review: 로테이션 — 어떤 유형이든 그 단어 문항이 나온다 */
  assert.deepStrictEqual(set.slice(2, 5).map((q) => q.wordId), ['w-002', 'w-003', 'w-005']);
  set.slice(2, 5).forEach((q) => assert.ok(['mcq', 'cloze', 'defpick', 'spell'].indexOf(q.type) >= 0, q.type));
  /* relearn: 고속 재인출 = 무힌트 철자만 */
  assert.deepStrictEqual([set[5].type, set[5].wordId, set[5].hinted, set[5].hint], ['spell', 'w-004', false, null]);
  /* 문장: 엔진 단계 정수 → 생성기 매핑, kind·stage·seq 표기 */
  assert.deepStrictEqual(set.slice(6).map((q) => q.type), ['kwblank', 'clozewide', 'order', 'write']);
  assert.deepStrictEqual(set.slice(6).map((q) => q.stage), [3, 4, 4, 5]);
  assert.deepStrictEqual(set.slice(6).map((q) => q.seq), [1, 2, 2, 4]);
  set.slice(0, 6).forEach((q) => assert.strictEqual(q.kind, 'word'));
  set.slice(6).forEach((q) => assert.strictEqual(q.kind, 'sentence'));
  assert.deepStrictEqual(G.dailySet(pack, { words: {}, sentences: [{ seq: 1, stage: 6 }, { seq: 2, stage: 1 }, { seq: 3, stage: 2 }] }, seeded(1)), [],
    '1·2·6단계는 앱이 직접 진행 — 조용한 kwblank 폴백 금지');
});

t('dailySet — review 유형을 그 단어로 못 만들면 다음 유형으로 폴백', () => {
  /* w-006(slow)은 예문도 영영풀이도 없다 — 어느 자리에서 시작해도 mcq 나 무힌트 철자로 폴백 */
  const set = G.dailySet(pack, { words: { fresh: [], review: ['w-001', 'w-006'], relearn: [] }, sentences: [] }, seeded(23));
  assert.strictEqual(set.length, 2);
  assert.strictEqual(set[1].wordId, 'w-006');
  assert.ok(set[1].type === 'mcq' || (set[1].type === 'spell' && set[1].hinted === false), set[1].type);
  /* 어떤 날짜·상태에서도 review 단어마다 문항 하나는 나온다 */
  for (let day = 0; day < 8; day++) {
    const s2 = G.dailySet(pack, { words: { review: ['w-006', 'w-003'] }, sentences: [] }, seeded(day + 1), { now: day * 86400000 });
    assert.strictEqual(s2.length, 2, 'day ' + day);
  }
});

t('E1 dailySet — 상태를 주면 미도달 review 단어는 반드시 무힌트 철자(도달 기회)', () => {
  const now = new Date(2026, 8, 10, 9).getTime();
  const states = {};
  pack.words.forEach((w) => { states[w.id] = E.createState(w.id, 'word', now); });
  E.recordQuiz(states['w-002'], { correct: true, confidence: 'sure' }, now);                      // 미도달
  E.recordCriterion(states['w-003'], { correct: true, confidence: 'sure' }, now);                 // 도달
  const plan = { words: { review: ['w-002', 'w-003'] }, sentences: [] };
  for (let seed = 1; seed <= 8; seed++) {
    const set = G.dailySet(pack, plan, seeded(seed), { states, now: now + seed * 86400000 });
    assert.deepStrictEqual([set[0].wordId, set[0].type, set[0].hinted], ['w-002', 'spell', false], 'seed ' + seed);
    assert.strictEqual(set[1].wordId, 'w-003');
  }
  /* plan.states 로 넘겨도 같다 */
  const viaPlan = G.dailySet(pack, { words: { review: ['w-002'] }, sentences: [], states }, seeded(3));
  assert.deepStrictEqual([viaPlan[0].type, viaPlan[0].hinted], ['spell', false]);
  /* 상태가 없어도 로테이션에 무힌트 철자가 들어 있어 며칠 안에 도달 기회가 온다 */
  let spellDays = 0;
  for (let day = 0; day < 4; day++) {
    const set = G.dailySet(pack, { words: { review: ['w-001'] }, sentences: [] }, seeded(1), { now: day * 86400000 });
    if (set[0].type === 'spell' && set[0].hinted === false) spellDays += 1;
  }
  assert.strictEqual(spellDays, 1, '4일 로테이션에 무힌트 철자 1회');
});

t('E16 dailySet — review 로테이션은 배열 위치가 아니라 단어 상태(id·오답·연속·날짜)로 정해진다', () => {
  const day = (n) => n * 86400000;
  /* 같은 자리(0번)에 다른 단어 — 유형이 갈린다 */
  const types = ['w-001', 'w-002', 'w-003', 'w-005'].map((id) => G.dailySet(pack, { words: { review: [id] }, sentences: [] }, seeded(1), { now: day(0) })[0].type);
  assert.ok(new Set(types).size > 1, '단어별로 유형이 달라야 한다: ' + types.join(','));
  /* 같은 단어라도 날짜가 바뀌면 유형이 돈다 */
  const days = [];
  for (let d = 0; d < 4; d++) days.push(G.dailySet(pack, { words: { review: ['w-001'] }, sentences: [] }, seeded(d + 1), { now: day(d) })[0].type);
  assert.deepStrictEqual(days.slice().sort(), ['cloze', 'defpick', 'mcq', 'spell'], '4일이면 네 유형 한 번씩: ' + days.join(','));
  /* 오답·연속이 바뀌어도 자리가 바뀐다 */
  const s = E.createState('w-001', 'word', day(0));
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, day(0));
  const a = G.dailySet(pack, { words: { review: ['w-001'] }, sentences: [] }, seeded(1), { states: { 'w-001': s }, now: day(0) })[0].type;
  s.wrong += 1;
  const b = G.dailySet(pack, { words: { review: ['w-001'] }, sentences: [] }, seeded(1), { states: { 'w-001': s }, now: day(0) })[0].type;
  assert.notStrictEqual(a, b);
});

console.log('\n통과 ' + passed + '개 — 문항 생성 모듈 검증 완료');
