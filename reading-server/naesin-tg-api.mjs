'use strict';
/* WB 탐구브레인 — /api/naesin-tg/* 라우트 (server.mjs·worker.mjs 공용)
   사회·과학 내신 문제지를 **지면 그대로** 보여 주고 답만 받는다(기획서 docs/탐구내신-학습웹앱-기획서-v0.md).
   격리 원칙은 형제 앱과 같다: 라우트는 /api/naesin-tg/* 아래, 저장은 naesintg: 접두(로컬 db.naesinTg)만.

   국어·영어와 다른 점 — **채점을 서버가 한다.**
   지면을 고치지 않으므로 학생 기기에 내려가는 것은 쪽 그림과 "몇 번이 몇 쪽에 있다"뿐이다.
   정답은 제출 전에는 어떤 응답에도 실리지 않고, 정답·해설 쪽(answerFrom 이후)도 제출 전에는 403 이다.
   그래서 학생 기록의 정본도 서버다(기기에는 쓰다 만 답만 잠깐 있다). */

const SHEET_ID_RE = /^[A-Za-z0-9-]{3,60}$/;
const CODE_RE = /^[A-Za-z0-9-]{3,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/* SVG 를 받는 이유: 저장소의 체험 문제지(자체 창작)가 SVG 다. 화면은 <img> 로만 그리므로 스크립트가 돌지 않는다. */
const PAGE_RE = /^data:image\/(jpeg|png|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const PAGE_MAX_CHARS = 1_400_000;   // 쪽 그림 1장(base64) — A4 한 쪽 JPEG 150dpi 가 0.2~0.4MB
const PAGES_MAX = 60;
const QUESTIONS_MAX = 100;
const EXAM_SHEETS_MAX = 80;
const ANSWER_MAX = 2000;            // 서술형 답안 길이
const SUBJECTS = ['science', 'social', 'history', 'ethics'];
const TYPES = ['choice', 'short', 'essay'];

export const naesinTgBodyLimit = (p) => (p === '/api/naesin-tg/admin/page' ? 1_600_000 : 300_000);

const nowIso = () => new Date().toISOString();
/* 한국 날짜 — "다른 날 다시 풀어야 지워진다"의 '날'은 학생이 사는 날짜다(UTC 로 세면 아침 9시에 날이 바뀐다). */
const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

/* 답 맞추기 — 객관식은 고른 번호의 집합, 단답은 띄어쓰기·기호·대소문자를 뺀 글자.
   단답 정답은 `|` 로 여러 개 적을 수 있다("도체|전도체"). */
const digits = (s) => [...new Set(String(s == null ? '' : s)
  .replace(/[①-⑨]/g, (c) => String(c.charCodeAt(0) - 0x245f)).replace(/[^1-9]/g, '').split(''))].sort().join('');
const plain = (s) => String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s.,·:;'"`~!?()[\]{}<>/\\-]/g, '');
export const isRight = (q, given) => {
  if (!q || q.type === 'essay') return null;         // 서술형은 기계가 판정하지 않는다
  if (q.type === 'choice') { const g = digits(given); return !!g && g === digits(q.answer); }
  const g = plain(given);
  return !!g && String(q.answer).split('|').map(plain).filter(Boolean).includes(g);
};

/* 올라온 문제지를 저장 꼴로 다듬는다. 고칠 수 없는 것은 오류 문자열로 돌려준다. */
export function normalizeSheet(id, s) {
  if (!s || typeof s !== 'object') return '문제지 정보가 없어요.';
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const title = str(s.title, 80);
  if (!title) return '제목이 필요해요.';
  if (!SUBJECTS.includes(s.subject)) return '과목은 ' + SUBJECTS.join('·') + ' 가운데 하나예요.';
  const kind = s.kind === 'note' ? 'note' : 'test';
  const step = Number(s.step);
  if (![1, 2, 3, 4].includes(step)) return '단계(step)는 1~4예요.';
  const pages = Number(s.pages);
  if (!Number.isInteger(pages) || pages < 1 || pages > PAGES_MAX) return `쪽 수는 1~${PAGES_MAX}예요.`;
  const answerFrom = kind === 'note' ? 0 : Number(s.answerFrom || 0);
  if (!Number.isInteger(answerFrom) || answerFrom < 0 || answerFrom > pages) return '정답·해설이 시작하는 쪽(answerFrom)이 쪽 수를 벗어나요.';
  const qs = kind === 'note' ? [] : (Array.isArray(s.questions) ? s.questions : []);
  if (qs.length > QUESTIONS_MAX) return `문항은 ${QUESTIONS_MAX}개까지예요.`;
  const seen = new Set();
  const questions = [];
  for (const q of qs) {
    const no = Number(q && q.no);
    if (!Number.isInteger(no) || no < 1 || no > 999) return '문항 번호가 숫자가 아니에요.';
    if (seen.has(no)) return no + '번이 두 번 있어요.';
    seen.add(no);
    const type = q.type;
    if (!TYPES.includes(type)) return no + '번의 유형은 choice·short·essay 가운데 하나예요.';
    const page = Number(q.page);
    if (!Number.isInteger(page) || page < 1 || page > pages) return no + '번이 있는 쪽이 쪽 수를 벗어나요.';
    const answer = str(q.answer, 200);
    questions.push({ no, type, page, answer });
  }
  questions.sort((a, b) => a.no - b.no);
  /* 학생에게 여는 것(open)은 정답이 다 찬 뒤에만 — 빈 정답으로 채점하면 전원 오답이 된다(Q9). */
  const missing = questions.filter((q) => q.type !== 'essay' && !q.answer).map((q) => q.no);
  const open = !!s.open;
  if (open && kind === 'test' && !questions.length) return '문항이 하나도 없으면 열 수 없어요.';
  if (open && missing.length) return '정답이 빈 문항이 있어 열 수 없어요: ' + missing.slice(0, 10).join(', ') + '번';
  return { id, title, subject: s.subject, grade: str(s.grade, 10), unit: str(s.unit, 40), step, kind, pages, answerFrom, questions, open };
}

const indexEntry = (s) => ({ id: s.id, title: s.title, subject: s.subject, grade: s.grade, unit: s.unit, step: s.step,
  kind: s.kind, pages: s.pages, count: s.questions.length, open: s.open });

/* 학생에게 가는 문제지 — 정답을 뺀다. 제출한 뒤에만 정답을 따로 실어 준다. */
const publicSheet = (s) => ({ ...s, questions: s.questions.map((q) => ({ no: q.no, type: q.type, page: q.page })) });

const examOf = async (store, code) => {
  const mine = await store.getExam(code);
  if (mine) return { exam: mine, scope: code };
  const def = await store.getExam('default');
  return { exam: def || null, scope: def ? 'default' : null };
};
/* 과제 — 시험 범위와 따로 주는 숙제. 대상은 전체 / 반(학생 기록의 cls) / 학생 코드 여럿.
   과제 목록은 한 키에 통째로 둔다(학원 규모에서 수십 건이라 KV 값 하나로 충분). */
const TASKS_MAX = 100;
const TASK_SHEETS_MAX = 10;
const TASK_HIDE_DAYS = 7;   // 마감 7일 뒤부터 학생 화면에서 숨긴다(지우는 것은 강사만)
const taskFor = (t, code, cls) => (t.target.kind === 'all' ? true
  : t.target.kind === 'cls' ? !!cls && t.target.cls === cls : t.target.codes.includes(code));
const myTasks = async (store, code) => {
  const all = (await store.getTasks()) || [];
  if (!all.length) return [];
  const stu = await store.getStudent(code);
  return all.filter((t) => taskFor(t, code, stu && stu.cls));
};
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
const stateOf = async (store, code) => {
  const rec = await store.getState(code);
  const st = (rec && rec.state) || {};
  if (!st.sheets || typeof st.sheets !== 'object') st.sheets = {};
  st.v = 1;
  return st;
};
const wrongOpen = (my) => Object.values((my && my.wrong) || {}).filter((w) => !w.cleared).length;
const progressOf = (my) => (my && my.done
  ? { submitted: true, at: my.done.at, score: my.done.score, total: my.done.total, wrongOpen: wrongOpen(my),
    essayHold: Object.values(my.essays || {}).filter((e) => !e.verdict).length }
  : { submitted: false, drafted: Object.keys((my && my.draft) || {}).length });

const cleanAnswers = (sheet, raw) => {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const q of sheet.questions) {
    const v = raw[q.no];
    if (v == null) continue;
    const s = String(v).trim().slice(0, q.type === 'essay' ? ANSWER_MAX : 200);
    if (s) out[q.no] = s;
  }
  return out;
};

export async function handleNaesinTg(ctx) {
  const { path: p, method, who, store } = ctx;
  const j = (status, body) => ({ status, body });
  if (!who) return j(401, { error: '로그인이 필요합니다.' });
  const today = kstDate(ctx.now ? ctx.now() : Date.now());
  const q = (k) => String((ctx.query && ctx.query.get(k)) || '').trim();
  const body = async () => {
    try { return await ctx.getBody(); } catch (e) { if (e && e.status === 413) throw e; return null; }
  };
  /* 학생이 열 수 있는 문제지인가 — 시험 범위(내 시험 → 반 공통)나 내 과제에 들었고 강사가 열어 둔 것만. 관리자는 통과.
     과제는 학생 화면에서 숨긴 뒤에도 지우기 전까지는 열린다 — 오답 다시 풀기가 그 문제지를 다시 연다. */
  const loadFor = async (id) => {
    if (!SHEET_ID_RE.test(id)) return { err: j(400, { error: '문제지 id가 필요해요.' }) };
    const rec = await store.getSheet(id);
    if (!rec) return { err: j(404, { error: '문제지를 찾을 수 없어요.' }) };
    if (!who.admin) {
      const { exam } = await examOf(store, who.code);
      const inExam = !!exam && (exam.sheetIds || []).includes(id);
      const inTask = !inExam && (await myTasks(store, who.code)).some((t) => t.sheetIds.includes(id));
      if (!(inExam || inTask) || !rec.sheet.open) return { err: j(403, { error: '배정되지 않은 문제지예요.' }) };
    }
    return { sheet: rec.sheet, updatedAt: rec.updatedAt };
  };

  /* ── 학생 ── */

  if (p === '/api/naesin-tg/sheets' && method === 'GET' && !who.admin) {
    const { exam, scope } = await examOf(store, who.code);
    const st = await stateOf(store, who.code);
    const index = (await store.getSheetIds()) || [];
    const tasks = (await myTasks(store, who.code))
      .filter((t) => addDays(t.due, TASK_HIDE_DAYS) >= today)
      .map((t) => ({ id: t.id, title: t.title, due: t.due, sheetIds: t.sheetIds }))
      .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
    const ids = [...new Set(((exam && exam.sheetIds) || []).concat(...tasks.map((t) => t.sheetIds)))];
    const sheets = ids.map((id) => index.find((e) => e.id === id)).filter((e) => e && e.open);
    const progress = {};
    for (const e of sheets) progress[e.id] = progressOf(st.sheets[e.id]);
    /* 학생 화면이 시험 범위 목록과 과제 목록을 나눠 그리도록 시험 범위 id 를 따로 싣는다 */
    const examIds = ((exam && exam.sheetIds) || []).filter((id) => sheets.some((e) => e.id === id));
    return j(200, { sheets, exam: exam ? { examDate: exam.examDate, title: exam.title || '' } : null, scope, progress, today,
      tasks: tasks.map((t) => ({ ...t, sheetIds: t.sheetIds.filter((id) => sheets.some((e) => e.id === id)) })).filter((t) => t.sheetIds.length),
      examIds });
  }

  if (p === '/api/naesin-tg/sheet' && method === 'GET') {
    const got = await loadFor(q('id'));
    if (got.err) return got.err;
    if (who.admin) return j(200, { sheet: got.sheet, updatedAt: got.updatedAt });
    const my = (await stateOf(store, who.code)).sheets[got.sheet.id] || {};
    const out = { sheet: publicSheet(got.sheet), my: { draft: my.draft || {}, done: my.done || null, wrong: my.wrong || {}, essays: my.essays || {} }, today };
    /* 제출한 뒤에만 정답이 나간다 */
    if (my.done) out.answers = Object.fromEntries(got.sheet.questions.map((x) => [x.no, x.answer]));
    return j(200, out);
  }

  if (p === '/api/naesin-tg/page' && method === 'GET') {
    const got = await loadFor(q('id'));
    if (got.err) return got.err;
    const n = Number(q('n'));
    if (!Number.isInteger(n) || n < 1 || n > got.sheet.pages) return j(400, { error: '쪽 번호가 범위를 벗어나요.' });
    if (!who.admin && got.sheet.answerFrom && n >= got.sheet.answerFrom) {
      const my = (await stateOf(store, who.code)).sheets[got.sheet.id];
      if (!my || !my.done) return j(403, { error: '정답과 해설은 제출한 뒤에 볼 수 있어요.' });
    }
    const data = await store.getPage(got.sheet.id, n);
    if (!data) return j(404, { error: '이 쪽은 아직 올라오지 않았어요.' });
    return j(200, { page: { n, data } });
  }

  /* 쓰다 만 답 — 기기를 바꿔도 이어 풀게 서버에 둔다. 제출한 뒤에는 받지 않는다. */
  if (p === '/api/naesin-tg/draft' && method === 'PUT' && !who.admin) {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const got = await loadFor(String(b.id || ''));
    if (got.err) return got.err;
    const st = await stateOf(store, who.code);
    const my = st.sheets[got.sheet.id] = st.sheets[got.sheet.id] || {};
    if (my.done) return j(409, { error: '이미 제출한 문제지예요.' });
    my.draft = cleanAnswers(got.sheet, b.answers);
    await store.putState(who.code, { state: st, updatedAt: nowIso() });
    return j(200, { ok: true });
  }

  /* 제출 = 채점. 한 번만 받는다 — 제출하면 정답·해설이 열리므로 다시 내는 점수는 뜻이 없다.
     틀린 문제는 /retry 로 다른 날 다시 맞혀서 지운다(Q10·Q12). */
  if (p === '/api/naesin-tg/submit' && method === 'POST' && !who.admin) {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const got = await loadFor(String(b.id || ''));
    if (got.err) return got.err;
    if (got.sheet.kind !== 'test') return j(400, { error: '읽기 자료는 제출하지 않아요.' });
    const st = await stateOf(store, who.code);
    const my = st.sheets[got.sheet.id] = st.sheets[got.sheet.id] || {};
    if (my.done) return j(409, { error: '이미 제출한 문제지예요.' });
    const answers = cleanAnswers(got.sheet, b.answers);
    const marks = {}; const wrong = {}; const essays = {};
    let score = 0, total = 0;
    for (const x of got.sheet.questions) {
      const ok = isRight(x, answers[x.no]);
      marks[x.no] = ok;
      if (ok === null) { essays[x.no] = { text: answers[x.no] || '' }; continue; }
      total += 1;
      if (ok) score += 1; else wrong[x.no] = { dates: [today], cleared: null };
    }
    my.done = { at: nowIso(), date: today, score, total, answers, marks };
    my.wrong = wrong; my.essays = essays; delete my.draft;
    await store.putState(who.code, { state: st, updatedAt: nowIso() });
    return j(200, { result: { score, total, marks, answers: Object.fromEntries(got.sheet.questions.map((x) => [x.no, x.answer])) } });
  }

  /* 오답 다시 풀기 — 틀린 날과 **다른 날** 맞혀야 지워진다. 같은 날은 방금 본 해설을 옮겨 적는 것이라 받지 않는다. */
  if (p === '/api/naesin-tg/retry' && method === 'POST' && !who.admin) {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const got = await loadFor(String(b.id || ''));
    if (got.err) return got.err;
    const st = await stateOf(store, who.code);
    const my = st.sheets[got.sheet.id];
    const no = Number(b.no);
    const w = my && my.wrong && my.wrong[no];
    if (!w || w.cleared) return j(404, { error: '다시 풀 오답이 아니에요.' });
    if (w.dates[w.dates.length - 1] === today) return j(409, { error: '오늘 틀린 문제는 내일부터 다시 풀 수 있어요.' });
    const ok = isRight(got.sheet.questions.find((x) => x.no === no), b.answer);
    if (ok) w.cleared = today; else w.dates = w.dates.concat(today).slice(-10);
    await store.putState(who.code, { state: st, updatedAt: nowIso() });
    return j(200, { retry: { ok: !!ok, cleared: !!ok } });
  }

  /* 서술형 스스로 표시 — 모범답안(해설 쪽)을 본 뒤 맞음·틀림을 적는다. 확정은 강사가 한다(Q11). */
  if (p === '/api/naesin-tg/essay' && method === 'POST' && !who.admin) {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const got = await loadFor(String(b.id || ''));
    if (got.err) return got.err;
    const st = await stateOf(store, who.code);
    const my = st.sheets[got.sheet.id];
    const e = my && my.done && my.essays && my.essays[Number(b.no)];
    if (!e) return j(404, { error: '제출한 서술형이 아니에요.' });
    if (b.self !== 'ok' && b.self !== 'no') return j(400, { error: "self 는 'ok' 또는 'no'" });
    e.self = b.self;
    await store.putState(who.code, { state: st, updatedAt: nowIso() });
    return j(200, { ok: true });
  }

  /* ── 관리 ── */
  if (!p.startsWith('/api/naesin-tg/admin/')) return j(404, { error: '없는 경로예요.' });
  if (!who.admin) return j(403, { error: '관리자만 쓸 수 있어요.' });

  if (p === '/api/naesin-tg/admin/sheets' && method === 'GET') {
    return j(200, { sheets: (await store.getSheetIds()) || [] });
  }

  if (p === '/api/naesin-tg/admin/sheet' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const id = String(b.id || '').trim();
    if (!SHEET_ID_RE.test(id)) return j(400, { error: '문제지 id는 영문·숫자·하이픈 3~60자예요.' });
    const sheet = normalizeSheet(id, b.sheet);
    if (typeof sheet === 'string') return j(400, { error: sheet });
    /* 열려면 쪽 그림이 다 올라와 있어야 한다 — 빈 쪽이 있으면 학생 화면이 중간에 멈춘다 */
    if (sheet.open) {
      for (let n = 1; n <= sheet.pages; n += 1) {
        if (!(await store.getPage(id, n))) return j(400, { error: n + '쪽 그림이 아직 없어 열 수 없어요.' });
      }
    }
    const rec = { sheet, updatedAt: nowIso() };
    await store.putSheet(id, rec);
    const index = ((await store.getSheetIds()) || []).filter((e) => e.id !== id).concat(indexEntry(sheet));
    await store.putSheetIds(index);
    return j(200, { ok: true, sheet, updatedAt: rec.updatedAt });
  }

  if (p === '/api/naesin-tg/admin/page' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const id = String(b.id || '').trim();
    const n = Number(b.n);
    if (!SHEET_ID_RE.test(id) || !Number.isInteger(n) || n < 1 || n > PAGES_MAX) return j(400, { error: 'id 와 쪽 번호가 필요해요.' });
    const data = String(b.data || '');
    if (data.length > PAGE_MAX_CHARS) return j(413, { error: '쪽 그림이 너무 커요. 해상도를 낮춰 다시 만들어 주세요.' });
    if (!PAGE_RE.test(data)) return j(400, { error: '쪽 그림은 JPEG·PNG·WebP 여야 해요.' });
    await store.putPage(id, n, data);
    return j(200, { ok: true });
  }

  if (p === '/api/naesin-tg/admin/sheet-delete' && method === 'POST') {
    const b = await body();
    const id = String((b && b.id) || '').trim();
    const rec = SHEET_ID_RE.test(id) ? await store.getSheet(id) : null;
    if (!rec) return j(404, { error: '문제지를 찾을 수 없어요.' });
    for (let n = 1; n <= PAGES_MAX; n += 1) await store.delPage(id, n);
    await store.delSheet(id);
    await store.putSheetIds(((await store.getSheetIds()) || []).filter((e) => e.id !== id));
    return j(200, { ok: true });
  }

  if (p === '/api/naesin-tg/admin/exam' && method === 'GET') {
    const scope = q('scope') || 'default';
    return j(200, { exam: (await store.getExam(scope)) || null, scope });
  }
  if (p === '/api/naesin-tg/admin/exam' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const scope = String(b.scope || '').trim();
    if (scope !== 'default' && !CODE_RE.test(scope)) return j(400, { error: "scope는 'default' 또는 학생 코드" });
    if (scope !== 'default' && !(await store.getStudent(scope))) return j(404, { error: '등록되지 않은 학생 코드예요.' });
    const examDate = String(b.examDate || '').trim();
    if (!DATE_RE.test(examDate)) return j(400, { error: 'examDate는 YYYY-MM-DD' });
    const sheetIds = [...new Set(Array.isArray(b.sheetIds) ? b.sheetIds.map((x) => String(x || '').trim()) : [])];
    if (!sheetIds.length || sheetIds.length > EXAM_SHEETS_MAX) return j(400, { error: `sheetIds 필요 (1~${EXAM_SHEETS_MAX}개)` });
    for (const sid of sheetIds) {
      if (!SHEET_ID_RE.test(sid) || !(await store.getSheet(sid))) return j(400, { error: '없는 문제지예요: ' + sid.slice(0, 60) });
    }
    const rec = { examDate, title: String(b.title || '').trim().slice(0, 60), sheetIds, updatedAt: nowIso() };
    await store.putExam(scope, rec);
    return j(200, { ok: true, scope, exam: rec });
  }

  /* 과제 목록 + 과제마다 대상·제출 수·안 낸 학생. 제출 = 과제의 문제지를 모두 낸 것.
     대상 명단: 학생 코드는 그대로, 반은 등록 학생 가운데 그 반, 전체는 탐구브레인을 한 번이라도 연 학생
     (전체를 등록 학생 전원으로 세면 다른 앱만 쓰는 학생까지 "안 냄"으로 잡힌다). */
  if (p === '/api/naesin-tg/admin/tasks' && method === 'GET') {
    const tasks = (await store.getTasks()) || [];
    const opened = await store.listStateCodes();
    let roster = null;   // 반 대상이 있을 때만 등록 학생을 훑는다
    const out = [];
    for (const t of tasks) {
      let codes;
      if (t.target.kind === 'codes') codes = t.target.codes;
      else if (t.target.kind === 'all') codes = opened;
      else {
        if (!roster) { roster = []; for (const c of await store.listStudentCodes()) roster.push(await store.getStudent(c)); }
        codes = roster.filter((s) => s && s.cls === t.target.cls).map((s) => s.code);
      }
      const done = []; const missing = [];
      for (const code of codes) {
        const st = await stateOf(store, code);
        const stu = await store.getStudent(code);
        (t.sheetIds.every((id) => st.sheets[id] && st.sheets[id].done) ? done : missing).push({ code, name: (stu && stu.name) || '' });
      }
      out.push({ ...t, status: { targets: codes.length, submitted: done.length, missing } });
    }
    return j(200, { tasks: out });
  }

  if (p === '/api/naesin-tg/admin/task' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const title = String(b.title || '').trim().slice(0, 60);
    if (!title) return j(400, { error: '과제 제목이 필요해요.' });
    const due = String(b.due || '').trim();
    if (!DATE_RE.test(due)) return j(400, { error: '마감일은 YYYY-MM-DD' });
    const index = (await store.getSheetIds()) || [];
    const sheetIds = [...new Set((Array.isArray(b.sheetIds) ? b.sheetIds : []).map((x) => String(x || '').trim()))];
    if (!sheetIds.length || sheetIds.length > TASK_SHEETS_MAX) return j(400, { error: '문제지를 1~' + TASK_SHEETS_MAX + '개 골라 주세요.' });
    for (const id of sheetIds) {
      const e = index.find((x) => x.id === id);
      if (!e) return j(400, { error: '없는 문제지예요: ' + id });
      if (e.kind !== 'test') return j(400, { error: '과제에는 문제지만 넣어요(읽기 자료 제외): ' + id });
    }
    const tg = b.target || {};
    let target;
    if (tg.kind === 'all') target = { kind: 'all' };
    else if (tg.kind === 'cls') {
      const cls = String(tg.cls || '').trim().slice(0, 30);
      if (!cls) return j(400, { error: '반 이름이 필요해요.' });
      target = { kind: 'cls', cls };
    } else if (tg.kind === 'codes') {
      const codes = [...new Set((Array.isArray(tg.codes) ? tg.codes : []).map((x) => String(x || '').trim()).filter(Boolean))];
      if (!codes.length || codes.length > 100) return j(400, { error: '학생 코드를 1~100명 넣어 주세요.' });
      for (const c of codes) {
        if (!CODE_RE.test(c) || !(await store.getStudent(c))) return j(404, { error: '등록되지 않은 학생 코드예요: ' + c });
      }
      target = { kind: 'codes', codes };
    } else return j(400, { error: "대상은 'all' · 'cls' · 'codes' 가운데 하나" });
    const tasks = (await store.getTasks()) || [];
    const id = String(b.id || '').trim();
    const old = id ? tasks.find((x) => x.id === id) : null;
    if (id && !old) return j(404, { error: '과제를 찾을 수 없어요.' });
    if (!old && tasks.length >= TASKS_MAX) return j(400, { error: '과제가 ' + TASKS_MAX + '건을 넘어요. 끝난 과제를 지워 주세요.' });
    const rec = { id: old ? old.id : 't-' + crypto.randomUUID().slice(0, 8), title, due, sheetIds, target,
      createdAt: old ? old.createdAt : nowIso(), updatedAt: nowIso() };
    await store.putTasks(old ? tasks.map((x) => (x.id === rec.id ? rec : x)) : tasks.concat(rec));
    return j(200, { ok: true, task: rec });
  }

  /* 과제를 지워도 학생의 풀이 기록은 문제지 단위라 그대로 남는다 */
  if (p === '/api/naesin-tg/admin/task-delete' && method === 'POST') {
    const b = await body();
    const id = String((b && b.id) || '').trim();
    const tasks = (await store.getTasks()) || [];
    if (!tasks.some((x) => x.id === id)) return j(404, { error: '과제를 찾을 수 없어요.' });
    await store.putTasks(tasks.filter((x) => x.id !== id));
    return j(200, { ok: true });
  }

  /* 반별 현황 — 등록 학생 가운데 그 반 전원이 분모(앱을 안 연 학생도 "안 냄"). 문제지마다 제출·평균 정답률·남은 오답·
     확정 안 된 서술형, 그리고 번호별 오답률(처음 제출 때 틀린 수 ÷ 제출 수, 서술형 제외 — 수업에서 다룰 번호를 고른다).
     cls 를 비우면 반 목록만 준다. 답안 원문은 싣지 않는다. */
  if (p === '/api/naesin-tg/admin/class' && method === 'GET') {
    const roster = [];
    for (const c of await store.listStudentCodes()) { const s = await store.getStudent(c); if (s) roster.push(s); }
    const classes = [...new Set(roster.map((s) => s.cls).filter(Boolean))].sort();
    const cls = q('cls');
    if (!cls) return j(200, { class: null, classes });
    const members = roster.filter((s) => s.cls === cls);
    const states = [];
    for (const s of members) states.push((await stateOf(store, s.code)).sheets);
    const sheets = [];
    for (const e of ((await store.getSheetIds()) || []).filter((x) => x.kind === 'test')) {
      let submitted = 0, score = 0, total = 0, wrongOpenSum = 0, essayHold = 0;
      const wrongByNo = {};
      for (const ss of states) {
        const my = ss[e.id];
        if (!my || !my.done) continue;
        const pg = progressOf(my);
        submitted += 1; score += pg.score; total += pg.total; wrongOpenSum += pg.wrongOpen; essayHold += pg.essayHold;
        for (const [no, ok] of Object.entries(my.done.marks || {})) if (ok === false) wrongByNo[no] = (wrongByNo[no] || 0) + 1;
      }
      sheets.push({ id: e.id, title: e.title, step: e.step, members: members.length, submitted,
        rate: total ? Math.round((score / total) * 100) : null, wrongOpen: wrongOpenSum, essayHold,
        wrongByNo: Object.entries(wrongByNo).map(([no, n]) => ({ no: Number(no), wrong: n, rate: Math.round((n / submitted) * 100) }))
          .sort((a, b) => b.wrong - a.wrong || a.no - b.no) });
    }
    return j(200, { class: { cls, members: members.length, sheets }, classes });
  }

  /* 반 현황 — 학생마다 문제지별 점수·남은 오답·확정 안 된 서술형 수. 답안 원문은 싣지 않는다. */
  if (p === '/api/naesin-tg/admin/overview' && method === 'GET') {
    const students = [];
    for (const code of await store.listStateCodes()) {
      const stu = await store.getStudent(code);
      const st = await stateOf(store, code);
      const sheets = {};
      for (const [id, my] of Object.entries(st.sheets)) if (my.done) sheets[id] = progressOf(my);
      students.push({ code, name: (stu && stu.name) || '', cls: (stu && stu.cls) || '', sheets });
    }
    return j(200, { students, sheets: (await store.getSheetIds()) || [] });
  }

  /* 한 학생의 한 문제지 — 어느 번호를 틀렸는지와 서술형 답안. 수업에서 다룰 번호를 고르는 화면이 읽는다. */
  if (p === '/api/naesin-tg/admin/student' && method === 'GET') {
    const code = q('code'); const id = q('id');
    if (!CODE_RE.test(code) || !SHEET_ID_RE.test(id)) return j(400, { error: 'code 와 id 가 필요해요.' });
    const my = (await stateOf(store, code)).sheets[id] || null;
    return j(200, { student: { code, id, done: (my && my.done) || null, wrong: (my && my.wrong) || {}, essays: (my && my.essays) || {} } });
  }

  if (p === '/api/naesin-tg/admin/essay' && method === 'POST') {
    const b = await body();
    if (!b) return j(400, { error: '올바른 JSON이 아니에요.' });
    const code = String(b.code || '').trim(); const id = String(b.id || '').trim();
    if (!CODE_RE.test(code) || !SHEET_ID_RE.test(id)) return j(400, { error: 'code 와 id 가 필요해요.' });
    if (b.verdict !== 'pass' && b.verdict !== 'fail') return j(400, { error: "verdict 는 'pass' 또는 'fail'" });
    const st = await stateOf(store, code);
    const e = st.sheets[id] && st.sheets[id].essays && st.sheets[id].essays[Number(b.no)];
    if (!e) return j(404, { error: '제출한 서술형이 아니에요.' });
    e.verdict = b.verdict; e.verdictAt = nowIso();
    await store.putState(code, { state: st, updatedAt: nowIso() });
    return j(200, { ok: true });
  }

  return j(404, { error: '없는 경로예요.' });
}
