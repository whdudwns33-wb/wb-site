'use strict';
/* WB 청크브레인 — /api/chunk/* 라우트 (server.mjs·worker.mjs 공용)
   격리 원칙(워드브레인·국어브레인 선례): 라우트는 /api/chunk/* 아래, 데이터는 청크 전용 저장소
   (워커: chunk: 접두 KV 키, 로컬: db.chunk)만 쓴다. 인증은 호스트의 토큰 검증 결과(who)를 그대로 받는다.

   콘텐츠(지문·카드)는 자체 창작이라 정적 자산(chunk/passages.js)으로 나간다 — 서버가 나르는 것은 학생 기록과 선생님 과제뿐이다.
   응답 계약(CLAUDE.md 절대 규칙 4): /state → {state, updatedAt} · /assign → {assign, updatedAt}.
   summary 는 관리 화면용 작은 요약 — 학생 기기가 올린 값이라 서버가 화이트리스트로 모양을 강제하고, 화면은 다시 이스케이프한다.

   저장 키 네 계열: state(학생 기록 전체) · summary(관리 화면용 요약) · assign(선생님이 정한 단계·글·카드) · customs(선생님이 올린 지문, 키 하나).

   가족 링크(/api/chunk/parent*, ?t=): 진로독서 학부모 토큰(parent:<t>)으로 로그인 없이 자녀 기록을 읽고 쓴다 — 브레인레터 가족 링크와 같은 토큰이라
   가정마다 링크가 하나다. 기록은 학생 토큰과 같은 키(chunk:state:<code>)에 쌓여 선생님 화면·학생 기기와 이어진다. 토큰이 곧 자격이므로 하루 PUT 상한을 둔다. */

const STATE_MAX_BYTES = 262_144;   // 학생 기록 1건 최대 (256KB) — log 400건 + items 로도 충분히 남는다
const SUMMARY_MAX_BYTES = 4_096;
const ASSIGN_MAX_ITEMS = 20;
const BANDS = ['K', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12'];   /* chunk/rules.js BAND_ORDER 와 같다 */
const CODE_RE = /^[A-Za-z0-9-]{3,20}$/;
const ID_RE = /^[a-z0-9-]{2,24}$/;        /* 지문·카드 id — g3-01, k-1 */
const TAG_RE = /^(?:miss|extra):[a-z]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PTOKEN_RE = /^[A-Za-z0-9]{16,64}$/;   /* 진로독서 학부모 토큰(parent:<t>) — 브레인레터 가족 링크와 같은 것 */
const PARENT_PUTS_PER_DAY = 60;             /* 가족 링크 PUT /state 하루 상한 — 앱은 0.7초 디바운스라 한 세션에 열 번 안팎 */
const CUSTOM_MAX = 200;              /* 선생님 지문 전체 상한 — 학생 앱이 켤 때 한 번에 받는 목록이라 작게 둔다 */
const PASSAGE_MAX_CHARS = 4_000;
const PARA_MAX = 20;
const nowIso = () => new Date().toISOString();
const size = (o) => JSON.stringify(o).length;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const int0 = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1_000_000, Math.round(Number(v)))) : 0);
const pctOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(100, Math.round(Number(v)))));

/* 학생 기기가 올린 요약을 모양만 강제한다 — 뜻은 해석하지 않는다(하루브레인 normalizeSummary 와 같은 원칙) */
export function normalizeChunkSummary(sum) {
  if (!isObj(sum)) return null;
  const weak = Array.isArray(sum.weak)
    ? sum.weak.filter((w) => isObj(w) && TAG_RE.test(String(w.tag || ''))).slice(0, 5).map((w) => ({ tag: String(w.tag), n: int0(w.n) }))
    : [];
  return {
    band: BANDS.includes(sum.band) ? sum.band : null,
    attempts: int0(sum.attempts), practiced: int0(sum.practiced), graduated: int0(sum.graduated),
    avg: pctOrNull(sum.avg), recentAvg: pctOrNull(sum.recentAvg), qRate: pctOrNull(sum.qRate),
    wpmRecent: sum.wpmRecent == null ? null : int0(sum.wpmRecent),
    streak: int0(sum.streak), lessonsDone: int0(sum.lessonsDone),
    assignDone: int0(sum.assignDone),
    index: pctOrNull(sum.index),
    weak,
    lastAt: Number.isFinite(Number(sum.lastAt)) && Number(sum.lastAt) > 0 ? Math.round(Number(sum.lastAt)) : null,
  };
}

/* 선생님 과제 — 단계·글·카드·메모·마감. 셋 다 비면 null(과제 없음). 오류는 문자열로 돌려준다. */
export function normalizeAssign(a) {
  if (!isObj(a)) return { error: '과제는 객체여야 해요.' };
  const band = a.band == null || a.band === '' ? null : (BANDS.includes(a.band) ? a.band : undefined);
  if (band === undefined) return { error: '모르는 단계예요: ' + String(a.band) };
  const ids = (list, what) => {
    if (list == null) return [];
    if (!Array.isArray(list)) return { error: what + ' 목록이 배열이 아니에요.' };
    const out = [];
    for (const x of list) { if (!ID_RE.test(String(x))) return { error: what + ' id 형식이 아니에요: ' + String(x) }; if (out.indexOf(x) < 0) out.push(String(x)); }
    if (out.length > ASSIGN_MAX_ITEMS) return { error: what + '은(는) ' + ASSIGN_MAX_ITEMS + '개까지만 정할 수 있어요.' };
    return out;
  };
  const passages = ids(a.passages, '글'); if (passages.error) return passages;
  const lessons = ids(a.lessons, '카드'); if (lessons.error) return lessons;
  const note = String(a.note || '').trim().slice(0, 200);
  const due = a.due == null || a.due === '' ? null : (DATE_RE.test(String(a.due)) ? String(a.due) : undefined);
  if (due === undefined) return { error: '마감일은 YYYY-MM-DD 형식이에요.' };
  if (!band && !passages.length && !lessons.length && !note) return { assign: null };
  return { assign: { band, passages, lessons, note, due } };
}

/* 선생님 지문 — 관리 화면 「글 저작」이 올린 글. 정적 지문(chunk/passages.js)과 같은 모양이라 학생 앱이 그대로 합친다.
   저장소는 키 하나(customs: {items:{id:passage}, updatedAt}) — 학생 앱이 켤 때 한 번에 받고, 선생님 편집은 드물어 읽고-고쳐-쓰기로 충분하다.
   조각 규칙(마지막을 빼고 공백으로 끝난다·빈 조각 없음)만 강제하고 끊기의 «뜻»은 검사하지 않는다 — 그것은 관리 화면의 규칙 검사와 사람이 본다. */
export function normalizePassage(p, id) {
  if (!isObj(p)) return { error: '지문은 객체여야 해요.' };
  if (!BANDS.includes(p.band)) return { error: '모르는 단계예요: ' + String(p.band) };
  const title = String(p.title || '').trim().slice(0, 60);
  if (!title) return { error: '제목이 필요해요.' };
  const genre = String(p.genre || '').trim().slice(0, 12) || '선생님 글';
  if (!Array.isArray(p.paragraphs) || !p.paragraphs.length || p.paragraphs.length > PARA_MAX) return { error: '문단은 1~' + PARA_MAX + '개여야 해요.' };
  const paragraphs = []; let chars = 0;
  for (const segs of p.paragraphs) {
    if (!Array.isArray(segs) || !segs.length) return { error: '문단은 조각 배열이어야 해요.' };
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const x = String(segs[i]);
      if (!x.trim()) return { error: '빈 조각이 있어요.' };
      if (i < segs.length - 1 && !/\s$/.test(x)) return { error: '조각은 공백으로 끝나야 해요: 「' + x + '」' };
      out.push(x); chars += x.length;
    }
    paragraphs.push(out);
  }
  if (chars > PASSAGE_MAX_CHARS) return { error: '글이 너무 길어요 (' + PASSAGE_MAX_CHARS + '자 이내).' };
  let q = null;
  if (p.q != null && p.q !== '') {
    if (!isObj(p.q)) return { error: '문제 형식이 아니에요.' };
    const qq = String(p.q.q || '').trim().slice(0, 200);
    const choices = Array.isArray(p.q.choices) ? p.q.choices.map((c) => String(c).trim().slice(0, 80)).filter(Boolean) : [];
    const answer = Number(p.q.answer);
    if (!qq || choices.length < 2 || choices.length > 4 || !Number.isInteger(answer) || answer < 0 || answer >= choices.length) return { error: '문제는 질문, 보기 2~4개, 정답 번호가 필요해요.' };
    q = { q: qq, choices, answer, explain: String(p.q.explain || '').trim().slice(0, 200) };
  }
  const source = isObj(p.source) ? { kind: String(p.source.kind || 'teacher').slice(0, 12), ref: String(p.source.ref || '').slice(0, 80) } : { kind: 'teacher', ref: '' };
  return { passage: { id, band: p.band, title, genre, paragraphs, q, source } };
}
/* id 는 서버가 만든다 — 과제 id 규칙(ID_RE)에 맞고 정적 지문(g3-01·k-1)과 겹치지 않게 c- 접두 */
const newCustomId = () => ('c-' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')).toLowerCase();
const customList = (rec) => Object.values(rec && rec.items ? rec.items : {}).sort((a, b) => String(a.id).localeCompare(String(b.id)));

/* 관리 overview 한 줄 — 학생 명단(students)과 요약·과제를 합친다 */
export function chunkOverviewRow(code, stu, rec, assignRec) {
  const s = rec && rec.summary ? rec.summary : null;
  const a = assignRec && assignRec.assign ? assignRec.assign : null;
  return {
    code, name: stu ? stu.name || '' : '', cls: stu ? stu.cls || '' : '', grade: stu ? stu.grade || '' : '',
    band: s ? s.band : null, attempts: s ? s.attempts : 0, practiced: s ? s.practiced : 0, graduated: s ? s.graduated : 0,
    avg: s ? s.avg : null, recentAvg: s ? s.recentAvg : null, qRate: s ? s.qRate : null, wpmRecent: s ? s.wpmRecent : null,
    streak: s ? s.streak : 0, lessonsDone: s ? s.lessonsDone : 0, weak: s ? s.weak || [] : [], assignDone: s ? s.assignDone || 0 : 0, index: s ? (s.index == null ? null : s.index) : null,
    lastAt: s ? s.lastAt : null, updatedAt: rec ? rec.updatedAt || null : null,
    assign: a ? { band: a.band, passages: a.passages.length, lessons: a.lessons.length, due: a.due, note: a.note, updatedAt: assignRec.updatedAt || null } : null,
  };
}

export async function handleChunk({ path: p, method, who, getBody, store, query }) {
  const j = (status, body) => ({ status, body });
  const body = async () => { try { return await getBody(); } catch (e) { return null; } };

  /* ── 가족 링크 — 로그인 없음, ?t= 가 자격. 호스트가 who 검증 전에 여기로 보낸다(브레인레터 parent 와 같은 자리) ── */
  if (p === '/api/chunk/parent' || p.startsWith('/api/chunk/parent/')) {
    const t = query && typeof query.get === 'function' ? String(query.get('t') || '') : '';
    const code = PTOKEN_RE.test(t) && store.getParentCode ? await store.getParentCode(t) : null;
    if (!code) return j(404, { error: '유효하지 않은 링크예요. 학원에 문의해 주세요.' });
    const stu = await store.getStudent(code);
    if (!stu) return j(404, { error: '학생 정보를 찾을 수 없어요.' });
    /* apps 게이트(외부 학생) — 호스트의 allowedApp 과 같은 규칙: apps 가 배열이면 그 목록만 */
    if (Array.isArray(stu.apps) && !stu.apps.includes('chunk')) return j(403, { error: '이 앱의 이용 대상이 아니에요.' });
    if (p === '/api/chunk/parent' && method === 'GET') {
      const [rec, arec, crec] = await Promise.all([store.getState(code), store.getAssign(code), store.getCustoms()]);
      const st = rec && rec.state ? rec.state : null, a = arec && arec.assign ? arec.assign : null;
      return j(200, {
        parent: { name: stu.name || '', cls: stu.cls || '', band: (a && a.band) || (st && st.band) || null },
        assign: a, assignUpdatedAt: arec ? arec.updatedAt : null,
        custom: customList(crec), updatedAt: rec ? rec.updatedAt : null,
      });
    }
    if (p === '/api/chunk/parent/state' && method === 'GET') {
      const rec = await store.getState(code);
      return j(200, { state: rec ? rec.state : null, updatedAt: rec ? rec.updatedAt : null });
    }
    if (p === '/api/chunk/parent/state' && method === 'PUT') {
      const b = await body();
      if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
      if (!isObj(b.state)) return j(400, { error: 'state 필요' });
      const prev = await store.getState(code), today = nowIso().slice(0, 10);
      const n = prev && prev.puts && prev.puts.d === today ? prev.puts.n : 0;
      if (n >= PARENT_PUTS_PER_DAY) return j(429, { error: '오늘 저장은 여기까지예요. 내일 이어서 해요.' });
      const rec = { state: b.state, updatedAt: nowIso(), puts: { d: today, n: n + 1 } };
      if (size(rec) > STATE_MAX_BYTES) return j(413, { error: '기록이 너무 커서 저장할 수 없어요. 선생님께 알려 주세요.' });
      await store.putState(code, rec);
      const sum = normalizeChunkSummary(b.summary);
      if (sum) { const srec = { summary: sum, updatedAt: rec.updatedAt }; if (size(srec) <= SUMMARY_MAX_BYTES) await store.putSummary(code, srec); }
      return j(200, { ok: true, updatedAt: rec.updatedAt });
    }
    return j(404, { error: 'unknown api' });
  }

  if (!who) return j(401, { error: '로그인이 필요합니다.' });

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
  /* 학생이 자기 과제를 받는다 — 선생님이 정한 단계·글·카드. 없으면 null. */
  if (p === '/api/chunk/assign' && method === 'GET' && !who.admin) {
    const rec = await store.getAssign(who.code);
    return j(200, { assign: rec ? rec.assign : null, updatedAt: rec ? rec.updatedAt : null });
  }

  /* 선생님 지문 목록 — 학생·관리자 모두 받는다(교재 페이지는 어느 토큰으로든 연다). 정적 지문처럼 원문이 그대로 간다 — 자체 창작·원내 자료뿐이다. */
  if (p === '/api/chunk/custom' && method === 'GET') {
    const rec = await store.getCustoms();
    return j(200, { custom: customList(rec), updatedAt: rec ? rec.updatedAt : null });
  }

  if (p.startsWith('/api/chunk/admin/')) {
    if (!who.admin) return j(403, { error: '관리자만 쓸 수 있어요.' });
    if (p === '/api/chunk/admin/custom' && method === 'GET') {
      const rec = await store.getCustoms();
      return j(200, { custom: customList(rec), updatedAt: rec ? rec.updatedAt : null });
    }
    const mc = p.match(/^\/api\/chunk\/admin\/custom(?:\/([a-z0-9-]{2,24}))?$/);
    if (mc && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
      const rec = (await store.getCustoms()) || { items: {}, updatedAt: null };
      if (!isObj(rec.items)) rec.items = {};
      const id = mc[1];
      if (method === 'DELETE') {
        if (!id || !rec.items[id]) return j(404, { error: '지문 없음' });
        delete rec.items[id]; rec.updatedAt = nowIso(); await store.putCustoms(rec);
        return j(200, { ok: true, updatedAt: rec.updatedAt });
      }
      if (method === 'POST' && id) return j(404, { error: 'unknown api' });
      if (method === 'PUT' && (!id || !rec.items[id])) return j(404, { error: '지문 없음' });
      const b = await body();
      if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
      const pid = method === 'POST' ? newCustomId() : id;
      const n = normalizePassage(b, pid);
      if (n.error) return j(400, { error: n.error });
      if (method === 'POST' && Object.keys(rec.items).length >= CUSTOM_MAX) return j(409, { error: '선생님 지문은 ' + CUSTOM_MAX + '편까지예요. 안 쓰는 글을 지워 주세요.' });
      rec.items[pid] = n.passage; rec.updatedAt = nowIso();
      await store.putCustoms(rec);
      return j(200, { ok: true, passage: n.passage, updatedAt: rec.updatedAt });
    }
    if (p === '/api/chunk/admin/overview' && method === 'GET') {
      const codes = await store.listSummaryCodes();
      /* 과제만 있고 아직 연습 기록이 없는 학생도 표에 올라야 선생님이 과제 상태를 본다 */
      if (store.listAssignCodes) for (const c of await store.listAssignCodes()) if (!codes.includes(c)) codes.push(c);
      /* 아직 시작하지 않은 학생도 명단째 올린다 — 첫 과제를 코드를 손으로 치지 않고 줄 수 있게. 외부 학생(apps 배열)은 chunk 가 있어야 */
      if (store.listStudentCodes) for (const c of await store.listStudentCodes()) if (!codes.includes(c)) codes.push(c);
      const rows = [];
      for (const c of codes) {
        const stu = await store.getStudent(c);
        if (!stu) continue;                         /* 퇴원 등으로 명단에서 빠진 학생은 내보내지 않는다 */
        if (Array.isArray(stu.apps) && !stu.apps.includes('chunk')) continue;
        rows.push(chunkOverviewRow(c, stu, await store.getSummary(c), await store.getAssign(c)));
      }
      rows.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
      return j(200, { rows, updatedAt: nowIso() });
    }
    /* 가족 링크 발급 — 학생 레코드의 ptoken 을 쓰고, 없으면 만든다(진로독서·브레인레터와 같은 토큰이라 가정마다 링크 하나) */
    const mp = p.match(/^\/api\/chunk\/admin\/parentlink\/([A-Za-z0-9-]{3,20})$/);
    if (mp && method === 'POST') {
      const stu = await store.getStudent(mp[1]);
      if (!stu) return j(404, { error: '학생 없음' });
      let ptoken = stu.ptoken, created = false;
      if (!ptoken) {
        ptoken = globalThis.crypto.randomUUID().replace(/-/g, '');
        await store.putParent(ptoken, mp[1]);
        await store.putStudent(mp[1], { ...stu, ptoken });
        created = true;
      }
      return j(200, { ptoken, path: '/chunk/?t=' + ptoken, created, name: stu.name || '' });
    }
    const ms = p.match(/^\/api\/chunk\/admin\/student\/([A-Za-z0-9-]{3,20})$/);
    if (ms && method === 'GET') {
      const rec = await store.getState(ms[1]);
      if (!rec) return j(404, { error: '기록 없음' });
      return j(200, { state: rec.state, updatedAt: rec.updatedAt });
    }
    const ma = p.match(/^\/api\/chunk\/admin\/assign\/([A-Za-z0-9-]{3,20})$/);
    if (ma && method === 'GET') {
      const rec = await store.getAssign(ma[1]);
      return j(200, { assign: rec ? rec.assign : null, updatedAt: rec ? rec.updatedAt : null });
    }
    if (ma && method === 'PUT') {
      const code = ma[1];
      if (!CODE_RE.test(code) || !(await store.getStudent(code))) return j(404, { error: '학생 없음' });
      const b = await body();
      if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
      const n = normalizeAssign(b);
      if (n.error) return j(400, { error: n.error });
      if (!n.assign) { await store.deleteAssign(code); return j(200, { ok: true, assign: null, updatedAt: null }); }
      const rec = { assign: n.assign, updatedAt: nowIso() };
      await store.putAssign(code, rec);
      return j(200, { ok: true, assign: rec.assign, updatedAt: rec.updatedAt });
    }
    return j(404, { error: 'unknown api' });
  }
  return j(404, { error: 'unknown api' });
}

/* 퇴원·파기 — 이 학생의 청크 기록 키 전부 */
export async function dropStudentChunk(store, code) {
  if (store.deleteState) await store.deleteState(code);
  if (store.deleteSummary) await store.deleteSummary(code);
  if (store.deleteAssign) await store.deleteAssign(code);
}
