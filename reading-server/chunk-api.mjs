'use strict';
/* WB 청크브레인 — /api/chunk/* 라우트 (server.mjs·worker.mjs 공용)
   격리 원칙(워드브레인·국어브레인 선례): 라우트는 /api/chunk/* 아래, 데이터는 청크 전용 저장소
   (워커: chunk: 접두 KV 키, 로컬: db.chunk)만 쓴다. 인증은 호스트의 토큰 검증 결과(who)를 그대로 받는다.

   콘텐츠(지문·카드)는 자체 창작이라 정적 자산(chunk/passages.js)으로 나간다 — 서버가 나르는 것은 학생 기록뿐이다.
   응답 계약(CLAUDE.md 절대 규칙 4): /state → {state, updatedAt}.
   summary 는 관리 화면용 작은 요약 — 학생 기기가 올린 값이라 서버가 화이트리스트로 모양을 강제하고, 화면은 다시 이스케이프한다. */

const STATE_MAX_BYTES = 262_144;   // 학생 기록 1건 최대 (256KB) — log 400건 + items 로도 충분히 남는다
const SUMMARY_MAX_BYTES = 2_048;
const BANDS = ['K', 'E1', 'E2', 'E3', 'M', 'H'];
const nowIso = () => new Date().toISOString();
const size = (o) => JSON.stringify(o).length;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const int0 = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1_000_000, Math.round(Number(v)))) : 0);
const pctOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(100, Math.round(Number(v)))));

/* 학생 기기가 올린 요약을 모양만 강제한다 — 뜻은 해석하지 않는다(하루브레인 normalizeSummary 와 같은 원칙) */
export function normalizeChunkSummary(sum) {
  if (!isObj(sum)) return null;
  return {
    band: BANDS.includes(sum.band) ? sum.band : null,
    attempts: int0(sum.attempts), practiced: int0(sum.practiced), graduated: int0(sum.graduated),
    avg: pctOrNull(sum.avg), recentAvg: pctOrNull(sum.recentAvg), qRate: pctOrNull(sum.qRate),
    wpmRecent: sum.wpmRecent == null ? null : int0(sum.wpmRecent),
    streak: int0(sum.streak), lessonsDone: int0(sum.lessonsDone),
    lastAt: Number.isFinite(Number(sum.lastAt)) && Number(sum.lastAt) > 0 ? Math.round(Number(sum.lastAt)) : null,
  };
}

/* 관리 overview 한 줄 — 학생 명단(students)과 요약을 합친다 */
export function chunkOverviewRow(code, stu, rec) {
  const s = rec && rec.summary ? rec.summary : null;
  return {
    code, name: stu ? stu.name || '' : '', cls: stu ? stu.cls || '' : '',
    band: s ? s.band : null, attempts: s ? s.attempts : 0, practiced: s ? s.practiced : 0, graduated: s ? s.graduated : 0,
    avg: s ? s.avg : null, recentAvg: s ? s.recentAvg : null, qRate: s ? s.qRate : null, wpmRecent: s ? s.wpmRecent : null,
    streak: s ? s.streak : 0, lessonsDone: s ? s.lessonsDone : 0, lastAt: s ? s.lastAt : null, updatedAt: rec ? rec.updatedAt || null : null,
  };
}

export async function handleChunk({ path: p, method, who, getBody, store }) {
  const j = (status, body) => ({ status, body });
  if (!who) return j(401, { error: '로그인이 필요합니다.' });
  const body = async () => { try { return await getBody(); } catch (e) { return null; } };

  if (p === '/api/chunk/state' && method === 'GET' && !who.admin) {
    const rec = await store.getState(who.code);
    return j(200, { state: rec ? rec.state : null, updatedAt: rec ? rec.updatedAt : null });
  }
  if (p === '/api/chunk/state' && method === 'PUT' && !who.admin) {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    if (!isObj(b.state)) return j(400, { error: 'state 필요' });
    const rec = { state: b.state, updatedAt: nowIso() };
    if (size(rec) > STATE_MAX_BYTES) return j(413, { error: '기록이 너무 커서 저장할 수 없어요. 선생님께 알려 주세요.' });
    await store.putState(who.code, rec);
    /* 요약은 같은 요청에서 별도 키로 — 관리 화면이 state 전체를 읽지 않게 한다 */
    const sum = normalizeChunkSummary(b.summary);
    if (sum) {
      const srec = { summary: sum, updatedAt: rec.updatedAt };
      if (size(srec) <= SUMMARY_MAX_BYTES) await store.putSummary(who.code, srec);
    }
    return j(200, { ok: true, updatedAt: rec.updatedAt });
  }

  if (p.startsWith('/api/chunk/admin/')) {
    if (!who.admin) return j(403, { error: '관리자만 쓸 수 있어요.' });
    if (p === '/api/chunk/admin/overview' && method === 'GET') {
      const codes = await store.listSummaryCodes();
      const rows = [];
      for (const c of codes) {
        const stu = await store.getStudent(c);
        if (!stu) continue;                         /* 퇴원 등으로 명단에서 빠진 학생은 내보내지 않는다 */
        rows.push(chunkOverviewRow(c, stu, await store.getSummary(c)));
      }
      rows.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
      return j(200, { rows, updatedAt: nowIso() });
    }
    const m = p.match(/^\/api\/chunk\/admin\/student\/([A-Za-z0-9-]{3,20})$/);
    if (m && method === 'GET') {
      const rec = await store.getState(m[1]);
      if (!rec) return j(404, { error: '기록 없음' });
      return j(200, { state: rec.state, updatedAt: rec.updatedAt });
    }
    return j(404, { error: 'unknown api' });
  }
  return j(404, { error: 'unknown api' });
}

/* 퇴원·파기 — 이 학생의 청크 기록 키 전부 */
export async function dropStudentChunk(store, code) {
  if (store.deleteState) await store.deleteState(code);
  if (store.deleteSummary) await store.deleteSummary(code);
}
