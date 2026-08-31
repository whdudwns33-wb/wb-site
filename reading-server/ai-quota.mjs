'use strict';
/* WB 워드브레인 — AI 호출 하루 한도 (server.mjs·worker.mjs 공용, 순수 함수)

   AI를 부르는 자리가 셋이다: 연상 만들기 · 문장 짓기 · 대화 미션.
   대화 미션은 학생이 한 마디 할 때마다 부르므로 한 사람이 하루에 수십 번도 부를 수 있다.
   막지 않으면 요금이 열려 있는 셈이다.

   두 겹으로 막는다.
   - 학생 한 명 하루 한도: 한 아이가 통째로 써 버리는 것을 막는다.
   - 학원 전체 하루 한도: 실제 비용 상한이다.

   센 다음에 부르지 않고, 부르기 전에 세어 자리를 잡는다(reserve).
   호출이 실패하면 자리 하나를 손해 보지만, 그 반대(먼저 부르고 나중에 세기)는
   한꺼번에 몰릴 때 한도를 넘겨 버린다. 요금 상한은 넘치는 쪽이 더 나쁘다.

   워커의 KV에는 원자적 증가가 없다. 같은 순간에 들어온 요청 몇 개가 같은 수를 읽어
   한도를 조금 넘길 수 있다. 하루 수백 회 규모에서 몇 회의 오차라 그대로 둔다 —
   정확히 막으려면 Durable Object가 필요한데 이 목적에는 과하다. */

export const QUOTA_DEFAULT = { perStudent: 30, total: 200 };

/* KST로 하루를 가른다 — 지표 화면과 같은 기준 */
export function dayKey(t) {
  const d = new Date(t + 9 * 3600000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/* 환경변수에서 한도를 읽는다. 값이 없거나 이상하면 기본값을 쓴다 —
   오타로 0이 들어가 기능이 통째로 죽는 일은 없어야 한다. */
export function readLimits(env) {
  const n = (v, d) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : d;
  };
  const e = env || {};
  return {
    perStudent: n(e.AI_DAILY_PER_STUDENT, QUOTA_DEFAULT.perStudent),
    total: n(e.AI_DAILY_TOTAL, QUOTA_DEFAULT.total),
  };
}

/* 오늘 것이 아니면 빈 장부로 본다 — 날짜가 바뀌면 저절로 0에서 시작한다 */
export function todayUsage(rec, now) {
  const day = dayKey(now);
  return (rec && rec.day === day) ? { day, total: rec.total || 0, by: rec.by || {} }
    : { day, total: 0, by: {} };
}

/* 자리를 잡는다. 남았으면 {ok:true, usage} — 새 장부를 저장하면 된다.
   막혔으면 {ok:false, reason, used, cap} — 어디서 막혔는지 화면이 말해 줄 수 있다. */
export function reserve(rec, code, now, limits) {
  const lim = limits || QUOTA_DEFAULT;
  const u = todayUsage(rec, now);
  const mine = u.by[code] || 0;
  if (u.total >= lim.total) return { ok: false, reason: 'total', used: u.total, cap: lim.total };
  if (mine >= lim.perStudent) return { ok: false, reason: 'student', used: mine, cap: lim.perStudent };
  return {
    ok: true,
    usage: { day: u.day, total: u.total + 1, by: { ...u.by, [code]: mine + 1 } },
    left: { student: lim.perStudent - mine - 1, total: lim.total - u.total - 1 },
  };
}

/* 관리 화면용 — 오늘 얼마나 썼는지 */
export function usageSummary(rec, now, limits) {
  const lim = limits || QUOTA_DEFAULT;
  const u = todayUsage(rec, now);
  const rows = Object.entries(u.by).map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n);
  return { day: u.day, total: u.total, cap: lim.total, perStudentCap: lim.perStudent, students: rows };
}
