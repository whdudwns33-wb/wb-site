'use strict';
/* 문항 생성 모듈 검증 (node naesin/gen.test.cjs) — 시드 고정 rnd로 결정적 검사 */
const assert = require('assert');
const G = require('./gen.js');
const pack = require('./pack-sample.json');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const seeded = (s) => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const scripted = (vals) => { let i = 0; return () => vals[Math.min(i, vals.length - 1, i++)]; };

const byId = {}; pack.words.forEach((w) => { byId[w.id] = w; });
const bySeq = {}; pack.sentences.forEach((s) => { bySeq[s.seq] = s; });
/* 파트 재조립 — 텍스트는 text, 빈칸은 표층형(answers[0]). 원문과 같아야 한다. */
const rebuild = (parts) => parts.map((p) => (p.text != null ? p.text : p.blank.answers[0])).join('');

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

t('spelling — 첫 글자 + 글자 수 힌트, 정답은 headword만', () => {
  const q = G.spelling(byId['w-001']);
  assert.strictEqual(q.type, 'spell');
  assert.strictEqual(q.hint, 's _ _ _ _ _ _');
  assert.strictEqual(q.promptKo, '갈매기');
  assert.deepStrictEqual(q.answers, ['seagull']);
  /* 불규칙 동사도 headword만 — kept를 받아 주면 "썼다"는 착각만 남는다 */
  assert.deepStrictEqual(G.spelling(byId['w-007']).answers, ['keep']);
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
  const call = { id: 'x-call', headword: 'call', example: { en: 'Seagulls were calling above the waves.', ko: '' } };
  assert.deepStrictEqual(G.exampleCloze(call).answers, ['calling', 'call']);
  /* 'keep'이 'keeper' 속에 걸리면 문장이 망가진다 — 어절 경계 필수 */
  const keeper = { id: 'x-k2', headword: 'keep', example: { en: 'The keeper smiled at us.', ko: '' } };
  assert.strictEqual(G.exampleCloze(keeper), null);
  assert.strictEqual(G.exampleCloze(byId['w-006']), null, '예문 없으면 null');
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

t('tokenOrder — 셔플은 순열이고, 원답과 같게 나오면 1회 재셔플', () => {
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

t('dailySet — fresh(재인→철자)·review(로테이션)·relearn(철자)·문장(단계별) 조립', () => {
  const plan = {
    words: { fresh: ['w-001'], review: ['w-002', 'w-003', 'w-005'], relearn: ['w-004'] },
    sentences: [{ seq: 1, stage: 3 }, { seq: 2, stage: 4 }, { seq: 3, stage: 4.5 }, { seq: 4, stage: 5 }, { seq: 5, stage: 5.5 }],
  };
  const set = G.dailySet(pack, plan, seeded(21));
  assert.strictEqual(set.length, 11, '단어 6 + 문장 5');
  /* fresh: 4지선다로 만나고 곧장 철자로 굳힌다 */
  assert.deepStrictEqual([set[0].type, set[0].wordId, set[0].kind], ['mcq', 'w-001', 'word']);
  assert.deepStrictEqual([set[1].type, set[1].wordId], ['spell', 'w-001']);
  /* review: i%3 로테이션 — mcq → 예문 빈칸 → 영영풀이 */
  assert.deepStrictEqual(set.slice(2, 5).map((q) => q.type), ['mcq', 'cloze', 'defpick']);
  assert.deepStrictEqual(set.slice(2, 5).map((q) => q.wordId), ['w-002', 'w-003', 'w-005']);
  /* relearn: 고속 재인출 = 철자만 */
  assert.deepStrictEqual([set[5].type, set[5].wordId], ['spell', 'w-004']);
  /* 문장: stage → 생성기 매핑, kind·stage 표기 */
  assert.deepStrictEqual(set.slice(6).map((q) => q.type), ['kwblank', 'clozewide', 'order', 'write', 'skeleton']);
  assert.deepStrictEqual(set.slice(6).map((q) => q.stage), [3, 4, 4.5, 5, 5.5]);
  set.slice(0, 6).forEach((q) => assert.strictEqual(q.kind, 'word'));
  set.slice(6).forEach((q) => assert.strictEqual(q.kind, 'sentence'));
});

t('dailySet — review 유형을 그 단어로 못 만들면 다음 유형으로 폴백', () => {
  /* w-006(slow)은 예문도 영영풀이도 없다 — i=1(예문 빈칸) 차례여도 mcq로 폴백 */
  const set = G.dailySet(pack, { words: { fresh: [], review: ['w-001', 'w-006'], relearn: [] }, sentences: [] }, seeded(23));
  assert.strictEqual(set.length, 2);
  assert.deepStrictEqual([set[1].type, set[1].wordId], ['mcq', 'w-006']);
});

console.log('\n통과 ' + passed + '개 — 문항 생성 모듈 검증 완료');
