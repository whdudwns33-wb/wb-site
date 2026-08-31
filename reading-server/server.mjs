'use strict';
/* WB 진로독서 백엔드 — 학생 동기화 API + 관리 웹 + 학생 앱 서빙 (Node 22 무의존성)
   실행: node reading-server/server.mjs   (기본 http://localhost:8890)
   환경: PORT, ADMIN_PIN(기본 wb-admin-2026 — 운영 시 반드시 변경), DATA_DIR */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { load, persist, getDb, listBackups, getBackup, snapshotNow } from './store.mjs';
import { handleVocab, sendNightPushes, vocabSummary } from './vocab-api.mjs';
import { bookIndex, cleanWords, coachingCard, confirmAllPlan, findBook, readyToConfirm, validProgress, withOverlay } from './textbook.mjs';
import { parseRoster } from './roster.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(ROOT, '..', 'reading');      // 학생 앱 정적 파일
const VOCAB_DIR = path.join(ROOT, '..', 'vocab');      // 워드브레인 앱 정적 파일
const SHARED_DIR = path.join(ROOT, '..', 'shared');    // 두 앱이 함께 쓰는 파일(voice.js)
const PUB_DIR = path.join(ROOT, 'public');             // 관리 웹
const PORT = +(process.env.PORT || 8890);
const ADMIN_PIN = process.env.ADMIN_PIN || 'wb-admin-2026';
const TOKEN_TTL = 1000 * 60 * 60 * 24 * 30;            // 30일

load();
const db = getDb();

/* 워드브레인 저장소 어댑터 — db.vocab만 사용 (분리 가능한 격리) */
const vocabPushMap = () => (db.vocab.push = db.vocab.push || {});
const vocabAssignMap = () => (db.vocab.assigns = db.vocab.assigns || {});
const vocabStore = {
  getState: (c) => db.vocab.states[c] || null,
  putState: (c, rec) => { db.vocab.states[c] = rec; persist(); },
  listStateCodes: () => Object.keys(db.vocab.states),
  getStudent: (c) => db.students[c] || null,
  getMnemo: (k) => db.vocab.mnemos[k] || null,
  putMnemo: (k, rec) => { db.vocab.mnemos[k] = rec; persist(); },
  listMnemos: () => Object.values(db.vocab.mnemos),
  getPush: (c) => vocabPushMap()[c] || null,
  putPush: (c, rec) => { vocabPushMap()[c] = rec; persist(); },
  delPush: (c) => { delete vocabPushMap()[c]; persist(); },
  listPushCodes: () => Object.keys(vocabPushMap()),
  getAssign: (c) => vocabAssignMap()[c] || null,
  putAssign: (c, rec) => { vocabAssignMap()[c] = rec; persist(); },
  listAssignCodes: () => Object.keys(vocabAssignMap()),
};
const VOCAB_PUSH_ENV = {
  publicKey: process.env.VAPID_PUBLIC_KEY || '',
  privateJwk: process.env.VAPID_PRIVATE_JWK || '',
  subject: process.env.VAPID_SUBJECT || 'mailto:admin@wb.local',
};

/* ── 유틸 ── */
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let buf = ''; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > 2_000_000) { reject(new Error('too large')); req.destroy(); return; } buf += c; });
  req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});
const PEND_TTL = 30 * 60 * 1000;   /* 연동 요청 30분 */
const newToken = (code, admin) => {
  const t = crypto.randomUUID().replace(/-/g, '');
  db.tokens[t] = { code, admin: !!admin, exp: Date.now() + TOKEN_TTL };
  persist();
  return t;
};
const auth = (req) => {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  const rec = t && db.tokens[t];
  if (!rec || rec.exp < Date.now()) return null;
  return rec;
};
const nowIso = () => new Date().toISOString();

/* ── 학생 요약 계산 (관리 현황판용) ── */
function dkeyOffset(off) {
  const d = new Date(); d.setDate(d.getDate() + off);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function summarize(code) {
  const st = db.states[code];
  const stu = db.students[code] || {};
  const base = { code, name: stu.name || '', cls: stu.cls || '', grade: stu.grade || '', level: stu.level || '', linked: !!st };
  if (!st || !st.state) return { ...base, today: false, streak: 0, week: 0, reads: 0, acc: null, vocab: 0, scraps: 0, reports: 0, redbook: 0, train: 0, appLevel: '', lastActive: st ? st.updatedAt : null };
  const S = st.state;
  const days = S.days || {};
  let streak = 0; let k = dkeyOffset(0);
  if (!days[k]) k = dkeyOffset(-1);
  for (let i = 0; i < 999 && days[k]; i++) { streak++; const d = new Date(k + 'T12:00:00'); d.setDate(d.getDate() - 1); k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  let week = 0; for (let i = 0; i < 7; i++) if (days[dkeyOffset(-i)]) week++;
  const quiz = Object.values(S.quiz || {});
  const qt = quiz.reduce((s, q) => s + (q.total || 0), 0);
  const qc = quiz.reduce((s, q) => s + (q.correct || 0), 0);
  return {
    ...base,
    today: !!days[dkeyOffset(0)],
    streak, week,
    reads: Object.keys(S.readings || {}).length,
    acc: qt ? Math.round(qc / qt * 100) : null,
    vocab: (S.vocab || []).length,
    scraps: Object.keys(S.scraps || {}).length,
    reports: (S.reports || []).length,
    redbook: (S.redbook || []).length,
    train: (S.train || []).length,
    appLevel: S.profile ? S.profile.level : '',
    lastActive: st.updatedAt,
  };
}

/* ── 학부모 리포트 ── */
let TITLE_CACHE = { t: 0, map: null };
function titleMap() {
  if (TITLE_CACHE.map && Date.now() - TITLE_CACHE.t < 60_000) return TITLE_CACHE.map;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'articles.json'), 'utf8'));
    const m = {};
    for (const a of d.articles || []) {
      m[a.id] = {};
      for (const lv of ['L1', 'L2', 'L3', 'L4']) if (a.levels && a.levels[lv]) m[a.id][lv] = a.levels[lv].title;
    }
    TITLE_CACHE = { t: Date.now(), map: m };
  } catch (e) { TITLE_CACHE = { t: Date.now(), map: TITLE_CACHE.map || {} }; }
  return TITLE_CACHE.map;
}
/* 교재(어휘가 독해다) — 정적 파일 하나, 제목 맵과 같은 방식으로 캐시 */
let TB_CACHE = { t: 0, data: null };
function textbookRaw() {
  if (TB_CACHE.data && Date.now() - TB_CACHE.t < 60_000) return TB_CACHE.data;
  try {
    TB_CACHE = { t: Date.now(), data: JSON.parse(fs.readFileSync(path.join(APP_DIR, 'textbook.json'), 'utf8')) };
  } catch (e) { TB_CACHE = { t: Date.now(), data: TB_CACHE.data || { books: [] } }; }
  return TB_CACHE.data;
}
/* 강사 검수 결과를 덧씌운 교재 — 화면에 나가는 것은 언제나 이쪽이다 */
function textbook() { return withOverlay(textbookRaw(), db.textbook || {}); }

function parentSummary(stu, st, vst, assignRec) {
  const titles = titleMap();
  const sum = summarize(stu.code);
  const S = (st && st.state) || {};
  const days = S.days || {};
  const dows = ['일', '월', '화', '수', '목', '금', '토'];
  const weekDays = [];
  for (let i = 6; i >= 0; i--) {
    const k = dkeyOffset(-i);
    const d = new Date(k + 'T12:00:00');
    weekDays.push({ dow: dows[d.getDay()], done: !!days[k], today: i === 0 });
  }
  /* 제목을 못 찾아도 내부 id를 학부모에게 보이지 않는다 — 지문 이름이 바뀌거나 내려가면 생긴다 */
  const anyTitle = (id, lv) => (titles[id] && (titles[id][lv] || titles[id].L3 || titles[id].L2 || titles[id].L1 || titles[id].L4)) || '읽은 글';
  const recent = Object.entries(S.readings || {})
    .sort((x, y) => (y[1].date < x[1].date ? -1 : 1))
    .slice(0, 5)
    .map(([id, r]) => ({ date: r.date, title: anyTitle(id, r.level) }));
  const reports = (S.reports || []).slice(-3).reverse().map(r => ({ title: r.title || '탐구보고서', done: r.done || '' }));
  const sp = S.speed || [];
  const speed = sp.length >= 2 ? { last: sp[sp.length - 1].cpm, delta: sp[sp.length - 1].cpm - sp[0].cpm } : null;
  return {
    name: stu.name, cls: stu.cls || '', grade: stu.grade || '', level: sum.level || sum.appLevel || '',
    today: sum.today, streak: sum.streak, week: sum.week, weekDays,
    reads: sum.reads, acc: sum.acc, vocab: sum.vocab, redbook: sum.redbook, train: sum.train,
    recent, reports, speed, lastActive: sum.lastActive, generatedAt: nowIso(),
    wordbrain: vocabSummary(vst),
    book: coachingCard(textbook(), stu.book, vst, assignRec),
  };
}

/* ── 정적 파일 ── */
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.pdf': 'application/pdf', '.css': 'text/css; charset=utf-8' };
function serveFile(res, base, rel) {
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  let fp = path.join(base, safe);
  if (!fp.startsWith(base)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  /* 배포본(Cloudflare)은 /admin/vocab-review 처럼 확장자 없이 열린다.
     로컬만 404가 나면 주소를 헛짚게 되므로 여기서도 .html을 한 번 더 찾아본다. */
  if (!fs.existsSync(fp) && !path.extname(fp) && fs.existsSync(fp + '.html')) fp += '.html';
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end('not found'); return; }
  /* 학년대별 지문 데이터는 ?v=<버전> 을 달고 오므로 오래 캐시해도 안전하다
     (배포본은 reading/_headers 가 같은 규칙을 준다) */
  const cacheable = /(^|\/)(articles-L[1-4]|hanja)\.json$/.test(fp);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
    'Cache-Control': cacheable ? 'public, max-age=604800' : 'no-store',
  });
  fs.createReadStream(fp).pipe(res);
}

/* ── 서버 ── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    /* API */
    if (p.startsWith('/api/')) {
      /* ai: AI 연상을 쓸 수 있는지. 키가 없으면 앱이 「AI 연상 만들기」 버튼을 감춘다 —
         눌러도 안 되는 버튼은 학생에게 앱이 고장 난 것처럼 보인다.
         키를 넣으면 다음 접속부터 버튼이 저절로 돌아온다. 값이 아니라 있고 없음만 알린다. */
      if (p === '/api/health') return json(res, 200, { ok: true, service: 'wb-reading', time: nowIso(), ai: !!process.env.ANTHROPIC_API_KEY });

      if (p === '/api/pub' && req.method === 'GET') return json(res, 200, { map: db.pubmap || {} });

      if (p === '/api/parent/summary' && req.method === 'GET') {
        const t = url.searchParams.get('t') || '';
        const code = /^[A-Za-z0-9]{16,64}$/.test(t) ? (db.parents || {})[t] : null;
        const stu = code && db.students[code];
        if (!stu) return json(res, 404, { error: '유효하지 않은 링크예요. 학원에 문의해 주세요.' });
        return json(res, 200, parentSummary(stu, db.states[code] || null, vocabStore.getState(code), vocabStore.getAssign(code)));
      }

      /* 학생 연동은 '요청 → 강사 승인' 두 단계 (워커와 동일) */
      if (p === '/api/login' && req.method === 'POST') {
        const { code, device } = await readBody(req);
        const stu = code && db.students[String(code).trim()];
        if (!stu) return json(res, 401, { error: '등록되지 않은 학생 코드예요. 선생님께 확인해 주세요.' });
        const nonce = crypto.randomUUID().replace(/-/g, '');
        db.pending = db.pending || {};
        db.pending[nonce] = {
          code: stu.code, name: stu.name, cls: stu.cls || '', grade: stu.grade || '',
          device: String(device || '').slice(0, 40), at: new Date().toISOString(),
          state: 'waiting', exp: Date.now() + PEND_TTL,
        };
        persist();
        return json(res, 200, { pending: true, nonce, name: stu.name });
      }

      if (p === '/api/login/status' && req.method === 'GET') {
        const nonce = url.searchParams.get('n') || '';
        const rec = db.pending && db.pending[nonce];
        if (!rec || rec.exp < Date.now()) { if (rec) { delete db.pending[nonce]; persist(); } return json(res, 404, { error: '연동 요청이 만료됐어요. 코드를 다시 입력해 주세요.' }); }
        if (rec.state === 'denied') { delete db.pending[nonce]; persist(); return json(res, 200, { denied: true }); }
        if (rec.state !== 'approved') return json(res, 200, { pending: true, name: rec.name });
        const stu = db.students[rec.code];
        if (!stu) return json(res, 404, { error: '학생 정보를 찾을 수 없어요.' });
        delete db.pending[nonce]; persist();
        return json(res, 200, { token: newToken(stu.code, false), student: stu });
      }

      if (p === '/api/admin/login' && req.method === 'POST') {
        const { pin } = await readBody(req);
        if (String(pin || '') !== ADMIN_PIN) return json(res, 401, { error: 'PIN이 올바르지 않습니다.' });
        return json(res, 200, { token: newToken('__admin__', true) });
      }

      const who = auth(req);
      if (!who) return json(res, 401, { error: '로그인이 필요합니다.' });

      /* 워드브레인 (/api/vocab/*) — 인증만 공유, 저장·라우트는 격리 */
      if (p.startsWith('/api/vocab/')) {
        const out = await handleVocab({
          path: p, method: req.method, who,
          getBody: () => readBody(req), store: vocabStore,
          ai: { apiKey: process.env.ANTHROPIC_API_KEY || '', model: process.env.VOCAB_AI_MODEL || '' },
          push: VOCAB_PUSH_ENV,
        });
        return json(res, out.status, out.body);
      }

      /* 학생 API */
      if (p === '/api/pull' && req.method === 'GET' && !who.admin) {
        const st = db.states[who.code] || null;
        const stu = db.students[who.code] || null;
        return json(res, 200, { state: st ? st.state : null, updatedAt: st ? st.updatedAt : null, level: stu ? stu.level : null, name: stu ? stu.name : null });
      }
      if (p === '/api/state' && req.method === 'PUT' && !who.admin) {
        const { state } = await readBody(req);
        if (!state || typeof state !== 'object') return json(res, 400, { error: 'state 필요' });
        if (JSON.stringify(state).length > 900_000) return json(res, 413, { error: '기록이 너무 커서 저장할 수 없어요.' });
        db.states[who.code] = { state, updatedAt: nowIso() };
        persist();
        return json(res, 200, { ok: true, updatedAt: db.states[who.code].updatedAt });
      }

      /* 우리 반 리그 — 같은 반 학생의 스트릭·주간 완료만 (성적 비공개) */
      if (p === '/api/league' && req.method === 'GET' && !who.admin) {
        const me = db.students[who.code];
        if (!me || !me.cls) return json(res, 200, { cls: '', members: [] });
        const members = Object.values(db.students)
          .filter(stu => stu.cls === me.cls)
          .map(stu => {
            const s = summarize(stu.code);
            return { name: stu.name, me: stu.code === who.code, streak: s.streak, week: s.week, today: s.today };
          })
          .sort((a, b) => b.streak - a.streak || b.week - a.week || (b.today ? 1 : 0) - (a.today ? 1 : 0));
        return json(res, 200, { cls: me.cls, members });
      }

      /* 관리자 API */
      if (!who.admin) return json(res, 403, { error: '권한이 없습니다.' });

      /* 학부모 주간 메시지 일괄 생성 */
      if (p === '/api/admin/parent-messages' && req.method === 'GET') {
        const origin = (req.headers['x-forwarded-proto'] || 'http') + '://' + (req.headers.host || 'localhost:' + PORT);
        db.parents = db.parents || {};
        const messages = [];
        for (const stu of Object.values(db.students)) {
          if (!stu.name || !db.states[stu.code]) continue; /* 앱 연동 학생만 */
          if (!stu.ptoken) {
            stu.ptoken = crypto.randomUUID().replace(/-/g, '');
            db.parents[stu.ptoken] = stu.code;
            persist();
          }
          const s = summarize(stu.code);
          messages.push({
            code: stu.code, name: stu.name, cls: stu.cls || '',
            text: `[WB 진로독서] ${stu.name} 학생 주간 리포트입니다.\n이번 주 ${s.week}회 완독 · ${s.streak}일 연속 읽는 중${s.acc != null ? ` · 문제 정답률 ${s.acc}%` : ''}입니다.\n자세한 내용: ${origin}/parent.html?t=${stu.ptoken}\n— WB 독해력학원 · 웩슬러브레인센터`,
          });
        }
        return json(res, 200, { messages });
      }
      if (p === '/api/admin/overview' && req.method === 'GET') {
        const codes = new Set([...Object.keys(db.students), ...Object.keys(db.states)]);
        return json(res, 200, { students: [...codes].map(summarize), time: nowIso() });
      }
      if (p === '/api/admin/students' && req.method === 'POST') {
        const { code, name, grade, cls, level } = await readBody(req);
        const c = String(code || '').trim();
        if (!/^[A-Za-z0-9-]{3,20}$/.test(c)) return json(res, 400, { error: '학생 코드는 영문/숫자 3~20자' });
        if (!name) return json(res, 400, { error: '이름 필요' });
        /* 기존 값을 펼쳐서 덮어쓴다 — 통째로 새로 만들면 학부모 토큰·교재 진도가 조용히 지워진다 */
        const prev = db.students[c] || {};
        db.students[c] = { ...prev, code: c, name, grade: grade || '', cls: cls || '', level: level || '', createdAt: prev.createdAt || nowIso() };
        persist();
        return json(res, 200, { ok: true, student: db.students[c] });
      }
      /* 반 하나를 등록하려면 폼을 사람 수만큼 채워야 했다 — 명단을 그대로 붙여넣게 한다 */
      if (p === '/api/admin/students/bulk' && req.method === 'POST') {
        const { text, cls, grade, level, prefix, dryRun } = await readBody(req);
        const { rows, errors } = parseRoster(text, { cls, grade, level, prefix, existing: Object.keys(db.students) });
        if (dryRun) return json(res, 200, { rows, errors, dryRun: true });
        let created = 0, updated = 0;
        for (const r of rows) {
          /* 기존 값을 펼쳐서 덮어쓴다 — 통째로 새로 만들면 학부모 토큰·교재 진도가 조용히 지워진다 */
          const prev = db.students[r.code];
          if (prev) updated += 1; else created += 1;
          db.students[r.code] = { ...(prev || {}), code: r.code, name: r.name, grade: r.grade, cls: r.cls,
            level: r.level, createdAt: (prev && prev.createdAt) || nowIso() };
        }
        if (rows.length) persist();
        return json(res, 200, { ok: true, created, updated, rows, errors });
      }
      if (p === '/api/admin/pending' && req.method === 'GET') {
        const now = Date.now();
        const items = Object.entries(db.pending || {})
          .filter(([, r]) => r.state === 'waiting' && r.exp > now)
          .map(([nonce, r]) => ({ ...r, nonce }))
          .sort((a, b) => (a.at < b.at ? 1 : -1));
        return json(res, 200, { pending: items });
      }
      if (p === '/api/admin/pending' && req.method === 'POST') {
        const { nonce, action } = await readBody(req);
        const rec = db.pending && db.pending[nonce];
        if (!rec) return json(res, 404, { error: '이미 처리됐거나 만료된 요청입니다.' });
        rec.state = action === 'deny' ? 'denied' : 'approved';
        persist();
        return json(res, 200, { ok: true, denied: action === 'deny' });
      }

      if (p === '/api/admin/level' && req.method === 'POST') {
        const { code, level } = await readBody(req);
        if (!db.students[code]) return json(res, 404, { error: '학생 없음' });
        if (!['L1', 'L2', 'L3', 'L4'].includes(level)) return json(res, 400, { error: '과정은 L1/L2/L3/L4' });
        db.students[code].level = level;
        db.levelLog.push({ code, level, at: nowIso() });
        persist();
        return json(res, 200, { ok: true });
      }
      /* 교재 진도 — 강사가 「초1 6강」을 지정하면 학부모 리포트에 그 주 코칭이 실린다 */
      if (p === '/api/admin/textbook' && req.method === 'GET') {
        return json(res, 200, { books: bookIndex(textbook()) });
      }
      if (p === '/api/admin/book' && req.method === 'POST') {
        const { code, bookId, lesson } = await readBody(req);
        const stu = db.students[code];
        if (!stu) return json(res, 404, { error: '학생 없음' });
        if (!bookId) { delete stu.book; persist(); return json(res, 200, { ok: true, book: null }); }
        const v = validProgress(textbook(), bookId, lesson);
        if (!v.ok) return json(res, 400, { error: v.error });
        stu.book = { bookId, lesson: v.lesson.lesson, at: nowIso() };
        persist();
        return json(res, 200, { ok: true, book: stu.book });
      }
      /* 교재 한 권을 통째로 열고 닫는다 — 강 번호가 아니라 confirm-all이라 아래 규칙과 겹치지 않는다 */
      const mAll = p.match(/^\/api\/admin\/textbook\/([A-Za-z0-9-]{1,40})\/confirm-all$/);
      if (mAll && req.method === 'POST') {
        const book = findBook(textbookRaw(), mAll[1]);
        if (!book) return json(res, 404, { error: '없는 교재예요.' });
        const { confirmed } = await readBody(req);
        db.textbook = db.textbook || {};
        const plan = confirmAllPlan(book, db.textbook, !!confirmed);
        const at = nowIso();
        for (const e of plan.entries) db.textbook[e.key] = { ...e.value, at };
        if (plan.entries.length) persist();
        return json(res, 200, { ok: true, confirmed: !!confirmed, done: plan.done, skipped: plan.skipped, blocked: plan.blocked });
      }

      /* 강사 검수 — 강 하나의 낱말을 통째로 저장한다 */
      const mLesson = p.match(/^\/api\/admin\/textbook\/([A-Za-z0-9-]{1,40})\/(\d{1,3})$/);
      if (mLesson && req.method === 'GET') {
        const v = validProgress(textbook(), mLesson[1], mLesson[2]);
        if (!v.ok) return json(res, 404, { error: v.error });
        return json(res, 200, { book: { id: v.book.id, short: v.book.short || v.book.title }, lesson: v.lesson });
      }
      if (mLesson && req.method === 'POST') {
        const bookId = mLesson[1], lessonNo = +mLesson[2];
        const v = validProgress(textbookRaw(), bookId, lessonNo);
        if (!v.ok) return json(res, 404, { error: v.error });
        const { words, confirmed } = await readBody(req);
        let list = cleanWords(words);
        if (confirmed) {
          const r = readyToConfirm(list);
          if (!r.ok) return json(res, 400, { error: r.error });
          list = r.words;
        }
        db.textbook = db.textbook || {};
        db.textbook[bookId + '#' + lessonNo] = { words: list, confirmed: !!confirmed, at: nowIso() };
        persist();
        return json(res, 200, { ok: true, words: list, confirmed: !!confirmed });
      }
      if (p === '/api/admin/export' && req.method === 'GET') {
        const day = url.searchParams.get('backup');
        if (day) {
          const snap = getBackup(day);
          if (!snap) return json(res, 404, { error: '해당 날짜의 스냅샷이 없습니다.' });
          return json(res, 200, snap);
        }
        return json(res, 200, { service: 'wb-reading', savedAt: nowIso(), students: db.students, states: db.states, vocab: db.vocab, textbook: db.textbook || {}, pubmap: db.pubmap || {} });
      }
      if (p === '/api/admin/backups' && req.method === 'GET') {
        return json(res, 200, { backups: listBackups() });
      }
      if (p === '/api/admin/backup-now' && req.method === 'POST') {
        return json(res, 200, { ok: true, day: snapshotNow() });
      }
      if (p === '/api/admin/pub' && req.method === 'POST') {
        const { id, status } = await readBody(req);
        if (!id || typeof id !== 'string' || id.length > 64) return json(res, 400, { error: 'id 필요' });
        if (!['published', 'draft'].includes(status)) return json(res, 400, { error: 'status는 published/draft' });
        db.pubmap = db.pubmap || {};
        db.pubmap[id] = status;
        persist();
        return json(res, 200, { ok: true, map: db.pubmap });
      }
      /* 퇴원 처리 (워커와 동일) — 학생이 남긴 것을 한 번에 지운다.
         하나라도 빠뜨리면 같은 코드로 새 학생을 등록했을 때 앞 학생 기록이 따라온다. */
      if (p === '/api/admin/students' && req.method === 'DELETE') {
        const { code } = await readBody(req);
        const c = String(code || '').trim();
        if (!/^[A-Za-z0-9-]{3,20}$/.test(c)) return json(res, 400, { error: '학생 코드 형식이 아닙니다' });
        const stu = db.students[c];
        if (!stu) return json(res, 404, { error: '학생 없음' });
        let removed = 0;
        const drop = (obj, k) => { if (obj && k in obj) { delete obj[k]; removed++; } };

        db.parents = db.parents || {};
        if (stu.ptoken) drop(db.parents, stu.ptoken);
        drop(db.states, c);
        drop(db.vocab.states, c);
        drop(db.vocab.push || {}, c);
        /* 기기 토큰은 토큰 값이 키라 코드로 못 찾는다 — 훑어서 이 학생 것만 */
        for (const [t, rec] of Object.entries(db.tokens)) if (rec && rec.code === c) drop(db.tokens, t);
        /* 승인 대기 줄에 남으면 지운 학생이 계속 뜬다 */
        for (const [n, rec] of Object.entries(db.pending || {})) if (rec && rec.code === c) drop(db.pending, n);
        drop(db.students, c);
        persist();
        return json(res, 200, { ok: true, code: c, name: stu.name, removed });
      }

      if (p === '/api/admin/parentlink' && req.method === 'POST') {
        const { code, reset } = await readBody(req);
        const stu = db.students[code];
        if (!stu) return json(res, 404, { error: '학생 없음' });
        db.parents = db.parents || {};
        if (stu.ptoken && !reset) return json(res, 200, { ok: true, token: stu.ptoken });
        if (stu.ptoken) delete db.parents[stu.ptoken];
        const t = crypto.randomUUID().replace(/-/g, '');
        stu.ptoken = t;
        db.parents[t] = stu.code;
        persist();
        return json(res, 200, { ok: true, token: t });
      }
      const mDetail = p.match(/^\/api\/admin\/student\/([A-Za-z0-9-]+)$/);
      if (mDetail && req.method === 'GET') {
        const code = mDetail[1];
        const st = db.states[code];
        /* 없는 학생이면 404 (워커와 동일) — 200에 student:null 을 주면 관리 화면이 터진다 */
        if (!db.students[code]) return json(res, 404, { error: '학생 없음' });
        return json(res, 200, { summary: summarize(code), student: db.students[code], state: st ? st.state : null, updatedAt: st ? st.updatedAt : null });
      }
      return json(res, 404, { error: 'unknown api' });
    }

    /* 관리 웹 */
    if (p === '/admin/qr.js') return serveFile(res, SHARED_DIR, 'qr.js');
    if (p === '/admin' || p === '/admin/') return serveFile(res, PUB_DIR, 'admin.html');
    if (p.startsWith('/admin/')) return serveFile(res, PUB_DIR, p.slice('/admin/'.length));

    /* 워드브레인 앱 */
    if (p === '/voice.js' || p === '/vocab/voice.js') return serveFile(res, SHARED_DIR, 'voice.js');
    if (p === '/vocab' || p === '/vocab/') return serveFile(res, VOCAB_DIR, 'index.html');
    if (p.startsWith('/vocab/')) return serveFile(res, VOCAB_DIR, p.slice('/vocab/'.length));

    /* 버전 — 발행 상태가 바뀌면 값도 바뀌어야 학생 기기 캐시가 갱신된다 (워커와 동일) */
    if (p === '/version.json') {
      try {
        const base = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'version.json'), 'utf8')).v || '0';
        const map = db.pubmap || {};
        const keys = Object.keys(map).sort();
        if (!keys.length) return json(res, 200, { v: base });
        let h = 0;
        for (const k of keys) { const s2 = k + ':' + map[k]; for (let i = 0; i < s2.length; i++) h = (h * 31 + s2.charCodeAt(i)) | 0; }
        return json(res, 200, { v: base + '-' + Math.abs(h).toString(36) });
      } catch (e) { /* 아래 정적 서빙으로 */ }
    }

    /* 발행 오버라이드 — 전체본과 학년대별 분할본 모두 (워커와 동일).
       분할본은 ?v= 로 버전이 붙어 오므로 오버라이드를 적용해도 캐시 헤더를 유지한다. */
    if (/^\/articles-L[1-4]\.json$/.test(p) && db.pubmap && Object.keys(db.pubmap).length) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(APP_DIR, p.slice(1)), 'utf8'));
        (data.articles || []).forEach(a => { if (db.pubmap[a.id]) a.status = db.pubmap[a.id]; });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=604800' });
        res.end(JSON.stringify(data));
        return;
      } catch (e) { /* 아래 정적 서빙으로 */ }
    }

    /* 한자 카드도 같은 규칙 (워커와 동일) — 내린 지문의 낱말이 카드에 남지 않도록
       낱말에 붙은 aid로 걸러 낸다. */
    if (p === '/hanja.json' && db.pubmap && Object.keys(db.pubmap).length) {
      try {
        const down = new Set(Object.keys(db.pubmap).filter(k => db.pubmap[k] !== 'published'));
        if (!down.size) throw new Error('내린 지문 없음');
        const data = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'hanja.json'), 'utf8'));
        data.families = (data.families || [])
          .map(f => ({ ...f, words: (f.words || []).filter(w => !down.has(w.aid)) }))
          .filter(f => f.words.length >= 2);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=604800' });
        res.end(JSON.stringify(data));
        return;
      } catch (e) { /* 아래 정적 서빙으로 */ }
    }

    /* 발행 오버라이드 적용된 articles.json */
    if (p === '/articles.json' && db.pubmap && Object.keys(db.pubmap).length) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'articles.json'), 'utf8'));
        (data.articles || []).forEach(a => { if (db.pubmap[a.id]) a.status = db.pubmap[a.id]; });
        return json(res, 200, data);
      } catch (e) { /* 파일 문제 시 원본 서빙으로 폴백 */ }
    }

    /* 교재 코칭 원문은 직접 열 수 없다 — WB가 쓴 글이라, 학부모는 자기 아이 링크로만,
       강사는 로그인해서만 본다. 서버·워커는 이 파일을 내부에서 읽어 쓴다. */
    if (p === '/textbook.json') return json(res, 404, { error: 'not found' });

    /* 학생 앱 */
    return serveFile(res, APP_DIR, p === '/' ? 'index.html' : p.slice(1));
  } catch (e) {
    json(res, 500, { error: '서버 오류', detail: String(e.message || e) });
  }
});

/* 밤 9시 물주기 푸시 — 로컬 서버용 1분 폴링 (운영 워커는 크론이 담당) */
let lastPushDay = null;
setInterval(async () => {
  const d = new Date();
  if (d.getHours() !== 21 || d.getMinutes() !== 0) return;
  const day = d.toDateString();
  if (lastPushDay === day) return;
  lastPushDay = day;
  try {
    const r = await sendNightPushes({ store: vocabStore, push: VOCAB_PUSH_ENV });
    if (r.sent || r.removed) console.log('[push] 밤 9시 물주기 알림:', JSON.stringify(r));
  } catch (e) { console.error('[push] 발송 실패:', e.message); }
}, 60000).unref();

server.listen(PORT, () => {
  console.log(`WB 진로독서 서버 http://localhost:${PORT}`);
  console.log(`  학생 앱: /   워드브레인: /vocab/   관리 웹: /admin   연상 검수함: /admin/vocab-review.html`);
  if (ADMIN_PIN === 'wb-admin-2026') console.log('  ⚠ 기본 ADMIN_PIN 사용 중 — 운영 배포 전 반드시 ADMIN_PIN 환경변수로 변경하세요.');
});
