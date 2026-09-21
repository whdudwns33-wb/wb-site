'use strict';
/* 브레인레터 순수 로직 검증 — node letter/letter.test.cjs
   학년대 판정·KST 주차·호 검증기·학년대 선택·렌더러(이스케이프·인쇄 별지)를 지킨다.
   샘플 호(issue-sample.json)는 검증기 오류 0 이어야 한다 — 체험 모드가 첫 화면에서 깨지지 않게. */
const assert = require('node:assert/strict');
const path = require('node:path');
const L = require('./letter.js');
const SAMPLE = require('./issue-sample.json');
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const clone = (v) => JSON.parse(JSON.stringify(v));
const errs = (issue) => L.checkIssue(issue).errors.map((e) => e.where + ': ' + e.msg);

t('학년대 다섯 — 유치→중등 순서, 라벨에 학년 범위', () => {
  assert.deepEqual(L.TIER_IDS, ['K', 'E1', 'E2', 'E3', 'M']);
  assert.equal(L.tierLabel('E2'), '초등 중학년(초3~4)');
  assert.equal(L.tierLabel('zz'), '');
});

t('주차는 KST 로 센다 — 일요일 밤 11시 30분과 월요일 0시 30분이 다른 주', () => {
  assert.equal(L.weekId(Date.parse('2026-09-21T01:00:00Z')), '2026-W39');
  assert.equal(L.weekId(Date.parse('2026-09-20T15:30:00Z')), '2026-W39');   // 9/21 00:30 KST 월요일
  assert.equal(L.weekId(Date.parse('2026-09-20T14:30:00Z')), '2026-W38');   // 9/20 23:30 KST 일요일
  assert.equal(L.weekId(Date.parse('2026-01-03T15:30:00Z')), '2026-W01');   // 1/4 00:30 KST — 1월 4일은 언제나 1주
  assert.equal(L.weekStart('2026-W39'), '2026-09-21');
  assert.equal(L.weekStart('2027-W01'), '2027-01-04');
  assert.equal(L.weekStart('2026-W99'), null);
  assert.equal(L.weekLabel('2026-W39'), '2026년 39호');
  assert.equal(L.kstDate(Date.parse('2026-09-20T15:30:00Z')), '2026-09-21');
  assert.equal(L.isValidDate('2026-02-30'), false);
  assert.equal(L.isValidDate('2026-02-28'), true);
});

t('명부 학년 문자열 → 학년대 (초·중·고·세·유치), 원장 지정이 이기고, 못 읽으면 진로독서 과정으로 어림', () => {
  const cases = { '초1': 'E1', '초2': 'E1', '초3': 'E2', '초4': 'E2', '초5': 'E3', '초6': 'E3', '초등 5학년': 'E3', '3학년': 'E2',
    '중1': 'M', '중3': 'M', '중학교 2학년': 'M', '고1': 'M', '고등 3학년': 'M', '7세': 'K', '6살': 'K', '유치부': 'K', '유아': 'K', '': null, '기타': null };
  for (const [g, want] of Object.entries(cases)) assert.equal(L.tierFromGrade(g), want, g);
  assert.equal(L.tierOf({ grade: '초3', letterTier: 'M' }), 'M', '원장 지정');
  assert.equal(L.tierOf({ grade: '초3', letterTier: 'nope' }), 'E2', '엉뚱한 지정은 무시');
  assert.equal(L.tierOf({ grade: '', level: 'L1' }), 'E1');
  assert.equal(L.tierOf({ grade: '', level: 'L2' }), 'E2');
  assert.equal(L.tierOf({ grade: '', level: 'L4' }), 'M');
  assert.equal(L.tierOf({ grade: '' }), null);
  assert.equal(L.tierOf(null), null);
});

t('샘플 호는 검증기 오류 0 — 다섯 학년대 모두 읽을거리·두뇌 놀이가 있다', () => {
  const r = L.checkIssue(SAMPLE);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
  assert.deepEqual(L.tiersOf(SAMPLE), ['K', 'E1', 'E2', 'E3', 'M']);
  assert.ok(/자체 창작/.test(SAMPLE.source), '샘플은 자체 창작 표시가 있어야 한다');
  const b = L.brief(SAMPLE);
  assert.equal(b.id, '2026-W39'); assert.equal(b.sections, SAMPLE.sections.length);
});

t('검증기 — 머리 정보 규칙(id·week·발행일·status·제목·출처)', () => {
  const bad = (mut) => { const i = clone(SAMPLE); mut(i); return errs(i); };
  assert.ok(bad((i) => { i.id = '39호'; }).some((e) => /^id:/.test(e)));
  assert.ok(bad((i) => { i.id = '2026-W40'; }).some((e) => /week/.test(e)), 'id 는 week 로 시작');
  assert.deepEqual(bad((i) => { i.id = '2026-W39-special'; }), [], '접미사는 허용');
  assert.ok(bad((i) => { i.publishAt = '2026-02-30'; }).some((e) => /publishAt/.test(e)));
  assert.ok(bad((i) => { i.status = 'live'; }).some((e) => /status/.test(e)));
  assert.ok(bad((i) => { i.title = '  '; }).some((e) => /title/.test(e)));
  assert.ok(bad((i) => { delete i.source; }).some((e) => /source/.test(e)), '출처 없는 호는 저장되지 않는다');
  assert.ok(bad((i) => { i.sections = []; }).some((e) => /sections/.test(e)));
  assert.ok(errs('x').length && errs(null).length);
});

t('검증기 — 섹션 규칙(id 중복·모르는 type·학년대·문항 정답 범위·보기 수·웩슬러 지표)', () => {
  const bad = (mut) => { const i = clone(SAMPLE); mut(i); return errs(i); };
  assert.ok(bad((i) => { i.sections[1].id = i.sections[0].id; }).some((e) => /중복/.test(e)));
  assert.ok(bad((i) => { i.sections[0].type = 'video'; }).some((e) => /type/.test(e)));
  assert.ok(bad((i) => { i.sections[0].tiers = ['K', 'X']; }).some((e) => /학년대/.test(e)));
  assert.ok(bad((i) => { i.sections[0].tiers = []; }).some((e) => /tiers/.test(e)));
  assert.ok(bad((i) => { i.sections[0].questions[0].answer = 5; }).some((e) => /answer/.test(e)), '정답 번호가 보기 밖이면 학생 화면이 그 문항에서 죽는다');
  assert.ok(bad((i) => { i.sections[0].questions[0].choices = ['하나']; }).some((e) => /보기/.test(e)));
  assert.ok(bad((i) => { i.sections[0].questions = []; }).some((e) => /문제/.test(e)));
  assert.ok(bad((i) => { i.sections[0].questions[0].skill = 'guess'; }).some((e) => /skill/.test(e)));
  const brain = SAMPLE.sections.findIndex((s) => s.type === 'brain');
  assert.ok(bad((i) => { i.sections[brain].index = 'IQ'; }).some((e) => /index/.test(e)));
  assert.ok(bad((i) => { i.sections[brain].items[0].answer = ''; }).some((e) => /answer/.test(e)));
  const words = SAMPLE.sections.findIndex((s) => s.type === 'words');
  assert.ok(bad((i) => { i.sections[words].words = []; }).some((e) => /words/.test(e)));
  assert.ok(bad((i) => { i.sections[words].family = { hanja: '色' }; }).some((e) => /family/.test(e)));
  /* 경고 — 오류는 아니지만 검수 화면이 보여 준다 */
  const w = (mut) => { const i = clone(SAMPLE); mut(i); return L.checkIssue(i).warnings.map((x) => x.msg); };
  assert.ok(w((i) => { i.sections = i.sections.filter((s) => s.id !== 'read-k'); }).some((m) => /유치.*읽을거리가 없습니다/.test(m)));
  assert.ok(w((i) => { i.sections[0].vocab = [{ word: '우주선', easy: 'x' }]; }).some((m) => /본문에 없습니다/.test(m)));
  assert.ok(w((i) => { i.sections[0].paragraphs = ['짧다']; }).some((m) => /글자 수/.test(m)));
  assert.ok(bad((i) => { i.sections[0].paragraphs = ['x'.repeat(200)]; i.intro = 'y'.repeat(801); }).some((e) => /intro/.test(e)));
});

t('검증기 — 400KB 를 넘는 호는 막는다(학생 기기·KV 한 값 상한)', () => {
  const i = clone(SAMPLE);
  i.sections.find((s) => s.type === 'column').paragraphs = Array.from({ length: 20 }, () => '가'.repeat(2000));
  i.sections.push({ id: 'big', type: 'column', tiers: 'all', title: 'x', paragraphs: Array.from({ length: 20 }, () => '나'.repeat(2000)) });
  for (let k = 0; k < 6; k += 1) i.sections.push({ id: 'big' + k, type: 'column', tiers: 'all', title: 'x', paragraphs: Array.from({ length: 20 }, () => '다'.repeat(2000)) });
  assert.ok(errs(i).some((e) => /400KB/.test(e)));
});

t('학년대 선택 — 자기 학년대 섹션 + all 만, 원래 순서 그대로', () => {
  const e2 = L.forTier(SAMPLE, 'E2');
  assert.deepEqual(e2.sections.map((s) => s.id), ['read-e2', 'words', 'brain-e2', 'mission', 'column', 'coach-e2', 'notice']);
  assert.equal(e2.tier, 'E2');
  const k = L.forTier(SAMPLE, 'K');
  assert.ok(!k.sections.some((s) => s.type === 'words'), '유치부에는 한자어 낱말 가족이 없다');
  assert.ok(k.sections.some((s) => s.id === 'read-k') && k.sections.some((s) => s.id === 'brain-k'));
  assert.equal(L.forTier(null, 'K'), null);
});

t('가시성 — published 이고 발행일이 오늘(KST) 이하일 때만', () => {
  assert.equal(L.isVisible(SAMPLE, '2026-09-21'), true);
  assert.equal(L.isVisible(SAMPLE, '2026-09-20'), false);
  assert.equal(L.isVisible({ ...SAMPLE, status: 'draft' }, '2026-12-31'), false);
  assert.equal(L.isVisible({ ...SAMPLE, publishAt: 'nope' }, '2026-12-31'), false);
});

t('렌더러 — 학년대 섹션만, 모든 문자열 이스케이프, 앱 모드는 버튼·인쇄 모드는 정답 별지', () => {
  const i = clone(SAMPLE);
  i.title = '<script>alert(1)</script> 가을';
  i.sections[0].paragraphs[0] = '여름에 <b>잎</b>은 "초록"이에요';
  i.sections[0].questions[0].choices[0] = '초록색 <img src=x onerror=alert(1)>';
  const app = L.renderIssue(i, 'K', { mode: 'app' });
  assert.ok(!/<script>/.test(app) && /&lt;script&gt;/.test(app), '제목이 그대로 HTML 로 들어갔다');
  assert.ok(!/<b>잎<\/b>/.test(app) && !/<img/.test(app));
  assert.ok(/data-q="read-k:0:0"/.test(app), '앱 모드는 보기 버튼');
  assert.ok(/data-ans="brain-k:0"/.test(app) && /data-chk="mission:0"/.test(app));
  assert.ok(/id="sec-read-k"/.test(app) && !/id="sec-read-m"/.test(app) && !/id="sec-words"/.test(app), '유치부 화면에 다른 학년대 글이 섞였다');
  assert.ok(/data-tier="K"/.test(app));
  assert.ok(/처리속도 PSI/.test(app), '두뇌 놀이에 웩슬러 지표 라벨');
  const print = L.renderIssue(i, 'M', { mode: 'print' });
  assert.ok(!/<button/.test(print), '인쇄본에는 버튼이 없다');
  assert.ok(/정답과 해설/.test(print) && /nl-key/.test(print), '인쇄본 마지막에 정답 별지');
  assert.ok(/답: ______/.test(print));
  const noKey = L.renderIssue(i, 'M', { mode: 'print', key: false });
  assert.ok(!/정답과 해설/.test(noKey), '정답 없이 인쇄');
  /* 상태 — 고른 보기·펼친 정답·미션 체크가 다시 그려진다 */
  const st = { quiz: { 'read-k:0': 1 }, reveal: { 'brain-k:0': true }, checks: { 'mission:1': true } };
  const withState = L.renderIssue(i, 'K', { mode: 'app', state: st });
  assert.ok(/class="nl-choice ok"[^>]*data-q="read-k:0:0"/.test(withState), '정답 보기에 ok');
  assert.ok(/class="nl-choice no"[^>]*data-q="read-k:0:1"/.test(withState), '고른 오답에 no');
  assert.ok(/정답은 ①이에요/.test(withState));
  assert.ok(/nl-ans">7개/.test(withState), '펼친 정답');
  assert.ok(/data-chk="mission:1" checked/.test(withState));
  assert.equal(L.renderIssue(null, 'K'), '');
  /* 학년대를 안 주면 전체(관리 미리보기 all) */
  const all = L.renderIssue(SAMPLE, null, { mode: 'print' });
  assert.ok(/id="sec-read-k"/.test(all) && /id="sec-read-m"/.test(all));
});

t('빈 템플릿 — 주차에서 발행일(월요일)을 채우고 섹션 종류가 전부 한 번씩', () => {
  const b = L.blankIssue('2026-W40');
  assert.equal(b.id, '2026-W40'); assert.equal(b.publishAt, '2026-09-28'); assert.equal(b.status, 'draft');
  const types = new Set(b.sections.map((s) => s.type));
  L.SECTION_TYPES.forEach((tp) => assert.ok(types.has(tp), tp));
  assert.ok(errs(b).length > 0, '빈 템플릿은 그대로 발행되지 않는다');
  assert.ok(/^\d{4}-W\d{2}$/.test(L.blankIssue('bad').week), '엉뚱한 주차면 이번 주');
});

t('공용 CSS 에 인쇄 규칙(A4·별지 새 쪽)이 있다', () => {
  assert.ok(/@media print/.test(L.CSS) && /@page\{size:A4/.test(L.CSS) && /nl-key\{break-before:page/.test(L.CSS));
});

console.log(`\nOK — ${passed}개 통과 (${path.basename(__filename)})`);
