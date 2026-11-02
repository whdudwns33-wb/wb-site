#!/usr/bin/env node
'use strict';
/* reading/draft-check.js 단위 테스트 — node reading/draft-check.test.cjs
 *
 * 가장 중요한 것은 마지막의 「정본 대조」다. draft-check 의 수치는
 * content.test.cjs 의 사본이라, 한쪽만 고치면 병합 전 검사와 병합 후 검사가
 * 서로 다른 규격을 재게 된다. 그 어긋남을 여기서 막는다. */
const fs = require('fs');
const path = require('path');
const C = require('./draft-check.js');

let fail = 0;
const ok = (cond, what) => { if (!cond) { console.error('X', what); fail++; } };
const has = (list, frag, what) =>
  ok(list.some((m) => m.includes(frag)), what + ' — 「' + frag + '」 를 찾지 못했다: ' + JSON.stringify(list));
const hasNot = (list, frag, what) =>
  ok(!list.some((m) => m.includes(frag)), what + ' — 「' + frag + '」 가 나왔다: ' + JSON.stringify(list));

/* ── words: 어절 셈은 content.test.cjs 와 같은 정규식이어야 한다 ── */
ok(C.words('하나 둘 셋') === 3, 'words 셋');
ok(C.words('하나  둘 ') === 2, 'words 연속 공백');
ok(C.words('') === 0, 'words 빈 문자열');

/* ── 출처 주소 규칙 ── */
ok(C.isIndexPage('https://www.kostat.go.kr/'), '기관 첫 화면');
ok(C.isIndexPage('https://www.kma.go.kr/kma/news/press.jsp'), '쿼리 없는 press.jsp 는 목록');
ok(!C.isIndexPage('https://www.kma.go.kr/kma/news/press.jsp?bid=press&mode=view&num=1'), '쿼리가 붙으면 상세');
ok(C.isIndexPage('https://www.moel.go.kr/news/enews/report/enewsList.do'), 'enewsList 는 목록');
ok(!C.isIndexPage('https://www.kdca.go.kr/bbs/kdca/42/313024/artclView.do'), 'artclView 는 상세');
ok(C.isAttachmentOnly('https://www.korea.kr/briefing/pressReleaseView.do?newsId=1'), 'korea.kr 전재 페이지');
ok(!C.isAttachmentOnly('https://www.mcee.go.kr/home/web/board/read.do?boardId=1'), 'mcee read.do 는 본문이 있다');

/* ── 온전한 지문 하나를 만들어 검사가 조용한지 본다 ── */
function seg(text, per) {            /* text 를 per 어절씩 끊어 조각 배열로 */
  const w = text.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < w.length; i += per) out.push(w.slice(i, i + per).join(' ') + ' ');
  out[out.length - 1] = out[out.length - 1].trimEnd();
  return out;
}
function body(chars, per) {          /* 꼭 chars 글자인 문단 하나 */
  const unit = '법을 모아 적은 글이 법전이다. ';
  let t = '';
  while (t.length < chars) t += unit;
  return seg(t.slice(0, chars).replace(/\S+$/, '').trim() || t.slice(0, chars).trim(), per);
}
function qs(n, types, nPara) {
  return Array.from({ length: n }, (_, i) => ({
    type: types[i % types.length],
    q: '물음 ' + i,
    choices: ['가', '나', '다', '라'],
    answer: i % 4,
    explain: '해설 ' + i,
    evidencePara: i % nPara
  }));
}
/* 학년대 하나 — 어휘·문항 수는 규격에서 가져온다 */
function level(lv, chars, per) {
  const lim = C.LIMITS[lv];
  const p = [body(Math.ceil(chars / 2), per), body(chars - Math.ceil(chars / 2), per)];
  const o = {
    title: lv + ' 제목', minutes: 3, paragraphs: p,
    vocab: ['법전', '법을', '모아', '적은', '글이'].slice(0, lim.vocab).map((w) => ({ word: w, easy: '뜻풀이' })),
    questions: qs(lim.q, ['main', 'detail', 'vocab', 'infer', 'detail'], p.length),
    challenge: qs(2, ['infer', 'apply'], p.length)
  };
  if (lv !== 'L1') {
    const en = ['A code is a book of laws gathered together.', 'It was written down and kept for a long time.'];
    o.en = en;
    o.enseg = en.map((s) => [s]);
    o.envocab = [
      { word: 'code', ko: '법전' }, { word: 'laws', ko: '법' }, { word: 'gathered', ko: '모은' },
      { word: 'written', ko: '적은' }, { word: 'kept', ko: '지킨' }
    ];
  }
  return o;
}
function sample() {
  return {
    id: 'sample-draft', category: 'history', careers: ['law', 'hum'],
    publishedAt: '2026-11-02', status: 'draft', issue: false,
    sources: [{ title: '출처', url: 'https://www.kdca.go.kr/bbs/kdca/42/1/artclView.do' }],
    levels: {
      L1: level('L1', 280, 3), L2: level('L2', 600, 4),
      L3: level('L3', 850, 4), L4: level('L4', 1100, 5)
    }
  };
}
{
  const r = C.checkDraft(sample());
  ok(r.errors.length === 0, '온전한 지문에 결함 0 — 나온 것: ' + JSON.stringify(r.errors));
  ok(r.stats.L4 && r.stats.L4.chars > 1000 && r.stats.L4.chars <= 1100, 'L4 글자 수 집계 — 나온 값 ' + (r.stats.L4 && r.stats.L4.chars));
  ok(r.stats.L2 && r.stats.L2.mean > 0, 'L2 조각 평균 집계');
}

/* ── 걸려야 하는 것들 ── */
{
  const a = sample(); a.category = 'sports';
  has(C.checkDraft(a).errors, 'category', '모르는 분야');
}
{
  const a = sample(); a.careers = [];
  has(C.checkDraft(a).errors, 'careers 없음', '진로 없음');
}
{
  const a = sample(); a.careers = ['sport'];
  has(C.checkDraft(a).errors, 'career "sport"', '모르는 진로');
}
{
  const a = sample(); a.status = 'hidden';
  has(C.checkDraft(a).errors, 'status', '모르는 status');
}
{
  const a = sample(); a.sources = [{ title: '목록', url: 'https://www.kma.go.kr/kma/news/press.jsp' }];
  has(C.checkDraft(a).errors, '목록 페이지', '게시판 목록을 출처로 달면');
}
{
  const a = sample(); a.sources = [{ title: '전재', url: 'https://www.korea.kr/briefing/pressReleaseView.do?newsId=1' }];
  has(C.checkDraft(a).errors, '첨부파일만', '첨부만 있는 전재 페이지');
}
{
  const a = sample(); a.sources = [{ title: 'http', url: 'http://example.com/x' }];
  has(C.checkDraft(a).errors, 'https 아님', 'http 출처');
}
{   /* 8어절 초과 — 예외 없다 */
  const a = sample();
  a.levels.L4.paragraphs[0] = ['아홉 어절 이 되 도록 길 게 끊 은 조각이다.'];
  has(C.checkDraft(a).errors, '8어절을 넘습니다', '8어절 초과');
}
{   /* 조각 평균이 규격에서 벗어남 */
  const a = sample();
  a.levels.L1 = level('L1', 280, 1);       /* 한 어절씩 끊으면 평균 1.0 */
  has(C.checkDraft(a).errors, '조각 평균', '평균 이탈');
}
{   /* 글자 수 */
  const a = sample(); a.levels.L1 = level('L1', 120, 3);
  has(C.checkDraft(a).errors, '글자 수', '하한 미달');
}
{   /* vocab 낱말이 조각 경계에 걸림 */
  const a = sample();
  a.levels.L2.vocab[0] = { word: '없는낱말', easy: '뜻' };
  has(C.checkDraft(a).errors, '통째로 없음', '어휘 조각 걸침');
}
{   /* L1 한자 병기 */
  const a = sample();
  a.levels.L1.vocab[0].hanja = '法(법 법)';
  has(C.checkDraft(a).errors, 'L1 은 한자', 'L1 한자 병기');
}
{   /* enseg 이 en 과 어긋남 */
  const a = sample();
  a.levels.L3.enseg[0] = ['달라진 ', '조각'];
  has(C.checkDraft(a).errors, 'enseg[0]', 'enseg 불일치');
}
{   /* envocab 낱말이 영어 본문에 없음 */
  const a = sample();
  a.levels.L3.envocab[0] = { word: 'absent', ko: '없는' };
  has(C.checkDraft(a).errors, '영어 본문에 없음', 'envocab 누락');
}
{   /* evidencePara 범위 */
  const a = sample();
  a.levels.L2.questions[0].evidencePara = 9;
  has(C.checkDraft(a).errors, 'evidencePara', 'evidencePara 범위');
}
{   /* 기본 문항의 critical 은 경고, 심화의 critical 은 아니다 */
  const a = sample();
  a.levels.L3.questions[0].type = 'critical';
  const r = C.checkDraft(a);
  has(r.warns, 'critical 은 L4 전용', 'L3 기본 문항 critical 은 경고');
  hasNot(r.errors, 'critical', 'L3 기본 문항 critical 은 오류가 아니다');
  const b = sample();
  b.levels.L3.challenge[0].type = 'critical';
  hasNot(C.checkDraft(b).errors, 'critical', '심화 문항의 critical 은 허용');
}
{   /* 레벨 누락 — L1 도 이제 필수다(신규 지문은 네 학년대 전부) */
  const a = sample(); delete a.levels.L1;
  has(C.checkDraft(a).errors, 'L1 없음', '학년대 누락');
}
{   /* 문단 앞뒤 공백·연속 공백 */
  const a = sample();
  a.levels.L2.paragraphs[0] = ['앞에 공백이 ', ' 있는 문단이다.'];
  has(C.checkDraft(a).errors, '연속 공백', '조각 사이 연속 공백');
}

{   /* 정답이 혼자 가장 긴 선지인 문항이 절반을 넘으면 경고 ──
       지문을 읽지 않고 최장 선지만 골라도 맞으면 문항이 재는 것이 없다 */
  const a = sample();
  a.levels.L2.questions.forEach((q) => { q.choices = ['가', '나', '다', '라']; q.choices[q.answer] = '아주 긴 정답 선지'; });
  a.levels.L2.challenge.forEach((q) => { q.choices = ['가', '나', '다', '라']; q.choices[q.answer] = '아주 긴 정답 선지'; });
  const r = C.checkDraft(a);
  has(r.warns, '정답이 혼자 가장 긴 선지', '최장 선지 쏠림');
  hasNot(r.errors, '최장', '쏠림은 경고일 뿐 오류가 아니다');
  ok(r.stats.L2.lengthTell === r.stats.L2.qCount, '쏠림 집계 — ' + r.stats.L2.lengthTell + '/' + r.stats.L2.qCount);
}
{   /* 가장 긴 선지가 둘 이상이면(동률) 길이로 못 집으므로 세지 않는다 */
  const a = sample();
  a.levels.L3.questions.forEach((q) => { q.choices = ['같은 길이 하나', '같은 길이 가나', '같은 길이 다라', '같은 길이 마바']; });
  a.levels.L3.challenge.forEach((q) => { q.choices = ['같은 길이 하나', '같은 길이 가나', '같은 길이 다라', '같은 길이 마바']; });
  const r = C.checkDraft(a);
  ok(r.stats.L3.lengthTell === 0, '동률은 세지 않는다 — ' + r.stats.L3.lengthTell);
  hasNot(r.warns, 'L3: 정답이 혼자 가장 긴', '동률이면 경고 없음');
}
{   /* 정답이 최장이 아니면 세지 않는다 */
  const a = sample();
  a.levels.L4.questions.forEach((q) => {
    q.choices = ['가', '나', '다', '라'];
    q.choices[(q.answer + 1) % 4] = '오답이 가장 긴 선지가 되도록';
  });
  a.levels.L4.challenge.forEach((q) => {
    q.choices = ['가', '나', '다', '라'];
    q.choices[(q.answer + 1) % 4] = '오답이 가장 긴 선지가 되도록';
  });
  const r = C.checkDraft(a);
  ok(r.stats.L4.lengthTell === 0, '정답이 최장이 아니면 0 — ' + r.stats.L4.lengthTell);
}

/* ── 한자 훈음은 글자당 하나 ──
   집필은 한 편씩 따로 하므로 훈음 충돌은 병합할 때까지 드러나지 않는다.
   2026-11-02 에 네 편에서 10건이 한꺼번에 나와 content.test.cjs 가 막았다. */
{
  const corpus = C.collectReadings([
    { id: 'old-one', levels: { L3: { vocab: [{ word: '매개변수', hanja: '媒(중매 매)+數(셈 수)' }] } } },
    { id: 'old-two', levels: { L4: { vocab: [{ word: '피폭', hanja: '曝(쬘 폭)' }] } } }
  ]);
  ok(corpus['數'] && corpus['數']['셈 수'] === 'old-one/L3 매개변수', '훈음 모으기 — 출처 자리까지');
  ok(corpus['曝'] && Object.keys(corpus['曝']).length === 1, '훈음 모으기 — 글자별 하나');

  const clash = C.hanjaClash(
    { id: 'new', levels: { L2: { vocab: [{ word: '전수', hanja: '全(온전 전)+數(셀 수)' }] } } }, corpus);
  has(clash, '數(셀 수)', '어긋난 훈음을 집는다');
  has(clash, '數(셈 수)', '모아 둔 훈음을 함께 보여 준다');
  has(clash, 'old-one/L3 매개변수', '어디서 쓰였는지 알려 준다');
  ok(clash.length === 1, '새 글자(全)는 충돌이 아니다 — 나온 것 ' + clash.length);

  ok(C.hanjaClash({ id: 'same', levels: { L2: { vocab: [{ word: '피폭', hanja: '曝(쬘 폭)' }] } } }, corpus).length === 0,
    '같은 훈음은 통과');
  ok(C.hanjaClash({ id: 'none', levels: { L2: { vocab: [{ word: '전수', hanja: '全(온전 전)' }] } } }, corpus).length === 0,
    '모아 둔 것에 없는 글자는 통과');
  ok(C.hanjaClash({ id: 'x', levels: { L1: { vocab: [{ word: '기록' }] } } }, corpus).length === 0,
    '한자 없는 어휘는 통과');
  ok(C.hanjaClash(null, corpus).length === 0 && C.hanjaClash({}, null).length === 0,
    '빈 입력에 터지지 않는다');
  /* 여러 레벨에서 같은 글자를 다르게 쓰면 각각 집는다 */
  const two = C.hanjaClash({ id: 'n2', levels: {
    L2: { vocab: [{ word: '전수', hanja: '數(셀 수)' }] },
    L3: { vocab: [{ word: '결산', hanja: '數(셈할 수)' }] } } }, corpus);
  ok(two.length === 2, '레벨마다 집는다 — 나온 것 ' + two.length);
}

/* ── 정본 대조: content.test.cjs 와 수치가 같은가 ──
   한쪽만 고치면 병합 전과 병합 후가 다른 규격을 잰다. */
{
  const src = fs.readFileSync(path.join(__dirname, 'content.test.cjs'), 'utf8');
  const num = (re, what) => {
    const m = src.match(re);
    ok(m, '정본에서 ' + what + ' 를 찾지 못했다 — content.test.cjs 가 바뀌었다면 이 테스트도 고친다');
    return m ? Number(m[1]) : NaN;
  };
  for (const [lv, lim] of Object.entries(C.LIMITS)) {
    const m = src.match(new RegExp(lv + ':\\s*\\{\\s*min:\\s*(\\d+),\\s*max:\\s*(\\d+),\\s*vocab:\\s*(\\d+),\\s*q:\\s*(\\d+)'));
    ok(m, '정본 LIMITS.' + lv + ' 를 찾지 못했다');
    if (!m) continue;
    ok(Number(m[1]) === lim.min && Number(m[2]) === lim.max
      && Number(m[3]) === lim.vocab && Number(m[4]) === lim.q,
      'LIMITS.' + lv + ' 가 content.test.cjs 와 다르다 (정본 ' + m.slice(1, 5).join('/') + ')');
  }
  const specM = src.match(/const SPEC = \{ L1: ([\d.]+), L2: ([\d.]+), L3: ([\d.]+), L4: ([\d.]+) \}/);
  ok(specM, '정본 SPEC 를 찾지 못했다');
  if (specM) {
    ['L1', 'L2', 'L3', 'L4'].forEach((lv, i) => {
      ok(Number(specM[i + 1]) === C.SPEC[lv], 'SPEC.' + lv + ' 가 정본과 다르다 (정본 ' + specM[i + 1] + ')');
    });
  }
  ok(num(/const TOL = ([\d.]+)/, 'TOL') === C.TOL, 'TOL 이 정본과 다르다');
  ok(num(/const LONG = (\d+)/, 'LONG') === C.LONG, 'LONG 이 정본과 다르다');
  for (const t of C.QTYPES) ok(src.includes("'" + t + "'"), 'QTYPES 의 ' + t + ' 가 정본에 없다');
  for (const c of C.CATS) ok(src.includes("'" + c + "'"), 'CATS 의 ' + c + ' 가 정본에 없다');
  for (const c of C.CAREERS) ok(src.includes("'" + c + "'"), 'CAREERS 의 ' + c + ' 가 정본에 없다');
}

if (fail) { console.error(`\nFAIL — ${fail}건`); process.exit(1); }
console.log('OK — draft-check 검사 통과');
