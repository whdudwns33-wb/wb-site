'use strict';
/* WB 진로독서 — Cloudflare Workers 버전 (server.mjs의 이식)
   저장: KV(DB 바인딩) — student:<code> / state:<code> / token:<t> / parent:<t> / pubmap / backup:<날짜>
   정적: [assets] dist/ (학생 앱 + /admin)
   크론: 매일 KV 스냅샷(backup:) 10개 보관 */

import { handleVocab, dumpVocab, sendNightPushes, vocabSummary } from './vocab-api.mjs';

const TOKEN_TTL_S = 60 * 60 * 24 * 30;
const STATE_MAX_BYTES = 900_000;   // 학생 기록 1건 최대 크기
const RL_MAX_FAILS = 20;           // 15분당 로그인 실패 허용 횟수
const BACKUP_KEEP = 10;

const json = (code, obj) => new Response(JSON.stringify(obj), {
  status: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

const nowIso = () => new Date().toISOString();

function dkeyOffset(off) {
  const d = new Date(Date.now() + 9 * 3600 * 1000); // KST 기준 날짜
  d.setUTCDate(d.getUTCDate() + off);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function summarize(code, stu, st) {
  const base = { code, name: stu?.name || '', cls: stu?.cls || '', grade: stu?.grade || '', level: stu?.level || '', linked: !!st };
  if (!st || !st.state) return { ...base, today: false, streak: 0, week: 0, reads: 0, acc: null, vocab: 0, scraps: 0, reports: 0, redbook: 0, train: 0, appLevel: '', lastActive: st ? st.updatedAt : null };
  const S = st.state;
  const days = S.days || {};
  let streak = 0; let k = dkeyOffset(0);
  if (!days[k]) k = dkeyOffset(-1);
  while (days[k] && streak < 999) {
    streak++;
    const d = new Date(k + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
    k = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  let week = 0; for (let i = 0; i < 7; i++) if (days[dkeyOffset(-i)]) week++;
  const quiz = Object.values(S.quiz || {});
  const qt = quiz.reduce((s, q) => s + (q.total || 0), 0);
  const qc = quiz.reduce((s, q) => s + (q.correct || 0), 0);
  return {
    ...base,
    today: !!days[dkeyOffset(0)], streak, week,
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

async function newToken(env, code, admin) {
  const t = crypto.randomUUID().replace(/-/g, '');
  await env.DB.put('token:' + t, JSON.stringify({ code, admin: !!admin }), { expirationTtl: TOKEN_TTL_S });
  return t;
}

async function auth(env, req) {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return null;
  return await env.DB.get('token:' + t, 'json');
}

/* 로그인 무차별 대입 완화 — 실패 횟수만 센다(성공 경로는 KV 쓰기 없음) */
function rlKey(req, bucket) {
  return 'rl:' + bucket + ':' + (req.headers.get('cf-connecting-ip') || 'unknown');
}
async function rlBlocked(env, req, bucket) {
  const n = parseInt(await env.DB.get(rlKey(req, bucket)), 10) || 0;
  return n >= RL_MAX_FAILS;
}
async function rlFail(env, req, bucket) {
  const key = rlKey(req, bucket);
  const n = parseInt(await env.DB.get(key), 10) || 0;
  await env.DB.put(key, String(n + 1), { expirationTtl: 900 });
}

async function kvListAll(env, prefix) {
  const keys = []; let cursor;
  do {
    const r = await env.DB.list({ prefix, cursor });
    keys.push(...r.keys.map(k => k.name));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return keys;
}

/* 워드브레인 저장소 어댑터 — vocab: 접두 키만 사용 (분리 가능한 격리) */
function vocabStore(env) {
  return {
    getState: (c) => env.DB.get('vocab:state:' + c, 'json'),
    putState: (c, rec) => env.DB.put('vocab:state:' + c, JSON.stringify(rec)),
    listStateCodes: async () => (await kvListAll(env, 'vocab:state:')).map(k => k.slice('vocab:state:'.length)),
    getStudent: (c) => env.DB.get('student:' + c, 'json'),
    getMnemo: (k) => env.DB.get('vocab:mnemo:' + k, 'json'),
    putMnemo: (k, rec) => env.DB.put('vocab:mnemo:' + k, JSON.stringify(rec)),
    listMnemos: async () => {
      const out = [];
      for (const k of await kvListAll(env, 'vocab:mnemo:')) {
        const v = await env.DB.get(k, 'json');
        if (v) out.push(v);
      }
      return out;
    },
    getPush: (c) => env.DB.get('vocab:push:' + c, 'json'),
    putPush: (c, rec) => env.DB.put('vocab:push:' + c, JSON.stringify(rec)),
    delPush: (c) => env.DB.delete('vocab:push:' + c),
    listPushCodes: async () => (await kvListAll(env, 'vocab:push:')).map(k => k.slice('vocab:push:'.length)),
    getAssign: (c) => env.DB.get('vocab:assign:' + c, 'json'),
    putAssign: (c, rec) => env.DB.put('vocab:assign:' + c, JSON.stringify(rec)),
    listAssignCodes: async () => (await kvListAll(env, 'vocab:assign:')).map(k => k.slice('vocab:assign:'.length)),
  };
}
function vocabPushEnv(env) {
  return {
    publicKey: env.VAPID_PUBLIC_KEY || '',
    privateJwk: env.VAPID_PRIVATE_JWK || '',
    subject: env.VAPID_SUBJECT || 'mailto:admin@wb.local',
  };
}

async function fullDump(env) {
  const students = {}; const states = {};
  const codes = new Set();
  for (const prefix of ['student:', 'state:']) {
    (await kvListAll(env, prefix)).forEach(k => codes.add(k.slice(prefix.length)));
  }
  for (const code of codes) {
    const [stu, st] = await Promise.all([
      env.DB.get('student:' + code, 'json'),
      env.DB.get('state:' + code, 'json'),
    ]);
    if (stu) students[code] = stu;
    if (st) states[code] = st;
  }
  const vocab = await dumpVocab(vocabStore(env));
  return { service: 'wb-reading', savedAt: nowIso(), students, states, vocab };
}

async function snapshotBackup(env) {
  const dump = await fullDump(env);
  const day = dkeyOffset(0);
  await env.DB.put('backup:' + day, JSON.stringify(dump));
  const keys = (await kvListAll(env, 'backup:')).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - BACKUP_KEEP))) await env.DB.delete(k);
  return day;
}

/* 지문 제목 맵 (학부모 리포트용) — 정적 자산에서 읽어 10분 캐시 */
let TITLE_CACHE = { t: 0, map: null };
async function titleMap(env, origin) {
  if (TITLE_CACHE.map && Date.now() - TITLE_CACHE.t < 600_000) return TITLE_CACHE.map;
  try {
    const r = await env.ASSETS.fetch(new Request(origin + '/articles.json'));
    const d = await r.json();
    const m = {};
    for (const a of d.articles || []) {
      m[a.id] = {};
      for (const lv of ['L2', 'L3', 'L4']) if (a.levels && a.levels[lv]) m[a.id][lv] = a.levels[lv].title;
    }
    TITLE_CACHE = { t: Date.now(), map: m };
  } catch (e) { TITLE_CACHE = { t: Date.now(), map: TITLE_CACHE.map || {} }; }
  return TITLE_CACHE.map;
}

function parentSummary(stu, st, titles, vst) {
  const sum = summarize(stu.code, stu, st);
  const S = (st && st.state) || {};
  const days = S.days || {};
  const dows = ['일', '월', '화', '수', '목', '금', '토'];
  const weekDays = [];
  for (let i = 6; i >= 0; i--) {
    const k = dkeyOffset(-i);
    const d = new Date(k + 'T12:00:00Z');
    weekDays.push({ dow: dows[d.getUTCDay()], done: !!days[k], today: i === 0 });
  }
  const anyTitle = (id, lv) => (titles[id] && (titles[id][lv] || titles[id].L3 || titles[id].L2 || titles[id].L4)) || id;
  const recent = Object.entries(S.readings || {})
    .sort((x, y) => (y[1].date < x[1].date ? -1 : 1))
    .slice(0, 5)
    .map(([id, r]) => ({ date: r.date, title: anyTitle(id, r.level) }));
  const reports = (S.reports || []).slice(-3).reverse().map(r => ({ title: r.title || '탐구보고서', done: r.done || '' }));
  const sp = S.speed || [];
  const speed = sp.length >= 2
    ? { last: sp[sp.length - 1].cpm, delta: sp[sp.length - 1].cpm - sp[0].cpm }
    : null;
  return {
    name: stu.name, cls: stu.cls || '', grade: stu.grade || '', level: sum.level || sum.appLevel || '',
    today: sum.today, streak: sum.streak, week: sum.week, weekDays,
    reads: sum.reads, acc: sum.acc, vocab: sum.vocab, redbook: sum.redbook, train: sum.train,
    recent, reports, speed, lastActive: sum.lastActive, generatedAt: nowIso(),
    wordbrain: vocabSummary(vst),
  };
}

export default {
  async scheduled(event, env, ctx) {
    /* 12:00 UTC(21:00 KST) = 밤 9시 물주기 푸시 / 그 외(18:00 UTC) = 일일 백업 */
    if (event.cron === '0 12 * * *') ctx.waitUntil(sendNightPushes({ store: vocabStore(env), push: vocabPushEnv(env) }));
    else ctx.waitUntil(snapshotBackup(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    /* 발행 오버라이드 적용된 articles.json */
    if (p === '/articles.json') {
      const res = await env.ASSETS.fetch(req);
      try {
        const map = await env.DB.get('pubmap', 'json');
        if (!map || !Object.keys(map).length) return res;
        const data = await res.json();
        (data.articles || []).forEach(a => { if (map[a.id]) a.status = map[a.id]; });
        return json(200, data);
      } catch (e) { return env.ASSETS.fetch(req); }
    }

    if (!p.startsWith('/api/')) {
      /* 정적 자산 (학생 앱 + /admin) */
      return env.ASSETS.fetch(req);
    }

    try {
      if (p === '/api/health') return json(200, { ok: true, service: 'wb-reading', runtime: 'workers', time: nowIso() });

      /* 발행 상태 맵 — 공개 읽기 (지문 발행 여부는 민감정보가 아님, 운영 루틴이 git 반영에 사용) */
      if (p === '/api/pub' && req.method === 'GET') {
        const map = await env.DB.get('pubmap', 'json');
        return json(200, { map: map || {} });
      }

      if (p === '/api/login' && req.method === 'POST') {
        if (await rlBlocked(env, req, 'stu')) return json(429, { error: '시도가 너무 많아요. 15분 뒤 다시 해 주세요.' });
        const { code } = await req.json();
        const stu = code && await env.DB.get('student:' + String(code).trim(), 'json');
        if (!stu) { await rlFail(env, req, 'stu'); return json(401, { error: '등록되지 않은 학생 코드예요. 선생님께 확인해 주세요.' }); }
        return json(200, { token: await newToken(env, stu.code, false), student: stu });
      }

      if (p === '/api/admin/login' && req.method === 'POST') {
        if (await rlBlocked(env, req, 'adm')) return json(429, { error: '시도가 너무 많습니다. 15분 뒤 다시 해 주세요.' });
        const { pin } = await req.json();
        if (!env.ADMIN_PIN || String(pin || '') !== env.ADMIN_PIN) { await rlFail(env, req, 'adm'); return json(401, { error: 'PIN이 올바르지 않습니다.' }); }
        return json(200, { token: await newToken(env, '__admin__', true) });
      }

      /* 학부모 리포트 — 학생별 열람 토큰으로 접근(로그인 불필요) */
      if (p === '/api/parent/summary' && req.method === 'GET') {
        const t = url.searchParams.get('t') || '';
        const code = /^[A-Za-z0-9]{16,64}$/.test(t) ? await env.DB.get('parent:' + t) : null;
        if (!code) return json(404, { error: '유효하지 않은 링크예요. 학원에 문의해 주세요.' });
        const [stu, st] = await Promise.all([
          env.DB.get('student:' + code, 'json'),
          env.DB.get('state:' + code, 'json'),
        ]);
        if (!stu) return json(404, { error: '학생 정보를 찾을 수 없어요.' });
        const titles = await titleMap(env, url.origin);
        const vst = await vocabStore(env).getState(code);
        return json(200, parentSummary(stu, st, titles, vst));
      }

      const who = await auth(env, req);
      if (!who) return json(401, { error: '로그인이 필요합니다.' });

      /* 워드브레인 (/api/vocab/*) — 인증만 공유, 저장·라우트는 격리 */
      if (p.startsWith('/api/vocab/')) {
        const out = await handleVocab({
          path: p, method: req.method, who,
          getBody: () => req.json(), store: vocabStore(env),
          ai: { apiKey: env.ANTHROPIC_API_KEY || '', model: env.VOCAB_AI_MODEL || '' },
          push: vocabPushEnv(env),
        });
        return json(out.status, out.body);
      }

      if (p === '/api/pull' && req.method === 'GET' && !who.admin) {
        const st = await env.DB.get('state:' + who.code, 'json');
        const stu = await env.DB.get('student:' + who.code, 'json');
        return json(200, { state: st ? st.state : null, updatedAt: st ? st.updatedAt : null, level: stu ? stu.level : null, name: stu ? stu.name : null });
      }
      if (p === '/api/state' && req.method === 'PUT' && !who.admin) {
        const { state } = await req.json();
        if (!state || typeof state !== 'object') return json(400, { error: 'state 필요' });
        const raw = JSON.stringify({ state, updatedAt: nowIso() });
        if (raw.length > STATE_MAX_BYTES) return json(413, { error: '기록이 너무 커서 저장할 수 없어요.' });
        await env.DB.put('state:' + who.code, raw);
        return json(200, { ok: true, updatedAt: JSON.parse(raw).updatedAt });
      }

      /* 우리 반 리그 — 같은 반 학생의 스트릭·주간 완료만 (정답률 등 성적은 비공개) */
      if (p === '/api/league' && req.method === 'GET' && !who.admin) {
        const me = await env.DB.get('student:' + who.code, 'json');
        if (!me || !me.cls) return json(200, { cls: '', members: [] });
        const codes = (await kvListAll(env, 'student:')).map(k => k.slice('student:'.length));
        const members = [];
        for (const c of codes) {
          const stu = await env.DB.get('student:' + c, 'json');
          if (!stu || stu.cls !== me.cls) continue;
          const st = await env.DB.get('state:' + c, 'json');
          const s = summarize(c, stu, st);
          members.push({ name: stu.name, me: c === who.code, streak: s.streak, week: s.week, today: s.today });
        }
        members.sort((a, b) => b.streak - a.streak || b.week - a.week || (b.today ? 1 : 0) - (a.today ? 1 : 0));
        return json(200, { cls: me.cls, members });
      }

      if (!who.admin) return json(403, { error: '권한이 없습니다.' });

      /* 학부모 주간 메시지 일괄 생성 — 연동 학생마다 링크 포함 발송 문구 */
      if (p === '/api/admin/parent-messages' && req.method === 'GET') {
        const codes = (await kvListAll(env, 'student:')).map(k => k.slice('student:'.length));
        const messages = [];
        for (const c of codes) {
          const stu = await env.DB.get('student:' + c, 'json');
          if (!stu || !stu.name) continue;
          const st = await env.DB.get('state:' + c, 'json');
          if (!st) continue; /* 앱 연동 학생만 */
          if (!stu.ptoken) {
            const t = crypto.randomUUID().replace(/-/g, '');
            stu.ptoken = t;
            await env.DB.put('parent:' + t, stu.code);
            await env.DB.put('student:' + stu.code, JSON.stringify(stu));
          }
          const s = summarize(c, stu, st);
          messages.push({
            code: c, name: stu.name, cls: stu.cls || '',
            text: `[WB 진로독서] ${stu.name} 학생 주간 리포트입니다.\n이번 주 ${s.week}회 완독 · ${s.streak}일 연속 읽는 중${s.acc != null ? ` · 문제 정답률 ${s.acc}%` : ''}입니다.\n자세한 내용: ${url.origin}/parent.html?t=${stu.ptoken}\n— WB 독해력학원 · 웩슬러브레인센터`,
          });
        }
        return json(200, { messages });
      }

      if (p === '/api/admin/overview' && req.method === 'GET') {
        const codes = new Set();
        for (const prefix of ['student:', 'state:']) {
          (await kvListAll(env, prefix)).forEach(k => codes.add(k.slice(prefix.length)));
        }
        const students = [];
        for (const code of codes) {
          const [stu, st] = await Promise.all([
            env.DB.get('student:' + code, 'json'),
            env.DB.get('state:' + code, 'json'),
          ]);
          students.push(summarize(code, stu, st));
        }
        return json(200, { students, time: nowIso() });
      }
      if (p === '/api/admin/students' && req.method === 'POST') {
        const { code, name, grade, cls, level } = await req.json();
        const c = String(code || '').trim();
        if (!/^[A-Za-z0-9-]{3,20}$/.test(c)) return json(400, { error: '학생 코드는 영문/숫자 3~20자' });
        if (!name) return json(400, { error: '이름 필요' });
        const prev = await env.DB.get('student:' + c, 'json');
        const stu = { ...(prev || {}), code: c, name, grade: grade || '', cls: cls || '', level: level || '', createdAt: prev?.createdAt || nowIso() };
        await env.DB.put('student:' + c, JSON.stringify(stu));
        return json(200, { ok: true, student: stu });
      }
      if (p === '/api/admin/level' && req.method === 'POST') {
        const { code, level } = await req.json();
        const stu = await env.DB.get('student:' + code, 'json');
        if (!stu) return json(404, { error: '학생 없음' });
        if (!['L2', 'L3', 'L4'].includes(level)) return json(400, { error: '레벨은 L2/L3/L4' });
        stu.level = level;
        await env.DB.put('student:' + code, JSON.stringify(stu));
        return json(200, { ok: true });
      }

      /* 백업: 전체 내려받기 / 자동 스냅샷 목록·내려받기 */
      if (p === '/api/admin/export' && req.method === 'GET') {
        const day = url.searchParams.get('backup');
        if (day) {
          const snap = await env.DB.get('backup:' + day, 'json');
          if (!snap) return json(404, { error: '해당 날짜의 스냅샷이 없습니다.' });
          return json(200, snap);
        }
        return json(200, await fullDump(env));
      }
      if (p === '/api/admin/backups' && req.method === 'GET') {
        const keys = (await kvListAll(env, 'backup:')).sort().reverse();
        return json(200, { backups: keys.map(k => k.slice('backup:'.length)) });
      }
      if (p === '/api/admin/backup-now' && req.method === 'POST') {
        return json(200, { ok: true, day: await snapshotBackup(env) });
      }

      /* 발행 오버라이드: 검수 뷰어의 발행/초안 원클릭 */
      if (p === '/api/admin/pub' && req.method === 'POST') {
        const { id, status } = await req.json();
        if (!id || typeof id !== 'string' || id.length > 64) return json(400, { error: 'id 필요' });
        if (!['published', 'draft'].includes(status)) return json(400, { error: 'status는 published/draft' });
        const map = (await env.DB.get('pubmap', 'json')) || {};
        map[id] = status;
        await env.DB.put('pubmap', JSON.stringify(map));
        return json(200, { ok: true, map });
      }

      /* 학부모 링크 발급/재발급 */
      if (p === '/api/admin/parentlink' && req.method === 'POST') {
        const { code, reset } = await req.json();
        const stu = await env.DB.get('student:' + code, 'json');
        if (!stu) return json(404, { error: '학생 없음' });
        if (stu.ptoken && !reset) return json(200, { ok: true, token: stu.ptoken });
        if (stu.ptoken) await env.DB.delete('parent:' + stu.ptoken);
        const t = crypto.randomUUID().replace(/-/g, '');
        stu.ptoken = t;
        await env.DB.put('parent:' + t, stu.code);
        await env.DB.put('student:' + stu.code, JSON.stringify(stu));
        return json(200, { ok: true, token: t });
      }

      const m = p.match(/^\/api\/admin\/student\/([A-Za-z0-9-]+)$/);
      if (m && req.method === 'GET') {
        const [stu, st] = await Promise.all([
          env.DB.get('student:' + m[1], 'json'),
          env.DB.get('state:' + m[1], 'json'),
        ]);
        return json(200, { summary: summarize(m[1], stu, st), student: stu, state: st ? st.state : null, updatedAt: st ? st.updatedAt : null });
      }
      return json(404, { error: 'unknown api' });
    } catch (e) {
      return json(500, { error: '서버 오류', detail: String(e && e.message || e) });
    }
  },
};
