/* 런북 코어 — 제안 A(SOP 콕핏)의 순수 로직. 브라우저(task/index.html)와 Node 테스트가 같이 쓴다.
 *
 * 무엇을 하나:
 *   - 런북 팩(task/runbook-pack.json) 검증 → 직원별 업무지시서(assignments)로 펼치기(expandPack)
 *   - 런북 task 판별·마감 시각(time+window)·지연 판정·하루 집계(summarize)·주간 리포트
 *   - 운영 요청(ops_requests)의 어휘·상태 전이·소요 계산·입력 검증
 *   - 메모 개인정보 패턴 거부(sanitizeNote)
 *
 * 무엇을 하지 않나: 저장·화면·네트워크. Date는 인자로 받는다(테스트 가능하게).
 * 학생은 SF 코드·stable studentId로만 다루고 이름·연락처 필드는 만들지 않는다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBRunbookCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ── 상수 ───────────────────────────────────────────── */

  /* 슬롯 id 형식은 index.html의 runbookFieldsOf()와 같아야 한다 — 다르면 발행은 되는데 필드가 버려진다. */
  const SLOT_ID_RE = /^R-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
  const TITLE_PREFIX_RE = /^\[(R-[A-Z0-9]+(?:-[A-Z0-9]+)*)\]\s*/;
  const PACK_VERSION_RE = /^\d{4}\.\d{2}-\d{1,3}$/;
  const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
  const SF_CODE = /^SF-\d{3}$/;
  const LINK_KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;

  const DEFAULT_WINDOW = 60;   // A.12-4: 기본 60분. 슬롯마다 window로 덮어쓴다.
  const MAX_WINDOW = 600;      // index.html runbookFieldsOf가 600으로 자른다 — 같은 상한.
  const NOTE_MAX = 300;        // 요청 detail·결과 한 줄 상한(A.5)
  const GUIDE_MAX = 2000;
  const REPEATS = ['once', 'daily', 'weekday', 'days'];
  const EVIDENCE = ['check', 'count', 'note'];
  const ISSUE = ['auto', 'manual'];

  const REQ_TYPES = Object.freeze(['account', 'assignment', 'worksheet', 'followup', 'other']);
  const PROGRAMS = Object.freeze(['studyforce', 'classcard', 'metamath', 'nelt', 'exam4you', 'jokbo', 'none']);
  const REQ_STATUS = Object.freeze(['requested', 'accepted', 'in_progress', 'done', 'blocked', 'cancelled']);
  const REQ_ACTIONS = Object.freeze(['accept', 'start', 'done', 'block', 'unblock', 'cancel', 'assign']);
  const VIA = Object.freeze(['app', 'kakao', 'auto']);
  /* 결과 링크는 '만들어 준 것'이 있는 종류에만 붙는다(A.5). 후속·기타는 링크가 아니라 한 줄로 끝난다. */
  const RESULT_URL_TYPES = Object.freeze(['account', 'assignment', 'worksheet']);
  /* 대상이 누구인지가 절차의 핵심인 종류 — 계정은 대상 없이는 만들 수 없다. */
  const TARGET_REQUIRED_TYPES = Object.freeze(['account']);

  const REQ_TYPE_LABEL = Object.freeze({
    account: '계정 발급', assignment: '세트·과제 배정', worksheet: '문제지 제작', followup: '후속 확인', other: '기타'
  });
  const PROGRAM_LABEL = Object.freeze({
    studyforce: '스터디포스', classcard: '클래스카드', metamath: '메타수학', nelt: '넬트',
    exam4you: '이그잼포유', jokbo: '족보닷컴', none: '해당 없음'
  });
  const REQ_STATUS_LABEL = Object.freeze({
    requested: '접수 대기', accepted: '접수', in_progress: '처리중', done: '완료', blocked: '막힘', cancelled: '취소'
  });
  const REQ_ACTION_LABEL = Object.freeze({
    accept: '접수', start: '시작', done: '완료', block: '막힘', unblock: '막힘 해제', cancel: '취소', assign: '담당 지정'
  });
  const VIA_LABEL = Object.freeze({ app: '앱', kakao: '카톡 경유', auto: '자동' });
  const STATUS_ICON = Object.freeze({ todo: '⬜', doing: '🔸', done: '✅', blocked: '🚧' });

  const DISCLAIMER = '절차 지표이며 학습 결과가 아님';

  /* ── 작은 도구 ─────────────────────────────────────── */

  function str(v) { return v == null ? '' : String(v).trim(); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function pad2(n) { return String(n).padStart(2, '0'); }

  function validYmd(s) {
    const v = str(s);
    if (!YMD_RE.test(v)) return false;
    const p = v.split('-').map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
  }

  function dowOf(ymd) {
    const p = str(ymd).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  }

  function addDays(ymd, n) {
    const p = str(ymd).split('-').map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + Number(n || 0)));
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function hmToMin(hm) {
    const v = str(hm);
    if (!HM_RE.test(v)) return -1;
    return Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  }

  function minToHM(min) {
    const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(Number(min) || 0)));
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }

  /** ms → 기기 로컬 'HH:MM'. 정시율은 기기 시각 기준이라는 한계를 A.4가 인정한다. */
  function hmOf(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function median(list) {
    const nums = (Array.isArray(list) ? list : []).map(Number).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  }

  /* ── 개인정보 패턴 ─────────────────────────────────── */

  /* 전화·이메일·주민번호 '패턴'만 거부한다. 실명은 정규식으로 못 가른다(A.5) — 교육·[대조 완료] 리뷰의 몫.
     lookbehind 없이 (^|비숫자)로 경계를 잡는다 — 구형 태블릿 브라우저에서도 같은 판정이 나오게. */
  const PHONE_RE = /(^|[^\d])0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/;
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const RRN_RE = /(^|[^\d])\d{6}[-\s]?[1-4]\d{6}(?!\d)/;
  const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

  function sanitizeNote(text, max) {
    const s = text == null ? '' : String(text);
    const limit = Number(max) > 0 ? Number(max) : NOTE_MAX;
    if (s.length > limit) return { ok: false, reason: 'too_long' };
    if (CONTROL_RE.test(s)) return { ok: false, reason: 'control' };
    if (EMAIL_RE.test(s)) return { ok: false, reason: 'email' };
    if (RRN_RE.test(s)) return { ok: false, reason: 'rrn' };
    if (PHONE_RE.test(s)) return { ok: false, reason: 'phone' };
    return { ok: true, reason: '' };
  }

  const SANITIZE_REASON = Object.freeze({
    too_long: '너무 깁니다', control: '허용되지 않는 문자가 있습니다',
    email: '이메일 주소는 적을 수 없습니다', rrn: '주민등록번호는 적을 수 없습니다', phone: '전화번호는 적을 수 없습니다'
  });

  /** 원장 타임라인·브리핑용 — 학생 식별자(SF 코드)를 가린다. 학생 식별자는 직원 화면에만 산다(A.5). */
  function maskIdentifiers(text) {
    return String(text == null ? '' : text).replace(/\bSF-\d{3}\b/g, 'SF-•••');
  }

  /* ── 팩 검증 ───────────────────────────────────────── */

  function validateSlot(slot, i, linkKeys, linkFor) {
    const errors = [];
    const at = 'slots[' + i + ']';
    if (!isObj(slot)) return [at + ': 객체가 아닙니다'];
    const id = str(slot.slotId);
    if (!SLOT_ID_RE.test(id)) errors.push(at + ': slotId 형식(R-XXXX-YYYY)이 아닙니다');
    const title = str(slot.title);
    if (!title || title.length > 80) errors.push(id + ': title은 1~80자');
    if (str(slot.slotTime) && !HM_RE.test(str(slot.slotTime))) errors.push(id + ': slotTime은 HH:MM');
    if (slot.window != null) {
      const w = Number(slot.window);
      if (!Number.isInteger(w) || w < 0 || w > MAX_WINDOW) errors.push(id + ': window는 0~' + MAX_WINDOW + '분 정수');
    }
    const repeat = str(slot.repeat) || 'weekday';
    if (!REPEATS.includes(repeat)) errors.push(id + ': repeat은 once|daily|weekday|days');
    const days = Array.isArray(slot.days) ? slot.days : [];
    if (repeat === 'days') {
      if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) errors.push(id + ': repeat=days면 days는 0~6 정수 배열');
    }
    if (slot.priority != null && !['normal', 'high'].includes(str(slot.priority))) errors.push(id + ': priority는 normal|high');
    if (slot.carry != null && typeof slot.carry !== 'boolean') errors.push(id + ': carry는 boolean');
    if (slot.evidence != null && !EVIDENCE.includes(str(slot.evidence))) errors.push(id + ': evidence는 check|count|note');
    if (slot.issue != null && !ISSUE.includes(str(slot.issue))) errors.push(id + ': issue는 auto|manual');
    const guide = String(slot.guide == null ? '' : slot.guide);
    if (!guide.trim()) errors.push(id + ': guide가 비었습니다 — 직원이 처음 봐도 할 수 있어야 합니다');
    const g = sanitizeNote(guide, GUIDE_MAX);
    if (!g.ok) errors.push(id + ': guide에 ' + (SANITIZE_REASON[g.reason] || g.reason));
    const steps = Array.isArray(slot.steps) ? slot.steps : [];
    if (!steps.length || steps.length > 12) errors.push(id + ': steps는 1~12개');
    steps.forEach((s, j) => {
      if (!isObj(s)) { errors.push(id + ' steps[' + j + ']: 객체가 아닙니다'); return; }
      if (!str(s.label) || str(s.label).length > 120) errors.push(id + ' steps[' + j + ']: label은 1~120자');
      if (s.ext != null) {
        const ext = str(s.ext);
        if (!LINK_KEY_RE.test(ext)) errors.push(id + ' steps[' + j + ']: ext는 링크 키만');
        else if (linkKeys && !linkKeys.includes(ext)) errors.push(id + ' steps[' + j + ']: ext ' + ext + '가 pack.linkKeys에 없습니다');
        else if (typeof linkFor === 'function' && !linkFor(ext)) errors.push(id + ' steps[' + j + ']: ext ' + ext + '는 WBExternalLinks에 없는 키');
      }
      /* URL을 팩에 직접 적는 실수를 막는다 — 주소는 external-links.js 한 곳에만 있어야 한다. */
      Object.keys(s).forEach(k => {
        if (/https?:\/\//i.test(String(s[k]))) errors.push(id + ' steps[' + j + ']: URL은 팩에 적지 않습니다(링크 키를 쓰세요)');
      });
    });
    if (/https?:\/\//i.test(guide)) errors.push(id + ': guide에 URL을 적지 않습니다(링크 키를 쓰세요)');
    if (slot.count != null) {
      if (!isObj(slot.count) || !str(slot.count.label)) errors.push(id + ': count는 {label, unit}');
    }
    return errors;
  }

  /** pack → {ok, errors}. linkFor를 주면 ext 키가 실제 링크 표에 있는지도 본다. */
  function validatePack(pack, opts) {
    const errors = [];
    const o = isObj(opts) ? opts : {};
    if (!isObj(pack)) return { ok: false, errors: ['팩이 객체가 아닙니다'] };
    if (!PACK_VERSION_RE.test(str(pack.packVersion))) errors.push('packVersion은 YYYY.MM-n 형식');
    const slots = Array.isArray(pack.slots) ? pack.slots : null;
    if (!slots || !slots.length) errors.push('slots가 비었습니다');
    const linkKeys = Array.isArray(pack.linkKeys) ? pack.linkKeys.map(str) : null;
    if (linkKeys) {
      linkKeys.forEach(k => {
        if (!LINK_KEY_RE.test(k)) errors.push('linkKeys: ' + k + ' 형식 오류');
        else if (typeof o.linkFor === 'function' && !o.linkFor(k)) errors.push('linkKeys: ' + k + '는 WBExternalLinks에 없는 키');
      });
    }
    const seen = new Set();
    (slots || []).forEach((slot, i) => {
      validateSlot(slot, i, linkKeys, o.linkFor).forEach(e => errors.push(e));
      const id = isObj(slot) ? str(slot.slotId) : '';
      if (id) {
        if (seen.has(id)) errors.push(id + ': slotId 중복');
        seen.add(id);
      }
    });
    return { ok: !errors.length, errors: errors };
  }

  /* ── 슬롯 ↔ task ───────────────────────────────────── */

  function titleFor(slot) {
    return '[' + str(slot && slot.slotId) + '] ' + str(slot && slot.title);
  }

  function stripSlotPrefix(title) {
    return str(title).replace(TITLE_PREFIX_RE, '');
  }

  /** task → 슬롯 id. 필드가 우선, 없으면 제목 접두 '[R-…]'(Phase 0 인스턴스)로 폴백. */
  function slotIdOf(task) {
    if (!isObj(task)) return '';
    const field = str(task.runbookSlotId);
    if (SLOT_ID_RE.test(field)) return field;
    const m = str(task.title).match(TITLE_PREFIX_RE);
    return m ? m[1] : '';
  }

  function isRunbookTask(task) {
    return !!(isObj(task) && !task.deleted && slotIdOf(task));
  }

  /** Phase 0 인스턴스 승격 — 제목 접두만 있는 task에 붙일 patch. 이미 필드가 있으면 null. */
  function adoptLegacySlotTitle(task) {
    if (!isObj(task) || SLOT_ID_RE.test(str(task.runbookSlotId))) return null;
    const id = slotIdOf(task);
    return id ? { runbookSlotId: id } : null;
  }

  function windowOf(task) {
    const w = Number(isObj(task) ? task.window : NaN);
    return Number.isFinite(w) && w >= 0 ? Math.min(MAX_WINDOW, Math.round(w)) : DEFAULT_WINDOW;
  }

  /** 예정 시각 + 여유(window) → 'HH:MM'. 시각이 없으면 '' — 지연을 따지지 않는 슬롯. */
  function dueLimit(task) {
    const start = hmToMin(isObj(task) ? task.time : '');
    if (start < 0) return '';
    return minToHM(start + windowOf(task));
  }

  /** 완료 시각. index.html의 toggle/syncAuto가 완료 순간에 at을 찍고, updatedAt은 메모 저장에도 바뀐다.
   *  그래서 doneAt → at → updatedAt 순으로 보되 마지막은 근사치다(메모를 나중에 고치면 늦게 보인다). */
  function doneAtOf(check) {
    if (!isObj(check)) return 0;
    return Number(check.doneAt) || Number(check.at) || Number(check.updatedAt) || 0;
  }

  function checkStatus(task, check) {
    if (isObj(check) && check.blocked) return 'blocked';
    if (isObj(check) && check.done) return 'done';
    const steps = Array.isArray(task && task.steps) ? task.steps : [];
    const stepDone = steps.filter(s => check && check.steps && check.steps[s.id]).length;
    if (stepDone > 0 || (isObj(check) && Number(check.count) > 0)) return 'doing';
    return 'todo';
  }

  /** 늦었는가. 완료면 완료 시각이 마감을 넘겼는지, 미완료면 지금이 마감을 넘겼는지.
   *  막힘은 지연이 아니라 막힘으로 센다 — 막힘 신고는 가점이다(A.4). */
  function isLate(task, check, nowHM) {
    const limit = dueLimit(task);
    if (!limit) return false;
    const st = checkStatus(task, check);
    if (st === 'blocked') return false;
    if (st === 'done') {
      const hm = hmOf(doneAtOf(check));
      return !!hm && hm > limit;
    }
    return !!str(nowHM) && str(nowHM) > limit;
  }

  function onTime(task, check) {
    if (checkStatus(task, check) !== 'done') return false;
    const limit = dueLimit(task);
    if (!limit) return true;
    const hm = hmOf(doneAtOf(check));
    return !hm || hm <= limit;
  }

  /* ── 팩 → 지시서 ───────────────────────────────────── */

  /** 지금 살아 있는 런북 task의 슬롯 id 집합 — 중복 발행 방지의 기준.
   *  once는 시작일이 아직 안 지났을 때만 '살아 있다'(분기 슬롯은 분기마다 재발행한다). */
  function activeSlotIds(tasks, date) {
    const out = new Set();
    (Array.isArray(tasks) ? tasks : []).forEach(t => {
      if (!isRunbookTask(t)) return;
      if (t.end && date && str(t.end) < str(date)) return;
      if (t.repeat === 'once' && date && str(t.start) < str(date)) return;
      out.add(slotIdOf(t));
    });
    return Array.from(out);
  }

  function slotDefaults(pack) {
    const d = isObj(pack) && isObj(pack.defaults) ? pack.defaults : {};
    return {
      window: Number.isInteger(d.window) ? d.window : DEFAULT_WINDOW,
      repeat: REPEATS.includes(str(d.repeat)) ? str(d.repeat) : 'weekday',
      priority: str(d.priority) === 'high' ? 'high' : 'normal',
      carry: typeof d.carry === 'boolean' ? d.carry : false,
      evidence: EVIDENCE.includes(str(d.evidence)) ? str(d.evidence) : 'check',
      issue: ISSUE.includes(str(d.issue)) ? str(d.issue) : 'auto'
    };
  }

  function slotOf(pack, slotId) {
    const id = str(slotId);
    return ((isObj(pack) && Array.isArray(pack.slots)) ? pack.slots : []).find(s => isObj(s) && str(s.slotId) === id) || null;
  }

  function slotIssue(slot, defaults) {
    return ISSUE.includes(str(slot.issue)) ? str(slot.issue) : defaults.issue;
  }

  /** 슬롯 하나 → applyAssignments가 받는 assignment 한 장. 필드 이름은 계약 §1을 따른다. */
  function assignmentFor(slot, staffName, start, pack, defaults) {
    const d = defaults || slotDefaults(pack);
    const win = Number.isInteger(slot.window) ? slot.window : d.window;
    const repeat = REPEATS.includes(str(slot.repeat)) ? str(slot.repeat) : d.repeat;
    const count = isObj(slot.count) ? slot.count : null;
    const detail = ['런북 ' + str(pack && pack.packVersion), '창 ' + win + '분']
      .concat(count ? ['수량: ' + str(count.label)] : [])
      .concat(str(slot.agentRef) ? ['판정: 코워크 ' + str(slot.agentRef)] : [])
      .join(' · ');
    return {
      staff: str(staffName),
      title: titleFor(slot),
      detail: detail,
      guide: String(slot.guide == null ? '' : slot.guide),
      steps: (Array.isArray(slot.steps) ? slot.steps : []).map(s => {
        const step = { label: str(s.label) };
        if (str(s.ext)) step.ext = str(s.ext);
        return step;
      }),
      /* target은 0 — 수량은 '몇 개였는가'지 '몇 개 채워야 완료'가 아니다. 수량 입력은 런북 블록의 rb-cnt가 check.count에 쓴다. */
      target: 0,
      unit: count ? str(count.unit) || '건' : '건',
      time: HM_RE.test(str(slot.slotTime)) ? str(slot.slotTime) : '',
      priority: str(slot.priority) === 'high' ? 'high' : d.priority,
      repeat: repeat,
      days: repeat === 'days' && Array.isArray(slot.days) ? slot.days.map(Number) : [],
      start: validYmd(start) ? str(start) : '',
      end: '',
      carry: typeof slot.carry === 'boolean' ? slot.carry : d.carry,
      runbookSlotId: str(slot.slotId),
      runbookPackVersion: str(pack && pack.packVersion),
      window: win
    };
  }

  /**
   * 팩 전체 → {assignments, skipped:[{slotId, reason}]}.
   *   opts.start            발행 시작일(YMD). once 슬롯은 이 날 하루짜리.
   *   opts.existingSlotIds  이미 살아 있는 슬롯 — 건너뛴다(중복 발행 방지).
   *   opts.slotIds          이 목록만 발행. 주면 manual 슬롯도 포함된다(원장이 골랐으니).
   *   opts.includeManual    slotIds 없이 manual까지 전부.
   */
  function expandPack(pack, staffName, opts) {
    const o = isObj(opts) ? opts : {};
    const v = validatePack(pack, { linkFor: o.linkFor });
    if (!v.ok) return { assignments: [], skipped: [], errors: v.errors };
    const name = str(staffName);
    if (!name) return { assignments: [], skipped: [], errors: ['직원 이름이 없습니다'] };
    const existing = new Set((Array.isArray(o.existingSlotIds) ? o.existingSlotIds : []).map(str));
    const only = Array.isArray(o.slotIds) ? new Set(o.slotIds.map(str)) : null;
    const defaults = slotDefaults(pack);
    const assignments = [], skipped = [];
    pack.slots.forEach(slot => {
      const id = str(slot.slotId);
      if (only && !only.has(id)) { skipped.push({ slotId: id, reason: 'not_selected' }); return; }
      if (existing.has(id)) { skipped.push({ slotId: id, reason: 'exists' }); return; }
      if (!only && !o.includeManual && slotIssue(slot, defaults) === 'manual') { skipped.push({ slotId: id, reason: 'manual' }); return; }
      assignments.push(assignmentFor(slot, name, o.start, pack, defaults));
    });
    return { assignments: assignments, skipped: skipped, errors: [] };
  }

  /* ── 하루 집계 ─────────────────────────────────────── */

  /**
   * todayTasks: 이미 '그날 것'으로 걸러진 task 배열(여러 직원 섞여도 됨). 런북 task만 집계한다.
   * getCheck(taskId, date) → check 또는 null.
   */
  function summarize(todayTasks, getCheck, date, nowHM) {
    const get = typeof getCheck === 'function' ? getCheck : () => null;
    const slots = (Array.isArray(todayTasks) ? todayTasks : []).filter(isRunbookTask).map(t => {
      const c = get(t.id, date) || null;
      const status = checkStatus(t, c);
      const steps = Array.isArray(t.steps) ? t.steps : [];
      return {
        taskId: str(t.id),
        staffId: str(t.staffId),
        slotId: slotIdOf(t),
        title: stripSlotPrefix(t.title),
        time: str(t.time),
        dueLimit: dueLimit(t),
        status: status,
        late: isLate(t, c, nowHM),
        onTime: onTime(t, c),
        count: Number(c && c.count) || 0,
        unit: str(t.unit) || '건',
        note: str(c && c.note),
        doneHM: status === 'done' ? hmOf(doneAtOf(c)) : '',
        stepsDone: steps.filter(s => c && c.steps && c.steps[s.id]).length,
        stepsTotal: steps.length,
        carry: t.carry !== false
      };
    }).sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || a.slotId.localeCompare(b.slotId));
    const issued = slots.length;
    const done = slots.filter(s => s.status === 'done').length;
    const onTimeN = slots.filter(s => s.onTime).length;
    const late = slots.filter(s => s.late).length;
    const blocked = slots.filter(s => s.status === 'blocked').length;
    return {
      date: str(date), issued: issued, done: done, onTime: onTimeN, late: late, blocked: blocked,
      doing: slots.filter(s => s.status === 'doing').length,
      todo: slots.filter(s => s.status === 'todo').length,
      completionRate: issued ? Math.round(done / issued * 100) : 0,
      onTimeRate: issued ? Math.round(onTimeN / issued * 100) : 0,
      slots: slots
    };
  }

  /** 이월 — 지난 lookback일 안에 발생했는데 끝나지 않은 런북 task. tasksForDate(ymd)는 호출부가 준다. */
  function carriedSlots(date, tasksForDate, getCheck, lookback) {
    const out = [];
    const days = Number.isInteger(lookback) && lookback > 0 ? lookback : 7;
    for (let i = 1; i <= days; i++) {
      const d = addDays(date, -i);
      (tasksForDate(d) || []).forEach(t => {
        if (!isRunbookTask(t) || t.carry === false) return;
        const st = checkStatus(t, getCheck(t.id, d) || null);
        if (st === 'done') return;
        out.push({ taskId: str(t.id), staffId: str(t.staffId), slotId: slotIdOf(t), date: d, daysAgo: i, status: st });
      });
    }
    return out;
  }

  /* ── 운영 요청 ─────────────────────────────────────── */

  /** 역할별 전이 규칙. 서버(sync/ops-request.js의 TRANSITIONS)와 같은 표여야 한다 — 화면이 보여 준 버튼을
   *  서버가 거부하면 안 되고, 서버가 받는 버튼을 화면이 숨겨도 안 된다. done은 accepted·in_progress·blocked
   *  어디서든 된다(접수만 하고 바로 끝내는 짧은 요청이 대부분이라 start를 강제하지 않는다).
   *  ctx = { role:'admin'|'staff', isOwner, isAssignee }. 반환 {ok, status, reason}. */
  function nextStatus(status, action, ctx) {
    const cur = str(status), act = str(action);
    const c = isObj(ctx) ? ctx : {};
    const admin = c.role === 'admin';
    const handler = admin || !!c.isAssignee;
    const fail = reason => ({ ok: false, status: cur, reason: reason });
    if (!REQ_STATUS.includes(cur)) return fail('unknown_status');
    if (!REQ_ACTIONS.includes(act)) return fail('unknown_action');
    if (cur === 'done' || cur === 'cancelled') return fail('terminal');
    switch (act) {
      case 'accept':
        if (cur !== 'requested') return fail('invalid_transition');
        return handler ? { ok: true, status: 'accepted', reason: '' } : fail('forbidden');
      case 'start':
        if (cur !== 'accepted') return fail('invalid_transition');
        return handler ? { ok: true, status: 'in_progress', reason: '' } : fail('forbidden');
      case 'done':
        if (!['accepted', 'in_progress', 'blocked'].includes(cur)) return fail('invalid_transition');
        return handler ? { ok: true, status: 'done', reason: '' } : fail('forbidden');
      case 'block':
        if (cur === 'blocked') return fail('invalid_transition');
        return handler ? { ok: true, status: 'blocked', reason: '' } : fail('forbidden');
      case 'unblock':
        if (cur !== 'blocked') return fail('invalid_transition');
        return handler ? { ok: true, status: 'in_progress', reason: '' } : fail('forbidden');
      case 'cancel':
        if (cur !== 'requested') return fail('invalid_transition');
        return (admin || c.isOwner) ? { ok: true, status: 'cancelled', reason: '' } : fail('forbidden');
      case 'assign':
        return admin ? { ok: true, status: cur, reason: '' } : fail('forbidden');
      default:
        return fail('unknown_action');
    }
  }

  /** 지금 상태에서 이 사람이 누를 수 있는 버튼 목록. */
  function allowedActions(status, ctx) {
    return REQ_ACTIONS.filter(a => nextStatus(status, a, ctx).ok);
  }

  /** 소요 — 요청자 기준(created→done)이 KPI, 작업 기준(accepted→done)은 참고. 미완료는 null. */
  function leadTime(req) {
    if (!isObj(req) || req.status !== 'done') return null;
    const created = Number(req.createdAt), accepted = Number(req.acceptedAt), done = Number(req.doneAt);
    if (!(done > 0) || !(created > 0)) return null;
    return {
      owner: Math.max(0, done - created),
      work: accepted > 0 ? Math.max(0, done - accepted) : null
    };
  }

  /** neededBy(YMD) 안에 끝났는가 — 완료 시각을 기기 로컬 날짜로 본다. 미완료는 null. */
  function slaMet(req) {
    if (!isObj(req) || req.status !== 'done' || !validYmd(req.neededBy)) return null;
    const done = Number(req.doneAt);
    if (!(done > 0)) return null;
    const d = new Date(done);
    const ymd = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    return ymd <= str(req.neededBy);
  }

  /* 서버(validTargetRef)와 같은 규칙: 'SF-'로 시작하면 반드시 SF-000, 아니면 SAFE_ID. SAFE_ID는 숫자·하이픈을
     허용해 전화번호 꼴도 통과시키므로 개인정보 패턴을 한 번 더 거른다. */
  function targetRefOk(ref) {
    const v = str(ref);
    if (!v) return true;
    if (/^sf-/i.test(v)) return SF_CODE.test(v);
    if (!SAFE_ID.test(v)) return false;
    return sanitizeNote(v, 128).ok;
  }

  /** 요청 폼 입력 → {ok, errors:[{field, reason}], value}. 이름·전화가 들어올 자리를 아예 두지 않는다.
   *  detail은 서버가 1~300자 한 줄을 요구한다(OPS_DETAIL) — 여기서 먼저 막아 왕복을 줄인다. */
  function validateRequest(input) {
    const i = isObj(input) ? input : {};
    const errors = [];
    const value = {
      reqType: str(i.reqType), program: str(i.program) || 'none', targetRef: str(i.targetRef),
      neededBy: str(i.neededBy), detail: String(i.detail == null ? '' : i.detail).replace(/\s+/g, ' ').trim(),
      via: str(i.via) || 'app', assigneeId: str(i.assigneeId)
    };
    if (!REQ_TYPES.includes(value.reqType)) errors.push({ field: 'reqType', reason: '종류를 고르세요' });
    if (!PROGRAMS.includes(value.program)) errors.push({ field: 'program', reason: '프로그램을 고르세요' });
    else if (RESULT_URL_TYPES.includes(value.reqType) && value.program === 'none') errors.push({ field: 'program', reason: '이 종류는 프로그램이 필요합니다' });
    if (!targetRefOk(value.targetRef)) errors.push({ field: 'targetRef', reason: '대상은 SF-000 코드 또는 학생 ID만 — 이름·전화 금지' });
    else if (TARGET_REQUIRED_TYPES.includes(value.reqType) && !value.targetRef) errors.push({ field: 'targetRef', reason: '계정 발급은 대상 코드가 필요합니다' });
    if (!validYmd(value.neededBy)) errors.push({ field: 'neededBy', reason: '필요일을 고르세요' });
    const s = sanitizeNote(value.detail, NOTE_MAX);
    if (!s.ok) errors.push({ field: 'detail', reason: SANITIZE_REASON[s.reason] || s.reason });
    else if (!value.detail) errors.push({ field: 'detail', reason: '요청 내용 한 줄을 적어 주세요' });
    if (!['app', 'kakao'].includes(value.via)) errors.push({ field: 'via', reason: '경로는 앱 또는 카톡' });
    if (value.assigneeId && !SAFE_ID.test(value.assigneeId)) errors.push({ field: 'assigneeId', reason: '담당 id 형식 오류' });
    return { ok: !errors.length, errors: errors, value: value };
  }

  /** 완료·막힘 때 붙는 결과 — 한 줄 + (허용 종류에만) 공식 https 링크. isApproved는 WBExternalLinks.isApprovedLink. */
  function validateResult(input, reqType, isApproved) {
    const i = isObj(input) ? input : {};
    const errors = [];
    const value = { resultNote: String(i.resultNote == null ? '' : i.resultNote).trim(), resultUrl: str(i.resultUrl) };
    const s = sanitizeNote(value.resultNote, NOTE_MAX);
    if (!s.ok) errors.push({ field: 'resultNote', reason: SANITIZE_REASON[s.reason] || s.reason });
    if (value.resultUrl) {
      if (!RESULT_URL_TYPES.includes(str(reqType))) errors.push({ field: 'resultUrl', reason: '이 종류에는 결과 링크를 붙이지 않습니다' });
      else if (typeof isApproved !== 'function' || !isApproved(value.resultUrl)) errors.push({ field: 'resultUrl', reason: '공식 사이트 https 주소만 붙일 수 있습니다' });
    }
    return { ok: !errors.length, errors: errors, value: value };
  }

  /** 요청 카드 정렬 — 필요일 오름차순, 같은 날이면 오래된 요청이 먼저. 끝난 건은 뒤로. */
  function sortRequests(list) {
    const rank = r => (r.status === 'done' || r.status === 'cancelled') ? 1 : 0;
    return (Array.isArray(list) ? list : []).slice().sort((a, b) =>
      rank(a) - rank(b) || str(a.neededBy || '9999').localeCompare(str(b.neededBy || '9999')) ||
      (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  }

  function isOpenRequest(req) {
    return isObj(req) && ['requested', 'accepted', 'in_progress', 'blocked'].includes(str(req.status));
  }

  /* ── 주간 리포트 ───────────────────────────────────── */

  /**
   * weekStart(월요일 YMD)부터 7일. tasksForDate(ymd) → 그날 task 배열(모든 직원), getCheck(taskId, date).
   * requests는 createdAt이 그 주에 드는 것만 센다. 학생 식별자(targetRef·note)는 싣지 않는다 — 테스트가 0건을 단언한다.
   */
  function weeklyReport(weekStart, tasksForDate, getCheck, requests, nowHM) {
    const start = validYmd(weekStart) ? str(weekStart) : '';
    const days = [];
    const bySlot = {};
    let issued = 0, done = 0, onTimeN = 0, late = 0, blocked = 0;
    for (let i = 0; i < 7 && start; i++) {
      const d = addDays(start, i);
      const s = summarize(tasksForDate(d) || [], getCheck, d, nowHM);
      days.push({ date: d, issued: s.issued, done: s.done, onTime: s.onTime, late: s.late, blocked: s.blocked });
      issued += s.issued; done += s.done; onTimeN += s.onTime; late += s.late; blocked += s.blocked;
      s.slots.forEach(sl => {
        const row = bySlot[sl.slotId] || (bySlot[sl.slotId] = { slotId: sl.slotId, title: sl.title, issued: 0, done: 0, onTime: 0, late: 0, blocked: 0 });
        row.issued++;
        if (sl.status === 'done') row.done++;
        if (sl.onTime) row.onTime++;
        if (sl.late) row.late++;
        if (sl.status === 'blocked') row.blocked++;
      });
    }
    const weekEnd = start ? addDays(start, 6) : '';
    const startMs = start ? Date.UTC(...start.split('-').map((n, k) => k === 1 ? Number(n) - 1 : Number(n))) - 9 * 3600 * 1000 : 0;
    const endMs = startMs + 7 * 24 * 3600 * 1000;
    const inWeek = (Array.isArray(requests) ? requests : []).filter(r => {
      const at = Number(r && r.createdAt);
      return start ? (at >= startMs && at < endMs) : true;
    });
    const byType = {};
    REQ_TYPES.forEach(t => { byType[t] = 0; });
    inWeek.forEach(r => { if (byType[str(r.reqType)] != null) byType[str(r.reqType)]++; });
    const doneReqs = inWeek.filter(r => r.status === 'done');
    const owners = doneReqs.map(r => leadTime(r)).filter(Boolean);
    const sla = doneReqs.map(slaMet).filter(v => v !== null);
    const kakao = inWeek.filter(r => r.via === 'kakao').length;
    return {
      disclaimer: DISCLAIMER,
      weekStart: start, weekEnd: weekEnd,
      issued: issued, done: done, onTime: onTimeN, late: late, blocked: blocked,
      completionRate: issued ? Math.round(done / issued * 100) : 0,
      onTimeRate: issued ? Math.round(onTimeN / issued * 100) : 0,
      days: days,
      bySlot: Object.keys(bySlot).sort().map(k => bySlot[k]),
      requests: {
        total: inWeek.length, byType: byType, done: doneReqs.length,
        open: inWeek.filter(isOpenRequest).length,
        blocked: inWeek.filter(r => r.status === 'blocked').length,
        kakao: kakao, kakaoRate: inWeek.length ? Math.round(kakao / inWeek.length * 100) : 0,
        leadOwnerMedianMs: median(owners.map(l => l.owner)),
        leadWorkMedianMs: median(owners.map(l => l.work).filter(v => v !== null)),
        slaMet: sla.filter(Boolean).length, slaTotal: sla.length,
        slaRate: sla.length ? Math.round(sla.filter(Boolean).length / sla.length * 100) : 0
      }
    };
  }

  function fmtDuration(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
    const h = Number(ms) / 3600000;
    if (h < 1) return Math.round(Number(ms) / 60000) + '분';
    if (h < 48) return (Math.round(h * 10) / 10) + '시간';
    return (Math.round(h / 24 * 10) / 10) + '일';
  }

  /** 리포트 → 카톡·문서에 붙일 텍스트. 첫 줄은 고정 문구(A.4). */
  function weeklyReportText(report) {
    const r = isObj(report) ? report : weeklyReport('', () => [], () => null, []);
    const q = r.requests || {};
    const lines = [
      '📋 주간 절차 리포트 ' + r.weekStart + ' ~ ' + r.weekEnd,
      '※ ' + DISCLAIMER,
      '─────────',
      '런북 발행 ' + r.issued + ' · 완료 ' + r.done + ' (' + r.completionRate + '%) · 정시 ' + r.onTime + ' (' + r.onTimeRate + '%) · 지연 ' + r.late + ' · 막힘 ' + r.blocked
    ];
    (r.bySlot || []).forEach(s => {
      lines.push('· ' + s.slotId + ' ' + s.title + ' — ' + s.done + '/' + s.issued + ' 완료' +
        (s.late ? ' · 지연 ' + s.late : '') + (s.blocked ? ' · 막힘 ' + s.blocked : ''));
    });
    lines.push('─────────');
    lines.push('요청 ' + (q.total || 0) + '건 — 완료 ' + (q.done || 0) + ' · 미처리 ' + (q.open || 0) + ' · 막힘 ' + (q.blocked || 0) +
      ' · 카톡 경유 ' + (q.kakaoRate || 0) + '%');
    lines.push('종류별: ' + REQ_TYPES.map(t => REQ_TYPE_LABEL[t] + ' ' + ((q.byType || {})[t] || 0)).join(' · '));
    lines.push('소요 중위 — 요청자 기준 ' + fmtDuration(q.leadOwnerMedianMs) + ' · 작업 기준 ' + fmtDuration(q.leadWorkMedianMs) +
      ' · 필요일 준수 ' + (q.slaMet || 0) + '/' + (q.slaTotal || 0) + ' (' + (q.slaRate || 0) + '%)');
    return lines.join('\n');
  }

  return {
    SLOT_ID_RE: SLOT_ID_RE, DEFAULT_WINDOW: DEFAULT_WINDOW, MAX_WINDOW: MAX_WINDOW, NOTE_MAX: NOTE_MAX,
    REQ_TYPES: REQ_TYPES, PROGRAMS: PROGRAMS, REQ_STATUS: REQ_STATUS, REQ_ACTIONS: REQ_ACTIONS, VIA: VIA,
    RESULT_URL_TYPES: RESULT_URL_TYPES, TARGET_REQUIRED_TYPES: TARGET_REQUIRED_TYPES,
    REQ_TYPE_LABEL: REQ_TYPE_LABEL, PROGRAM_LABEL: PROGRAM_LABEL, REQ_STATUS_LABEL: REQ_STATUS_LABEL,
    REQ_ACTION_LABEL: REQ_ACTION_LABEL, VIA_LABEL: VIA_LABEL, STATUS_ICON: STATUS_ICON,
    SANITIZE_REASON: SANITIZE_REASON, DISCLAIMER: DISCLAIMER,
    validYmd: validYmd, dowOf: dowOf, addDays: addDays, hmToMin: hmToMin, minToHM: minToHM, hmOf: hmOf, median: median,
    sanitizeNote: sanitizeNote, maskIdentifiers: maskIdentifiers,
    validatePack: validatePack, titleFor: titleFor, stripSlotPrefix: stripSlotPrefix, slotIdOf: slotIdOf,
    isRunbookTask: isRunbookTask, adoptLegacySlotTitle: adoptLegacySlotTitle, slotOf: slotOf,
    windowOf: windowOf, dueLimit: dueLimit, doneAtOf: doneAtOf, checkStatus: checkStatus, isLate: isLate, onTime: onTime,
    activeSlotIds: activeSlotIds, expandPack: expandPack,
    summarize: summarize, carriedSlots: carriedSlots,
    nextStatus: nextStatus, allowedActions: allowedActions, leadTime: leadTime, slaMet: slaMet,
    validateRequest: validateRequest, validateResult: validateResult, sortRequests: sortRequests, isOpenRequest: isOpenRequest,
    weeklyReport: weeklyReport, weeklyReportText: weeklyReportText, fmtDuration: fmtDuration
  };
});
