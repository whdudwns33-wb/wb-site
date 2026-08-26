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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(ROOT, '..', 'reading');      // 학생 앱 정적 파일
const PUB_DIR = path.join(ROOT, 'public');             // 관리 웹
const PORT = +(process.env.PORT || 8890);
const ADMIN_PIN = process.env.ADMIN_PIN || 'wb-admin-2026';
const TOKEN_TTL = 1000 * 60 * 60 * 24 * 30;            // 30일

load();
const db = getDb();

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
      for (const lv of ['L2', 'L3', 'L4']) if (a.levels && a.levels[lv]) m[a.id][lv] = a.levels[lv].title;
    }
    TITLE_CACHE = { t: Date.now(), map: m };
  } catch (e) { TITLE_CACHE = { t: Date.now(), map: TITLE_CACHE.map || {} }; }
  return TITLE_CACHE.map;
}
function parentSummary(stu, st) {
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
  const anyTitle = (id, lv) => (titles[id] && (titles[id][lv] || titles[id].L3 || titles[id].L2 || titles[id].L4)) || id;
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
  };
}

/* ── 정적 파일 ── */
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.pdf': 'application/pdf', '.css': 'text/css; charset=utf-8' };
function serveFile(res, base, rel) {
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  let fp = path.join(base, safe);
  if (!fp.startsWith(base)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(fp).pipe(res);
}

/* ── 서버 ── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    /* API */
    if (p.startsWith('/api/')) {
      if (p === '/api/health') return json(res, 200, { ok: true, service: 'wb-reading', time: nowIso() });

      if (p === '/api/pub' && req.method === 'GET') return json(res, 200, { map: db.pubmap || {} });

      if (p === '/api/parent/summary' && req.method === 'GET') {
        const t = url.searchParams.get('t') || '';
        const code = /^[A-Za-z0-9]{16,64}$/.test(t) ? (db.parents || {})[t] : null;
        const stu = code && db.students[code];
        if (!stu) return json(res, 404, { error: '유효하지 않은 링크예요. 학원에 문의해 주세요.' });
        return json(res, 200, parentSummary(stu, db.states[code] || null));
      }

      if (p === '/api/login' && req.method === 'POST') {
        const { code } = await readBody(req);
        const stu = code && db.students[String(code).trim()];
        if (!stu) return json(res, 401, { error: '등록되지 않은 학생 코드예요. 선생님께 확인해 주세요.' });
        return json(res, 200, { token: newToken(stu.code, false), student: stu });
      }

      if (p === '/api/admin/login' && req.method === 'POST') {
        const { pin } = await readBody(req);
        if (String(pin || '') !== ADMIN_PIN) return json(res, 401, { error: 'PIN이 올바르지 않습니다.' });
        return json(res, 200, { token: newToken('__admin__', true) });
      }

      const who = auth(req);
      if (!who) return json(res, 401, { error: '로그인이 필요합니다.' });

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

      /* 관리자 API */
      if (!who.admin) return json(res, 403, { error: '권한이 없습니다.' });
      if (p === '/api/admin/overview' && req.method === 'GET') {
        const codes = new Set([...Object.keys(db.students), ...Object.keys(db.states)]);
        return json(res, 200, { students: [...codes].map(summarize), time: nowIso() });
      }
      if (p === '/api/admin/students' && req.method === 'POST') {
        const { code, name, grade, cls, level } = await readBody(req);
        const c = String(code || '').trim();
        if (!/^[A-Za-z0-9-]{3,20}$/.test(c)) return json(res, 400, { error: '학생 코드는 영문/숫자 3~20자' });
        if (!name) return json(res, 400, { error: '이름 필요' });
        db.students[c] = { code: c, name, grade: grade || '', cls: cls || '', level: level || '', createdAt: (db.students[c] || {}).createdAt || nowIso() };
        persist();
        return json(res, 200, { ok: true, student: db.students[c] });
      }
      if (p === '/api/admin/level' && req.method === 'POST') {
        const { code, level } = await readBody(req);
        if (!db.students[code]) return json(res, 404, { error: '학생 없음' });
        if (!['L2', 'L3', 'L4'].includes(level)) return json(res, 400, { error: '레벨은 L2/L3/L4' });
        db.students[code].level = level;
        db.levelLog.push({ code, level, at: nowIso() });
        persist();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/admin/export' && req.method === 'GET') {
        const day = url.searchParams.get('backup');
        if (day) {
          const snap = getBackup(day);
          if (!snap) return json(res, 404, { error: '해당 날짜의 스냅샷이 없습니다.' });
          return json(res, 200, snap);
        }
        return json(res, 200, { service: 'wb-reading', savedAt: nowIso(), students: db.students, states: db.states });
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
        return json(res, 200, { summary: summarize(code), student: db.students[code] || null, state: st ? st.state : null, updatedAt: st ? st.updatedAt : null });
      }
      return json(res, 404, { error: 'unknown api' });
    }

    /* 관리 웹 */
    if (p === '/admin' || p === '/admin/') return serveFile(res, PUB_DIR, 'admin.html');
    if (p.startsWith('/admin/')) return serveFile(res, PUB_DIR, p.slice('/admin/'.length));

    /* 발행 오버라이드 적용된 articles.json */
    if (p === '/articles.json' && db.pubmap && Object.keys(db.pubmap).length) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'articles.json'), 'utf8'));
        (data.articles || []).forEach(a => { if (db.pubmap[a.id]) a.status = db.pubmap[a.id]; });
        return json(res, 200, data);
      } catch (e) { /* 파일 문제 시 원본 서빙으로 폴백 */ }
    }

    /* 학생 앱 */
    return serveFile(res, APP_DIR, p === '/' ? 'index.html' : p.slice(1));
  } catch (e) {
    json(res, 500, { error: '서버 오류', detail: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`WB 진로독서 서버 http://localhost:${PORT}`);
  console.log(`  학생 앱: /   관리 웹: /admin   API: /api/health`);
  if (ADMIN_PIN === 'wb-admin-2026') console.log('  ⚠ 기본 ADMIN_PIN 사용 중 — 운영 배포 전 반드시 ADMIN_PIN 환경변수로 변경하세요.');
});
