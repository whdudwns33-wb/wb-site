'use strict';
/* WB 내신 — 수업 라이브 세션 순수 로직 (기획서 §15-3).
 *
 * 왜: 관리 웹은 결과 집계용이라 수업 중 강사가 보는 화면이 없다. 누가 어디서 막혔는지
 * 태블릿을 돌아다니며 봐야 하고, 과제 배정은 하루 단위인데 실제 수업은 분 단위로 굴러간다.
 *
 * 설계에서 지키는 것:
 *  - 새 실시간 인프라를 만들지 않는다. 학생 상태는 이미 주기적으로 서버에 올라가므로
 *    강사 화면이 5초 간격으로 읽기만 하면 된다(WebSocket·SSE 없음).
 *  - 강사가 학생 태블릿을 원격 조작하지 않는다. 「지금 이 단계」라는 신호만 서버에 두고
 *    학생 앱이 읽어 스스로 따라간다 — 오작동이 학습을 망치는 구조를 만들지 않는다.
 *  - 정답은 학생 태블릿으로 내려가지 않는다(publicLive 가 answerKey 를 지운다).
 *    TV에 문제를 띄우고 답만 태블릿에서 받는 구조라, 정답이 내려가면 그 자리에서 무너진다.
 *
 * 이 모듈은 순수 함수만 담는다 — 저장·라우팅은 naesin-api.mjs 가 한다.
 */

export const PHASE_KEYS = ['words', 'passage', 'quiz', 'mock', 'free', 'projector'];
export const WHERE_KEYS = ['home', 'words', 'passage', 'quiz', 'progress', 'runner'];
export const LIVE_TTL_MS = 4 * 3600e3;   // 수업이 끝나고 방치된 단계가 다음 날 학생 화면에 남으면 안 된다
export const STALE_MS = 2 * 60e3;        // 태블릿을 덮었거나 앱을 닫았다고 보는 시간
export const IDLE_WARN_SEC = 180;        // 3분 이상 멈춤 = 강사가 가 봐야 할 학생
export const PROJ_ITEMS_MAX = 20;
export const LABEL_MAX = 40;
export const PROMPT_MAX = 300;
export const CHOICE_MAX = 120;
export const CHOICES_MAX = 8;
export const REF_MAX = 80;
export const PHASE_MIN_MS = 60e3, PHASE_MAX_MS = 3 * 3600e3;   // 1분~3시간 — 오타로 30일 타이머가 걸리지 않게

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const int0 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0; };
const strMax = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isoStr = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
const nowMs = (now) => (now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now)));

/* ── 학생 앱이 올리는 「지금 무엇을 하고 있는지」 (계약 L2) ──
   normalizeSummary 안에서 불린다. 학생 기기가 올린 값이 강사 화면에 그려지는 자리라
   열거값·길이·정수를 여기서 강제한다(화면은 다시 이스케이프한다 — 두 겹을 유지). */
export function normalizeLive(v) {
  if (!isObj(v)) return null;
  const where = WHERE_KEYS.includes(v.where) ? v.where : 'home';
  return {
    at: isoStr(v.at),
    where,
    label: strMax(v.label, LABEL_MAX),
    idleSec: Math.min(24 * 3600, int0(v.idleSec)),
    todayDone: Math.min(9999, int0(v.todayDone)),
  };
}

/* ── 단계 (타임박스) ──
   endsAt 은 서버가 분 입력에서 계산한다 — 강사 노트북 시계가 틀려도 학생 화면의 남은
   시간이 어긋나지 않게. 무제한(분 미입력)은 null. */
export function normalizePhase(v, now) {
  if (!isObj(v)) return null;
  const key = PHASE_KEYS.includes(v.key) ? v.key : null;
  if (!key) return null;
  const t = nowMs(now);
  const out = { key, label: strMax(v.label, LABEL_MAX) || key, startedAt: new Date(t).toISOString(), endsAt: null };
  /* minutes 가 오면 그것으로 계산하고, endsAt 이 직접 오면(연장) 범위만 확인해 받는다 */
  const mins = Number(v.minutes);
  if (Number.isFinite(mins) && mins > 0) {
    out.endsAt = new Date(t + Math.min(PHASE_MAX_MS, Math.max(PHASE_MIN_MS, Math.round(mins * 60e3)))).toISOString();
  } else if (isoStr(v.endsAt)) {
    const e = Date.parse(v.endsAt);
    if (e > t) out.endsAt = new Date(Math.min(t + PHASE_MAX_MS, e)).toISOString();
  }
  if (isoStr(v.startedAt)) out.startedAt = v.startedAt;   /* 연장은 시작 시각을 유지한다 */
  const from = Number(v.seqFrom), to = Number(v.seqTo);
  if (Number.isInteger(from) && from > 0) out.seqFrom = from;
  if (Number.isInteger(to) && to > 0) out.seqTo = to;
  if (Array.isArray(v.typeKeys)) {
    const keys = v.typeKeys.filter((k) => typeof k === 'string' && /^[a-z]-[a-z0-9]{1,12}$|^mock$|^g-\d{1,3}$/.test(k)).slice(0, 12);
    if (keys.length) out.typeKeys = keys;
  }
  return out;
}

/* 남은 시간(초). endsAt 이 없으면 null(무제한), 지났으면 0 */
export function remainSec(phase, now) {
  const e = phase && isoStr(phase.endsAt);
  if (!e) return null;
  return Math.max(0, Math.round((Date.parse(e) - nowMs(now)) / 1000));
}

/* ── 투사 모드 ──
   문제는 강사 화면이 만들어 보낸다(학생 앱과 같은 gen.js 를 쓴다). 서버는 모양만 지킨다. */
export function normalizeProjector(v, now) {
  if (!isObj(v)) return null;
  const raw = Array.isArray(v.items) ? v.items.slice(0, PROJ_ITEMS_MAX) : [];
  const items = [];
  raw.forEach((it, i) => {
    if (!isObj(it)) return;
    const prompt = strMax(it.prompt, PROMPT_MAX);
    if (!prompt) return;
    const choices = (Array.isArray(it.choices) ? it.choices : []).slice(0, CHOICES_MAX)
      .map((c, ci) => (isObj(c)
        ? { key: strMax(c.key, 8) || String(ci + 1), text: strMax(c.text, CHOICE_MAX) }
        : { key: String(ci + 1), text: strMax(c, CHOICE_MAX) }))
      .filter((c) => c.text);
    if (choices.length < 2) return;
    const answerKey = strMax(it.answerKey, 8);
    if (!choices.some((c) => c.key === answerKey)) return;   /* 정답이 보기에 없는 문제는 띄우지 않는다 */
    items.push({ ref: strMax(it.ref, REF_MAX) || ('p' + i), prompt, choices, answerKey });
  });
  if (!items.length) return null;
  const idx = Number(v.index);
  return {
    items, index: Number.isInteger(idx) ? Math.min(items.length - 1, Math.max(0, idx)) : 0,
    revealed: !!v.revealed,
    startedAt: isoStr(v.startedAt) || new Date(nowMs(now)).toISOString(),
  };
}

/* 저장된 세션이 아직 살아 있는가 — 4시간 넘게 손대지 않았으면 없는 것으로 본다 */
export function isLive(rec, now) {
  if (!isObj(rec)) return false;
  const u = isoStr(rec.updatedAt);
  if (!u) return false;
  return nowMs(now) - Date.parse(u) < LIVE_TTL_MS;
}

/* ── 학생에게 주는 모양 (계약 L1) ──
   answerKey 를 지운다. 여기가 이 기능의 유일한 보안 지점이다 — 정답이 태블릿에
   내려가면 TV에 문제를 띄우는 의미가 없어진다. 공개(revealed) 뒤에만 정답을 붙인다. */
export function publicLive(rec, now) {
  if (!isLive(rec, now)) return null;
  const phase = isObj(rec.phase) ? rec.phase : null;
  const pj = isObj(rec.projector) ? rec.projector : null;
  const out = { phase: null, projector: null, updatedAt: rec.updatedAt };
  if (phase) out.phase = { ...phase, remainSec: remainSec(phase, now) };
  if (pj) {
    const cur = pj.items[pj.index] || null;
    out.projector = {
      index: pj.index, count: pj.items.length, revealed: !!pj.revealed, startedAt: pj.startedAt,
      item: cur ? {
        ref: cur.ref, prompt: cur.prompt, choices: cur.choices,
        /* 공개 전에는 정답이 응답에 없다 — 학생이 응답을 들여다봐도 답을 알 수 없다 */
        ...(pj.revealed ? { answerKey: cur.answerKey } : {}),
      } : null,
    };
  }
  return out;
}

/* ── 라이브 보드 행 (계약 L2) ──
   overview 가 이미 주는 학생별 summary·lastActive 에 「지금 무엇을 하고 있는지」를 더한다.
   정렬은 정체 오래된 순 — 강사가 먼저 봐야 할 학생이 위로 와야 화면을 볼 이유가 생긴다. */
export function boardRows(rows, now) {
  const t = nowMs(now);
  const out = (Array.isArray(rows) ? rows : []).map((r) => {
    const sum = isObj(r && r.summary) ? r.summary : null;
    const lv = sum && isObj(sum.live) ? sum.live : null;
    const atMs = lv && isoStr(lv.at) ? Date.parse(lv.at) : (isoStr(r && r.lastActive) ? Date.parse(r.lastActive) : NaN);
    const stale = !Number.isFinite(atMs) || (t - atMs) > STALE_MS;
    /* 정체 시간은 학생이 올린 idleSec 에 그 뒤 흐른 시간을 더한다 — 앱을 덮으면 갱신이
       멈추므로 올라온 값만 믿으면 정체가 영원히 그 값에 머문다. */
    const drift = Number.isFinite(atMs) ? Math.max(0, Math.round((t - atMs) / 1000)) : 0;
    const idleSec = lv ? lv.idleSec + drift : (Number.isFinite(atMs) ? drift : null);
    return {
      code: r.code, name: r.name || '', cls: r.cls || '',
      linked: !!r.linked,
      where: lv ? lv.where : null,
      label: lv ? lv.label : '',
      idleSec, todayDone: lv ? lv.todayDone : null,
      stale, lastActive: (r && r.lastActive) || null,
      blankAcc: blankAccOf(sum),
    };
  });
  out.sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? 1 : -1;        /* 앱을 닫은 학생은 아래로 */
    return (b.idleSec == null ? -1 : b.idleSec) - (a.idleSec == null ? -1 : a.idleSec);
  });
  return out;
}

/* 오늘 백지 정확도 — 요약에 단락 백지 진도가 있으면 거기서. 없으면 null(못 잰 것을 0으로 단정하지 않는다) */
export function blankAccOf(sum) {
  const p = sum && isObj(sum.passage) ? sum.passage : null;
  if (p) {
    const tot = Number(p.blankTotal != null ? p.blankTotal : p.paraTotal);
    const got = Number(p.blankDone != null ? p.blankDone : p.paraDone);
    if (Number.isFinite(tot) && tot > 0 && Number.isFinite(got)) return Math.max(0, Math.min(1, got / tot));
  }
  const s = sum && isObj(sum.sentence) ? sum.sentence : null;
  if (s) {
    const tot = Number(s.total), got = Number(s.memorized);
    if (Number.isFinite(tot) && tot > 0 && Number.isFinite(got)) return Math.max(0, Math.min(1, got / tot));
  }
  return null;
}

/* 백지 정확도 하위 N명의 코드 — 값을 못 낸 학생은 넣지 않는다(0점으로 오해할 자리다) */
export function weakest(board, n) {
  return (Array.isArray(board) ? board : [])
    .filter((r) => r.blankAcc != null && r.linked)
    .sort((a, b) => a.blankAcc - b.blankAcc)
    .slice(0, Math.max(0, int0(n) || 3))
    .map((r) => r.code);
}

/* ── 투표 집계 ──
   votes = {[ref]: {[code]: key}}. 강사 화면은 「몇 명이 무엇을 골랐나」와 「누가 틀렸나」를
   같이 봐야 한다 — 분포만으로는 부를 이름이 안 나온다. */
export function tally(votes, projector) {
  const V = isObj(votes) ? votes : {};
  const items = (projector && Array.isArray(projector.items)) ? projector.items : [];
  return items.map((it) => {
    const picks = isObj(V[it.ref]) ? V[it.ref] : {};
    const counts = {};
    it.choices.forEach((c) => { counts[c.key] = 0; });
    let answered = 0, correct = 0;
    for (const [code, key] of Object.entries(picks)) {
      if (typeof key !== 'string' || !(key in counts)) continue;
      counts[key] += 1; answered += 1;
      if (key === it.answerKey) correct += 1;
      void code;
    }
    const wrong = Object.entries(picks)
      .filter(([, key]) => key !== it.answerKey && typeof key === 'string' && key in counts)
      .map(([code]) => code);
    return { ref: it.ref, answered, correct, counts, wrong, picks, answerKey: it.answerKey };
  });
}

/* 학생 응답 하나를 담는다 — 같은 문제를 다시 고르면 마지막 것만 남는다(고쳐 낼 수 있어야 한다) */
export function putVote(votes, ref, code, key) {
  const V = isObj(votes) ? { ...votes } : {};
  const at = isObj(V[ref]) ? { ...V[ref] } : {};
  at[code] = key;
  V[ref] = at;
  return V;
}
