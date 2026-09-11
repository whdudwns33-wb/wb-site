/* 런북 UI — 제안 A(SOP 콕핏)의 화면 조각. task/index.html이 head에서 로드하고 훅 4곳에서 부른다:
 *   viewToday  → WBRunbookUI.todayBlocks(me, cursor)   오늘의 런북 + 내 요청함 + [＋ 운영 요청]
 *   viewBoard  → WBRunbookUI.boardCard(cursor)         원장 운영 카드(완료율·정시율·막힘·이월·요청 소요·타임라인·[런북 발행])
 *   taskPanel  → WBRunbookUI.stepExt(step)             단계 옆 ↗ 공식 링크 버튼
 *   briefText  → WBRunbookUI.briefSection(date)        마감 브리핑 운영 절
 *
 * 규칙(구현 계약 §1·§2·§4):
 *   - index.html 전역(state·getCheck·tasksFor·session·sync…)은 호출 시점에만 참조한다. 이 파일은 그 전역보다
 *     먼저 로드되고 Node 테스트에서도 require되므로, 최상위에서 전역을 만지면 터진다.
 *   - 클릭은 자기 리스너로 받고 data-act는 전부 'rb-' 접두 — index.html의 switch와 충돌하지 않는다.
 *   - 서버가 없거나 실패하면 힌트만 보이고 런북 체크(일반 task)는 계속 된다.
 *   - 외부 서비스는 WBExternalLinks의 공식 https 링크를 새 창으로 열 뿐이다. 학생은 SF 코드·studentId만.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBRunbookUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PACK_URL = './runbook-pack.json';   // task/index.html 기준 상대 경로 — Pages 배포에서 같은 디렉터리
  const AUDIT_PREFIX = '__audit__';         // 원장 [대조 완료] 증적: checks '__audit__<taskId>|<date>'
  const ATT_PREFIX = '__att__';             // 출퇴근 정본은 /staff-attendance — 여기서는 배지로 읽기만
  const REQUEST_ID_RE = /^opr_[A-Za-z0-9_-]{4,76}$/;
  const TARGET_RE = /^(?:SF-\d{3}|[A-Za-z0-9_-]{1,128})$/;

  /* 메모리 캐시. 요청 목록은 라우트 진입마다 1회 갱신하고(loadedKey), 전이 결과로 행만 바꿔 끼운다. */
  const st = {
    requests: [], loaded: false, loading: false, error: '', loadedKey: '', promise: null,
    viewerId: '', role: '',
    pack: null, packLoading: false, packError: '', packPromise: null,
    busy: false, viaDraft: 'app'
  };

  /* ── index.html 전역 접근 (호출 시점 해석) ─────────── */

  function core() { return typeof WBRunbookCore !== 'undefined' ? WBRunbookCore : null; }
  function links() { return typeof WBExternalLinks !== 'undefined' ? WBExternalLinks : null; }
  function ready() {
    return !!core() && typeof state === 'object' && !!state && typeof getCheck === 'function' &&
      typeof tasksFor === 'function' && typeof session === 'object' && !!session;
  }
  function localEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function E(s) { return typeof esc === 'function' ? esc(s) : localEsc(s); }
  function T(msg) { if (typeof toast === 'function') toast(msg); }
  function rerender() {
    if (typeof renderAfterSync === 'function') renderAfterSync();
    else if (typeof render === 'function') render();
  }
  function todayYmd() { return typeof today === 'function' ? today() : new Date().toISOString().slice(0, 10); }
  function nowHMs() { return typeof nowHM === 'function' ? nowHM() : ''; }
  function nowMs() { return typeof now === 'function' ? now() : Date.now(); }
  function newId(prefix) {
    const raw = typeof uid === 'function' ? uid() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
    return prefix + String(raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
  }
  function q(sel) { return typeof document !== 'undefined' ? document.querySelector(sel) : null; }
  function val(id) { const el = q('#' + id); return el ? String(el.value || '') : ''; }
  /* '원장' 판정. 업무지시서 앱은 isAdmin 하나지만, 프로그램데스크는 직원도 isAdmin(운영자)이라
     canApprove 로 원장을 가른다 — 발행·담당 지정·대조 완료·운영 카드는 원장만. */
  function isAdmin() { return !!(session && session.isAdmin && session.canApprove !== false); }
  function myId() { return session && session.isStaffLink ? String(session.staffId || '') : ''; }
  /* 서버가 list 응답에 viewerId를 준다(관리 담당은 자기 id, 비밀키 원장은 'admin'). 그 전에는 링크의 staffId. */
  function viewerId() { return st.viewerId || myId(); }
  function ctxFor(req) {
    const me = viewerId();
    return { role: isAdmin() ? 'admin' : 'staff', isOwner: !!me && req.ownerId === me, isAssignee: !!me && req.assigneeId === me };
  }
  function staffName(id) {
    const s = typeof staffById === 'function' ? staffById(id) : null;
    if (s && s.name) return String(s.name);
    if (id === 'admin' || id === 'director') return '원장님';
    return id ? '직원' : '미지정';
  }
  function liveStaffList() {
    if (typeof liveStaff === 'function') return liveStaff();
    return (state.staff || []).filter(s => s && !s.deleted);
  }
  function tasksOn(staffId, date) { return tasksFor(staffId, date) || []; }
  function allStaffTasks(date) {
    const out = [];
    liveStaffList().forEach(s => tasksOn(s.id, date).forEach(t => out.push(t)));
    return out;
  }
  function authOk() { return typeof sync === 'object' && !!sync && typeof sync.auth === 'function' && !!sync.auth(); }
  function appName() { return typeof SYNC_APP === 'string' ? SYNC_APP : 'task'; }
  function post(body) {
    return sync.post('/ops-request', Object.assign({ app: appName(), auth: sync.auth() }, body));
  }
  function editableHere() { return !!(session && (session.isStaffLink || session.isAdmin)); }
  function hm(ms) { return core().hmOf(ms); }
  function ymdOf(ms) {
    const n = Number(ms);
    if (!(n > 0)) return '';
    const d = new Date(n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ── 외부 링크 ─────────────────────────────────────── */

  function linkBtn(key, extraStyle) {
    const L = links();
    const row = L ? L.linkFor(key) : null;
    if (!row) return '';
    return '<a class="btn btn-sm btn-ghost" href="' + E(row.url) + '" target="_blank" rel="noopener noreferrer" ' +
      'data-act="rb-ext" data-ext="' + E(row.key) + '" style="white-space:nowrap' + (extraStyle ? ';' + extraStyle : '') + '">↗ ' + E(row.label) + '</a>';
  }

  /** taskPanel 단계 옆에 붙는 ↗ 버튼. ext 키가 링크 표에 없으면 '' — 임의 주소는 그리지 않는다. */
  function stepExt(step) {
    if (!step || typeof step !== 'object' || !step.ext) return '';
    return linkBtn(String(step.ext), 'margin-left:auto');
  }

  function resultUrlHtml(url) {
    const L = links();
    const u = String(url || '');
    if (!u) return '';
    if (L && L.isApprovedLink(u)) {
      return '<a class="btn btn-sm btn-ghost" href="' + E(u) + '" target="_blank" rel="noopener noreferrer">↗ 결과 링크</a>';
    }
    /* 서버는 https면 받지만 화면은 승인 호스트만 링크로 연다 — 나머지는 호스트 이름만 보여 준다. */
    let host = '';
    try { host = new URL(u).hostname; } catch (e) { host = ''; }
    return host ? '<span class="tag">링크: ' + E(host) + '</span>' : '';
  }

  /* ── 팩 ────────────────────────────────────────────── */

  function ensurePackLoaded(force) {
    if (st.pack && !force) return Promise.resolve(st.pack);
    if (st.packPromise && !force) return st.packPromise;
    if (typeof fetch !== 'function' || !core()) {
      st.packError = '런북 팩을 읽을 수 없는 환경입니다';
      return Promise.resolve(null);
    }
    st.packLoading = true; st.packError = '';
    const L = links();
    st.packPromise = fetch(PACK_URL, { cache: 'no-cache' })
      .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(pack => {
        const v = core().validatePack(pack, { linkFor: L ? L.linkFor : null });
        if (!v.ok) throw new Error(v.errors[0]);
        st.pack = pack;
        return pack;
      })
      .catch(err => { st.pack = null; st.packError = '런북 팩을 불러오지 못했습니다 — ' + (err && err.message || err); return null; })
      .finally(() => { st.packLoading = false; st.packPromise = null; });
    return st.packPromise;
  }

  function slotDef(slotId) { return st.pack ? core().slotOf(st.pack, slotId) : null; }

  /* ── 요청 목록 ─────────────────────────────────────── */

  function normalizeRequest(r) {
    const C = core();
    if (!r || typeof r !== 'object' || !REQUEST_ID_RE.test(String(r.id || ''))) return null;
    const target = String(r.targetRef || '');
    return {
      id: String(r.id),
      reqType: C.REQ_TYPES.includes(r.reqType) ? r.reqType : 'other',
      program: C.PROGRAMS.includes(r.program) ? r.program : 'none',
      targetRef: TARGET_RE.test(target) ? target : '',
      ownerId: String(r.ownerId || ''), assigneeId: String(r.assigneeId || ''),
      via: C.VIA.includes(r.via) ? r.via : 'app',
      neededBy: C.validYmd(r.neededBy) ? String(r.neededBy) : '',
      detail: String(r.detail || '').slice(0, 300),
      status: C.REQ_STATUS.includes(r.status) ? r.status : 'requested',
      resultNote: String(r.resultNote || '').slice(0, 300),
      resultUrl: String(r.resultUrl || '').slice(0, 500),
      createdAt: Number(r.createdAt) || 0, acceptedAt: Number(r.acceptedAt) || null,
      doneAt: Number(r.doneAt) || null, updatedAt: Number(r.updatedAt) || 0
    };
  }

  function replaceRequest(row) {
    const r = normalizeRequest(row);
    if (!r) return;
    const i = st.requests.findIndex(x => x.id === r.id);
    if (i < 0) st.requests.unshift(r); else st.requests[i] = r;
  }

  /** 라우트 진입마다 1회 갱신. 서버가 없으면 힌트만 남기고 조용히 끝난다 — 런북 체크는 계속 되어야 한다. */
  function ensureRequestsLoaded(force) {
    if (!ready()) return Promise.resolve([]);
    if (!authOk()) { st.error = ''; st.loaded = false; return Promise.resolve([]); }
    const key = String(typeof route === 'string' ? route : '');
    if (st.loading) return st.promise || Promise.resolve(st.requests);
    if (st.loaded && !force && st.loadedKey === key) return Promise.resolve(st.requests);
    st.loading = true;
    st.promise = post({ action: 'list' })
      .then(res => {
        st.requests = (Array.isArray(res.requests) ? res.requests : []).map(normalizeRequest).filter(Boolean);
        st.viewerId = String(res.viewerId || '');
        st.role = String(res.role || '');
        st.error = '';
      })
      .catch(err => {
        st.error = (err && err.code === 'OPS_REQUEST_NOT_READY') ? '요청함 서버를 준비하고 있습니다'
          : '요청함을 불러오지 못했습니다' + (err && err.message ? ' — ' + err.message : '');
      })
      .finally(() => {
        st.loaded = true; st.loadedKey = key; st.loading = false; st.promise = null;
        rerender();
      });
    return st.promise;
  }

  function requestsFor(filter) { return st.requests.filter(filter); }
  function openReq(r) { return core().isOpenRequest(r); }
  function overdueReq(r, date) { return openReq(r) && !!r.neededBy && r.neededBy < (date || todayYmd()); }

  /* ── 요청 카드 ─────────────────────────────────────── */

  function statusTag(status) {
    const C = core();
    const cls = status === 'done' ? 'ok' : status === 'blocked' ? 'blk' : (status === 'accepted' || status === 'in_progress') ? 'doing' : '';
    return '<span class="tag ' + cls + '">' + E(C.REQ_STATUS_LABEL[status] || status) + '</span>';
  }

  function taskClass(status) {
    return status === 'done' || status === 'cancelled' ? 'done' : status === 'blocked' ? 'blocked isblocked'
      : (status === 'accepted' || status === 'in_progress') ? 'doing' : 'todo';
  }

  /**
   * 요청 한 장. opts.who: 'assignee'(내 처리)·'owner'(내가 올림)·'admin'(전체).
   * 대상 코드는 처리하는 사람에게 필요하니 보이되, 원장 타임라인에는 싣지 않는다(boardCard가 따로 그린다).
   */
  function requestCard(r, date, opts) {
    const C = core();
    const o = opts || {};
    const ctx = ctxFor(r);
    const actions = C.allowedActions(r.status, ctx);
    const L = links();
    const progLink = L ? L.keys().find(k => L.programOf(k) === r.program && /_(admin|teacher|center|org)$|^(exam4you|jokbo)$/.test(k)) : '';
    const meta =
      (r.neededBy ? '<span class="tag time">필요 ' + E(r.neededBy) + '</span>' : '') +
      statusTag(r.status) +
      (r.via === 'kakao' ? '<span class="tag">카톡 경유</span>' : r.via === 'auto' ? '<span class="tag">자동</span>' : '') +
      (overdueReq(r, date) ? '<span class="tag blk">기한 지남</span>' : '') +
      (o.who !== 'assignee' ? '<span class="tag">담당 ' + E(staffName(r.assigneeId)) + '</span>' : '') +
      (o.who !== 'owner' ? '<span class="tag">요청 ' + E(staffName(r.ownerId)) + '</span>' : '');
    const buttons = actions.map(a => {
      const cls = a === 'done' ? 'btn-primary' : a === 'block' ? 'btn-danger' : a === 'cancel' ? 'btn-ghost' : 'btn-navy';
      return '<button class="btn btn-sm ' + cls + '" data-act="rb-req-act" data-id="' + E(r.id) + '" data-action="' + a + '">' +
        E(C.REQ_ACTION_LABEL[a]) + '</button>';
    }).join('');
    return '<div class="task ' + taskClass(r.status) + '" data-rb-req="' + E(r.id) + '"><div class="task-body">' +
      '<div class="task-t">' + E(C.REQ_TYPE_LABEL[r.reqType]) + ' · ' + E(C.PROGRAM_LABEL[r.program]) +
        (r.targetRef ? ' · <span class="muted">' + E(r.targetRef) + '</span>' : '') + '</div>' +
      '<div class="meta">' + meta + '</div>' +
      (r.detail ? '<div class="task-d">' + E(r.detail) + '</div>' : '') +
      (r.resultNote || r.resultUrl
        ? '<div class="small muted mt8">' + (r.status === 'blocked' ? '사유: ' : '결과: ') + E(r.resultNote) + ' ' + resultUrlHtml(r.resultUrl) + '</div>' : '') +
      ((buttons || progLink) ? '<div class="row wraprow mt8" style="gap:6px">' + buttons +
        (progLink && openReq(r) ? linkBtn(progLink) : '') + '</div>' : '') +
      '</div></div>';
  }

  function serverHint() {
    if (!authOk()) return '<div class="hint mt8">동기화(개인 링크 또는 관리자 비밀키)가 연결되면 요청함을 쓸 수 있습니다.</div>';
    if (st.error) {
      return '<div class="hint mt8" style="color:var(--coral)">' + E(st.error) + ' — 런북 체크는 계속 저장됩니다. ' +
        '<button class="btn btn-sm btn-ghost" data-act="rb-req-refresh">다시 시도</button></div>';
    }
    if (st.loading && !st.loaded) return '<div class="hint mt8">요청함을 불러오는 중…</div>';
    return '';
  }

  /* ── 오늘 화면 ─────────────────────────────────────── */

  function runbookBlock(me, date, tasks) {
    const C = core();
    const s = C.summarize(tasks, getCheck, date, nowHMs());
    const isToday = date === todayYmd();
    const editable = editableHere();
    if (!st.pack && !st.packLoading && !st.packError) ensurePackLoaded().then(p => { if (p) rerender(); });
    const carried = isToday ? C.carriedSlots(date, d => tasksOn(me.id, d), getCheck, 7) : [];
    const carryBySlot = {};
    carried.forEach(c => { carryBySlot[c.slotId] = Math.max(carryBySlot[c.slotId] || 0, c.daysAgo); });
    const needsAtt = isToday && session.isStaffLink && me.id === session.staffId && !((getCheck(ATT_PREFIX + me.id, date) || {}).done);

    let h = '<div class="card"><div class="between mb8"><div class="card-title">📋 오늘의 런북</div>' +
      '<div class="pill' + (s.late ? ' warn' : '') + '">' + s.done + '/' + s.issued + ' 완료 · 정시 ' + s.onTime +
      (s.blocked ? ' · 막힘 ' + s.blocked : '') + '</div></div>';
    if (needsAtt) h += '<div class="mb8"><span class="pill warn">출근 체크 먼저 — 위 [출근했습니다] 버튼</span></div>';
    if (st.packError) {
      h += '<div class="hint mb8">' + E(st.packError) + ' <button class="btn btn-sm btn-ghost" data-act="rb-pack-retry">다시</button></div>';
    }
    h += s.slots.map(sl => {
      const t = tasks.find(x => String(x.id) === sl.taskId) || {};
      const def = slotDef(sl.slotId);
      const stepsWithExt = (Array.isArray(t.steps) ? t.steps : []).filter(x => x && x.ext);
      const extKeys = [...new Set((stepsWithExt.length ? stepsWithExt : (def && def.steps || [])).map(x => String(x.ext || '')).filter(Boolean))];
      const hasCount = !!(def && (def.count || def.evidence === 'count'));
      const countLabel = def && def.count ? String(def.count.label || '수량') : '수량';
      const carryDays = carryBySlot[sl.slotId] || 0;
      const style = 'padding:8px 0;border-bottom:1px solid var(--light-gray)' +
        (sl.late && sl.status !== 'done' ? ';border-left:3px solid var(--coral);padding-left:8px' : '');
      return '<div class="between small" style="' + style + '">' +
        '<div style="flex:1;min-width:0">' +
          '<b>' + C.STATUS_ICON[sl.status] + ' ' + E(sl.time || '—') + ' ' + E(sl.title) + '</b>' +
          '<div class="muted">' + (sl.stepsTotal ? sl.stepsDone + '/' + sl.stepsTotal + '단계 · ' : '') +
            (sl.dueLimit ? '마감 ' + E(sl.dueLimit) : '시각 없음') +
            (sl.status === 'done' && sl.doneHM ? ' · 완료 ' + E(sl.doneHM) : '') +
            (sl.late ? ' <span class="tag blk">지연</span>' : '') +
            (carryDays ? ' <span class="tag carry">⚠ 이월 ' + carryDays + '일</span>' : '') +
          '</div>' +
          (hasCount ? '<div class="row mt8" style="gap:6px"><span class="muted">' + E(countLabel) + '</span>' +
            (editable ? '<button class="btn btn-sm btn-ghost" data-act="rb-cnt" data-id="' + E(sl.taskId) + '" data-date="' + E(date) + '" data-n="-1">−</button>' : '') +
            '<b>' + sl.count + '</b><span class="muted">' + E(sl.unit) + '</span>' +
            (editable ? '<button class="btn btn-sm btn-ghost" data-act="rb-cnt" data-id="' + E(sl.taskId) + '" data-date="' + E(date) + '" data-n="1">＋</button>' : '') +
            '</div>' : '') +
          (sl.note ? '<div class="muted" style="margin-top:4px">“' + E(sl.note) + '”</div>' : '') +
        '</div>' +
        '<div class="row wraprow" style="gap:6px;justify-content:flex-end">' +
          extKeys.map(k => linkBtn(k)).join('') +
          '<button class="btn btn-sm btn-ghost" data-act="rb-jump" data-id="' + E(sl.taskId) + '" title="업무 카드로">▾</button>' +
        '</div></div>';
    }).join('');
    h += '<div class="hint mt8">체크·메모·막힘은 아래 업무 카드에서 합니다. 예정 시각 + 여유 안에 완료하면 정시입니다. ' +
      '정상 완료는 체크만 — 막힘·이월·수량이 있을 때만 메모 한 줄을 남기세요.</div></div>';
    return h;
  }

  function inboxBlock(me, date) {
    const C = core();
    ensureRequestsLoaded();
    const assigned = C.sortRequests(requestsFor(r => r.assigneeId === me.id));
    const mine = C.sortRequests(requestsFor(r => r.ownerId === me.id && r.assigneeId !== me.id));
    const openN = assigned.filter(openReq).length;
    const adminView = isAdmin();
    let h = '<div class="card"><div class="between mb8"><div class="card-title">📨 내 요청함</div>' +
      '<div class="pill' + (openN ? ' warn' : '') + '">미처리 ' + openN + '</div></div>';
    h += serverHint();
    if (assigned.length) {
      h += '<div class="sect" style="margin-top:8px">담당 요청</div>' + assigned.map(r => requestCard(r, date, { who: 'assignee' })).join('');
    }
    if (mine.length) {
      h += '<div class="sect" style="margin-top:8px">내가 올린 요청</div>' + mine.map(r => requestCard(r, date, { who: 'owner' })).join('');
    }
    if (!assigned.length && !mine.length && st.loaded && !st.error) {
      h += '<div class="small muted mt8">요청이 없습니다. 계정 발급·세트 배정·문제지가 필요하면 아래 버튼으로 올리세요 — 카톡으로 묻지 않아도 됩니다.</div>';
    }
    h += '<div class="row wraprow mt8" style="gap:6px">' +
      '<button class="btn btn-sm btn-primary" data-act="rb-req-new"' + (adminView ? ' data-assignee="' + E(me.id) + '"' : '') + '>＋ 운영 요청</button>' +
      (adminView ? '<button class="btn btn-sm btn-ghost" data-act="rb-req-new" data-via="kakao" data-assignee="' + E(me.id) + '">＋ 카톡 요청 대신 등록</button>' : '') +
      '<button class="btn btn-sm btn-ghost" data-act="rb-req-refresh">새로고침</button></div></div>';
    return h;
  }

  /** 오늘 화면 — 출퇴근 카드 다음. 런북 task가 없는 강사에게도 요청함(＋ 운영 요청)은 보인다. */
  function todayBlocks(me, date) {
    if (!ready() || !me || !me.id) return '';
    const C = core();
    const d = String(date || todayYmd());
    const tasks = tasksOn(me.id, d).filter(C.isRunbookTask);
    let h = '';
    if (tasks.length) h += runbookBlock(me, d, tasks);
    if (d === todayYmd()) h += inboxBlock(me, d);
    return h;
  }

  /* ── 원장 카드 ─────────────────────────────────────── */

  function auditOf(taskId, date) { return getCheck(AUDIT_PREFIX + taskId, date); }

  function boardCard(date) {
    if (!ready() || !isAdmin()) return '';
    const C = core();
    const d = String(date || todayYmd());
    ensureRequestsLoaded();
    const s = C.summarize(allStaffTasks(d), getCheck, d, nowHMs());
    const carried = C.carriedSlots(d, allStaffTasks, getCheck, 7);
    const carry3 = carried.filter(c => c.daysAgo >= 3).length;
    const reqs = st.requests;
    const open = reqs.filter(openReq);
    const overdue = open.filter(r => overdueReq(r, d));
    const doneToday = reqs.filter(r => r.status === 'done' && ymdOf(r.doneAt) === d);
    const weekAgo = C.addDays(d, -6);
    const recentDone = reqs.filter(r => r.status === 'done' && ymdOf(r.doneAt) >= weekAgo && ymdOf(r.doneAt) <= d);
    const leads = recentDone.map(r => C.leadTime(r)).filter(Boolean);
    const sla = recentDone.map(r => C.slaMet(r)).filter(v => v !== null);
    const kakao = reqs.filter(r => r.via === 'kakao' && ymdOf(r.createdAt) >= weekAgo).length;
    const weekReqs = reqs.filter(r => ymdOf(r.createdAt) >= weekAgo).length;

    let h = '<div class="card"><div class="between mb8"><div class="card-title">🧭 운영 런북 · 요청함</div>' +
      '<div class="pill' + (s.late || s.blocked ? ' warn' : '') + '">' + E(d) + '</div></div>';
    h += '<div class="card-sub mb8">절차 지표입니다 — 학생이 실제로 했는가는 수행 탭(코워크 판정)이 봅니다.</div>';
    h += '<div class="row wraprow small" style="gap:8px">' +
      '<span class="pill">완료율 ' + s.completionRate + '% (' + s.done + '/' + s.issued + ')</span>' +
      '<span class="pill">정시율 ' + s.onTimeRate + '%</span>' +
      '<span class="pill' + (s.blocked ? ' bad' : '') + '">막힘 ' + s.blocked + '</span>' +
      '<span class="pill' + (s.late ? ' warn' : '') + '">지연 ' + s.late + '</span>' +
      '<span class="pill' + (carry3 ? ' bad' : carried.length ? ' warn' : '') + '">이월 ' + carried.length + (carry3 ? ' · 3일+ ' + carry3 : '') + '</span>' +
      '</div>';
    h += '<div class="row wraprow small mt8" style="gap:8px">' +
      '<span class="pill' + (overdue.length ? ' bad' : open.length ? ' warn' : '') + '">요청 미처리 ' + open.length + (overdue.length ? ' · 기한 지남 ' + overdue.length : '') + '</span>' +
      '<span class="pill">오늘 완료 ' + doneToday.length + '</span>' +
      '<span class="pill">소요 중위(7일) ' + E(C.fmtDuration(C.median(leads.map(l => l.owner)))) + '</span>' +
      '<span class="pill">필요일 준수 ' + sla.filter(Boolean).length + '/' + sla.length + '</span>' +
      '<span class="pill">카톡 경유 ' + (weekReqs ? Math.round(kakao / weekReqs * 100) : 0) + '%</span>' +
      '</div>';
    h += serverHint();

    /* 오늘 결과 타임라인 — 슬롯 시각·직원·상태·건수·메모 한 줄. 학생 식별자는 가린다(A.5). */
    h += '<div class="sect">오늘 결과 타임라인</div>';
    if (!s.slots.length) {
      h += '<div class="small muted">오늘 발행된 런북 슬롯이 없습니다. [런북 발행]으로 직원에게 슬롯을 내려보내세요.</div>';
    } else {
      h += s.slots.map(sl => {
        const audited = auditOf(sl.taskId, d);
        return '<div class="between small" style="padding:5px 0;border-bottom:1px solid var(--light-gray)">' +
          '<div style="flex:1;min-width:0">' + C.STATUS_ICON[sl.status] + ' <b>' + E(sl.time || '—') + '</b> ' + E(sl.title) +
            ' <span class="muted">· ' + E(staffName(sl.staffId)) + '</span>' +
            (sl.status === 'done' && sl.doneHM ? ' <span class="tag ok">' + E(sl.doneHM) + ' 완료</span>' : '') +
            (sl.late ? ' <span class="tag blk">지연</span>' : '') +
            (sl.status === 'blocked' ? ' <span class="tag blk">막힘</span>' : '') +
            (sl.count ? ' <span class="tag">' + sl.count + E(sl.unit) + '</span>' : '') +
            (sl.note ? '<div class="muted">“' + E(C.maskIdentifiers(sl.note)) + '”</div>' : '') +
          '</div>' +
          (audited && audited.done
            ? '<span class="tag ok">대조 ✓</span>'
            : '<button class="btn btn-sm btn-ghost" data-act="rb-audit" data-id="' + E(sl.taskId) + '" data-date="' + E(d) + '">대조 완료</button>') +
        '</div>';
      }).join('');
    }
    if (doneToday.length) {
      h += doneToday.map(r => '<div class="small" style="padding:5px 0;border-bottom:1px solid var(--light-gray)">📨 <b>' +
        E(hm(r.doneAt)) + '</b> ' + E(C.REQ_TYPE_LABEL[r.reqType]) + ' · ' + E(C.PROGRAM_LABEL[r.program]) +
        ' <span class="muted">· ' + E(staffName(r.assigneeId)) + '</span>' +
        (r.resultNote ? ' <span class="muted">“' + E(C.maskIdentifiers(r.resultNote)) + '”</span>' : '') + ' ' + resultUrlHtml(r.resultUrl) + '</div>').join('');
    }

    /* 미처리 요청 — 담당 지정·막힘 회신은 여기서. 접혀 있어 카드가 길어지지 않는다. */
    if (open.length) {
      h += '<details class="mt8"><summary class="small" style="cursor:pointer;font-weight:700">미처리 요청 ' + open.length + '건 펼치기</summary>' +
        C.sortRequests(open).map(r => requestCard(r, d, { who: 'admin' })).join('') + '</details>';
    }

    h += '<hr class="sep"><div class="row wraprow" style="gap:6px">' +
      '<button class="btn btn-sm btn-navy" data-act="rb-publish">📋 런북 발행</button>' +
      '<button class="btn btn-sm btn-primary" data-act="rb-req-new">＋ 운영 요청</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="rb-req-new" data-via="kakao">＋ 카톡 요청 대신 등록</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="rb-weekly">주간 절차 리포트</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="rb-req-refresh">요청 새로고침</button></div></div>';
    return h;
  }

  /* ── 마감 브리핑 절 ────────────────────────────────── */

  function briefSection(date) {
    if (!ready()) return '';
    const C = core();
    const d = String(date || todayYmd());
    const s = C.summarize(allStaffTasks(d), getCheck, d, nowHMs());
    const reqs = st.requests;
    const open = reqs.filter(openReq);
    const doneToday = reqs.filter(r => r.status === 'done' && ymdOf(r.doneAt) === d);
    if (!s.issued && !st.loaded) return '';
    let txt = '─────────\n📋 운영 런북 — 발행 ' + s.issued + ' · 완료 ' + s.done + ' (' + s.completionRate + '%) · 정시 ' + s.onTime +
      ' · 지연 ' + s.late + ' · 막힘 ' + s.blocked + '\n';
    s.slots.forEach(sl => {
      txt += '· ' + (sl.time || '—') + ' ' + sl.title + ' — ' +
        (sl.status === 'done' ? '완료' + (sl.doneHM ? ' ' + sl.doneHM : '') : sl.status === 'blocked' ? '막힘' : sl.status === 'doing' ? '진행중' : '미착수') +
        (sl.late ? ' [지연]' : '') + (sl.count ? ' ' + sl.count + sl.unit : '') + ' (' + staffName(sl.staffId) + ')' +
        (sl.note ? '\n   “' + C.maskIdentifiers(sl.note) + '”' : '') + '\n';
    });
    if (st.loaded) {
      txt += '📨 요청함 — 미처리 ' + open.length + ' · 막힘 ' + open.filter(r => r.status === 'blocked').length +
        ' · 오늘 완료 ' + doneToday.length + ' · 기한 지남 ' + open.filter(r => overdueReq(r, d)).length + '\n';
    } else if (st.error) {
      txt += '📨 요청함 — 서버 연결 실패(' + st.error + ')\n';
    }
    return txt;
  }

  /* ── 모달: 요청 등록 ───────────────────────────────── */

  function selectHtml(id, options, selected, extraAttrs) {
    return '<select class="in" id="' + id + '"' + (extraAttrs || '') + '>' + options.map(o =>
      '<option value="' + E(o[0]) + '"' + (o[0] === selected ? ' selected' : '') + '>' + E(o[1]) + '</option>').join('') + '</select>';
  }

  function openRequestForm(opts) {
    if (typeof modal !== 'function') return;
    const C = core();
    const o = opts || {};
    const admin = isAdmin();
    st.viaDraft = admin && o.via === 'kakao' ? 'kakao' : 'app';
    const staffOpts = [['', '(미지정 — 나중에 담당 지정)']].concat(liveStaffList().map(s => [String(s.id), String(s.name)]));
    const body =
      '<div class="fl">종류</div>' + selectHtml('rb-f-type', C.REQ_TYPES.map(t => [t, C.REQ_TYPE_LABEL[t]]), o.reqType || 'account') +
      '<div class="fl mt8">프로그램</div>' + selectHtml('rb-f-program', C.PROGRAMS.map(p => [p, C.PROGRAM_LABEL[p]]), o.program || 'studyforce') +
      '<div class="fl mt8">대상 — SF 코드(SF-012) 또는 학생 ID · <b>이름·전화 금지</b></div>' +
      '<input class="in" id="rb-f-target" maxlength="128" placeholder="SF-012" value="' + E(o.targetRef || '') + '">' +
      '<div class="fl mt8">필요일</div><input class="in" id="rb-f-needed" type="date" value="' + E(o.neededBy || C.addDays(todayYmd(), 1)) + '">' +
      '<div class="fl mt8">내용 한 줄 (300자)</div>' +
      '<textarea class="in" id="rb-f-detail" rows="2" maxlength="300" placeholder="예) 스터디포스 계정 발급 — 붉은 책 2단계부터">' + E(o.detail || '') + '</textarea>' +
      (admin
        ? '<div class="fl mt8">담당</div>' + selectHtml('rb-f-assignee', staffOpts, String(o.assigneeId || '')) +
          '<div class="fl mt8">접수 경로</div><div class="chips">' +
          '<button type="button" class="chip' + (st.viaDraft === 'app' ? ' on' : '') + '" data-act="rb-via" data-v="app">앱</button>' +
          '<button type="button" class="chip' + (st.viaDraft === 'kakao' ? ' on' : '') + '" data-act="rb-via" data-v="kakao">카톡·구두 대신 등록</button></div>'
        : '') +
      '<div class="hint mt8">카톡 원문은 옮기지 않습니다. 파일·드라이브 경로·아이디·비밀번호는 적지 않습니다. 자료(교재·문제지 파일) 구매는 자산 탭에서 합니다.</div>';
    modal('운영 요청', body, '<button class="btn btn-primary btn-block mt14" data-act="rb-req-submit">요청 등록</button>');
  }

  async function submitRequest(button) {
    const C = core();
    if (st.busy) return;
    const admin = isAdmin();
    const input = {
      reqType: val('rb-f-type'), program: val('rb-f-program'), targetRef: val('rb-f-target'),
      neededBy: val('rb-f-needed'), detail: val('rb-f-detail'),
      via: admin ? st.viaDraft : 'app', assigneeId: admin ? val('rb-f-assignee') : ''
    };
    const v = C.validateRequest(input);
    if (!v.ok) return T(v.errors[0].reason);
    if (!authOk()) return T('동기화가 연결되어야 요청을 올릴 수 있습니다');
    const body = {
      action: 'create', id: newId('opr_'), reqType: v.value.reqType, program: v.value.program,
      targetRef: v.value.targetRef || undefined, neededBy: v.value.neededBy, detail: v.value.detail
    };
    /* via·assigneeId는 서버가 admin에게만 받는다 — staff가 보내면 403이라 아예 붙이지 않는다. */
    if (admin) { body.via = v.value.via; if (v.value.assigneeId) body.assigneeId = v.value.assigneeId; }
    st.busy = true;
    if (button) { button.disabled = true; button.textContent = '등록 중…'; }
    try {
      const res = await post(body);
      replaceRequest(res.request);
      if (typeof closeModal === 'function') closeModal();
      T('운영 요청을 등록했습니다');
      rerender();
    } catch (err) {
      if (button) { button.disabled = false; button.textContent = '요청 등록'; }
      T('요청 등록 실패 — ' + (err && err.message || err));
    } finally {
      st.busy = false;
    }
  }

  /* ── 모달: 결과·사유, 담당 지정 ───────────────────── */

  function openResultModal(id, action) {
    if (typeof modal !== 'function') return;
    const C = core();
    const r = st.requests.find(x => x.id === id);
    if (!r) return T('요청을 찾을 수 없습니다');
    const isDone = action === 'done';
    const body =
      '<div class="small mb8"><b>' + E(C.REQ_TYPE_LABEL[r.reqType]) + ' · ' + E(C.PROGRAM_LABEL[r.program]) + '</b>' +
        (r.targetRef ? ' · ' + E(r.targetRef) : '') + '</div>' +
      '<div class="fl">' + (isDone ? '결과 한 줄 (선택 · 300자)' : '막힌 이유 한 줄 (300자)') + '</div>' +
      '<textarea class="in" id="rb-res-note" rows="2" maxlength="300" placeholder="' + (isDone ? '예) 발급 완료, 초기 안내 전달' : '예) 사이트 점검 중 — 내일 재시도') + '"></textarea>' +
      (isDone && C.RESULT_URL_TYPES.includes(r.reqType)
        ? '<div class="fl mt8">결과 링크 (선택 · 공식 사이트 https만)</div><input class="in" id="rb-res-url" placeholder="공식 사이트 주소 (https)">'
        : '') +
      '<div class="hint mt8">학생 이름·연락처·비밀번호는 적지 않습니다.' + (isDone ? '' : ' 막힘 신고는 감점이 아닙니다 — 절차 결함을 찾는 근거입니다.') + '</div>';
    modal(isDone ? '완료 기록' : '막힘 신고', body,
      '<button class="btn ' + (isDone ? 'btn-primary' : 'btn-danger') + ' btn-block mt14" data-act="rb-req-result-submit" data-id="' + E(id) + '" data-action="' + action + '">' +
      (isDone ? '완료 저장' : '막힘으로 표시') + '</button>');
  }

  function openAssignModal(id) {
    if (typeof modal !== 'function') return;
    const r = st.requests.find(x => x.id === id);
    if (!r) return T('요청을 찾을 수 없습니다');
    const staffOpts = liveStaffList().map(s => [String(s.id), String(s.name)]);
    if (!staffOpts.length) return T('담당으로 지정할 직원이 없습니다');
    modal('담당 지정', '<div class="fl">담당 직원</div>' + selectHtml('rb-assign', staffOpts, r.assigneeId || staffOpts[0][0]),
      '<button class="btn btn-primary btn-block mt14" data-act="rb-req-assign-submit" data-id="' + E(id) + '">지정</button>');
  }

  /** 전이 한 번. CAS(expectedUpdatedAt) 실패면 서버의 current로 갈아끼우고 다시 그린다 — 오래된 화면이 이기면 안 된다. */
  async function transition(id, action, extra, button) {
    const C = core();
    const r = st.requests.find(x => x.id === id);
    if (!r) return T('요청을 찾을 수 없습니다');
    const chk = C.nextStatus(r.status, action, ctxFor(r));
    if (!chk.ok) return T('지금 상태에서는 할 수 없는 처리입니다');
    if (!authOk()) return T('동기화가 연결되어야 처리할 수 있습니다');
    if (st.busy) return;
    st.busy = true;
    if (button) button.disabled = true;
    try {
      const res = await post(Object.assign({ action: action, id: id, expectedUpdatedAt: r.updatedAt }, extra || {}));
      replaceRequest(res.request);
      if (typeof closeModal === 'function') closeModal();
      T(C.REQ_ACTION_LABEL[action] + ' 처리했습니다');
    } catch (err) {
      if (err && (err.code === 'OPS_STALE' || err.code === 'OPS_TRANSITION') && err.current) {
        replaceRequest(err.current);
        T('다른 기기에서 먼저 바뀌었습니다 — 최신 상태로 갱신했습니다');
      } else {
        T('요청 처리 실패 — ' + (err && err.message || err));
      }
      if (button) button.disabled = false;
    } finally {
      st.busy = false;
      rerender();
    }
  }

  function submitResult(el) {
    const C = core();
    const id = String(el.dataset.id || ''), action = String(el.dataset.action || '');
    const r = st.requests.find(x => x.id === id);
    if (!r) return T('요청을 찾을 수 없습니다');
    const L = links();
    const v = C.validateResult({ resultNote: val('rb-res-note'), resultUrl: val('rb-res-url') }, r.reqType, L ? L.isApprovedLink : null);
    if (!v.ok) return T(v.errors[0].reason);
    if (action === 'block' && !v.value.resultNote) return T('막힌 이유를 한 줄 적어 주세요');
    const extra = {};
    if (v.value.resultNote) extra.resultNote = v.value.resultNote;
    if (action === 'done' && v.value.resultUrl) extra.resultUrl = v.value.resultUrl;
    return transition(id, action, extra, el);
  }

  /* ── 모달: 런북 발행 ───────────────────────────────── */

  function openPublishModal(opts) {
    if (typeof modal !== 'function' || !isAdmin()) return;
    const C = core();
    const o = opts || {};
    ensurePackLoaded().then(pack => {
      if (!pack) return T(st.packError || '런북 팩을 불러오지 못했습니다');
      const staffList = liveStaffList();
      if (!staffList.length) return T('발행할 직원이 없습니다 — 직원 관리에서 먼저 등록하세요');
      const staffId = String(o.staffId || staffList[0].id);
      const start = C.validYmd(o.start) ? o.start : todayYmd();
      const existing = new Set(C.activeSlotIds((state.tasks || []).filter(t => String(t.staffId) === staffId), start));
      const defaults = pack.defaults || {};
      const body =
        '<div class="fl">직원</div>' + selectHtml('rb-pub-staff', staffList.map(s => [String(s.id), String(s.name)]), staffId, ' data-act="rb-pub-staff"') +
        '<div class="fl mt8">시작일</div><input class="in" id="rb-pub-start" type="date" value="' + E(start) + '">' +
        '<div class="fl mt8">슬롯 (팩 ' + E(pack.packVersion) + ')</div>' +
        pack.slots.map(sl => {
          const manual = String(sl.issue || defaults.issue || 'auto') === 'manual';
          const has = existing.has(sl.slotId);
          const rep = sl.repeat === 'days' ? '요일 ' + (sl.days || []).map(n => '일월화수목금토'[n]).join('') : sl.repeat === 'once' ? '1회' : sl.repeat === 'daily' ? '매일' : '평일';
          return '<label class="row small" style="gap:8px;padding:5px 0;border-bottom:1px solid var(--light-gray)">' +
            '<input type="checkbox" name="rb-pub-slot" value="' + E(sl.slotId) + '"' + (has || manual ? '' : ' checked') + (has ? ' disabled' : '') + '>' +
            '<span style="flex:1"><b>[' + E(sl.slotId) + ']</b> ' + E(sl.title) + ' <span class="muted">' + E(sl.slotTime || '') + ' · ' + rep + '</span></span>' +
            (has ? '<span class="tag ok">발행됨</span>' : manual ? '<span class="tag">수동</span>' : '') + '</label>';
        }).join('') +
        '<div class="hint mt8">이미 살아 있는 슬롯은 건너뜁니다(중복 발행 방지). 시험 3주 전·넬트 분기 슬롯은 필요할 때 체크해서 발행하고, ' +
        '발행 뒤 지시서 상세(detail)에 과목·시험일·대상 반을 적어 주세요. 팩 개정은 기존 지시서를 중단한 뒤 다시 발행합니다.</div>';
      modal('런북 발행', body, '<button class="btn btn-primary btn-block mt14" data-act="rb-publish-run">발행</button>');
    });
  }

  function runPublish(button) {
    const C = core();
    if (!st.pack || typeof applyAssignments !== 'function') return T('런북 팩이 준비되지 않았습니다');
    const staffId = val('rb-pub-staff');
    const s = typeof staffById === 'function' ? staffById(staffId) : liveStaffList().find(x => String(x.id) === staffId);
    if (!s) return T('직원을 선택해 주세요');
    const start = val('rb-pub-start');
    if (!C.validYmd(start)) return T('시작일을 확인해 주세요');
    const chosen = typeof document !== 'undefined'
      ? Array.from(document.querySelectorAll('input[name="rb-pub-slot"]:checked')).map(el => String(el.value)) : [];
    if (!chosen.length) return T('발행할 슬롯을 하나 이상 고르세요');
    const existing = C.activeSlotIds((state.tasks || []).filter(t => String(t.staffId) === staffId), start);
    const L = links();
    const r = C.expandPack(st.pack, s.name, { start: start, existingSlotIds: existing, slotIds: chosen, linkFor: L ? L.linkFor : null });
    if (r.errors.length) return T(r.errors[0]);
    if (!r.assignments.length) return T('발행할 새 슬롯이 없습니다 — 전부 이미 발행되어 있습니다');
    if (button) button.disabled = true;
    applyAssignments({ assignments: r.assignments }, true);
  }

  /* ── 모달: 주간 리포트 ─────────────────────────────── */

  function openWeeklyModal(date) {
    if (typeof modal !== 'function' || !isAdmin()) return;
    const C = core();
    const d = String(date || todayYmd());
    const weekStart = typeof mondayOf === 'function' ? mondayOf(d) : C.addDays(d, -((C.dowOf(d) + 6) % 7));
    const report = C.weeklyReport(weekStart, allStaffTasks, getCheck, st.requests, nowHMs());
    const text = C.weeklyReportText(report);
    modal('주간 절차 리포트',
      '<div class="card-sub mb8">' + E(C.DISCLAIMER) + ' · 월요일 첫 접속 때 이 화면에서 조립합니다(서버 저장 없음).</div>' +
      '<textarea class="in" id="rb-weekly-text" rows="16" readonly>' + E(text) + '</textarea>',
      '<button class="btn btn-navy btn-block mt14" data-act="rb-copy" data-target="rb-weekly-text">복사</button>');
  }

  function copyText(targetId) {
    const el = q('#' + targetId);
    if (!el) return;
    const text = String(el.value || el.textContent || '');
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => T('복사했습니다'), () => { el.select(); T('길게 눌러 복사하세요'); });
      } else { el.select(); T('길게 눌러 복사하세요'); }
    } catch (e) { T('길게 눌러 복사하세요'); }
  }

  /* ── 이벤트 ────────────────────────────────────────── */

  function onClick(ev) {
    const el = ev.target && ev.target.closest ? ev.target.closest('[data-act^="rb-"]') : null;
    if (!el || !ready()) return;
    const act = String(el.dataset.act || '');
    const id = String(el.dataset.id || '');
    const date = String(el.dataset.date || (typeof cursor === 'string' ? cursor : todayYmd()));
    switch (act) {
      case 'rb-ext': {
        /* 링크는 그대로 열리게 두고(preventDefault 없음), 업무 카드 안에서 눌렸으면 extOpened만 남긴다 — 확인 증적의 보장선(A.6). */
        const card = el.closest('[data-task]');
        const taskId = card ? String(card.dataset.task || '') : '';
        if (!taskId || !editableHere() || typeof setCheck !== 'function') return;
        const c = getCheck(taskId, date);
        if (!(c && c.extOpened)) setCheck(taskId, date, { extOpened: true });
        return;
      }
      case 'rb-jump': {
        const node = typeof document !== 'undefined' ? document.querySelector('[data-task="' + id.replace(/"/g, '') + '"]') : null;
        if (node && node.scrollIntoView) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      case 'rb-cnt': {
        if (!editableHere() || typeof setCheck !== 'function') return;
        const c = getCheck(id, date);
        const next = Math.max(0, (Number(c && c.count) || 0) + (Number(el.dataset.n) || 0));
        setCheck(id, date, { count: next });
        rerender();
        return;
      }
      case 'rb-audit': {
        if (!isAdmin() || typeof setCheck !== 'function') return;
        setCheck(AUDIT_PREFIX + id, date, { done: true, at: nowMs(), by: viewerId() || 'admin' });
        T('대조 완료로 기록했습니다');
        rerender();
        return;
      }
      case 'rb-pack-retry': ensurePackLoaded(true).then(rerender); return;
      case 'rb-req-refresh': ensureRequestsLoaded(true); T('요청함을 새로 불러옵니다'); return;
      case 'rb-req-new': openRequestForm({ via: String(el.dataset.via || 'app'), assigneeId: String(el.dataset.assignee || '') }); return;
      case 'rb-via': {
        st.viaDraft = el.dataset.v === 'kakao' ? 'kakao' : 'app';
        if (typeof document !== 'undefined') {
          document.querySelectorAll('[data-act="rb-via"]').forEach(b => b.classList.toggle('on', b.dataset.v === st.viaDraft));
        }
        return;
      }
      case 'rb-req-submit': submitRequest(el); return;
      case 'rb-req-act': {
        const action = String(el.dataset.action || '');
        if (action === 'done' || action === 'block') openResultModal(id, action);
        else if (action === 'assign') openAssignModal(id);
        else if (action === 'cancel') { if (typeof confirm !== 'function' || confirm('이 요청을 취소할까요?')) transition(id, 'cancel', {}, el); }
        else transition(id, action, {}, el);
        return;
      }
      case 'rb-req-result-submit': submitResult(el); return;
      case 'rb-req-assign-submit': {
        const assigneeId = val('rb-assign');
        if (!assigneeId) return T('담당 직원을 고르세요');
        transition(id, 'assign', { assigneeId: assigneeId }, el);
        return;
      }
      case 'rb-publish': openPublishModal({}); return;
      case 'rb-publish-run': runPublish(el); return;
      case 'rb-weekly': openWeeklyModal(date); return;
      case 'rb-copy': copyText(String(el.dataset.target || '')); return;
      default: return;
    }
  }

  function onChange(ev) {
    const el = ev.target && ev.target.closest ? ev.target.closest('[data-act="rb-pub-staff"]') : null;
    if (!el || !ready()) return;
    /* 직원을 바꾸면 '발행됨' 표시가 달라지므로 모달을 다시 그린다. 시작일은 유지. */
    openPublishModal({ staffId: String(el.value || ''), start: val('rb-pub-start') });
  }

  if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
  }

  return {
    todayBlocks: todayBlocks,
    boardCard: boardCard,
    stepExt: stepExt,
    briefSection: briefSection,
    ensureRequestsLoaded: ensureRequestsLoaded,
    ensurePackLoaded: ensurePackLoaded,
    requests: () => st.requests.slice(),
    /* 테스트·디버그용. 화면 코드는 아래를 쓰지 않는다. */
    _state: st,
    _normalizeRequest: normalizeRequest,
    _requestCard: requestCard,
    _onClick: onClick
  };
});
