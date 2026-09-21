'use strict';
/* 하루브레인 — /api/haru/* 라우트 (server.mjs·worker.mjs 공용, naesin-api.mjs 선례)
   격리 원칙: 라우트는 /api/haru/* 아래, 데이터는 haru: 접두 KV(로컬은 db.haru)만 쓴다.
   인증은 호스트의 토큰 검증 결과(who)를 받는다. apps 게이트(allowedApp)는 호스트가 who 검증 직후 한 곳에서 건다 —
   여기서만 걸면 외부 초6 토큰이 진로독서·워드브레인·내신을 여는 유출이 그대로다(설계안 §7-4).

   이 앱의 성립 조건: GET /pack·/gen 은 정답을 뺀다. 정답은 /answer 응답에만, 그것도 응답 뒤에만 나간다.
   학생 기록은 쓰기 주체별 3키 — haru:state(학생 기기)·haru:mock(서버 채점)·haru:paper(강사 입력). PUT /state 에 mocks·paper 가 오면 400. */
import PC from '../haru/pack-check.js';
import AC from '../haru/atoms-check.js';
import M from '../haru/mastery.js';
import PR from '../haru/probe.js';
import P from '../haru/plan.js';
import S from '../haru/strings.js';
import C from '../haru/cause.js';
import CALC from '../haru/calc.js';
import KM from '../haru/kor-master.js';
import KD from '../haru/kor-master-data.json' with { type: 'json' };
import { scorePeriod, mockRecord, keyFromPack, pctOf, distUpdate, distView, boardRows, coachMap, aggWeek, MOCKS_MAX } from './haru-score.mjs';

export const STATE_MAX_BYTES = 400_000;      // 학생 기록 1건 상한(UTF-8 바이트). 코어 16 + 주변 + 지문·주차 스냅샷이 이 안이다
export const PACK_MAX_BYTES = 524_288;       // 팩 512KB (설계안 §7-1)
export const BODY_LIMIT_PACK = 4_718_592;    // /admin/pack·/admin/plan·/admin/atoms
export const BODY_LIMIT_STATE = 307_200;     // 그 외 전부
export const PUTS_PER_DAY = 3;               // PUT /state 하루 상한 — KV 1,000 writes/일은 네임스페이스 합산이다
export const PARENT_TTL_DAYS = 30;           // ptoken 만료 = 시험일 + 보유기간
const BIG_BODY_PATHS = ['/api/haru/admin/pack', '/api/haru/admin/plan', '/api/haru/admin/atoms'];
export const haruBodyLimit = (p) => (BIG_BODY_PATHS.includes(p) ? BODY_LIMIT_PACK : BODY_LIMIT_STATE);
const PACK_ID_RE = /^[A-Za-z0-9-]{3,60}$/;
const CODE_RE = /^[A-Za-z0-9-]{3,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[a-f0-9]{32}$/;
const SUBJECTS = ['kor', 'math', 'eng'];
const TOO_LARGE = Symbol('too-large');

const nowIso = (t) => new Date(t == null ? Date.now() : t).toISOString();
const byteLen = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const strMax = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const int0 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0; };
export function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}
export const todayKst = (now) => P.kstDate(now == null ? Date.now() : now);

/* ── apps 게이트 (기획서 D-6) — 호스트가 who 검증 직후 한 곳에서 부른다 ──
   stu.apps == null → 재원생(전부 허용). 배열이면 그 목록만. 경로 → 앱 이름은 appOfPath. */
export function appOfPath(p) {
  if (p.startsWith('/api/token/')) return null;               // 토큰 재발급은 앱이 아니다 — 어느 앱의 학생이든 지난다
  if (p.startsWith('/api/haru/')) return 'haru';
  if (p.startsWith('/api/vocab/')) return 'vocab';
  if (p.startsWith('/api/naesin/')) return 'naesin';
  if (p.startsWith('/api/letter/')) return 'letter';           // 브레인레터 — 재원생(apps null)은 전부, 외부 학생은 apps 에 'letter' 가 있어야
  return 'reading';
}
export function allowedApp(stu, app) {
  if (!stu) return false;
  if (app == null || stu.apps == null) return true;
  return Array.isArray(stu.apps) && stu.apps.includes(app);
}
export const isRetroPath = (p, method) => p === '/api/haru/retro' || (method === 'GET' && (p === '/api/haru/plan' || p === '/api/haru/state' || p === '/api/haru/atoms'));

/* ── summary 화이트리스트 (설계안 §5-4) — 학생 기기가 올린 값이 강사·부모 화면에 그려진다. 모양만 강제하고 뜻은 해석하지 않는다. ── */
const CARRY_MAX = 12, CARRY_LEN = 40;
export function normalizeSummary(sum) {
  if (!isObj(sum)) return null;
  const sub = (v) => (isObj(v) ? { core: int0(v.core), fluent: int0(v.fluent), shaky: int0(v.shaky), hole: int0(v.hole), unknown: int0(v.unknown) } : { core: 0, fluent: 0, shaky: 0, hole: 0, unknown: 0 });
  const g = isObj(sum.gained) ? sum.gained : {};
  return {
    doneDays: int0(sum.doneDays), totalDays: int0(sum.totalDays), lastDone: isValidDate(sum.lastDone) ? sum.lastDone : '',
    confirmed: int0(sum.confirmed), coreTotal: int0(sum.coreTotal),
    bySubject: { kor: sub(sum.bySubject && sum.bySubject.kor), math: sub(sum.bySubject && sum.bySubject.math), eng: sub(sum.bySubject && sum.bySubject.eng) },
    gained: { atoms: int0(g.atoms), carry: (Array.isArray(g.carry) ? g.carry : []).slice(0, CARRY_MAX).map((x) => strMax(String(x), CARRY_LEN)),
              engWords: int0(g.engWords), korMorph: int0(g.korMorph), mockRuns: int0(g.mockRuns), paperRecovered: int0(g.paperRecovered),
              oneReadRate: Math.min(1, Math.max(0, Number(g.oneReadRate) || 0)) },
    phase: ['p1', 'p2', 'p3', 'p4', 'p5'].includes(sum.phase) ? sum.phase : '', updatedAt: typeof sum.updatedAt === 'string' ? sum.updatedAt.slice(0, 30) : '',
  };
}

/* ── 원자·플랜 해석 ── */
async function atomsDoc(store, ctx) {
  const rec = await store.getAtoms();
  if (rec && rec.atoms && Array.isArray(rec.atoms.atoms)) return { doc: rec.atoms, updatedAt: rec.updatedAt || null };
  const fb = ctx.atomsFallback ? await ctx.atomsFallback() : null;
  return { doc: fb || { atoms: [], coreByPhase: {} }, updatedAt: null };
}
function coreOf(doc, phase) {
  const c = (doc.coreByPhase || {})[phase];
  if (Array.isArray(c)) return c;
  if (typeof c === 'string' && /^same-as-/.test(c)) return coreOf(doc, c.slice('same-as-'.length));
  return Array.isArray((doc.coreByPhase || {}).p2) ? doc.coreByPhase.p2 : [];
}
export async function resolvePlan(store, cohort) {
  if (!cohort) return null;
  const rec = await store.getPlan(cohort);
  return rec && rec.plan ? rec.plan : null;
}
/* 배정 밖 팩은 존재 여부도 알려 주지 않는다 — 팩의 cohort 배열 또는 플랜 days[].packId */
function packAllowed(pack, stu, plan) {
  if (!pack || !stu) return false;
  if (Array.isArray(pack.cohort) && pack.cohort.includes(stu.cohort)) return true;
  return !!(plan && (plan.days || []).some((d) => d.packId === pack.packId));
}

/* ── 생성기 문항 — 기기에 정답을 두지 않으려고 서버가 seed 로 만들고 seed 로 다시 만들어 채점한다 ── */
const GEN_ATOMS = () => Object.keys(CALC.TEMPLATES).concat(Object.keys(KM.TEMPLATES));
function genItem(atomId, seed) {
  const s = (Number(seed) >>> 0) || 1;
  if (CALC.TEMPLATES[atomId]) return CALC.generate(atomId, CALC.seeded(s));
  if (KM.TEMPLATES[atomId]) { const rnd = CALC.seeded(s); for (let i = 0; i < 40; i++) { const it = KM.generate(atomId, KD, rnd); if (it) return it; } }
  return null;
}
const gidOf = (atomId, seed) => 'g:' + atomId + ':' + ((Number(seed) >>> 0) || 1);
function parseGid(gid) { const m = /^g:([a-z0-9-]+):(\d+)$/.exec(String(gid || '')); return m ? { atomId: m[1], seed: +m[2] } : null; }
/* 정답 제거본 — pack-check.STRIP 과 같은 목록. 생성기 문항의 params·answerValue 도 정답을 되짚는 값이라 뺀다. */
function stripItem(it) {
  const out = JSON.parse(JSON.stringify(it));
  PC.STRIP.forEach((k) => { delete out[k]; });
  delete out.answerValue; delete out.params;
  (out.choices || []).forEach((o) => { PC.STRIP_CHOICE.forEach((k) => { delete o[k]; }); });
  return out;
}
/* 단서 사다리 — 팩 문항은 cueSteps, 생성기 문항은 해설에서 단계별로 줄인다. level 3 전문 → 2 첫 문장+수치 → 1 첫 문장 → 0 없음 */
function cueText(item, level) {
  if (level <= 0) return '';
  if (Array.isArray(item.cueSteps) && item.cueSteps.length) return item.cueSteps[Math.min(item.cueSteps.length, level) - 1] || '';
  const ex = String(item.explanationKo || '');
  const first = ex.split(/(?<=[.다요]\s)|(?<=[.다요])$/)[0] || ex;
  if (level >= 3) return ex;
  if (level === 2) return first;
  return first.replace(/[0-9.,/%]+/g, '□');
}

async function packsFor(store, stu, plan) {
  const ids = (await store.getPackIds()) || [];
  const out = [];
  for (const id of ids) { const rec = await store.getPack(id); if (rec && packAllowed(rec.pack, stu, plan)) out.push(rec.pack); }
  return out;
}
/* 문항 공급이 있는 원자만 오늘 카드에 오른다 — 공급 없는 슬롯은 러너가 비어 학생이 앱이 고장 났다고 느낀다 */
function supplySet(packs) {
  const s = new Set(GEN_ATOMS());
  packs.forEach((p) => (p.items || []).forEach((it) => { if (it.atomId) s.add(it.atomId); }));
  return s;
}

function merged(stateRec, mockRec, paperRec) {
  return { ...((stateRec && stateRec.state) || {}), mocks: (mockRec && mockRec.mocks) || [], paper: (paperRec && paperRec.paper) || [] };
}
function weekDone(days, now) {
  let n = 0; for (let i = 0; i < 7; i++) { const k = P.kstDate(now - i * P.DAY); if (days[k] && days[k].sat) n++; } return n;
}
function lowWeeks(days, now) {
  let low = 0;
  for (let w = 1; w <= 3; w++) { let n = 0; for (let i = 0; i < 7; i++) { const k = P.kstDate(now - (w * 7 + i) * P.DAY); if (days[k] && days[k].sat) n++; } if (n < 2) low++; else break; }
  return low;
}
const nextMockText = (plan, now) => { const d = (plan && plan.days || []).find((x) => x.kind === 'mock' && x.d >= P.kstDate(now)); return d ? d.d.slice(5).replace('-', '/') + ' ' + (d.startAt || '09:00') : null; };

export async function handleHaru(ctx) {
  const { path: p, method, who, store } = ctx;
  const now = ctx.now == null ? Date.now() : +ctx.now;
  const j = (status, body) => ({ status, body });
  const body = async () => { try { return await ctx.getBody(); } catch (e) { return e && e.status === 413 ? TOO_LARGE : null; } };
  const badBody = (b) => (b === TOO_LARGE ? j(413, { error: '요청이 너무 커서 받을 수 없어요.' }) : (!b ? j(400, { error: '올바른 JSON이 아니에요.' }) : null));
  const q = (k) => String((ctx.query && ctx.query.get(k)) || '').trim();

  /* ── 부모 (ptoken, 읽기 전용, 로그인 없음) ── */
  if (p === '/api/haru/parent' && method === 'GET') {
    const t = q('t');
    const rec = TOKEN_RE.test(t) ? await store.getParent(t) : null;
    if (!rec) return j(404, { error: '유효하지 않은 링크예요. 학원에 문의해 주세요.' });
    if (rec.exp && now > rec.exp) return j(410, { error: '열람 기간이 끝났어요.' });
    const stu = await store.getStudent(rec.code);
    if (!stu) return j(404, { error: '학생 정보를 찾을 수 없어요.' });
    const [st, mk, plan] = await Promise.all([store.getState(rec.code), store.getMock(rec.code), resolvePlan(store, stu.cohort)]);
    const days = ((st && st.state) || {}).days || {};
    const today = P.kstDate(now), td = days[today] || null;
    const mocks = (mk && mk.mocks) || [];
    const last = mocks.length ? mocks[mocks.length - 1] : null;
    const lastVisible = last && last.at && Date.parse(last.at) + P.DAY <= now ? last : null;   // 회차 다음 날부터
    let dist = null;
    if (lastVisible && plan) { const d = await store.getDist(stu.cohort, lastVisible.keyId); dist = distView(d, lastVisible.pct == null ? null : lastVisible.pct); }
    const wd = weekDone(days, now);
    return j(200, { parent: {
      name: stu.name, today: { done: !!(td && td.sat), min: td ? td.min || 0 : 0 }, week: { done: wd },
      lastMock: lastVisible ? { at: lastVisible.at.slice(0, 10), completed: !!lastVisible.completed, blank: lastVisible.blank || 0 } : null,
      dist, bedTarget: plan ? P.bedTarget(plan, now) : null,
      milestones: plan ? P.milestonesFor(plan, 'parent', now, 45).map((m) => ({ d: m.d, at: m.at || null, text: m.text })) : [],
      coach: S.coach(wd, lowWeeks(days, now), nextMockText(plan, now)), review: null,
      notice: plan && plan.notice || '',
    }, updatedAt: nowIso(now) });
  }

  if (!who) return j(401, { error: '로그인이 필요합니다.' });

  /* ── 학생 게이트: consent → 만료(회고 경로 통과) → 플랜 ── */
  let stu = null, plan = null;
  if (!who.admin) {
    stu = await store.getStudent(who.code);
    if (!stu || !stu.consent || !stu.consent.at) return j(403, { error: '보호자 동의 확인이 필요해요.' });
    if (stu.expiresAt && stu.expiresAt < todayKst(now) && !isRetroPath(p, method)) return j(403, { error: '이용 기간이 끝났어요.' });
    plan = await resolvePlan(store, stu.cohort);
  }
  const { doc: atomsAll, updatedAt: atomsAt } = await atomsDoc(store, ctx);
  const atoms = atomsAll.atoms || [];
  const atomIdx = {}; atoms.forEach((a) => { atomIdx[a.id] = a; });
  const phaseOf = () => (plan ? P.phaseOf(plan, now) : { phase: 'p2', dday: null, dailyMin: 15, mix: P.MIX.p2, mode: 'mixed', freezeNew: false });
  const noPlan = () => j(409, { error: '학습 달력이 아직 준비되지 않았어요. 선생님께 말씀해 주세요.' });

  /* ── 학생 라우트 ── */
  if (p === '/api/haru/atoms' && method === 'GET') {
    const ph = phaseOf();
    return j(200, { atoms: atoms.map((a) => ({ id: a.id, subject: a.subject, label: a.label, band: a.band, tier: a.tier, teach: a.teach, weight: a.weight, prereq: a.prereq || [], confuse: a.confuse || [], carryTo: a.carryTo || '', gen: a.gen || [] })),
                    coreByPhase: atomsAll.coreByPhase || {}, core: coreOf(atomsAll, ph.phase), treeId: atomsAll.treeId || null, updatedAt: atomsAt });
  }
  if (p === '/api/haru/plan' && method === 'GET' && !who.admin) {
    if (!plan) return noPlan();
    const ph = phaseOf();
    return j(200, { plan: { cohort: plan.cohort, examDate: plan.examDate, examDateStatus: plan.examDateStatus || 'assumed', order: plan.order || SUBJECTS,
      budget: ph.dailyMin, extendBlockMin: ph.extendBlockMin || 0, extendMax: ph.extendMax || 0, phase: ph, dday: P.dday(plan, now),
      days: P.windowDays(plan, now, 3).map((d) => ({ d: d.d, kind: d.kind, keyId: d.keyId || null, keyIds: d.keyIds || null, subjects: d.subjects || null, startAt: d.startAt || null, app: d.app !== false, note: d.note || '', retakeKeyId: d.retakeKeyId || null, packId: d.packId || null })),
      milestones: P.milestonesFor(plan, 'student', now, 45).map((m) => ({ d: m.d, at: m.at || null, text: m.text })),
      locked: P.isLocked(plan, now), retro: P.isRetro(plan, now), numbersOpen: P.numbersOpen(plan, now), frozenKeyId: plan.frozenKeyId || null,
      notice: plan.notice || '', bedTarget: P.bedTarget(plan, now) }, scope: stu.cohort });
  }
  if (p === '/api/haru/today' && method === 'GET' && !who.admin) {
    if (!plan) return noPlan();
    const st = await store.getState(who.code);
    const state = (st && st.state) || {};
    const ph = phaseOf();
    if (P.isLocked(plan, now)) return j(200, { today: { slots: [], envelope: null, minEstimate: 0, phase: ph, sat: false }, dday: P.dday(plan, now), updatedAt: nowIso(now) });
    const packs = await packsFor(store, stu, plan);
    const supply = supplySet(packs);
    const core = coreOf(atomsAll, ph.phase).filter((id) => supply.has(id) && atomIdx[id]);
    const recent = {}; Object.keys(state.atoms || {}).forEach((id) => { const s = state.atoms[id]; if (s && s.lastAt) recent[id] = s.lastAt; });
    const card = PR.todayCard(state.atoms || {}, atoms, plan, now, { core, recent: state.recentProbe || {}, seenPeri: state.seenPeri || {}, prevEnvelope: state.envelope || null });
    const packOf = (atomId) => { const pk = packs.find((x) => (x.items || []).some((it) => it.atomId === atomId)); return pk ? pk.packId : null; };
    const slots = card.slots.map((s) => ({ ...s, source: GEN_ATOMS().includes(s.atomId) ? 'gen' : 'pack', packId: GEN_ATOMS().includes(s.atomId) ? null : packOf(s.atomId), n: 3 }));
    const td = (state.days || {})[P.kstDate(now)];
    return j(200, { today: { slots, envelope: card.envelope, minEstimate: card.minEstimate, phase: ph, sat: !!(td && td.sat), passage: (P.dayEntry(plan, P.kstDate(now)) || {}).packId || null },
                    dday: P.dday(plan, now), updatedAt: nowIso(now) });
  }
  if (p === '/api/haru/gen' && method === 'GET' && !who.admin) {
    const atomId = q('atomId'), seed = (Number(q('seed')) >>> 0) || ((now % 2147483647) >>> 0);
    if (!atomIdx[atomId]) return j(404, { error: '없는 원자예요.' });
    if (plan && !P.bandOpen(plan, atomIdx[atomId].band, now)) return j(403, { error: '아직 열리지 않은 범위예요.' });
    const it = genItem(atomId, seed);
    if (!it) return j(404, { error: '이 칸은 생성기가 없어요.' });
    return j(200, { item: { gid: gidOf(atomId, seed), ...stripItem(it) }, updatedAt: nowIso(now) });
  }
  if (p === '/api/haru/pack' && method === 'GET') {
    const id = q('id');
    if (!PACK_ID_RE.test(id)) return j(400, { error: '팩 id가 필요해요.' });
    const rec = await store.getPack(id);
    if (!who.admin && !(rec && packAllowed(rec.pack, stu, plan))) return j(403, { error: '배정되지 않은 자료예요.' });
    if (!rec) return j(404, { error: '팩을 찾을 수 없어요.' });
    return j(200, { pack: who.admin ? rec.pack : PC.stripForStudent(rec.pack), updatedAt: rec.updatedAt || null });
  }
  if (p === '/api/haru/cue' && method === 'GET' && !who.admin) {
    const item = await resolveItem(store, stu, plan, { gid: q('gid'), packId: q('packId'), no: q('no') });
    if (!item) return j(404, { error: '문항을 찾을 수 없어요.' });
    const st = await store.getState(who.code);
    const s = (((st && st.state) || {}).atoms || {})[item.atomId];
    const gate = !s || (s.stage || 1) <= 1 || (s.lastCause === 'gap') || (s.cue || 0) > 0;
    if (!gate) return j(403, { error: '지금은 단서 없이 풀어요.' });
    const level = Math.min(3, Math.max(0, s ? (s.cue == null ? 3 : s.cue) : 3));
    return j(200, { cue: { level, text: cueText(item, level) } });
  }
  if (p === '/api/haru/state' && method === 'GET' && !who.admin) {
    const [st, mk, pa] = await Promise.all([store.getState(who.code), store.getMock(who.code), store.getPaper(who.code)]);
    const state = merged(st, mk, pa);
    /* 회차 결과는 다음 날부터 보인다 — 채점은 즉시, 공개는 지연(§4-4). 오늘 친 회차는 접수 사실만 */
    state.mocks = state.mocks.map((m) => {
      if (m.at && Date.parse(m.at) + P.DAY > now) return { keyId: m.keyId, at: m.at, retake: m.retake, kind: m.kind, pending: true };
      const { pct, ...rest } = m; return rest;                   // 백분율은 분포 갱신용 — 학생 기기로는 나가지 않는다
    });
    return j(200, { state, updatedAt: st ? st.updatedAt : null });
  }
  if (p === '/api/haru/state' && method === 'PUT' && !who.admin) {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const state = b.state;
    if (!isObj(state)) return j(400, { error: 'state 필요' });
    if ('mocks' in state || 'paper' in state) return j(400, { error: 'mocks·paper 는 학생 기기가 쓰지 않는 키예요.' });
    const prev = await store.getState(who.code);
    const today = P.kstDate(now);
    const puts = prev && prev.puts && prev.puts.d === today ? prev.puts.n : 0;
    if (puts >= PUTS_PER_DAY) return j(429, { error: '오늘 저장은 여기까지예요. 내일 이어서 해요.' });
    if (state.summary !== undefined) { const ns = normalizeSummary(state.summary); if (ns) state.summary = ns; else delete state.summary; }
    /* weekly 는 서버가 주 1회 append — 클라이언트가 보낸 값은 무시한다 */
    const weekly = Array.isArray(prev && prev.state && prev.state.weekly) ? prev.state.weekly.slice(-60) : [];
    const wk = P.weekKey(now);
    if (!weekly.some((w) => w.w === wk)) {
      const core = coreOf(atomsAll, phaseOf().phase);
      const byAtom = {}; core.forEach((id) => { const s = (state.atoms || {})[id]; if (s && (s.obs || 0) >= M.MIN_OBS && atomIdx[id]) byAtom[id] = Math.round(M.p(s, now) * 100) / 100; });
      const top3 = core.filter((id) => byAtom[id] != null).sort((a, b) => byAtom[a] - byAtom[b]).slice(0, 3);
      weekly.push({ w: wk, byAtom, top3 });
    }
    state.weekly = weekly;
    const rec = { state, updatedAt: nowIso(now), puts: { d: today, n: puts + 1 } };
    if (byteLen(rec) > STATE_MAX_BYTES) return j(413, { error: '기록이 너무 커서 저장할 수 없어요.' });
    await store.putState(who.code, rec);
    return j(200, { ok: true, updatedAt: rec.updatedAt });
  }
  if (p === '/api/haru/answer' && method === 'POST' && !who.admin) {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const item = await resolveItem(store, stu, plan, b);
    if (!item) return j(404, { error: '문항을 찾을 수 없어요.' });
    const picked = b.picked === 'skip' ? 'skip' : String(b.picked == null ? '' : b.picked).slice(0, 2);
    const ok = picked === String(item.answerKey);
    const ms = int0(b.ms);
    const st = await store.getState(who.code);
    const s = (((st && st.state) || {}).atoms || {})[item.atomId] || null;
    const cause = ok ? null : C.classify(item, picked, ms, s, null);
    return j(200, { result: { ok, answerKey: item.answerKey, explanationKo: item.explanationKo || '', cause,
      item: { atomId: item.atomId, itemId: item.itemId || null, form: item.form || 'mcq4', choices: (item.choices || []).map((c) => ({ key: c.key, text: c.text, atomId: c.atomId || null, errKind: c.errKind || null })) },
      cueNext: ok ? 0 : Math.min(3, ((s && s.cue) || 0) + 1) } });
  }
  if (p === '/api/haru/probe' && method === 'POST' && !who.admin) {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const item = await resolveItem(store, stu, plan, b);
    if (!item) return j(404, { error: '문항을 찾을 수 없어요.' });
    const st = await store.getState(who.code);
    const s = (((st && st.state) || {}).atoms || {})[item.atomId] || null;
    const probe = { said: b.said === 'canDo' ? 'canDo' : 'no', ok: b.ok === true };
    return j(200, { cause: C.classify(item, String(b.picked || ''), int0(b.ms), s, probe), updatedAt: nowIso(now) });
  }
  if (p === '/api/haru/attempt' && method === 'POST' && !who.admin) {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    if (!plan) return noPlan();
    const kind = b.kind === 'single' ? 'single' : 'full';
    const periods = Array.isArray(b.periods) ? b.periods : [];
    if (kind === 'full' && periods.length !== 3) return j(409, { error: '3교시가 모두 끝나야 답안지를 낼 수 있어요.' });
    if (!periods.length || periods.length > 3) return j(400, { error: '교시 답안이 필요해요.' });
    const results = [], keys = [];
    for (const per of periods) {
      if (!isObj(per)) return j(400, { error: '교시 답안 형식 오류' });
      let key = null;
      if (typeof per.keyId === 'string' && PACK_ID_RE.test(per.keyId)) { const r = await store.getPaperKey(per.keyId); key = r && r.key; }
      else if (typeof per.packId === 'string' && PACK_ID_RE.test(per.packId)) { const r = await store.getPack(per.packId); if (r && packAllowed(r.pack, stu, plan) && r.pack.kind === 'screen-mock') key = keyFromPack(r.pack); }
      if (!key) return j(404, { error: '등록되지 않은 회차예요.' });
      if (!key.answer) return j(400, { error: '이 자료는 앱에서 채점하지 않아요(강사 입력).' });
      if (per.subject && per.subject !== key.subject) return j(400, { error: '교시 과목이 대응표와 달라요.' });
      results.push(scorePeriod(per, key)); keys.push(key);
    }
    const mk = (await store.getMock(who.code)) || { mocks: [] };
    const keyId = typeof b.keyId === 'string' && PACK_ID_RE.test(b.keyId) ? b.keyId : keys[0].id;
    const retake = keys.some((k) => k.frozen && mk.mocks.some((m) => m.keyId === keyId || (m.subjects || []).length && m.bySubject && Object.values(m.bySubject).some((x) => x.keyId === k.id)));
    const at = nowIso(now);
    const rec = mockRecord(results, { keyId, at, retake, kind });
    rec.pct = pctOf(results);                                   // 분포 위 점의 원천 — 학생·부모 화면으로는 나가지 않는다(state GET 이 걸러 낸다)
    mk.mocks = mk.mocks.concat([rec]).slice(-MOCKS_MAX);
    await store.putMock(who.code, mk);
    if (!retake && rec.pct != null) {
      const d = await store.getDist(stu.cohort, keyId);
      await store.putDist(stu.cohort, keyId, distUpdate(d, rec.pct, { keyId, cohort: stu.cohort, at, composition: stu.cohort + ' 코호트 등록생', itemSource: '자작' }));
    }
    return j(200, { accepted: true, at, retake });
  }
  if (p === '/api/haru/sheet' && method === 'GET') {
    const keyId = q('keyId');
    if (!PACK_ID_RE.test(keyId)) return j(400, { error: 'keyId 가 필요해요.' });
    const r = await store.getPaperKey(keyId);
    if (!r || !r.key) return j(404, { error: '등록되지 않은 회차예요.' });
    const k = r.key;
    return j(200, { sheet: { keyId: k.id, label: k.label, subject: k.subject, n: k.n, timeLimitSec: k.timeLimitSec || null, origin: k.origin, frozen: !!k.frozen, sets: k.sets || null } });
  }
  if (p === '/api/haru/retro' && method === 'GET' && !who.admin) {
    if (!plan) return noPlan();
    const [st, mk] = await Promise.all([store.getState(who.code), store.getMock(who.code)]);
    const state = (st && st.state) || {};
    const days = state.days || {};
    const sat = Object.keys(days).filter((d) => days[d].sat).length;
    const core = coreOf(atomsAll, 'p4');
    const carry = core.filter((id) => { const s = (state.atoms || {})[id]; return s && atomIdx[id] && M.grade(s, atomIdx[id], now) === 'fluent'; }).map((id) => atomIdx[id].carryTo).filter(Boolean);
    const out = { sat, totalDays: (plan.days || []).filter((d) => ['card', 'passage', 'mock'].includes(d.kind)).length, carry: Array.from(new Set(carry)), examDate: plan.examDate, numbersOpen: P.numbersOpen(plan, now) };
    if (P.numbersOpen(plan, now)) {
      const mocks = (mk && mk.mocks) || [];
      const pas = state.passages || [];
      const frozen = mocks.filter((m) => m.keyId === plan.frozenKeyId);
      const okOf = (m) => Object.values(m.bySubject || {}).reduce((a, x) => a + (x.ok || 0), 0);
      out.gained = {
        atoms: carry.length, minutes: Object.keys(days).reduce((a, d) => a + ((days[d].sat && days[d].min) || 0), 0),
        mockRuns: mocks.length, mockCompleted: mocks.filter((m) => m.completed).length,
        rewindsFirst: pas.length ? pas[0].rewinds || 0 : null, rewindsLast: pas.length ? pas[pas.length - 1].rewinds || 0 : null,
        frozenPair: frozen.length >= 2 ? { first: { at: frozen[0].at.slice(0, 10), ok: okOf(frozen[0]) }, last: { at: frozen[frozen.length - 1].at.slice(0, 10), ok: okOf(frozen[frozen.length - 1]) } } : null,
        engWords: Object.keys(state.words || {}).length, paperRecovered: (state.wrong || []).filter((w) => w.cleared > 0).length,
      };
    }
    return j(200, { retro: out, updatedAt: nowIso(now) });
  }
  if (p === '/api/haru/report' && method === 'POST' && !who.admin) {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const packId = typeof b.packId === 'string' && PACK_ID_RE.test(b.packId) ? b.packId : (parseGid(b.gid) ? 'gen' : '');
    if (!packId) return j(400, { error: '어느 문항인지 알 수 없어요.' });
    const ref = packId === 'gen' ? String(b.gid) : String(int0(b.no));
    const rec = { id: 'rp-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8), code: who.code, packId, itemRef: ref.slice(0, 80),
                  reason: ['answer', 'broken', 'meaning', 'other'].includes(b.reason) ? b.reason : 'other', memo: strMax(String(b.memo == null ? '' : b.memo).trim(), 200), at: nowIso(now), resolved: false };
    const list = ((await store.getReports(packId)) || []).filter((x) => !(x.code === rec.code && x.itemRef === rec.itemRef && !x.resolved));
    list.unshift(rec);
    await store.putReports(packId, list.slice(0, 200));
    return j(200, { ok: true });
  }

  /* ── 관리 ── */
  if (!who.admin) return j(403, { error: '권한이 없습니다.' });
  const A = '/api/haru/admin/';
  if (!p.startsWith(A)) return j(404, { error: 'unknown api' });
  const r = p.slice(A.length);

  if (r === 'students' && method === 'GET') {
    const codes = await store.listStudentCodes();
    const out = [];
    for (const c of codes) { const s = await store.getStudent(c); if (s && ((Array.isArray(s.apps) && s.apps.includes('haru')) || s.cohort)) out.push({ code: s.code, name: s.name, grade: s.grade || '', cls: s.cls || '', cohort: s.cohort || '', apps: s.apps || null, consent: s.consent || null, expiresAt: s.expiresAt || null, haruPtoken: s.haruPtoken || null }); }
    return j(200, { students: out, updatedAt: nowIso(now) });
  }
  if (r === 'enroll' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const code = String(b.code || '').trim();
    if (!CODE_RE.test(code)) return j(400, { error: '학생 코드는 영문/숫자 3~20자' });
    if (code.toLowerCase() === 'default') return j(400, { error: "'default'는 예약어예요." });
    if (!b.name) return j(400, { error: '이름 필요' });
    const cohort = String(b.cohort || '').trim();
    if (!/^[A-Za-z0-9-]{2,20}$/.test(cohort)) return j(400, { error: '코호트가 필요해요 (예: 2027-pilot, 2028)' });
    const cs = b.consent;
    if (!isObj(cs) || !isValidDate(cs.at)) return j(400, { error: '보호자 동의일(consent.at)이 있어야 등록할 수 있어요.' });
    const cplan = await resolvePlan(store, cohort);
    const consent = { at: cs.at, via: ['paper', 'digital'].includes(cs.via) ? cs.via : 'paper',
      guardian: isObj(cs.guardian) ? { name: strMax(cs.guardian.name, 20), rel: strMax(cs.guardian.rel, 10) } : null,
      retainUntil: isValidDate(cs.retainUntil) ? cs.retainUntil : (cplan ? P.kstDate(P.retroEndAt(cplan)) : '') };
    const prev = await store.getStudent(code);
    const apps = prev && prev.apps == null && prev.createdAt ? null : Array.from(new Set(((prev && prev.apps) || []).concat(['haru'])));
    const rec = { ...(prev || {}), code, name: strMax(String(b.name), 20), grade: strMax(String(b.grade || ''), 10), cls: strMax(String(b.cls || ''), 20),
                  apps, cohort, consent, expiresAt: consent.retainUntil || (prev && prev.expiresAt) || '', createdAt: (prev && prev.createdAt) || nowIso(now) };
    await store.putStudent(code, rec);
    return j(200, { ok: true, student: rec });
  }
  if (r === 'pack' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const pack = b.pack;
    if (!isObj(pack)) return j(400, { error: 'pack 필요' });
    const id = String(b.id || pack.packId || '').trim();
    if (!PACK_ID_RE.test(id) || (pack.packId && pack.packId !== id)) return j(400, { error: '팩 id 형식 (영숫자·하이픈 3~60자)' });
    const chk = PC.checkPack(pack, { atoms: atomsAll, now });
    if (chk.errors.length) return j(400, { error: '팩 검증 실패', errors: chk.errors.slice(0, 30), warnings: chk.warnings.slice(0, 30) });
    if (byteLen(pack) > PACK_MAX_BYTES) return j(413, { error: '팩이 너무 커요 (512KB 이내).' });
    const rec = { pack, updatedAt: nowIso(now) };
    await store.putPack(id, rec);
    const ids = (await store.getPackIds()) || [];
    if (!ids.includes(id)) await store.putPackIds(ids.concat([id]));
    return j(200, { ok: true, id, updatedAt: rec.updatedAt, warnings: chk.warnings.slice(0, 30), counts: { items: (pack.items || []).length, passages: (pack.passages || []).length } });
  }
  if (r === 'packs' && method === 'GET') {
    const ids = (await store.getPackIds()) || [];
    const packs = [];
    for (const id of ids) { const rec = await store.getPack(id); if (rec) packs.push({ id, subject: rec.pack.subject, kind: rec.pack.kind, cohort: rec.pack.cohort || [], tier: rec.pack.tier, origin: rec.pack.origin, items: (rec.pack.items || []).length, updatedAt: rec.updatedAt, expiresAt: rec.pack.license && rec.pack.license.expiresAt || null }); }
    return j(200, { packs });
  }
  if (r === 'pack' && method === 'DELETE') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const id = String(b.id || '').trim();
    if (!PACK_ID_RE.test(id)) return j(400, { error: '팩 id 형식' });
    const plans = (await store.getPlanIds()) || [];
    const using = [];
    for (const c of plans) { const rec = await store.getPlan(c); if (rec && (rec.plan.days || []).some((d) => d.packId === id)) using.push(c); }
    if (using.length) return j(409, { error: '플랜에 배정된 팩이에요.', scopes: using });
    await store.deletePack(id);
    await store.putPackIds(((await store.getPackIds()) || []).filter((x) => x !== id));
    return j(200, { ok: true });
  }
  if (r === 'paperkey' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const key = b.key;
    if (!isObj(key)) return j(400, { error: 'key 필요' });
    const id = String(b.id || key.id || '').trim();
    if (!PACK_ID_RE.test(id) || (key.id && key.id !== id)) return j(400, { error: '대응표 id 형식' });
    key.id = id;
    const chk = PC.checkPaperKey(key, { atoms: atomsAll });
    if (chk.errors.length) return j(400, { error: '대응표 검증 실패', errors: chk.errors.slice(0, 30), warnings: chk.warnings.slice(0, 30) });
    await store.putPaperKey(id, { key, updatedAt: nowIso(now) });
    const ids = (await store.getPaperKeyIds()) || [];
    if (!ids.includes(id)) await store.putPaperKeyIds(ids.concat([id]));
    return j(200, { ok: true, id, warnings: chk.warnings.slice(0, 30) });
  }
  if (r === 'paperkeys' && method === 'GET') {
    const ids = (await store.getPaperKeyIds()) || [];
    const keys = [];
    for (const id of ids) { const rec = await store.getPaperKey(id); if (rec) { const k = rec.key; keys.push({ id, label: k.label, subject: k.subject, n: k.n, origin: k.origin, holder: k.holder, frozen: !!k.frozen, timeLimitSec: k.timeLimitSec || null, hasAnswer: !!k.answer, updatedAt: rec.updatedAt }); } }
    return j(200, { keys });
  }
  if (r === 'paper' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const code = String(b.code || '').trim(), keyId = String(b.keyId || '').trim();
    if (!CODE_RE.test(code) || !PACK_ID_RE.test(keyId)) return j(400, { error: '학생 코드와 keyId 가 필요해요.' });
    const rec = await store.getPaperKey(keyId);
    if (!rec) return j(404, { error: '등록되지 않은 대응표예요.' });
    const key = rec.key;
    const entry = { keyId, at: isValidDate(b.at) ? b.at : P.kstDate(now) };
    if (key.origin === 'own') {
      const nos = Array.isArray(b.wrongNos) ? b.wrongNos.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= key.n) : null;
      if (!nos) return j(400, { error: '자작 자료는 틀린 문항 번호(wrongNos)를 넣어요.' });
      entry.wrongNos = Array.from(new Set(nos)).sort((a, b2) => a - b2);
      entry.atomIds = Array.from(new Set(entry.wrongNos.map((n) => key.map[n]).filter(Boolean)));
    } else {
      const cb = isObj(b.correctBySubject) ? b.correctBySubject : null;
      if (!cb || !SUBJECTS.some((s) => Number.isInteger(cb[s]))) return j(400, { error: '시판 자료는 과목별 정답 개수(correctBySubject)만 넣어요.' });
      entry.correctBySubject = {}; SUBJECTS.forEach((s) => { if (Number.isInteger(cb[s])) entry.correctBySubject[s] = Math.min(key.n, Math.max(0, cb[s])); });
      entry.n = key.n;
    }
    const pa = (await store.getPaper(code)) || { paper: [] };
    pa.paper = pa.paper.concat([entry]).slice(-200);
    await store.putPaper(code, pa);
    return j(200, { ok: true, entry });
  }
  if (r === 'plan' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const pl = b.plan;
    if (!isObj(pl)) return j(400, { error: 'plan 필요' });
    const cohort = String(b.cohort || pl.cohort || '').trim();
    if (!/^[A-Za-z0-9-]{2,20}$/.test(cohort)) return j(400, { error: '코호트 이름 형식' });
    if (!isValidDate(pl.examDate)) return j(400, { error: 'examDate 가 달력에 있는 날이어야 해요.' });
    if (!Array.isArray(pl.days) || !Array.isArray(pl.phases)) return j(400, { error: 'days·phases 배열이 필요해요.' });
    const badDay = pl.days.find((d) => !isObj(d) || !isValidDate(d.d) || !d.kind);
    if (badDay) return j(400, { error: 'days 항목에 d(날짜)·kind 가 필요해요.' });
    pl.cohort = cohort;
    await store.putPlan(cohort, { plan: pl, updatedAt: nowIso(now) });
    const ids = (await store.getPlanIds()) || [];
    if (!ids.includes(cohort)) await store.putPlanIds(ids.concat([cohort]));
    return j(200, { ok: true, cohort, days: pl.days.length, milestones: (pl.milestones || []).length });
  }
  if (r === 'plans' && method === 'GET') {
    const ids = (await store.getPlanIds()) || [];
    const plans = [];
    for (const c of ids) { const rec = await store.getPlan(c); if (rec) plans.push({ cohort: c, examDate: rec.plan.examDate, examDateStatus: rec.plan.examDateStatus || null, days: (rec.plan.days || []).length, phases: rec.plan.phases || [], bands: rec.plan.bands || {}, frozenKeyId: rec.plan.frozenKeyId || null, updatedAt: rec.updatedAt }); }
    return j(200, { plans });
  }
  if (r === 'plan' && method === 'GET') {
    const rec = await store.getPlan(q('cohort'));
    return rec ? j(200, { plan: rec.plan, updatedAt: rec.updatedAt }) : j(404, { error: '플랜 없음' });
  }
  if (r === 'plan' && method === 'DELETE') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const c = String(b.cohort || '').trim();
    await store.deletePlan(c);
    await store.putPlanIds(((await store.getPlanIds()) || []).filter((x) => x !== c));
    return j(200, { ok: true });
  }
  if (r === 'cohort' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const c = String(b.cohort || '').trim();
    const rec = await store.getPlan(c);
    if (!rec) return j(404, { error: '플랜 없음' });
    if (Array.isArray(b.phases)) rec.plan.phases = b.phases;
    if (isObj(b.bands)) rec.plan.bands = b.bands;
    if (isValidDate(b.examDate)) { rec.plan.examDate = b.examDate; rec.plan.examDateStatus = b.examDateStatus === 'confirmed' ? 'confirmed' : 'assumed'; }
    rec.updatedAt = nowIso(now);
    await store.putPlan(c, rec);
    return j(200, { ok: true });
  }
  if (r === 'atoms' && method === 'GET') return j(200, { atoms: atomsAll, updatedAt: atomsAt });
  if (r === 'atoms' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const doc = b.atoms;
    if (!isObj(doc) || !Array.isArray(doc.atoms)) return j(400, { error: 'atoms 문서가 필요해요.' });
    const chk = AC.check(doc, { skills: null });
    if (chk.errors.length) return j(400, { error: '원자 목록 검증 실패', errors: chk.errors.slice(0, 30) });
    await store.putAtoms({ atoms: doc, updatedAt: nowIso(now) });
    return j(200, { ok: true, count: doc.atoms.length });
  }
  if (r === 'board' && method === 'GET') {
    const codes = await store.listStudentCodes();
    const list = [];
    for (const c of codes) {
      const s = await store.getStudent(c);
      if (!s || !((Array.isArray(s.apps) && s.apps.includes('haru')) || s.cohort)) continue;
      const [st, mk] = await Promise.all([store.getState(c), store.getMock(c)]);
      list.push({ code: c, student: s, state: st, mocks: mk });
    }
    const core = coreOf(atomsAll, 'p4');
    return j(200, { rows: boardRows(list, atoms, core, now), coreMap: core.map((id) => ({ id, label: atomIdx[id] ? atomIdx[id].label : id, subject: atomIdx[id] ? atomIdx[id].subject : '' })), updatedAt: nowIso(now) });
  }
  if (r === 'map' && method === 'GET') {
    const code = q('code');
    if (!CODE_RE.test(code)) return j(400, { error: '학생 코드' });
    const [st, mk, pa] = await Promise.all([store.getState(code), store.getMock(code), store.getPaper(code)]);
    const map = coachMap(st, atoms, coreOf(atomsAll, 'p4'), now);
    const state = (st && st.state) || {};
    return j(200, { map, days: state.days || {}, wrong: (state.wrong || []).slice(-50), passages: (state.passages || []).slice(-20), envelope: state.envelope || null,
                    mocks: (mk && mk.mocks) || [], paper: (pa && pa.paper) || [], updatedAt: st ? st.updatedAt : null });
  }
  if (r === 'parentlink' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const code = String(b.code || '').trim();
    const s = await store.getStudent(code);
    if (!s) return j(404, { error: '학생 없음' });
    if (!s.consent || !s.consent.at) return j(400, { error: '보호자 동의 확인 전에는 링크를 만들 수 없어요.' });
    if (s.haruPtoken) await store.deleteParent(s.haruPtoken);
    const t = (ctx.randomToken ? ctx.randomToken() : Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''));
    const cplan = await resolvePlan(store, s.cohort);
    const exp = cplan ? P.retroEndAt(cplan) : now + PARENT_TTL_DAYS * P.DAY;
    await store.putParent(t, { code, exp, at: nowIso(now) });
    s.haruPtoken = t;
    await store.putStudent(code, s);
    return j(200, { ptoken: t, exp: nowIso(exp) });
  }
  if (r === 'reports' && method === 'GET') {
    const id = q('packId') || 'gen';
    return j(200, { reports: (await store.getReports(id)) || [] });
  }
  if (r === 'reports/resolve' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const id = String(b.packId || 'gen');
    const list = ((await store.getReports(id)) || []).map((x) => (x.id === b.id ? { ...x, resolved: true, resolvedAt: nowIso(now) } : x));
    await store.putReports(id, list);
    return j(200, { ok: true });
  }
  if (r === 'export' && method === 'GET') {
    const code = q('code');
    if (!CODE_RE.test(code)) return j(400, { error: '학생 코드' });
    const s = await store.getStudent(code);
    if (!s) return j(404, { error: '학생 없음' });
    const cplan = await resolvePlan(store, s.cohort);
    if (!cplan || !P.numbersOpen(cplan, now)) return j(409, { error: '숫자 개방(시험일 + 7일 16:00) 전에는 내보낼 수 없어요.' });
    const [st, mk, pa] = await Promise.all([store.getState(code), store.getMock(code), store.getPaper(code)]);
    const state = (st && st.state) || {};
    return j(200, { report: { code, name: s.name, cohort: s.cohort, exportedAt: nowIso(now), summary: normalizeSummary(state.summary), days: state.days || {},
      map: coachMap(st, atoms, coreOf(atomsAll, 'p4'), now), passages: state.passages || [], weekly: state.weekly || [], mocks: (mk && mk.mocks) || [], paper: (pa && pa.paper) || [] } });
  }
  if (r === 'purge' && method === 'POST') {
    /* 파기 — 정확 접두 4계열만(haru:state·mock·paper·parent). haru:paperkey:* 는 원장의 대응표라 건드리지 않는다(§7-5). 학생 레코드도 남긴다(D-22). */
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const cohort = String(b.cohort || '').trim();
    if (!cohort) return j(400, { error: '코호트' });
    const codes = await store.listStudentCodes();
    let n = 0;
    for (const c of codes) {
      const s = await store.getStudent(c);
      if (!s || s.cohort !== cohort) continue;
      await Promise.all([store.deleteState(c), store.deleteMock(c), store.deletePaper(c)]);
      if (s.haruPtoken) { await store.deleteParent(s.haruPtoken); delete s.haruPtoken; await store.putStudent(c, s); }
      n++;
    }
    return j(200, { ok: true, cohort, purged: n });
  }
  return j(404, { error: 'unknown api' });
}

/* 문항 해석 — gid(생성기) 또는 packId+no(팩). 배정 밖 팩은 없는 것으로 답한다. */
async function resolveItem(store, stu, plan, b) {
  const g = parseGid(b && b.gid);
  if (g) { const it = genItem(g.atomId, g.seed); return it ? { ...it, gid: gidOf(g.atomId, g.seed) } : null; }
  const packId = String((b && b.packId) || ''), no = Number(b && b.no);
  if (!PACK_ID_RE.test(packId) || !Number.isInteger(no)) return null;
  const rec = await store.getPack(packId);
  if (!rec || !packAllowed(rec.pack, stu, plan)) return null;
  const it = (rec.pack.items || []).find((x) => x.no === no);
  return it ? { ...it, itemId: it.itemId || packId + '#' + no } : null;
}

/* 퇴원·백업용 — 학생 한 명의 haru 4계열 키 삭제 (호스트의 DELETE /api/admin/students 가 부른다) */
export async function dropStudentHaru(store, code) {
  const s = await store.getStudent(code);
  await Promise.all([store.deleteState(code), store.deleteMock(code), store.deletePaper(code)]);
  if (s && s.haruPtoken) await store.deleteParent(s.haruPtoken);
}
export async function dumpHaru(store) {
  const out = { packIds: (await store.getPackIds()) || [], paperkeys: {}, plans: {}, states: {}, mocks: {}, paper: {}, atoms: (await store.getAtoms()) || null };
  for (const id of (await store.getPaperKeyIds()) || []) out.paperkeys[id] = await store.getPaperKey(id);
  for (const c of (await store.getPlanIds()) || []) out.plans[c] = await store.getPlan(c);
  for (const c of await store.listStateCodes()) { out.states[c] = await store.getState(c); out.mocks[c] = await store.getMock(c); out.paper[c] = await store.getPaper(c); }
  return out;
}

/* 주간 익명 집계 크론(haru:agg:<주>) — 멱등 재계산. 학생 코드 없음, 앉은 학생 10명 미만이면 그 주는 쓰지 않는다. */
export async function weeklyAgg(store, now) {
  const week = P.weekKey(now == null ? Date.now() : now);
  const entries = [];
  for (const c of await store.listStateCodes()) {
    const rec = await store.getState(c);
    const st = (rec && rec.state) || {};
    const wk = (st.weekly || []).find((w) => w.w === week);
    if (!wk) continue;
    const atoms = {};
    Object.keys(st.atoms || {}).forEach((id) => { const s = st.atoms[id]; if (s && (s.obs || 0) > 0) atoms[id] = { obs: s.obs, ok: s.ok || 0 }; });
    entries.push({ atoms });
  }
  const agg = aggWeek(week, entries);
  if (agg && store.putAgg) await store.putAgg(week, { ...agg, at: nowIso(now) });
  return agg;
}
