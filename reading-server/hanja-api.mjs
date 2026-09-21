'use strict';
/* WB 한자브레인 — /api/hanja/* 라우트 (server.mjs·worker.mjs 공용, 워드브레인과 같은 "분리 가능한" 구조)
   격리 원칙: 라우트는 /api/hanja/* 아래, 데이터는 hanja 전용 저장소(워커: hanja: 접두 키, 로컬: db.hanja)만 쓴다.
   인증은 호스트의 토큰 검증 결과(who)를 받고, apps 게이트(allowedApp)는 호스트가 who 검증 직후 한 곳에서 건다.

   단어장(문제집 한 권의 낱말·한자)은 라이선스 자료라 저장소·정적 자산에 없다 — 관리 웹 업로드로만 들어와
   KV(hanja:book:<id>)에 살고, 학생은 토큰으로만 받는다(CLAUDE.md 절대 규칙 1·3). 검사 규칙은 hanja/book-check.js
   하나다(CLI 검증기·미리보기와 같은 판정). 목록(hanja:books)은 본문 없는 메타만 담아 목록 조회가 본문을 읽지 않게 한다.

   공개 범위(scope): 'all' = 연동 학생 모두 · 'assigned' = 배정한 학생만. 교재를 산 학생에게만 열어야 할 때 쓴다.

   응답 래핑 계약: /books → {books, updatedAt} · /book → {book, updatedAt} · /pull → {state, updatedAt}. */

import CHECK from '../hanja/book-check.js';

const STATE_MAX_BYTES = 400_000;         // 학생 기록 1건 최대 (워드브레인과 같은 400KB)
export const BOOK_MAX_BYTES = 1_572_864; // 단어장 1권 최대 (1.5MB — 낱말 3000·한자 2000 이 넉넉히 든다)
export const BODY_LIMIT_BOOK = 2_097_152;   // 2MB — /admin/book (텍스트 붙여넣기 포함)
export const BODY_LIMIT_DEFAULT = 450_000;  // 나머지 (기록 400KB + 포장)
export const hanjaBodyLimit = (p) => (p === '/api/hanja/admin/book' ? BODY_LIMIT_BOOK : BODY_LIMIT_DEFAULT);

const ID_RE = CHECK.ID_RE;
const SCOPES = ['all', 'assigned'];
const ASSIGN_MAX = 30;                    // 학생 하나에 배정하는 단어장 상한
const nowIso = () => new Date().toISOString();
const byteLen = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/* ── 학생별 요약 (관리 현황판용) — 학생 기기가 올린 state 를 읽어 숫자만 뽑는다 ── */
const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 90];
export function hanjaSummary(stateRec, now) {
  const base = { linked: !!stateRec, total: 0, words: 0, chars: 0, graduated: 0, due: 0, emergency: 0, traced: 0, streak: 0, books: [], lastActive: stateRec ? stateRec.updatedAt : null };
  const S = stateRec && stateRec.state;
  if (!S || !isObj(S)) return base;
  const t = now == null ? Date.now() : now;
  const books = new Set();
  for (const [id, s] of Object.entries(isObj(S.states) ? S.states : {})) {
    if (!isObj(s)) continue;
    base.total += 1;
    if (id.startsWith('c:')) base.chars += 1; else { base.words += 1; const m = id.match(/^w:([^:]+):/); if (m) books.add(m[1]); }
    if (s.graduated) { base.graduated += 1; continue; }
    const due = Number(s.due) || 0;
    if (due <= t) {
      base.due += 1;
      const iv = Math.max(INTERVAL_DAYS[Math.min(Number(s.step) || 0, 6)] || 0, 0.5) * 86400000;
      if ((t - due) / iv >= 1.25) base.emergency += 1;
    }
  }
  base.traced = Object.keys(isObj(S.trace) ? S.trace : {}).length;
  base.streak = (isObj(S.streak) && Number(S.streak.count)) || 0;
  base.books = [...books].slice(0, 20);
  return base;
}

/* 목록 항목 — 본문 없는 메타 + 공개 범위 + 갱신 시각 */
function indexEntry(book, scope, updatedAt) {
  return { ...CHECK.bookMeta(book), scope, updatedAt };
}

async function readIndex(store) {
  const idx = await store.getBookIds();
  return Array.isArray(idx) ? idx.filter((e) => isObj(e) && ID_RE.test(String(e.id || ''))) : [];
}

/* ctx = { path, method, who:{code,admin}|null, query?, getBody(), store }
   store 계약: getBook(id)·putBook(id,rec)·deleteBook(id)·getBookIds()·putBookIds(list)
              getState(code)·putState(code,rec)·listStateCodes()
              getAssign(code)·putAssign(code,rec)·deleteAssign(code)·listAssignCodes()·getStudent(code)
   반환: { status, body } — /api/hanja/* 가 아닌 경로는 호출 전에 호스트가 거른다. */
export async function handleHanja(ctx) {
  const { path: p, method, who, store } = ctx;
  const j = (status, body) => ({ status, body });
  if (!who) return j(401, { error: '로그인이 필요합니다.' });
  const body = async () => { try { const b = await ctx.getBody(); return isObj(b) ? b : {}; } catch (e) { return null; } };
  const q = (k) => String((ctx.query && ctx.query.get && ctx.query.get(k)) || '').trim();

  /* ── 학생 ── */
  if (!who.admin) {
    if (p === '/api/hanja/pull' && method === 'GET') {
      const st = await store.getState(who.code);
      return j(200, { state: st ? st.state : null, updatedAt: st ? st.updatedAt : null });
    }
    if (p === '/api/hanja/state' && method === 'PUT') {
      const b = await body();
      if (!b) return j(400, { error: '요청 본문이 JSON 이 아니에요.' });
      const { state } = b;
      if (!isObj(state)) return j(400, { error: 'state 필요' });
      const rec = { state, updatedAt: nowIso() };
      if (byteLen(rec) > STATE_MAX_BYTES) return j(413, { error: '기록이 너무 커서 저장할 수 없어요.' });
      await store.putState(who.code, rec);
      return j(200, { ok: true, updatedAt: rec.updatedAt });
    }
    /* 단어장 목록 — 공개 범위가 '모두'인 것 + 내게 배정된 것. 배정된 것은 mine 으로 표시해 앞에 세운다 */
    if (p === '/api/hanja/books' && method === 'GET') {
      const mine = new Set(((await store.getAssign(who.code)) || {}).bookIds || []);
      const books = (await readIndex(store))
        .filter((e) => e.scope !== 'assigned' || mine.has(e.id))
        .map((e) => ({ ...e, mine: mine.has(e.id) }))
        .sort((a, b) => (a.mine === b.mine ? (a.updatedAt < b.updatedAt ? 1 : -1) : (a.mine ? -1 : 1)));
      return j(200, { books, updatedAt: books.reduce((m, e) => (e.updatedAt > m ? e.updatedAt : m), '') || null });
    }
    if (p === '/api/hanja/book' && method === 'GET') {
      const id = q('id');
      if (!ID_RE.test(id)) return j(400, { error: '단어장 id 가 필요해요.' });
      const entry = (await readIndex(store)).find((e) => e.id === id);
      const rec = entry && await store.getBook(id);
      if (!entry || !rec) return j(404, { error: '없는 단어장이에요.' });
      if (entry.scope === 'assigned') {
        const mine = ((await store.getAssign(who.code)) || {}).bookIds || [];
        if (!mine.includes(id)) return j(403, { error: '이 단어장은 배정받은 학생만 열 수 있어요.' });
      }
      return j(200, { book: rec.book, updatedAt: rec.updatedAt || null });
    }
    return j(p.startsWith('/api/hanja/admin/') ? 403 : 404, { error: p.startsWith('/api/hanja/admin/') ? '권한이 없습니다.' : 'unknown api' });
  }

  /* ── 관리자 (강사) ── */
  /* 단어장 업로드 — JSON 한 벌({book}) 또는 붙여넣기({text, id, title, …}). dryRun 이면 검사 결과만 돌려준다.
     같은 id 재업로드는 덮어쓴다(공개 범위·배정은 유지) — 되묻는 것은 관리 웹의 confirm 몫. */
  if (p === '/api/hanja/admin/book' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '요청 본문이 JSON 이 아니에요.' });
    let res;
    if (isObj(b.book)) res = CHECK.checkBook(b.book);
    else if (typeof b.text === 'string') res = CHECK.parseBookText(b.text, { id: b.id, title: b.title, publisher: b.publisher, level: b.level, note: b.note });
    else return j(400, { error: 'book(JSON) 또는 text(붙여넣기)가 필요해요.' });
    const preview = { summary: res.summary, warns: res.warns, errors: res.errors, counts: res.counts || null, meta: res.book ? CHECK.bookMeta(res.book) : null };
    if (b.dryRun) return j(200, { ok: res.ok, preview: true, ...preview });
    if (!res.ok) return j(400, { error: '단어장에 오류가 있어요 — 고친 뒤 다시 올려 주세요.', ...preview });
    const book = res.book;
    if (byteLen(book) > BOOK_MAX_BYTES) return j(413, { error: '단어장이 너무 커요 (1.5MB 이내) — 권을 나누세요.' });
    const updatedAt = nowIso();
    const idx = await readIndex(store);
    const prev = idx.find((e) => e.id === book.id);
    const scope = prev && SCOPES.includes(prev.scope) ? prev.scope : (SCOPES.includes(b.scope) ? b.scope : 'all');
    await store.putBook(book.id, { book, updatedAt });
    const entry = indexEntry(book, scope, updatedAt);
    await store.putBookIds(prev ? idx.map((e) => (e.id === book.id ? entry : e)) : idx.concat([entry]));
    return j(200, { ok: true, id: book.id, updatedAt, replaced: !!prev, ...preview });
  }
  if (p === '/api/hanja/admin/books' && method === 'GET') {
    return j(200, { books: await readIndex(store), time: nowIso() });
  }
  if (p === '/api/hanja/admin/book' && method === 'GET') {
    const id = q('id');
    if (!ID_RE.test(id)) return j(400, { error: '단어장 id 가 필요해요.' });
    const rec = await store.getBook(id);
    if (!rec) return j(404, { error: '없는 단어장이에요.' });
    const entry = (await readIndex(store)).find((e) => e.id === id);
    return j(200, { book: rec.book, updatedAt: rec.updatedAt || null, scope: (entry && entry.scope) || 'all' });
  }
  /* 삭제 — 본문·목록·모든 학생의 배정에서 뺀다. 학생 기록(SRS)은 남는다: 다시 올리면 그대로 이어진다 */
  if (p === '/api/hanja/admin/book' && method === 'DELETE') {
    const b = await body();
    const id = String((b && b.id) || '').trim();
    if (!ID_RE.test(id)) return j(400, { error: '단어장 id 가 필요해요.' });
    const idx = await readIndex(store);
    if (!idx.some((e) => e.id === id) && !(await store.getBook(id))) return j(404, { error: '없는 단어장이에요.' });
    await store.deleteBook(id);
    await store.putBookIds(idx.filter((e) => e.id !== id));
    let unassigned = 0;
    for (const code of await store.listAssignCodes()) {
      const rec = await store.getAssign(code);
      const ids = (rec && rec.bookIds) || [];
      if (!ids.includes(id)) continue;
      const next = ids.filter((x) => x !== id);
      if (next.length) await store.putAssign(code, { bookIds: next, updatedAt: nowIso() });
      else await store.deleteAssign(code);
      unassigned += 1;
    }
    return j(200, { ok: true, id, unassigned });
  }
  if (p === '/api/hanja/admin/scope' && method === 'POST') {
    const b = await body();
    const id = String((b && b.id) || '').trim(), scope = String((b && b.scope) || '');
    if (!ID_RE.test(id)) return j(400, { error: '단어장 id 가 필요해요.' });
    if (!SCOPES.includes(scope)) return j(400, { error: '공개 범위는 all(연동 학생 모두) 또는 assigned(배정한 학생만)' });
    const idx = await readIndex(store);
    if (!idx.some((e) => e.id === id)) return j(404, { error: '없는 단어장이에요.' });
    await store.putBookIds(idx.map((e) => (e.id === id ? { ...e, scope } : e)));
    return j(200, { ok: true, id, scope });
  }
  /* 배정 — 학생들에게 단어장을 더하거나(add) 뺀다(remove). 없는 단어장은 거절, 없는 학생은 건너뛴다 */
  if (p === '/api/hanja/admin/assign' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '요청 본문이 JSON 이 아니에요.' });
    const codes = (Array.isArray(b.codes) ? b.codes : []).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 200);
    const bookIds = (Array.isArray(b.bookIds) ? b.bookIds : []).map((c) => String(c || '').trim()).filter(Boolean).slice(0, ASSIGN_MAX);
    const action = b.action === 'remove' ? 'remove' : 'add';
    if (!codes.length) return j(400, { error: '학생을 골라 주세요.' });
    if (!bookIds.length) return j(400, { error: '단어장을 골라 주세요.' });
    const known = new Set((await readIndex(store)).map((e) => e.id));
    const unknown = bookIds.filter((id) => !known.has(id));
    if (unknown.length) return j(400, { error: '없는 단어장이에요: ' + unknown.join(', ') });
    const assigned = [];
    for (const code of codes) {
      if (!(await store.getStudent(code))) continue;
      const rec = (await store.getAssign(code)) || { bookIds: [] };
      const cur = Array.isArray(rec.bookIds) ? rec.bookIds : [];
      const next = action === 'add' ? [...new Set(cur.concat(bookIds))].slice(0, ASSIGN_MAX) : cur.filter((id) => !bookIds.includes(id));
      if (next.length) await store.putAssign(code, { bookIds: next, updatedAt: nowIso() });
      else await store.deleteAssign(code);
      assigned.push(code);
    }
    if (!assigned.length) return j(404, { error: '등록된 학생이 없어요.' });
    return j(200, { ok: true, action, assigned, bookIds });
  }
  if (p === '/api/hanja/admin/assign' && method === 'GET') {
    const items = [];
    for (const code of await store.listAssignCodes()) {
      const rec = await store.getAssign(code);
      const stu = await store.getStudent(code);
      if (!rec || !(rec.bookIds || []).length) continue;
      items.push({ code, name: (stu && stu.name) || '', cls: (stu && stu.cls) || '', bookIds: rec.bookIds, updatedAt: rec.updatedAt || null });
    }
    items.sort((a, b) => (a.cls === b.cls ? (a.name < b.name ? -1 : 1) : (a.cls < b.cls ? -1 : 1)));
    return j(200, { items });
  }
  if (p === '/api/hanja/admin/overview' && method === 'GET') {
    const students = [];
    for (const code of await store.listStateCodes()) {
      const [stu, st, as] = await Promise.all([store.getStudent(code), store.getState(code), store.getAssign(code)]);
      students.push({ code, name: (stu && stu.name) || '', cls: (stu && stu.cls) || '', assigned: (as && as.bookIds) || [], ...hanjaSummary(st) });
    }
    students.sort((a, b) => (a.cls === b.cls ? (a.name < b.name ? -1 : 1) : (a.cls < b.cls ? -1 : 1)));
    return j(200, { students, time: nowIso() });
  }
  return j(404, { error: 'unknown api' });
}

/* 퇴원 — 이 학생의 기록·배정만 지운다. 단어장은 학생 것이 아니라 그대로 둔다 */
export async function dropStudentHanja(store, code) {
  await Promise.all([store.deleteState(code), store.deleteAssign(code)]);
}

/* 백업 스냅샷용 덤프 — 단어장 본문은 싣지 않는다(라이선스 자료가 백업 파일로 흩어지지 않게, 내신 팩과 같은 이유).
   목록(메타)·학생 기록·배정만 담는다 — 복구 뒤 원장이 원본 JSON 을 다시 올리면 그대로 이어진다. */
export async function dumpHanja(store) {
  const index = await readIndex(store);
  const states = {}, assigns = {};
  for (const code of await store.listStateCodes()) states[code] = await store.getState(code);
  for (const code of await store.listAssignCodes()) assigns[code] = await store.getAssign(code);
  return { bookIds: index.map((e) => e.id), index, states, assigns };
}
