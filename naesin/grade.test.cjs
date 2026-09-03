'use strict';
/* 채점 모듈 검증 (node naesin/grade.test.cjs)
   픽스처: pack-sample.json 의 데모 지문 5문장 — 실제 교재와 무관한 자체 창작 콘텐츠 */
const assert = require('assert');
const G = require('./grade.js');
const pack = require('./pack-sample.json');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const S = pack.sentences; // seq 1~5
const canon = S.map((s) => ({ seq: s.seq, en: s.en }));
const near = (a, b) => Math.abs(a - b) < 1e-9;

t('normalizeEn — 소문자화·구두점 제거·공백 정리', () => {
  assert.strictEqual(G.normalizeEn('Hello,   World!'), 'hello world');
  assert.strictEqual(G.normalizeEn('  a   b  '), 'a b');
  assert.strictEqual(G.normalizeEn('sea.The'), 'sea the'); // 구두점은 공백으로 — 낱말이 붙으면 안 된다
  assert.strictEqual(G.normalizeEn(''), '');
  assert.strictEqual(G.normalizeEn(null), '');
});

t('normalizeEn — 굽은따옴표를 편 뒤 축약형을 전개한다', () => {
  assert.strictEqual(G.normalizeEn('I’m sure it’s fine.'), 'i am sure it is fine');
  assert.strictEqual(G.normalizeEn('“Hello,” he said.'), 'hello he said');
});

t('normalizeEn — 축약형 전개 전체 목록', () => {
  assert.strictEqual(G.normalizeEn("Don't worry."), 'do not worry');
  assert.strictEqual(G.normalizeEn("You can't win."), 'you cannot win');
  assert.strictEqual(G.normalizeEn("Won't he come?"), 'will not he come');
  assert.strictEqual(G.normalizeEn("Let's take the slow train."), 'let us take the slow train');
  assert.strictEqual(G.normalizeEn("She's kind. He's tall."), 'she is kind he is tall');
  assert.strictEqual(G.normalizeEn("We're ready. They're here. You're late."), 'we are ready they are here you are late');
  assert.strictEqual(G.normalizeEn("I'll always keep it."), 'i will always keep it');
  assert.strictEqual(G.normalizeEn("It isn't mine. They aren't here."), 'it is not mine they are not here');
  assert.strictEqual(G.normalizeEn("He didn't go. She doesn't know."), 'he did not go she does not know');
  assert.strictEqual(G.normalizeEn("I wasn't there. We weren't ready."), 'i was not there we were not ready');
});

t("E18 normalizeEn — 'd→would, can not→cannot, 아포스트로피 없는 축약(dont·Id) 복원 — 양쪽 같은 규칙", () => {
  assert.strictEqual(G.normalizeEn("I'd like"), 'i would like');
  assert.strictEqual(G.normalizeEn('I would like'), 'i would like');
  assert.strictEqual(G.normalizeEn('Id like'), 'i would like');
  assert.strictEqual(G.normalizeEn("You'd better go."), 'you would better go');
  assert.strictEqual(G.normalizeEn('can not'), 'cannot');
  assert.strictEqual(G.normalizeEn("can't"), 'cannot');
  assert.strictEqual(G.normalizeEn('dont worry'), 'do not worry');
  assert.strictEqual(G.normalizeEn('I cant go. She wont come. We didnt know. Im here. Theyre late.'),
    'i cannot go she will not come we did not know i am here they are late');
  assert.strictEqual(G.gradeAnswer('dont worry', ["Don't worry"]).correct, true);
  assert.strictEqual(G.gradeAnswer('I would like', ["I'd like"]).correct, true);
  assert.strictEqual(G.gradeAnswer('Id like', ["I'd like"]).correct, true);
  assert.strictEqual(G.gradeAnswer('can not', ['cannot']).correct, true);
  /* 진짜 낱말과 겹치는 형태는 건드리지 않는다 */
  assert.strictEqual(G.normalizeEn('He is ill. Its tail is long. We were well.'), 'he is ill its tail is long we were well');
});

t('normalizeEn — 소유격 아포스트로피는 전개하지 않고 지운다', () => {
  /* 's 를 아무 데나 is 로 펴면 my brother's book 이 my brother is book 이 된다.
     소유격은 그냥 지워 brothers 가 되고, 정답 쪽도 같은 규칙이라 비교는 어긋나지 않는다. */
  assert.strictEqual(G.normalizeEn("My brother's book"), 'my brothers book');
  assert.strictEqual(G.normalizeEn("my brothers book"), 'my brothers book');
});

t('gradeAnswer — 대소문자·구두점 무시 + 복수 정답', () => {
  assert.deepStrictEqual(G.gradeAnswer('Knocking', ['knocking', 'knock']), { correct: true, matched: 'knocking' });
  assert.deepStrictEqual(G.gradeAnswer('knock!', ['knocking', 'knock']), { correct: true, matched: 'knock' });
  assert.deepStrictEqual(G.gradeAnswer('knocked', ['knocking', 'knock']), { correct: false, matched: null });
});

t('gradeAnswer — 축약형은 어느 쪽으로 써도 정답', () => {
  assert.strictEqual(G.gradeAnswer('do not', ["Don't"]).correct, true);
  assert.strictEqual(G.gradeAnswer("don't", ['do not']).correct, true);
  assert.strictEqual(G.gradeAnswer('cannot', ["can't"]).correct, true);
});

t('gradeAnswer — 빈 입력은 오답', () => {
  assert.strictEqual(G.gradeAnswer('', ['knock']).correct, false);
  assert.strictEqual(G.gradeAnswer('   ', ['knock']).correct, false);
  assert.strictEqual(G.gradeAnswer('knock', []).correct, false);
});

t('gradeBlanks — 빈칸별 부분 채점', () => {
  const r = G.gradeBlanks(['Took', 'hear', 'knock!'], [['took'], ['heard'], ['knocking', 'knock']]);
  assert.strictEqual(r.allCorrect, false);
  assert.strictEqual(r.perBlank.length, 3);
  assert.strictEqual(r.perBlank[0].correct, true);
  assert.strictEqual(r.perBlank[1].correct, false);
  assert.strictEqual(r.perBlank[1].expected, 'heard'); // 틀린 칸에는 대표 정답을 보여 준다
  assert.strictEqual(r.perBlank[2].correct, true);
  assert.strictEqual(r.perBlank[2].matched, 'knock');
});

t('gradeBlanks — 전부 맞으면 allCorrect, 입력이 모자라면 그 칸은 오답', () => {
  assert.strictEqual(G.gradeBlanks(['took', 'HEARD.'], [['took'], ['heard']]).allCorrect, true);
  const r = G.gradeBlanks(['took'], [['took'], ['heard']]);
  assert.strictEqual(r.allCorrect, false);
  assert.strictEqual(r.perBlank[1].correct, false);
});

t('similarity — 정규화 후 토큰 편집거리 비율', () => {
  assert.strictEqual(G.similarity(S[0].en, S[0].en), 1);
  assert.strictEqual(G.similarity("DON'T STOP!", 'do not stop'), 1); // 정규화 차이는 거리 0
  assert.ok(near(G.similarity(S[2].en, 'We built a small castle out of wet sand.'), 8 / 9)); // 9토큰 중 1개 치환
  assert.ok(G.similarity(S[0].en, 'I like pizza very much.') < 0.35, '무관한 문장은 임계 아래');
  assert.strictEqual(G.similarity('', 'hello'), 0);
  assert.strictEqual(G.similarity('', ''), 1);
});

t('splitSentences — 마침표·물음표·느낌표에서 끊는다', () => {
  assert.deepStrictEqual(G.splitSentences('Hello! Are you there? Yes.'), ['Hello!', 'Are you there?', 'Yes.']);
  assert.deepStrictEqual(G.splitSentences('no trailing period'), ['no trailing period']);
  assert.deepStrictEqual(G.splitSentences(''), []);
});

t('splitSentences — Mr.·Aug. 같은 약어와 소수점은 지킨다', () => {
  assert.deepStrictEqual(G.splitSentences('Mr. Kim arrived on Aug. 1. He smiled.'),
    ['Mr. Kim arrived on Aug. 1.', 'He smiled.']);
  assert.deepStrictEqual(G.splitSentences('The rock is 3.5 meters wide. Really.'),
    ['The rock is 3.5 meters wide.', 'Really.']);
});

t('R6 splitSentences — 이니셜(J. K.)은 안 끊지만 낱말 a·I 뒤 마침표는 문장 끝이다', () => {
  assert.deepStrictEqual(G.splitSentences('J. K. Rowling wrote it. We read it.'), ['J. K. Rowling wrote it.', 'We read it.']);
  assert.deepStrictEqual(G.splitSentences('I got an A. We cheered.'), ['I got an A.', 'We cheered.']);
  assert.deepStrictEqual(G.splitSentences('It was I. Then we left.'), ['It was I.', 'Then we left.']);
  assert.deepStrictEqual(G.splitSentences('We live in the U.S.A. now.'), ['We live in the U.S.A. now.'], '약어 속 글자');
});

t('splitSentences — 줄바꿈도 경계다 (브레인덤프는 구두점 없이 줄만 바꾼다)', () => {
  assert.deepStrictEqual(G.splitSentences('first line\nsecond line'), ['first line', 'second line']);
});

t('diffPassage — 완벽 재현이면 전부 ok', () => {
  const r = G.diffPassage(S.map((s) => s.en).join(' '), canon);
  assert.strictEqual(r.okCount, 5);
  assert.strictEqual(r.partialCount, 0);
  assert.strictEqual(r.missingCount, 0);
  assert.strictEqual(r.orderOk, true);
  assert.deepStrictEqual(r.extras, []);
  r.perSentence.forEach((p, i) => {
    assert.strictEqual(p.seq, i + 1);
    assert.strictEqual(p.status, 'ok');
    assert.strictEqual(p.score, 1);
    assert.strictEqual(p.input, S[i].en);
  });
});

t('diffPassage — 문장 하나 누락', () => {
  const text = [S[0].en, S[1].en, S[3].en, S[4].en].join(' '); // seq 3 을 빠뜨렸다
  const r = G.diffPassage(text, canon);
  assert.strictEqual(r.okCount, 4);
  assert.strictEqual(r.missingCount, 1);
  const miss = r.perSentence.find((p) => p.seq === 3);
  assert.strictEqual(miss.status, 'missing');
  assert.strictEqual(miss.score, 0);
  assert.strictEqual(miss.input, null);
  /* 누락 문장의 diff 는 통째로 missing 한 덩어리 — 화면에서 "이 문장이 없다"로 보인다 */
  assert.deepStrictEqual(miss.diff, [{ type: 'missing', text: S[2].en }]);
  assert.strictEqual(r.orderOk, true);
});

t('diffPassage — 순서 뒤바뀜은 orderOk 로 잡는다', () => {
  const text = [S[0].en, S[2].en, S[1].en, S[3].en, S[4].en].join(' '); // 2·3번을 바꿔 썼다
  const r = G.diffPassage(text, canon);
  assert.strictEqual(r.okCount, 5, '문장 자체는 다 맞았다');
  assert.strictEqual(r.missingCount, 0);
  assert.strictEqual(r.orderOk, false);
});

t('diffPassage — 표현 일부 오류는 partial + 토큰 diff', () => {
  const wrong = 'We built a small castle out of wet sand.'; // warm → wet
  const text = [S[0].en, S[1].en, wrong, S[3].en, S[4].en].join(' ');
  const r = G.diffPassage(text, canon);
  assert.strictEqual(r.okCount, 4);
  assert.strictEqual(r.partialCount, 1);
  const p = r.perSentence.find((x) => x.seq === 3);
  assert.strictEqual(p.status, 'partial');
  assert.ok(near(p.score, 8 / 9));
  assert.strictEqual(p.input, wrong);
  assert.deepStrictEqual(p.diff, [
    { type: 'same', text: 'We built a small castle out of' },
    { type: 'missing', text: 'warm' },
    { type: 'extra', text: 'wet' },
    { type: 'same', text: 'sand.' },
  ]);
});

t('E6 diffPassage — ok 는 정규화 후 완전 일치뿐: 16토큰 문장의 낱말 하나 치환·누락도 partial', () => {
  const long = 'When the doors of the old train finally opened, I heard seagulls calling above the waves.';
  const c = [{ seq: 1, en: long }];
  const sub = G.diffPassage('When the doors of the old train finally opened, I heard seagulls crying above the waves.', c);
  assert.strictEqual(sub.perSentence[0].status, 'partial');
  assert.strictEqual(sub.okCount, 0);
  assert.ok(near(sub.perSentence[0].score, 15 / 16), '화면용 점수는 유지');
  const miss = G.diffPassage('When the doors of the old train finally opened, I heard seagulls above the waves.', c);
  assert.strictEqual(miss.perSentence[0].status, 'partial');
  const exact = G.diffPassage('when the doors of the old train finally opened i heard seagulls calling above the waves', c);
  assert.strictEqual(exact.perSentence[0].status, 'ok', '정규화 차이만 있으면 ok');
});

t('diffPassage — 전혀 다른 입력은 매칭하지 않고 extras 로 남긴다', () => {
  /* 0.35 미만을 억지로 붙이면 diff 가 소음이 된다 — 안 붙이는 게 정보다 */
  const r = G.diffPassage('I like pizza. My cat is cute.', canon);
  assert.strictEqual(r.missingCount, 5);
  assert.strictEqual(r.okCount + r.partialCount, 0);
  assert.deepStrictEqual(r.extras, ['I like pizza.', 'My cat is cute.']);
  assert.strictEqual(r.orderOk, true); // 매칭이 없으면 순서 위반도 없다
});

t('diffPassage — 빈 입력이면 전부 missing', () => {
  const r = G.diffPassage('', canon);
  assert.strictEqual(r.missingCount, 5);
  assert.deepStrictEqual(r.extras, []);
});

t('diffPassage — 축약·대소문자·구두점 차이는 감점이 아니다 (auto_norm 과 같은 눈)', () => {
  const text = 'i will always keep that salty morning in my heart';
  const r = G.diffPassage(text, [{ seq: 5, en: S[4].en }]);
  assert.strictEqual(r.perSentence[0].status, 'ok');
  assert.strictEqual(r.perSentence[0].score, 1);
});

t('diffPassage — 브레인덤프: 구두점 없이 줄바꿈으로 친 두 문장도 각각 매칭된다', () => {
  const dump = 'Last summer my family took a slow train to the sea\nWe built a small castle out of warm sand';
  const r = G.diffPassage(dump, canon);
  assert.strictEqual(r.okCount, 2);
  assert.strictEqual(r.missingCount, 3);
  const seqs = r.perSentence.filter((p) => p.status === 'ok').map((p) => p.seq);
  assert.deepStrictEqual(seqs, [1, 3]);
  assert.strictEqual(r.orderOk, true); // 쓴 순서(1→3)는 정본 순서와 어긋나지 않는다
});

t('E9 diffPassage — 구두점·줄바꿈 없이 이어 쓴 브레인덤프도 정본 문장 경계로 분할해 채점한다', () => {
  const dump = S.map((s) => s.en.replace(/[.,]/g, '')).join(' ');
  assert.strictEqual(G.splitSentences(dump).length, 1);
  const r = G.diffPassage(dump, canon);
  assert.strictEqual(r.okCount, 5, JSON.stringify(r.perSentence.map((p) => p.seq + ':' + p.status)));
  assert.deepStrictEqual(r.extras, []);
  assert.strictEqual(r.orderOk, true);
  r.perSentence.forEach((p, i) => assert.strictEqual(G.normalizeEn(p.input), G.normalizeEn(S[i].en)));
  /* 한 문장을 빠뜨리고 낱말 하나를 바꿔 이어 쓴 덤프 — 누락·부분이 제자리에 잡힌다 */
  const dump2 = [S[0].en, S[1].en, S[3].en.replace('night', 'noon'), S[4].en].map((s) => s.replace(/[.,]/g, '')).join(' ');
  const r2 = G.diffPassage(dump2, canon);
  assert.deepStrictEqual(r2.perSentence.map((p) => p.status), ['ok', 'ok', 'missing', 'partial', 'ok']);
  const p4 = r2.perSentence[3];
  assert.ok(p4.diff.some((d) => d.type === 'extra' && d.text === 'noon'));
  assert.ok(p4.diff.some((d) => d.type === 'missing' && d.text.indexOf('night') >= 0));
});

t('E14 diffPassage — 두 문장을 하나로 합쳐 써도 각각 매칭, 한 문장을 둘로 나눠 써도 extras 없이 매칭', () => {
  const merged = S[0].en.slice(0, -1) + ' and ' + S[1].en.charAt(0).toLowerCase() + S[1].en.slice(1) + ' ' + S[2].en;
  const r = G.diffPassage(merged, canon.slice(0, 3));
  assert.strictEqual(r.missingCount, 0, JSON.stringify(r.perSentence.map((p) => p.seq + ':' + p.status)));
  assert.deepStrictEqual(r.extras, []);
  assert.strictEqual(r.perSentence[2].status, 'ok');
  const scores = r.perSentence.map((p) => p.score);
  assert.ok(scores[0] + scores[1] > 1.85, '"and" 한 낱말만 군더더기: ' + scores.join(','));
  const split = G.diffPassage('We built a small castle. Out of warm sand.', [canon[2]]);
  assert.strictEqual(split.perSentence[0].status, 'ok');
  assert.deepStrictEqual(split.extras, []);
  assert.strictEqual(split.okCount, 1);
  /* 학생이 제대로 끊어 쓴 문장 경계는 존중한다 — 낱말 하나 틀린 문장은 그 문장만 partial */
  const wrong = 'We built a small castle out of wet sand.';
  const r3 = G.diffPassage([S[0].en, S[1].en, wrong, S[3].en, S[4].en].join(' '), canon);
  assert.strictEqual(r3.perSentence[2].input, wrong);
  assert.strictEqual(r3.okCount, 4);
});

t('R7 diffPassage — 짧은 문장은 낱말 하나 겹친 것만으로 매칭하지 않는다(최소 2낱말, 1낱말은 완전 일치)', () => {
  const r = G.diffPassage('Me neither.', [{ seq: 1, en: 'Me too.' }]);
  assert.strictEqual(r.perSentence[0].status, 'missing');
  assert.deepStrictEqual(r.extras, ['Me neither.']);
  const r2 = G.diffPassage('I like pizza.', [{ seq: 1, en: 'I like it.' }]);
  assert.strictEqual(r2.perSentence[0].status, 'partial', '3낱말 중 2개 겹치면 partial');
  assert.strictEqual(G.diffPassage('Yes.', [{ seq: 1, en: 'Yes.' }]).okCount, 1, '한 낱말 문장 완전 일치');
  assert.strictEqual(G.diffPassage('No.', [{ seq: 1, en: 'Yes.' }]).missingCount, 1);
});

t('gradeTranslationChunks — 모든 청크의 핵심 토큰이 있으면 coverage 1', () => {
  const r = G.gradeTranslationChunks(S[1].ko, S[1].chunks); // 모범 해석 그대로
  assert.strictEqual(r.perChunk.length, 3);
  r.perChunk.forEach((c) => assert.strictEqual(c.present, true));
  assert.strictEqual(r.coverage, 1);
  S.forEach((s) => assert.strictEqual(G.gradeTranslationChunks(s.ko, s.chunks).coverage, 1, 'seq ' + s.seq + ' 모범 해석'));
});

t('gradeTranslationChunks — 빠뜨린 청크가 표시된다', () => {
  const r = G.gradeTranslationChunks('문이 열렸을 때 나는 들었다', S[1].chunks); // 갈매기 청크를 빠뜨렸다
  assert.strictEqual(r.perChunk[0].present, true);
  assert.strictEqual(r.perChunk[1].present, true);
  assert.strictEqual(r.perChunk[2].present, false);
  assert.ok(near(r.coverage, 2 / 3));
});

t('gradeTranslationChunks — 조사·어미가 달라도 어간 근사로 잡는다', () => {
  /* 정밀 채점이 아니다 — "들었어요"도 "들었다"의 청크를 채운 것으로 본다 */
  const r = G.gradeTranslationChunks('문이 열리자 나는 갈매기가 파도 위에서 우는 소리를 들었어요', S[1].chunks);
  r.perChunk.forEach((c) => assert.strictEqual(c.present, true));
  assert.strictEqual(r.coverage, 1);
});

t('E11 gradeTranslationChunks — 기능 어간(것이다·하다·있다…)과 2자 어간의 접두로는 청크를 채우지 못한다', () => {
  const r = G.gradeTranslationChunks('나는 그것이 좋다', S[4].chunks); // "간직할 것이다" 청크가 '것이'로 잡히면 오탐
  assert.deepStrictEqual(r.perChunk.map((c) => c.present), [false, false, false]);
  assert.strictEqual(r.coverage, 0);
  const r2 = G.gradeTranslationChunks('그는 갔다', [{ en: 'x', ko: '그는 파도를 봤다' }]); // '파도'·'봤다' 둘 다 없음
  assert.strictEqual(r2.perChunk[0].present, false);
  const r3 = G.gradeTranslationChunks('우리는 성을 만들었다', [{ en: 'x', ko: '우리는 작은 성을 만들었다' }]);
  assert.strictEqual(r3.perChunk[0].present, true, '핵심 토큰(우리·성·만들었)이 있으면 present');
  /* 같은 자리를 두 청크가 나눠 쓰지 못한다 — '파도' 한 번으로 두 청크를 채우지 않는다 */
  const r4 = G.gradeTranslationChunks('파도', [{ en: 'a', ko: '파도 위에서' }, { en: 'b', ko: '큰 파도를' }]);
  assert.deepStrictEqual(r4.perChunk.map((c) => c.present), [true, false]);
});

t('gradeTranslationChunks — 청크가 없으면 빠뜨릴 것도 없다', () => {
  assert.strictEqual(G.gradeTranslationChunks('아무 해석', []).coverage, 1);
  assert.deepStrictEqual(G.gradeTranslationChunks('아무 해석', []).perChunk, []);
});

console.log('\n통과 ' + passed + '개 — 채점 모듈 검증 완료');
