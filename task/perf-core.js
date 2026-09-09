(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBPerfCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 수행 신호 관제(기획 제안 C, Phase 0)의 순수 로직.
     저장은 전부 checks 테이블의 '__prefix__<id>|<scope>' 키다 — 출결·기기 대장과 같은 방식이라
     백엔드를 건드리지 않는다. 기존 __opset__/__op__/__exam__ 은 학생 "이름" 키(레거시)라
     여기서는 읽기만 하고, 새 기록은 roster의 stable studentId 키로만 남긴다.
     점수·정답률·전화·학교명·계정 ID는 어떤 값에도 넣지 않는다 — 앱은 공개 오리진이고
     이 안이 다루는 것은 이탈 선행지표(했는가/안 했는가)뿐이다. 모든 값은 닫힌 enum이다. */

  const PERFSET_PREFIX = '__perfset__';
  const PERFDAY_PREFIX = '__perfday__';
  const ACT_PREFIX = '__act__';
  const LEGACY_OPSET_PREFIX = '__opset__';
  const LEGACY_EXAM_PREFIX = '__exam__';
  const ATT_PREFIX = '__st__';
  const ONBOARDING_PREFIX = '__onboarding__';
  /* 신규생 "프로그램 계정·첫 과제 배정" 항목 id. index.html의 ONBOARDING_STAGES에 통합 담당이
     같은 id로 항목을 추가한다 — 여기 상수 하나만 맞추면 S2가 살아난다. */
  const ONBOARDING_ACCOUNT_ITEM = 'program_account';

  /* 프로그램 키는 영문 고정. 표시명은 UI가 붙인다 — 레거시 __opset__ 이 한글 라벨을 값으로
     써서 라벨을 바꾸면 데이터가 깨졌던 전철을 밟지 않는다. */
  const PROGS = ['studyforce', 'classcard'];
  const PROG_LABEL = { studyforce: '스터디포스', classcard: '클래스카드' };
  const LEGACY_PROG = { '스터디포스': 'studyforce', '클래스카드': 'classcard' };
  const DEFAULT_TARGET = { studyforce: 5, classcard: 5 };
  const DEFAULT_DUE_DAYS = [1, 2, 3, 4, 5];   // 월~금 (0=일)

  const DAY_STATES = ['completed', 'partial', 'not_completed', 'unknown', 'not_due', 'absent'];
  const EX_STATES = ['not_completed', 'partial', 'unknown'];
  const BASIS = ['login_log', 'assignment_status', 'report'];
  const WHYS = ['no_login', 'no_assignment', 'account_issue', 'score_below_target', 'review_pending', 'other'];
  const ACTION_TYPES = ['contact', 'assign', 'teacher_note', 'nelt_notice', 'audit'];
  const ACTION_STATES = ['open', 'done', 'blocked', 'skipped'];
  const PRIORITIES = ['P0', 'P1', 'P2'];
  const RESULTS = { contact: ['reached', 'no_answer'], audit: ['match', 'mismatch'] };
  const SET_FROM = ['legacy', 'bulk'];

  /* 신호 규칙은 고정이고 늘리지 않는다(C.10). 구현되지 않은 규칙은 표에만 있고 signals()가 건너뛴다. */
  const RULES = [
    { id: 'S1', label: '연속 미수행', phase: 0, impl: true },
    { id: 'S2', label: '신규 미시작', phase: 0, impl: true },
    { id: 'S3', label: '미확인 누적', phase: 1, impl: true },
    { id: 'S4', label: '과제 미배정', phase: 1, impl: true },
    { id: 'S5', label: '넬트 하락·정체', phase: 1, impl: false },
    { id: 'S6', label: '주간 미수행 2일+', phase: 1, impl: true },
    { id: 'S7', label: '시험 자료 미인계', phase: 2, impl: false },
    { id: 'S8', label: '넬트 90일 미응시', phase: 1, impl: false }
  ];

  /* 에이전트(agent-studyforce-manager) 등급을 그대로 코드화한다: P0 7일 · P1 3일 · P2 1일.
     연속은 "대상일 기준"으로 재정의 — 주말·비대상일·결석은 세지도 끊지도 않는다. */
  const STREAK_P0 = 7;
  const STREAK_P1 = 3;
  const S2_DUE_WINDOW = 5;      // 계정 완료 후 대상일 5일
  const S2_GRACE_DAYS = 7;      // 창이 지난 뒤 1주까지만 — 그 뒤는 S1이 같은 학생을 잡는다
  const S3_UNKNOWN_RUN = 2;
  const S6_MIN_NOT_DONE = 2;
  const DEFAULT_CAP = 12;       // 직원 일일 조치 상한(C.11 신호 과다 완화)
  /* 스탬프가 없는 날(unknown)은 끊지 않고 건너뛰므로, 기록 시작 전 과거로 무한히 거슬러 가지
     않게 상한을 둔다. 60일이면 주말 포함 대상일 40여 일 — P0 임계(7)의 5배가 넘는다. */
  const LOOKBACK_DAYS = 60;
  const DAY_MS = 86400000;

  /* ── 문자열·날짜 ──
     ymd 문자열은 이미 KST 달력 날짜다. 호스트 시간대·DST의 영향을 받지 않도록
     Date.UTC 산술만 쓴다. 주 경계(KST 월요일)는 index.html의 mondayOf를 ctx로 주입받는 것을
     우선하고, 없을 때만 같은 규칙(일요일은 지난 월요일에 붙는다)으로 계산한다. */
  function str(v) { return v == null ? '' : String(v).trim(); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
    if (!m) return null;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isFinite(t) ? t : null;
  }
  function fmtUtc(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function validYmd(s) { const t = parseYmd(s); return t != null && fmtUtc(t) === str(s); }
  function addDays(ymd, n) { const t = parseYmd(ymd); return t == null ? '' : fmtUtc(t + (Number(n) || 0) * DAY_MS); }
  function dowOf(ymd) { const t = parseYmd(ymd); return t == null ? -1 : new Date(t).getUTCDay(); }
  function mondayOfDefault(ymd) { const d = dowOf(ymd); return d < 0 ? '' : addDays(ymd, -((d + 6) % 7)); }
  function diffDays(a, b) {
    const ta = parseYmd(a), tb = parseYmd(b);
    return ta == null || tb == null ? null : Math.round((ta - tb) / DAY_MS);
  }
  function weekOf(ctx, ymd) {
    const fn = ctx && typeof ctx.mondayOf === 'function' ? ctx.mondayOf : mondayOfDefault;
    const mon = str(fn(ymd));
    return validYmd(mon) ? mon : mondayOfDefault(ymd);
  }
  function median(list) {
    const l = (list || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!l.length) return null;
    const mid = Math.floor(l.length / 2);
    return l.length % 2 ? l[mid] : (l[mid - 1] + l[mid]) / 2;
  }

  /* ── 키 ── */
  function perfsetTaskId(studentId) { return PERFSET_PREFIX + str(studentId); }
  function perfsetKey(studentId) { return perfsetTaskId(studentId) + '|all'; }
  /* __perfday__ 행은 setCheck('__perfday__' + prog, ymd, …) 로 만들어진다 — 날짜가 scope다. */
  function perfdayTaskId(prog) { return PERFDAY_PREFIX + str(prog); }
  function perfdayKey(prog, ymd) { return perfdayTaskId(prog) + '|' + str(ymd); }
  function actTaskId(staffId) { return ACT_PREFIX + str(staffId); }
  function actKey(staffId, actionId) { return actTaskId(staffId) + '|' + str(actionId); }
  /* perfset·perfday는 관리자 범위(owner null). __act__<staffId> 는 직원 소유라 기존 일반 규칙을 탄다. */
  function isPerfKey(key) {
    const k = str(key);
    return k.startsWith(PERFSET_PREFIX) || k.startsWith(PERFDAY_PREFIX);
  }
  function isActKey(key) { return str(key).startsWith(ACT_PREFIX); }
  function parseActKey(key) {
    const k = str(key);
    if (!isActKey(k)) return null;
    const bar = k.indexOf('|');
    if (bar < 0) return null;
    const staffId = k.slice(ACT_PREFIX.length, bar), actionId = k.slice(bar + 1);
    return staffId && actionId ? { staffId: staffId, actionId: actionId } : null;
  }
  function parsePerfdayKey(key) {
    const k = str(key);
    if (!k.startsWith(PERFDAY_PREFIX)) return null;
    const bar = k.indexOf('|');
    if (bar < 0) return null;
    const prog = k.slice(PERFDAY_PREFIX.length, bar), ymd = k.slice(bar + 1);
    return PROGS.includes(prog) && validYmd(ymd) ? { prog: prog, ymd: ymd } : null;
  }

  /* ── 정규화: 닫힌 enum 밖의 값은 버린다 ── */
  function normalizeDueDays(v) {
    const list = Array.isArray(v) ? v.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : [];
    return Array.from(new Set(list)).sort((a, b) => a - b);
  }
  function normalizePerfset(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const progs = Array.isArray(r.progs) ? r.progs.map(str).filter(p => PROGS.includes(p)) : [];
    const dueDays = {}, target = {};
    let hasTarget = false;
    progs.forEach(p => {
      const dd = normalizeDueDays(r.dueDays && r.dueDays[p]);
      dueDays[p] = dd.length ? dd : DEFAULT_DUE_DAYS.slice();
      const t = r.target && Number(r.target[p]);
      if (Number.isFinite(t) && t > 0 && t <= 7) { target[p] = t; hasTarget = true; }
    });
    return {
      progs: Array.from(new Set(progs)),
      dueDays: dueDays,
      target: hasTarget ? target : null,
      from: SET_FROM.includes(str(r.from)) ? str(r.from) : 'bulk'
    };
  }
  function dueDaysOf(perfset, prog) {
    const ps = normalizePerfset(perfset);
    return ps.dueDays[prog] || DEFAULT_DUE_DAYS.slice();
  }
  /* target이 null이면 기본값(5·5). 학생별 override는 Phase 1 — 값은 이미 받을 수 있게 둔다. */
  function targetOf(perfset, prog) {
    const ps = normalizePerfset(perfset);
    const t = ps.target && ps.target[prog];
    return Number.isFinite(t) && t > 0 ? t : (DEFAULT_TARGET[prog] || 5);
  }

  function normalizeStamp(raw) {
    const s = raw && typeof raw === 'object' ? raw : null;
    if (!s) return null;
    const at = Number(s.at) || 0;
    const basis = BASIS.includes(str(s.basis)) ? str(s.basis) : '';
    if (!at && !basis) return null;
    return { by: str(s.by), at: at, basis: basis || BASIS[0] };
  }
  function normalizeEx(raw) {
    const out = {};
    const ex = raw && typeof raw === 'object' ? raw : {};
    Object.keys(ex).forEach(id => {
      const e = ex[id] && typeof ex[id] === 'object' ? ex[id] : null;
      if (!e || !EX_STATES.includes(str(e.st))) return;
      out[str(id)] = { st: str(e.st), why: WHYS.includes(str(e.why)) ? str(e.why) : '' };
    });
    return out;
  }
  function normalizePerfday(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return { stamp: normalizeStamp(r.stamp), ex: normalizeEx(r.ex) };
  }
  function hasStamp(row) { return !!normalizePerfday(row).stamp; }

  function priorityRank(p) { const i = PRIORITIES.indexOf(str(p)); return i < 0 ? PRIORITIES.length : i; }
  function normalizeHist(list) {
    const seen = {};
    return (Array.isArray(list) ? list : []).map(h => ({
      st: ACTION_STATES.includes(str(h && h.st)) ? str(h.st) : 'open',
      at: Number(h && h.at) || 0,
      by: str(h && h.by),
      result: str(h && h.result)
    })).filter(h => {
      const k = h.st + '|' + h.at + '|' + h.by + '|' + h.result;
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    }).sort((a, b) => a.at - b.at);
  }
  function normalizeAction(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const type = ACTION_TYPES.includes(str(r.type)) ? str(r.type) : 'contact';
    const allowed = RESULTS[type] || [];
    const ev = r.evidence && typeof r.evidence === 'object' ? r.evidence : {};
    return {
      actionId: str(r.actionId),
      staffId: str(r.staffId),
      studentId: str(r.studentId),
      type: type,
      rule: str(r.rule),
      priority: PRIORITIES.includes(str(r.priority)) ? str(r.priority) : 'P2',
      evidence: {
        prog: PROGS.includes(str(ev.prog)) ? str(ev.prog) : '',
        dueStreak: Number(ev.dueStreak) || 0,
        from: validYmd(ev.from) ? str(ev.from) : '',
        to: validYmd(ev.to) ? str(ev.to) : '',
        why: WHYS.includes(str(ev.why)) ? str(ev.why) : '',
        count: Number(ev.count) || 0
      },
      st: ACTION_STATES.includes(str(r.st)) ? str(r.st) : 'open',
      openedAt: Number(r.openedAt) || 0,
      openedDate: validYmd(r.openedDate) ? str(r.openedDate) : '',
      closedAt: Number(r.closedAt) || null,
      result: allowed.includes(str(r.result)) ? str(r.result) : null,
      ctRef: str(r.ctRef) || null,
      taskRef: str(r.taskRef) || null,
      note: str(r.note),
      hist: normalizeHist(r.hist)
    };
  }
  function parseActionId(actionId) {
    const parts = str(actionId).split(':');
    if (parts.length < 4) return null;
    return { rule: parts[0], prog: parts[1], studentId: parts[2], openedDate: parts[3], sub: parts[4] || '' };
  }

  /* ── 학생 해석 ──
     이름 키 레거시(__opset__/__exam__)를 stable id로 옮길 때 한 번 쓴다.
     동명이인은 절대 자동으로 고르지 않는다 — 다른 학생의 기록이 섞이면 되돌릴 수 없다. */
  function normName(v) { return str(v).normalize('NFKC').replace(/\s+/g, ''); }
  function rosterStudents(roster) {
    if (Array.isArray(roster)) return roster;
    return roster && Array.isArray(roster.students) ? roster.students : [];
  }
  function brief(s) { return { id: str(s.id), name: str(s.name), grade: str(s.grade) }; }
  function resolveStudent(roster, nameOrId) {
    const q = str(nameOrId);
    if (!q) return null;
    const students = rosterStudents(roster).filter(s => s && s.id);
    const byId = students.find(s => str(s.id) === q);
    if (byId) return brief(byId);
    const hits = students.filter(s => normName(s.name) === normName(q));
    if (!hits.length) return null;
    if (hits.length === 1) return brief(hits[0]);
    return { ambiguous: true, name: q, candidates: hits.map(brief) };
  }

  function legacyPerfset(checks, roster, name) {
    const rec = (checks || {})[LEGACY_OPSET_PREFIX + str(name) + '|all'];
    if (!rec || !Array.isArray(rec.progs)) return null;
    const progs = rec.progs.map(p => LEGACY_PROG[str(p)] || (PROGS.includes(str(p)) ? str(p) : '')).filter(Boolean);
    if (!progs.length) return null;
    return {
      name: str(name),
      resolved: resolveStudent(roster, name),
      perfset: normalizePerfset({ progs: progs, target: null, from: 'legacy' })
    };
  }
  function legacyPerfsets(checks, roster) {
    const out = [];
    Object.keys(checks || {}).forEach(k => {
      if (!k.startsWith(LEGACY_OPSET_PREFIX) || !k.endsWith('|all')) return;
      const name = k.slice(LEGACY_OPSET_PREFIX.length, k.length - 4);
      const row = legacyPerfset(checks, roster, name);
      if (row) out.push(row);
    });
    return out;
  }

  /* ── ctx ──
     { checks, perfsetOf(studentId), today, students:[{id,name}], absentOn(studentId, ymd)?,
       onboardingAccountDate(studentId)?, mondayOf(ymd)?, now? }
     perfsetOf·absentOn이 없으면 checks에서 직접 읽는다(테스트·간단한 호출용). */
  function perfsetOf(ctx, studentId) {
    const raw = ctx && typeof ctx.perfsetOf === 'function'
      ? ctx.perfsetOf(studentId)
      : ((ctx && ctx.checks) || {})[perfsetKey(studentId)];
    return raw ? normalizePerfset(raw) : null;
  }
  function absentOn(ctx, studentId, ymd) {
    if (ctx && typeof ctx.absentOn === 'function') return !!ctx.absentOn(studentId, ymd);
    const row = ((ctx && ctx.checks) || {})[ATT_PREFIX + str(studentId) + '|' + str(ymd)];
    return !!(row && row.att === 'A');
  }
  function perfdayOf(checks, prog, ymd) {
    const row = (checks || {})[perfdayKey(prog, ymd)];
    return row ? normalizePerfday(row) : null;
  }

  /* 일일 상태 6값. 우선순위: 비대상 → 결석 → 스탬프 없음(unknown) → 예외 → completed.
     "스탬프 있음 + 예외 없음 = completed"가 이 안의 핵심 약속이라, 스탬프 없이 예외만 있는 행은
     완료로 읽지 않는다(안 봤는데 완료로 남는 것이 가장 나쁜 오류다). */
  function dayState(ctx, studentId, prog, ymd) {
    const ps = perfsetOf(ctx, studentId);
    if (!ps || !ps.progs.includes(prog)) return 'not_due';
    if (!dueDaysOf(ps, prog).includes(dowOf(ymd))) return 'not_due';
    if (absentOn(ctx, studentId, ymd)) return 'absent';
    const row = perfdayOf(ctx.checks, prog, ymd);
    if (!row || !row.stamp) return 'unknown';
    const ex = row.ex[str(studentId)];
    return ex ? ex.st : 'completed';
  }
  /* 명시 unknown: 직원이 보고도 "못 찾음"으로 찍은 셀. 스탬프 자체가 없는 날과 구분한다(S3·KPI). */
  function explicitUnknown(ctx, studentId, prog, ymd) {
    const row = perfdayOf(ctx.checks, prog, ymd);
    const ex = row && row.stamp ? row.ex[str(studentId)] : null;
    return !!(ex && ex.st === 'unknown');
  }

  /* 주간 요약. ratio는 min(daysDone, target)/target 인데, unknown(스탬프 없음·명시 unknown)과
     아직 오지 않은 대상일은 분모(target)에서 뺀다 — 직원이 안 본 날 때문에 학생 수행률이
     깎이면 지표가 직원 입력량을 재게 된다. rawRatio는 뺀 것 없는 원식(주말 마감용). */
  function weekSummary(ctx, studentId, monday, opts) {
    const pw = Number(opts && opts.partialWeight) || 0;
    const todayYmd = validYmd(ctx && ctx.today) ? ctx.today : '';
    const ps = perfsetOf(ctx, studentId);
    const days = [];
    for (let i = 0; i < 7; i++) days.push(addDays(monday, i));
    const progs = {};
    const total = { daysDone: 0, target: 0, unknown: 0, partial: 0, completed: 0, notDone: 0, absent: 0, pending: 0, due: 0 };
    const ratios = [], raws = [];
    (ps ? ps.progs : []).forEach(prog => {
      const c = { completed: 0, partial: 0, notDone: 0, unknown: 0, absent: 0, pending: 0, due: 0, states: [] };
      days.forEach(d => {
        const st = dayState(ctx, studentId, prog, d);
        c.states.push(st);
        if (st === 'not_due') return;
        if (st === 'absent') { c.absent++; return; }
        c.due++;
        if (todayYmd && d > todayYmd) { c.pending++; return; }
        if (st === 'completed') c.completed++;
        else if (st === 'partial') c.partial++;
        else if (st === 'not_completed') c.notDone++;
        else c.unknown++;
      });
      const target = targetOf(ps, prog);
      const daysDone = c.completed + pw * c.partial;
      const eff = Math.max(0, target - c.unknown - c.pending);
      const ratio = eff ? Math.min(daysDone, eff) / eff : null;
      const rawRatio = Math.min(daysDone, target) / target;
      progs[prog] = Object.assign(c, { target: target, daysDone: daysDone, ratio: ratio, rawRatio: rawRatio });
      Object.keys(total).forEach(k => { if (k in c) total[k] += c[k]; });
      total.target += target;
      total.daysDone += daysDone;
      if (ratio != null) ratios.push(ratio);
      raws.push(rawRatio);
    });
    return Object.assign(total, {
      days: days,
      progs: progs,
      ratio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null,
      rawRatio: raws.length ? raws.reduce((a, b) => a + b, 0) / raws.length : null
    });
  }

  /* 대상일 기준 연속 미수행. ymd에서 거꾸로 걸으며 not_completed만 센다.
     unknown·not_due·absent는 "끊지 않고 건너뛴다" — 직원이 하루 못 본 것(unknown)이나
     주말·결석이 7일 연속을 3+3으로 쪼개면 P0가 영영 안 뜬다. completed·partial이 나오면 끝. */
  function streakInfo(ctx, studentId, prog, ymd) {
    let n = 0, from = '', to = '', d = str(ymd);
    for (let i = 0; i < LOOKBACK_DAYS && validYmd(d); i++) {
      const st = dayState(ctx, studentId, prog, d);
      if (st === 'not_completed') { n++; if (!to) to = d; from = d; }
      else if (st === 'completed' || st === 'partial') break;
      d = addDays(d, -1);
    }
    return { n: n, from: from, to: to };
  }
  function dueStreak(ctx, studentId, prog, ymd) { return streakInfo(ctx, studentId, prog, ymd).n; }

  /* ymd 이하의 최근 대상일 count개(비대상·결석 제외), 최신 순. */
  function recentDueDays(ctx, studentId, prog, ymd, count) {
    const out = [];
    let d = str(ymd);
    for (let i = 0; i < LOOKBACK_DAYS && out.length < count && validYmd(d); i++) {
      const st = dayState(ctx, studentId, prog, d);
      if (st !== 'not_due' && st !== 'absent') out.push(d);
      d = addDays(d, -1);
    }
    return out;
  }
  /* since 다음 날부터 ymd까지의 대상일 count개, 오래된 순. 결석은 대상일로 세지 않는다. */
  function dueDaysAfter(ctx, studentId, prog, since, ymd, count) {
    const out = [];
    let d = addDays(since, 1);
    for (let i = 0; i < LOOKBACK_DAYS && out.length < count && validYmd(d) && d <= ymd; i++) {
      const st = dayState(ctx, studentId, prog, d);
      if (st !== 'not_due' && st !== 'absent') out.push(d);
      d = addDays(d, 1);
    }
    return out;
  }

  function ctxStudents(ctx) {
    return ((ctx && ctx.students) || []).map(s => (s && typeof s === 'object') ? str(s.id) : str(s)).filter(Boolean);
  }

  /* 신호 판정. ymd = 20:30 저장한 날(=오늘). 학생×프로그램마다 규칙을 돌리고 우선순위순으로 준다.
     P2는 색만이고 조치를 만들지 않는다(planActions가 거른다). */
  function signals(ctx, ymd) {
    const out = [];
    if (!validYmd(ymd)) return out;
    const monday = weekOf(ctx, ymd);
    ctxStudents(ctx).forEach(studentId => {
      const ps = perfsetOf(ctx, studentId);
      if (!ps || !ps.progs.length) return;
      ps.progs.forEach(prog => {
        const push = (rule, priority, evidence) =>
          out.push({ rule: rule, priority: priority, studentId: studentId, prog: prog, evidence: Object.assign({ prog: prog }, evidence) });

        /* S1 연속 미수행 */
        const sk = streakInfo(ctx, studentId, prog, ymd);
        if (sk.n >= STREAK_P0) push('S1', 'P0', { dueStreak: sk.n, from: sk.from, to: sk.to });
        else if (sk.n >= STREAK_P1) push('S1', 'P1', { dueStreak: sk.n, from: sk.from, to: sk.to });
        else if (sk.n >= 1) push('S1', 'P2', { dueStreak: sk.n, from: sk.from, to: sk.to });

        /* S2 신규 미시작: 계정 항목 완료 후 대상일 5일이 지났는데 completed·partial 0.
           전부 unknown(안 본 것)이면 근거가 없으니 내지 않는다. 창 종료 후 1주가 지나면 S1에 맡긴다. */
        const acct = ctx && typeof ctx.onboardingAccountDate === 'function' ? str(ctx.onboardingAccountDate(studentId)) : '';
        if (validYmd(acct)) {
          const win = dueDaysAfter(ctx, studentId, prog, acct, ymd, S2_DUE_WINDOW);
          if (win.length >= S2_DUE_WINDOW && diffDays(ymd, win[win.length - 1]) <= S2_GRACE_DAYS) {
            const states = win.map(d => dayState(ctx, studentId, prog, d));
            const started = states.some(s => s === 'completed' || s === 'partial');
            const seen = states.filter(s => s === 'not_completed').length;
            if (!started && seen >= 1) push('S2', 'P0', { dueStreak: seen, from: win[0], to: win[win.length - 1] });
          }
        }

        /* S3 명시 unknown 대상일 2연속 — 스탬프 없는 날은 세지 않는다(그건 원장 카드 "스탬프 없음"이 잡는다) */
        const recent = recentDueDays(ctx, studentId, prog, ymd, S3_UNKNOWN_RUN);
        if (recent.length === S3_UNKNOWN_RUN && recent.every(d => explicitUnknown(ctx, studentId, prog, d))) {
          push('S3', 'P2', { dueStreak: S3_UNKNOWN_RUN, from: recent[recent.length - 1], to: recent[0] });
        }

        /* S4 과제 미배정 — 오늘 예외의 why */
        const row = perfdayOf(ctx.checks, prog, ymd);
        const ex = row && row.stamp ? row.ex[studentId] : null;
        if (ex && ex.why === 'no_assignment') push('S4', 'P1', { dueStreak: sk.n, from: ymd, to: ymd, why: 'no_assignment' });

        /* S6 이번 주 not_completed 2일 이상 → 강사 전달. 주 경계는 주입된 mondayOf(KST). */
        let notDone = 0;
        for (let d = monday; validYmd(d) && d <= ymd; d = addDays(d, 1)) {
          if (dayState(ctx, studentId, prog, d) === 'not_completed') notDone++;
        }
        if (notDone >= S6_MIN_NOT_DONE) push('S6', 'P1', { dueStreak: sk.n, from: monday, to: ymd, count: notDone });
      });
    });
    return out.sort(compareSignal);
  }
  function compareSignal(a, b) {
    return priorityRank(a.priority) - priorityRank(b.priority) ||
      a.rule.localeCompare(b.rule) || a.prog.localeCompare(b.prog) || a.studentId.localeCompare(b.studentId);
  }

  /* 규칙 → 조치 유형. S2는 배정과 연락 둘 다 낸다(계정만 있고 과제가 없는 경우가 대부분이라). */
  function actionTypesFor(sig) {
    if (sig.priority === 'P2') return [];
    if (sig.rule === 'S1') return ['contact'];
    if (sig.rule === 'S2') return ['assign', 'contact'];
    if (sig.rule === 'S4') return ['assign'];
    if (sig.rule === 'S6') return ['teacher_note'];
    return [];
  }
  /* actionId = '<rule>:<prog>:<studentId>:<openedDate>' — 두 기기가 같은 저녁에 저장해도 같은 행이 된다.
     한 규칙이 두 유형을 내는 S2의 두 번째 유형(contact)만 ':contact'를 덧붙인다 —
     한 행에 두 조치를 넣으면 종결을 따로 할 수 없다. */
  function actionIdOf(sig, type, ymd) {
    const base = sig.rule + ':' + sig.prog + ':' + sig.studentId + ':' + ymd;
    const primary = actionTypesFor(sig)[0];
    return type === primary ? base : base + ':' + type;
  }

  /* 학생 이름 없는 상수 문구. 이름은 UI가 카드에 따로 붙인다 — 문구가 저장돼도 개인정보가 아니다. */
  function scriptFor(type, evidence) {
    const ev = evidence && typeof evidence === 'object' ? evidence : {};
    const label = PROG_LABEL[ev.prog] || '온라인 프로그램';
    const n = Number(ev.dueStreak) || 0;
    switch (str(type)) {
      case 'contact':
        return label + ' 대상일 ' + n + '일 연속 미수행 — 보호자에게 안내하고 이번 주 학습 계획을 확인합니다' +
          (n >= STREAK_P0 ? ' (전화)' : ' (문자)');
      case 'assign':
        return label + ' 관리자 화면에서 이번 주 과제를 배정하고 학생 계정에서 보이는지 확인합니다';
      case 'teacher_note':
        return label + ' 이번 주 미수행 ' + (Number(ev.count) || n) + '일 — 수업 중 확인하고 필요하면 과제 조정을 요청합니다';
      case 'nelt_notice':
        return '넬트 정기 평가 응시 안내 — 마지막 응시 후 90일 경과';
      case 'audit':
        return '관리자 화면과 앱 기록 5셀 무작위 대조';
      default:
        return '';
    }
  }

  /* 신호 → 새 __act__ 행. 이미 열린 같은(규칙·프로그램·학생·유형) 조치가 같거나 높은 등급이면
     또 만들지 않는다. 같은 actionId가 있으면 건너뛴다(병합은 저장 쪽 mergeAction). 상한을 넘는
     분량은 P순으로 자른다 — 카드가 학생 수만큼 쏟아지면 아무도 안 본다. */
  function planActions(sigs, openActions, opts) {
    const o = opts || {};
    const ymd = validYmd(o.ymd) ? o.ymd : '';
    if (!ymd) return [];
    const staffId = str(o.staffId) || 'admin';
    const cap = Number(o.cap) > 0 ? Number(o.cap) : DEFAULT_CAP;
    const at = Number(o.now) || Date.now();
    const weekStart = validYmd(o.weekStart) ? o.weekStart : '';
    const existing = (openActions || []).map(normalizeAction);
    const batch = {};
    const cands = [];

    (sigs || []).slice().sort(compareSignal).forEach(sig => {
      actionTypesFor(sig).forEach(type => {
        const actionId = actionIdOf(sig, type, ymd);
        if (existing.some(a => a.actionId === actionId)) return;
        const same = a => a.rule === sig.rule && a.type === type && a.studentId === sig.studentId && a.evidence.prog === sig.prog;
        if (existing.some(a => same(a) && a.st === 'open' && priorityRank(a.priority) <= priorityRank(sig.priority))) return;
        /* 주 1장 규칙(S6): 이번 주에 이미 냈으면(종결됐어도) 다시 내지 않는다 */
        if (sig.rule === 'S6' && weekStart && existing.some(a => same(a) && a.openedDate >= weekStart)) return;
        const bk = type + '|' + sig.prog + '|' + sig.studentId;
        if (batch[bk]) return;
        batch[bk] = true;
        cands.push({
          actionId: actionId,
          staffId: staffId,
          studentId: sig.studentId,
          type: type,
          rule: sig.rule,
          priority: sig.priority,
          evidence: Object.assign({}, sig.evidence),
          st: 'open',
          openedAt: at,
          openedDate: ymd,
          closedAt: null,
          result: null,
          ctRef: null,
          taskRef: null,
          note: scriptFor(type, sig.evidence),
          hist: [{ st: 'open', at: at, by: staffId, result: '' }]
        });
      });
    });
    return cands.slice(0, cap).map(normalizeAction);
  }

  /* 같은 actionId 두 벌 병합. openedAt은 최솟값(처음 열린 시각이 대응 소요의 기준), hist는 합집합.
     상태·종결은 더 늦은 이력을 가진 쪽을 따른다. */
  function lastAt(a) { return a.hist.length ? a.hist[a.hist.length - 1].at : 0; }
  function mergeAction(a, b) {
    if (!a) return b ? normalizeAction(b) : null;
    if (!b) return normalizeAction(a);
    const A = normalizeAction(a), B = normalizeAction(b);
    const newer = lastAt(B) >= lastAt(A) ? B : A, older = newer === A ? B : A;
    const opened = [A.openedAt, B.openedAt].filter(t => t > 0);
    return normalizeAction(Object.assign({}, older, newer, {
      openedAt: opened.length ? Math.min.apply(null, opened) : 0,
      openedDate: A.openedDate && B.openedDate ? (A.openedDate < B.openedDate ? A.openedDate : B.openedDate) : (A.openedDate || B.openedDate),
      priority: priorityRank(A.priority) <= priorityRank(B.priority) ? A.priority : B.priority,
      ctRef: newer.ctRef || older.ctRef,
      taskRef: newer.taskRef || older.taskRef,
      hist: normalizeHist(A.hist.concat(B.hist))
    }));
  }

  /* 상태 전이. contact의 no_answer는 "열어둔 채 이월"(C.3) — 결과만 적고 open을 유지한다.
     done·skipped만 closedAt을 찍는다. blocked는 원장이 볼 때까지 열려 있는 상태다. */
  function transitionAction(action, next, opts) {
    const a = normalizeAction(action);
    const o = opts || {};
    const at = Number(o.at) || Date.now();
    const by = str(o.by);
    const allowed = RESULTS[a.type] || [];
    const result = allowed.includes(str(o.result)) ? str(o.result) : null;
    let st = ACTION_STATES.includes(str(next)) ? str(next) : a.st;
    if (a.type === 'contact' && result === 'no_answer') st = 'open';
    const closed = st === 'done' || st === 'skipped';
    return normalizeAction(Object.assign({}, a, {
      st: st,
      result: result || (closed ? a.result : a.result),
      closedAt: closed ? at : null,
      ctRef: str(o.ctRef) || a.ctRef,
      taskRef: str(o.taskRef) || a.taskRef,
      hist: a.hist.concat([{ st: st, at: at, by: by, result: result || '' }])
    }));
  }

  function inRange(ymd, from, to) {
    if (!validYmd(ymd)) return !from && !to;
    if (from && ymd < from) return false;
    if (to && ymd > to) return false;
    return true;
  }

  /* 원장 카드·개인 KPI 최소판. 직원이 통제하는 숫자만 낸다(대응 소요·미확인 비율).
     수행률은 학생·강사·보호자 행동의 결과라 여기 없다. */
  function kpi(actions, ctx, range) {
    const r = range || {};
    const from = validYmd(r.from) ? r.from : '', to = validYmd(r.to) ? r.to : '';
    const now = Number(ctx && ctx.now) || Number(r.now) || Date.now();
    const list = (actions || []).map(normalizeAction).filter(a => inRange(a.openedDate, from, to));
    const count = st => list.filter(a => a.st === st).length;
    const closeMs = p => median(list.filter(a => a.st === 'done' && a.priority === p && a.closedAt && a.openedAt)
      .map(a => a.closedAt - a.openedAt));
    const byStaff = {};
    list.forEach(a => {
      const s = a.staffId || 'admin';
      byStaff[s] = byStaff[s] || { open: 0, done: 0, blocked: 0, skipped: 0 };
      byStaff[s][a.st]++;
    });

    let dueCells = 0, unknownCells = 0;
    const todayYmd = validYmd(ctx && ctx.today) ? ctx.today : '';
    if (from && to) {
      const last = todayYmd && todayYmd < to ? todayYmd : to;
      ctxStudents(ctx).forEach(id => {
        const ps = perfsetOf(ctx, id);
        if (!ps) return;
        ps.progs.forEach(prog => {
          for (let d = from; validYmd(d) && d <= last; d = addDays(d, 1)) {
            const st = dayState(ctx, id, prog, d);
            if (st === 'not_due' || st === 'absent') continue;
            dueCells++;
            if (st === 'unknown') unknownCells++;
          }
        });
      });
    }
    return {
      open: count('open'),
      done: count('done'),
      blocked: count('blocked'),
      skipped: count('skipped'),
      p0Over24h: list.filter(a => a.st === 'open' && a.priority === 'P0' && a.openedAt && now - a.openedAt > DAY_MS),
      medianCloseMs: { P0: closeMs('P0'), P1: closeMs('P1') },
      unknownRatio: dueCells ? unknownCells / dueCells : null,
      unknownCells: unknownCells,
      dueCells: dueCells,
      byStaff: byStaff
    };
  }

  /* 레거시 __exam__<이름>|<날짜> 읽기 해석 — index.html의 examTrend/examRisk와 같은 규칙.
     단계(lv)만 본다. 이관하지 않고 이름 키를 resolveStudent로 한 번 해석해 붙인다. */
  const EXAM_KINDS = { nelt: '넬트', metamath: '메타수학' };
  function examTrendOf(checks, name, todayYmd) {
    const pre = LEGACY_EXAM_PREFIX + str(name) + '|';
    const all = [];
    Object.keys(checks || {}).forEach(k => {
      if (!k.startsWith(pre)) return;
      const date = k.slice(pre.length);
      if (!validYmd(date)) return;
      const items = (checks[k] && Array.isArray(checks[k].items)) ? checks[k].items : [];
      items.forEach(x => all.push({ kind: str(x && x.kind), lv: Number(x && x.lv) || 0, label: str(x && x.label), date: date }));
    });
    all.sort((a, b) => b.date.localeCompare(a.date));
    const out = {};
    Object.keys(EXAM_KINDS).forEach(key => {
      const l = all.filter(x => x.kind === EXAM_KINDS[key]);
      const last = l[0] || null;
      let trend = null, risk = null;
      if (l.length >= 2) {
        const d = l[0].lv - l[1].lv;
        trend = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
      }
      /* 3회차 이상 쌓였을 때만 판정 — 초반 두 회차로 단정하지 않는다 */
      if (l.length >= 3) {
        if (l[0].lv < l[1].lv) risk = 'down';
        else if (l[0].lv === l[1].lv && l[1].lv === l[2].lv) risk = 'stall';
      }
      out[key] = {
        count: l.length,
        last: last ? last.date : null,
        lv: last ? last.lv : null,
        label: last ? last.label : '',
        trend: trend,
        risk: risk,
        daysSince: last && validYmd(todayYmd) ? diffDays(todayYmd, last.date) : null
      };
    });
    return out;
  }

  return {
    PERFSET_PREFIX: PERFSET_PREFIX,
    PERFDAY_PREFIX: PERFDAY_PREFIX,
    ACT_PREFIX: ACT_PREFIX,
    ONBOARDING_PREFIX: ONBOARDING_PREFIX,
    ONBOARDING_ACCOUNT_ITEM: ONBOARDING_ACCOUNT_ITEM,
    PROGS: PROGS,
    PROG_LABEL: PROG_LABEL,
    LEGACY_PROG: LEGACY_PROG,
    DEFAULT_TARGET: DEFAULT_TARGET,
    DEFAULT_DUE_DAYS: DEFAULT_DUE_DAYS,
    DAY_STATES: DAY_STATES,
    EX_STATES: EX_STATES,
    BASIS: BASIS,
    WHYS: WHYS,
    ACTION_TYPES: ACTION_TYPES,
    ACTION_STATES: ACTION_STATES,
    PRIORITIES: PRIORITIES,
    RESULTS: RESULTS,
    RULES: RULES,
    STREAK_P0: STREAK_P0,
    STREAK_P1: STREAK_P1,
    DEFAULT_CAP: DEFAULT_CAP,
    LOOKBACK_DAYS: LOOKBACK_DAYS,
    keys: {
      perfsetKey: perfsetKey,
      perfsetTaskId: perfsetTaskId,
      perfdayKey: perfdayKey,
      perfdayTaskId: perfdayTaskId,
      actKey: actKey,
      actTaskId: actTaskId
    },
    perfsetKey: perfsetKey,
    perfsetTaskId: perfsetTaskId,
    perfdayKey: perfdayKey,
    perfdayTaskId: perfdayTaskId,
    actKey: actKey,
    actTaskId: actTaskId,
    isPerfKey: isPerfKey,
    isActKey: isActKey,
    parseActKey: parseActKey,
    parsePerfdayKey: parsePerfdayKey,
    parseActionId: parseActionId,
    validYmd: validYmd,
    addDays: addDays,
    dowOf: dowOf,
    mondayOf: mondayOfDefault,
    diffDays: diffDays,
    median: median,
    normalizePerfset: normalizePerfset,
    normalizePerfday: normalizePerfday,
    normalizeAction: normalizeAction,
    hasStamp: hasStamp,
    dueDaysOf: dueDaysOf,
    targetOf: targetOf,
    resolveStudent: resolveStudent,
    legacyPerfset: legacyPerfset,
    legacyPerfsets: legacyPerfsets,
    dayState: dayState,
    explicitUnknown: explicitUnknown,
    weekSummary: weekSummary,
    streakInfo: streakInfo,
    dueStreak: dueStreak,
    signals: signals,
    actionTypesFor: actionTypesFor,
    planActions: planActions,
    mergeAction: mergeAction,
    transitionAction: transitionAction,
    scriptFor: scriptFor,
    kpi: kpi,
    examTrendOf: examTrendOf,
    priorityRank: priorityRank
  };
});
