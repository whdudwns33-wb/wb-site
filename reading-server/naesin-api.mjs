'use strict';
/* WB 내신 — /api/naesin/* 라우트 (server.mjs·worker.mjs 공용, vocab-api.mjs 선례)
   격리 원칙: 라우트는 /api/naesin/* 아래, 데이터는 내신 전용 저장소
   (워커: naesin: 접두 KV 키, 로컬: db.naesin)만 쓴다.
   인증은 호스트(진로독서)의 토큰 검증 결과(who)를 그대로 받는다 — 학생은 연동 한 번으로 세 앱을 쓴다.

   기획서 §9.3: 팩(구매 콘텐츠)은 KV에만 존재한다 — 정적 자산·git 어디에도 없다.
   기획서 §10: 인증 없이는 콘텐츠를 절대 반환하지 않는다. 이 모듈은 who가 없으면
   무조건 401로 끝난다. Cache-Control: no-store 는 호스트의 json() 헬퍼가 모든
   /api/* 응답에 붙인다(§10-3) — 여기서 따로 붙일 헤더가 없다. */

const STATE_MAX_BYTES = 262_144;    // 학생 학습 기록 1건 최대 크기 (256KB, UTF-8 바이트)
const PACK_MAX_BYTES = 4_194_304;   // 팩 1건 최대 크기 (4MB) — 단어 77·문장 25·문항·해설이 다 들어간다
const PACK_ID_RE = /^[A-Za-z0-9-]{3,60}$/;
const CODE_RE = /^[A-Za-z0-9-]{3,20}$/;          // 학생 코드 — 호스트 등록 규칙과 동일
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXAM_PACKS_MAX = 20;          // 한 시험 범위에 담는 팩 수 — 한 학기 시험이 이걸 넘지 않는다
const WORD_DEADLINE_MIN = 3, WORD_DEADLINE_MAX = 30;   // 단어 초회 도달 마감(D-n) 허용 범위, 기본 7은 클라이언트가 안다
const TASK_TYPES_MAX = 30;          // 과제 한 건의 학습 유형 수 — 고정 키 15개 + 문법 패턴 키 몇 개면 충분하다

/* 호스트가 몸통을 파싱하기 전에 content-length 로 끊는 상한 — 저장 상한보다 조금 크다(JSON 래핑 여유).
   워커는 req.json()이 몸통을 다 읽고서야 크기를 아는데, 그 전에 끊어야 메모리도 시간도 안 쓴다. */
export const BODY_LIMIT_PACK = 4_718_592;   // 4.5MB — /admin/pack
export const BODY_LIMIT_STATE = 307_200;    // 300KB — /state 를 비롯한 나머지 전부
export const naesinBodyLimit = (p) => (p === '/api/naesin/admin/pack' ? BODY_LIMIT_PACK : BODY_LIMIT_STATE);

/* 과제 학습 유형 키 — 학생 앱 quizTypes()·관리 웹 TYPE_LIST 와 같은 목록(계약 0.4).
   세 곳이 어긋나면 강사가 고른 유형이 학생 화면에서 조용히 빠진다. 여기서 모르는 키는 400으로 돌려
   보내 등록 단계에서 드러나게 한다. 문법 개념은 팩의 패턴 번호별 동적 키(g-<n>)라 정규식으로 받는다. */
export const TASK_TYPE_KEYS = ['w-e2k', 'w-k2e', 'w-spell', 'w-cloze', 'w-def', 'w-poly', 'w-syn',
  's-gram', 's-verb', 's-order', 's-kw', 'i-mcq', 'i-multi', 'mock', 'g-concept'];
export const TASK_TYPE_KEY_RE = /^g-\d{1,3}$/;
export const isTaskTypeKey = (k) => TASK_TYPE_KEYS.includes(k) || TASK_TYPE_KEY_RE.test(k);

/* 'default' 는 반 공통 시험 배정의 scope 키다(naesin:exam:default). 이 코드로 학생을 만들면
   그 학생의 개별 배정과 반 공통 배정이 한 키를 두고 싸운다 — 호스트의 학생 등록이 여기로 묻는다. */
export const isReservedCode = (c) => String(c || '').trim().toLowerCase() === 'default';
/* 명단 붙여넣기(parseRoster) 결과에서 예약어 코드 줄만 오류로 돌린다 — 두 호스트의 bulk 등록이 같은 규칙을 쓴다 */
export function dropReservedRows({ rows, errors }) {
  const bad = (rows || []).filter((r) => isReservedCode(r.code));
  if (!bad.length) return { rows: rows || [], errors: errors || [] };
  return {
    rows: rows.filter((r) => !isReservedCode(r.code)),
    errors: (errors || []).concat(bad.map((r) => r.name + ': 코드 ' + r.code + ' 는 예약어라 쓸 수 없습니다 (내신 반 공통 배정 키)')),
  };
}

const nowIso = () => new Date().toISOString();
/* 크기 상한은 UTF-8 바이트로 잰다 — JSON.stringify().length 는 글자 수라 한글 기록이 실제보다 1/3로 잡혔다. */
const byteLen = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/* 날짜는 모양(YYYY-MM-DD)만 보지 않고 실제 달력에 있는 날인지 본다 — 2026-13-45 가 시험일로 저장되면
   학생 앱의 D-day 계산이 NaN 으로 무너진다. Date.UTC 로 만든 뒤 되읽어 같은 날이어야 통과. */
export function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/* 오늘(KST) — 시험 만료 판정의 기준. 워커는 UTC 로 돌아서 자정 전후 9시간이 어긋난다. */
export const todayKst = (now) => new Date((now == null ? Date.now() : +now) + 9 * 3600e3).toISOString().slice(0, 10);

/* ── 학생 상태 요약 정규화 (계약 0.1) ──
   summary 는 학생 앱이 만들어 보내고 관리 웹이 그대로 그린다. 서버가 뜻을 해석하지는 않되
   모양은 강제한다 — 화이트리스트 밖 키는 버리고, 숫자는 정수로, 문자열은 형식·길이를 자른다.
   한 학생 기기에서 보낸 값이 강사 화면에 HTML 로 꽂히는 길(저장형 XSS)을 여기서 끊는다.
   저장(PUT /state)과 출력(overview) 양쪽에 건다 — 옛 저장본도 정규화된 모양으로만 나간다. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const SUMMARY_TITLE_MAX = 80;
const int0 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0; };
const strMax = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const isoStr = (v) => (typeof v === 'string' && ISO_RE.test(v) ? v : '');
const dateStr = (v) => (typeof v === 'string' && DATE_RE.test(v) ? v : '');

export function normalizeSummary(sum) {
  if (!isObj(sum)) return null;
  const w = isObj(sum.word) ? sum.word : {};
  const s = isObj(sum.sentence) ? sum.sentence : {};
  const bs = isObj(s.byStage) ? s.byStage : {};
  const t = isObj(sum.task) ? sum.task : null;
  return {
    packId: typeof sum.packId === 'string' && PACK_ID_RE.test(sum.packId) ? sum.packId : '',
    word: { total: int0(w.total), reached: int0(w.reached), stable: int0(w.stable), risky: int0(w.risky), needsSpellCheck: int0(w.needsSpellCheck) },
    sentence: {
      total: int0(s.total), interpreted: int0(s.interpreted), memorized: int0(s.memorized),
      byStage: { 1: int0(bs[1]), 2: int0(bs[2]), 3: int0(bs[3]), 4: int0(bs[4]), 5: int0(bs[5]), 6: int0(bs[6]) },
    },
    /* taskAt 은 관리 웹이 과제의 updatedAt 과 문자열 그대로 비교한다 — 형식만 확인하고 값은 손대지 않는다 */
    task: t ? { date: dateStr(t.date), taskAt: isoStr(t.taskAt), title: strMax(t.title, SUMMARY_TITLE_MAX), correct: int0(t.correct), total: int0(t.total) } : null,
    updatedAt: isoStr(sum.updatedAt),
  };
}

/* 성취도 대시보드 한 줄 (관리 overview용).
   state 구조는 클라이언트 소관이다 — 단어 도달/안정화 수·문장 단계 분포·마지막 학습
   시각 같은 요약은 클라이언트가 state.summary 에 만들어 두고, 서버는 그것을 정규화만 해서
   내보낸다. 서버가 state 속을 해석하기 시작하면 클라이언트 구조가 바뀔 때마다
   여기가 같이 깨진다(vocab의 vocabSummary가 그 비용을 치르고 있다). */
export function naesinSummary(code, stu, stateRec) {
  const row = {
    code,
    name: (stu && stu.name) || '',
    cls: (stu && stu.cls) || '',
    linked: !!stateRec,
    lastActive: stateRec ? stateRec.updatedAt : null,
  };
  const S = stateRec && stateRec.state;
  const sum = normalizeSummary(S && S.summary);
  if (sum) row.summary = sum;
  return row;
}

/* ── 학생의 유효 시험 (계약 0.2) ──
   개별 배정(scope=학생 코드)이 있고 만료되지 않았으면 그것, 아니면 반 공통(default), 아니면 빈 값.
   만료 = examDate < 오늘(KST). 전에는 개별 배정이 영구히 default 를 이겨서, 지난 학기에
   한 번 따로 잡아 준 학생은 반 전체의 새 시험을 영영 못 받았다.
   반 공통은 지난 날짜여도 그대로 준다 — 학생 앱이 '시험 종료 · 자율 학습'으로 보여 준다.
   팩 서빙 제한(GET /pack)도 같은 해석을 써야 화면과 서버가 같은 교재를 가리킨다. */
export async function resolveExam(store, code, now) {
  const today = todayKst(now);
  const live = (rec) => isObj(rec) && !(typeof rec.examDate === 'string' && rec.examDate < today);
  if (typeof code === 'string' && CODE_RE.test(code)) {
    const mine = await store.getExam(code);
    if (live(mine)) return { exam: mine, scope: 'student' };
  }
  const def = await store.getExam('default');
  if (isObj(def)) return { exam: def, scope: 'default' };
  return { exam: {}, scope: null };
}

/* 시험 배정 목록 한 줄 — 관리 웹의 「현재 배정 현황」이 그린다.
   expired·name 은 계약 밖의 편의 필드(관리 웹이 만료 표시·이름 표시에 쓴다). */
function examRow(scope, rec, stu, today) {
  const row = { scope, examDate: rec.examDate || '', packIds: Array.isArray(rec.packIds) ? rec.packIds : [] };
  if (rec.wordDeadlineDays != null) row.wordDeadlineDays = rec.wordDeadlineDays;
  row.updatedAt = rec.updatedAt || null;
  row.expired = typeof rec.examDate === 'string' && rec.examDate < today;
  row.name = scope === 'default' ? '' : ((stu && stu.name) || '');
  return row;
}

/* 이 팩을 참조하는 배정 scope 들 — 팩 삭제 전 확인용 */
async function scopesUsingPack(store, id) {
  const out = [];
  for (const scope of (await store.listExamScopes()) || []) {
    const rec = await store.getExam(scope);
    if (rec && Array.isArray(rec.packIds) && rec.packIds.includes(id)) out.push(scope);
  }
  return out;
}

/* ── 라우터 ──
   ctx = {
     path, method, who,                 // who: {code, admin} | null — 호스트가 검증한 토큰
     query,                             // URLSearchParams (GET ?id= 용)
     getBody: async () => object,       // 호스트가 JSON을 파싱해 준다 — 실패는 여기서 400으로,
                                        //   호스트가 크기 초과를 e.status=413 으로 던지면 413으로
     now,                               // (선택) 시각 — 테스트가 만료 판정을 고정할 때
     store: {                           // 내신 전용 저장소 어댑터 (전부 async 허용)
       getPack(id), putPack(id, rec), deletePack(id),
       getPackIds(), putPackIds(ids),   // naesin:packs — 저장된 팩 id 배열
       getState(code), putState(code, rec), listStateCodes(),
       getExam(scope), putExam(scope, rec), deleteExam(scope), listExamScopes(),   // scope: 'default' | 학생코드
       getTask(scope), putTask(scope, rec),   // 수업 과제 — 현재는 'default'만 사용
       getStudent(code),                // 호스트 학생 명부 (읽기만)
     },
   }
   반환: { status, body } — /api/naesin/* 이 아닌 경로는 호출 전에 호스트가 거른다. */
const TOO_LARGE = Symbol('too-large');

export async function handleNaesin(ctx) {
  const { path: p, method, who, store } = ctx;
  const j = (status, body) => ({ status, body });
  if (!who) return j(401, { error: '로그인이 필요합니다.' });

  /* 저장 라우트는 몸통이 JSON이 아니면 400으로 끝낸다 — 저장 전 파싱 검증(기획 요구).
     호스트마다 파싱 실패의 모양이 다르다(로컬은 reject, 워커는 throw) — 여기서 통일한다.
     로컬 호스트는 스트림 상한 초과를 status 413 인 오류로 알린다 — 그건 400이 아니라 413이다. */
  const body = async () => {
    try { return await ctx.getBody(); } catch (e) { return e && e.status === 413 ? TOO_LARGE : null; }
  };
  const badBody = (b) => (b === TOO_LARGE ? j(413, { error: '요청이 너무 커서 받을 수 없어요.' })
    : (!b ? j(400, { error: '올바른 JSON이 아니에요.' }) : null));

  /* ── 학생 (관리자 토큰도 통과) ── */

  /* 팩 서빙 — 콘텐츠는 KV에만 있고(§9.3) 인증 없이는 아무것도 나가지 않는다(§10).
     학생은 자기 유효 시험(resolveExam)의 packIds 에 든 팩만 받는다 — 연동 학생 하나가 id 를
     바꿔 가며 학원이 산 팩 전부를 내려받는 길을 막는다(계약 0.3). 존재 여부보다 배정을 먼저
     보는 이유도 같다: 배정 안 된 팩은 있는지 없는지도 알려 주지 않는다.
     관리자는 제한 없음 — 강사 검수 화면이 방금 올린 팩을 같은 라우트로 확인한다. */
  if (p === '/api/naesin/pack' && method === 'GET') {
    const id = String((ctx.query && ctx.query.get('id')) || '').trim();
    if (!PACK_ID_RE.test(id)) return j(400, { error: '팩 id가 필요해요.' });
    if (!who.admin) {
      const { exam } = await resolveExam(store, who.code, ctx.now);
      const allowed = Array.isArray(exam.packIds) ? exam.packIds : [];
      if (!allowed.includes(id)) return j(403, { error: '배정되지 않은 교재예요.' });
    }
    const rec = await store.getPack(id);
    if (!rec) return j(404, { error: '팩을 찾을 수 없어요.' });
    return j(200, { pack: rec.pack, updatedAt: rec.updatedAt || null });
  }

  if (p === '/api/naesin/state' && method === 'GET' && !who.admin) {
    const rec = await store.getState(who.code);
    return j(200, { state: rec ? rec.state : {}, updatedAt: rec ? rec.updatedAt : null });
  }
  if (p === '/api/naesin/state' && method === 'PUT' && !who.admin) {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    const state = b.state;
    if (!isObj(state)) return j(400, { error: 'state 필요' });
    /* 요약은 저장 시점에 정규화해 둔다 — 읽는 쪽(overview)도 한 번 더 거르지만,
       저장본부터 깨끗해야 백업·다른 소비자도 안전하다. */
    if (state.summary !== undefined) {
      const ns = normalizeSummary(state.summary);
      if (ns) state.summary = ns; else delete state.summary;
    }
    const rec = { state, updatedAt: nowIso() };
    if (byteLen(rec) > STATE_MAX_BYTES) return j(413, { error: '기록이 너무 커서 저장할 수 없어요.' });
    await store.putState(who.code, rec);
    return j(200, { ok: true, updatedAt: rec.updatedAt });
  }

  /* 시험 설정 — 내 것(만료 전) → 반 공통(default) → 빈 값 (resolveExam).
     빈 값도 200이다 — 시험이 아직 안 잡힌 것은 오류가 아니라 평시다. */
  if (p === '/api/naesin/exam' && method === 'GET' && !who.admin) {
    return j(200, await resolveExam(store, who.code, ctx.now));
  }

  /* 오늘 수업 과제 — 강사가 배정한 반 공통 과제(수업 모드). 없으면 빈 값(평시). */
  if (p === '/api/naesin/task' && method === 'GET' && !who.admin) {
    const rec = await store.getTask('default');
    return j(200, { task: rec || {}, scope: rec ? 'default' : null });
  }

  /* ── 관리자 (원장·강사 — 관리 PIN 토큰) ── */
  if (!who.admin) return j(403, { error: '권한이 없습니다.' });

  /* 수업 과제 등록·조회 — 수업시간에 전원이 같은 범위를 진행하게 하는 배정 */
  if (p === '/api/naesin/admin/task' && method === 'GET') {
    return j(200, { task: (await store.getTask('default')) || {} });
  }
  if (p === '/api/naesin/admin/task' && method === 'POST') {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    const date = String(b.date || '').trim();
    if (!isValidDate(date)) return j(400, { error: 'date는 실제 날짜(YYYY-MM-DD)' });
    const title = String(b.title || '').trim().slice(0, 80);
    if (!title) return j(400, { error: 'title 필요' });
    const typeKeys = Array.isArray(b.typeKeys)
      ? [...new Set(b.typeKeys.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, TASK_TYPES_MAX) : [];
    if (!typeKeys.length) return j(400, { error: 'typeKeys 필요 (학습 유형 1개 이상)' });
    const unknown = typeKeys.find((k) => !isTaskTypeKey(k));
    if (unknown) return j(400, { error: '알 수 없는 학습 유형: ' + unknown.slice(0, 30) });
    const rec = { date, title, typeKeys, updatedAt: nowIso() };
    if (b.seqFrom != null || b.seqTo != null) {
      const f = Number(b.seqFrom), to = Number(b.seqTo);
      if (!Number.isInteger(f) || !Number.isInteger(to) || f < 1 || to < f) return j(400, { error: '문장 범위가 올바르지 않아요.' });
      rec.seqFrom = f; rec.seqTo = to;
    }
    await store.putTask('default', rec);
    return j(200, { ok: true, task: rec });
  }

  /* 팩 업로드 — 업로드 파이프라인의 종착지(§7). 검증은 최소로:
     구조 검증은 업로드 도구·검수 화면 몫이고, 서버는 id 일치와 크기만 지킨다.
     같은 id 재업로드는 덮어쓴다(검수 후 재업로드) — 되묻는 것은 관리 웹의 confirm 몫. */
  if (p === '/api/naesin/admin/pack' && method === 'POST') {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    const id = String(b.id || '').trim();
    if (!PACK_ID_RE.test(id)) return j(400, { error: '팩 id는 영문/숫자/하이픈 3~60자' });
    const pack = b.pack;
    if (!isObj(pack)) return j(400, { error: 'pack 필요' });
    /* id와 pack.packId가 다르면 저장을 거절한다 — 다른 팩을 덮어쓰는 사고의 마지막 방어선 */
    if (pack.packId !== id) return j(400, { error: 'pack.packId가 id와 달라요.' });
    if (byteLen(pack) > PACK_MAX_BYTES) return j(413, { error: '팩이 너무 커요 (4MB 이내).' });
    const rec = { pack, updatedAt: nowIso() };
    await store.putPack(id, rec);
    const ids = (await store.getPackIds()) || [];
    if (!ids.includes(id)) { ids.push(id); await store.putPackIds(ids); }
    return j(200, { ok: true, id, updatedAt: rec.updatedAt });
  }
  if (p === '/api/naesin/admin/packs' && method === 'GET') {
    return j(200, { packs: (await store.getPackIds()) || [], time: nowIso() });
  }
  /* 팩 삭제 — 어떤 배정(반 공통·학생별)이든 참조 중이면 거절한다(409).
     지우고 나면 그 배정을 받은 학생 앱이 404를 만나고서야 아는데, 그때는 수업 중이다. */
  if (p === '/api/naesin/admin/pack' && method === 'DELETE') {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    const id = String(b.id || '').trim();
    if (!PACK_ID_RE.test(id)) return j(400, { error: '팩 id가 필요해요.' });
    const scopes = await scopesUsingPack(store, id);
    if (scopes.length) return j(409, { error: '시험 범위에 배정된 팩이에요. 먼저 배정을 해제하세요.', scopes });
    await store.deletePack(id);
    const ids = ((await store.getPackIds()) || []).filter((x) => x !== id);
    await store.putPackIds(ids);
    return j(200, { ok: true, id });
  }

  /* 시험 배정 — scope가 'default'면 반 공통, 학생 코드면 그 학생만 (학생 쪽 폴백 참고).
     없는 팩 id를 배정하면 학생 앱이 404를 만나고서야 안다 — 저장 전에 걸러 준다.
     지난 날짜도 저장은 한다(관리 웹이 confirm 으로 되묻는다) — 시험 뒤에 자율 복습 범위로 남겨 두는 용도가 있다. */
  if (p === '/api/naesin/admin/exam' && method === 'POST') {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    const scope = String(b.scope || '').trim();
    if (scope !== 'default' && !CODE_RE.test(scope)) return j(400, { error: "scope는 'default' 또는 학생 코드" });
    if (scope !== 'default' && !(await store.getStudent(scope))) return j(404, { error: '등록되지 않은 학생 코드예요.' });
    const examDate = String(b.examDate || '').trim();
    if (!isValidDate(examDate)) return j(400, { error: 'examDate는 실제 날짜(YYYY-MM-DD)' });
    const packIds = Array.isArray(b.packIds) ? b.packIds.map((x) => String(x || '').trim()) : [];
    if (!packIds.length || packIds.length > EXAM_PACKS_MAX) return j(400, { error: 'packIds 필요 (1~' + EXAM_PACKS_MAX + '개)' });
    for (const pid of packIds) {
      if (!PACK_ID_RE.test(pid)) return j(400, { error: '팩 id 형식 오류: ' + pid.slice(0, 60) });
      if (!(await store.getPack(pid))) return j(400, { error: '없는 팩이에요: ' + pid });
    }
    const rec = { examDate, packIds, updatedAt: nowIso() };
    /* 단어 초회 도달 마감(시험 D-n). 비우면 필드를 생략해 클라이언트 기본값(7)을 따른다. */
    if (b.wordDeadlineDays != null && b.wordDeadlineDays !== '') {
      const w = Number(b.wordDeadlineDays);
      if (!Number.isInteger(w) || w < WORD_DEADLINE_MIN || w > WORD_DEADLINE_MAX)
        return j(400, { error: 'wordDeadlineDays는 ' + WORD_DEADLINE_MIN + '~' + WORD_DEADLINE_MAX + ' 사이 정수' });
      rec.wordDeadlineDays = w;
    }
    await store.putExam(scope, rec);
    return j(200, { ok: true, scope, exam: rec });
  }
  /* 배정 현황 — 반 공통 + 학생별 전부. 관리 웹이 만료 표시·해제 버튼을 붙인다. */
  if (p === '/api/naesin/admin/exams' && method === 'GET') {
    const today = todayKst(ctx.now);
    const exams = [];
    for (const scope of (await store.listExamScopes()) || []) {
      const rec = await store.getExam(scope);
      if (!isObj(rec)) continue;
      exams.push(examRow(scope, rec, scope === 'default' ? null : await store.getStudent(scope), today));
    }
    /* 반 공통이 맨 위, 학생별은 코드순 — 화면이 정렬을 다시 할 필요가 없게 */
    exams.sort((a, b) => (a.scope === 'default' ? -1 : b.scope === 'default' ? 1 : a.scope.localeCompare(b.scope)));
    return j(200, { exams, today, time: nowIso() });
  }
  /* 배정 해제 — 없는 scope 도 ok (두 번 눌러도 오류가 아니다) */
  if (p === '/api/naesin/admin/exam' && method === 'DELETE') {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    const scope = String(b.scope || '').trim();
    if (scope !== 'default' && !CODE_RE.test(scope)) return j(400, { error: "scope는 'default' 또는 학생 코드" });
    await store.deleteExam(scope);
    return j(200, { ok: true, scope });
  }

  /* 성취도 대시보드 원천 — 연동(기록 있는) 학생만, 요약만 추려서.
     state 전체를 내보내지 않는다 — 화면에 필요한 것만 나가는 것이 §10의 결이다. */
  if (p === '/api/naesin/admin/overview' && method === 'GET') {
    const students = [];
    for (const code of await store.listStateCodes()) {
      const [stu, st] = await Promise.all([store.getStudent(code), store.getState(code)]);
      students.push(naesinSummary(code, stu, st));
    }
    return j(200, { students, time: nowIso() });
  }

  return j(404, { error: 'unknown api' });
}
