'use strict';
/* WB 진로독서 — Cloudflare Workers 버전 (server.mjs의 이식)
   저장: KV(DB 바인딩) — student:<code> / state:<code> / token:<t>
   정적: [assets] dist/ (학생 앱 + /admin) */

const TOKEN_TTL_S = 60 * 60 * 24 * 30;

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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (!p.startsWith('/api/')) {
      /* 정적 자산 (학생 앱 + /admin) */
      return env.ASSETS.fetch(req);
    }

    try {
      if (p === '/api/health') return json(200, { ok: true, service: 'wb-reading', runtime: 'workers', time: nowIso() });

      if (p === '/api/login' && req.method === 'POST') {
        const { code } = await req.json();
        const stu = code && await env.DB.get('student:' + String(code).trim(), 'json');
        if (!stu) return json(401, { error: '등록되지 않은 학생 코드예요. 선생님께 확인해 주세요.' });
        return json(200, { token: await newToken(env, stu.code, false), student: stu });
      }

      if (p === '/api/admin/login' && req.method === 'POST') {
        const { pin } = await req.json();
        if (!env.ADMIN_PIN || String(pin || '') !== env.ADMIN_PIN) return json(401, { error: 'PIN이 올바르지 않습니다.' });
        return json(200, { token: await newToken(env, '__admin__', true) });
      }

      const who = await auth(env, req);
      if (!who) return json(401, { error: '로그인이 필요합니다.' });

      if (p === '/api/pull' && req.method === 'GET' && !who.admin) {
        const st = await env.DB.get('state:' + who.code, 'json');
        const stu = await env.DB.get('student:' + who.code, 'json');
        return json(200, { state: st ? st.state : null, updatedAt: st ? st.updatedAt : null, level: stu ? stu.level : null, name: stu ? stu.name : null });
      }
      if (p === '/api/state' && req.method === 'PUT' && !who.admin) {
        const { state } = await req.json();
        if (!state || typeof state !== 'object') return json(400, { error: 'state 필요' });
        const rec = { state, updatedAt: nowIso() };
        await env.DB.put('state:' + who.code, JSON.stringify(rec));
        return json(200, { ok: true, updatedAt: rec.updatedAt });
      }

      if (!who.admin) return json(403, { error: '권한이 없습니다.' });

      if (p === '/api/admin/overview' && req.method === 'GET') {
        const codes = new Set();
        for (const prefix of ['student:', 'state:']) {
          let cursor;
          do {
            const r = await env.DB.list({ prefix, cursor });
            r.keys.forEach(k => codes.add(k.name.slice(prefix.length)));
            cursor = r.list_complete ? null : r.cursor;
          } while (cursor);
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
        const stu = { code: c, name, grade: grade || '', cls: cls || '', level: level || '', createdAt: prev?.createdAt || nowIso() };
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
      const m = p.match(/^\/api\/admin\/student\/([A-Za-z0-9-]+)$/);
      if (m && req.method === 'GET') {
        const [stu, st] = await Promise.all([
          env.DB.get('student:' + m[1], 'json'),
          env.DB.get('state:' + m[1], 'json'),
        ]);
        return json(200, { summary: summarize(m[1], stu, st), state: st ? st.state : null, updatedAt: st ? st.updatedAt : null });
      }
      return json(404, { error: 'unknown api' });
    } catch (e) {
      return json(500, { error: '서버 오류', detail: String(e && e.message || e) });
    }
  },
};
