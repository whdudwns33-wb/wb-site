'use strict';
/* WB 브레인레터 — /api/letter/* 라우트 (server.mjs·worker.mjs 공용, haru-api.mjs 선례)
   격리 원칙: 라우트는 /api/letter/* 아래, 데이터는 letter: 접두 KV(로컬은 db.letter)만 쓴다.
   인증은 호스트의 토큰 검증 결과(who)를 받고, apps 게이트(allowedApp)는 호스트가 who 검증 직후 한 곳에서 건다.
   가족 링크(/api/letter/parent?t=)는 진로독서 학부모 토큰(parent:<t>)을 그대로 쓴다 — 가정마다 링크가 하나여야
   주간 문자에 링크를 두 개 넣는 일이 없다.

   호(issue)의 유일한 검증기는 letter/letter.js 의 checkIssue 다 — 관리 웹·AI 초안·저장이 같은 규칙으로 걸러진다.
   학생에게는 자기 학년대 섹션만 내려간다(forTier). 정답은 뉴스레터의 일부라 함께 내려간다(하루브레인과 다르다 —
   시험이 아니라 가정 학습지다). */
import L from '../letter/letter.js';
import SAMPLE from '../letter/issue-sample.json' with { type: 'json' };
import { parseJsonBlock, makeQuota } from './naesin-extract.mjs';

export const ISSUE_BODY_LIMIT = 512_000;     // PUT /admin/issue — 호 400KB + 포장
export const STATE_BODY_LIMIT = 200_000;     // 그 외 전부
export const STATE_MAX_BYTES = 150_000;      // 학생 기록 1건 상한
export const PUTS_PER_DAY = 10;              // PUT /state 하루 상한 — KV 쓰기 예산은 네임스페이스 합산이다(앱은 20초 디바운스)
export const LETTER_AI_DAILY_DEFAULT = 30;   // AI 초안 하루 호출 상한 — 한 호가 6조각(공통 + 학년대 5)이라 하루 다섯 호
export const DRAFT_PARTS = ['shared', 'K', 'E1', 'E2', 'E3', 'M'];
export const DEFAULT_TIER = 'E2';            // 학년을 못 읽는 학생의 임시 학년대 — 관리 웹 [학년대 지정]으로 바로잡는다
const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5';
const MAX_TOKENS = 16000;
const CODE_RE = /^[A-Za-z0-9-]{3,20}$/;
const ISSUE_ID_RE = /^\d{4}-W\d{2}(-[a-z0-9]{1,12})?$/;
const PTOKEN_RE = /^[A-Za-z0-9]{16,64}$/;
const KEY_RE = /^[a-z0-9-]{2,30}:\d{1,2}$/;
const TOO_LARGE = Symbol('too-large');

export const letterBodyLimit = (p) => (p === '/api/letter/admin/issue' ? ISSUE_BODY_LIMIT : STATE_BODY_LIMIT);
export function readLetterAiLimit(env) {
  const n = Number((env || {}).LETTER_AI_DAILY);
  return { total: Number.isFinite(n) && n > 0 ? Math.floor(n) : LETTER_AI_DAILY_DEFAULT };
}

const nowIso = (t) => new Date(t == null ? Date.now() : t).toISOString();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const strMax = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const byteLen = (v) => new TextEncoder().encode(JSON.stringify(v)).length;

/* 학년대 — 명부에서 읽고, 못 읽으면 기본값. guess 는 화면이 "선생님께 학년을 알려 주세요" 를 띄우는 근거 */
export function tierFor(stu) {
  const t = L.tierOf(stu);
  return t ? { tier: t, guess: false } : { tier: DEFAULT_TIER, guess: true };
}

/* ── 학생 기록 화이트리스트 — 학생 기기가 올린 값이 강사 화면(열람 현황)에 집계된다. 모양만 강제한다 ── */
function pickMap(src, keep, max) {
  const out = {};
  if (!isObj(src)) return out;
  Object.keys(src).filter((k) => KEY_RE.test(k)).slice(0, max).forEach((k) => { const v = keep(src[k]); if (v !== undefined) out[k] = v; });
  return out;
}
export function normalizeState(state) {
  if (!isObj(state)) return null;
  const out = { v: 1, issues: {} };
  const src = isObj(state.issues) ? state.issues : {};
  Object.keys(src).filter((id) => ISSUE_ID_RE.test(id)).slice(0, 60).forEach((id) => {
    const r = src[id];
    if (!isObj(r)) return;
    out.issues[id] = {
      openedAt: strMax(r.openedAt, 30), doneAt: strMax(r.doneAt, 30),
      quiz: pickMap(r.quiz, (v) => (Number.isInteger(v) && v >= 0 && v <= 4 ? v : undefined), 200),
      reveal: pickMap(r.reveal, (v) => (v === true ? true : undefined), 200),
      checks: pickMap(r.checks, (v) => (v === true ? true : undefined), 200),
    };
  });
  return out;
}

/* 가정으로 보내는 문자 문구 — 관리 웹이 학생마다 만들어 복사한다(진로독서 parent-messages 와 같은 자리) */
export function familyMessage(stu, issue, link, tier) {
  return `[WB 브레인레터] ${L.weekLabel(issue.week)} — ${issue.title}\n` +
    `${stu.name} 학생 가정에 보내는 이번 주 뉴스레터입니다 (${L.tierLabel(tier)}).\n` +
    `읽을거리·문제·웩슬러 두뇌 놀이가 들어 있어요. 화면의 [PDF로 저장]을 누르면 인쇄본을 받을 수 있어요.\n` +
    `${link}\n— WB 독해력학원 · 웩슬러브레인센터`;
}

async function allIssues(store) {
  const ids = (await store.getIssueIds()) || [];
  const out = [];
  for (const id of ids) { const rec = await store.getIssue(id); if (rec && rec.issue) out.push(rec); }
  /* 최신 발행일이 앞 — 같은 날이면 id 역순 */
  out.sort((a, b) => (b.issue.publishAt || '').localeCompare(a.issue.publishAt || '') || (b.issue.id || '').localeCompare(a.issue.id || ''));
  return out;
}
const visibleOf = (recs, today) => recs.filter((r) => L.isVisible(r.issue, today));
/* 학년대에 볼 것이 하나라도 있는 호만 목록에 올린다 — 유치부 학생에게 중등 전용 호가 뜨면 빈 화면이다 */
const hasTier = (issue, tier) => L.tiersOf(issue).includes(tier);

/* ── AI 초안 — 호 하나를 6조각(공통 + 학년대 5)으로 나눠 부른다. 한 번에 다 부르면 응답이 길어 브라우저가
   기다리다 끊기고, 실패하면 전부 버린다. 조각이면 관리 웹이 진행률을 보이고 실패한 조각만 다시 부른다. ── */
const DRAFT_SYSTEM = `너는 WB 독해력학원·웩슬러브레인센터의 주간 뉴스레터 "브레인레터" 편집자다.
유치(5~7세)부터 중학생까지 다섯 학년대(K·E1·E2·E3·M)에 같은 주제를 다른 깊이로 읽히는 글을 쓴다.
목적은 셋 — 독해력, 입시 문해력(수능·내신형 비문학 읽기), 웩슬러 지능검사(K-WISC-V) 다섯 지표(VCI 언어이해·VSI 시공간·FRI 유동추론·WMI 작업기억·PSI 처리속도)와 연결된 두뇌 놀이.

규칙:
- 출력은 JSON 객체 하나뿐이다. 설명·머리말·코드펜스를 붙이지 않는다.
- 모든 글은 네가 새로 쓴 창작이어야 한다. 책·교과서·기사·시험 문제를 옮기거나 흉내 내지 않는다. 인명·기관·통계 수치는 널리 알려진 일반 지식만 쓰고, 확신이 없으면 쓰지 않는다.
- 학년대별 읽을거리 길이(공백 포함): K 50~300자(부모가 읽어 주는 짧은 문장, readAloud:true), E1 160~480자, E2 380~820자, E3 560~1150자, M 800~1600자(수능 비문학처럼 원인·과정·가설 구조가 드러나게).
- 문제 수와 보기 수: K 3문제(보기 2~3), E1 3문제(보기 3), E2 4문제(보기 4), E3 4~5문제(보기 4), M 5문제(보기 5). answer 는 0부터 시작하는 보기 번호. skill 은 main·detail·infer·vocab·apply·critical 을 섞는다. why 는 본문의 근거를 짚는 한두 문장.
- vocab 의 word 는 반드시 본문에 그대로 나온 낱말이어야 한다. E2 이상 한자어에는 hanja 를 "葉(잎 엽)+綠(푸를 록)" 꼴로 적는다.
- 두뇌 놀이(brain)는 지정된 웩슬러 지표를 쓰되 검사 문항을 흉내 내지 않는다. 텍스트만으로 되는 놀이(기호 세기·규칙 찾기·거꾸로 말하기·공통점 말하기 등). grid 는 문자열 배열(한 줄이 한 원소). items 마다 answer 필수(열린 놀이면 "예시: …"). parentTip 한두 문장.
- 말투: K·E1 은 "~해요" 체, E2·E3 은 "~합니다/~다" 섞어도 됨, M 은 설명문체("~다").
- 섹션 id 는 요청에 적힌 것을 그대로 쓴다. tiers 는 요청에 적힌 배열 또는 "all".
- status 는 "draft". source 는 "WB 독해력학원 자체 창작 (AI 초안, 원장 검수 전)".`;

function partSpec(part) {
  if (part === 'shared') return {
    ask: '공통 조각을 만든다. 출력: {"head":{"title":"호 제목(30자 이내)","theme":"이번 주 주제 한 줄","intro":"편집자 머리말 2~3문장"},"sections":[ words(id "words", tiers ["E2","E3","M"], 한자 하나의 낱말 가족 4~6개, family {hanja,hun,eum}, task), column(id "column", tiers "all", 부모용 입시 문해력·웩슬러 칼럼 3~4문단, takeaway), checklist(id "mission", tiers "all", items 4~5), notice(id "notice", tiers "all", 원장 메모의 소식이 있으면 그것을, 없으면 "(예시)" 를 붙인 자리표시 2~3개) ]}',
    example: SAMPLE_PARTS().shared,
  };
  const s = { K: '유치(5~7세)', E1: '초등 1~2학년', E2: '초등 3~4학년', E3: '초등 5~6학년', M: '중학교 1~3학년' }[part];
  return {
    ask: `학년대 ${part}(${s}) 조각을 만든다. 출력: {"sections":[ read(id "read-${part.toLowerCase()}", tiers ["${part}"], title, minutes, paragraphs, vocab, questions${part === 'K' ? ', readAloud:true, lead(부모 안내 한 줄)' : ''}), brain(id "brain-${part.toLowerCase()}", tiers ["${part}"], index 는 지정된 지표, title, minutes, howTo, items 3~5, parentTip), coach(id "coach-${part.toLowerCase()}", tiers ["${part}"], title "… 부모님께", tips 2) ]}`,
    example: SAMPLE_PARTS()[part],
  };
}
let SAMPLE_CACHE = null;
/* 형식 예시는 샘플 호(자체 창작)에서 그 조각만 뽑아 보여 준다 — 스키마를 말로 설명하는 것보다 JSON 하나가 정확하다 */
export function SAMPLE_PARTS() {
  if (SAMPLE_CACHE) return SAMPLE_CACHE;
  const by = (ids) => SAMPLE.sections.filter((x) => ids.includes(x.id));
  SAMPLE_CACHE = { shared: { head: { title: SAMPLE.title, theme: SAMPLE.theme, intro: SAMPLE.intro }, sections: by(['words', 'column', 'mission', 'notice']) } };
  for (const t of ['K', 'E1', 'E2', 'E3', 'M']) { const k = t.toLowerCase(); SAMPLE_CACHE[t] = { sections: by(['read-' + k, 'brain-' + k, 'coach-' + k]) }; }
  return SAMPLE_CACHE;
}

export function draftUserPrompt({ part, theme, week, publishAt, brainIndex, notes }) {
  const spec = partSpec(part);
  return [
    '주차: ' + week + ' (발행일 ' + publishAt + ')',
    '이번 주 주제: ' + theme,
    part !== 'shared' ? '이번 주 이 학년대의 두뇌 놀이 지표: ' + brainIndex + ' (' + (L.WISC[brainIndex] || {}).label + ')' : '이번 주 두뇌 놀이 지표 배정: ' + JSON.stringify(brainIndex),
    notes ? '원장 메모: ' + notes : null,
    '',
    spec.ask,
    spec.example ? '형식 예시(다른 주제의 지난 호 — 형식만 따르고 내용은 이번 주제로 새로 쓴다):\n' + JSON.stringify(spec.example) : null,
  ].filter((x) => x != null).join('\n');
}

async function callDraft({ userPrompt, apiKey, model, fetchImpl }) {
  const f = fetchImpl || fetch;
  let r;
  try {
    r = await f(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      body: JSON.stringify({ model: model || DEFAULT_MODEL, max_tokens: MAX_TOKENS, fallbacks: 'default', system: DRAFT_SYSTEM, messages: [{ role: 'user', content: userPrompt }] }),
    });
  } catch (e) { return { ok: false, reason: 'network' }; }
  if (!r || !r.ok) return { ok: false, reason: 'api-' + ((r && r.status) || 0) };
  let d;
  try { d = await r.json(); } catch (e) { return { ok: false, reason: 'parse' }; }
  if (d && d.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
  if (d && d.stop_reason === 'max_tokens') return { ok: false, reason: 'truncated' };
  const text = (d && Array.isArray(d.content) ? d.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  const obj = parseJsonBlock(text);
  if (!obj || !Array.isArray(obj.sections)) return { ok: false, reason: obj ? 'shape' : 'parse' };
  return { ok: true, obj, model: (d && d.model) || null };
}

/* 조각을 임시 호로 감싸 검증한다 — 조각 단위라 학년대 커버리지 경고는 뺀다 */
function checkPart(part, obj, week, publishAt) {
  const head = isObj(obj.head) ? obj.head : {};
  const tmp = { id: week, week, publishAt, status: 'draft', title: head.title || '임시', theme: head.theme || '', intro: head.intro || '', source: 'x', sections: obj.sections };
  const r = L.checkIssue(tmp);
  return { errors: r.errors, warnings: r.warnings.filter((w) => w.where !== 'coverage') };
}

export async function handleLetter(ctx) {
  const { path: p, method, who, store } = ctx;
  const now = ctx.now == null ? Date.now() : +ctx.now;
  const today = L.kstDate(now);
  const j = (status, body) => ({ status, body });
  const body = async () => { try { return await ctx.getBody(); } catch (e) { return e && e.status === 413 ? TOO_LARGE : null; } };
  const badBody = (b) => (b === TOO_LARGE ? j(413, { error: '요청이 너무 커서 받을 수 없어요.' }) : (!b ? j(400, { error: '올바른 JSON이 아니에요.' }) : null));
  const q = (k) => String((ctx.query && ctx.query.get(k)) || '').trim();

  /* ── 가족 링크 (ptoken, 읽기 전용, 로그인 없음) ── */
  if (p === '/api/letter/parent' && method === 'GET') {
    const t = q('t');
    const code = PTOKEN_RE.test(t) ? await store.getParentCode(t) : null;
    if (!code) return j(404, { error: '유효하지 않은 링크예요. 학원에 문의해 주세요.' });
    const stu = await store.getStudent(code);
    if (!stu) return j(404, { error: '학생 정보를 찾을 수 없어요.' });
    const { tier, guess } = tierFor(stu);
    const vis = visibleOf(await allIssues(store), today).filter((r) => hasTier(r.issue, tier));
    const id = q('id');
    let rec = null;
    if (id) { rec = vis.find((r) => r.issue.id === id) || null; if (!rec) return j(404, { error: '그 호는 아직 열리지 않았어요.' }); }
    else rec = vis[0] || null;
    return j(200, { parent: { name: stu.name, tier, tierLabel: L.tierLabel(tier), guess },
      issue: rec ? L.forTier(rec.issue, tier) : null, issues: vis.map((r) => L.brief(r.issue)), updatedAt: rec ? rec.updatedAt || null : null });
  }

  if (!who) return j(401, { error: '로그인이 필요합니다.' });

  let stu = null, tier = null, guess = false;
  if (!who.admin) {
    stu = await store.getStudent(who.code);
    if (!stu) return j(404, { error: '학생 정보를 찾을 수 없어요.' });
    ({ tier, guess } = tierFor(stu));
  }

  /* ── 학생 라우트 ── */
  if (p === '/api/letter/issues' && method === 'GET' && !who.admin) {
    const vis = visibleOf(await allIssues(store), today).filter((r) => hasTier(r.issue, tier));
    return j(200, { issues: vis.map((r) => L.brief(r.issue)), tier, tierLabel: L.tierLabel(tier), guess, today });
  }
  if (p === '/api/letter/issue' && method === 'GET') {
    const id = q('id');
    if (!ISSUE_ID_RE.test(id)) return j(400, { error: '호 id 가 필요해요.' });
    const rec = await store.getIssue(id);
    if (!rec || !rec.issue) return j(404, { error: '그 호를 찾을 수 없어요.' });
    if (!who.admin) {
      if (!L.isVisible(rec.issue, today) || !hasTier(rec.issue, tier)) return j(404, { error: '그 호는 아직 열리지 않았어요.' });
      return j(200, { issue: L.forTier(rec.issue, tier), tier, tierLabel: L.tierLabel(tier), guess, updatedAt: rec.updatedAt || null });
    }
    /* 관리자 미리보기 — 초안도 보고, tier 를 주면 그 학년대로, 없거나 all 이면 전체 */
    const tq = q('tier');
    const tv = L.TIER_IDS.includes(tq) ? tq : null;
    return j(200, { issue: tv ? L.forTier(rec.issue, tv) : rec.issue, tier: tv, tierLabel: tv ? L.tierLabel(tv) : '', guess: false, updatedAt: rec.updatedAt || null });
  }
  if (p === '/api/letter/state' && method === 'GET' && !who.admin) {
    const st = await store.getState(who.code);
    return j(200, { state: (st && st.state) || { v: 1, issues: {} }, updatedAt: st ? st.updatedAt || null : null });
  }
  if (p === '/api/letter/state' && method === 'PUT' && !who.admin) {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const state = normalizeState(b.state);
    if (!state) return j(400, { error: 'state 필요' });
    const prev = await store.getState(who.code);
    const puts = prev && prev.puts && prev.puts.d === today ? prev.puts.n : 0;
    if (puts >= PUTS_PER_DAY) return j(429, { error: '오늘 저장은 여기까지예요. 내일 이어서 해요.' });
    const rec = { state, updatedAt: nowIso(now), puts: { d: today, n: puts + 1 } };
    if (byteLen(rec) > STATE_MAX_BYTES) return j(413, { error: '기록이 너무 커서 저장할 수 없어요.' });
    await store.putState(who.code, rec);
    return j(200, { ok: true, updatedAt: rec.updatedAt });
  }

  if (!who.admin) return j(403, { error: '권한이 없습니다.' });

  /* ── 관리 라우트 ── */
  if (p === '/api/letter/admin/issues' && method === 'GET') {
    const recs = await allIssues(store);
    /* 열람 수 — 학생 기록을 한 번 훑어 호별로 센다 */
    const opened = {};
    for (const c of await store.listStateCodes()) {
      const st = await store.getState(c);
      const map = (st && st.state && st.state.issues) || {};
      Object.keys(map).forEach((id) => { if (map[id] && map[id].openedAt) opened[id] = (opened[id] || 0) + 1; });
    }
    return j(200, { issues: recs.map((r) => ({ ...L.brief(r.issue), updatedAt: r.updatedAt || null, opened: opened[r.issue.id] || 0, visible: L.isVisible(r.issue, today) })), today });
  }
  if (p === '/api/letter/admin/issue' && method === 'GET') {
    const id = q('id');
    const rec = ISSUE_ID_RE.test(id) ? await store.getIssue(id) : null;
    if (!rec || !rec.issue) return j(404, { error: '그 호를 찾을 수 없어요.' });
    return j(200, { issue: rec.issue, updatedAt: rec.updatedAt || null });
  }
  if (p === '/api/letter/admin/issue' && method === 'PUT') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const issue = b.issue;
    const r = L.checkIssue(issue);
    if (r.errors.length) return j(400, { error: '검증 실패 — 오류 ' + r.errors.length + '건', errors: r.errors, warnings: r.warnings });
    const ids = (await store.getIssueIds()) || [];
    const rec = { issue, updatedAt: nowIso(now) };
    await store.putIssue(issue.id, rec);
    if (!ids.includes(issue.id)) await store.putIssueIds(ids.concat([issue.id]));
    return j(200, { ok: true, id: issue.id, status: issue.status, warnings: r.warnings, updatedAt: rec.updatedAt });
  }
  if (p === '/api/letter/admin/issue' && method === 'DELETE') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const id = String(b.id || '');
    const rec = ISSUE_ID_RE.test(id) ? await store.getIssue(id) : null;
    if (!rec) return j(404, { error: '그 호를 찾을 수 없어요.' });
    await store.deleteIssue(id);
    await store.putIssueIds(((await store.getIssueIds()) || []).filter((x) => x !== id));
    return j(200, { ok: true, id });
  }
  if (p === '/api/letter/admin/publish' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const id = String(b.id || '');
    const rec = ISSUE_ID_RE.test(id) ? await store.getIssue(id) : null;
    if (!rec || !rec.issue) return j(404, { error: '그 호를 찾을 수 없어요.' });
    if (b.status !== 'draft' && b.status !== 'published') return j(400, { error: 'status 는 draft 또는 published' });
    if (b.publishAt != null && !L.isValidDate(b.publishAt)) return j(400, { error: '발행일은 YYYY-MM-DD' });
    const issue = { ...rec.issue, status: b.status };
    if (b.publishAt) issue.publishAt = b.publishAt;
    /* 발행하려는 호는 지금 규칙으로 다시 검증한다 — 규칙이 바뀐 뒤 저장된 옛 초안이 그대로 나가지 않게 */
    const r = L.checkIssue(issue);
    if (b.status === 'published' && r.errors.length) return j(400, { error: '발행할 수 없어요 — 오류 ' + r.errors.length + '건', errors: r.errors });
    const out = { issue, updatedAt: nowIso(now) };
    await store.putIssue(id, out);
    return j(200, { ok: true, id, status: issue.status, publishAt: issue.publishAt, visible: L.isVisible(issue, today) });
  }
  if (p === '/api/letter/admin/students' && method === 'GET') {
    const students = [];
    for (const c of await store.listStudentCodes()) {
      const s = await store.getStudent(c);
      if (!s || !s.name) continue;
      const auto = L.tierOf({ grade: s.grade, level: s.level });
      const { tier: tt, guess: gg } = tierFor(s);
      students.push({ code: c, name: s.name, grade: s.grade || '', cls: s.cls || '', tier: tt, guess: gg, letterTier: s.letterTier || '', autoTier: auto || '', hasLink: !!s.ptoken, apps: s.apps || null });
    }
    students.sort((a, b) => L.TIER_IDS.indexOf(a.tier) - L.TIER_IDS.indexOf(b.tier) || a.name.localeCompare(b.name, 'ko'));
    return j(200, { students, tiers: L.TIERS });
  }
  if (p === '/api/letter/admin/tier' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const code = String(b.code || '');
    const s = CODE_RE.test(code) ? await store.getStudent(code) : null;
    if (!s) return j(404, { error: '학생 없음' });
    const t = b.tier == null || b.tier === '' ? '' : String(b.tier);
    if (t && !L.TIER_IDS.includes(t)) return j(400, { error: '학년대는 K·E1·E2·E3·M 또는 빈 값(자동)' });
    const next = { ...s };
    if (t) next.letterTier = t; else delete next.letterTier;
    await store.putStudent(code, next);
    return j(200, { ok: true, code, tier: tierFor(next).tier, letterTier: t });
  }
  if (p === '/api/letter/admin/messages' && method === 'GET') {
    const id = q('id');
    const rec = ISSUE_ID_RE.test(id) ? await store.getIssue(id) : null;
    if (!rec || !rec.issue) return j(404, { error: '그 호를 찾을 수 없어요.' });
    const origin = ctx.origin || '';
    const messages = [];
    for (const c of await store.listStudentCodes()) {
      const s = await store.getStudent(c);
      if (!s || !s.name) continue;
      const { tier: tt } = tierFor(s);
      if (!hasTier(rec.issue, tt)) continue;
      /* 가족 링크가 없으면 여기서 만든다 — 진로독서 parent-messages 와 같은 토큰(parent:<t>)이라 링크가 가정마다 하나다 */
      let ptoken = s.ptoken;
      if (!ptoken) {
        ptoken = ctx.randomToken ? ctx.randomToken() : crypto.randomUUID().replace(/-/g, '');
        await store.putParent(ptoken, c);
        await store.putStudent(c, { ...s, ptoken });
      }
      const link = origin + '/letter/?t=' + ptoken;
      messages.push({ code: c, name: s.name, cls: s.cls || '', tier: tt, link, text: familyMessage(s, rec.issue, link, tt) });
    }
    messages.sort((a, b) => L.TIER_IDS.indexOf(a.tier) - L.TIER_IDS.indexOf(b.tier) || a.name.localeCompare(b.name, 'ko'));
    return j(200, { messages, issue: L.brief(rec.issue) });
  }
  if (p === '/api/letter/admin/stats' && method === 'GET') {
    const id = q('id');
    const rec = ISSUE_ID_RE.test(id) ? await store.getIssue(id) : null;
    if (!rec || !rec.issue) return j(404, { error: '그 호를 찾을 수 없어요.' });
    const issue = rec.issue;
    const byTier = {}; L.TIER_IDS.forEach((t) => { byTier[t] = { total: 0, opened: 0, done: 0 }; });
    const unopened = [];
    const quiz = [];
    const qIndex = {};
    issue.sections.forEach((s) => { if (s.type === 'read') (s.questions || []).forEach((qq, qi) => { const row = { section: s.id, title: s.title, qi, skill: qq.skill || '', n: 0, correct: 0 }; qIndex[s.id + ':' + qi] = { row, answer: qq.answer }; quiz.push(row); }); });
    for (const c of await store.listStudentCodes()) {
      const s = await store.getStudent(c);
      if (!s || !s.name) continue;
      const { tier: tt } = tierFor(s);
      if (!hasTier(issue, tt)) continue;
      byTier[tt].total += 1;
      const st = await store.getState(c);
      const r = st && st.state && st.state.issues && st.state.issues[id];
      if (r && r.openedAt) {
        byTier[tt].opened += 1;
        if (r.doneAt) byTier[tt].done += 1;
        Object.keys(r.quiz || {}).forEach((k) => { const x = qIndex[k]; if (!x) return; x.row.n += 1; if (r.quiz[k] === x.answer) x.row.correct += 1; });
      } else unopened.push({ code: c, name: s.name, cls: s.cls || '', tier: tt });
    }
    const total = Object.values(byTier).reduce((a, b) => a + b.total, 0), opened = Object.values(byTier).reduce((a, b) => a + b.opened, 0);
    return j(200, { stats: { id, total, opened, byTier, unopened, quiz } });
  }
  if (p === '/api/letter/admin/draft' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const part = String(b.part || '');
    if (!DRAFT_PARTS.includes(part)) return j(400, { error: 'part 는 shared·K·E1·E2·E3·M 중 하나' });
    const theme = strMax(b.theme, 200).trim();
    if (!theme) return j(400, { error: '이번 주 주제(theme)가 필요해요.' });
    const week = /^\d{4}-W\d{2}$/.test(String(b.week || '')) ? b.week : L.weekId(now);
    const publishAt = L.isValidDate(b.publishAt) ? b.publishAt : (L.weekStart(week) || today);
    const brainIndex = part === 'shared' ? (isObj(b.brainIndex) ? b.brainIndex : {}) : (L.WISC[b.brainIndex] ? b.brainIndex : 'FRI');
    const ai = ctx.ai || {};
    if (!ai.apiKey) return j(200, { ok: false, reason: 'no-key', part });
    const limits = readLetterAiLimit(ai.env);
    let useRec = store.getAiUse ? await store.getAiUse() : null;
    const quota = ai.quota || makeQuota({ rec: useRec, limits, now, onUse: (rec) => { useRec = rec; } });
    if (!quota.take()) return j(200, { ok: false, reason: 'quota', part, aiLeft: 0, aiCap: limits.total });
    const res = await callDraft({ userPrompt: draftUserPrompt({ part, theme, week, publishAt, brainIndex, notes: strMax(b.notes, 1000) }), apiKey: ai.apiKey, model: ai.model, fetchImpl: ai.fetchImpl });
    /* 쓴 만큼은 성공·실패와 무관하게 남긴다 — 실패한 호출도 요금은 나간다 */
    if (store.putAiUse && useRec) await store.putAiUse(useRec);
    const aiLeft = typeof quota.left === 'function' ? quota.left() : null;
    if (!res.ok) return j(200, { ok: false, reason: res.reason, part, aiLeft, aiCap: limits.total });
    const chk = checkPart(part, res.obj, week, publishAt);
    return j(200, { ok: true, part, head: isObj(res.obj.head) ? { title: strMax(res.obj.head.title, 80), theme: strMax(res.obj.head.theme, 120), intro: strMax(res.obj.head.intro, 800) } : null,
      sections: res.obj.sections, errors: chk.errors, warnings: chk.warnings, model: res.model, aiLeft, aiCap: limits.total });
  }
  return j(404, { error: 'unknown api' });
}

/* 퇴원 처리 — 학생 기록만 지운다. 호는 학생 것이 아니다 */
export async function dropStudentLetter(store, code) {
  await store.deleteState(code);
}
/* 백업 — 호 본문은 원장이 쓴 것이라 통째로 담는다(내신 팩과 달리 라이선스 원문이 아니다). 학생 기록도 담는다 */
export async function dumpLetter(store) {
  const issues = {}, states = {};
  for (const r of await allIssues(store)) issues[r.issue.id] = r;
  for (const c of await store.listStateCodes()) { const st = await store.getState(c); if (st) states[c] = st; }
  return { issues, states };
}
