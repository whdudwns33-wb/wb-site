'use strict';
/* WB 워드브레인 — /api/vocab/* 라우트 (server.mjs·worker.mjs 공용, "분리 가능한 A" 구조)
   격리 원칙: 라우트는 /api/vocab/* 아래, 데이터는 vocab 전용 저장소(워커: vocab: 접두 키, 로컬: db.vocab)만 쓴다.
   인증은 호스트(진로독서)의 토큰 검증 결과(who)를 그대로 받는다 — 학생은 연동 한 번으로 두 앱을 쓴다.
   나중에 단독 서비스로 분리할 때는 이 모듈 + vocab 저장소만 들어내면 된다. */

const STATE_MAX_BYTES = 400_000; // 워드브레인 기록 1건 최대 크기
const nowIso = () => new Date().toISOString();

/* ── AI 찰떡 연상 생성 (Claude API, raw fetch — 무의존성·Workers/Node 공용) ──
   기본 모델 claude-opus-5 + 서버측 refusal fallback 기본 활성. */
const AI_SYSTEM = `너는 WB 독해력학원의 어휘 연상(암기 고리) 작가다. 초등 고학년~중학생이 단어를 오래 기억하도록 짧고 선명한 연상을 만든다.

어종별 방식:
- english: 발음과 비슷한 우리말 키워드를 찾아 뜻과 이어지는 장면을 만든다(키워드 연상법). cue에 그 키워드 고리를 담는다.
- hanja: 제공된 한자의 훈(뜻)을 살려 글자들이 조립되어 뜻이 되는 이야기를 만든다.
- native: 뜻이 눈앞에 그려지는 구체적인 장면 하나를 만든다.

규칙:
- cue는 20자 안팎의 한 줄 연상 고리, scene은 1~2문장의 그림이 그려지는 장면.
- 약간 엉뚱하고 과장되게(기억에 남게), 그러나 밝고 유쾌하게.
- 금지: 폭력·공포·선정성·비하·놀림·특정 인물 조롱. 학생 관심사가 주어지면 자연스러울 때만 활용.
- 출력은 JSON 하나만. 형식: {"candidates":[{"cue":"...","scene":"..."},{"cue":"...","scene":"..."},{"cue":"...","scene":"..."}]}
- candidates는 서로 다른 접근의 연상 3개. JSON 밖에 다른 텍스트를 쓰지 않는다.`;

export function parseCandidates(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const d = JSON.parse(t.slice(start, end + 1));
    const arr = Array.isArray(d.candidates) ? d.candidates : null;
    if (!arr) return null;
    const out = arr
      .filter(c => c && typeof c.cue === 'string' && typeof c.scene === 'string')
      .map(c => ({ cue: c.cue.trim().slice(0, 120), scene: c.scene.trim().slice(0, 300) }))
      .filter(c => c.cue.length >= 2 && c.scene.length >= 4)
      .slice(0, 3);
    return out.length ? out : null;
  } catch (e) { return null; }
}

export async function aiMnemonic({ word, meaning, type, hanja, interests, apiKey, model }) {
  if (!apiKey) return { ok: false, reason: 'no-key' };
  const user = [
    '어종: ' + type,
    '단어: ' + word,
    '뜻: ' + meaning,
    hanja ? '한자: ' + hanja : null,
    interests ? '학생 관심사: ' + interests : null,
  ].filter(Boolean).join('\n');
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model: model || 'claude-opus-5',
        max_tokens: 2000,
        fallbacks: 'default',
        system: AI_SYSTEM,
        messages: [{ role: 'user', content: user }],
      }),
    });
  } catch (e) { return { ok: false, reason: 'network' }; }
  if (!r.ok) return { ok: false, reason: 'api-' + r.status };
  const d = await r.json();
  if (d.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
  const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const candidates = parseCandidates(text);
  if (!candidates) return { ok: false, reason: 'parse' };
  return { ok: true, candidates, model: d.model };
}

/* ── 학생별 워드브레인 요약 (강사 현황판·검수 페이지용) ── */
const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 90];
export function vocabSummary(stateRec) {
  const base = { linked: !!stateRec, total: 0, graduated: 0, due: 0, emergency: 0, streak: 0, msAvg: null, lastActive: stateRec ? stateRec.updatedAt : null };
  const S = stateRec && stateRec.state;
  if (!S || !S.states) return base;
  const now = Date.now();
  let msSum = 0, msN = 0;
  for (const s of Object.values(S.states)) {
    base.total += 1;
    if (s.emaMs) { msSum += s.emaMs; msN += 1; }
    if (s.graduated) { base.graduated += 1; continue; }
    if (s.due <= now) {
      base.due += 1;
      const iv = Math.max(INTERVAL_DAYS[Math.min(s.step || 0, 6)] || 0, 0.5) * 86400000;
      if ((now - s.due) / iv >= 1.25) base.emergency += 1;
    }
  }
  if (msN) base.msAvg = Math.round(msSum / msN);
  base.streak = (S.streak && S.streak.count) || 0;
  return base;
}

const mnemoKey = (word) => String(word || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 60);

/* ── 라우터 ──
   ctx = {
     path, method, who,                    // who: {code, admin} | null — 호스트가 검증한 토큰
     getBody: async () => object,
     store: {                              // vocab 전용 저장소 어댑터 (전부 async 허용)
       getState(code), putState(code, rec),
       listStateCodes(), getStudent(code),
       getMnemo(key), putMnemo(key, rec), listMnemos(),
     },
     ai: { apiKey, model, generate? },     // generate는 테스트 주입용 (기본 aiMnemonic)
   }
   반환: { status, body } — /api/vocab/* 이 아닌 경로는 호출 전에 호스트가 거른다. */
export async function handleVocab(ctx) {
  const { path: p, method, who, store } = ctx;
  const j = (status, body) => ({ status, body });
  if (!who) return j(401, { error: '로그인이 필요합니다.' });

  /* ── 학생 ── */
  if (p === '/api/vocab/pull' && method === 'GET' && !who.admin) {
    const st = await store.getState(who.code);
    return j(200, { state: st ? st.state : null, updatedAt: st ? st.updatedAt : null });
  }
  if (p === '/api/vocab/state' && method === 'PUT' && !who.admin) {
    const { state } = await ctx.getBody();
    if (!state || typeof state !== 'object') return j(400, { error: 'state 필요' });
    const rec = { state, updatedAt: nowIso() };
    if (JSON.stringify(rec).length > STATE_MAX_BYTES) return j(413, { error: '기록이 너무 커서 저장할 수 없어요.' });
    await store.putState(who.code, rec);
    return j(200, { ok: true, updatedAt: rec.updatedAt });
  }
  if (p === '/api/vocab/mnemonic' && method === 'POST' && !who.admin) {
    const b = await ctx.getBody();
    const word = String(b.word || '').trim();
    const meaning = String(b.meaning || '').trim();
    const type = String(b.type || '').trim();
    if (!word || word.length > 80 || !meaning || meaning.length > 300) return j(400, { error: '단어와 뜻이 필요해요.' });
    if (!['english', 'hanja', 'native'].includes(type)) return j(400, { error: '어종은 english/hanja/native' });
    const key = mnemoKey(word);
    const prev = await store.getMnemo(key);
    if (prev && prev.status === 'approved' && prev.approved) {
      return j(200, { ok: true, status: 'approved', candidates: [prev.approved] });
    }
    if (prev && prev.status === 'pending' && prev.candidates) {
      return j(200, { ok: true, status: 'pending', candidates: prev.candidates });
    }
    const generate = ctx.ai.generate || aiMnemonic;
    const out = await generate({
      word, meaning, type,
      hanja: b.hanja ? String(b.hanja).slice(0, 200) : undefined,
      interests: b.interests ? String(b.interests).slice(0, 100) : undefined,
      apiKey: ctx.ai.apiKey, model: ctx.ai.model,
    });
    if (!out.ok) return j(200, { ok: false, reason: out.reason });
    await store.putMnemo(key, {
      key, word, meaning, type, candidates: out.candidates,
      requestedBy: who.code, at: nowIso(), status: 'pending', model: out.model || null,
    });
    return j(200, { ok: true, status: 'pending', candidates: out.candidates });
  }

  /* ── 관리자 (강사) ── */
  if (!who.admin) return j(403, { error: '권한이 없습니다.' });

  if (p === '/api/vocab/admin/review' && method === 'GET') {
    const items = await store.listMnemos();
    items.sort((a, b) => (a.status === 'pending') === (b.status === 'pending') ? (a.at < b.at ? 1 : -1) : (a.status === 'pending' ? -1 : 1));
    return j(200, { items, time: nowIso() });
  }
  if (p === '/api/vocab/admin/review' && method === 'POST') {
    const { key, action, cue, scene } = await ctx.getBody();
    const rec = key && await store.getMnemo(mnemoKey(key));
    if (!rec) return j(404, { error: '검수 항목 없음' });
    if (action === 'approve') {
      if (!cue || !scene) return j(400, { error: '승인할 연상(cue·scene)이 필요해요.' });
      rec.status = 'approved';
      rec.approved = { cue: String(cue).slice(0, 120), scene: String(scene).slice(0, 300) };
      rec.decidedAt = nowIso();
    } else if (action === 'reject') {
      rec.status = 'rejected';
      rec.approved = null;
      rec.decidedAt = nowIso();
    } else return j(400, { error: 'action은 approve/reject' });
    await store.putMnemo(rec.key, rec);
    return j(200, { ok: true, item: rec });
  }
  if (p === '/api/vocab/admin/overview' && method === 'GET') {
    const codes = await store.listStateCodes();
    const students = [];
    for (const code of codes) {
      const [stu, st] = await Promise.all([store.getStudent(code), store.getState(code)]);
      students.push({ code, name: (stu && stu.name) || '', cls: (stu && stu.cls) || '', ...vocabSummary(st) });
    }
    return j(200, { students, time: nowIso() });
  }
  return j(404, { error: 'unknown api' });
}

/* 백업 스냅샷용 전체 덤프 */
export async function dumpVocab(store) {
  const states = {};
  for (const code of await store.listStateCodes()) states[code] = await store.getState(code);
  const mnemos = {};
  for (const m of await store.listMnemos()) mnemos[m.key] = m;
  return { states, mnemos };
}
