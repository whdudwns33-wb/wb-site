'use strict';
/* WB 내신 — /api/naesin/* 라우트 (server.mjs·worker.mjs 공용, vocab-api.mjs 선례)
   격리 원칙: 라우트는 /api/naesin/* 아래, 데이터는 내신 전용 저장소
   (워커: naesin: 접두 KV 키, 로컬: db.naesin)만 쓴다.
   인증은 호스트(진로독서)의 토큰 검증 결과(who)를 그대로 받는다 — 학생은 연동 한 번으로 세 앱을 쓴다.

   기획서 §9.3: 팩(구매 콘텐츠)은 KV에만 존재한다 — 정적 자산·git 어디에도 없다.
   기획서 §10: 인증 없이는 콘텐츠를 절대 반환하지 않는다. 이 모듈은 who가 없으면
   무조건 401로 끝난다. Cache-Control: no-store 는 호스트의 json() 헬퍼가 모든
   /api/* 응답에 붙인다(§10-3) — 여기서 따로 붙일 헤더가 없다. */

const STATE_MAX_BYTES = 262_144;    // 학생 학습 기록 1건 최대 크기 (256KB)
const PACK_MAX_BYTES = 4_194_304;   // 팩 1건 최대 크기 (4MB) — 단어 77·문장 25·문항·해설이 다 들어간다
const PACK_ID_RE = /^[A-Za-z0-9-]{3,60}$/;
const CODE_RE = /^[A-Za-z0-9-]{3,20}$/;          // 학생 코드 — 호스트 등록 규칙과 동일
const EXAM_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXAM_PACKS_MAX = 20;          // 한 시험 범위에 담는 팩 수 — 한 학기 시험이 이걸 넘지 않는다

const nowIso = () => new Date().toISOString();

/* 성취도 대시보드 한 줄 (관리 overview용).
   state 구조는 클라이언트 소관이다 — 단어 도달/안정화 수·문장 단계 분포·마지막 학습
   시각 같은 요약은 클라이언트가 state.summary 에 만들어 두고, 서버는 그것을 그대로
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
  const sum = S && S.summary;
  if (sum && typeof sum === 'object' && !Array.isArray(sum)) row.summary = sum;
  return row;
}

/* ── 라우터 ──
   ctx = {
     path, method, who,                 // who: {code, admin} | null — 호스트가 검증한 토큰
     query,                             // URLSearchParams (GET ?id= 용)
     getBody: async () => object,       // 호스트가 JSON을 파싱해 준다 — 실패는 여기서 400으로
     store: {                           // 내신 전용 저장소 어댑터 (전부 async 허용)
       getPack(id), putPack(id, rec),
       getPackIds(), putPackIds(ids),   // naesin:packs — 저장된 팩 id 배열
       getState(code), putState(code, rec), listStateCodes(),
       getExam(scope), putExam(scope, rec),   // scope: 'default' | 학생코드
       getStudent(code),                // 호스트 학생 명부 (읽기만)
     },
   }
   반환: { status, body } — /api/naesin/* 이 아닌 경로는 호출 전에 호스트가 거른다. */
export async function handleNaesin(ctx) {
  const { path: p, method, who, store } = ctx;
  const j = (status, body) => ({ status, body });
  if (!who) return j(401, { error: '로그인이 필요합니다.' });

  /* 저장 라우트는 몸통이 JSON이 아니면 400으로 끝낸다 — 저장 전 파싱 검증(기획 요구).
     호스트마다 파싱 실패의 모양이 다르다(로컬은 reject, 워커는 throw) — 여기서 통일한다. */
  const body = async () => {
    try { return await ctx.getBody(); } catch (e) { return null; }
  };

  /* ── 학생 (관리자 토큰도 통과) ── */

  /* 팩 서빙 — 콘텐츠는 KV에만 있고(§9.3) 인증 없이는 아무것도 나가지 않는다(§10).
     학생·관리자 모두 열 수 있다 — 강사 검수 화면이 방금 올린 팩을 같은 라우트로 확인한다.
     과 단위 필요 분량만 서빙(전체 덤프 API 없음)도 §10-3의 요구다. */
  if (p === '/api/naesin/pack' && method === 'GET') {
    const id = String((ctx.query && ctx.query.get('id')) || '').trim();
    if (!PACK_ID_RE.test(id)) return j(400, { error: '팩 id가 필요해요.' });
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
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const state = b.state;
    if (!state || typeof state !== 'object') return j(400, { error: 'state 필요' });
    const rec = { state, updatedAt: nowIso() };
    if (JSON.stringify(rec).length > STATE_MAX_BYTES) return j(413, { error: '기록이 너무 커서 저장할 수 없어요.' });
    await store.putState(who.code, rec);
    return j(200, { ok: true, updatedAt: rec.updatedAt });
  }

  /* 시험 설정 — 내 것 → 반 공통(default) → 빈 값.
     빈 값도 200이다 — 시험이 아직 안 잡힌 것은 오류가 아니라 평시다. */
  if (p === '/api/naesin/exam' && method === 'GET' && !who.admin) {
    const mine = await store.getExam(who.code);
    if (mine) return j(200, { exam: mine, scope: 'student' });
    const def = await store.getExam('default');
    if (def) return j(200, { exam: def, scope: 'default' });
    return j(200, { exam: {}, scope: null });
  }

  /* ── 관리자 (원장·강사 — 관리 PIN 토큰) ── */
  if (!who.admin) return j(403, { error: '권한이 없습니다.' });

  /* 팩 업로드 — 업로드 파이프라인의 종착지(§7). 검증은 최소로:
     구조 검증은 업로드 도구·검수 화면 몫이고, 서버는 id 일치와 크기만 지킨다. */
  if (p === '/api/naesin/admin/pack' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const id = String(b.id || '').trim();
    if (!PACK_ID_RE.test(id)) return j(400, { error: '팩 id는 영문/숫자/하이픈 3~60자' });
    const pack = b.pack;
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return j(400, { error: 'pack 필요' });
    /* id와 pack.packId가 다르면 저장을 거절한다 — 다른 팩을 덮어쓰는 사고의 마지막 방어선 */
    if (pack.packId !== id) return j(400, { error: 'pack.packId가 id와 달라요.' });
    if (JSON.stringify(pack).length > PACK_MAX_BYTES) return j(413, { error: '팩이 너무 커요 (4MB 이내).' });
    const rec = { pack, updatedAt: nowIso() };
    await store.putPack(id, rec);
    const ids = (await store.getPackIds()) || [];
    if (!ids.includes(id)) { ids.push(id); await store.putPackIds(ids); }
    return j(200, { ok: true, id, updatedAt: rec.updatedAt });
  }
  if (p === '/api/naesin/admin/packs' && method === 'GET') {
    return j(200, { packs: (await store.getPackIds()) || [], time: nowIso() });
  }

  /* 시험 배정 — scope가 'default'면 반 공통, 학생 코드면 그 학생만 (학생 쪽 폴백 참고).
     없는 팩 id를 배정하면 학생 앱이 404를 만나고서야 안다 — 저장 전에 걸러 준다. */
  if (p === '/api/naesin/admin/exam' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const scope = String(b.scope || '').trim();
    if (scope !== 'default' && !CODE_RE.test(scope)) return j(400, { error: "scope는 'default' 또는 학생 코드" });
    if (scope !== 'default' && !(await store.getStudent(scope))) return j(404, { error: '등록되지 않은 학생 코드예요.' });
    const examDate = String(b.examDate || '').trim();
    if (!EXAM_DATE_RE.test(examDate)) return j(400, { error: 'examDate는 YYYY-MM-DD' });
    const packIds = Array.isArray(b.packIds) ? b.packIds.map((x) => String(x || '').trim()) : [];
    if (!packIds.length || packIds.length > EXAM_PACKS_MAX) return j(400, { error: 'packIds 필요 (1~' + EXAM_PACKS_MAX + '개)' });
    for (const pid of packIds) {
      if (!PACK_ID_RE.test(pid)) return j(400, { error: '팩 id 형식 오류: ' + pid.slice(0, 60) });
      if (!(await store.getPack(pid))) return j(400, { error: '없는 팩이에요: ' + pid });
    }
    const rec = { examDate, packIds, updatedAt: nowIso() };
    await store.putExam(scope, rec);
    return j(200, { ok: true, scope, exam: rec });
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
