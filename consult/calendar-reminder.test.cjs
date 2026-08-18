const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start + marker.length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = open; i < html.length; i++) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(name + ' function is incomplete');
}

function eventCase(name) {
  const marker = "case '" + name + "':";
  const start = html.indexOf(marker);
  if (start < 0) return '';
  const tail = html.slice(start + marker.length);
  const next = tail.match(/\n\s*case '[^']+':/);
  return html.slice(start, next ? start + marker.length + next.index : html.length);
}

const dateHelpers = `
  function ymd(d) { const p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
  function parseYmd(s) { const [y,m,d]=String(s).split('-').map(Number); return new Date(y,m-1,d); }
  function addDays(s,n) { const d=parseYmd(s); d.setDate(d.getDate()+n); return ymd(d); }
  function ymAdd(ym,n) { const d=new Date(Number(ym.slice(0,4)),Number(ym.slice(5,7))-1+n,1); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
  function monthDates(ym) { const last=new Date(Number(ym.slice(0,4)),Number(ym.slice(5,7)),0).getDate(); return Array.from({length:last},(_,i)=>ym+'-'+String(i+1).padStart(2,'0')); }
  const ymOf=s=>String(s).slice(0,7);
`;

function createAgendaApi() {
  const dday = functionSource('agendaDday');
  const endTime = functionSource('agendaEndTime');
  const endDate = functionSource('agendaEndDate');
  const stableId = functionSource('agendaStableId');
  const source = functionSource('agendaItemsFor');
  return Function(`${dateHelpers}
    const calls=[];
    const STUDY_SUBJECTS={math:{label:'수학'},korean:{label:'국어'}};
    const ACADEMIC_TYPES={exam:{label:'시험'},performance:{label:'수행평가'}};
    function dowOf(s) { return parseYmd(s).getDay(); }
    function ingHmMin(value) { const [h,m]=String(value).split(':').map(Number); return Number.isFinite(h)&&Number.isFinite(m)?h*60+m:null; }
    function ingMinHm(value) { const n=Math.max(0,Math.min(1439,Math.round(value))); return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0'); }
    function academicDateOf(item) { return item.dueDate || item.examDate || item.start || ''; }
    function academicItemsFor(sid) {
      calls.push(['academicItemsFor',sid]);
      if (sid !== 'student-1') return [{id:'leak-academic',staffId:sid,title:'다른 학생 시험',academicType:'exam',dueDate:'2026-08-20'}];
      return [
        {id:'exam',staffId:sid,title:'2학기 중간고사',academicType:'exam',studySubject:'math',dueDate:'2026-08-20',range:'일차함수'},
        {id:'performance',staffId:sid,title:'독서 발표',academicType:'performance',studySubject:'korean',dueDate:'2026-08-22',unit:'과거 단원',range:'과거 평가 안내'},
        {id:'outside',staffId:sid,title:'다음 달 시험',academicType:'exam',dueDate:'2026-09-01'}
      ];
    }
    const taskRows={
      '2026-08-20':[{id:'task',staffId:'student-1',title:'수학 숙제',studySubject:'math',time:'',start:'2026-08-20'}],
      '2026-08-21':[{id:'plan',staffId:'student-1',title:'개념 정리 · 중간고사',studySubject:'math',auto:'exam-plan-v1',examId:'exam',examPhase:'concept',slotStart:'11:00',slotEnd:'11:50',start:'2026-08-21'}]
    };
    function checklistTasksFor(sid,date) {
      calls.push(['checklistTasksFor',sid,date]);
      return sid === 'student-1' ? (taskRows[date] || []) : [{id:'leak-task',title:'다른 학생 숙제',start:date}];
    }
    function ingPlan(sid,date) {
      calls.push(['ingPlan',sid,date]);
      return sid === 'student-1' && date === '2026-08-20'
        ? [{cid:'course',seq:1,title:'일차함수 1강',s:'18:00',e:'18:50',done:false}] : [];
    }
    function ingLec(sid) { calls.push(['ingLec',sid]); return {course:{name:'수학 개념',title:'수학 개념'},lec:{title:'일차함수 1강'}}; }
    function tbOf(sid,date) {
      calls.push(['tbOf',sid,date]);
      return sid === 'student-1' && date === '2026-08-20'
        ? [{id:'block',label:'수학 학원',subj:'math',s:'16:00',e:'18:00'}] : [];
    }
    function monthPlanOf(sid,ym) {
      calls.push(['monthPlanOf',sid,ym]);
      return {events:sid === 'student-1' && ym === '2026-08'
        ? [{id:'personal',title:'학교 상담',date:'2026-08-21',range:'상담실'}] : []};
    }
    function taskStudySubjectKey(task) { return task.studySubject || 'other'; }
    function studySubject(value) { return STUDY_SUBJECTS[value] || {label:'기타'}; }
    function ingAvail(sid) { calls.push(['ingAvail',sid]); return {configured:false,blocks:[]}; }
    function getCheck() { return null; }
    function isDone() { return false; }
    ${dday}
    ${endTime}
    ${endDate}
    ${stableId}
    ${source}
    return {agendaItemsFor,calls};`)();
}

test('the existing month tab becomes the shared schedule for admin and student roles', () => {
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);

  const tabs = functionSource('renderTabs');
  const month = functionSource('viewMonth');
  const calendar = functionSource('agendaCalendarCard');
  assert.match(tabs, /\['today',\s*'오늘/);
  assert.match(tabs, /\['week',\s*'주간/);
  assert.ok((tabs.match(/\['month',\s*'일정'/g) || []).length >= 3,
    'director, manager, and student tab sets all expose the same schedule');
  assert.doesNotMatch(html, /\['calendar',/);

  assert.match(calendar, /중요한 일정/);
  assert.ok(month.indexOf('agendaCalendarCard') < month.indexOf('이달의 목표'),
    'the integrated calendar should be the first monthly section');
  assert.match(month, /const me = currentStaff\(\)/);
  assert.match(calendar, /agendaImportantItemsFor\(me\.id/);
  assert.match(month, /!session\.isStaffLink[\s\S]*?staffSwitcher\(me\.id\)/);
  ['agendapick', 'agendaday', 'agendaics', 'agendamonthics', 'montheventadd']
    .forEach(action => assert.match(calendar, new RegExp('data-act="' + action + '"')));
  assert.match(calendar, /data-act="montheventadd" data-date="' \+ agendaDate/,
    'calendar entry should default to the currently selected date');
  assert.match(calendar, /data-n="-1"/);
  assert.match(calendar, /data-n="1"/);
  assert.match(calendar, /googleCalendarUrl\(/);
  assert.match(calendar, /agendaDday\(/);
});

test('D-day labels and one inclusive projection support today, week, and month ranges', () => {
  const agendaDday = Function(`${dateHelpers}\n${functionSource('agendaDday')}\nreturn agendaDday;`)();
  assert.equal(agendaDday('2026-08-20', '2026-08-20'), 'D-DAY');
  assert.equal(agendaDday('2026-08-23', '2026-08-20'), 'D-3');
  assert.equal(agendaDday('2026-08-18', '2026-08-20'), 'D+2');

  const api = createAgendaApi();
  const todayItems = api.agendaItemsFor('student-1', '2026-08-20', '2026-08-20');
  assert.deepEqual(new Set(todayItems.map(item => item.type)), new Set([
    'exam', 'task', 'ingang', 'timeblock'
  ]));
  assert.ok(todayItems.every(item => item.date === '2026-08-20'));

  const weekItems = api.agendaItemsFor('student-1', '2026-08-17', '2026-08-23');
  assert.deepEqual(new Set(weekItems.map(item => item.type)), new Set([
    'exam', 'performance', 'task', 'exam-plan', 'ingang', 'timeblock', 'personal'
  ]));
  assert.equal(weekItems.length, 7);

  const monthItems = api.agendaItemsFor('student-1', '2026-08-01', '2026-08-31');
  assert.equal(monthItems.length, 7);
  assert.ok(monthItems.every(item => item.date >= '2026-08-01' && item.date <= '2026-08-31'));
});

test('agenda projection merges every existing source while keeping one student isolated', () => {
  const source = functionSource('agendaItemsFor');
  ['checklistTasksFor', 'academicItemsFor', 'ingPlan', 'tbOf', 'monthPlanOf']
    .forEach(name => assert.match(source, new RegExp(name + '\\(')));
  assert.doesNotMatch(source, /setCheck\(|state\.(?:tasks|checks).*push|save\(\)|queueSync\(\)/,
    'agenda is a read-only projection of existing consult data');
  const fixed = source.slice(source.indexOf("key: 'fixed:"), source.indexOf('date = addDays'));
  assert.match(fixed, /block\.label/);
  assert.doesNotMatch(fixed, /block\.name/);

  const api = createAgendaApi();
  const items = api.agendaItemsFor('student-1', '2026-08-17', '2026-08-23');
  assert.ok(api.calls.length > 0);
  assert.ok(api.calls.every(call => call[1] === 'student-1'),
    'every backing store must receive only the selected student id');
  assert.doesNotMatch(items.map(item => item.title).join(' '), /다른 학생/);
  assert.equal(new Set(items.map(item => item.sourceId)).size, items.length);

  const byType = Object.fromEntries(items.map(item => [item.type, item]));
  assert.equal(byType.exam.sourceId, 'exam');
  assert.equal(byType.exam.date, '2026-08-20');
  assert.equal(byType.performance.sourceId, 'performance');
  assert.equal(byType.performance.detail, '', 'removed legacy performance fields stay hidden from the calendar');
  assert.equal(byType.task.sourceId, 'task');
  assert.equal(byType['exam-plan'].sourceId, 'plan');
  assert.equal(byType['exam-plan'].startTime, '11:00');
  assert.equal(byType['exam-plan'].endTime, '11:50');
  assert.equal(byType.ingang.startTime, '18:00');
  assert.equal(byType.ingang.endTime, '18:50');
  assert.equal(byType.timeblock.startTime, '16:00');
  assert.equal(byType.timeblock.endTime, '18:00');
  assert.equal(byType.personal.sourceId, 'personal');
});

test('Google Calendar links use Seoul time and export no private identity or credentials', () => {
  const source = functionSource('googleCalendarUrl');
  const googleCalendarUrl = Function(`${dateHelpers}
    function ingHmMin(value) { const [h,m]=String(value).split(':').map(Number); return Number.isFinite(h)&&Number.isFinite(m)&&h<24&&m<60?h*60+m:null; }
    function ingMinHm(value) { const n=Math.max(0,Math.min(1439,Math.round(value))); return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0'); }
    ${functionSource('agendaEndTime')}
    ${source}
    return googleCalendarUrl;`)();
  assert.doesNotMatch(source, /location|state\.settings|staffId|token|secret|adminToken|syncSecret/i);

  const privateFields = {
    staffId: 'student-private-42', token: 'token-private-99',
    adminToken: 'admin-private-77', syncSecret: 'sync-private-55'
  };
  const allDay = googleCalendarUrl(Object.assign({}, privateFields, {
    sourceId: 'exam', title: '중간고사', date: '2026-08-20', allDay: true,
    detail: '시험범위: 일차함수'
  }));
  const allDayUrl = new URL(allDay);
  assert.equal(allDayUrl.origin, 'https://calendar.google.com');
  assert.equal(allDayUrl.pathname, '/calendar/render');
  assert.equal(allDayUrl.searchParams.get('action'), 'TEMPLATE');
  assert.equal(allDayUrl.searchParams.get('text'), '중간고사');
  assert.equal(allDayUrl.searchParams.get('dates'), '20260820/20260821');
  assert.match(allDayUrl.searchParams.get('details'), /WB 컨설팅 앱/);
  assert.doesNotMatch(allDayUrl.searchParams.get('details'), /일차함수/);

  const timed = new URL(googleCalendarUrl(Object.assign({}, privateFields, {
    sourceId: 'plan', title: '개념 정리', date: '2026-08-20',
    startTime: '09:00', endTime: '10:00', allDay: false, detail: '시험대비'
  })));
  assert.equal(timed.searchParams.get('dates'), '20260820T090000/20260820T100000');
  assert.equal(timed.searchParams.get('ctz'), 'Asia/Seoul');

  [allDay, timed.href].forEach(value => {
    const decoded = decodeURIComponent(value);
    Object.values(privateFields).forEach(secret => assert.ok(!decoded.includes(secret)));
  });
  assert.equal(googleCalendarUrl({title:'잘못된 날짜',date:'not-a-date',allDay:true}), '');
});

test('ICS uses RFC text escaping, exclusive all-day ends, CRLF, and Asia/Seoul timed dates', () => {
  const escapeSource = functionSource('icsEscape');
  const icsSource = functionSource('agendaIcs');
  const api = Function(`${dateHelpers}
    function ingHmMin(value) { const [h,m]=String(value).split(':').map(Number); return Number.isFinite(h)&&Number.isFinite(m)&&h<24&&m<60?h*60+m:null; }
    function ingMinHm(value) { const n=Math.max(0,Math.min(1439,Math.round(value))); return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0'); }
    ${functionSource('agendaEndTime')}
    ${escapeSource}
    ${functionSource('agendaUtcStamp')}
    ${functionSource('icsFold')}
    ${icsSource}
    return {icsEscape,agendaIcs};`)();
  assert.equal(api.icsEscape('국어,영어;범위\\메모\r\n둘째 줄\r단독 줄'),
    '국어\\,영어\\;범위\\\\메모\\n둘째 줄\\n단독 줄');
  assert.doesNotMatch(icsSource, /location|state\.settings|staffId|token|secret|adminToken|syncSecret/i);

  const privateFields = {
    staffId: 'student-private-42', token: 'token-private-99',
    adminToken: 'admin-private-77', syncSecret: 'sync-private-55'
  };
  const ics = api.agendaIcs([
    Object.assign({}, privateFields, {
      source:'academic', sourceId:'exam', title:'중간고사, 수학', date:'2026-08-20', allDay:true,
      detail:'일차함수; 그래프\\식\n교과서'
    }),
    Object.assign({}, privateFields, {
      source:'exam-plan', sourceId:'plan', title:'개념 정리', date:'2026-08-21', allDay:false,
      startTime:'09:00', endTime:'10:00', detail:'시험대비'
    })
  ]);

  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /VERSION:2\.0\r\n/);
  assert.match(ics, /PRODID:/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260820\r\nDTEND;VALUE=DATE:20260821\r\n/);
  assert.match(ics, /DTSTART:20260821T000000Z\r\nDTEND:20260821T010000Z\r\n/,
    '09:00~10:00 Asia/Seoul must be converted to 00:00~01:00 UTC');
  assert.match(ics, /SUMMARY:중간고사\\, 수학\r\n/);
  assert.match(ics, /DESCRIPTION:WB 컨설팅 앱에서 추가한 일정\r\n/);
  assert.doesNotMatch(ics, /일차함수|그래프|교과서/,
    'private scope and notes stay inside the consult app');
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.doesNotMatch(ics.replace(/\r\n/g, ''), /[\r\n]/,
    'ICS lines must consistently use CRLF');
  Object.values(privateFields).forEach(secret => assert.ok(!ics.includes(secret)));

  const longTitle = '아주 긴 시험 일정 제목과 알림 내용 '.repeat(8).trim();
  const folded = api.agendaIcs([{
    source:'academic', sourceId:'long', title:longTitle, date:'2026-08-22', allDay:true
  }]);
  folded.split('\r\n').filter(Boolean).forEach(line =>
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, 'ICS physical line exceeds 75 octets'));
  assert.ok(folded.replace(/\r\n[ \t]/g, '').includes('SUMMARY:' + api.icsEscape(longTitle)));

  const downloadSource = functionSource('downloadAgendaIcs');
  assert.doesNotMatch(downloadSource, /\\uFEFF|﻿/, 'ICS must start with BEGIN:VCALENDAR, without a BOM');
  if (/METHOD:PUBLISH/.test(ics)) assert.match(downloadSource, /text\/calendar[^'"}]*method=PUBLISH/i,
    'MIME method must match the ICS METHOD property');
});

test('the calendar keeps only exams, performance assessments, and designated important dates', () => {
  const agendaImportantKind = Function(`${functionSource('agendaImportantKind')}
    return agendaImportantKind;`)();
  assert.equal(agendaImportantKind({type:'exam'}), 'exam');
  assert.equal(agendaImportantKind({type:'performance'}), 'performance');
  assert.equal(agendaImportantKind({type:'personal',personal:true,importantKind:'performance'}), 'performance');
  assert.equal(agendaImportantKind({type:'personal',personal:true,importantKind:'consult'}), 'important');
  assert.equal(agendaImportantKind({type:'task'}), '');
  assert.equal(agendaImportantKind({type:'ingang'}), '');
  assert.equal(agendaImportantKind({type:'timeblock'}), '');

  const upcomingSource = functionSource('agendaUpcomingImportantItems');
  assert.match(upcomingSource, /addDays\(today\(\), 90\)/);
  assert.match(upcomingSource, /slice\(0, 5\)/);
});

test('schedule navigation is transient and ICS export stays scoped to currentStaff for both roles', () => {
  const pick = eventCase('agendapick');
  const day = eventCase('agendaday');
  const open = eventCase('agendaopen');
  const download = [eventCase('agendaics'), eventCase('agendamonthics')];

  [pick, day, open].forEach(source => {
    assert.ok(source, 'agenda action case must exist');
    assert.doesNotMatch(source, /if \(!session\.isAdmin\)|setCheck\(|save\(\)|queueSync\(\)/);
    assert.match(source, /render\(\)|go\('today'\)/);
  });
  download.forEach(source => {
    assert.ok(source, 'agenda ICS action case must exist');
    assert.match(source, /const me = currentStaff\(\)/);
    assert.match(source, /agendaImportantItemsFor\(me\.id/);
    assert.match(source, /downloadAgendaIcs\(/);
    assert.match(source, /\.ics/);
    assert.doesNotMatch(source, /if \(!session\.isAdmin\)|el\.dataset\.sid|session\.staffId/);
  });
  const monthDownload = eventCase('agendamonthics');
  assert.doesNotMatch(monthDownload, /agendaFilter|agendaMatchesFilter|!item\.quiet/,
    'the month export must use the same important-date scope as the calendar');
  const calendar = functionSource('agendaCalendarCard');
  assert.match(calendar, /이번 달 전체 \.ics/);
  assert.match(calendar, /const monthItems = agendaImportantItemsFor/);
  assert.doesNotMatch(calendar, /agendaFilter|maxStudySecs|stTotal\(me\.id|timeblock|ingang/,
    'routine work, timetables, lectures, and study heat must stay out of the simplified calendar');
  const helper = functionSource('downloadAgendaIcs');
  assert.match(helper, /text\/calendar/);
  assert.match(helper, /URL\.createObjectURL/);
  assert.match(helper, /URL\.revokeObjectURL/);
});
