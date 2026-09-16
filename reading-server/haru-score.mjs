'use strict';
/* 하루브레인 서버 채점 — 회차 답안지(/attempt)의 유일한 채점 자리.
   정답은 KV 의 paperkey·팩에만 있고 기기에는 없다(설계안 §7-1). 그래서 채점은 서버에서만 일어나고,
   결과는 haru:mock 에 쓰되 학생 화면에는 다음 날 카드와 함께 열린다(§4-4).
   순수 로직만 — 저장·인증은 haru-api.mjs 가 한다. 이 파일은 워커 번들에 들어가므로 Node 전용 모듈을 쓰지 않는다. */
import PACE from '../haru/pace.js';
import M from '../haru/mastery.js';
import S from '../haru/strings.js';

export const MOCKS_MAX = 60;          // 학생 한 명의 회차 기록 상한 — 3년 × 시즌 회차라도 이 안이다
export const DIST_BINS = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 101]];   // 백분율 구간 5개 (§5-7)
export const MIN_N_DIST = 30;         // 이보다 적으면 부모 화면이 점을 안 그린다
export const AGG_MIN_STUDENTS = 10;   // 주간 집계 — 앉은 학생이 이보다 적으면 그 주 생략
export const AGG_MIN_CELL = 5;        // 셀 n<5 생략 (재식별 방지)
const KEY_RE = /^[1-5]$/;
export const SKILL_KEYS = ['markImmediate', 'passUsedAndRecovered', 'blank0', 'noBreakGrade'];   // 시험 기술 4항목(§4-4). lag·passes 는 부가 관측

/* 화면 회차(screen-mock 팩) → paperkey 모양의 투영. pace.js 는 sets/n/answer 만 본다. */
export function keyFromPack(pack) {
  const items = (pack.items || []).slice().sort((a, b) => a.no - b.no);
  const sets = {}, seen = {};
  (pack.passages || []).forEach((p) => { sets[p.id] = (p.itemNos || []).slice(); (p.itemNos || []).forEach((n) => { seen[n] = true; }); });
  items.forEach((it) => { if (!seen[it.no]) sets['q' + it.no] = [it.no]; });
  const map = {}, answer = {};
  items.forEach((it) => { map[it.no] = it.atomId; answer[it.no] = it.answerKey; });
  return { id: pack.packId, label: pack.packId, subject: pack.subject, n: items.length, timeLimitSec: pack.timeLimitSec || 2400,
           origin: pack.origin === 'own' ? 'own' : 'own', holder: 'academy', frozen: !!pack.frozen, sets, map, answer, screen: true };
}

/* 답안지 정규화 — 기기가 보낸 값은 전부 상한·형식을 거친다(강사 보드에 그려지는 값의 원천). */
function normEvents(events, n) {
  const out = [];
  (Array.isArray(events) ? events : []).forEach((e) => {
    if (!e || typeof e !== 'object') return;
    const type = ['mark', 'pass', 'change', 'break-grade-attempt'].includes(e.type) ? e.type : null;
    const no = Number(e.no), at = Number(e.at);
    if (!type || !Number.isFinite(at)) return;
    if (type !== 'break-grade-attempt' && !(Number.isInteger(no) && no >= 1 && no <= n)) return;
    const rec = { type, no: type === 'break-grade-attempt' ? 0 : no, at };
    if (typeof e.key === 'string' && KEY_RE.test(e.key)) rec.key = e.key;
    out.push(rec);
  });
  return out.slice(0, 2000).sort((a, b) => a.at - b.at);
}
function marksOf(period, events, n) {
  const marks = {};
  if (period.marks && typeof period.marks === 'object') {
    Object.keys(period.marks).forEach((no) => {
      const k = period.marks[no];
      if (Number.isInteger(+no) && +no >= 1 && +no <= n && typeof k === 'string' && KEY_RE.test(k)) marks[+no] = k;
    });
    return marks;
  }
  events.forEach((e) => { if (e.type === 'mark' && e.key) marks[e.no] = e.key; });
  return marks;
}

/* 한 교시 채점. key 는 paperkey(origin:'own', answer 있음) 또는 keyFromPack 투영. answer 가 없으면 채점하지 않는다(null). */
export function scorePeriod(period, key) {
  const n = key.n || 25;
  const events = normEvents(period.events, n);
  const marks = marksOf(period, events, n);
  const openedAt = Number(period.openedAt), closedAt = Number(period.closedAt);
  const timed = Number.isFinite(openedAt) && Number.isFinite(closedAt) && closedAt >= openedAt;
  const att = timed ? PACE.attribute(events, openedAt, closedAt, key) : { items: [], sets: [] };
  const secOf = {}; att.items.forEach((t) => { secOf[t.no] = t.sec; });
  const perItem = [], wrongNos = [];
  let ok = 0, blank = 0;
  for (let no = 1; no <= n; no++) {
    const picked = marks[no] == null ? null : marks[no];
    const ans = key.answer ? key.answer[no] : null;
    const good = ans == null ? null : (picked != null && picked === String(ans));
    if (picked == null) blank++;                      // 무응답은 오답 번호에 넣지 않는다 — 시험 기술(blank0)의 관측이지 원자의 관측이 아니다
    else if (good === true) ok++;
    else if (good === false) wrongNos.push(no);
    perItem.push({ no, ok: good, picked, atomId: (key.map && key.map[no]) || null, sec: secOf[no] == null ? null : secOf[no] });
  }
  const skills = timed ? PACE.skills(events, key, { breakGradeAttempts: period.breakGradeAttempts || 0 }) : null;
  const sec = timed ? Math.round((closedAt - openedAt) / 1000) : null;
  return {
    subject: key.subject, keyId: key.id, n, ok: key.answer ? ok : null, blank, wrongNos, perItem,
    sets: att.sets.map((s) => ({ setId: s.setId, itemNos: s.itemNos, readSec: s.readSec, perItemSec: s.perItemSec })),
    skills, sec, completed: timed && sec <= (key.timeLimitSec || 2400) + 300,
    itemTimes: att.items.map((t) => ({ no: t.no, sec: t.sec, via: t.via, setId: t.setId })),
  };
}

/* 회차 기록 한 건 — haru:mock 의 mocks[] 원소(설계안 §5-4). 점수·백분율은 담지 않는다: bySubject.ok 는 정답 수이고 화면이 결정한다. */
export function mockRecord(results, meta) {
  const bySubject = {}, blankTotal = { n: 0 }, sets = [], perItem = [], itemTimes = [];
  let sec = 0, completed = true;
  const skills = { markImmediate: true, passUsedAndRecovered: true, blank0: true, noBreakGrade: true };
  results.forEach((r) => {
    bySubject[r.subject] = { n: r.n, ok: r.ok, blank: r.blank, keyId: r.keyId };
    blankTotal.n += r.blank; sec += r.sec || 0; completed = completed && r.completed;
    r.sets.forEach((s) => sets.push({ subject: r.subject, ...s }));
    r.perItem.forEach((it) => perItem.push({ subject: r.subject, ...it }));
    r.itemTimes.forEach((t) => itemTimes.push({ subject: r.subject, ...t }));
    if (r.skills) Object.keys(skills).forEach((k) => { skills[k] = skills[k] && !!r.skills[k]; });
  });
  return { keyId: meta.keyId, kind: meta.kind || 'full', at: meta.at, retake: !!meta.retake, subjects: results.map((r) => r.subject),
           bySubject, blank: blankTotal.n, sec, completed, sets, skills, itemTimes, perItem };
}

/* 회차 백분율 — 분포(haru:dist)에만 쓴다. 학생·부모 화면에는 나가지 않는다. */
export function pctOf(results) {
  let n = 0, ok = 0;
  results.forEach((r) => { if (r.ok != null) { n += r.n; ok += r.ok; } });
  return n ? Math.round(ok / n * 100) : null;
}
export function distUpdate(dist, pct, meta) {
  const d = dist && Array.isArray(dist.bins) ? dist : { keyId: meta.keyId, cohort: meta.cohort, n: 0,
    bins: DIST_BINS.map(([lo, hi]) => ({ lo, hi: Math.min(hi, 100), c: 0 })), composition: meta.composition || '코호트 등록생', itemSource: meta.itemSource || '자작' };
  if (pct == null) return d;
  const i = DIST_BINS.findIndex(([lo, hi]) => pct >= lo && pct < hi);
  if (i >= 0) { d.bins[i].c += 1; d.n += 1; }
  d.updatedAt = meta.at || null;
  return d;
}
/* 부모 화면용 투영 — n<30 이면 mine:null. 내 아이의 점(구간 번호)만 주고 백분율은 주지 않는다. */
export function distView(dist, myPct) {
  if (!dist || dist.n < MIN_N_DIST) return null;
  const mine = myPct == null ? null : DIST_BINS.findIndex(([lo, hi]) => myPct >= lo && myPct < hi);
  return { bins: dist.bins, n: dist.n, composition: dist.composition, itemSource: dist.itemSource, mine: mine == null || mine < 0 ? null : mine };
}

/* 주간 익명 집계(haru:agg:<week>) — 학생 코드 없음. 앉은 학생 10명 미만이면 그 주는 없다, 셀 n<5 는 뺀다. */
export function aggWeek(week, entries) {
  const active = entries.filter((e) => e && e.atoms && Object.keys(e.atoms).some((id) => (e.atoms[id].obs || 0) > 0));
  if (active.length < AGG_MIN_STUDENTS) return null;
  const by = {};
  active.forEach((e) => {
    Object.keys(e.atoms).forEach((id) => {
      const s = e.atoms[id]; if (!s || !(s.obs > 0)) return;
      const c = by[id] = by[id] || { atomId: id, n: 0, ok: 0, nItems: 0 };
      c.n += 1; c.ok += s.ok || 0; c.nItems += s.obs;
    });
  });
  const cells = Object.values(by).filter((c) => c.n >= AGG_MIN_CELL)
    .map((c) => ({ atomId: c.atomId, n: c.n, ok: Math.round(c.ok * 10) / 10, nItems: Math.round(c.nItems * 10) / 10 }));
  return { week, students: active.length, cells };
}

/* 코치 보드 행 — 정렬은 마지막 접속 오래된 순 하나뿐. 점수·정답률·순위·확률 열이 없다(§3-3). */
export function boardRows(list, atoms, core, now) {
  const idx = {}; (atoms || []).forEach((a) => { idx[a.id] = a; });
  const ymd = (t) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
  const today = ymd(now);
  const rows = list.map(({ code, student, state, mocks }) => {
    const st = (state && state.state) || {};
    const days = st.days || {};
    let min7 = 0;
    for (let i = 0; i < 7; i++) { const k = ymd(now - i * 86400e3); if (days[k] && days[k].sat) min7 += days[k].min || 0; }
    const sat = Object.keys(days).filter((d) => days[d].sat).sort();
    const lastSat = sat.length ? sat[sat.length - 1] : null;
    const lastAt = state && state.updatedAt ? state.updatedAt : null;
    const idle = lastSat ? Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(lastSat + 'T00:00:00Z')) / 86400e3) : null;
    let confirmed = 0;
    (core || []).forEach((id) => { const s = (st.atoms || {})[id]; if (s && idx[id] && M.grade(s, idx[id], now) === 'fluent') confirmed++; });
    const env = st.envelope && Array.isArray(st.envelope.items) ? st.envelope.items.map((x) => x.label || x.atomId).slice(0, 2) : [];
    const lm = (mocks && mocks.mocks && mocks.mocks.length) ? mocks.mocks[mocks.mocks.length - 1] : null;
    const lastMock = lm ? { keyId: lm.keyId, at: lm.at, completed: !!lm.completed, blank: lm.blank || 0,
      passes: lm.skills ? SKILL_KEYS.filter((k) => lm.skills[k]).length : null, lag: lm.skills && lm.skills.lag != null ? lm.skills.lag : null, retake: !!lm.retake } : null;
    return { code, name: student ? student.name : '', cls: student ? student.cls || '' : '', cohort: student ? student.cohort || '' : '',
             lastSat, lastAt, min7, confirmed, coreTotal: (core || []).length,
             flag: idle == null ? 'none' : idle >= 3 ? 'idle' + idle : '', envelope: env, lastMock, consent: !!(student && student.consent && student.consent.at) };
  });
  return rows.sort((a, b) => String(a.lastAt || '') < String(b.lastAt || '') ? -1 : 1);
}

/* 좌표 지도 — 강사용 내부값(구멍·흔들림). 학생 화면에는 이 라벨을 쓰지 않는다. */
export function coachMap(state, atoms, core, now) {
  const st = (state && state.state) || {};
  const all = M.mapOf(st.atoms || {}, atoms, now).map((r) => ({ ...r, label: r.label, stateLabel: S.stateLabel(r.grade, 'coach') }));
  const coreSet = new Set(core || []);
  return { core: all.filter((r) => coreSet.has(r.id)), peri: all.filter((r) => !coreSet.has(r.id) && r.obs > 0) };
}
