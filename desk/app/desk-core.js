/* WB 프로그램데스크 — 순수 로직 모듈 (브라우저 classic script + Node 테스트 공용).
 *
 * 왜 따로 두나: app.js는 DOM·fetch·localStorage를 만지는 런타임이라 Node에서 돌릴 수 없다. 날짜·발생 판정·
 * 진행률·지시서 변환·문서 병합·입력 검증처럼 "틀리면 조용히 잘못 저장되는" 규칙은 여기 모아 테스트로 묶는다.
 * 학원 업무지시서 앱(task/index.html)의 같은 이름 함수(occursOn·tasksFor·taskSteps·taskProgress·statusOf·
 * applyAssignments)를 단순화해 옮겼다 — 수업 지시서·보강·주말 수업 같은 학원 전용 분기는 전부 뺐다.
 *
 * 규칙: 외부 의존성 0, 전역은 WBDeskCore 하나, 최상위에서 다른 전역(state·document…)을 만지지 않는다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBDeskCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ── 상수 ──────────────────────────────────────────── */

  const PROGRAMS = Object.freeze(['studyforce', 'classcard', 'metamath', 'nelt']);
  const PROGRAM_LABEL = Object.freeze({ studyforce: '스터디포스', classcard: '클래스카드', metamath: '메타수학', nelt: '넬트' });
  const STUDENT_STATUS = Object.freeze(['active', 'paused', 'ended']);
  const STUDENT_STATUS_LABEL = Object.freeze({ active: '이용 중', paused: '일시 중지', ended: '종료' });
  const ACCOUNT_STATES = Object.freeze(['none', 'requested', 'issued']);
  const ACCOUNT_LABEL = Object.freeze({ none: '계정 없음', requested: '발급 요청', issued: '발급됨' });
  const CONTACT_TYPES = Object.freeze(['call', 'msg', 'visit']);
  const CONTACT_TYPE_LABEL = Object.freeze({ call: '전화', msg: '문자·카톡', visit: '방문' });
  const CONTACT_RESULTS = Object.freeze(['reached', 'no_answer', 'note']);
  const CONTACT_RESULT_LABEL = Object.freeze({ reached: '연락됨', no_answer: '부재중', note: '메모' });
  const REPEATS = Object.freeze(['once', 'daily', 'weekday', 'days']);
  const TASK_STATUS_LABEL = Object.freeze({ todo: '미착수', doing: '진행중', done: '완료', blocked: '막힘' });
  const ROUTES = Object.freeze(['login', 'today', 'room', 'requests', 'students', 'assets', 'perf', 'contacts', 'manuals', 'matrix', 'admin']);
  const DOW = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);
  /* 기획서 v1.1 — 프로그램 방 6개(원장 표현: 세션). 구독 4개 + 자료 출처 2곳. 방 = 카드 큐의 창 + 매뉴얼 + 사이트 열기 + 현황. */
  const ROOMS = Object.freeze(['studyforce', 'classcard', 'metamath', 'nelt', 'exam4you', 'jokbo']);
  const ROOM_LABEL = Object.freeze({ studyforce: '스터디포스', classcard: '클래스카드', metamath: '메타수학', nelt: '넬트', exam4you: '이그잼포유', jokbo: '족보닷컴' });
  const CARD_STATUS = Object.freeze(['todo', 'doing', 'done', 'blocked']);
  const CARD_STATUS_LABEL = Object.freeze({ todo: '대기', doing: '진행', done: '완료', blocked: '막힘' });
  const CARD_TARGETS = Object.freeze(['student', 'app', 'text']);
  const PLAN_TARGETS = Object.freeze(['each', 'student', 'app', 'text']);
  const PLAN_TARGET_LABEL = Object.freeze({ each: '구독 학생 각각', student: '학생 한 명', app: '학원 학습 앱', text: '반·기타(글로)' });
  const RANGE_STATUS = Object.freeze(['need', 'buying', 'uploading', 'have']);
  const RANGE_STATUS_LABEL = Object.freeze({ need: '없음', buying: '구매 대기', uploading: '업로드 대기', have: '있음' });
  const RANGE_SOURCES = Object.freeze(['exam4you', 'jokbo', 'other']);
  const MANUAL_SCOPES = Object.freeze(['studyforce', 'classcard', 'metamath', 'nelt', 'exam4you', 'jokbo', 'app']);
  const EXAM_SOURCES = Object.freeze(['exam4you', 'jokbo']);   // 시험 자료가 나오는 방
  const EXAM_LEAD_DEFAULT = 21;                                 // 시험 3주 전에 카드가 생긴다
  const EXAM_DUE_BEFORE_DEFAULT = 7;                            // 시험 1주 전까지 전달
  const HTTPS_RE = /^https:\/\/[^\s"'<>]{1,200}$/;
  const NOTE_MAX = 300;
  const CONTACT_NOTE_MAX = 200;
  const DOC_ID_RE = /^[A-Za-z0-9_|.:@-]{1,160}$/;   // 서버 §3.4와 같은 문서 id 규칙
  const EXT_KEY_RE = /^[a-z_]{1,40}$/;               // steps[].ext — 서버가 이 형식만 받는다
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const YM_RE = /^\d{4}-\d{2}$/;
  const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  /* 개인정보 패턴 — 서버(§3.4)가 같은 기준으로 400 PII를 돌려주므로, 화면에서 먼저 막아 왕복을 줄인다. */
  const PHONE_RE = /(^|[^\d])0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/;
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const RRN_RE = /(^|[^\d])\d{6}[-\s]?[1-4]\d{6}(?!\d)/;

  /* ── 기본 유틸 ─────────────────────────────────────── */

  function str(v) { return v == null ? '' : String(v).trim(); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  /** 문서 id용 소문자·숫자 슬러그. rand()는 [0,1) — 테스트가 고정값을 넣는다. */
  function slug(n, rand) {
    const r = typeof rand === 'function' ? rand : Math.random;
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < (n > 0 ? n : 12); i++) out += chars[Math.floor(r() * chars.length) % chars.length];
    return out;
  }
  function hasPII(text) {
    const t = String(text == null ? '' : text);
    return PHONE_RE.test(t) || EMAIL_RE.test(t) || RRN_RE.test(t);
  }

  /* ── 날짜 ──────────────────────────────────────────── */

  function ymdOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseYmd(s) {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return ymdOf(d) === s ? d : null;
  }
  function validYmd(s) { return !!parseYmd(s); }
  function validYm(s) {
    if (!YM_RE.test(String(s || ''))) return false;
    const mo = Number(String(s).slice(5, 7));
    return mo >= 1 && mo <= 12;
  }
  function dowOf(s) { const d = parseYmd(s); return d ? d.getDay() : -1; }
  function addDays(s, n) {
    const d = parseYmd(s);
    if (!d) return '';
    d.setDate(d.getDate() + (Number(n) || 0));
    return ymdOf(d);
  }
  function mondayOf(s) { const w = dowOf(s); return w < 0 ? '' : addDays(s, -((w + 6) % 7)); }
  function label(s) {
    const d = parseYmd(s);
    return d ? (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + DOW[d.getDay()] + ')' : String(s || '');
  }
  function shortDate(s) { const d = parseYmd(s); return d ? (d.getMonth() + 1) + '/' + d.getDate() : String(s || ''); }
  function hmOf(ms) {
    const n = Number(ms);
    if (!(n > 0)) return '';
    const d = new Date(n);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function hmToMin(hm) {
    const m = String(hm || '').match(/^(\d{2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  }
  function minToHM(min) {
    const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)));
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }
  function repeatLabel(t) {
    const r = str(t && t.repeat);
    if (r === 'once') return (validYmd(t.start) ? label(t.start) + ' ' : '') + '1회';
    if (r === 'daily') return '매일';
    if (r === 'weekday') return '평일';
    if (r === 'days') return '매주 ' + (Array.isArray(t.days) ? t.days : []).map(Number).filter(n => n >= 0 && n <= 6).map(n => DOW[n]).join('·');
    return '';
  }

  /* ── task 발생·진행 ────────────────────────────────── */

  /** 그날 이 task가 있는가. 학원 앱의 plannedOccursOn만 남겼다(주말 수업 예외 없음). */
  function occursOn(task, ymd) {
    if (!isObj(task) || task.deleted) return false;
    const d = String(ymd || '');
    if (!validYmd(d)) return false;
    if (task.start && d < String(task.start)) return false;
    if (task.end && d > String(task.end)) return false;
    switch (task.repeat) {
      case 'once': return d === String(task.start || '');
      case 'daily': return true;
      case 'weekday': { const w = dowOf(d); return w >= 1 && w <= 5; }
      case 'days': return (Array.isArray(task.days) ? task.days : []).map(Number).includes(dowOf(d));
      default: return false;
    }
  }

  /** 직원 한 사람의 그날 task — 시각 → 중요 → 등록순. */
  function tasksFor(tasks, staffId, ymd) {
    const id = String(staffId || '');
    return (Array.isArray(tasks) ? tasks : [])
      .filter(t => isObj(t) && String(t.staffId || '') === id && occursOn(t, ymd))
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') ||
        ((b.priority === 'high') - (a.priority === 'high')) ||
        ((Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)));
  }

  function checkKey(taskId, date) { return String(taskId) + '|' + String(date); }

  /** 단계 목록 — id가 없는 단계는 task id 기준으로 안정된 id를 붙인다(체크 키가 바뀌면 기록이 끊긴다). */
  function taskSteps(t) {
    const steps = isObj(t) && Array.isArray(t.steps) ? t.steps : [];
    return steps.map((s, i) => {
      const o = isObj(s) ? s : { label: s };
      const row = { id: str(o.id) || (str(t && t.id) || 'task') + '-s' + (i + 1), label: str(o.label) };
      if (str(o.ext)) row.ext = str(o.ext);
      return row;
    }).filter(s => s.label);
  }

  /** 단계·수량을 고려한 진행률 — 학원 앱과 같은 의미. */
  function taskProgress(t, c) {
    const steps = taskSteps(t);
    if (steps.length) {
      const done = steps.filter(s => c && c.steps && c.steps[s.id]).length;
      return { done: done, total: steps.length, unit: '단계', pct: Math.round(done / steps.length * 100) };
    }
    const target = Number(t && t.target) || 0;
    if (target > 0) {
      const n = Number(c && c.count) || 0;
      return { done: n, total: target, unit: str(t.unit) || '건', pct: Math.min(100, Math.round(n / target * 100)) };
    }
    const d = c && c.done ? 1 : 0;
    return { done: d, total: 1, unit: '', pct: d * 100 };
  }

  function isDone(t, c) { return !!(c && c.done); }

  /** 미착수 todo / 진행중 doing / 완료 done / 막힘 blocked */
  function statusOf(t, c) {
    if (c && c.blocked) return 'blocked';
    if (isDone(t, c)) return 'done';
    if (taskProgress(t, c).done > 0) return 'doing';
    return 'todo';
  }

  /** 단계·수량이 다 차면 자동 완료, 되돌리면 자동 해제. 둘 다 없는 task는 null(수동만). */
  function autoDone(t, c) {
    const steps = taskSteps(t);
    const target = Number(t && t.target) || 0;
    if (!steps.length && !(target > 0)) return null;
    const stepsOk = !steps.length || steps.every(s => c && c.steps && c.steps[s.id]);
    const countOk = !(target > 0) || (Number(c && c.count) || 0) >= target;
    return stepsOk && countOk;
  }

  /** 지난 lookback일 안에 발생했는데 끝나지 않은 task(carry !== false). 오늘 화면의 "지난 미완료". */
  function carriedTasks(tasks, checks, staffId, ymd, lookback) {
    const out = [];
    const days = Number.isInteger(lookback) && lookback > 0 ? lookback : 7;
    const ch = isObj(checks) ? checks : {};
    for (let i = 1; i <= days; i++) {
      const d = addDays(ymd, -i);
      if (!d) break;
      tasksFor(tasks, staffId, d).forEach(t => {
        if (t.carry === false) return;
        const c = ch[checkKey(t.id, d)] || null;
        if (isDone(t, c)) return;
        out.push({ task: t, date: d, daysAgo: i, status: statusOf(t, c) });
      });
    }
    return out;
  }

  /* ── 지시서 JSON → task ────────────────────────────── */

  function normName(v) { return str(v).normalize('NFKC').replace(/\s+/g, ''); }

  /** 문자열이면 JSON으로 읽고, 배열이거나 {assignments:[…]}면 그대로. → {list, error} */
  function parseAssignments(input) {
    let data = input;
    if (typeof input === 'string') {
      try { data = JSON.parse(input); } catch (e) { return { list: [], error: 'JSON 형식이 잘못되었습니다' }; }
    }
    const list = Array.isArray(data) ? data : (isObj(data) && Array.isArray(data.assignments) ? data.assignments : []);
    return { list: list.filter(isObj), error: '' };
  }

  /**
   * 지시서 목록 → task 문서. 학원 앱 applyAssignments와 같은 필드 규칙이되,
   *  - 없는 직원은 만들지 않고 skipped로 돌려준다(직원 등록은 원장 화면에서만).
   *  - steps[].ext는 서버 형식(^[a-z_]{1,40}$)이고 linkFor가 아는 키일 때만 남긴다 — 임의 링크 금지.
   *  - runbookSlotId·runbookPackVersion·window는 런북 팩 발행이 붙이는 값이라 그대로 통과시킨다.
   * opts: {uid(), now(), today(), linkFor?}
   */
  function applyAssignmentsPure(list, staffList, opts) {
    const o = isObj(opts) ? opts : {};
    const uid = typeof o.uid === 'function' ? o.uid : () => Math.random().toString(36).slice(2, 12);
    const nowMs = typeof o.now === 'function' ? Number(o.now()) || Date.now() : Date.now();
    const todayYmd = typeof o.today === 'function' ? String(o.today()) : ymdOf(new Date());
    const linkFor = typeof o.linkFor === 'function' ? o.linkFor : null;
    const staff = (Array.isArray(staffList) ? staffList : []).filter(isObj);
    const byName = {};
    staff.forEach(s => { const k = normName(s.name); if (k && !byName[k]) byName[k] = s; });
    const byId = {};
    staff.forEach(s => { if (str(s.id)) byId[str(s.id)] = s; });
    const groupId = 'ai-' + nowMs;
    const tasks = [], skipped = [];
    (Array.isArray(list) ? list : []).forEach(a => {
      if (!isObj(a)) return;
      const s = (str(a.staffId) && byId[str(a.staffId)]) || byName[normName(a.staff)] || null;
      if (!s) { skipped.push({ staff: str(a.staff) || str(a.staffId) || '(직원 없음)', title: str(a.title) }); return; }
      const id = str(a.id) && DOC_ID_RE.test(str(a.id)) ? str(a.id) : String(uid());
      const steps = (Array.isArray(a.steps) ? a.steps : []).map(x => {
        const label = typeof x === 'string' ? str(x) : str(isObj(x) && x.label);
        const row = { id: String(uid()), label: label };
        const ext = isObj(x) ? str(x.ext) : '';
        if (ext && EXT_KEY_RE.test(ext) && (!linkFor || linkFor(ext))) row.ext = ext;
        return row;
      }).filter(x => x.label);
      const repeat = REPEATS.includes(a.repeat) ? a.repeat : 'once';
      const task = {
        id: id, groupId: groupId, staffId: String(s.id),
        title: str(a.title) || '(제목 없음)',
        detail: String(a.detail == null ? '' : a.detail),
        guide: String(a.guide == null ? '' : a.guide),
        steps: steps,
        target: Math.max(0, Number(a.target) || 0),
        unit: str(a.unit) || '건',
        time: HM_RE.test(str(a.time)) ? str(a.time) : '',
        priority: a.priority === 'high' ? 'high' : 'normal',
        repeat: repeat,
        days: repeat === 'days' && Array.isArray(a.days) ? a.days.map(Number).filter(n => n >= 0 && n <= 6) : [],
        start: validYmd(a.start) ? String(a.start) : todayYmd,
        end: validYmd(a.end) ? String(a.end) : '',
        carry: a.carry !== false,
        createdAt: nowMs, updatedAt: nowMs, deleted: false
      };
      if (str(a.runbookSlotId)) task.runbookSlotId = str(a.runbookSlotId);
      if (str(a.runbookPackVersion)) task.runbookPackVersion = str(a.runbookPackVersion);
      if (Number.isFinite(Number(a.window)) && a.window !== '' && a.window != null) task.window = Math.max(0, Math.round(Number(a.window)));
      tasks.push(task);
    });
    return { tasks: tasks, skipped: skipped };
  }

  /* ── 학생 → 수행 패널용 roster ─────────────────────── */

  function ymOf(v) {
    const s = str(v);
    if (validYm(s)) return s;
    if (validYmd(s)) return s.slice(0, 7);
    return '';
  }

  /**
   * students 문서 → rosterDb.students (계약 §4). start = since(YYYY-MM) 또는 프로그램 since 최솟값의 달.
   * end = 'ended'면 그 달(프로그램 until 최댓값이 있으면 그 달, 없으면 이번 달), 'paused'는 이번 달로 두어
   * 수행 판정(end > 이번 달 조건)에서 빠지게 한다.
   */
  /* 수행 패널은 학생마다 __perfset__ 행(이용 프로그램·대상 요일)이 있어야 신호판에 올린다. 그 값은 학생 문서의
     programs.*.active 와 같은 정보라 두 번 적게 하지 않는다 — 서버 행이 없으면 학생 문서에서 메모리 위에 만든다
     (from:'students', 서버에 보내지 않음). 사람이 수행 화면에서 저장하면 그 행이 이긴다. */
  function seedPerfsets(students, checks, opts) {
    const o = isObj(opts) ? opts : {};
    const perfProgs = Array.isArray(o.progs) && o.progs.length ? o.progs : ['studyforce', 'classcard'];
    const dueDays = Array.isArray(o.dueDays) && o.dueDays.length ? o.dueDays : [1, 2, 3, 4, 5];
    const keyOf = typeof o.perfsetKey === 'function' ? o.perfsetKey : (id => '__perfset__' + id + '|all');
    const out = Object.assign({}, isObj(checks) ? checks : {});
    let seeded = 0, dropped = 0;
    const seen = new Set();
    (Array.isArray(students) ? students : []).forEach(st => {
      if (!isObj(st) || !str(st.id) || st.deleted) return;
      const key = keyOf(str(st.id));
      seen.add(key);
      const cur = out[key];
      if (cur && cur.from !== 'students') return;            // 사람이 저장한 행은 건드리지 않는다
      const progs = isObj(st.programs) ? perfProgs.filter(k => isObj(st.programs[k]) && st.programs[k].active === true) : [];
      if (!progs.length || str(st.status) === 'ended') { if (cur) { delete out[key]; dropped++; } return; }
      const dd = {};
      progs.forEach(k => { dd[k] = dueDays.slice(); });
      out[key] = { studentId: str(st.id), progs: progs, dueDays: dd, target: null, from: 'students' };
      seeded++;
    });
    Object.keys(out).forEach(key => {
      if (out[key] && out[key].from === 'students' && !seen.has(key)) { delete out[key]; dropped++; }
    });
    return { checks: out, seeded: seeded, dropped: dropped };
  }

  function studentsToRoster(students, todayYm) {
    const month = validYm(todayYm) ? String(todayYm) : ymOf(ymdOf(new Date()));
    return (Array.isArray(students) ? students : []).filter(s => isObj(s) && str(s.id) && !s.deleted).map(s => {
      const progs = isObj(s.programs) ? s.programs : {};
      const sinces = PROGRAMS.map(k => ymOf(isObj(progs[k]) ? progs[k].since : '')).filter(Boolean).sort();
      const untils = PROGRAMS.map(k => ymOf(isObj(progs[k]) ? progs[k].until : '')).filter(Boolean).sort();
      const row = { id: str(s.id), name: str(s.name), grade: str(s.grade) };
      const start = ymOf(s.since) || sinces[0] || '';
      if (start) row.start = start;
      const status = str(s.status);
      if (status === 'ended') row.end = (untils.length && untils[untils.length - 1] <= month) ? untils[untils.length - 1] : month;
      else if (status === 'paused') row.end = month;
      return row;
    });
  }

  /** 명단 화면 필터 — 이름·코드·학년 부분 일치 + 상태. 이름순. */
  function searchStudents(students, q, status) {
    const needle = normName(q).toLowerCase();
    const st = str(status);
    return (Array.isArray(students) ? students : []).filter(s => isObj(s) && !s.deleted)
      .filter(s => !st || st === 'all' || str(s.status || 'active') === st)
      .filter(s => !needle || [s.name, s.code, s.grade, s.school].some(v => normName(v).toLowerCase().includes(needle)))
      .sort((a, b) => str(a.name).localeCompare(str(b.name), 'ko') || str(a.id).localeCompare(str(b.id)));
  }

  /* ── 문서 병합 ─────────────────────────────────────── */

  function docKey(c, id) { return String(c) + '|' + String(id); }

  function upsert(list, id, data, deleted) {
    const i = list.findIndex(x => isObj(x) && String(x.id) === String(id));
    if (deleted) { if (i >= 0) list.splice(i, 1); return; }
    const row = Object.assign({}, data, { id: String(id) });
    if (i >= 0) list[i] = row; else list.push(row);
  }

  /**
   * 서버 문서를 로컬 state에 반영한다. pendingKeys(아직 안 보낸 'c|id')는 건드리지 않는다 — 내 변경이
   * 다른 기기의 옛 값에 덮이면 안 된다. updatedAt이 이미 아는 값보다 오래된 문서도 무시한다.
   * base['c|id']에는 서버가 마지막으로 준 data(삭제면 null)를 남긴다 — 서버가 거절한 내 변경을 되돌릴 때 쓴다.
   * local = {staff, tasks, checks, students, contacts, settings, meta:{'c|id': updatedAt}, base} → {local, changed, skipped}
   */
  function mergeDocs(local, docs, pendingKeys) {
    const L = isObj(local) ? local : {};
    const out = {
      staff: (Array.isArray(L.staff) ? L.staff : []).slice(),
      tasks: (Array.isArray(L.tasks) ? L.tasks : []).slice(),
      checks: Object.assign({}, isObj(L.checks) ? L.checks : {}),
      students: (Array.isArray(L.students) ? L.students : []).slice(),
      contacts: (Array.isArray(L.contacts) ? L.contacts : []).slice(),
      cards: (Array.isArray(L.cards) ? L.cards : []).slice(),
      plans: (Array.isArray(L.plans) ? L.plans : []).slice(),
      apps: (Array.isArray(L.apps) ? L.apps : []).slice(),
      manuals: (Array.isArray(L.manuals) ? L.manuals : []).slice(),
      settings: Object.assign({}, isObj(L.settings) ? L.settings : {}),
      meta: Object.assign({}, isObj(L.meta) ? L.meta : {}),
      base: Object.assign({}, isObj(L.base) ? L.base : {})
    };
    const pend = new Set((Array.isArray(pendingKeys) ? pendingKeys : []).map(String));
    let changed = 0, skipped = 0;
    (Array.isArray(docs) ? docs : []).forEach(d => {
      if (!isObj(d) || !str(d.c) || !str(d.id)) return;
      const key = docKey(d.c, d.id);
      if (pend.has(key)) { skipped++; return; }
      const at = Number(d.updatedAt) || 0;
      const prev = Number(out.meta[key]) || 0;
      if (at && prev && at < prev) return;
      const data = isObj(d.data) ? d.data : {};
      const del = !!d.deleted;
      switch (String(d.c)) {
        case 'checks': if (del) delete out.checks[d.id]; else out.checks[d.id] = Object.assign({}, data); break;
        case 'tasks': upsert(out.tasks, d.id, data, del || data.deleted === true); break;
        case 'students': upsert(out.students, d.id, data, del); break;
        case 'contacts': upsert(out.contacts, d.id, data, del); break;
        case 'cards': upsert(out.cards, d.id, data, del); break;
        case 'plans': upsert(out.plans, d.id, data, del); break;
        case 'apps': upsert(out.apps, d.id, data, del); break;
        case 'manuals': upsert(out.manuals, d.id, data, del); break;
        case 'staff': upsert(out.staff, d.id, data, del); break;
        case 'settings': out.settings = del ? {} : Object.assign({}, data); break;
        default: return;
      }
      out.meta[key] = at || prev || 0;
      out.base[key] = del ? null : Object.assign({}, data);
      changed++;
    });
    return { local: out, changed: changed, skipped: skipped };
  }

  /** 서버가 거절한 로컬 변경을 되돌리는 문서 — base에 있으면 그 값, 없으면(서버가 모르는 문서) 삭제 문서. */
  function revertDoc(local, key) {
    const k = String(key || '');
    const i = k.indexOf('|');
    if (i < 0) return null;
    const c = k.slice(0, i), id = k.slice(i + 1);
    const base = isObj(local) && isObj(local.base) ? local.base[k] : undefined;
    const at = isObj(local) && isObj(local.meta) ? Number(local.meta[k]) || 0 : 0;
    if (base) return { c: c, id: id, data: base, updatedAt: at, deleted: false };
    return { c: c, id: id, data: {}, updatedAt: at, deleted: true };
  }

  /**
   * 변경 큐. 같은 문서를 연달아 고치면 마지막 값 하나만 남고, 전송 중에 또 고치면(seq가 올라감) 응답이 와도
   * 지우지 않아 다음 전송에 실린다. ack는 서버 results를 ok / stale / failed로 나눠 돌려준다.
   */
  function createOutbox() {
    const map = new Map();
    let seq = 0;
    return {
      put: function (c, id, data, deleted) {
        map.set(docKey(c, id), { c: String(c), id: String(id), data: data, deleted: !!deleted, seq: ++seq });
      },
      keys: function () { return Array.from(map.keys()); },
      size: function () { return map.size; },
      has: function (key) { return map.has(String(key)); },
      snapshot: function (limit) {
        return Array.from(map.values()).slice(0, limit > 0 ? limit : 200).map(e => Object.assign({}, e));
      },
      ack: function (sent, results) {
        const ok = [], stale = [], failed = [];
        const sentBy = {};
        (Array.isArray(sent) ? sent : []).forEach(e => { sentBy[docKey(e.c, e.id)] = e; });
        (Array.isArray(results) ? results : []).forEach(r => {
          if (!isObj(r)) return;
          const key = docKey(r.c, r.id);
          const s = sentBy[key];
          const cur = map.get(key);
          const settled = !!(cur && s && cur.seq === s.seq);
          if (!r.error && !r.code) {
            ok.push({ key: key, c: String(r.c), id: String(r.id), updatedAt: Number(r.updatedAt) || 0 });
            if (settled) map.delete(key);
          } else if (r.code === 'STALE') {
            stale.push({ key: key, c: String(r.c), id: String(r.id), current: r.current || null });
            if (settled) map.delete(key);
          } else {
            failed.push({ key: key, c: String(r.c), id: String(r.id), error: String(r.error || r.code), code: String(r.code || '') });
            if (settled) map.delete(key);
          }
        });
        return { ok: ok, stale: stale, failed: failed };
      },
      clear: function () { map.clear(); }
    };
  }

  /* ── 전화번호 ──────────────────────────────────────── */

  /** 숫자만 남겨 하이픈을 다시 넣는다. 표준 자릿수가 아니면 숫자만 돌려준다(검증은 validateStudent가). */
  function normalizePhone(raw) {
    const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (!digits) return '';
    const n = digits.length;
    if (n === 11) return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
    if (n === 10) return digits.startsWith('02')
      ? digits.slice(0, 2) + '-' + digits.slice(2, 6) + '-' + digits.slice(6)
      : digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
    if (n === 9 && digits.startsWith('02')) return digits.slice(0, 2) + '-' + digits.slice(2, 5) + '-' + digits.slice(5);
    if (n === 8) return digits.slice(0, 4) + '-' + digits.slice(4);
    return digits;
  }

  /** 목록 표시용 마스킹: 010-****-5678. 하이픈 두 개가 아니면 끝 4자리만 남긴다. */
  function maskPhone(raw) {
    const f = normalizePhone(raw);
    if (!f) return '';
    const parts = f.split('-');
    if (parts.length === 3) return parts[0] + '-' + '*'.repeat(parts[1].length) + '-' + parts[2];
    if (parts.length === 2) return '*'.repeat(parts[0].length) + '-' + parts[1];
    return '*'.repeat(Math.max(0, f.length - 4)) + f.slice(-4);
  }

  /* ── 입력 검증 ─────────────────────────────────────── */

  /**
   * 학생 문서 검증 — 서버 §3.4 students 규칙과 같은 형식 검사(서버가 다시 검사하므로 형식만).
   * 전화번호는 guardian.phone에만 두고, 그 밖의 문자열에 전화·이메일·주민번호 패턴이 있으면 거절한다.
   * → {ok, errors:[{field, reason}], value}
   */
  function validateStudent(input) {
    const s = isObj(input) ? input : {};
    const errors = [];
    const value = {};
    const name = str(s.name);
    if (!name || name.length > 40) errors.push({ field: 'name', reason: '이름은 1~40자' });
    else if (hasPII(name)) errors.push({ field: 'name', reason: '이름에 전화번호·이메일을 넣을 수 없습니다' });
    value.name = name;
    const grade = str(s.grade);
    if (grade.length > 10) errors.push({ field: 'grade', reason: '학년은 10자 이내' });
    else if (hasPII(grade)) errors.push({ field: 'grade', reason: '학년에 전화번호를 넣을 수 없습니다' });
    value.grade = grade;
    const school = str(s.school);   // 시험 템플릿이 학교·학년으로 대상을 고른다
    if (school.length > 40) errors.push({ field: 'school', reason: '학교는 40자 이내' });
    else if (hasPII(school)) errors.push({ field: 'school', reason: '학교에 전화번호를 넣을 수 없습니다' });
    if (school) value.school = school;
    const code = str(s.code);
    if (code.length > 20) errors.push({ field: 'code', reason: '코드는 20자 이내' });
    else if (hasPII(code)) errors.push({ field: 'code', reason: '코드에 전화번호를 넣을 수 없습니다' });
    if (code) value.code = code;
    const status = str(s.status) || 'active';
    if (!STUDENT_STATUS.includes(status)) errors.push({ field: 'status', reason: '상태는 이용 중·일시 중지·종료 중 하나' });
    value.status = status;
    const since = str(s.since);
    if (since && !validYm(since)) errors.push({ field: 'since', reason: '시작 월은 YYYY-MM' });
    if (since) value.since = since;
    const memo = str(s.memo);
    if (memo.length > NOTE_MAX) errors.push({ field: 'memo', reason: '메모는 ' + NOTE_MAX + '자 이내' });
    else if (hasPII(memo)) errors.push({ field: 'memo', reason: '메모에 전화번호·이메일·주민번호를 넣을 수 없습니다' });
    value.memo = memo;

    const progs = isObj(s.programs) ? s.programs : {};
    value.programs = {};
    PROGRAMS.forEach(k => {
      const p = isObj(progs[k]) ? progs[k] : {};
      const row = { active: !!p.active, account: ACCOUNT_STATES.includes(str(p.account)) ? str(p.account) : 'none' };
      if (str(p.account) && !ACCOUNT_STATES.includes(str(p.account))) errors.push({ field: 'programs.' + k + '.account', reason: '계정 상태 값이 잘못되었습니다' });
      const plan = str(p.plan);
      if (plan.length > 40) errors.push({ field: 'programs.' + k + '.plan', reason: PROGRAM_LABEL[k] + ' 상품명은 40자 이내' });
      else if (hasPII(plan)) errors.push({ field: 'programs.' + k + '.plan', reason: PROGRAM_LABEL[k] + ' 상품명에 전화번호를 넣을 수 없습니다' });
      if (plan) row.plan = plan;
      ['since', 'until'].forEach(f => {
        const v = str(p[f]);
        if (v && !validYmd(v)) errors.push({ field: 'programs.' + k + '.' + f, reason: PROGRAM_LABEL[k] + ' 날짜는 YYYY-MM-DD' });
        if (v && validYmd(v)) row[f] = v;
      });
      value.programs[k] = row;
    });

    const g = isObj(s.guardian) ? s.guardian : {};
    const guardian = { consent: !!g.consent };
    const relation = str(g.relation);
    if (relation.length > 10) errors.push({ field: 'guardian.relation', reason: '관계는 10자 이내' });
    else if (hasPII(relation)) errors.push({ field: 'guardian.relation', reason: '관계 칸에 전화번호를 넣을 수 없습니다' });
    if (relation) guardian.relation = relation;
    const rawPhone = str(g.phone);
    if (rawPhone) {
      if (/[^\d\-\s.()+]/.test(rawPhone)) errors.push({ field: 'guardian.phone', reason: '전화번호는 숫자와 하이픈만' });
      const phone = normalizePhone(rawPhone);
      const digits = phone.replace(/\D/g, '').length;
      if (digits < 8 || digits > 13) errors.push({ field: 'guardian.phone', reason: '전화번호는 8~13자리' });
      guardian.phone = phone;
    }
    value.guardian = guardian;
    return { ok: !errors.length, errors: errors, value: value };
  }

  /** 연락 기록 검증(§3.4 contacts). by는 서버가 토큰으로 덮어쓰므로 여기서는 받지 않는다. */
  function validateContact(input) {
    const s = isObj(input) ? input : {};
    const errors = [];
    const studentId = str(s.studentId);
    if (!studentId) errors.push({ field: 'studentId', reason: '학생을 고르세요' });
    const type = str(s.type);
    if (!CONTACT_TYPES.includes(type)) errors.push({ field: 'type', reason: '연락 유형을 고르세요' });
    const result = str(s.result);
    if (!CONTACT_RESULTS.includes(result)) errors.push({ field: 'result', reason: '결과를 고르세요' });
    const note = str(s.note);
    if (note.length > CONTACT_NOTE_MAX) errors.push({ field: 'note', reason: '메모는 ' + CONTACT_NOTE_MAX + '자 이내' });
    else if (hasPII(note)) errors.push({ field: 'note', reason: '메모에 전화번호·이메일을 넣을 수 없습니다' });
    const value = { studentId: studentId, type: type, result: result };
    if (note) value.note = note;
    return { ok: !errors.length, errors: errors, value: value };
  }

  /* ── 오늘 요약 ─────────────────────────────────────── */

  function defaultDueLimit(task) {
    const start = hmToMin(isObj(task) ? task.time : '');
    return start < 0 ? '' : minToHM(start + 60);
  }

  /**
   * 오늘 지연·막힘·미완료 — 직원 여러 명을 합쳐 센다. dueLimitFn(task) → 'HH:MM'(WBRunbookCore.dueLimit)이
   * 없으면 예정 시각 + 60분. 막힘은 지연으로 세지 않는다(막힘 신고는 감점이 아니다).
   */
  function alertsToday(tasks, checks, staffIds, ymd, nowHM, dueLimitFn) {
    const due = typeof dueLimitFn === 'function' ? dueLimitFn : defaultDueLimit;
    const ch = isObj(checks) ? checks : {};
    const ids = (Array.isArray(staffIds) ? staffIds : []).map(String);
    const now = str(nowHM);
    const out = { total: 0, done: 0, todo: 0, doing: 0, late: [], blocked: [] };
    ids.forEach(sid => tasksFor(tasks, sid, ymd).forEach(t => {
      const c = ch[checkKey(t.id, ymd)] || null;
      const st = statusOf(t, c);
      out.total++;
      if (st === 'done') { out.done++; return; }
      const row = { taskId: String(t.id), staffId: sid, title: str(t.title), time: str(t.time), note: str(c && c.note) };
      if (st === 'blocked') { out.blocked.push(row); return; }
      if (st === 'doing') out.doing++; else out.todo++;
      const limit = due(t);
      if (limit && now && now > limit) out.late.push(Object.assign(row, { dueLimit: limit }));
    }));
    return out;
  }

  /**
   * 마감 브리핑 한 단락 — 오늘 완료/미완료/막힘. o = {date, staff:[{id,name}], tasks, checks, nowHM, dueLimitFn}.
   * 학생 식별자는 싣지 않는다(제목·메모만). 런북 절은 호출부가 WBRunbookUI.briefSection으로 덧붙인다.
   */
  function briefText(o) {
    const opt = isObj(o) ? o : {};
    const date = str(opt.date);
    const staff = (Array.isArray(opt.staff) ? opt.staff : []).filter(isObj);
    const ch = isObj(opt.checks) ? opt.checks : {};
    const a = alertsToday(opt.tasks, ch, staff.map(s => s.id), date, opt.nowHM, opt.dueLimitFn);
    const nameOf = id => { const s = staff.find(x => String(x.id) === String(id)); return s ? str(s.name) : '직원'; };
    const pend = [], blocked = [], clear = [];
    staff.forEach(s => {
      const list = tasksFor(opt.tasks, s.id, date);
      let hasPend = false;
      list.forEach(t => {
        const c = ch[checkKey(t.id, date)] || null;
        const st = statusOf(t, c), pr = taskProgress(t, c);
        if (st === 'done') return;
        hasPend = true;
        const line = '· ' + nameOf(s.id) + ' — ' + str(t.title) + (t.time ? ' (' + t.time + ')' : '') +
          (st === 'doing' ? ' [진행 ' + pr.done + '/' + pr.total + pr.unit + ']' : '') +
          (a.late.some(l => l.taskId === String(t.id)) ? ' [지연]' : '') +
          (c && c.note ? '\n   “' + str(c.note) + '”' : '');
        (st === 'blocked' ? blocked : pend).push(line);
      });
      if (!hasPend && list.length) clear.push(nameOf(s.id));
    });
    const pct = a.total ? Math.round(a.done / a.total * 100) : 0;
    let txt = '📊 ' + label(date) + ' 프로그램데스크 마감 브리핑\n' +
      '전체 ' + a.total + '건 중 ' + a.done + '건 완료 (' + pct + '%) · 지연 ' + a.late.length + ' · 막힘 ' + a.blocked.length + '\n─────────\n';
    if (blocked.length) txt += '🚧 막힘 ' + blocked.length + '건 — 조치 필요\n' + blocked.join('\n') + '\n─────────\n';
    txt += pend.length ? '⚠️ 미완료 ' + pend.length + '건\n' + pend.join('\n') + '\n' : '✅ 미완료 없음\n';
    if (clear.length) txt += '─────────\n✅ 전원 완료: ' + clear.join(', ') + '\n';
    return txt;
  }

  /* ── 배정 카드·템플릿·앱 목적지·매뉴얼 (기획서 v1.1 §1.4·§1.8·§3) ──────────
   * 카드 = 한 대상 × 한 프로그램 × 한 배정. 템플릿(recurring)이 매일 아침 카드를 만들고, 원장 지시는 카드를 직접 만든다.
   * 카드 id 는 템플릿·날짜·대상으로 결정적이라 어느 기기가 몇 번 만들어도 같은 카드 하나다(서버 CAS 0 과 함께 중복을 막는다). */

  function live(list) { return (Array.isArray(list) ? list : []).filter(x => isObj(x) && !x.deleted); }

  function planCardId(planId, ymd, targetId) {
    return 'p:' + str(planId) + ':' + str(ymd) + ':' + (str(targetId) || '-');
  }

  function planActiveOn(plan, ymd) {
    if (!isObj(plan) || plan.kind !== 'recurring' || plan.active === false) return false;
    if (!Array.isArray(plan.days) || !plan.days.map(Number).includes(dowOf(ymd))) return false;
    if (str(plan.start) && ymd < str(plan.start)) return false;
    if (str(plan.end) && ymd > str(plan.end)) return false;
    return true;
  }

  /** 템플릿의 대상을 오늘 실제 대상 목록으로 편다. each = 그 프로그램을 구독 중(active)인 이용 중 학생 전원. */
  function planTargetsFor(plan, students, apps) {
    const t = isObj(plan.target) ? plan.target : {};
    if (t.type === 'each') {
      return live(students).filter(s => str(s.status || 'active') === 'active')
        .filter(s => !PROGRAMS.includes(plan.program) || (isObj(s.programs) && isObj(s.programs[plan.program]) && s.programs[plan.program].active === true))
        .map(s => ({ type: 'student', id: str(s.id) }));
    }
    if (t.type === 'student') {
      const s = live(students).find(x => str(x.id) === str(t.id));
      return s && str(s.status || 'active') !== 'ended' ? [{ type: 'student', id: str(s.id) }] : [];
    }
    if (t.type === 'app') {
      const a = live(apps).find(x => str(x.id) === str(t.id));
      return a && a.active !== false ? [{ type: 'app', id: str(a.id) }] : [];
    }
    if (t.type === 'text') return [{ type: 'text', label: str(t.label) }];
    return [];
  }

  /**
   * 오늘(ymd) 만들어야 할 카드 — 활성 템플릿 × 오늘 요일 × 대상. 이미 있는 id(삭제된 것 포함)는 건너뛴다.
   * 돌려주는 카드는 서버 규칙(ruleCards)이 받는 모양이다. createdBy 는 서버가 토큰 신원으로 덮는다.
   */
  function deriveCards(plans, students, apps, cards, ymd, nowMs, knownIds) {
    // knownIds: 서버가 아는 카드 id(삭제된 것 포함) — 원장이 지운 카드를 아침마다 되살리지 않게 하려는 것.
    const have = new Set((Array.isArray(cards) ? cards : []).filter(isObj).map(c => str(c.id)).concat((Array.isArray(knownIds) ? knownIds : []).map(String)));
    const out = [];
    let skipped = 0;
    (Array.isArray(plans) ? plans : []).forEach(plan => {
      if (isObj(plan) && plan.kind === 'exam') {
        // 시험 템플릿: 시험일 leadDays 전부터 시험일까지 창이 열리고, 학교·학년이 맞는 이용 중 학생 × 자료마다 카드 하나(날짜와 무관한 id 라 한 번만).
        if (plan.active === false || !validYmd(str(plan.examDate)) || !str(plan.school)) return;
        const lead = Number(plan.leadDays) > 0 ? Number(plan.leadDays) : EXAM_LEAD_DEFAULT;
        const before = Number(plan.dueDaysBefore) >= 0 ? Number(plan.dueDaysBefore) : EXAM_DUE_BEFORE_DEFAULT;
        const from = addDays(str(plan.examDate), -lead);
        if (ymd < from || ymd > str(plan.examDate)) return;
        const due = addDays(str(plan.examDate), -before);
        const context = [plan.school, plan.grade, plan.subject, plan.examName, plan.examDate, plan.scope].map(str).filter(Boolean).join(' · ');
        const targets = live(students).filter(s => str(s.status || 'active') === 'active' && normName(s.school) === normName(plan.school) &&
          (!str(plan.grade) || normName(s.grade) === normName(plan.grade)));
        (Array.isArray(plan.materials) ? plan.materials : []).forEach((m, i) => {
          if (!isObj(m) || !EXAM_SOURCES.includes(m.source) || !str(m.what)) return;
          targets.forEach(s => {
            const id = 'p:' + str(plan.id) + ':m' + i + ':' + str(s.id);
            if (have.has(id)) { skipped++; return; }
            have.add(id);
            const card = { id: id, program: m.source, target: { type: 'student', id: str(s.id) }, what: str(m.what), status: 'todo', due: due, source: 'plan:' + str(plan.id), createdAt: Number(nowMs) || 0, note: context.slice(0, 300) };
            if (str(m.where)) card.where = str(m.where);
            out.push(card);
          });
        });
        return;
      }
      if (!planActiveOn(plan, ymd) || !ROOMS.includes(plan.program)) return;
      planTargetsFor(plan, students, apps).forEach(target => {
        const id = planCardId(plan.id, ymd, target.type === 'text' ? slugOf(target.label) : target.id);
        if (have.has(id)) { skipped++; return; }
        have.add(id);
        const card = { id: id, program: plan.program, target: target, what: str(plan.what), status: 'todo', due: ymd, source: 'plan:' + str(plan.id), createdAt: Number(nowMs) || 0 };
        if (str(plan.where)) card.where = str(plan.where);
        if (str(plan.manualId)) card.manualId = str(plan.manualId);
        out.push(card);
      });
    });
    return { cards: out, skipped: skipped };
  }
  function slugOf(text) { return str(text).toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x'; }

  function cardLate(card, ymd) { return !!(isObj(card) && card.status !== 'done' && str(card.due) && str(card.due) < str(ymd)); }

  /** 오늘 화면의 카드: 열린 것(기한 없음·오늘·지난 미완료) + 예정(기한이 뒤) + 오늘 완료한 것. 열린 것은 막힘 → 지연 → 진행 → 대기 순. */
  function cardsOn(cards, ymd) {
    const day = str(ymd);
    const open = [], upcoming = [], done = [];
    live(cards).forEach(c => {
      if (c.status === 'done') { if (doneYmd(c) === day || str(c.due) === day) done.push(c); return; }
      if (!str(c.due) || str(c.due) <= day) open.push(c); else upcoming.push(c);
    });
    const rank = c => (c.status === 'blocked' ? 0 : cardLate(c, day) ? 1 : c.status === 'doing' ? 2 : 3);
    const dueKey = c => str(c.due) || '9999-99-99';   // 기한 없는 카드는 뒤로
    const tie = (a, b) => dueKey(a).localeCompare(dueKey(b)) || str(a.program).localeCompare(str(b.program)) || str(a.what).localeCompare(str(b.what));
    open.sort((a, b) => rank(a) - rank(b) || tie(a, b));
    upcoming.sort(tie);
    done.sort((a, b) => (Number(b.doneAt) || 0) - (Number(a.doneAt) || 0));
    return { open: open, upcoming: upcoming, done: done };
  }
  /** 기한까지 남은 날 — 예정 카드의 D-n. 기한이 없거나 지났으면 null. */
  function daysUntil(card, ymd) {
    const a = parseYmd(str(ymd)), b = parseYmd(str(card && card.due));
    if (!a || !b || b <= a) return null;
    return Math.round((b - a) / 86400000);
  }

  /** 직원별 처리 지표 — 최근 days 일 동안 완료한 카드: 건수·기한 넘긴 완료·처리 시간(만든 뒤 완료까지, 분). doneBy 가 토큰 신원이라 믿을 수 있다. */
  function staffStats(cards, ymd, days) {
    const n = Number(days) > 0 ? Number(days) : 7;
    const from = addDays(str(ymd), -(n - 1));
    const by = {};
    live(cards).forEach(c => {
      if (c.status !== 'done') return;
      const d = doneYmd(c);
      if (!d || d < from || d > str(ymd)) return;
      const id = str(c.doneBy) || '?';
      const r = by[id] || (by[id] = { staffId: id, done: 0, lateDone: 0, minutes: [] });
      r.done++;
      if (str(c.due) && d > str(c.due)) r.lateDone++;
      const created = Number(c.createdAt), doneAt = Number(c.doneAt);
      if (created > 0 && doneAt >= created) r.minutes.push(Math.round((doneAt - created) / 60000));
    });
    return Object.keys(by).map(k => {
      const r = by[k];
      const m = r.minutes.slice().sort((a, b) => a - b);
      return { staffId: r.staffId, done: r.done, lateDone: r.lateDone, timed: m.length,
        avgMinutes: m.length ? Math.round(m.reduce((a, b) => a + b, 0) / m.length) : null, medianMinutes: m.length ? m[Math.floor((m.length - 1) / 2)] : null };
    }).sort((a, b) => b.done - a.done || a.staffId.localeCompare(b.staffId));
  }

  /** 시험 템플릿 폼 → plan(exam). materialsText 는 "출처 | 무엇을 | 어디에" 줄(출처: 이그잼포유/족보닷컴). */
  function validateExam(input) {
    const i = isObj(input) ? input : {};
    let e = lengthErr('학교', i.school, 1, 40) || (str(i.grade).length > 10 ? '학년은 10자까지입니다' : '') || (str(i.subject).length > 40 ? '과목은 40자까지입니다' : '') ||
      (str(i.textbook).length > 40 ? '교과서는 40자까지입니다' : '') || (str(i.examName).length > 40 ? '시험 이름은 40자까지입니다' : '') || (str(i.scope).length > 120 ? '시험 범위는 120자까지입니다' : '') ||
      (str(i.note).length > 300 ? '메모는 300자까지입니다' : '');
    if (e) return { value: null, error: e };
    if (!validYmd(str(i.examDate))) return { value: null, error: '시험일은 YYYY-MM-DD 형식입니다' };
    const lead = str(i.leadDays) === '' ? EXAM_LEAD_DEFAULT : Number(i.leadDays);
    const before = str(i.dueDaysBefore) === '' ? EXAM_DUE_BEFORE_DEFAULT : Number(i.dueDaysBefore);
    if (!Number.isInteger(lead) || lead < 1 || lead > 90) return { value: null, error: '몇 일 전부터(1~90)를 확인하세요' };
    if (!Number.isInteger(before) || before < 0 || before > 60 || before >= lead) return { value: null, error: '전달 기한(시험 몇 일 전, 0~60)은 시작보다 앞설 수 없습니다' };
    const materials = [];
    const lines = String(i.materialsText == null ? '' : i.materialsText).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return { value: null, error: '자료를 한 줄 이상 적으세요 (출처 | 무엇을 | 어디에)' };
    if (lines.length > 20) return { value: null, error: '자료는 20줄까지입니다' };
    for (const line of lines) {
      const parts = line.split('|').map(s => s.trim());
      const src = parts[0].toLowerCase();
      const source = /이그잼|exam4you/.test(src) ? 'exam4you' : /족보|jokbo/.test(src) ? 'jokbo' : '';
      if (!source) return { value: null, error: '자료 줄은 "이그잼포유 | 무엇을 | 어디에" 또는 "족보닷컴 | …"으로 시작해야 합니다' };
      const what = str(parts[1]);
      if (!what || what.length > 120) return { value: null, error: '자료의 "무엇을"은 1~120자여야 합니다' };
      const where = str(parts[2]);
      if (where.length > 120) return { value: null, error: '자료의 "어디에"는 120자까지입니다' };
      const m = { source: source, what: what };
      if (where) m.where = where;
      materials.push(m);
    }
    e = piiErr([i.school, i.grade, i.subject, i.textbook, i.examName, i.scope, i.materialsText, i.note]);
    if (e) return { value: null, error: e };
    const value = { kind: 'exam', school: str(i.school), examDate: str(i.examDate), leadDays: lead, dueDaysBefore: before, materials: materials, active: i.active !== false };
    ['grade', 'subject', 'textbook', 'examName', 'scope', 'note'].forEach(k => { if (str(i[k])) value[k] = str(i[k]); });
    return { value: value, error: '' };
  }
  function doneYmd(card) {
    const n = Number(card && card.doneAt);
    return n > 0 ? ymdOf(new Date(n)) : '';
  }

  /** 방별 묶음 — ROOMS 순서의 {program: [cards]}. 모르는 프로그램은 버린다. */
  function groupByRoom(cards) {
    const out = {};
    ROOMS.forEach(k => { out[k] = []; });
    (Array.isArray(cards) ? cards : []).forEach(c => { if (isObj(c) && out[c.program]) out[c.program].push(c); });
    return out;
  }

  /** 원장 매트릭스 — 이용 중 학생 × 방. 칸 = 구독 여부 + 마지막 카드(기한 최신)의 상태. */
  function matrixOf(students, cards, ymd) {
    const byKey = {};
    live(cards).forEach(c => {
      if (!isObj(c.target) || c.target.type !== 'student' || !ROOMS.includes(c.program)) return;
      const key = str(c.target.id) + '|' + c.program;
      const cur = byKey[key];
      const newer = !cur || str(c.due) > str(cur.due) || (str(c.due) === str(cur.due) && (Number(c.createdAt) || 0) > (Number(cur.createdAt) || 0));
      if (newer) byKey[key] = c;
    });
    return live(students).filter(s => str(s.status || 'active') !== 'ended').map(s => {
      const cells = {};
      ROOMS.forEach(p => {
        const sub = PROGRAMS.includes(p) ? !!(isObj(s.programs) && isObj(s.programs[p]) && s.programs[p].active === true) : null;
        const last = byKey[str(s.id) + '|' + p] || null;
        cells[p] = { sub: sub, status: last ? str(last.status) : '', due: last ? str(last.due) : '', late: last ? cardLate(last, ymd) : false, what: last ? str(last.what) : '' };
      });
      return { id: str(s.id), name: str(s.name), grade: str(s.grade), cells: cells };
    });
  }

  /** 앱 × 범위 커버리지 — 앱마다 범위 행과 상태별 건수. */
  function coverageOf(apps, plans) {
    const ranges = live(plans).filter(p => p.kind === 'apprange');
    return live(apps).map(app => {
      const rows = ranges.filter(r => str(r.appId) === str(app.id))
        .sort((a, b) => str(a.subject).localeCompare(str(b.subject)) || str(a.grade).localeCompare(str(b.grade)) || str(a.unit).localeCompare(str(b.unit)));
      const counts = { need: 0, buying: 0, uploading: 0, have: 0 };
      rows.forEach(r => { if (counts[r.status] != null) counts[r.status]++; });
      return { app: app, rows: rows, counts: counts, total: rows.length };
    });
  }

  /** 카드에 붙는 매뉴얼 — manualId 가 있으면 그것, 없으면 같은 방의 첫 항목(작업 종류 'assign' 우선). */
  function manualFor(manuals, card) {
    const list = live(manuals);
    if (isObj(card) && str(card.manualId)) {
      const hit = list.find(m => str(m.id) === str(card.manualId));
      if (hit) return hit;
    }
    const scope = isObj(card) && isObj(card.target) && card.target.type === 'app' ? 'app' : (isObj(card) ? str(card.program) : '');
    const same = list.filter(m => str(m.scope) === scope && (scope !== 'app' || !str(m.appId) || str(m.appId) === str(card.target.id)));
    return same.find(m => m.task === 'assign') || same[0] || null;
  }
  function manualsFor(manuals, scope, appId) {
    return live(manuals).filter(m => str(m.scope) === str(scope) && (str(scope) !== 'app' || !str(appId) || !str(m.appId) || str(m.appId) === str(appId)))
      .sort((a, b) => str(a.task).localeCompare(str(b.task)) || str(a.title).localeCompare(str(b.title)));
  }

  function lengthErr(label, v, min, max) {
    const s = str(v);
    if (s.length < min) return label + '을(를) 입력하세요';
    if (s.length > max) return label + '은(는) ' + max + '자까지입니다';
    return '';
  }
  function piiErr(values) {
    for (const v of values) if (hasPII(v)) return '학생 이름 외의 개인정보(전화번호·이메일)는 적을 수 없습니다';
    return '';
  }

  /** 지시 폼 → 카드 데이터. {value, error} */
  function validateCard(input) {
    const i = isObj(input) ? input : {};
    if (!ROOMS.includes(i.program)) return { value: null, error: '프로그램을 고르세요' };
    const tt = str(i.targetType);
    if (!CARD_TARGETS.includes(tt)) return { value: null, error: '대상 종류를 고르세요' };
    const target = { type: tt };
    if (tt === 'text') {
      const e = lengthErr('대상', i.targetLabel, 1, 60);
      if (e) return { value: null, error: e };
      target.label = str(i.targetLabel);
    } else {
      if (!DOC_ID_RE.test(str(i.targetId))) return { value: null, error: tt === 'app' ? '앱을 고르세요' : '학생을 고르세요' };
      target.id = str(i.targetId);
    }
    let e = lengthErr('무엇을', i.what, 1, 120) || (str(i.where).length > 120 ? '어디에는 120자까지입니다' : '') || (str(i.note).length > 300 ? '메모는 300자까지입니다' : '');
    if (e) return { value: null, error: e };
    if (str(i.due) && !validYmd(str(i.due))) return { value: null, error: '기한은 YYYY-MM-DD 형식입니다' };
    e = piiErr([i.what, i.where, i.note, i.targetLabel]);
    if (e) return { value: null, error: e };
    const value = { program: i.program, target: target, what: str(i.what), status: 'todo', source: str(i.source) || 'order' };
    if (str(i.where)) value.where = str(i.where);
    if (str(i.due)) value.due = str(i.due);
    if (str(i.note)) value.note = str(i.note);
    if (str(i.manualId)) value.manualId = str(i.manualId);
    return { value: value, error: '' };
  }

  /** 반복 템플릿 폼 → plan(recurring). days 는 [0..6] 배열. */
  function validateRecurring(input) {
    const i = isObj(input) ? input : {};
    if (!ROOMS.includes(i.program)) return { value: null, error: '프로그램을 고르세요' };
    const days = (Array.isArray(i.days) ? i.days : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
    if (!days.length) return { value: null, error: '요일을 하나 이상 고르세요' };
    const tt = str(i.targetType);
    if (!PLAN_TARGETS.includes(tt)) return { value: null, error: '대상 종류를 고르세요' };
    const target = { type: tt };
    if (tt === 'student' || tt === 'app') {
      if (!DOC_ID_RE.test(str(i.targetId))) return { value: null, error: tt === 'app' ? '앱을 고르세요' : '학생을 고르세요' };
      target.id = str(i.targetId);
    } else if (tt === 'text') {
      const e = lengthErr('대상', i.targetLabel, 1, 60);
      if (e) return { value: null, error: e };
      target.label = str(i.targetLabel);
    }
    let e = lengthErr('무엇을', i.what, 1, 120) || (str(i.where).length > 120 ? '어디에는 120자까지입니다' : '');
    if (e) return { value: null, error: e };
    for (const k of ['start', 'end']) if (str(i[k]) && !validYmd(str(i[k]))) return { value: null, error: (k === 'start' ? '시작' : '끝') + '은 YYYY-MM-DD 형식입니다' };
    e = piiErr([i.what, i.where, i.targetLabel, i.note]);
    if (e) return { value: null, error: e };
    const value = { kind: 'recurring', program: i.program, days: Array.from(new Set(days)).sort((a, b) => a - b), target: target, what: str(i.what), active: i.active !== false };
    ['where', 'manualId', 'start', 'end', 'note'].forEach(k => { if (str(i[k])) value[k] = str(i[k]); });
    return { value: value, error: '' };
  }

  /** 앱 자료 범위 폼 → plan(apprange). */
  function validateRange(input) {
    const i = isObj(input) ? input : {};
    if (!DOC_ID_RE.test(str(i.appId))) return { value: null, error: '앱을 고르세요' };
    let e = lengthErr('범위', i.unit, 1, 80) || (str(i.subject).length > 40 ? '과목은 40자까지입니다' : '') || (str(i.grade).length > 10 ? '학년은 10자까지입니다' : '') ||
      (str(i.material).length > 40 ? '자료 종류는 40자까지입니다' : '') || (str(i.note).length > 300 ? '메모는 300자까지입니다' : '');
    if (e) return { value: null, error: e };
    const status = str(i.status) || 'need';
    if (!RANGE_STATUS.includes(status)) return { value: null, error: '상태가 올바르지 않습니다' };
    const source = str(i.source) || 'exam4you';
    if (!RANGE_SOURCES.includes(source)) return { value: null, error: '출처가 올바르지 않습니다' };
    e = piiErr([i.unit, i.subject, i.grade, i.material, i.note]);
    if (e) return { value: null, error: e };
    const value = { kind: 'apprange', appId: str(i.appId), unit: str(i.unit), status: status, source: source };
    ['subject', 'grade', 'material', 'note'].forEach(k => { if (str(i[k])) value[k] = str(i[k]); });
    return { value: value, error: '' };
  }

  function validateApp(input) {
    const i = isObj(input) ? input : {};
    let e = lengthErr('앱 이름', i.name, 1, 40) || (str(i.format).length > 80 ? '자료 형식은 80자까지입니다' : '') || (str(i.note).length > 300 ? '메모는 300자까지입니다' : '');
    if (e) return { value: null, error: e };
    if (str(i.adminUrl) && !HTTPS_RE.test(str(i.adminUrl))) return { value: null, error: '관리 웹 주소는 https:// 로 시작해야 합니다' };
    e = piiErr([i.name, i.format, i.note]);
    if (e) return { value: null, error: e };
    const value = { name: str(i.name), active: i.active !== false };
    ['adminUrl', 'format', 'note'].forEach(k => { if (str(i[k])) value[k] = str(i[k]); });
    return { value: value, error: '' };
  }

  /** 매뉴얼 폼 → manual. steps·cautions 는 줄 단위 텍스트, links 는 "이름 | 주소(https)" 줄. */
  function validateManual(input) {
    const i = isObj(input) ? input : {};
    if (!MANUAL_SCOPES.includes(i.scope)) return { value: null, error: '어느 방의 매뉴얼인지 고르세요' };
    let e = lengthErr('작업 종류', i.task, 1, 40) || lengthErr('제목', i.title, 1, 80) || (str(i.purpose).length > 300 ? '목적은 300자까지입니다' : '');
    if (e) return { value: null, error: e };
    const lines = text => String(text == null ? '' : text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const steps = lines(i.stepsText);
    if (steps.length > 40) return { value: null, error: '단계는 40개까지입니다' };
    if (steps.some(s => s.length > 300)) return { value: null, error: '단계는 각 300자까지입니다' };
    const cautions = lines(i.cautionsText);
    if (cautions.length > 20) return { value: null, error: '주의점은 20개까지입니다' };
    if (cautions.some(s => s.length > 300)) return { value: null, error: '주의점은 각 300자까지입니다' };
    const links = [];
    for (const line of lines(i.linksText)) {
      const m = line.match(/^(.+?)\s*\|\s*(https:\/\/\S+)$/);
      if (!m || m[1].trim().length > 40 || !HTTPS_RE.test(m[2])) return { value: null, error: '링크는 "이름 | 주소" 형식으로 한 줄에 하나씩, 주소는 https 로 시작해야 합니다' };
      links.push({ label: m[1].trim(), url: m[2] });
    }
    if (links.length > 10) return { value: null, error: '링크는 10개까지입니다' };
    if (str(i.lastCheckedAt) && !validYmd(str(i.lastCheckedAt))) return { value: null, error: '마지막 확인일은 YYYY-MM-DD 형식입니다' };
    e = piiErr([i.title, i.purpose, i.stepsText, i.cautionsText]);
    if (e) return { value: null, error: e };
    const value = { scope: i.scope, task: str(i.task), title: str(i.title), steps: steps.map(t => ({ text: t })), cautions: cautions, links: links, version: Number(i.version) > 0 ? Number(i.version) : 1 };
    if (str(i.purpose)) value.purpose = str(i.purpose);
    if (str(i.appId) && i.scope === 'app') value.appId = str(i.appId);
    if (str(i.lastCheckedAt)) value.lastCheckedAt = str(i.lastCheckedAt);
    return { value: value, error: '' };
  }

  /* ── 라우트 ────────────────────────────────────────── */

  /** '#/students' → {route:'students', code:''} · '#/p/classcard' → {route:'room', room:'classcard'} · '#c=abc' → 코드 · 모르면 today */
  function routeOf(hash) {
    const h = String(hash || '').replace(/^#/, '');
    const m = h.match(/^c=([A-Za-z0-9_-]{4,200})$/);
    if (m) return { route: 'today', room: '', code: m[1] };
    const parts = h.replace(/^\/+/, '').split(/[/?]/);
    if (parts[0] === 'p') return ROOMS.includes(parts[1]) ? { route: 'room', room: parts[1], code: '' } : { route: 'today', room: '', code: '' };
    const r = parts[0];
    return { route: ROUTES.includes(r) && r !== 'room' ? r : 'today', room: '', code: '' };
  }

  /** 직원 초대 링크 — 앱 주소 + '#c=' + 코드. index.html로 열렸어도 디렉터리 주소로 정리한다. */
  function inviteLink(origin, pathname, code) {
    const dir = String(pathname || '/').replace(/index\.html$/, '');
    return String(origin || '') + (dir.startsWith('/') ? dir : '/' + dir) + '#c=' + String(code || '');
  }

  return {
    PROGRAMS: PROGRAMS, PROGRAM_LABEL: PROGRAM_LABEL, STUDENT_STATUS: STUDENT_STATUS, STUDENT_STATUS_LABEL: STUDENT_STATUS_LABEL,
    ACCOUNT_STATES: ACCOUNT_STATES, ACCOUNT_LABEL: ACCOUNT_LABEL, CONTACT_TYPES: CONTACT_TYPES, CONTACT_TYPE_LABEL: CONTACT_TYPE_LABEL,
    CONTACT_RESULTS: CONTACT_RESULTS, CONTACT_RESULT_LABEL: CONTACT_RESULT_LABEL, REPEATS: REPEATS, TASK_STATUS_LABEL: TASK_STATUS_LABEL,
    ROUTES: ROUTES, DOW: DOW, NOTE_MAX: NOTE_MAX, CONTACT_NOTE_MAX: CONTACT_NOTE_MAX, DOC_ID_RE: DOC_ID_RE, EXT_KEY_RE: EXT_KEY_RE,
    hasPII: hasPII,
    ymdOf: ymdOf, parseYmd: parseYmd, validYmd: validYmd, validYm: validYm, dowOf: dowOf, addDays: addDays, mondayOf: mondayOf,
    label: label, shortDate: shortDate, hmOf: hmOf, hmToMin: hmToMin, minToHM: minToHM, repeatLabel: repeatLabel,
    occursOn: occursOn, tasksFor: tasksFor, checkKey: checkKey, taskSteps: taskSteps, taskProgress: taskProgress,
    isDone: isDone, statusOf: statusOf, autoDone: autoDone, carriedTasks: carriedTasks,
    parseAssignments: parseAssignments, applyAssignmentsPure: applyAssignmentsPure,
    studentsToRoster: studentsToRoster, seedPerfsets: seedPerfsets, searchStudents: searchStudents,
    docKey: docKey, mergeDocs: mergeDocs, revertDoc: revertDoc, createOutbox: createOutbox, slug: slug,
    normalizePhone: normalizePhone, maskPhone: maskPhone, validateStudent: validateStudent, validateContact: validateContact,
    alertsToday: alertsToday, briefText: briefText, routeOf: routeOf, inviteLink: inviteLink,
    ROOMS: ROOMS, ROOM_LABEL: ROOM_LABEL, CARD_STATUS: CARD_STATUS, CARD_STATUS_LABEL: CARD_STATUS_LABEL, CARD_TARGETS: CARD_TARGETS,
    PLAN_TARGETS: PLAN_TARGETS, PLAN_TARGET_LABEL: PLAN_TARGET_LABEL, RANGE_STATUS: RANGE_STATUS, RANGE_STATUS_LABEL: RANGE_STATUS_LABEL,
    RANGE_SOURCES: RANGE_SOURCES, MANUAL_SCOPES: MANUAL_SCOPES, EXAM_SOURCES: EXAM_SOURCES,
    EXAM_LEAD_DEFAULT: EXAM_LEAD_DEFAULT, EXAM_DUE_BEFORE_DEFAULT: EXAM_DUE_BEFORE_DEFAULT,
    planCardId: planCardId, planActiveOn: planActiveOn, planTargetsFor: planTargetsFor, deriveCards: deriveCards, cardLate: cardLate,
    cardsOn: cardsOn, daysUntil: daysUntil, groupByRoom: groupByRoom, matrixOf: matrixOf, coverageOf: coverageOf, staffStats: staffStats,
    manualFor: manualFor, manualsFor: manualsFor,
    validateCard: validateCard, validateRecurring: validateRecurring, validateRange: validateRange, validateApp: validateApp, validateManual: validateManual,
    validateExam: validateExam
  };
});
