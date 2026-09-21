'use strict';
/* WB 한자브레인 — /api/hanja/* 라우트 (server.mjs·worker.mjs 공용, 워드브레인과 같은 "분리 가능한" 구조)
   격리 원칙: 라우트는 /api/hanja/* 아래, 데이터는 hanja 전용 저장소(워커: hanja: 접두 키, 로컬: db.hanja)만 쓴다.
   인증은 호스트의 토큰 검증 결과(who)를 받고, apps 게이트(allowedApp)는 호스트가 who 검증 직후 한 곳에서 건다.

   단어장(문제집 한 권의 낱말·한자)은 라이선스 자료라 저장소·정적 자산에 없다 — 관리 웹 업로드로만 들어와
   KV(hanja:book:<id>)에 살고, 학생은 토큰으로만 받는다(CLAUDE.md 절대 규칙 1·3). 검사 규칙은 hanja/book-check.js
   하나다(CLI 검증기·미리보기와 같은 판정). 목록(hanja:books)은 본문 없는 메타만 담아 목록 조회가 본문을 읽지 않게 한다.

   저장 키(워커 접두 hanja:) — book:<id> 본문 · books 목록 · remap:<id> 재업로드 id 대응 · state:<code> 학생 기록 ·
   summary:<code> 기록 저장 시점의 요약(현황판이 기록 본문을 안 읽게) · assign:<code> 단어장 배정 · task:<scope> 이번 주 단원 ·
   strokes 공용 획순 사전 · push:<code> 밤 알림 구독.

   공개 범위(scope): 'all' = 연동 학생 모두 · 'assigned' = 배정한 학생만. 교재를 산 학생에게만 열어야 할 때 쓴다.
   응답 래핑 계약: /books → {books, updatedAt} · /book → {book, updatedAt, remap} · /pull → {state, updatedAt} ·
   /task → {task, scope} · /strokes → {strokes, updatedAt}. */

import CHECK from '../hanja/book-check.js';

const STATE_MAX_BYTES = 400_000;         // 학생 기록 1건 최대 (워드브레인과 같은 400KB)
export const BOOK_MAX_BYTES = 1_572_864; // 단어장 1권 최대 (1.5MB — 낱말 3000·한자 2000 이 넉넉히 든다)
export const STROKES_MAX_BYTES = 3_145_728; // 획순 사전 최대 (3MB — 글자 5000자)
export const BODY_LIMIT_BOOK = 2_097_152;   // 2MB — /admin/book (텍스트 붙여넣기 포함)
export const BODY_LIMIT_STROKES = 4_194_304; // 4MB — /admin/strokes (변환기 산출물)
export const BODY_LIMIT_DEFAULT = 450_000;  // 나머지 (기록 400KB + 포장)
export const hanjaBodyLimit = (p) => (p === '/api/hanja/admin/book' ? BODY_LIMIT_BOOK : p === '/api/hanja/admin/strokes' ? BODY_LIMIT_STROKES : BODY_LIMIT_DEFAULT);

const ID_RE = CHECK.ID_RE;
const CODE_RE = /^[A-Za-z0-9-]{3,20}$/;
const SCOPES = ['all', 'assigned'];
const SOURCES = CHECK.SOURCES;   /* 단어장 종류 own(자체)·textbook(교재) — book-check 와 같은 목록 */
const BULK_MAX = 50;   /* 공개 범위를 한 번에 바꿀 수 있는 권수 — 목록 한 벌을 다시 쓰는 일이라 상한을 둔다 */
const ASSIGN_MAX = 30;                    // 학생 하나에 배정하는 단어장 상한
const STROKES_MAX_CHARS = 5000;
const nowIso = () => new Date().toISOString();
const byteLen = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/* 학원 달력은 KST — 마감·오늘 판정을 기기 시간대에 맡기지 않는다(내신 todayKst 와 같은 규칙) */
export const todayKst = (now) => new Date((now == null ? Date.now() : +now) + 9 * 3600e3).toISOString().slice(0, 10);
export function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

/* ── 학생별 요약 (관리 현황판용) — 기록 저장 시점에 서버가 계산해 작은 키에 둔다 ── */
const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 90];

/* 교재 점검 한 건 — 학생 앱이 db.checks['<단어장>|<단원>'] 에 단원마다 마지막 점수만 남긴다.
   학생 기기가 올린 값이라 서버가 화이트리스트로 조인다: 모르는 키는 버리고, 문항 수·정답 수는 앞뒤가 맞는 정수만 남긴다. */
export function normCheck(c) {
  if (!isObj(c)) return null;
  const n = Math.round(Number(c.n) || 0);
  if (!(n > 0) || n > 1000) return null;
  const right = Math.round(Number(c.right) || 0);
  const at = Math.round(Number(c.at) || 0);
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return { book: str(c.book, 60), unit: str(c.unit, 60), title: str(c.title, 60), n, right: Math.max(0, Math.min(n, right)), at: at > 0 ? at : null };
}
export function checkList(stateRec) {
  const S = stateRec && stateRec.state;
  if (!S || !isObj(S.checks)) return [];
  return Object.values(S.checks).map(normCheck).filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0));
}
/* 단원 하나의 점검 점수 — 진도표가 '이번 주 단원을 몇 점으로 통과했나'를 학생별로 보여 준다 */
export function unitCheck(stateRec, bookId, unitId) {
  const S = stateRec && stateRec.state;
  const all = S && isObj(S.checks) ? S.checks : {};
  return normCheck(all[bookId + '|' + (unitId == null ? '' : unitId)]);
}
export function hanjaSummary(stateRec, now) {
  const base = { linked: !!stateRec, total: 0, words: 0, chars: 0, graduated: 0, due: 0, emergency: 0, traced: 0, streak: 0, checks: 0, lastCheck: null, books: [], lastActive: stateRec ? stateRec.updatedAt : null };
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
  const cks = checkList(stateRec);
  base.checks = cks.length;
  base.lastCheck = cks[0] || null;
  base.traced = Object.keys(isObj(S.trace) ? S.trace : {}).length;
  base.streak = (isObj(S.streak) && Number(S.streak.count)) || 0;
  base.books = [...books].slice(0, 20);
  return base;
}

/* 밤 9시 알림 판정 — 지금 만기인 항목이 있는가. 요약 키는 저장 시점 값이라 밤에는 낡아 있어 기록 본문으로 센다.
   오늘 이미 학습했으면(저장 시각이 오늘) 부르지 않는다 — 자기 전 3분은 안 한 학생을 위한 것이다. */
export function hanjaNightDue(stateRec, now) {
  const S = stateRec && stateRec.state;
  if (!S || !isObj(S.states)) return { due: false, left: 0, reason: 'no-state' };
  const t = now == null ? Date.now() : +now;
  let left = 0;
  for (const s of Object.values(S.states)) if (isObj(s) && !s.graduated && (Number(s.due) || 0) <= t) left += 1;
  if (!left) return { due: false, left: 0, reason: 'done' };
  const savedAt = stateRec.updatedAt ? Date.parse(stateRec.updatedAt) : NaN;
  if (!isNaN(savedAt) && todayKst(savedAt) === todayKst(t)) return { due: false, left, reason: 'studied-today' };
  return { due: true, left, reason: 'due' };
}
export async function hanjaNightDueFor(store, code, now) {
  if (!store || typeof store.getState !== 'function') return { due: false, left: 0, reason: 'no-store' };
  return hanjaNightDue(await store.getState(code), now);
}

/* 목록 항목 — 본문 없는 메타 + 공개 범위 + 갱신 시각 */
function indexEntry(book, scope, updatedAt) {
  return { ...CHECK.bookMeta(book), scope, updatedAt };
}
/* 요청 본문의 id 하나 또는 ids 목록 → 중복 없는 id 배열. 옛 클라이언트({id})와 새 클라이언트({ids})가 같은 라우트를 쓴다 */
function idList(b) {
  const raw = Array.isArray(b && b.ids) ? b.ids : (b && b.id != null ? [b.id] : []);
  const out = [];
  for (const x of raw) {
    const id = String(x == null ? '' : x).trim();
    if (ID_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
async function readIndex(store) {
  const idx = await store.getBookIds();
  return Array.isArray(idx) ? idx.filter((e) => isObj(e) && ID_RE.test(String(e.id || ''))) : [];
}

/* 목록(hanja:books) 고치기 — 읽고 고쳐 다시 쓴다. 이 구조에는 두 가지 함정이 있고 둘을 갈라 다뤄야 한다.
   ① 읽기가 옛 값일 수 있다 — KV 는 지역마다 최대 60초쯤 앞의 쓰기를 못 본 값을 돌려준다. 이것은 화면 문제다:
      바꾼 직후 목록이 옛 범위를 보여 줄 수 있고, 잠시 뒤 새로 고치면 맞다. 되읽기로 확인해 봐도 그 읽기가 옛 값이면
      「안 됐다」는 잘못된 판정이 나온다.
   ② 그 옛 값 위에 쓰면 진짜로 잃는다 — 뒤의 요청이 앞의 변경이 빠진 목록을 그대로 되쓰면 앞의 변경이 사라진다.
      12권을 한 권씩 연달아 바꾸다 실제로 겪었다(성공 응답 12번, 남은 것 2건).
   그래서 **여러 권은 한 번의 쓰기로** 고친다 — 요청이 하나면 자기 자신과 경합할 일이 없다.
   되읽기는 확인(applied)까지만 하고 **되쓰지 않는다**: 옛 값 위에 한 번 더 쓰는 것이 바로 ②를 만드는 일이라,
   확인이 늦은 것을 고치려다 다른 사람의 변경을 지우게 된다. applied 가 false 면 「아직 확인 못 했다」는 뜻이다. */
async function editIndex(store, patch) {
  const idx = await readIndex(store);
  const next = idx.map((e) => (patch[e.id] ? { ...e, ...patch[e.id] } : e));
  await store.putBookIds(next);
  const fits = (list) => list.every((e) => !patch[e.id] || Object.entries(patch[e.id]).every(([k, v]) => e[k] === v));
  return { entries: next, applied: fits(await readIndex(store)) };
}

/* 재업로드 id 대응 — 낱말 텍스트(낱말|한자)가 같은데 id 가 달라진 것을 옛 id → 새 id 로 잇는다.
   순번 id 로 만든 옛 단어장을 내용 기반 id 로 다시 올릴 때, 그리고 강사가 명시 id 를 바꿨을 때
   학생의 기억 기록(w:<단어장>:<id>)이 다른 낱말을 가리키거나 사라지지 않게 한다.
   이미 있던 대응(o→m)은 새 대응(m→n)을 따라 o→n 으로 이어 붙이고, 새 단어장에 없는 목적지는 버린다. */
export function buildRemap(prevBook, nextBook, prevRemap) {
  const keyOf = (w) => w.word + '|' + (w.hanja || '');
  const nextByKey = new Map(), nextIds = new Set();
  for (const w of (nextBook && nextBook.words) || []) { nextByKey.set(keyOf(w), w.id); nextIds.add(w.id); }
  const map = {};
  for (const w of (prevBook && prevBook.words) || []) {
    const nid = nextByKey.get(keyOf(w));
    if (nid && nid !== w.id) map[w.id] = nid;
  }
  for (const [o, m] of Object.entries(isObj(prevRemap) ? prevRemap : {})) {
    if (map[o]) continue;
    const n = map[m] || m;
    if (nextIds.has(n) && n !== o) map[o] = n;
  }
  return map;
}

/* 단원 하나의 학습 항목 SRS id — 학생 앱 itemsOf 와 같은 규칙(낱말 + 직접 적은 한자, 끌어낸 한자는 참고) */
export function unitItemIds(book, unitId) {
  const out = [];
  for (const w of (book && book.words) || []) if (w.unit === unitId) out.push('w:' + book.id + ':' + w.id);
  for (const c of (book && book.chars) || []) if (!c.derived && c.unit === unitId) out.push('c:' + c.ch);
  return out;
}
export function unitProgress(stateRec, itemIds, now) {
  const S = stateRec && stateRec.state, states = (S && isObj(S.states)) ? S.states : {};
  const t = now == null ? Date.now() : +now;
  const p = { total: itemIds.length, planted: 0, graduated: 0, due: 0 };
  for (const id of itemIds) {
    const s = states[id];
    if (!isObj(s)) continue;
    p.planted += 1;
    if (s.graduated) p.graduated += 1; else if ((Number(s.due) || 0) <= t) p.due += 1;
  }
  return p;
}

/* 이번 주 단원(task) — 학생 코드 → 반 → default 순으로 찾는다(내신 resolveExam 과 같은 폴백) */
export async function resolveTask(store, code, stu) {
  if (typeof code === 'string' && code) {
    const mine = await store.getTask(code);
    if (isObj(mine) && mine.bookId) return { task: mine, scope: 'student' };
  }
  const cls = stu && typeof stu.cls === 'string' ? stu.cls.trim() : '';
  if (cls && cls !== 'default') {
    const byCls = await store.getTask(cls);
    if (isObj(byCls) && byCls.bookId) return { task: byCls, scope: 'class' };
  }
  const def = await store.getTask('default');
  if (isObj(def) && def.bookId) return { task: def, scope: 'default' };
  return { task: {}, scope: null };
}

/* ctx = { path, method, who:{code,admin}|null, query?, getBody(), store, push? }
   store 계약: getBook·putBook·deleteBook·getBookIds·putBookIds · getRemap·putRemap·deleteRemap
              getState·putState·deleteState·listStateCodes · getSummary·putSummary·deleteSummary·listSummaryCodes
              getAssign·putAssign·deleteAssign·listAssignCodes · getTask·putTask·deleteTask·listTaskScopes
              getStrokes·putStrokes · getPush·putPush·delPush·listPushCodes · getStudent·listStudentCodes
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
      /* 요약은 저장 시점에 한 번 — 현황판이 학생 수만큼 기록 본문을 읽지 않게 */
      await store.putSummary(who.code, { ...hanjaSummary(rec), updatedAt: rec.updatedAt });
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
      const remap = (await store.getRemap(id)) || null;
      return j(200, { book: rec.book, updatedAt: rec.updatedAt || null, remap: remap && isObj(remap.map) && Object.keys(remap.map).length ? remap.map : null });
    }
    if (p === '/api/hanja/task' && method === 'GET') {
      const stu = await store.getStudent(who.code);
      const { task, scope } = await resolveTask(store, who.code, stu);
      return j(200, { task, scope });
    }
    if (p === '/api/hanja/strokes' && method === 'GET') {
      const rec = await store.getStrokes();
      return j(200, { strokes: (rec && isObj(rec.strokes)) ? rec.strokes : {}, updatedAt: rec ? rec.updatedAt || null : null });
    }
    /* 밤 9시 알림 (Web Push 구독) — 워드브레인과 같은 방식, 저장 키만 hanja:push:<code> */
    if (p === '/api/hanja/push/key' && method === 'GET') {
      const key = ctx.push && ctx.push.publicKey;
      return j(200, key ? { ok: true, key } : { ok: false, reason: 'no-vapid' });
    }
    if (p === '/api/hanja/push/subscribe' && method === 'POST') {
      const b = await body();
      const subscription = b && b.subscription;
      const ep = subscription && String(subscription.endpoint || '');
      if (!ep || ep.length > 500 || !/^https:\/\//.test(ep)) return j(400, { error: '유효한 구독이 아니에요.' });
      await store.putPush(who.code, { endpoint: ep, at: nowIso() });
      return j(200, { ok: true });
    }
    if (p === '/api/hanja/push/unsubscribe' && method === 'POST') {
      await store.delPush(who.code);
      return j(200, { ok: true });
    }
    return j(p.startsWith('/api/hanja/admin/') ? 403 : 404, { error: p.startsWith('/api/hanja/admin/') ? '권한이 없습니다.' : 'unknown api' });
  }

  /* ── 관리자 (강사) ── */
  /* 단어장 업로드 — JSON 한 벌({book}) 또는 붙여넣기({text, id, title, …}). dryRun 이면 검사 결과만 돌려준다.
     같은 id 재업로드는 덮어쓴다(공개 범위·배정은 유지, 바뀐 낱말 id 는 remap 으로 잇는다) — 되묻는 것은 관리 웹의 confirm 몫. */
  if (p === '/api/hanja/admin/book' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '요청 본문이 JSON 이 아니에요.' });
    let res;
    /* 종류(source)는 JSON 에 적힌 값이 먼저, 없으면 관리 웹 선택값 — 둘 다 없으면 검사기가 교재로 둔다 */
    if (isObj(b.book)) res = CHECK.checkBook(b.book.source == null && b.source ? { ...b.book, source: b.source } : b.book);
    else if (typeof b.text === 'string') res = CHECK.parseBookText(b.text, { id: b.id, title: b.title, publisher: b.publisher, level: b.level, note: b.note, source: b.source });
    else return j(400, { error: 'book(JSON) 또는 text(붙여넣기)가 필요해요.' });
    const preview = { summary: res.summary, warns: res.warns, errors: res.errors, counts: res.counts || null, meta: res.book ? CHECK.bookMeta(res.book) : null };
    if (b.dryRun) return j(200, { ok: res.ok, preview: true, ...preview });
    if (!res.ok) return j(400, { error: '단어장에 오류가 있어요 — 고친 뒤 다시 올려 주세요.', ...preview });
    const book = res.book;
    if (byteLen(book) > BOOK_MAX_BYTES) return j(413, { error: '단어장이 너무 커요 (1.5MB 이내) — 권을 나누세요.' });
    const updatedAt = nowIso();
    const idx = await readIndex(store);
    const prev = idx.find((e) => e.id === book.id);
    const prevRec = prev ? await store.getBook(book.id) : null;
    let remapped = 0;
    if (prevRec && prevRec.book) {
      const prevRemap = await store.getRemap(book.id);
      const map = buildRemap(prevRec.book, book, prevRemap && prevRemap.map);
      remapped = Object.keys(map).length;
      if (remapped) await store.putRemap(book.id, { map, updatedAt }); else if (prevRemap) await store.deleteRemap(book.id);
    }
    const scope = prev && SCOPES.includes(prev.scope) ? prev.scope : (SCOPES.includes(b.scope) ? b.scope : 'all');
    await store.putBook(book.id, { book, updatedAt });
    const entry = indexEntry(book, scope, updatedAt);
    await store.putBookIds(prev ? idx.map((e) => (e.id === book.id ? entry : e)) : idx.concat([entry]));
    return j(200, { ok: true, id: book.id, updatedAt, replaced: !!prev, remapped, ...preview });
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
  /* 삭제 — 본문·목록·모든 학생의 배정·이 단어장을 가리키는 단원 지정에서 뺀다. 학생 기록(SRS)은 남는다: 다시 올리면 그대로 이어진다 */
  if (p === '/api/hanja/admin/book' && method === 'DELETE') {
    const b = await body();
    const id = String((b && b.id) || '').trim();
    if (!ID_RE.test(id)) return j(400, { error: '단어장 id 가 필요해요.' });
    const idx = await readIndex(store);
    if (!idx.some((e) => e.id === id) && !(await store.getBook(id))) return j(404, { error: '없는 단어장이에요.' });
    await store.deleteBook(id);
    await store.deleteRemap(id);
    await store.putBookIds(idx.filter((e) => e.id !== id));
    let unassigned = 0, untasked = 0;
    for (const code of await store.listAssignCodes()) {
      const rec = await store.getAssign(code);
      const ids = (rec && rec.bookIds) || [];
      if (!ids.includes(id)) continue;
      const next = ids.filter((x) => x !== id);
      if (next.length) await store.putAssign(code, { bookIds: next, updatedAt: nowIso() });
      else await store.deleteAssign(code);
      unassigned += 1;
    }
    for (const scope of await store.listTaskScopes()) {
      const t = await store.getTask(scope);
      if (t && t.bookId === id) { await store.deleteTask(scope); untasked += 1; }
    }
    return j(200, { ok: true, id, unassigned, untasked });
  }
  /* 공개 범위 바꾸기 — id 하나 또는 ids 여러 개(한 번의 쓰기로). 여러 권을 한꺼번에 바꾸는 것이 기본 쓰임이다 */
  if (p === '/api/hanja/admin/scope' && method === 'POST') {
    const b = await body();
    const scope = String((b && b.scope) || '');
    if (!SCOPES.includes(scope)) return j(400, { error: '공개 범위는 all(연동 학생 모두) 또는 assigned(배정한 학생만)' });
    const ids = idList(b);
    if (!ids.length) return j(400, { error: '단어장 id(id 또는 ids)가 필요해요.' });
    if (ids.length > BULK_MAX) return j(400, { error: '한 번에 ' + BULK_MAX + '권까지만 바꿔요.' });
    const idx = await readIndex(store);
    const missing = ids.filter((x) => !idx.some((e) => e.id === x));
    if (missing.length) return j(404, { error: '없는 단어장이에요: ' + missing.slice(0, 5).join(', ') });
    const patch = {};
    ids.forEach((x) => { patch[x] = { scope }; });
    const { applied } = await editIndex(store, patch);
    return j(200, { ok: true, ids, scope, applied, ...(ids.length === 1 ? { id: ids[0] } : {}) });
  }
  /* 종류 바꾸기 — 자체(own)·교재(textbook). 학생 앱은 본문의 source 로 AI 연상 버튼을 가리므로 목록만 아니라 본문도 바꾸고
     updatedAt 을 올려 기기 캐시가 새 본문을 받게 한다. */
  if (p === '/api/hanja/admin/source' && method === 'POST') {
    const b = await body();
    const id = String((b && b.id) || '').trim(), source = String((b && b.source) || '');
    if (!ID_RE.test(id)) return j(400, { error: '단어장 id 가 필요해요.' });
    if (!SOURCES.includes(source)) return j(400, { error: '종류는 own(자체 단어장) 또는 textbook(교재 단어장)' });
    const idx = await readIndex(store);
    const rec = idx.some((e) => e.id === id) ? await store.getBook(id) : null;
    if (!rec || !rec.book) return j(404, { error: '없는 단어장이에요.' });
    const updatedAt = nowIso();
    await store.putBook(id, { book: { ...rec.book, source }, updatedAt });
    const { applied } = await editIndex(store, { [id]: { source, updatedAt } });
    return j(200, { ok: true, id, source, updatedAt, applied });
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

  /* 이번 주 단원 지정 — scope 는 'default'(전체) · 반 이름 · 학생 코드. 학생 앱 오늘 화면 맨 위에 뜬다.
     없는 단어장·단원을 지정하면 학생 앱이 열고 나서야 아는데 그때는 수업 중이다 — 저장 전에 걸러 준다. */
  if (p === '/api/hanja/admin/task' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '요청 본문이 JSON 이 아니에요.' });
    const scope = String(b.scope || '').trim();
    if (!scope || scope.length > 40 || /[:\n]/.test(scope)) return j(400, { error: 'scope 는 default·반 이름·학생 코드 (40자 이내)' });
    const bookId = String(b.bookId || '').trim();
    if (!ID_RE.test(bookId)) return j(400, { error: '단어장 id 가 필요해요.' });
    const rec = await store.getBook(bookId);
    if (!rec || !rec.book) return j(404, { error: '없는 단어장이에요.' });
    const unitId = String(b.unitId == null ? '' : b.unitId).trim();
    const unit = (rec.book.units || []).find((u) => u.id === unitId);
    if (!unit) return j(400, { error: '그 단어장에 없는 단원이에요: ' + unitId.slice(0, 40) });
    const due = String(b.due || '').trim();
    if (due && !isValidDate(due)) return j(400, { error: '마감(due)은 실제 날짜(YYYY-MM-DD)' });
    const title = String(b.title || '').trim().slice(0, 80) || (rec.book.title + ' · ' + unit.title);
    const task = { bookId, unitId, unitTitle: unit.title, bookTitle: rec.book.title, title, due: due || '', updatedAt: nowIso() };
    await store.putTask(scope, task);
    return j(200, { ok: true, scope, task });
  }
  if (p === '/api/hanja/admin/tasks' && method === 'GET') {
    const tasks = [];
    for (const scope of await store.listTaskScopes()) { const t = await store.getTask(scope); if (t) tasks.push({ scope, ...t }); }
    tasks.sort((a, b) => (a.scope === 'default' ? -1 : b.scope === 'default' ? 1 : a.scope < b.scope ? -1 : 1));
    return j(200, { tasks, today: todayKst() });
  }
  if (p === '/api/hanja/admin/task' && method === 'DELETE') {
    const b = await body();
    const scope = String((b && b.scope) || '').trim();
    if (!scope) return j(400, { error: 'scope 필요' });
    if (!(await store.getTask(scope))) return j(404, { error: '그 범위에 지정한 단원이 없어요.' });
    await store.deleteTask(scope);
    return j(200, { ok: true, scope });
  }
  /* 단원별 진도 — 지정 범위의 학생마다 그 단원 항목의 심음·장기 기억·복습 밀림. 기록 본문을 읽는 무거운 조회라 범위 하나씩만 */
  if (p === '/api/hanja/admin/progress' && method === 'GET') {
    const scope = q('scope') || 'default';
    const task = await store.getTask(scope);
    if (!task || !task.bookId) return j(404, { error: '그 범위에 지정한 단원이 없어요.' });
    const rec = await store.getBook(task.bookId);
    if (!rec || !rec.book) return j(404, { error: '지정한 단어장이 없어요 — 다시 올리거나 지정을 지우세요.' });
    const ids = unitItemIds(rec.book, task.unitId);
    /* 범위가 학생 코드면 그 학생만, 아니면 반 이름(default 는 전원) — 코드인지는 학생이 실제로 있는지로 본다 */
    const one = scope !== 'default' ? await store.getStudent(scope) : null;
    const codes = one ? [scope] : await store.listStudentCodes();
    const rows = [];
    for (const code of codes) {
      const stu = await store.getStudent(code);
      if (!stu || !stu.name) continue;
      if (!one && scope !== 'default' && String(stu.cls || '').trim() !== scope) continue;
      const st = await store.getState(code);
      rows.push({ code, name: stu.name, cls: stu.cls || '', linked: !!st, lastActive: st ? st.updatedAt : null, check: unitCheck(st, task.bookId, task.unitId), ...unitProgress(st, ids) });
    }
    rows.sort((a, b) => (a.cls === b.cls ? (a.name < b.name ? -1 : 1) : (a.cls < b.cls ? -1 : 1)));
    const unit = (rec.book.units || []).find((u) => u.id === task.unitId) || { id: task.unitId, title: task.unitId };
    return j(200, { scope, task, unit: { id: unit.id, title: unit.title, total: ids.length }, rows, today: todayKst() });
  }
  /* 공용 획순 사전 — { "十": { strokes, medians } } . 단어장마다 획순을 붙이지 않고 글자 하나에 하나만 둔다(기억 기록도 글자 단위다).
     변환기(hanja/strokes-convert.mjs) 산출물을 원장이 검수해 올린다. replace 가 아니면 있는 글자 위에 덧쓴다. */
  if (p === '/api/hanja/admin/strokes' && method === 'POST') {
    const b = await body();
    if (!b || !isObj(b.strokes)) return j(400, { error: 'strokes 표({"十": {strokes, medians}})가 필요해요.' });
    const prev = b.replace ? {} : (((await store.getStrokes()) || {}).strokes || {});
    const next = { ...prev }, errors = [];
    for (const [ch, v] of Object.entries(b.strokes)) {
      if (!CHECK.isHanjaChar(ch)) { errors.push({ where: ch.slice(0, 6), message: '한자 한 글자가 아니에요.' }); continue; }
      if (!isObj(v)) { errors.push({ where: ch, message: '값은 {strokes, medians} 여야 해요.' }); continue; }
      const entry = {};
      if (v.strokes != null) {
        const n = Number(v.strokes);
        if (!(Number.isInteger(n) && n >= 1 && n <= 64)) { errors.push({ where: ch, message: '획수는 1~64 정수' }); continue; }
        entry.strokes = n;
      }
      if (v.medians != null) {
        const C = { errors: [], err: (w, m) => C.errors.push({ where: w, message: m }) };
        const med = CHECK.checkMedians(v.medians, ch, C);
        if (!med) { errors.push(...C.errors); continue; }
        if (entry.strokes != null && entry.strokes !== med.length) { errors.push({ where: ch, message: '획순 ' + med.length + '획인데 획수는 ' + entry.strokes }); continue; }
        entry.medians = med; if (entry.strokes == null) entry.strokes = med.length;
      }
      if (entry.strokes == null) { errors.push({ where: ch, message: '획수도 획순도 없어요.' }); continue; }
      next[ch] = entry;
    }
    if (errors.length) return j(400, { error: '획순 사전에 오류가 있어요 (' + errors.length + '건)', errors: errors.slice(0, 50) });
    if (Object.keys(next).length > STROKES_MAX_CHARS) return j(413, { error: '획순 사전이 ' + STROKES_MAX_CHARS + '자를 넘어요.' });
    const rec = { strokes: next, updatedAt: nowIso() };
    if (byteLen(rec) > STROKES_MAX_BYTES) return j(413, { error: '획순 사전이 너무 커요 (3MB 이내).' });
    await store.putStrokes(rec);
    return j(200, { ok: true, count: Object.keys(next).length, added: Object.keys(b.strokes).length, updatedAt: rec.updatedAt });
  }
  if (p === '/api/hanja/admin/strokes' && method === 'GET') {
    const rec = await store.getStrokes();
    const strokes = (rec && isObj(rec.strokes)) ? rec.strokes : {};
    return j(200, { strokes, updatedAt: rec ? rec.updatedAt || null : null, count: Object.keys(strokes).length, withMedians: Object.values(strokes).filter((v) => v && v.medians).length });
  }
  /* 현황 — 저장 시점 요약 키를 읽는다. 요약이 없는 옛 기록만 본문을 읽어 셈한다 */
  if (p === '/api/hanja/admin/overview' && method === 'GET') {
    const codes = new Set([...(await store.listSummaryCodes()), ...(await store.listStateCodes())]);
    const students = [];
    for (const code of codes) {
      const [stu, sum, as] = await Promise.all([store.getStudent(code), store.getSummary(code), store.getAssign(code)]);
      const summary = sum || hanjaSummary(await store.getState(code));
      students.push({ code, name: (stu && stu.name) || '', cls: (stu && stu.cls) || '', assigned: (as && as.bookIds) || [], ...summary });
    }
    students.sort((a, b) => (a.cls === b.cls ? (a.name < b.name ? -1 : 1) : (a.cls < b.cls ? -1 : 1)));
    return j(200, { students, time: nowIso() });
  }
  return j(404, { error: 'unknown api' });
}

/* 퇴원 — 이 학생의 기록·요약·배정·알림 구독만 지운다. 단어장·단원 지정·획순 사전은 학생 것이 아니라 그대로 둔다 */
export async function dropStudentHanja(store, code) {
  await Promise.all([store.deleteState(code), store.deleteSummary(code), store.deleteAssign(code), store.delPush(code), store.deleteTask(code)]);
}

/* 백업 스냅샷용 덤프 — 단어장 본문은 싣지 않는다(라이선스 자료가 백업 파일로 흩어지지 않게, 내신 팩과 같은 이유).
   목록(메타)·학생 기록·요약·배정·단원 지정·재업로드 대응·획순 사전(원장이 검수한 것)을 담는다. */
export async function dumpHanja(store) {
  const index = await readIndex(store);
  const states = {}, summaries = {}, assigns = {}, tasks = {}, remaps = {};
  for (const code of await store.listStateCodes()) states[code] = await store.getState(code);
  for (const code of await store.listSummaryCodes()) summaries[code] = await store.getSummary(code);
  for (const code of await store.listAssignCodes()) assigns[code] = await store.getAssign(code);
  for (const scope of await store.listTaskScopes()) tasks[scope] = await store.getTask(scope);
  for (const e of index) { const r = await store.getRemap(e.id); if (r) remaps[e.id] = r; }
  return { bookIds: index.map((e) => e.id), index, states, summaries, assigns, tasks, remaps, strokes: (await store.getStrokes()) || null };
}
