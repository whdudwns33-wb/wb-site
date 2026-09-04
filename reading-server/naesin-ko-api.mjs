'use strict';
/* WB 국어브레인 — /api/naesin-ko/* 라우트 (server.mjs·worker.mjs 공용)
   격리 원칙: 라우트는 /api/naesin-ko/* 아래, 데이터는 국어 전용 저장소
   (워커: naesinko: 접두 KV 키, 로컬: db.naesinKo)만 쓴다.
   인증은 호스트(진로독서)의 토큰 검증 결과(who)를 그대로 받는다 —
   학생은 연동 한 번으로 네 앱(진로독서·워드브레인·내신브레인·국어브레인)을 쓴다.

   기획서(docs/국어내신-학습웹앱-기획서-v1.md) §9.2·§10:
   - 팩(구매 또는 자체 제작 콘텐츠)은 KV에만 존재한다 — 정적 자산·git 어디에도 없다.
   - who가 없으면 무조건 401. 인증 없이는 콘텐츠가 한 글자도 나가지 않는다.
   - Cache-Control: no-store 는 호스트의 json() 헬퍼가 모든 /api/* 응답에 붙인다.

   영어 앱과 다른 점(§8 저장 예산): 학생 기록을 state 하나에 다 넣지 않는다.
   - state    : SRS 상태 + 일별 롤업만 (256KB)
   - summary  : 관리 overview 전용 요약 (overview는 이것만 읽는다 — state 전체를 안 읽는다)
   - review   : 서술형 제출·판정·확정 (문항별 레코드, 답안 원문이 여기 산다)
   - overlay  : 학교 강조점·정답 덮어쓰기 (시험 scope 단위, 강사 작성물) */

const STATE_MAX_BYTES = 262_144;    // 학생 SRS 기록 1건 최대 (256KB)
const SUMMARY_MAX_BYTES = 8_192;    // 관리 화면 요약 1건 최대 (8KB)
const REVIEW_MAX_BYTES = 16_384;    // 서술형 제출 1건 최대 (16KB)
const OVERLAY_MAX_BYTES = 262_144;  // 학교 오버레이 1건 최대
const PACK_MAX_BYTES = 4_194_304;   // 팩 1건 최대 (4MB)
const PENDING_MAX_BYTES = 1_048_576; // 검수 대기 목록 1팩 최대 (1MB) — 팩에 안 들어가는 초안이라 따로 산다
const REVIEW_LIST_MAX = 300;        // 학생 1명이 쌓아 두는 서술형 제출 상한
const PACK_ID_RE = /^[A-Za-z0-9-]{3,60}$/;
const CODE_RE = /^[A-Za-z0-9-]{3,20}$/;
const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXAM_PACKS_MAX = 20;
const VERDICTS = ['pass', 'hold', 'fail'];

const nowIso = () => new Date().toISOString();
const size = (o) => JSON.stringify(o).length;

/* 성취도 대시보드 한 줄.
   영어 앱과 같은 원칙: 서버는 학습 기록 속을 해석하지 않는다. 클라이언트가
   summary를 따로 올리고 서버는 그것을 그대로 내보낸다. 국어는 요약을 state에서
   분리해 별도 키에 두었으므로(§8 저장 예산) overview가 state를 읽지 않는다 —
   반 15명 조회에 256KB × 15를 읽던 비용이 사라진다. */
export function naesinKoSummary(code, stu, sumRec) {
  const row = {
    code,
    name: (stu && stu.name) || '',
    cls: (stu && stu.cls) || '',
    linked: !!sumRec,
    lastActive: sumRec ? sumRec.updatedAt : null,
  };
  const s = sumRec && sumRec.summary;
  if (s && typeof s === 'object' && !Array.isArray(s)) row.summary = s;
  return row;
}

/* ── 라우터 ──
   ctx = { path, method, who, query, getBody, store }
   store: getPack/putPack, getPackIds/putPackIds, getPending/putPending, getState/putState,
          getSummary/putSummary/listSummaryCodes,
          getReviews/putReviews, getOverlay/putOverlay,
          getExam/putExam, getTask/putTask, getStudent
   반환: { status, body } */
export async function handleNaesinKo(ctx) {
  const { path: p, method, who, store } = ctx;
  const j = (status, body) => ({ status, body });
  if (!who) return j(401, { error: '로그인이 필요합니다.' });

  /* 호스트마다 JSON 파싱 실패의 모양이 다르다(로컬 reject, 워커 throw) — 여기서 400으로 통일 */
  const body = async () => {
    try { return await ctx.getBody(); } catch (e) { return null; }
  };

  /* ── 학생 (관리자 토큰도 통과) ── */

  /* 팩 서빙 — 인증 없이는 아무것도 나가지 않는다(§10-4).
     학생·관리자 모두 열 수 있다 — 검수 화면이 방금 올린 팩을 같은 라우트로 확인한다. */
  if (p === '/api/naesin-ko/pack' && method === 'GET') {
    const id = String((ctx.query && ctx.query.get('id')) || '').trim();
    if (!PACK_ID_RE.test(id)) return j(400, { error: '팩 id가 필요해요.' });
    const rec = await store.getPack(id);
    if (!rec) return j(404, { error: '팩을 찾을 수 없어요.' });
    return j(200, { pack: rec.pack, updatedAt: rec.updatedAt || null });
  }

  if (p === '/api/naesin-ko/state' && method === 'GET' && !who.admin) {
    const rec = await store.getState(who.code);
    return j(200, { state: rec ? rec.state : {}, updatedAt: rec ? rec.updatedAt : null });
  }
  if (p === '/api/naesin-ko/state' && method === 'PUT' && !who.admin) {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const state = b.state;
    if (!state || typeof state !== 'object') return j(400, { error: 'state 필요' });
    const rec = { state, updatedAt: nowIso() };
    /* 상한을 넘으면 조용히 실패하지 않고 413으로 알린다 — 학생 화면이 경고를 띄운다.
       서술형 답안은 여기 오지 않는다(/review로 간다) — state가 부푸는 주범이었다. */
    if (size(rec) > STATE_MAX_BYTES) return j(413, { error: '학습 기록이 너무 커서 저장할 수 없어요. 선생님께 알려 주세요.' });
    await store.putState(who.code, rec);

    /* 요약은 같은 요청에서 별도 키로 함께 저장한다 — 관리 화면이 state를 안 읽게 하려면
       요약이 항상 최신이어야 하고, 왕복을 두 번 하면 어긋날 틈이 생긴다. */
    if (b.summary && typeof b.summary === 'object' && !Array.isArray(b.summary)) {
      const srec = { summary: b.summary, updatedAt: rec.updatedAt };
      if (size(srec) <= SUMMARY_MAX_BYTES) await store.putSummary(who.code, srec);
    }
    return j(200, { ok: true, updatedAt: rec.updatedAt });
  }

  /* 시험 설정 — 내 것 → 반 공통(default) → 빈 값. 빈 값도 200이다(시험 없는 평시). */
  if (p === '/api/naesin-ko/exam' && method === 'GET' && !who.admin) {
    const mine = await store.getExam(who.code);
    if (mine) return j(200, { exam: mine, scope: 'student' });
    const def = await store.getExam('default');
    if (def) return j(200, { exam: def, scope: 'default' });
    return j(200, { exam: {}, scope: null });
  }

  /* 오늘 수업 과제 — 강사가 배정한 반 공통 세트(수업 모드) */
  if (p === '/api/naesin-ko/task' && method === 'GET' && !who.admin) {
    const rec = await store.getTask('default');
    return j(200, { task: rec || {}, scope: rec ? 'default' : null });
  }

  /* 학교 오버레이 — 학교 선생님이 강조한 해석이 정본을 덮어쓴다(§3, §14-1).
     시험 설정과 같은 폴백을 쓴다: 내 것 → 반 공통. */
  if (p === '/api/naesin-ko/overlay' && method === 'GET' && !who.admin) {
    const mine = await store.getOverlay(who.code);
    if (mine) return j(200, { overlay: mine, scope: 'student' });
    const def = await store.getOverlay('default');
    if (def) return j(200, { overlay: def, scope: 'default' });
    return j(200, { overlay: {}, scope: null });
  }

  /* 서술형 제출·조회 — 답안 원문은 state가 아니라 여기 산다(§8 저장 예산). */
  if (p === '/api/naesin-ko/review' && method === 'GET' && !who.admin) {
    const rec = await store.getReviews(who.code);
    return j(200, { reviews: (rec && rec.reviews) || [], updatedAt: rec ? rec.updatedAt : null });
  }
  if (p === '/api/naesin-ko/review' && method === 'POST' && !who.admin) {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const r = b.review;
    if (!r || typeof r !== 'object') return j(400, { error: 'review 필요' });
    const itemId = String(r.itemId || '').trim();
    if (!ITEM_ID_RE.test(itemId)) return j(400, { error: 'itemId 형식 오류' });
    const packId = String(r.packId || '').trim();
    if (!PACK_ID_RE.test(packId)) return j(400, { error: 'packId 형식 오류' });
    const entry = {
      itemId, packId,
      answer: String(r.answer || '').slice(0, 2000),
      rule: r.rule && typeof r.rule === 'object' ? r.rule : null,   // 1층 규칙 판정 결과
      verdict: VERDICTS.includes(r.verdict) ? r.verdict : 'hold',
      submittedAt: nowIso(),
      teacher: null,   // 강사 확정 전 — 확정은 관리 라우트가 채운다
    };
    if (size(entry) > REVIEW_MAX_BYTES) return j(413, { error: '답안이 너무 길어요.' });
    const rec = (await store.getReviews(who.code)) || { reviews: [] };
    /* 같은 문항 재제출은 덮어쓴다 — 오답노트가 아니라 '현재 답안'이 필요한 화면이다 */
    const list = rec.reviews.filter((x) => x.itemId !== itemId);
    list.push(entry);
    const next = { reviews: list.slice(-REVIEW_LIST_MAX), updatedAt: nowIso() };
    await store.putReviews(who.code, next);
    return j(200, { ok: true, updatedAt: next.updatedAt });
  }

  /* ── 관리자 (원장·강사 — 관리 PIN 토큰) ── */
  if (!who.admin) return j(403, { error: '권한이 없습니다.' });

  /* 팩 업로드 — 구조 검증은 업로드 도구·검수 화면(pack-check.js) 몫이고,
     서버는 id 일치와 크기만 지킨다. */
  if (p === '/api/naesin-ko/admin/pack' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const id = String(b.id || '').trim();
    if (!PACK_ID_RE.test(id)) return j(400, { error: '팩 id는 영문/숫자/하이픈 3~60자' });
    const pack = b.pack;
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return j(400, { error: 'pack 필요' });
    /* id와 pack.packId가 다르면 거절 — 다른 팩을 덮어쓰는 사고의 마지막 방어선 */
    if (pack.packId !== id) return j(400, { error: 'pack.packId가 id와 달라요.' });
    if (size(pack) > PACK_MAX_BYTES) return j(413, { error: '팩이 너무 커요 (4MB 이내).' });
    const rec = { pack, updatedAt: nowIso() };
    await store.putPack(id, rec);
    const ids = (await store.getPackIds()) || [];
    if (!ids.includes(id)) { ids.push(id); await store.putPackIds(ids); }
    return j(200, { ok: true, id, updatedAt: rec.updatedAt });
  }
  if (p === '/api/naesin-ko/admin/packs' && method === 'GET') {
    return j(200, { packs: (await store.getPackIds()) || [], time: nowIso() });
  }

  /* ── 검수 대기 목록 ──
     추출기가 팩에 못 넣은 것들(루브릭 없는 서술형이 대부분)이 여기 산다. **팩과 다른 키**다 —
     같이 두면 학생에게 배달되고, 학생 화면에 뜨면 안 되는 초안이기 때문이다(§7[3] 검수 게이트).
     관리 화면이 루브릭을 저작해 팩으로 옮기면 여기서 빠진다. */
  if (p === '/api/naesin-ko/admin/pending' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const id = String(b.id || '').trim();
    if (!PACK_ID_RE.test(id)) return j(400, { error: '팩 id는 영문/숫자/하이픈 3~60자' });
    if (!Array.isArray(b.pending)) return j(400, { error: 'pending 배열이 필요해요.' });
    if (size(b.pending) > PENDING_MAX_BYTES) return j(413, { error: '검수 목록이 너무 커요 (1MB 이내).' });
    const rec = { pending: b.pending, updatedAt: nowIso() };
    await store.putPending(id, rec);
    return j(200, { ok: true, id, count: b.pending.length, updatedAt: rec.updatedAt });
  }
  if (p === '/api/naesin-ko/admin/pending' && method === 'GET') {
    const id = String((ctx.query && ctx.query.get('id')) || '').trim();
    if (!PACK_ID_RE.test(id)) return j(400, { error: '팩 id가 필요해요.' });
    const rec = await store.getPending(id);
    return j(200, { pending: (rec && rec.pending) || [], updatedAt: (rec && rec.updatedAt) || null });
  }

  /* 시험 배정 — scope가 'default'면 반 공통, 학생 코드면 그 학생만.
     profile(문항 수·서술형 배점)은 학교알리미 평가계획에서 옮겨 적는 값이고,
     플래너가 서술형 착수일을 앞당기는 데 쓴다(§3, §5.4). */
  if (p === '/api/naesin-ko/admin/exam' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const scope = String(b.scope || '').trim();
    if (scope !== 'default' && !CODE_RE.test(scope)) return j(400, { error: "scope는 'default' 또는 학생 코드" });
    if (scope !== 'default' && !(await store.getStudent(scope))) return j(404, { error: '등록되지 않은 학생 코드예요.' });
    const examDate = String(b.examDate || '').trim();
    if (!DATE_RE.test(examDate)) return j(400, { error: 'examDate는 YYYY-MM-DD' });
    const packIds = Array.isArray(b.packIds) ? b.packIds.map((x) => String(x || '').trim()) : [];
    if (!packIds.length || packIds.length > EXAM_PACKS_MAX) return j(400, { error: `packIds 필요 (1~${EXAM_PACKS_MAX}개)` });
    for (const pid of packIds) {
      if (!PACK_ID_RE.test(pid)) return j(400, { error: '팩 id 형식 오류: ' + pid.slice(0, 60) });
      if (!(await store.getPack(pid))) return j(400, { error: '없는 팩이에요: ' + pid });
    }
    const rec = { examDate, packIds, updatedAt: nowIso() };
    if (b.profile && typeof b.profile === 'object') {
      const mc = Number(b.profile.mcCount), es = Number(b.profile.essayCount), w = Number(b.profile.essayWeight);
      rec.profile = {
        mcCount: Number.isFinite(mc) && mc >= 0 ? Math.min(100, Math.round(mc)) : null,
        essayCount: Number.isFinite(es) && es >= 0 ? Math.min(100, Math.round(es)) : null,
        essayWeight: Number.isFinite(w) && w >= 0 && w <= 1 ? w : null,
      };
    }
    await store.putExam(scope, rec);
    return j(200, { ok: true, scope, exam: rec });
  }

  /* 수업 과제 배정 — 수업시간에 반 전원이 같은 세트를 진행하게 한다(§6) */
  if (p === '/api/naesin-ko/admin/task' && method === 'GET') {
    return j(200, { task: (await store.getTask('default')) || {} });
  }
  if (p === '/api/naesin-ko/admin/task' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const date = String(b.date || '').trim();
    if (!DATE_RE.test(date)) return j(400, { error: 'date는 YYYY-MM-DD' });
    const title = String(b.title || '').trim().slice(0, 80);
    if (!title) return j(400, { error: 'title 필요' });
    const typeKeys = Array.isArray(b.typeKeys)
      ? b.typeKeys.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12) : [];
    if (!typeKeys.length) return j(400, { error: 'typeKeys 필요 (학습 유형 1개 이상)' });
    const rec = { date, title, typeKeys, updatedAt: nowIso() };
    const packId = String(b.packId || '').trim();
    if (packId) {
      if (!PACK_ID_RE.test(packId)) return j(400, { error: 'packId 형식 오류' });
      if (!(await store.getPack(packId))) return j(400, { error: '없는 팩이에요: ' + packId });
      rec.packId = packId;
    }
    if (Array.isArray(b.workIds)) rec.workIds = b.workIds.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20);
    await store.putTask('default', rec);
    return j(200, { ok: true, task: rec });
  }

  /* 학교 오버레이 등록(§3·§14-1) — 정본의 특정 항목을 학교 해석으로 덮어쓴다.
     overrides[]: {targetRef, answers[], note} · notes[]: {workId, text} */
  if (p === '/api/naesin-ko/admin/overlay' && method === 'GET') {
    const scope = String((ctx.query && ctx.query.get('scope')) || 'default').trim();
    return j(200, { overlay: (await store.getOverlay(scope)) || {}, scope });
  }
  if (p === '/api/naesin-ko/admin/overlay' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const scope = String(b.scope || 'default').trim();
    if (scope !== 'default' && !CODE_RE.test(scope)) return j(400, { error: "scope는 'default' 또는 학생 코드" });
    const overrides = Array.isArray(b.overrides) ? b.overrides.slice(0, 500).map((o) => ({
      targetRef: String((o && o.targetRef) || '').trim().slice(0, 80),
      answers: Array.isArray(o && o.answers) ? o.answers.map((a) => String(a || '').slice(0, 200)).filter(Boolean) : [],
      note: String((o && o.note) || '').slice(0, 500),
    })).filter((o) => o.targetRef && o.answers.length) : [];
    const notes = Array.isArray(b.notes) ? b.notes.slice(0, 100).map((n) => ({
      workId: String((n && n.workId) || '').trim().slice(0, 60),
      text: String((n && n.text) || '').slice(0, 2000),
    })).filter((n) => n.workId && n.text) : [];
    const rec = { overrides, notes, updatedAt: nowIso() };
    if (size(rec) > OVERLAY_MAX_BYTES) return j(413, { error: '오버레이가 너무 커요.' });
    await store.putOverlay(scope, rec);
    return j(200, { ok: true, scope, overlay: rec });
  }

  /* 서술형 검토 큐 — 강사가 학생 답안을 나란히 보고 원터치로 확정한다(§6).
     학생 화면의 판정 라벨은 '연습 판정'이다 — 학교 채점과 다를 수 있다(§10-8). */
  if (p === '/api/naesin-ko/admin/review' && method === 'GET') {
    const want = String((ctx.query && ctx.query.get('code')) || '').trim();
    const codes = want ? [want] : await store.listSummaryCodes();
    const rows = [];
    for (const code of codes) {
      const rec = await store.getReviews(code);
      if (!rec) continue;
      const stu = await store.getStudent(code);
      (rec.reviews || []).forEach((r) => {
        rows.push({ code, name: (stu && stu.name) || '', cls: (stu && stu.cls) || '', ...r });
      });
    }
    return j(200, { reviews: rows, time: nowIso() });
  }
  if (p === '/api/naesin-ko/admin/review' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const code = String(b.code || '').trim();
    if (!CODE_RE.test(code)) return j(400, { error: '학생 코드 형식 오류' });
    const itemId = String(b.itemId || '').trim();
    if (!ITEM_ID_RE.test(itemId)) return j(400, { error: 'itemId 형식 오류' });
    if (!VERDICTS.includes(b.verdict)) return j(400, { error: "verdict는 pass·hold·fail" });
    const rec = await store.getReviews(code);
    if (!rec) return j(404, { error: '제출 기록이 없어요.' });
    const list = rec.reviews || [];
    const hit = list.filter((x) => x.itemId === itemId)[0];
    if (!hit) return j(404, { error: '해당 문항의 제출이 없어요.' });
    const points = Number(b.points);
    hit.teacher = {
      verdict: b.verdict,
      points: Number.isFinite(points) ? points : null,
      comment: String(b.comment || '').slice(0, 500),
      confirmedAt: nowIso(),
      /* 규칙 판정을 강사가 뒤집었는지 — 파일럿의 '뒤집기율' 지표가 이 값을 센다(§11) */
      flipped: !!(hit.rule && hit.rule.verdict && hit.rule.verdict !== b.verdict),
    };
    const next = { reviews: list, updatedAt: nowIso() };
    await store.putReviews(code, next);
    return j(200, { ok: true, review: hit });
  }

  /* 성취도 대시보드 원천 — 요약 키만 읽는다(§8 저장 예산). */
  if (p === '/api/naesin-ko/admin/overview' && method === 'GET') {
    const students = [];
    for (const code of await store.listSummaryCodes()) {
      const [stu, sum] = await Promise.all([store.getStudent(code), store.getSummary(code)]);
      students.push(naesinKoSummary(code, stu, sum));
    }
    return j(200, { students, time: nowIso() });
  }

  return j(404, { error: 'unknown api' });
}
