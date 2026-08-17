const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'source block not found: ' + start);
  return html.slice(from, to);
};

const dateHelpers = `
  const ING_WEEK_DAYS = [1, 2, 3, 4, 5, 6, 0];
  function ymd(d) { const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function parseYmd(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); }
  function addDays(s,n) { const d=parseYmd(s); d.setDate(d.getDate()+n); return ymd(d); }
  function dowOf(s) { return parseYmd(s).getDay(); }
  function ingMinHm(value) { const n=Math.max(0,Math.min(1439,Math.round(value))); return String(Math.floor(n/60)).padStart(2,'0') + ':' + String(n%60).padStart(2,'0'); }
  function ingLectureSpan(lecture) { return Number(lecture._span) || Number(lecture.min) || 60; }
`;

test('smart paste parses common provider formats and rejects false headings', () => {
  const source = between('function ingParse(text) {', '\nfunction ingToggle(');
  const ingParse = Function(source + '\nreturn ingParse;')();
  const parsed = ingParse([
    '2026 수능 수학 강좌',
    '1강 다항식 52분',
    '02. 방정식 (51:20)',
    '[03강]\t부등식\t00:47:30',
    '4회 함수 45분 20초',
    '1강 중복 행 40분',
    '1 정승제',
    '2 이지영',
    '3 박광일',
    '고객센터 09:00',
    '0강 잘못된 회차 30분',
    '1000강 범위 밖 30분'
  ].join('\r\n'));

  assert.deepEqual(parsed.map(x => [x.seq, x.title, x.min]), [
    [1, '다항식', 52],
    [2, '방정식', 51],
    [3, '부등식', 48],
    [4, '함수', 45]
  ]);
});

test('quick creation builds a parseable 1-to-N curriculum without OCR', () => {
  const quickSource = between('function ingQuickText(', '\n\nfunction ingAssignModal(');
  const parseSource = between('function ingParse(text) {', '\nfunction ingToggle(');
  const api = Function(quickSource + '\n' + parseSource + '\nreturn { ingQuickText, ingParse };')();
  const text = api.ingQuickText(3, 50, '수학 개념');
  assert.equal(text, '1강 수학 개념 1 50분\n2강 수학 개념 2 50분\n3강 수학 개념 3 50분');
  assert.deepEqual(api.ingParse(text).map(x => [x.seq, x.title, x.min]), [
    [1, '수학 개념 1', 50], [2, '수학 개념 2', 50], [3, '수학 개념 3', 50]
  ]);
  assert.equal(api.ingQuickText(0, 50, '수학'), '');
  assert.equal(api.ingQuickText(1000, 50, '수학'), '');
  assert.equal(api.ingQuickText(3.5, 50, '수학'), '');
  assert.equal(api.ingQuickText(10, 9, '수학'), '');
  assert.equal(api.ingQuickText(10, 50.5, '수학'), '');
  assert.match(html, /id="ingQuickCount" type="number" min="1" max="999"/);
  assert.match(html, /id="ingQuickMin" type="number" min="10" max="240"/);
  assert.match(html, /case 'ingquick':[\s\S]*?confirm\('현재 커리큘럼을 빠른 생성 내용으로 바꿀까요\?'\)/);
});

test('free-time subtraction merges overlaps and packer uses exact-fit slots', () => {
  const freeSource = between('function ingFreeIntervals(', '\nfunction ingFreeForDate(');
  const packSource = between('function ingPackSchedule(', '\nfunction ingBuildSchedule(');
  const api = Function(`const ING_MIN_FREE=20; ${dateHelpers} ${freeSource} ${packSource}
    return { ingFreeIntervals, ingPackSchedule };`)();

  assert.deepEqual(api.ingFreeIntervals(540, 720, [
    { s: 580, e: 630 }, { s: 620, e: 670 }
  ]), [{ s: 540, e: 580 }, { s: 670, e: 720 }]);

  const exact = api.ingPackSchedule([{ seq: 1, title: '정확히 맞음', _span: 50 }],
    '2026-08-23', '2026-08-23', [0], 1,
    () => [{ s: 540, e: 580 }, { s: 600, e: 650 }], () => 0);
  assert.equal(exact.complete, true);
  assert.equal(exact.finishDate, '2026-08-23');
  assert.deepEqual(exact.items.map(x => [x.date, x.s, x.e]), [['2026-08-23', '10:00', '10:50']]);
});

test('fixed schedule, one-off timetable, and timed lectures all block the same free-time grid', () => {
  const freeSource = between('function ingFreeIntervals(', '\nfunction ingFreeForDate(');
  const forDateSource = between('function ingFreeForDate(', '\nfunction ingWeeklyFreeMin(');
  const ingFreeForDate = Function(`const ING_MIN_FREE=20; ${dateHelpers} ${freeSource}
    function ingAvail() { return { configured:true, start:'09:00', end:'12:00', blocks:[
      {id:'fixed',days:[0],s:'10:00',e:'10:30'}
    ] }; }
    function ingHmMin(value) { const [h,m]=String(value).split(':').map(Number); return Number.isFinite(h)&&Number.isFinite(m)?h*60+m:null; }
    function tbOf() { return [{s:'09:30',e:'10:00'}]; }
    function ingPlan() { return [{cid:'old',seq:1,done:false},{cid:'timed',seq:2,s:'11:00',e:'11:30'}]; }
    ${forDateSource}
    return ingFreeForDate;`)();

  assert.deepEqual(ingFreeForDate('s', '2026-08-23', true), [
    {s:540,e:570}, {s:630,e:660}, {s:690,e:720}
  ]);
});

test('packer includes Sunday and the goal day but never schedules after it', () => {
  const packSource = between('function ingPackSchedule(', '\nfunction ingBuildSchedule(');
  const ingPackSchedule = Function(`${dateHelpers} ${packSource}\nreturn ingPackSchedule;`)();
  const result = ingPackSchedule([
    { seq: 1, _span: 60 }, { seq: 2, _span: 60 }
  ], '2026-08-23', '2026-08-23', [0], 2, () => [{ s: 540, e: 600 }], () => 0);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].date, '2026-08-23');
  assert.equal(result.complete, false);
  assert.equal(result.remaining, 1);
  assert.equal(result.finishDate, null);

  const noDays = ingPackSchedule([{ seq: 1, _span: 20 }],
    '2026-08-23', '2026-08-23', [], 1, () => [{ s: 540, e: 600 }], () => 0);
  assert.equal(noDays.items.length, 0);
});

test('legacy assigned lectures are not duplicated and still use the daily limit', () => {
  const packSource = between('function ingPackSchedule(', '\nfunction ingBuildSchedule(');
  const buildSource = between('function ingBuildSchedule(', '\nfunction ingReplayRounds(');
  const ingBuildSchedule = Function(`${dateHelpers} ${packSource}
    function ingAssigned() { return { 'course|1': { date:'2026-08-23', done:false } }; }
    function ingAvail() { return { configured:true }; }
    function ingFreeForDate() { return [{ s:540, e:660 }]; }
    function ingPlan() { return [{ cid:'course', seq:1, done:false }]; }
    ${buildSource}
    return ingBuildSchedule;`)();

  const course = { id: 'course', lectures: [
    { seq: 1, title: '구형 배정', min: 50 }, { seq: 2, title: '새 배정', min: 50 }
  ] };
  const result = ingBuildSchedule('student', course, '2026-08-23', '2026-08-23', [0], 2);
  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map(x => x.seq), [2]);
  assert.equal(result.items[0].cid, 'course');
});

test('review count only includes fully schedulable repeat rounds', () => {
  const packSource = between('function ingPackSchedule(', '\nfunction ingBuildSchedule(');
  const replaySource = between('function ingReplayRounds(', '\nfunction ingForecast(');
  const ingReplayRounds = Function(`${dateHelpers} ${packSource}
    function today() { return '2026-08-17'; }
    function ingFreeForDate(_sid,date) { return date === '2026-08-19' ? [{s:540,e:590}] : [{s:540,e:600}]; }
    function ingPlan() { return []; }
    ${replaySource}
    return ingReplayRounds;`)();
  const course = { lectures: [{ seq: 1, min: 60 }] };

  assert.equal(ingReplayRounds('s', course, '2026-08-17', '2026-08-18', [1, 2], 1), 2);
  assert.equal(ingReplayRounds('s', course, '2026-08-17', '2026-08-19', [1, 2, 3], 1), 2,
    'the short final slot must not count as another full round');
  assert.equal(ingReplayRounds('s', course, '2026-08-10', '2026-08-18', [1, 2, 3, 4, 5, 6, 0], 1), 2,
    'past free time must not be counted as a future replay');
});

test('availability is opt-in and the planner UI is wired for students and directors', () => {
  const availSource = between('function ingAvail(sid) {', '\nfunction ingSaveAvail(');
  const ingAvail = Function(`
    let state={checks:{}};
    const ingAvailKey=sid=>'__ingavail__'+sid;
    function ingHmMin(value) { const m=String(value||'').match(/^(\\d{2}):(\\d{2})$/); if(!m)return null; const h=Number(m[1]),n=Number(m[2]); return h<24&&n<60?h*60+n:null; }
    ${availSource}
    return { read: ingAvail, state };`)();
  assert.equal(ingAvail.read('s').configured, false);
  ingAvail.state.checks['__ingavail__s|all'] = { avail: { configured:true, start:'08:00', end:'22:00', blocks:[] } };
  assert.equal(ingAvail.read('s').configured, true);

  assert.match(html, /const ING_WEEK_DAYS = \[1, 2, 3, 4, 5, 6, 0\]/);
  assert.match(html, /주간 일정과 빈 시간/);
  assert.match(html, /id="ingAvailStart" type="time"/);
  assert.match(html, /id="ingEnd" value=[\s\S]*?type="date"|type="date" id="ingEnd"|id="ingEnd"[^>]*type="date"/);
  assert.match(html, /완강 예상/);
  assert.match(html, /예상 전환/);
  assert.match(html, /총 ' \+ f\.rounds \+ '회독 가능/);
  assert.match(html, /가용시간 부족/);
  assert.match(html, /session\.isStaffLink \|\| admin/);
  assert.match(html, /if \(!\(session\.isAdmin \|\| isManager\(\)\)\) break/);
  assert.match(html, /x\.type === 'free' && canManage && date >= today\(\)/);
  assert.match(html, /if \(start < today\(\)\) return \{ error: '시작일은 오늘 이후로 선택해 주세요' \}/);
  assert.match(html, /ingPlan\(me\.id, d\)\.concat\(buckets\[d\]\)/);
  assert.match(html, /!ds\.length && data\.result\.remaining/);
  assert.match(html, /@media \(max-width: 640px\)[\s\S]*?\.ing-week \{ grid-template-columns: 1fr; min-width: 0; \}/);
});

test('five official course sites have safe direct links and smart-paste fallback', () => {
  const expected = {
    '이투스': 'https://www.etoos.com/lecture/TotalLecture.asp',
    '메가스터디': 'https://www.megastudy.net/lecbookSearch/main.asp',
    '대성마이맥': 'https://www.mimacstudy.com/common/getMenuContainer.ds?requestMenuId=MNMN_M004',
    '엠베스트': 'https://www.mbest.co.kr/lecture/coursemap/main.asp',
    '엘리하이': 'https://mjr.mbest.co.kr/lecture/list/lecture_list.asp'
  };
  const providerSource = between('const ING_PROVIDER_URLS = {', '\nconst ING_PROVIDER_DOMAINS');
  const providers = Function(providerSource + '\nreturn ING_PROVIDER_URLS;')();
  assert.deepEqual(providers, expected);
  const domainSource = between('const ING_PROVIDER_DOMAINS = {', '\nconst ING_LATE_WARN');
  const matchSource = between('function ingProviderUrlMatches(', '\n\nconst ingKey');
  const matches = Function(domainSource + '\n' + matchSource + '\nreturn ingProviderUrlMatches;')();
  assert.equal(matches('이투스', 'https://m.etoos.com/course/1'), true);
  assert.equal(matches('이투스', 'https://example.com/course/1'), false);
  assert.equal(matches('엠베스트', 'https://junior.mbest.co.kr/course/1'), false);
  assert.equal(matches('엠베스트', 'https://mjr.mbest.co.kr/course/1'), false);
  assert.equal(matches('엘리하이', 'https://mjr.mbest.co.kr/course/1'), true);
  assert.equal(matches('엘리하이', 'https://junior.mbest.co.kr/course/1'), true);
  assert.equal(matches('기타', 'https://example.com/course/1'), true);
  const modal = between('function ingAddModal()', '\nfunction ingShowParsePreview(');
  assert.match(modal, /target="_blank" rel="noopener noreferrer"/);
  assert.match(modal, /사이트 열기 → 로그인 → 강좌 상세의 강의목차 전체 복사/);
  assert.match(modal, /data-act="ingpaste"/);
  assert.doesNotMatch(modal, /iframe|type="password"|document\.cookie/i);
  assert.doesNotMatch(modal, /\/search|\/curriculum|data-act="ingfetch"|data-act="ingsearch"/);
  assert.match(html, /box\.textContent = parsed\.length/);
  assert.match(html, /sourceUrl: sourceUrl/);
  assert.match(html, /case 'ingprovider':[\s\S]*?c\.dataset\.v === el\.dataset\.v/);
  assert.match(html, /const SYNC_APP = 'consult'/);
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
});

test('every rendered ingang action has one event case', () => {
  const area = between('const ING_PLATFORMS', '/* ══════════════════════════════════════════════════════\n   타임블록');
  const rendered = new Set([...area.matchAll(/data-act="(ing[a-z]+)"/g)].map(x => x[1]));
  rendered.forEach(action => {
    const cases = [...html.matchAll(new RegExp("case '" + action + "':", 'g'))];
    assert.equal(cases.length, 1, action + ' must have exactly one event case');
  });
});

test('director-only lecture mutations are guarded and student checks stay self-scoped', () => {
  const director = /session\.isAdmin \|\| isManager\(\)/;
  assert.match(between("case 'ingadd':", "case 'ingpf':"), director);
  assert.match(between("case 'ingsave':", "case 'ingdel':"), director);
  assert.match(between("case 'ingdel':", "case 'ingassign':"), director);
  assert.match(between("case 'ingcatchup':", "case 'ingshift':"), director);
  assert.match(between("case 'ingshift':", '/* 순공시간 타이머 */'), director);
  const check = between("case 'ingcheck':", "case 'ingreview':");
  assert.match(check, /const me = currentStaff\(\)/);
  assert.match(check, /me\.id !== el\.dataset\.sid/);
  assert.match(check, /ingToggle\(me\.id/);
});
