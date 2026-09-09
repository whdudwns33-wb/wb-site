(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBPerfPanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /* 수행 탭(#perf) 화면 — 기획 제안 C Phase 0.
     index.html 뒤에 loadScriptOnce로 지연 로드된다. index.html은 단일 파일 앱이라 최상위
     const/let·함수(state, session, rosterDb, setCheck, modal, esc, today, mondayOf…)가 뒤에 오는
     classic script에 렉시컬 전역으로 보인다. Node(테스트)에서는 없으므로 전부 typeof로 확인한다.
     저장은 setCheck 하나로만 한다 — 동기화·소유자 판정이 그 경로에 있다.

     권한: 저장 버튼은 session.isAdmin(원장·관리 담당)에서만 그린다. 서버는 개인 링크(staff)의
     '__접두__<값>' 쓰기를 값 === 본인 staffId 일 때만 받으므로 '__perfday__studyforce' 같은 키는
     개인 링크에서 조용히 거부된다. 프로그램 담당 직원은 관리 담당 롤(allowlist vars)로 둔다는
     전제(C.7 선택지 A)이며, 그 직원의 조치는 __act__<본인 staffId> 로 남는다. */

  function C() {
    if (root && root.WBPerfCore) return root.WBPerfCore;
    /* Node 테스트 스모크용. 브라우저에는 require가 없다. */
    if (typeof require === 'function') { try { return require('./perf-core.js'); } catch (e) { return null; } }
    return null;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function localYmd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function hm(ms) { const d = new Date(Number(ms) || 0); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function escLocal(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ── index.html 전역 접근(존재 확인 후) ── */
  const G = {
    state: () => (typeof state !== 'undefined' && state ? state : null),
    session: () => (typeof session !== 'undefined' && session ? session : null),
    roster: () => (typeof rosterDb !== 'undefined' ? rosterDb : null),
    rosterErr: () => (typeof rosterErr !== 'undefined' ? String(rosterErr || '') : ''),
    rosterLoading: () => (typeof rosterLoading !== 'undefined' && !!rosterLoading),
    today: () => (typeof today === 'function' ? today() : localYmd(new Date())),
    now: () => (typeof now === 'function' ? now() : Date.now()),
    mondayOf: () => (typeof mondayOf === 'function' ? mondayOf : null),
    esc: s => (typeof esc === 'function' ? esc(s) : escLocal(s)),
    links: () => (root && root.WBExternalLinks ? root.WBExternalLinks : null),
    staffName: id => {
      const s = typeof staffById === 'function' ? staffById(id) : null;
      return s && s.name ? s.name : (id === 'admin' ? '원장' : String(id || ''));
    }
  };
  function checks() { const st = G.state(); return st && st.checks ? st.checks : {}; }
  function isAdmin() { const s = G.session(); return !!(s && s.isAdmin); }
  /* 조치의 담당자. 관리 담당 링크면 본인 staffId, 원장 화면(개인 링크 아님)이면 'admin'. */
  function actorId() { const s = G.session(); return (s && s.staffId) || 'admin'; }
  function write(taskId, scope, patch) { return typeof setCheck === 'function' ? setCheck(taskId, scope, patch) : null; }
  function rerender() { if (typeof render === 'function') render(); }
  function say(msg) { if (typeof toast === 'function') toast(msg); }
  function shiftDate(ymd, n) { const core = C(); return core ? core.addDays(ymd, n) : ymd; }
  function mondayOfYmd(ymd) { const fn = G.mondayOf(); const core = C(); return fn ? fn(ymd) : (core ? core.mondayOf(ymd) : ymd); }

  /* ── 화면 상태 ── */
  let tab = 'board';           // board | input | setup
  let inputDate = '';          // 입력 모드 날짜(기본 오늘)
  let basisPick = {};          // prog → 스탬프 전 고른 basis
  let queueFilter = 'open';    // open | all
  let setupDraft = null;       // { byId: {studentId: [progs]}, origin: {studentId: 'legacy'|'bulk'|''}, picks: {name: studentId}, legacy: [...] }
  let absentIndex = null;      // 렌더 1회 동안만 유효한 date → Set(studentId)

  /* ── 학생 ── */
  function transition(student) {
    return /^(휴원|퇴원)\s+\d{4}-\d{2}-\d{2}(?:\s|$)/.test(String(student && student.reason || ''));
  }
  /* 재원생 = roster에서 이번 달 재원 중이고 휴원·퇴원 예정이 아닌 학생. index.html activeIn과 같은 규칙. */
  function activeStudents() {
    const r = G.roster();
    const month = G.today().slice(0, 7);
    return ((r && Array.isArray(r.students)) ? r.students : [])
      .filter(s => s && s.id && s.name && !transition(s) && (!s.start || s.start <= month) && (!s.end || s.end > month))
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko') || String(a.id).localeCompare(String(b.id)));
  }
  function studentName(id) {
    const r = G.roster();
    const s = r && Array.isArray(r.students) ? r.students.find(x => String(x.id) === String(id)) : null;
    return s ? String(s.name) : String(id);
  }

  /* 결석 출처 두 가지: (1) __st__<id>|<날짜>.att (기획 표기) (2) task 앱의 실제 출결 — 수업 task 체크의 att.
     둘 다 'A'만 결석이다. 렌더 한 번에 checks를 한 번만 훑는다. */
  function buildAbsentIndex() {
    const map = {};
    const st = G.state();
    const ch = checks();
    const tasks = st && Array.isArray(st.tasks) ? st.tasks : [];
    const taskById = {};
    tasks.forEach(t => { if (t && t.id) taskById[t.id] = t; });
    Object.keys(ch).forEach(k => {
      const row = ch[k];
      if (!row || row.att !== 'A') return;
      let sid = '', date = String(row.date || k.split('|')[1] || '');
      if (k.startsWith('__st__')) sid = k.slice(6).split('|')[0];
      else { const t = taskById[row.taskId]; sid = t && t.studentId ? String(t.studentId) : ''; }
      if (!sid || !date) return;
      (map[date] = map[date] || {})[sid] = true;
    });
    return map;
  }
  function absentOn(id, ymd) {
    if (!absentIndex) absentIndex = buildAbsentIndex();
    return !!(absentIndex[ymd] && absentIndex[ymd][id]);
  }
  /* 신규생 계정 항목 완료일. 항목 값이 시각(ms)이면 그 날, 단순 true면 첫 등원일로 본다. */
  function onboardingRecord(core, id) {
    const rec = checks()[core.ONBOARDING_PREFIX + encodeURIComponent(String(id)) + '|all'];
    return rec && !rec.deleted ? rec : null;
  }
  function onboardingAccountDate(core, id) {
    const rec = onboardingRecord(core, id);
    const v = rec && rec.items ? rec.items[core.ONBOARDING_ACCOUNT_ITEM] : null;
    if (!v) return null;
    if (Number(v) >= 1000000000000) return localYmd(new Date(Number(v)));
    return core.validYmd(rec.firstClassDate) ? rec.firstClassDate : null;
  }
  function isNewStudent(core, id) {
    const rec = onboardingRecord(core, id);
    if (!rec || !core.validYmd(rec.firstClassDate)) return false;
    const d = core.diffDays(G.today(), rec.firstClassDate);
    return d != null && d >= -7 && d <= 30;
  }

  function ctx(core) {
    const ch = checks();
    return {
      checks: ch,
      today: G.today(),
      now: G.now(),
      students: activeStudents().map(s => ({ id: String(s.id), name: String(s.name) })),
      perfsetOf: id => ch[core.perfsetKey(id)] || null,
      absentOn: absentOn,
      onboardingAccountDate: id => onboardingAccountDate(core, id),
      mondayOf: G.mondayOf() || undefined
    };
  }

  /* ── 조치 행 ── */
  function allActions(core) {
    const ch = checks();
    const out = [];
    Object.keys(ch).forEach(k => {
      const p = core.parseActKey(k);
      if (!p || !ch[k] || ch[k].deleted) return;
      out.push(Object.assign(core.normalizeAction(Object.assign({}, ch[k], { staffId: p.staffId, actionId: p.actionId })), { key: k }));
    });
    return out;
  }
  /* 같은 actionId가 이미 있으면(다른 기기가 같은 저녁에 저장) 병합해 openedAt 최솟값을 지킨다 */
  function saveAction(core, row) {
    const key = core.actKey(row.staffId, row.actionId);
    const cur = checks()[key];
    const next = cur ? core.mergeAction(cur, row) : core.normalizeAction(row);
    delete next.key;
    write(core.actTaskId(row.staffId), row.actionId, Object.assign(next, { studentId: next.studentId, done: next.st === 'done' }));
  }
  function planFor(core, date) {
    const cx = ctx(core);
    const sigs = core.signals(cx, date);
    const rows = core.planActions(sigs, allActions(core), {
      staffId: actorId(), ymd: date, cap: core.DEFAULT_CAP, now: G.now(), weekStart: mondayOfYmd(date)
    });
    rows.forEach(r => saveAction(core, r));
    return rows.length;
  }
  function alertCount() {
    const core = C();
    if (!core || !G.state()) return 0;
    return allActions(core).filter(a => a.st === 'open' && a.priority === 'P0').length;
  }

  /* ── 공통 조각 ── */
  const DOT = {
    completed: ['●', 'var(--green)', '완료'],
    partial: ['◐', 'var(--amber)', '부분'],
    not_completed: ['○', 'var(--coral)', '미수행'],
    unknown: ['?', 'var(--mid-gray)', '미확인'],
    not_due: ['·', 'var(--line)', '비대상'],
    absent: ['A', 'var(--deep-blue)', '결석']
  };
  const TYPE_LABEL = { contact: '연락', assign: '과제 배정', teacher_note: '강사 전달', nelt_notice: '넬트 안내', audit: '감사' };
  const ST_LABEL = { open: '열림', done: '완료', blocked: '막힘', skipped: '건너뜀' };
  const WHY_LABEL = { no_login: '미접속', no_assignment: '과제 없음', account_issue: '계정 문제', score_below_target: '목표 미달', review_pending: '오답 복습 필요', other: '기타' };
  const BASIS_LABEL = { login_log: '접속 기록', assignment_status: '과제 현황', report: '리포트' };
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];

  function dot(core, cx, id, prog, d, futureFrom) {
    const st = core.dayState(cx, id, prog, d);
    const m = DOT[st] || DOT.unknown;
    const dim = futureFrom && d > futureFrom;
    return '<span title="' + G.esc(d + ' ' + m[2]) + '" style="display:inline-block;width:14px;text-align:center;color:' + m[1] +
      (dim ? ';opacity:.35' : '') + '">' + m[0] + '</span>';
  }
  function weekDots(core, cx, id, prog, monday) {
    let h = '';
    for (let i = 0; i < 7; i++) h += dot(core, cx, id, prog, core.addDays(monday, i), cx.today);
    return h;
  }
  function priorityPill(p) {
    return '<span class="pill ' + (p === 'P0' ? 'bad' : p === 'P1' ? 'warn' : '') + '">' + G.esc(p) + '</span>';
  }
  function progLink(core, prog) {
    const L = G.links();
    const key = prog === 'studyforce' ? 'studyforce_admin' : prog === 'classcard' ? 'classcard_teacher' : prog;
    const l = L && typeof L.linkFor === 'function' ? L.linkFor(key) : null;
    if (!l || !/^https:\/\//.test(String(l.url || ''))) return '';
    return '<a class="btn btn-sm btn-ghost" href="' + G.esc(l.url) + '" target="_blank" rel="noopener noreferrer">' +
      G.esc(l.label || core.PROG_LABEL[prog] || key) + ' ↗</a>';
  }
  function linksRow(core) {
    const L = G.links();
    if (!L || typeof L.linkFor !== 'function') return '';
    const h = ['studyforce_admin', 'classcard_teacher', 'metamath_center', 'nelt_org'].map(key => {
      const l = L.linkFor(key);
      if (!l || !/^https:\/\//.test(String(l.url || ''))) return '';
      return '<a class="btn btn-sm btn-ghost" href="' + G.esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + G.esc(l.label || key) + ' ↗</a>';
    }).join('');
    return h ? '<div class="row mb8" style="flex-wrap:wrap;gap:6px">' + h + '</div>' : '';
  }
  function tabChips() {
    return '<div class="chips mb14">' + [['board', '신호판·조치'], ['input', '오늘 입력'], ['setup', '프로그램 설정']].map(t =>
      '<button type="button" class="chip ' + (tab === t[0] ? 'on' : '') + '" data-act="pf-tab" data-v="' + t[0] + '">' + t[1] + '</button>').join('') + '</div>';
  }
  function trendText(t) {
    if (!t || !t.count) return '<span class="muted">—</span>';
    const arrow = t.trend === 'up' ? '▲' : t.trend === 'down' ? '▼' : t.trend === 'flat' ? '―' : '·';
    const cls = t.risk === 'down' ? 'bad' : t.risk === 'stall' ? 'warn' : '';
    return '<span class="pill ' + cls + '">' + arrow + ' ' + G.esc(t.label || (t.lv + '단계')) + '</span>' +
      (t.daysSince != null ? ' <span class="muted small">D+' + t.daysSince + '</span>' : '');
  }

  /* ── ① 원장 카드 ── */
  function directorCard(core, cx, actions) {
    const todayYmd = cx.today, yesterday = core.addDays(todayYmd, -1);
    const k = core.kpi(actions, cx, {});
    const week = core.kpi([], cx, { from: mondayOfYmd(todayYmd), to: todayYmd });
    const yP0 = actions.filter(a => a.st === 'open' && a.priority === 'P0' && a.openedDate && a.openedDate <= yesterday);
    const staffRows = Object.keys(k.byStaff).sort().map(sid => {
      const c = k.byStaff[sid];
      return '<div class="between small" style="padding:3px 0"><span>' + G.esc(G.staffName(sid)) + '</span>' +
        '<span class="row" style="gap:6px"><span class="pill ' + (c.open ? 'warn' : '') + '">열림 ' + c.open + '</span>' +
        '<span class="pill">완료 ' + c.done + '</span><span class="pill ' + (c.blocked ? 'bad' : '') + '">막힘 ' + c.blocked + '</span>' +
        '<span class="pill">건너뜀 ' + c.skipped + '</span></span></div>';
    }).join('') || '<div class="small muted">조치 기록이 아직 없습니다.</div>';
    const stampRows = core.PROGS.map(prog => {
      const row = core.normalizePerfday(cx.checks[core.perfdayKey(prog, todayYmd)]);
      const unknownCells = cx.students.filter(s => core.explicitUnknown(cx, s.id, prog, todayYmd)).length;
      return '<div class="between small" style="padding:3px 0"><span>' + G.esc(core.PROG_LABEL[prog]) + '</span><span class="row" style="gap:6px">' +
        (row.stamp
          ? '<span class="pill">스탬프 ' + hm(row.stamp.at) + ' · ' + G.esc(BASIS_LABEL[row.stamp.basis] || row.stamp.basis) + (row.stamp.by ? ' · ' + G.esc(G.staffName(row.stamp.by)) : '') + '</span>'
          : '<span class="pill warn">오늘 스탬프 없음</span>') +
        (unknownCells ? '<span class="pill warn">? ' + unknownCells + '명</span>' : '') + '</span></div>';
    }).join('');
    return '<div class="card"><div class="between mb8"><div class="card-title">원장 카드 — 수행 관제</div>' +
      (yP0.length ? '<span class="pill bad">어제 P0 미종결 ' + yP0.length + '</span>' : '<span class="pill">어제 P0 미종결 0</span>') + '</div>' +
      '<div class="card-sub mb8">직원별 조치 건수 · 오늘 스탬프 · 명시 미확인 · 24h 초과 P0. 직원 평가 근거는 대응 소요·미확인 비율·감사 불일치뿐이다.</div>' +
      staffRows + '<hr class="sep">' + stampRows +
      '<div class="between small mt14"><span class="muted">이번 주 미확인 비율</span><span class="pill ' + (week.unknownRatio != null && week.unknownRatio > 0.2 ? 'warn' : '') + '">' +
        (week.unknownRatio == null ? '—' : Math.round(week.unknownRatio * 100) + '% (' + week.unknownCells + '/' + week.dueCells + ')') + '</span></div>' +
      (k.p0Over24h.length
        ? '<div class="small mt14" style="color:var(--coral)"><b>24h 초과 P0 ' + k.p0Over24h.length + '건</b> — ' +
          G.esc(k.p0Over24h.map(a => studentName(a.studentId) + '(' + G.staffName(a.staffId) + ')').join(', ')) + '</div>'
        : '') +
      '</div>';
  }

  /* ── ② 신호판 ── */
  function gridCard(core, cx, sigs) {
    const monday = mondayOfYmd(cx.today);
    const best = {};
    sigs.forEach(s => { if (!best[s.studentId] || core.priorityRank(s.priority) < core.priorityRank(best[s.studentId].priority)) best[s.studentId] = s; });
    const rows = cx.students.filter(s => { const ps = cx.perfsetOf(s.id); return ps && core.normalizePerfset(ps).progs.length; });
    const unset = cx.students.length - rows.length;
    const head = '<tr><th style="text-align:left;padding:4px 6px">학생</th>' +
      core.PROGS.map(p => '<th style="text-align:left;padding:4px 6px;white-space:nowrap">' + G.esc(core.PROG_LABEL[p]) + '</th>').join('') +
      '<th style="text-align:left;padding:4px 6px">넬트</th><th style="text-align:left;padding:4px 6px">메타수학</th><th style="text-align:left;padding:4px 6px">신호</th></tr>';
    const body = rows.map(s => {
      const ps = core.normalizePerfset(cx.perfsetOf(s.id));
      const ws = core.weekSummary(cx, s.id, monday);
      const ex = core.examTrendOf(cx.checks, s.name, cx.today);
      const b = best[s.id];
      return '<tr style="border-top:1px solid var(--line)"><td style="padding:4px 6px;white-space:nowrap"><b>' + G.esc(s.name) + '</b>' +
        (isNewStudent(core, s.id) ? ' <span class="tag add">신규</span>' : '') + '</td>' +
        core.PROGS.map(p => {
          if (!ps.progs.includes(p)) return '<td style="padding:4px 6px" class="muted">—</td>';
          const w = ws.progs[p];
          return '<td style="padding:4px 6px;white-space:nowrap">' + weekDots(core, cx, s.id, p, monday) +
            ' <span class="small muted">' + w.daysDone + '/' + w.target + (w.unknown ? ' ?' + w.unknown : '') + '</span></td>';
        }).join('') +
        '<td style="padding:4px 6px;white-space:nowrap">' + trendText(ex.nelt) + '</td>' +
        '<td style="padding:4px 6px;white-space:nowrap">' + trendText(ex.metamath) + '</td>' +
        '<td style="padding:4px 6px;white-space:nowrap">' + (b ? priorityPill(b.priority) + ' <span class="tag">' + G.esc(b.rule + ' · ' + core.PROG_LABEL[b.prog] +
          (b.evidence.dueStreak ? ' ' + b.evidence.dueStreak + '일' : '')) + '</span>' : '<span class="muted">—</span>') + '</td></tr>';
    }).join('');
    return '<div class="card"><div class="between mb8"><div class="card-title">신호판 — ' + G.esc(monday.slice(5).replace('-', '/')) + ' 주</div>' +
      '<span class="pill">재원생 ' + rows.length + '명</span></div>' +
      '<div class="card-sub mb8">● 완료 ◐ 부분 ○ 미수행 ? 미확인 · 비대상 A 결석 — 스터디포스·클래스카드는 일일, 넬트·메타수학은 단계 추세만.</div>' +
      (rows.length
        ? '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">' + head + body + '</table></div>'
        : '<div class="empty"><b>—</b>이용 프로그램이 설정된 학생이 없습니다.</div>') +
      (unset ? '<div class="hint mt14">프로그램 미설정 ' + unset + '명 — <button type="button" class="btn btn-sm btn-ghost" data-act="pf-tab" data-v="setup">프로그램 설정</button></div>' : '') +
      '</div>';
  }

  /* ── ④ 조치 큐 ── */
  function actionCard(core, a) {
    const ev = a.evidence;
    const admin = isAdmin();
    const basis = a.rule + ' · ' + (core.PROG_LABEL[ev.prog] || '') +
      (ev.dueStreak ? ' · 대상일 ' + ev.dueStreak + '일째' : '') + (ev.count ? ' · 이번 주 ' + ev.count + '일' : '') +
      (ev.why ? ' · ' + (WHY_LABEL[ev.why] || ev.why) : '');
    const btn = (label, st, result, cls) =>
      '<button type="button" class="btn btn-sm ' + (cls || 'btn-ghost') + '" data-act="pf-act" data-key="' + G.esc(a.key) + '" data-st="' + st + '"' +
        (result ? ' data-result="' + result + '"' : '') + '>' + label + '</button>';
    let buttons = '';
    if (admin && a.st === 'open') {
      buttons = a.type === 'contact'
        ? btn('연락됨 → 완료', 'done', 'reached', 'btn-primary') + btn('부재중', 'open', 'no_answer')
        : btn('완료', 'done', '', 'btn-primary');
      buttons += btn('막힘', 'blocked', '', 'btn-danger') + btn('건너뜀', 'skipped');
    } else if (admin && a.st === 'blocked') {
      buttons = btn('다시 열기', 'open') + btn('완료', 'done', a.type === 'contact' ? 'reached' : '', 'btn-primary');
    }
    /* 배정 조치는 관리자 화면 공식 링크를 카드에 같이 둔다 — 링크만 열 뿐 계정·화면은 저장하지 않는다 */
    const extra = a.type === 'assign' && a.st === 'open' ? progLink(core, ev.prog) : '';
    return '<div class="task"><div class="task-body"><div class="task-t">' + priorityPill(a.priority) + ' <span class="tag">' + G.esc(TYPE_LABEL[a.type] || a.type) + '</span> ' +
      '<b>' + G.esc(studentName(a.studentId)) + '</b>' + (a.st !== 'open' ? ' <span class="pill ' + (a.st === 'blocked' ? 'bad' : '') + '">' + ST_LABEL[a.st] + '</span>' : '') +
      (a.result ? ' <span class="pill warn">' + G.esc(a.result === 'no_answer' ? '부재중' : a.result === 'reached' ? '연락됨' : a.result) + '</span>' : '') + '</div>' +
      '<div class="meta">' + G.esc(basis) + '</div>' +
      (a.note ? '<div class="small" style="margin-top:6px">' + G.esc(a.note) + '</div>' : '') +
      '<div class="meta muted">열림 ' + G.esc(a.openedDate) + ' ' + hm(a.openedAt) + ' · ' + G.esc(G.staffName(a.staffId)) +
        (a.hist.length > 1 ? ' · 이력 ' + a.hist.length : '') + '</div>' +
      (buttons || extra ? '<div class="row mt14" style="flex-wrap:wrap;gap:6px">' + buttons + extra + '</div>' : '') +
      '</div></div>';
  }
  function queueCard(core, cx, actions) {
    const sorted = actions.slice().sort((a, b) => core.priorityRank(a.priority) - core.priorityRank(b.priority) || a.openedAt - b.openedAt);
    const open = sorted.filter(a => a.st === 'open' || a.st === 'blocked');
    const since = core.addDays(cx.today, -7);
    const closed = sorted.filter(a => (a.st === 'done' || a.st === 'skipped') && a.openedDate >= since);
    const list = queueFilter === 'all' ? open.concat(closed) : open;
    return '<div class="card"><div class="between mb8"><div class="card-title">조치 큐</div><span class="row" style="gap:6px">' +
      '<span class="pill ' + (open.length ? 'warn' : '') + '">열림 ' + open.length + '</span>' +
      (isAdmin() ? '<button type="button" class="btn btn-sm btn-ghost" data-act="pf-plan" data-date="' + G.esc(cx.today) + '">조치 다시 계산</button>' : '') + '</span></div>' +
      '<div class="chips mb8">' + [['open', '열림·막힘'], ['all', '최근 7일 종결 포함']].map(f =>
        '<button type="button" class="chip ' + (queueFilter === f[0] ? 'on' : '') + '" data-act="pf-queue-filter" data-v="' + f[0] + '">' + f[1] + '</button>').join('') + '</div>' +
      (list.length ? list.map(a => actionCard(core, a)).join('') : '<div class="empty"><b>✓</b>열린 조치가 없습니다.</div>') +
      '<div class="hint mt14">연락 완료의 /contact-log 연동은 Phase 1 — 지금은 결과(연락됨·부재중)만 남깁니다. 부재중은 열어둔 채 이월됩니다.</div></div>';
  }

  /* ── ③ 오늘 열 입력 모드 ── */
  function inputCards(core, cx, date) {
    const admin = isAdmin();
    const nav = '<div class="card"><div class="between"><button class="btn btn-sm btn-ghost" data-act="pf-date" data-n="-1">‹ 전날</button>' +
      '<div class="card-title">' + G.esc(date) + ' (' + DOW[core.dowOf(date)] + ')' + (date === cx.today ? ' · 오늘' : '') + '</div>' +
      '<button class="btn btn-sm btn-ghost" data-act="pf-date" data-n="1"' + (date >= cx.today ? ' disabled' : '') + '>다음날 ›</button></div>' +
      '<div class="card-sub mt14">관리자 화면을 이름순으로 훑고 <b>[확인 스탬프]</b> 1탭, 미수행·부분·못 찾은 학생만 ○/◐/? 로 표시합니다. 정상 수행 학생은 손대지 않습니다.</div>' +
      (!admin ? '<div class="hint mt14">원장·관리 담당만 기록할 수 있습니다(개인 링크는 서버가 이 키의 저장을 거부합니다).</div>' : '') + '</div>';
    const cards = core.PROGS.map(prog => {
      const row = core.normalizePerfday(cx.checks[core.perfdayKey(prog, date)]);
      const basis = basisPick[prog] || (row.stamp ? row.stamp.basis : core.BASIS[0]);
      const students = cx.students.filter(s => { const ps = cx.perfsetOf(s.id); return ps && core.normalizePerfset(ps).progs.includes(prog); });
      const dueToday = core.DEFAULT_DUE_DAYS.includes(core.dowOf(date));
      let h = '<div class="card"><div class="between mb8"><div class="card-title">' + G.esc(core.PROG_LABEL[prog]) + '</div>' + progLink(core, prog) + '</div>';
      h += row.stamp
        ? '<div class="between mb8"><span class="pill">확인 스탬프 ' + hm(row.stamp.at) + ' · ' + G.esc(BASIS_LABEL[row.stamp.basis] || row.stamp.basis) + (row.stamp.by ? ' · ' + G.esc(G.staffName(row.stamp.by)) : '') + '</span>' +
          (admin ? '<button type="button" class="btn btn-sm btn-ghost" data-act="pf-unstamp" data-prog="' + prog + '" data-date="' + G.esc(date) + '">스탬프 취소</button>' : '') + '</div>'
        : '<div class="between mb8"><span class="pill warn">스탬프 없음 — 전원 미확인(?)</span></div>';
      if (admin && !row.stamp) {
        h += '<div class="fl mb8">확인 기준</div><div class="chips mb8">' + core.BASIS.map(b =>
          '<button type="button" class="chip ' + (basis === b ? 'on' : '') + '" data-act="pf-basis" data-prog="' + prog + '" data-v="' + b + '">' + G.esc(BASIS_LABEL[b]) + '</button>').join('') + '</div>' +
          '<button type="button" class="btn btn-primary btn-block" data-act="pf-stamp" data-prog="' + prog + '" data-date="' + G.esc(date) + '" data-basis="' + basis + '">✓ 확인 스탬프 — 예외 없는 학생은 완료</button>';
      }
      if (!dueToday) h += '<div class="hint mt14">' + DOW[core.dowOf(date)] + '요일은 기본 대상일이 아닙니다 — 대상일이 아닌 학생은 신호에 세지 않습니다.</div>';
      h += '<hr class="sep"><div class="fl mb8">예외 학생 ' + (Object.keys(row.ex).length ? '(' + Object.keys(row.ex).length + '명)' : '') + '</div>';
      if (!students.length) h += '<div class="small muted">이 프로그램을 쓰는 재원생이 없습니다.</div>';
      students.forEach(s => {
        const ex = row.ex[s.id];
        const cur = ex ? ex.st : '';
        h += '<div class="between small" style="padding:4px 0;gap:6px"><span style="min-width:64px">' + G.esc(s.name) +
          (absentOn(s.id, date) ? ' <span class="tag">결석</span>' : '') + '</span><span class="row" style="gap:4px;flex-wrap:wrap;justify-content:flex-end">' +
          core.EX_STATES.map(stv => {
            const m = DOT[stv];
            return admin
              ? '<button type="button" class="chip ' + (cur === stv ? 'on' : '') + '" style="padding:4px 9px" data-act="pf-ex" data-prog="' + prog + '" data-date="' + G.esc(date) + '" data-sid="' + G.esc(s.id) + '" data-v="' + stv + '" title="' + m[2] + '">' + m[0] + '</button>'
              : (cur === stv ? '<span class="pill">' + m[0] + ' ' + m[2] + '</span>' : '');
          }).join('') +
          (ex ? '<select class="in" style="width:auto;padding:4px 6px" data-act="pf-why" data-prog="' + prog + '" data-date="' + G.esc(date) + '" data-sid="' + G.esc(s.id) + '"' + (admin ? '' : ' disabled') + '>' +
            '<option value=""' + (!ex.why ? ' selected' : '') + '>사유</option>' +
            core.WHYS.map(w => '<option value="' + w + '"' + (ex.why === w ? ' selected' : '') + '>' + G.esc(WHY_LABEL[w]) + '</option>').join('') + '</select>' : '') +
          '</span></div>';
      });
      return h + '</div>';
    }).join('');
    return nav + cards;
  }

  /* ── ⑤ 일괄 설정 ── */
  function ensureDraft(core, cx) {
    if (setupDraft) return setupDraft;
    const legacy = core.legacyPerfsets(cx.checks, G.roster());
    const byId = {}, origin = {};
    cx.students.forEach(s => {
      const cur = cx.perfsetOf(s.id);
      if (cur) { byId[s.id] = core.normalizePerfset(cur).progs.slice(); origin[s.id] = 'saved'; return; }
      const lg = legacy.find(x => x.resolved && !x.resolved.ambiguous && x.resolved.id === s.id);
      byId[s.id] = lg ? lg.perfset.progs.slice() : [];
      origin[s.id] = lg ? 'legacy' : '';
    });
    setupDraft = { byId: byId, origin: origin, picks: {}, legacy: legacy };
    return setupDraft;
  }
  function setupCard(core, cx) {
    const d = ensureDraft(core, cx);
    const admin = isAdmin();
    const ambiguous = d.legacy.filter(x => x.resolved && x.resolved.ambiguous);
    const autoFilled = Object.keys(d.origin).filter(id => d.origin[id] === 'legacy').length;
    const orphans = d.legacy.filter(x => !x.resolved).length;
    let h = '<div class="card"><div class="card-title">이용 프로그램 일괄 설정</div>' +
      '<div class="card-sub mb8">재원생마다 쓰는 프로그램을 표시합니다. 대상일은 월~금, 목표는 주 5일(학생별 조정은 Phase 1). ' +
      '예전 온라인 프로그램 카드(이름 키)에서 ' + autoFilled + '명을 자동으로 채웠습니다' + (orphans ? ' · 명단에 없는 이름 ' + orphans + '건은 건너뜁니다' : '') + '.</div>';
    if (ambiguous.length) {
      h += '<div class="guide mb8"><b>동명이인 — 수동 선택</b>' + ambiguous.map(x =>
        '<div class="small mt14" style="margin-top:6px"><b>' + G.esc(x.name) + '</b> (' + G.esc(x.perfset.progs.map(p => core.PROG_LABEL[p]).join('·')) + ') → ' +
        x.resolved.candidates.map(c => '<button type="button" class="chip ' + (d.picks[x.name] === c.id ? 'on' : '') + '" style="padding:4px 9px" data-act="pf-pick" data-name="' + G.esc(x.name) + '" data-sid="' + G.esc(c.id) + '">' +
          G.esc(c.name + (c.grade ? ' · ' + c.grade : '') + ' · ' + c.id) + '</button>').join(' ') + '</div>').join('') + '</div>';
    }
    h += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">' +
      '<tr><th style="text-align:left;padding:4px 6px">학생</th>' + core.PROGS.map(p => '<th style="padding:4px 6px">' + G.esc(core.PROG_LABEL[p]) + '</th>').join('') + '<th style="padding:4px 6px">출처</th></tr>' +
      cx.students.map(s => '<tr style="border-top:1px solid var(--line)"><td style="padding:4px 6px;white-space:nowrap">' + G.esc(s.name) + '</td>' +
        core.PROGS.map(p => '<td style="text-align:center;padding:4px 6px"><input type="checkbox" data-act="pf-set" data-sid="' + G.esc(s.id) + '" data-prog="' + p + '"' +
          ((d.byId[s.id] || []).includes(p) ? ' checked' : '') + (admin ? '' : ' disabled') + '></td>').join('') +
        '<td style="text-align:center;padding:4px 6px" class="muted small">' + (d.origin[s.id] === 'saved' ? '저장됨' : d.origin[s.id] === 'legacy' ? '자동' : '—') + '</td></tr>').join('') +
      '</table></div>';
    h += admin
      ? '<div class="row mt14" style="gap:6px"><button type="button" class="btn btn-primary btn-block" data-act="pf-setup-save">저장</button>' +
        '<button type="button" class="btn btn-ghost" data-act="pf-setup-reset">되돌리기</button></div>'
      : '<div class="hint mt14">원장·관리 담당만 저장할 수 있습니다.</div>';
    return h + '</div>';
  }
  function saveSetup(core, cx) {
    const d = ensureDraft(core, cx);
    let n = 0;
    cx.students.forEach(s => {
      const sel = (d.byId[s.id] || []).filter(p => core.PROGS.includes(p));
      const cur = cx.perfsetOf(s.id);
      const curProgs = cur ? core.normalizePerfset(cur).progs : [];
      if (!cur && !sel.length) return;
      if (cur && curProgs.length === sel.length && curProgs.every(p => sel.includes(p))) return;
      const dueDays = {};
      sel.forEach(p => { dueDays[p] = (cur && cur.dueDays && cur.dueDays[p]) || core.DEFAULT_DUE_DAYS.slice(); });
      write(core.perfsetTaskId(s.id), 'all', {
        studentId: s.id, progs: sel, dueDays: dueDays,
        target: cur && cur.target ? cur.target : null,
        from: d.origin[s.id] === 'legacy' ? 'legacy' : 'bulk',
        done: true
      });
      n++;
    });
    setupDraft = null;
    return n;
  }

  /* ── 수행 탭 전체 ── */
  function view() {
    const core = C();
    if (!core) return '<div class="card"><div class="card-title">수행</div><div class="card-sub">불러오는 중…</div></div>';
    if (!G.state()) return '<div class="card"><div class="card-title">수행</div><div class="card-sub">앱 상태를 불러오는 중…</div></div>';
    const r = G.roster();
    if (!r || !Array.isArray(r.students)) {
      if (!G.rosterLoading() && typeof loadRoster === 'function') loadRoster();
      return '<div class="card"><div class="card-title">수행</div><div class="card-sub">원생 명단을 불러오는 중…</div>' +
        (G.rosterErr() ? '<div class="hint mt14">' + G.esc(G.rosterErr()) + '</div>' : '') + '</div>';
    }
    absentIndex = null;
    const cx = ctx(core);
    const date = inputDate && core.validYmd(inputDate) && inputDate <= cx.today ? inputDate : cx.today;
    let h = '<div class="card"><div class="between mb8"><div class="card-title">수행 신호 관제</div><span class="pill ' + (alertCount() ? 'bad' : '') + '">P0 ' + alertCount() + '</span></div>' +
      '<div class="card-sub mb8">학생 쪽에 결과가 생겼는가만 본다 — 점수·정답률은 외부가 정본이고 앱에는 넣지 않는다.</div>' + linksRow(core) + tabChips() + '</div>';
    if (tab === 'input') return h + inputCards(core, cx, date);
    if (tab === 'setup') return h + setupCard(core, cx);
    const actions = allActions(core);
    const sigs = core.signals(cx, cx.today);
    return h + directorCard(core, cx, actions) + gridCard(core, cx, sigs) + queueCard(core, cx, actions);
  }

  /* 기존 opModal(이름) 훅. __perfset__이 있는 학생은 옛 주간 횟수 입력을 잠그고 weekSummary를 보여 준다.
     같은 값을 두 곳(주간 횟수·일일 스탬프)에 적게 하면 둘 다 못 믿게 된다. */
  function legacyOpModal(name) {
    const core = C();
    const r = G.roster();
    if (!core || !r || !G.state()) return false;
    const res = core.resolveStudent(r, name);
    if (!res || res.ambiguous) return false;
    const ps = checks()[core.perfsetKey(res.id)];
    if (!ps || !core.normalizePerfset(ps).progs.length) return false;
    if (typeof modal !== 'function') return true;
    absentIndex = null;
    const cx = ctx(core);
    const mon = mondayOfYmd(cx.today), last = core.addDays(mon, -7);
    const block = (monday, title) => {
      const ws = core.weekSummary(cx, res.id, monday);
      return '<div class="fl mb8">' + title + ' (' + G.esc(monday.slice(5).replace('-', '/')) + ' 주)</div>' +
        Object.keys(ws.progs).map(p => '<div class="between small mb8"><span>' + G.esc(core.PROG_LABEL[p]) + '</span><span class="row" style="gap:6px">' +
          weekDots(core, cx, res.id, p, monday) + '<span class="pill">' + ws.progs[p].daysDone + '/' + ws.progs[p].target + '</span>' +
          (ws.progs[p].unknown ? '<span class="pill warn">? ' + ws.progs[p].unknown + '</span>' : '') + '</span></div>').join('');
    };
    modal('📱 ' + name + ' 온라인 프로그램',
      block(mon, '이번 주') + '<hr class="sep">' + block(last, '지난주') +
      '<div class="hint">일일 기록은 수행 탭의 20:30 입력 모드에서 남깁니다. 주간 횟수 입력은 이 학생에게 더 이상 쓰지 않습니다.</div>',
      '<button class="btn btn-navy btn-block mt14" data-act="pf-open-tab">수행 탭 열기</button>');
    return true;
  }

  /* ── 이벤트 (pf- 접두 — index.html의 switch와 충돌하지 않는다) ── */
  function updateEx(core, prog, date, sid, mut) {
    const row = core.normalizePerfday(checks()[core.perfdayKey(prog, date)]);
    const ex = Object.assign({}, row.ex);
    const next = mut(ex[sid] ? Object.assign({}, ex[sid]) : null);
    if (next) ex[sid] = next; else delete ex[sid];
    write(core.perfdayTaskId(prog), date, { ex: ex, done: !!row.stamp });
    if (row.stamp) planFor(core, date);
  }
  function onClick(ev) {
    const t = ev.target;
    const el = t && typeof t.closest === 'function' ? t.closest('[data-act^="pf-"]') : null;
    if (!el) return;
    const core = C();
    if (!core) return;
    const d = el.dataset;
    switch (d.act) {
      case 'pf-tab': tab = d.v || 'board'; rerender(); break;
      case 'pf-queue-filter': queueFilter = d.v === 'all' ? 'all' : 'open'; rerender(); break;
      case 'pf-date': {
        const base = inputDate && core.validYmd(inputDate) ? inputDate : G.today();
        const next = shiftDate(base, Number(d.n) || 0);
        if (next <= G.today() && next >= shiftDate(G.today(), -30)) inputDate = next;
        rerender(); break;
      }
      case 'pf-open-tab': {
        if (typeof closeModal === 'function') closeModal();
        tab = 'board';
        if (typeof go === 'function') go('perf');
        break;
      }
      case 'pf-basis': basisPick[d.prog] = core.BASIS.includes(d.v) ? d.v : core.BASIS[0]; rerender(); break;
      case 'pf-stamp': {
        if (!isAdmin()) { say('원장·관리 담당만 기록할 수 있습니다'); break; }
        if (!core.PROGS.includes(d.prog) || !core.validYmd(d.date)) break;
        write(core.perfdayTaskId(d.prog), d.date, { stamp: { by: actorId(), at: G.now(), basis: core.BASIS.includes(d.basis) ? d.basis : core.BASIS[0] }, done: true });
        const n = planFor(core, d.date);
        rerender();
        say(core.PROG_LABEL[d.prog] + ' 확인 스탬프 — 조치 ' + n + '건 생성');
        break;
      }
      case 'pf-unstamp': {
        if (!isAdmin()) break;
        if (!core.PROGS.includes(d.prog) || !core.validYmd(d.date)) break;
        write(core.perfdayTaskId(d.prog), d.date, { stamp: null, done: false });
        rerender(); say('스탬프를 취소했습니다 — 이 날은 전원 미확인');
        break;
      }
      case 'pf-ex': {
        if (!isAdmin()) { say('원장·관리 담당만 기록할 수 있습니다'); break; }
        if (!core.PROGS.includes(d.prog) || !core.validYmd(d.date) || !d.sid || !core.EX_STATES.includes(d.v)) break;
        updateEx(core, d.prog, d.date, d.sid, cur => (cur && cur.st === d.v ? null : { st: d.v, why: cur ? cur.why : '' }));
        rerender();
        break;
      }
      case 'pf-plan': {
        if (!isAdmin()) break;
        const n = planFor(core, core.validYmd(d.date) ? d.date : G.today());
        rerender(); say('조치 ' + n + '건 새로 생성');
        break;
      }
      case 'pf-act': {
        if (!isAdmin()) { say('원장·관리 담당만 처리할 수 있습니다'); break; }
        const row = allActions(core).find(a => a.key === d.key);
        if (!row) break;
        const next = core.transitionAction(row, d.st, { by: actorId(), at: G.now(), result: d.result || '' });
        delete next.key;
        write(core.actTaskId(row.staffId), row.actionId, Object.assign(next, { done: next.st === 'done' }));
        rerender();
        say(TYPE_LABEL[row.type] + ' · ' + studentName(row.studentId) + ' — ' + (d.result === 'no_answer' ? '부재중으로 이월' : ST_LABEL[next.st]));
        break;
      }
      case 'pf-pick': {
        if (!setupDraft || !d.name || !d.sid) break;
        const lg = setupDraft.legacy.find(x => x.name === d.name);
        if (!lg) break;
        setupDraft.picks[d.name] = d.sid;
        if (setupDraft.origin[d.sid] !== 'saved') { setupDraft.byId[d.sid] = lg.perfset.progs.slice(); setupDraft.origin[d.sid] = 'legacy'; }
        rerender();
        break;
      }
      case 'pf-setup-save': {
        if (!isAdmin()) { say('원장·관리 담당만 저장할 수 있습니다'); break; }
        const n = saveSetup(core, ctx(core));
        rerender(); say('프로그램 설정 ' + n + '명 저장');
        break;
      }
      case 'pf-setup-reset': setupDraft = null; rerender(); break;
      default: break;
    }
  }
  function onChange(ev) {
    const t = ev.target;
    const el = t && typeof t.closest === 'function' ? t.closest('[data-act^="pf-"]') : null;
    if (!el) return;
    const core = C();
    if (!core) return;
    const d = el.dataset;
    if (d.act === 'pf-why') {
      if (!isAdmin() || !core.PROGS.includes(d.prog) || !core.validYmd(d.date) || !d.sid) return;
      const why = core.WHYS.includes(el.value) ? el.value : '';
      updateEx(core, d.prog, d.date, d.sid, cur => (cur ? Object.assign(cur, { why: why }) : null));
      return;
    }
    if (d.act === 'pf-set') {
      if (!setupDraft || !d.sid || !core.PROGS.includes(d.prog)) return;
      const list = (setupDraft.byId[d.sid] || []).filter(p => p !== d.prog);
      if (el.checked) list.push(d.prog);
      setupDraft.byId[d.sid] = core.PROGS.filter(p => list.includes(p));
    }
  }
  if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
  }

  return {
    view: view,
    alertCount: alertCount,
    legacyOpModal: legacyOpModal,
    planFor: date => { const core = C(); return core ? planFor(core, date) : 0; },
    activeStudents: activeStudents,
    setTab: v => { tab = v; }
  };
});
