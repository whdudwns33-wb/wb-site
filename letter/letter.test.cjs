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
  const bi = SAMPLE.sections[brain].items.findIndex((it) => !it.figure && !it.drill);   // 생성기 항목(figure·drill)은 answer 가 없어도 된다
  assert.ok(bad((i) => { i.sections[brain].items[bi].answer = ''; }).some((e) => /answer/.test(e)));
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
  assert.deepEqual(e2.sections.map((s) => s.id), ['read-e2', 'words', 'brain-e2', 'mission', 'column', 'coach-e2', 'poem', 'talk', 'write-e2', 'books', 'voices', 'news']);
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
  assert.ok(!/<b>잎<\/b>/.test(app) && !/<img src=x/.test(app), '보기 문자열의 img 태그가 그대로 들어갔다');
  assert.ok(/data-q="read-k:0:0"/.test(app), '앱 모드는 보기 버튼');
  assert.ok(/data-ans="brain-k:0"/.test(app) && /data-chk="mission:0"/.test(app));
  assert.ok(/np-mast/.test(app) && /제39호/.test(app) && /2026년 9월 21일 월요일/.test(app) && /유치판/.test(app), '제호·발행선');
  assert.ok(/id="sec-read-k"/.test(app) && !/id="sec-read-m"/.test(app) && !/id="sec-words"/.test(app), '유치부 화면에 다른 학년대 글이 섞였다');
  assert.ok(/data-tier="K"/.test(app));
  assert.ok(/처리속도<\/b> PSI/.test(app), '두뇌 놀이에 웩슬러 지표 라벨');
  const print = L.renderIssue(i, 'M', { mode: 'print' });
  assert.ok(!/<button/.test(print), '인쇄본에는 버튼이 없다');
  assert.ok(/정답과 해설/.test(print) && /np-key/.test(print), '인쇄본 마지막에 정답 별지');
  assert.ok(/답 ______/.test(print));
  const noKey = L.renderIssue(i, 'M', { mode: 'print', key: false });
  assert.ok(!/정답과 해설/.test(noKey), '정답 없이 인쇄');
  /* 상태 — 고른 보기·펼친 정답·미션 체크가 다시 그려진다 */
  const st = { quiz: { 'read-k:0': 1 }, reveal: { 'brain-k:1': true }, checks: { 'mission:1': true } };
  const withState = L.renderIssue(i, 'K', { mode: 'app', state: st });
  assert.ok(/class="np-choice ok"[^>]*data-q="read-k:0:0"/.test(withState), '정답 보기에 ok');
  assert.ok(/class="np-choice no"[^>]*data-q="read-k:0:1"/.test(withState), '고른 오답에 no');
  assert.ok(/정답은 ①이에요/.test(withState));
  assert.ok(/np-ans">7개/.test(withState), '펼친 정답');
  assert.ok(/data-chk="mission:1" checked/.test(withState));
  assert.equal(L.renderIssue(null, 'K'), '');
  /* 학년대를 안 주면 전체(관리 미리보기 all) */
  const all = L.renderIssue(SAMPLE, null, { mode: 'print' });
  assert.ok(/id="sec-read-k"/.test(all) && /id="sec-read-m"/.test(all));
});

t('사진 — id 또는 file 중 하나, alt·credit 필수, 3장 이내; 렌더러는 figure/figcaption 으로 그린다', () => {
  const i = clone(SAMPLE);
  const rd = i.sections.find((s) => s.id === 'read-e2');
  rd.image = { file: 'leaf-autumn.svg', alt: '노랗고 붉게 물든 잎 세 장', caption: '가을 잎', credit: 'WB 자체 제작 삽화' };
  assert.deepEqual(errs(i), []);
  const html = L.renderIssue(i, 'E2', { mode: 'app' });
  assert.ok(/<figure class="np-photo" data-zoom="1"><img src="img\/leaf-autumn\.svg" alt="노랗고 붉게 물든 잎 세 장" loading="lazy" decoding="async">/.test(html));
  assert.ok(!/data-zoom/.test(L.renderIssue(i, 'E2', { mode: 'print' })), '인쇄본에는 돋보기 표시가 없다');
  assert.ok(/np-credit">WB 자체 제작 삽화/.test(html));
  assert.ok(/src="\/letter\/img\/leaf-autumn\.svg"/.test(L.renderIssue(i, 'E2', { mode: 'app', imgBase: '/letter/img/' })), '관리 미리보기는 절대 경로');
  rd.image = { id: 'a'.repeat(32), alt: 'x', credit: 'WB 촬영' };
  assert.deepEqual(errs(i), []);
  assert.ok(/src="\/api\/letter\/img\/a{32}"/.test(L.renderIssue(i, 'E2', { mode: 'app' })), '올린 사진은 API 경로');
  rd.image = { id: 'a'.repeat(32), file: 'x.svg', alt: 'x', credit: 'c' };
  assert.ok(errs(i).some((e) => /하나만/.test(e)));
  rd.image = { file: 'x.svg', alt: 'x' };
  assert.ok(errs(i).some((e) => /credit/.test(e)), '출처 없는 사진은 저장되지 않는다');
  rd.image = { file: '../x.svg', alt: 'x', credit: 'c' };
  assert.ok(errs(i).some((e) => /하나만/.test(e)), '경로 조작은 파일 이름 규칙에서 걸린다');
  rd.image = { file: 'x.svg', alt: '<b>x</b>', credit: 'c' };
  assert.ok(!/<b>x<\/b>/.test(L.renderIssue(i, 'E2', { mode: 'app' })), 'alt 도 이스케이프');
  rd.image = null;
  rd.images = [{ file: 'a.svg', alt: 'a', credit: 'c' }, { file: 'b.svg', alt: 'b', credit: 'c' }, { file: 'c.svg', alt: 'c', credit: 'c' }, { file: 'd.svg', alt: 'd', credit: 'c' }];
  assert.ok(errs(i).some((e) => /3장/.test(e)));
  rd.images = rd.images.slice(0, 2);
  assert.deepEqual(errs(i), []);
  assert.ok(/np-gallery/.test(L.renderIssue(i, 'E2', { mode: 'app' })));
  const ck = i.sections.find((s) => s.type === 'checklist'); ck.image = { file: 'a.svg', alt: 'a', credit: 'c' };
  assert.deepEqual(errs(i), [], '미션 섹션의 image 는 무시된다(검사하지 않음)');
  i.cover = { file: 'cover.svg', alt: '표지', credit: 'WB' };
  assert.ok(/np-cover/.test(L.renderIssue(i, 'K', { mode: 'app' })), '표지 사진은 1면 머리기사 아래');
});

t('도형 놀이 — figure 는 생성기가 그리고 답을 정한다; JSON 의 answer 가 다르면 오류', () => {
  const i = clone(SAMPLE);
  const br = i.sections.find((s) => s.id === 'brain-e1');
  br.index = 'VSI';
  br.items = [{ figure: { kind: 'mirror', seed: 12 } }, { figure: { kind: 'blocks', seed: 3 }, prompt: '몇 개?' }];
  assert.deepEqual(errs(i), [], 'answer 를 비우면 자동');
  const S = require('./shapes.js');
  const g = S.make({ kind: 'mirror', seed: 12, tier: 'E1' });
  br.items[0].answer = g.answerText;
  assert.deepEqual(errs(i), []);
  br.items[0].answer = g.answerText === '①' ? '②' : '①';
  assert.ok(errs(i).some((e) => /생성기와 다릅니다/.test(e)));
  br.items[0].answer = '';
  br.items[0].figure = { kind: 'zzz', seed: 1 };
  assert.ok(errs(i).some((e) => /figure/.test(e)));
  br.items[0].figure = { kind: 'mirror', seed: 12 };
  const html = L.renderIssue(i, 'E1', { mode: 'app', state: { reveal: { 'brain-e1:0': true } } });
  assert.ok(/np-fig-target/.test(html) && (html.match(/np-fig-opt"/g) || []).length === 4, '과녁 + 보기 4');
  assert.ok(new RegExp('np-ans">' + g.answerText).test(html), '펼친 정답은 생성기 답');
  assert.ok(/몇 개\?/.test(html) && /<polygon/.test(html), '쌓기나무');
  const key = L.renderIssue(i, 'E1', { mode: 'print' });
  assert.ok(new RegExp('<li>' + g.answerText).test(key), '별지에도 생성기 답');
});

t('지표 순환 — 같은 주에 다섯 학년대가 서로 다른 지표, 5주에 학년대마다 다섯 지표가 한 번씩; 달력이 덮어쓴다', () => {
  assert.deepEqual(L.rotationFor('2026-W39'), { K: 'PSI', E1: 'VSI', E2: 'WMI', E3: 'FRI', M: 'VCI' });
  for (let k = 0; k < 8; k += 1) {
    const w = L.nextWeek('2026-W39') && (k === 0 ? '2026-W39' : L.weekId(Date.parse(L.weekStart('2026-W39') + 'T12:00:00Z') + k * 7 * 86400000));
    const r = L.rotationFor(w);
    assert.equal(new Set(Object.values(r)).size, 5, w + ' 같은 주 다섯 학년대가 겹친다');
  }
  L.TIER_IDS.forEach((t) => {
    const seen = new Set();
    for (let k = 0; k < 5; k += 1) seen.add(L.rotationFor(L.weekId(Date.parse('2026-09-21T12:00:00Z') + k * 7 * 86400000))[t]);
    assert.equal(seen.size, 5, t + ' 5주에 다섯 지표');
  });
  assert.equal(L.rotationFor('bad'), null);
  const cal = { weeks: { '2026-W40': { theme: '가을 곤충의 겨울나기', notes: '휴원 안내', indices: { K: 'VSI' } } } };
  const e = L.calendarEntry(cal, '2026-W40');
  assert.equal(e.theme, '가을 곤충의 겨울나기'); assert.equal(e.indices.K, 'VSI'); assert.equal(e.indices.M, 'VSI' === e.indices.K ? L.rotationFor('2026-W40').M : e.indices.M); assert.equal(e.monday, '2026-09-28'); assert.equal(e.hasTheme, true);
  assert.equal(L.calendarEntry(cal, '2026-W41').hasTheme, false);
  assert.deepEqual(L.checkCalendar(cal), []);
  assert.ok(L.checkCalendar({ weeks: { 'W40': {} } }).length && L.checkCalendar({ weeks: { '2026-W40': { indices: { K: 'IQ' } } } }).length && L.checkCalendar(null).length);
  assert.equal(L.nextWeek('2026-W52'), '2026-W53', '2026년은 53주');
  assert.equal(L.nextWeek('2026-W53'), '2027-W01');
});

t('빈 템플릿 — 주차에서 발행일(월요일)을 채우고 섹션 종류가 전부 한 번씩', () => {
  const b = L.blankIssue('2026-W40');
  assert.equal(b.id, '2026-W40'); assert.equal(b.publishAt, '2026-09-28'); assert.equal(b.status, 'draft');
  const types = new Set(b.sections.map((s) => s.type));
  L.SECTION_TYPES.forEach((tp) => assert.ok(types.has(tp), tp));
  assert.ok(errs(b).length > 0, '빈 템플릿은 그대로 발행되지 않는다');
  const vsi = b.sections.filter((s) => s.type === 'brain').find((s) => s.index === 'VSI');
  assert.ok(vsi && vsi.items[0].figure, '순환상 시공간 차례인 학년대는 도형 놀이 자리로 시작한다');
  assert.ok(/^\d{4}-W\d{2}$/.test(L.blankIssue('bad').week), '엉뚱한 주차면 이번 주');
});

t('공용 CSS 에 인쇄 규칙(A4·별지 새 쪽)과 2단 신문 짜임이 있다', () => {
  assert.ok(/@media print/.test(L.CSS) && /@page\{size:A4/.test(L.CSS) && /np-key\{break-before:page/.test(L.CSS));
  assert.ok(/@media\(min-width:640px\)\{\.np-top\{grid-template-columns/.test(L.CSS), '넓은 화면·A4 에서 본문·옆단 2단');
});


t('사진 크기(w·h) — 한 쌍이어야 하고, 렌더러는 width/height 와 aspect-ratio 로 자리를 먼저 잡는다', () => {
  const i = clone(SAMPLE); const rd = i.sections.find((s) => s.id === 'read-e2');
  rd.image = { file: 'leaf-autumn.svg', alt: 'x', credit: 'WB', w: 1600, h: 1067 };
  assert.deepEqual(errs(i), []);
  assert.ok(/width="1600" height="1067" style="aspect-ratio:1600\/1067"/.test(L.renderIssue(i, 'E2', { mode: 'app' })));
  delete rd.image.h; assert.ok(errs(i).some((e) => /w·h/.test(String(e.msg || e))), '한쪽만 있으면 오류');
  rd.image.h = 0; assert.ok(errs(i).some((e) => /w·h/.test(String(e.msg || e))));
});

t('교육·입시 이슈(news) — 제목·요약·출처 필수, 링크는 https 만; 앱은 링크, 인쇄는 출처명만', () => {
  const i = clone(SAMPLE);
  assert.ok(i.sections.some((s) => s.type === 'news'), '샘플 호에 이슈 섹션이 있다');
  i.sections = i.sections.filter((s) => s.type !== 'news');
  const n = { id: 'news', type: 'news', tiers: 'all', title: '이번 주 교육·입시 이슈', items: [{ title: '예시 제목', summary: '예시 요약.', why: '예시 뜻.', source: '예시 기관', url: 'https://example.com/x', date: '2026-09-18' }] };
  i.sections.push(n);
  assert.deepEqual(errs(i), []);
  const app = L.renderIssue(i, 'M', { mode: 'app' });
  assert.ok(/np-news/.test(app) && /이번 주 교육·입시 이슈/.test(app) && /우리 아이에게 — 예시 뜻\./.test(app));
  assert.ok(/<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">예시 기관 · 2026-09-18 ↗<\/a>/.test(app));
  assert.ok(!/<a href/.test(L.renderIssue(i, 'M', { mode: 'print' })), '인쇄본에는 링크가 없다');
  n.items[0].url = 'http://example.com/x'; assert.ok(errs(i).some((e) => /https/.test(String(e.msg || e))));
  n.items[0].url = ''; n.items[0].source = ''; assert.ok(errs(i).some((e) => /source/.test(String(e.msg || e))));
  n.items[0].source = '예시 기관'; n.items[0].date = '2026-13-01'; assert.ok(errs(i).some((e) => /date/.test(String(e.msg || e))));
  n.items[0].date = ''; n.items = []; assert.ok(errs(i).some((e) => /1~6개/.test(String(e.msg || e))));
  assert.ok(L.blankIssue('2026-W40').sections.some((s) => s.type === 'news'), '빈 템플릿에도 이슈 자리가 있다');
});

t('하루 한 장 — 발행일이 1일째, 7일에 나눠 읽고, 그 학년대에 없는 날은 읽을거리를 다시 읽는다', () => {
  const at = (d) => Date.parse(d + 'T03:00:00Z');   // KST 정오
  assert.equal(L.dayOf(SAMPLE, at('2026-09-21')), 1);
  assert.equal(L.dayOf(SAMPLE, at('2026-09-24')), 4);
  assert.equal(L.dayOf(SAMPLE, at('2026-09-10')), 1, '발행 전은 1일째');
  assert.equal(L.dayOf(SAMPLE, at('2026-10-30')), 7, '지난 호는 7일째에 머문다');
  assert.equal(L.dayDate(SAMPLE, 3), '2026-09-23'); assert.equal(L.dayDow(SAMPLE, 3), '수');
  assert.equal(L.DAY_PLAN.length, 7);
  const d1 = L.dayPage(SAMPLE, 'E2', 1); assert.deepEqual(d1.items.map((x) => x.part), ['lead', 'read', 'poem', 'talk', 'daily']); assert.equal(d1.items[1].opts.noQuiz, true);
  const d2 = L.dayPage(SAMPLE, 'E2', 2); assert.equal(d2.items[0].opts.foldText, true); assert.deepEqual(d2.items.map((x) => x.part), ['read', 'write', 'daily']);
  assert.deepEqual(L.dayPage(SAMPLE, 'E2', 3).items.map((x) => x.part), ['words', 'cloze', 'daily']);
  assert.deepEqual(L.dayPage(SAMPLE, 'E2', 6).items.map((x) => x.part), ['checklist', 'voices', 'daily']);
  assert.ok(!L.dayPage(SAMPLE, 'E2', 7).items.some((x) => x.part === 'daily'), '7일째엔 오늘의 5분이 없다');
  const d5 = L.dayPage(SAMPLE, 'E2', 5); assert.deepEqual(d5.items.map((x) => x.part), ['column', 'news', 'books', 'coach', 'daily']);
  const noVocab = clone(SAMPLE); noVocab.sections.find((x) => x.id === 'read-k').vocab = [];
  const k3 = L.dayPage(noVocab, 'K', 3); assert.equal(k3.again, true, '유치부는 한자 코너도 낱말 복습도 없으면 읽을거리를 다시 읽는다'); assert.equal(k3.items[0].section.id, 'read-k');
  assert.ok(L.dayPage(SAMPLE, 'K', 3).items.some((x) => x.part === 'cloze'), '낱말 노트가 있으면 유치부도 낱말 복습');
  /* day 지정 — 종류로 정한 날 대신 그날에 */
  const moved = clone(SAMPLE); moved.sections.find((x) => x.id === 'write-e2').day = 6;
  assert.ok(!L.dayPage(moved, 'E2', 2).items.some((x) => x.part === 'write') && L.dayPage(moved, 'E2', 6).items.some((x) => x.part === 'write'));
  moved.sections.find((x) => x.id === 'write-e2').day = 9; assert.ok(errs(moved).some((e) => /day 는 1~7/.test(String(e.msg || e))));
  assert.equal(L.dayPage(SAMPLE, 'E2', 7).items[0].part, 'review');
});

t('하루 한 장 렌더 — 1일째는 문제 없이, 2일째는 본문을 접고 문제만, 7일째는 내 답·정답·점수; 띠는 오늘·마침·미래를 구분', () => {
  const st = { quiz: { 'read-e2:0': 0, 'read-e2:1': 3 }, checks: { 'mission:0': true }, days: { 1: '2026-09-21T01:00:00Z' } };
  const d1 = L.renderDay(SAMPLE, 'E2', 1, { mode: 'app', state: st });
  assert.ok(/np-daily/.test(d1) && /data-day="1"/.test(d1) && /1일째/.test(d1) && /np-lead/.test(d1) && /np-cover/.test(d1));
  assert.ok(!/np-qs/.test(d1), '1일째엔 문제가 없다'); assert.ok(/data-tts="read-e2"/.test(d1), '읽어 주기 단추'); assert.ok(/data-p="read-e2:0"/.test(d1), '문단마다 낭독 표식');
  const d2 = L.renderDay(SAMPLE, 'E2', 2, { mode: 'app', state: st });
  assert.ok(/<details class="np-fold">/.test(d2) && /np-qs/.test(d2) && !/data-tts=/.test(d2));
  const d3 = L.renderDay(SAMPLE, 'E2', 3, { mode: 'app', state: st });
  assert.ok(/np-trace" data-trace="色"/.test(d3), '한자 따라쓰기 칸');
  assert.ok(!/np-trace/.test(L.renderDay(SAMPLE, 'E2', 3, { mode: 'app', state: st, noTrace: true })), '관리 미리보기는 뺄 수 있다');
  const d7 = L.renderDay(SAMPLE, 'E2', 7, { mode: 'app', state: st, nextTheme: '달의 모양' });
  assert.ok(/np-review/.test(d7) && /<b>1<\/b>\/4/.test(d7) && /아직 안 푼 문제가 2개/.test(d7) && /다음 주 예고/.test(d7) && /달의 모양/.test(d7));
  assert.ok(/<b>1<\/b>\/5<span>마친 미션/.test(d7));
  const strip = L.renderDayStrip(SAMPLE, 3, 4, st);
  assert.equal((strip.match(/class="np-sday/g) || []).length, 7);
  assert.ok(/np-sday done" data-day="1"/.test(strip) && /np-sday cur" data-day="3"/.test(strip) && /np-sday future" data-day="5"/.test(strip));
  assert.ok(!/data-tts=|np-trace|data-zoom/.test(L.renderIssue(SAMPLE, 'E2', { mode: 'print' })), '인쇄본에는 단추·캔버스·돋보기가 없다');
  assert.ok(/mix-blend-mode:multiply/.test(L.CSS) && /aspect-ratio:16\/10/.test(L.CSS) && /scroll-snap-type/.test(L.CSS), '앱 사진 규칙(종이 질감·표지 비율·스냅 갤러리)');
});


t('고정 코너 — 시(낭독·필사)·가족 대화 카드·한 문장 쓰기·책 한 권·독자의 답: 검증 규칙과 렌더', () => {
  const i = clone(SAMPLE);
  assert.deepEqual(errs(i), []);
  const app = L.renderDay(i, 'E2', 1, { mode: 'app', state: {} });
  assert.ok(/np-poem/.test(app) && /data-tts="poem"/.test(app) && /data-p="poem:0"/.test(app), '시는 행마다 낭독 표식');
  assert.ok(/np-bubble/.test(app), '대화 카드');
  const d2 = L.renderDay(i, 'E2', 2, { mode: 'app', state: { write: { 'write-e2:0': '잎이 <색>을 바꿔요' } } });
  assert.ok(/<textarea class="np-ta" data-write="write-e2:0"[^>]*>잎이 &lt;색&gt;을 바꿔요<\/textarea>/.test(d2), '쓴 글은 이스케이프해서 되살린다');
  const pr = L.renderIssue(i, 'E2', { mode: 'print' });
  assert.ok(!/<textarea/.test(pr) && /np-lines-tall/.test(pr), '인쇄본은 쓸 줄');
  const d5 = L.renderDay(i, 'E2', 5, { mode: 'app', state: {} });
  assert.ok(/np-books/.test(d5) && /강아지똥/.test(d5) && /np-for/.test(d5));
  const d6 = L.renderDay(i, 'E2', 6, { mode: 'app', state: {} });
  assert.ok(/np-voices/.test(d6) && /np-quote/.test(d6));
  /* 규칙 */
  const bad = clone(SAMPLE);
  bad.sections.find((x) => x.id === 'poem').lines = []; assert.ok(errs(bad).some((e) => /lines/.test(String(e.msg || e))));
  const b2 = clone(SAMPLE); b2.sections.find((x) => x.id === 'write-e2').prompts = [{ q: '' }]; assert.ok(errs(b2).some((e) => /prompts\[0\]/.test(String(e.msg || e))));
  const b3 = clone(SAMPLE); b3.sections.find((x) => x.id === 'books').items[0].why = ''; assert.ok(errs(b3).some((e) => /why/.test(String(e.msg || e))));
  const b4 = clone(SAMPLE); b4.sections.find((x) => x.id === 'voices').items[0].who = 'x'.repeat(21); assert.ok(errs(b4).some((e) => /who/.test(String(e.msg || e))));
  const b5 = clone(SAMPLE); b5.sections.find((x) => x.id === 'talk').items = []; assert.ok(errs(b5).some((e) => /items/.test(String(e.msg || e))));
  assert.deepEqual(L.SECTION_TYPES.slice(-5), ['poem', 'talk', 'write', 'books', 'voices']);
});

t('5분 놀이(drill) — 두뇌 놀이 항목에 seed 만 싣고 답은 생성기가; 지표가 다르면 경고, 답이 다르면 오류', () => {
  const D = require('./drills.js');
  const i = clone(SAMPLE);
  const b = i.sections.find((x) => x.id === 'brain-e2');
  assert.ok(b.items.some((it) => it.drill && it.drill.kind === 'span'), '샘플 E2 두뇌 놀이에 거꾸로 말하기 생성기');
  const app = L.renderIssue(i, 'E2', { mode: 'app' });
  assert.ok(/np-dr-seq/.test(app), '숫자열이 그려진다');
  const g = D.make({ kind: 'span', seed: 12, tier: 'E2' });
  assert.ok(L.renderIssue(i, 'E2', { mode: 'print' }).includes(g.answerText), '정답 별지에 생성기 답');
  b.items[0].answer = '1 – 2'; assert.ok(errs(i).some((e) => /생성기와 다릅니다/.test(String(e.msg || e))));
  b.items[0].answer = g.answerText; assert.deepEqual(errs(i), []);
  b.items[0].drill = { kind: 'nope', seed: 1 }; assert.ok(errs(i).some((e) => /drill 은/.test(String(e.msg || e))));
  b.items[0].drill = { kind: 'symbols', seed: 3 }; delete b.items[0].answer;
  const w = L.checkIssue(i).warnings; assert.ok(w.some((x) => /놀이 종류\(PSI\)가 섹션 지표\(WMI\)/.test(x.msg)), '지표 불일치 경고');
});

t('낱말 복습(cloze) — 낱말 노트에서 저절로, 같은 seed 면 같은 문제, 3일째에 실리고 답이 기록된다', () => {
  const rd = SAMPLE.sections.find((x) => x.id === 'read-e2');
  const a = L.clozeFor(rd, 5), b = L.clozeFor(rd, 5);
  assert.deepEqual(a, b); assert.ok(a.length >= 3 && a.length <= 4);
  a.forEach((q) => { assert.ok(q.q.includes('____')); assert.equal(q.choices.length, 4); assert.ok(q.answer >= 0 && q.answer < 4); assert.ok(!q.q.includes(q.choices[q.answer]), '빈칸 문장에 답이 남아 있지 않다'); });
  assert.deepEqual(L.clozeFor({ paragraphs: ['x'], vocab: [{ word: 'a', easy: 'b' }] }, 1), [], '낱말이 둘 미만이면 없다');
  const d3 = L.renderDay(SAMPLE, 'E2', 3, { mode: 'app', state: {} });
  assert.ok(/np-cloze/.test(d3) && /data-q="cloze-read-e2:0:0"/.test(d3));
  const items = L.clozeFor(rd, L.weekIndex('2026-W39') || 1);
  const st = { quiz: { 'cloze-read-e2:0': items[0].answer } };
  assert.ok(/맞았어요!/.test(L.renderDay(SAMPLE, 'E2', 3, { mode: 'app', state: st })));
  assert.ok(/<b>1<\/b>\/1<span>낱말 복습/.test(L.renderDay(SAMPLE, 'E2', 7, { mode: 'app', state: st })), '되돌아보기에 낱말 복습 점수');
});

t('오늘의 5분 — 1~6일째 매일 같은 자리에, 주차·학년대·요일이 문제를 정하고 정답 보기가 기록된다', () => {
  const D = require('./drills.js');
  for (let d = 1; d <= 6; d++) {
    const h = L.renderDay(SAMPLE, 'E1', d, { mode: 'app', state: {} });
    assert.ok(/np-daily5/.test(h) && new RegExp('data-ans="daily-' + d + ':0"').test(h), d + '일째');
  }
  const dd = D.daily(SAMPLE.week, 'E1', 2), g = D.make(dd);
  const open = L.renderDay(SAMPLE, 'E1', 2, { mode: 'app', state: { reveal: { 'daily-2:0': true } } });
  assert.ok(open.includes(g.answerText) && /정답 숨기기/.test(open));
  assert.ok(!/np-daily5/.test(L.renderIssue(SAMPLE, 'E1', { mode: 'print' })), '인쇄본(신문)에는 없다');
});

t('되돌아보기 — 이번 주 내가 쓴 문장이 실린다', () => {
  const st = { write: { 'write-e2:0': '잎은 색소가 달라져서 색이 변해요' } };
  const h = L.renderDay(SAMPLE, 'E2', 7, { mode: 'app', state: st });
  assert.ok(/이번 주 내가 쓴 문장/.test(h) && /잎은 색소가 달라져서/.test(h));
  assert.ok(!/이번 주 내가 쓴 문장/.test(L.renderDay(SAMPLE, 'E2', 7, { mode: 'app', state: {} })));
});

t('파일럿 호 고르기 — 발행일이 지난 것 중 가장 최근 호, 아직이면 가장 이른 호를 미리, 초안은 절대 안 나간다', () => {
  const list = [
    { file: 'b.json', id: '2026-W41', publishAt: '2026-10-05', status: 'published' },
    { file: 'a.json', id: '2026-W40', publishAt: '2026-09-28', status: 'published' },
    { file: 'c.json', id: '2026-W42', publishAt: '2026-10-12', status: 'draft' },
  ];
  const at = (d) => L.pickPilot(list, d);
  assert.equal(at('2026-09-21').cur.id, '2026-W40', '아직 아무 호도 안 됐으면 가장 이른 호를 미리 보여 준다');
  assert.deepEqual(at('2026-09-21').list.map((b) => b.id), ['2026-W40']);
  assert.equal(at('2026-09-28').cur.id, '2026-W40', '발행일 당일부터 그 호');
  assert.equal(at('2026-10-04').cur.id, '2026-W40', '다음 호 발행일 전까지는 그대로');
  assert.equal(at('2026-10-05').cur.id, '2026-W41', '발행일이 되면 저절로 넘어간다');
  assert.deepEqual(at('2026-10-05').list.map((b) => b.id), ['2026-W41', '2026-W40'], '지난 호는 목록에 남고 최신이 위');
  assert.equal(at('2026-12-31').cur.id, '2026-W41', '초안(2026-W42)은 발행일이 지나도 열리지 않는다');
  assert.ok(at('2026-12-31').list.every((b) => b.status !== 'draft'));
  assert.equal(L.pickPilot([], '2026-10-05'), null);
  assert.equal(L.pickPilot([{ file: 'c.json', id: '2026-W42', publishAt: '2026-01-01', status: 'draft' }], '2026-10-05'), null, '초안뿐이면 없는 것과 같다 — 앱은 체험 호로 넘어간다');
  assert.equal(L.pickPilot([{ id: 'x' }, { file: 'd.json', publishAt: '나쁜날짜' }], '2026-10-05'), null, '파일·발행일이 없는 줄은 버린다');
});

console.log(`\nOK — ${passed}개 통과 (${path.basename(__filename)})`);
