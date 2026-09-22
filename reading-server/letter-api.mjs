'use strict';
/* WB 브레인레터 — /api/letter/* 라우트 (server.mjs·worker.mjs 공용, haru-api.mjs 선례)
   격리 원칙: 라우트는 /api/letter/* 아래, 데이터는 letter: 접두 KV(로컬은 db.letter)만 쓴다.
   인증은 호스트의 토큰 검증 결과(who)를 받고, apps 게이트(allowedApp)는 호스트가 who 검증 직후 한 곳에서 건다.
   가족 링크(/api/letter/parent?t=)는 진로독서 학부모 토큰(parent:<t>)을 그대로 쓴다 — 가정마다 링크가 하나여야
   주간 문자에 링크를 두 개 넣는 일이 없다.

   호(issue)의 유일한 검증기는 letter/letter.js 의 checkIssue 다 — 관리 웹·AI 초안·저장이 같은 규칙으로 걸러진다.
   학생에게는 자기 학년대 섹션만 내려간다(forTier). 정답은 뉴스레터의 일부라 함께 내려간다(하루브레인과 다르다 —
   시험이 아니라 가정 학습지다).
   사진(letter:img:<id>)은 관리 웹이 올리고 id(128비트 무작위)로 서빙한다. 새 호 알림은 워드브레인의 VAPID 배선을 재사용한다.
   주제 달력은 배포본 기본값(letter/calendar.json) 위에 KV(letter:calendar)가 덮어쓴다. */
import L from '../letter/letter.js';
import SAMPLE from '../letter/issue-sample.json' with { type: 'json' };
import CALENDAR_DEFAULT from '../letter/calendar.json' with { type: 'json' };
import { parseJsonBlock, makeQuota } from './naesin-extract.mjs';
import { vapidJwt } from './vocab-api.mjs';

export const ISSUE_BODY_LIMIT = 512_000;     // PUT /admin/issue — 호 400KB + 포장
export const IMG_BODY_LIMIT = 2_400_000;     // POST /admin/img — 사진 1.5MB 의 base64 + 포장
export const IMG_MAX_BYTES = 1_500_000;      // 사진 한 장 상한(관리 웹이 올리기 전에 1600px·JPEG 로 줄인다)
export const STATE_BODY_LIMIT = 200_000;     // 그 외 전부
export const STATE_MAX_BYTES = 150_000;      // 학생 기록 1건 상한
export const PUTS_PER_DAY = 10;              // PUT /state 하루 상한 — KV 쓰기 예산은 네임스페이스 합산이다(앱은 20초 디바운스)
export const LETTER_AI_DAILY_DEFAULT = 30;   // AI 초안 하루 호출 상한 — 한 호 7조각(공통 + 학년대 5 + 이슈), 삽화도 함께 센다
export const DRAFT_PARTS = ['shared', 'K', 'E1', 'E2', 'E3', 'M', 'news'];   // news 는 웹 검색으로 그 주의 교육·입시 소식을 간추리는 조각
export const DEFAULT_TIER = 'E2';            // 학년을 못 읽는 학생의 임시 학년대 — 관리 웹 [학년대 지정]으로 바로잡는다
export const IMAGE_RATIOS = ['16:9', '4:3', '1:1', '3:4'];   // AI 삽화 비율 — 모델이 받는 값만(표지 16:10 자리는 16:9 를 cover 로 맞춘다)
export const IMAGE_PROMPT_MAX = 600;
const IMAGE_API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';   // "나노바나나" — LETTER_IMAGE_MODEL 로 바꾼다
/* 삽화 공통 지시 — 배포본 SVG 삽화와 같은 결(단순한 색면·따뜻한 빛·밝은 종이 바탕). 글자는 넣지 않는다:
   모델이 그리는 글자는 자주 틀리고, 캡션·제목은 지면이 단다. 실존 인물을 그리지 않는 것은 초상권 때문 */
const IMAGE_STYLE = '어린이 주간 신문에 싣는 삽화. 단순한 색면과 부드러운 종이 질감, 따뜻한 빛, 밝은 바탕. 인물은 실존 인물이 아닌 그림체의 아이·가족.'
  + ' 그림 안에 글자·숫자·워터마크·말풍선을 넣지 않는다. No text, letters, numbers, logos or watermark anywhere in the image.';
const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5';
const MAX_TOKENS = 16000;
const CODE_RE = /^[A-Za-z0-9-]{3,20}$/;
const ISSUE_ID_RE = /^\d{4}-W\d{2}(-[a-z0-9]{1,12})?$/;
const PTOKEN_RE = /^[A-Za-z0-9]{16,64}$/;
const IMG_ID_RE = /^[a-f0-9]{32}$/;
const IMG_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const KEY_RE = /^[a-z0-9-]{2,30}:\d{1,2}$/;
const TOO_LARGE = Symbol('too-large');

export const letterBodyLimit = (p) => (p === '/api/letter/admin/issue' ? ISSUE_BODY_LIMIT : p === '/api/letter/admin/img' ? IMG_BODY_LIMIT : STATE_BODY_LIMIT);
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

/* ── 사진 — 관리 웹이 base64 로 올린다. 종류는 확장자가 아니라 앞 몇 바이트(매직 바이트)로 확인한다:
   SVG 는 받지 않는다(스크립트가 들어갈 수 있어 직접 열면 실행된다). 배포본 삽화(letter/img/*.svg)는 저장소의 자체 제작본이라 예외. ── */
function b64decode(s) {
  const clean = String(s || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const bin = atob(clean); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/* ── 새 호 도착 푸시 — 워드브레인 밤 9시 푸시와 같은 배선(VAPID 서명, 페이로드 없음). 구독 키는 s:<학생 코드> 또는 f:<가족 토큰>.
   호에 그 가정의 학년대 섹션이 없으면 보내지 않는다(유치부 가정에 중등 전용 호 알림이 가면 열어도 빈 화면이다). ── */
async function tierOfPushKey(store, key) {
  const [kind, id] = [key.slice(0, 2), key.slice(2)];
  let code = null;
  if (kind === 's:') code = id;
  else if (kind === 'f:') code = await store.getParentCode(id);
  if (!code) return null;
  const stu = await store.getStudent(code);
  return stu ? tierFor(stu).tier : null;
}
export async function sendLetterPushes({ store, push, fetchFn, issue, now }) {
  if (!push || !push.publicKey || !push.privateJwk) return { sent: 0, skipped: 0, removed: 0, failed: 0, reason: 'no-vapid' };
  const f = fetchFn || fetch;
  let sent = 0, skipped = 0, removed = 0, failed = 0;
  for (const key of await store.listPushKeys()) {
    const sub = await store.getPush(key);
    if (!sub || !sub.endpoint) continue;
    const tier = await tierOfPushKey(store, key);
    if (!tier) { await store.delPush(key); removed += 1; continue; }        // 퇴원했거나 링크가 바뀐 구독
    if (issue && !L.tiersOf(issue).includes(tier)) { skipped += 1; continue; }
    try {
      const jwt = await vapidJwt({ audience: new URL(sub.endpoint).origin, subject: push.subject || 'mailto:admin@wb.local', privateJwk: push.privateJwk });
      const r = await f(sub.endpoint, { method: 'POST', headers: { TTL: '172800', Urgency: 'normal', Authorization: 'vapid t=' + jwt + ', k=' + push.publicKey } });
      if (r.status === 404 || r.status === 410) { await store.delPush(key); removed += 1; }
      else if (r.status >= 200 && r.status < 300) sent += 1;
      else failed += 1;
    } catch (e) { failed += 1; }
  }
  return { sent, skipped, removed, failed };
}
/* KV는 같은 키를 초당 한 번만 쓴다. 저장→발행→결과의 연속 쓰기는 1초 뒤 최신 기록에 다시 합친다.
   ponytail: 429 재시도는 한 번뿐이다. 여러 관리자가 동시에 편집하게 되면 호별 직렬 저장으로 바꾼다. */
async function saveIssue(store, id, update) {
  for (let attempt = 0; ; attempt += 1) {
    const rec = update(await store.getIssue(id));
    if (!rec) return;
    try { await store.putIssue(id, rec); return; }
    catch (e) {
      if (attempt || !/^KV PUT failed: 429\b/.test(String(e && e.message))) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
/* 발송 중 원장이 고친 본문·발행 상태는 유지하고, 마지막 발송 결과만 덧붙인다. 실패분은 관리 웹에서 다시 보낸다. */
async function recordPush(store, id, result, now) {
  await saveIssue(store, id, (rec) => rec && { ...rec, pushedAt: nowIso(now), pushResult: result });
}
/* 발행일이 된 호에 아직 알림을 안 보냈으면 보낸다 — 07:00 KST 크론이 부른다(예약 발행분). 즉시 발행은 publish 라우트가 보낸다 */
export async function pushDueIssues({ store, push, fetchFn, now }) {
  if (!push || !push.publicKey || !push.privateJwk) return { pushed: [], reason: 'no-vapid' };
  const t = now == null ? Date.now() : +now;
  const today = L.kstDate(t);
  const out = [];
  for (const rec of await allIssues(store)) {
    if (!L.isVisible(rec.issue, today) || rec.pushedAt) continue;
    const r = await sendLetterPushes({ store, push, fetchFn, issue: rec.issue, now: t });
    if (r.reason === 'no-vapid') return { pushed: [], reason: 'no-vapid' };
    await recordPush(store, rec.issue.id, r, t);
    out.push({ id: rec.issue.id, ...r });
  }
  return { pushed: out };
}
function subscriptionEndpoint(b) {
  const sub = b && b.subscription;
  const ep = sub && String(sub.endpoint || '');
  return ep && ep.length <= 500 && /^https:\/\//.test(ep) ? ep : null;
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
      /* 하루 한 장 — 요일(1~7)별로 마친 시각. 따라쓰기 — 섹션별 마친 회차 */
      days: pickDays(r.days),
      trace: pickTrace(r.trace),
      /* 한 문장 쓰기 — 섹션:번호 키에 300자까지. 지면에 다시 그려지는 값이라 화면이 이스케이프한다(여기서는 길이·형만 본다) */
      write: pickMap(r.write, (v) => (typeof v === 'string' && v.trim() && v.length <= 300 ? v : undefined), 40),
    };
  });
  return out;
}
function pickDays(src) { const out = {}; if (!isObj(src)) return out; for (let d = 1; d <= 7; d++) { const v = src[d]; if (typeof v === 'string' && v && v.length <= 30) out[d] = v; } return out; }
function pickTrace(src) { const out = {}; if (!isObj(src)) return out; Object.keys(src).filter((k) => /^[a-z0-9-]{2,30}$/.test(k)).slice(0, 20).forEach((k) => { const v = src[k]; if (Number.isInteger(v) && v >= 0 && v <= 30) out[k] = v; }); return out; }

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

/* ── AI 초안 — 호 하나를 7조각(공통 + 학년대 5 + 이슈)으로 나눠 부른다. 한 번에 다 부르면 응답이 길어 브라우저가
   기다리다 끊기고, 실패하면 전부 버린다. 조각이면 관리 웹이 진행률을 보이고 실패한 조각만 다시 부른다. ── */
const DRAFT_SYSTEM = `너는 WB 독해력학원·웩슬러브레인센터의 주간 뉴스레터 "브레인레터" 편집자다.
유치(5~7세)부터 중학생까지 다섯 학년대(K·E1·E2·E3·M)에 같은 주제를 다른 깊이로 읽히는 글을 쓴다.
목적은 셋 — 독해력, 입시 문해력(수능·내신형 비문학 읽기), 웩슬러 지능검사(K-WISC-V) 다섯 지표(VCI 언어이해·VSI 시공간·FRI 유동추론·WMI 작업기억·PSI 처리속도)와 연결된 두뇌 놀이.

규칙:
- 출력은 JSON 객체 하나뿐이다. 설명·머리말·코드펜스를 붙이지 않는다.
- 모든 글은 네가 새로 쓴 창작이어야 한다. 책·교과서·기사·시험 문제를 옮기거나 흉내 내지 않는다. 인명·기관·통계 수치는 널리 알려진 일반 지식만 쓰고, 확신이 없으면 쓰지 않는다.
- 단 하나의 예외 — 교육·입시 이슈(news) 조각은 웹 검색 결과를 간추린다. 기사 문장을 옮기지 말고 사실만 짧게 정리하며, 항목마다 출처(기관·언론명)와 원문 주소를 적는다. 검색으로 확인되지 않은 수치·날짜는 쓰지 않는다.
- 학년대별 읽을거리 길이(공백 포함): K 50~300자(부모가 읽어 주는 짧은 문장, readAloud:true), E1 160~480자, E2 380~820자, E3 560~1150자, M 800~1600자(수능 비문학처럼 원인·과정·가설 구조가 드러나게).
- 문제 수와 보기 수: K 3문제(보기 2~3), E1 3문제(보기 3), E2 4문제(보기 4), E3 4~5문제(보기 4), M 5문제(보기 5). answer 는 0부터 시작하는 보기 번호. skill 은 main·detail·infer·vocab·apply·critical 을 섞는다. why 는 본문의 근거를 짚는 한두 문장.
- vocab 의 word 는 반드시 본문에 그대로 나온 낱말이어야 한다. E2 이상 한자어에는 hanja 를 "葉(잎 엽)+綠(푸를 록)" 꼴로 적는다.
- 두뇌 놀이(brain)는 지정된 웩슬러 지표를 쓰되 검사 문항을 흉내 내지 않는다. 텍스트만으로 되는 놀이(기호 세기·규칙 찾기·거꾸로 말하기·공통점 말하기 등). grid 는 문자열 배열(한 줄이 한 원소). items 마다 answer 필수(열린 놀이면 "예시: …"). parentTip 한두 문장. 항목 하나는 생성기 놀이로 둘 수 있다: {"drill":{"kind":"span"|"symbols"|"sequence"|"common"|"odd-word","seed":1~999999}} — kind 는 지표에 맞춘다(WMI span · PSI symbols · FRI sequence · VCI common/odd-word). 시공간(VSI)은 {"figure":{"kind":"odd"|"rotate"|"mirror"|"blocks"|"complete","seed":…}}.
- 고정 코너(매 호 같은 자리): poem(동시 6~12줄, 네가 새로 쓴 창작, author "WB 편집실") · talk(가족 대화 카드 3문 — 예측·이유·아이 삶과 잇기) · write(학년대별 한 문장 쓰기 prompts 1~2 — 요약 한 문장, 질문 만들기, "기자가 되어 한 줄") · books(실제로 널리 알려진 어린이·청소년 책 2~3권, title·author·why·for. 확신이 없는 책은 넣지 않는다). voices(독자의 답)는 네가 만들지 않는다.
- 말투: K·E1 은 "~해요" 체, E2·E3 은 "~합니다/~다" 섞어도 됨, M 은 설명문체("~다").
- 섹션 id 는 요청에 적힌 것을 그대로 쓴다. tiers 는 요청에 적힌 배열 또는 "all".
- 미션(checklist)의 쓰기·한자 등 특정 학년대 활동은 items와 같은 길이의 itemTiers 배열로 대상을 지정한다. 각 값은 "all" 또는 학년대 배열이며, 유치부에는 쓰기·한자 미션을 넣지 않는다.
- status 는 "draft". source 는 "WB 독해력학원 자체 창작 (AI 초안, 원장 검수 전)".`;

function partSpec(part) {
  if (part === 'shared') return {
    ask: '공통 조각을 만든다. 출력: {"head":{"title":"호 제목(30자 이내)","theme":"이번 주 주제 한 줄","intro":"편집자 머리말 2~3문장"},"sections":[ words(id "words", tiers ["E2","E3","M"], 한자 하나의 낱말 가족 4~6개, family {hanja,hun,eum}, task), poem(id "poem", tiers ["K","E1","E2"], 주제와 닿는 동시 6~12줄, author "WB 편집실", task 한 줄), talk(id "talk", tiers "all", 가족 대화 카드 items 3), books(id "books", tiers "all", 주제와 닿는 실제 책 2~3권), column(id "column", tiers "all", 부모용 입시 문해력·웩슬러 칼럼 3~4문단, takeaway), checklist(id "mission", tiers "all", items 4~5), notice(id "notice", tiers "all") 는 원장 메모에 학원 소식이 있을 때만 넣는다 — 교육·입시 이슈는 news 조각이 따로 만든다 ]}',
    example: SAMPLE_PARTS().shared,
  };
  if (part === 'news') return {
    ask: '교육·입시 이슈 조각을 만든다. 웹 검색으로 오늘 기준 최근 7일의 한국 교육·입시 소식 가운데 초·중등 학부모에게 뜻이 있는 것 3~5건을 고른다 — 교육부·시도교육청·한국교육과정평가원·대교협의 발표와 주요 언론 보도만 쓰고, 커뮤니티·블로그·광고·학원 홍보는 쓰지 않는다. 항목마다 title(60자 이내), summary(2~3문장, 사실만, 400자 이내), why(우리 아이·초중등 학부모에게 뜻하는 것 한 문장), source(기관·언론명), url(검색 결과에 실제로 있는 기사 주소, https), date(YYYY-MM-DD). 출력: {"sections":[ news(id "news", tiers "all", title "이번 주 교육·입시 이슈", items 3~5) ]}',
    example: SAMPLE_PARTS().news,
  };
  const s = { K: '유치(5~7세)', E1: '초등 1~2학년', E2: '초등 3~4학년', E3: '초등 5~6학년', M: '중학교 1~3학년' }[part];
  return {
    ask: `학년대 ${part}(${s}) 조각을 만든다. 출력: {"sections":[ read(id "read-${part.toLowerCase()}", tiers ["${part}"], title, minutes, paragraphs, vocab ${part === 'K' ? '0~2' : '4~6'}개, questions${part === 'K' ? ', readAloud:true, lead(부모 안내 한 줄)' : ''}), brain(id "brain-${part.toLowerCase()}", tiers ["${part}"], index 는 지정된 지표, title, minutes, howTo, items 3~5(하나는 지표에 맞는 drill/figure 생성기 항목), parentTip), ${part === 'K' ? '' : `write(id "write-${part.toLowerCase()}", tiers ["${part}"], title, prompts 1~2 — 첫째는 "이 글을 한 문장으로", 둘째는 ${part === 'E1' ? '"글을 읽고 궁금한 것 하나"' : '"기자가 되어 제목 한 줄" 또는 "글쓴이에게 묻고 싶은 것"'}), `}coach(id "coach-${part.toLowerCase()}", tiers ["${part}"], title "… 부모님께", tips 2) ]}`,
    example: SAMPLE_PARTS()[part],
  };
}
let SAMPLE_CACHE = null;
/* 형식 예시는 샘플 호(자체 창작)에서 그 조각만 뽑아 보여 준다 — 스키마를 말로 설명하는 것보다 JSON 하나가 정확하다 */
export function SAMPLE_PARTS() {
  if (SAMPLE_CACHE) return SAMPLE_CACHE;
  const by = (ids) => SAMPLE.sections.filter((x) => ids.includes(x.id));
  SAMPLE_CACHE = { shared: { head: { title: SAMPLE.title, theme: SAMPLE.theme, intro: SAMPLE.intro }, sections: by(['words', 'poem', 'talk', 'books', 'column', 'mission', 'notice']) } };
  for (const t of ['K', 'E1', 'E2', 'E3', 'M']) { const k = t.toLowerCase(); SAMPLE_CACHE[t] = { sections: by(['read-' + k, 'brain-' + k, 'write-' + k, 'coach-' + k]) }; }
  SAMPLE_CACHE.news = { sections: by(['news']) };
  return SAMPLE_CACHE;
}

export function draftUserPrompt({ part, theme, week, publishAt, brainIndex, notes, today }) {
  const spec = partSpec(part);
  return [
    '주차: ' + week + ' (발행일 ' + publishAt + ')',
    part === 'news' ? '오늘 날짜: ' + (today || publishAt) + ' — 최근 7일 소식만' : '이번 주 주제: ' + theme,
    part === 'news' ? null : part !== 'shared' ? '이번 주 이 학년대의 두뇌 놀이 지표: ' + brainIndex + ' (' + (L.WISC[brainIndex] || {}).label + ')' : '이번 주 두뇌 놀이 지표 배정: ' + JSON.stringify(brainIndex),
    notes ? '원장 메모: ' + notes : null,
    '',
    spec.ask,
    spec.example ? '형식 예시(다른 주제의 지난 호 — 형식만 따르고 내용은 이번 주제로 새로 쓴다):\n' + JSON.stringify(spec.example) : null,
  ].filter((x) => x != null).join('\n');
}

async function callDraft({ userPrompt, apiKey, model, fetchImpl, webSearch }) {
  const f = fetchImpl || fetch;
  const req = { model: model || DEFAULT_MODEL, max_tokens: MAX_TOKENS, fallbacks: 'default', system: DRAFT_SYSTEM, messages: [{ role: 'user', content: userPrompt }] };
  /* 교육·입시 이슈 조각만 웹 검색을 켠다 — 나머지는 창작이라 검색이 오히려 남의 글을 끌어온다. 한국 기준, 한 조각에 6번까지 */
  if (webSearch) req.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6, user_location: { type: 'approximate', country: 'KR', timezone: 'Asia/Seoul' } }];
  let r;
  try {
    r = await f(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      body: JSON.stringify(req),
    });
  } catch (e) { return { ok: false, reason: 'network' }; }
  if (!r || !r.ok) return { ok: false, reason: 'api-' + ((r && r.status) || 0) };
  let d;
  try { d = await r.json(); } catch (e) { return { ok: false, reason: 'parse' }; }
  if (d && d.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
  if (d && d.stop_reason === 'max_tokens') return { ok: false, reason: 'truncated' };
  /* 웹 검색을 켜면 content 에 검색 블록이 섞여 온다 — 글 블록만 이어 붙여 JSON 을 찾는다 */
  const text = (d && Array.isArray(d.content) ? d.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  const obj = parseJsonBlock(text);
  if (!obj || !Array.isArray(obj.sections)) return { ok: false, reason: d && d.stop_reason === 'pause_turn' ? 'paused' : (obj ? 'shape' : 'parse') };
  return { ok: true, obj, model: (d && d.model) || null };
}

/* AI 삽화 — Gemini 이미지 모델(generateContent, 응답은 inlineData 의 base64). 바이트를 저장하지 않고 관리 웹에 돌려준다:
   모델이 주는 PNG 는 1~2MB 라 사진 상한(1.5MB)을 자주 넘고, 관리 웹이 어차피 1600px JPEG 로 줄여 /admin/img 로 올린다 —
   원장이 미리 보고 마음에 드는 것만 올리므로 저장소에는 고른 그림만 남는다 */
async function callImage({ prompt, ratio, apiKey, model, fetchImpl }) {
  const f = fetchImpl || fetch;
  const m = model || DEFAULT_IMAGE_MODEL;
  const req = { contents: [{ parts: [{ text: IMAGE_STYLE + '\n\n장면: ' + prompt }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ratio } } };
  let r;
  try {
    r = await f(IMAGE_API + encodeURIComponent(m) + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(req) });
  } catch (e) { return { ok: false, reason: 'network' }; }
  if (!r || !r.ok) return { ok: false, reason: 'api-' + ((r && r.status) || 0) };
  let d;
  try { d = await r.json(); } catch (e) { return { ok: false, reason: 'parse' }; }
  if (d && d.promptFeedback && d.promptFeedback.blockReason) return { ok: false, reason: 'refused' };
  const cand = d && Array.isArray(d.candidates) ? d.candidates[0] : null;
  const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
  const part = parts.find((x) => x && x.inlineData && typeof x.inlineData.data === 'string' && x.inlineData.data);
  if (!part) return { ok: false, reason: /SAFETY|PROHIBITED|BLOCK/i.test(String((cand && cand.finishReason) || '')) ? 'refused' : 'shape' };
  let bytes;
  try { bytes = b64decode(part.inlineData.data); } catch (e) { return { ok: false, reason: 'parse' }; }
  const type = sniffImage(bytes);   // 보낸 mimeType 이 아니라 바이트로 정한다 — 올릴 때와 같은 규칙
  if (!type) return { ok: false, reason: 'shape' };
  return { ok: true, type, size: bytes.length, data: part.inlineData.data.replace(/\s+/g, ''), model: m };
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

  /* 가족 링크의 기록 — 링크 토큰이 곧 자격(읽기와 같다). 학생 코드 하나에 기록 하나라 앱 연동 학생과 같은 자리에 쓴다.
     원장의 열람 현황이 가족 링크로 읽은 것(하루 한 장 진행)도 세려면 기록이 기기 밖으로 나와야 한다 */
  if (p === '/api/letter/parent/state' && (method === 'GET' || method === 'PUT')) {
    const t = q('t');
    const code = PTOKEN_RE.test(t) ? await store.getParentCode(t) : null;
    if (!code) return j(404, { error: '유효하지 않은 링크예요.' });
    if (method === 'GET') { const st = await store.getState(code); return j(200, { state: (st && st.state) || { v: 1, issues: {} }, updatedAt: st ? st.updatedAt || null : null }); }
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const state = normalizeState(b.state);
    if (!state) return j(400, { error: 'state 필요' });
    const prev = await store.getState(code);
    const puts = prev && prev.puts && prev.puts.d === today ? prev.puts.n : 0;
    if (puts >= PUTS_PER_DAY) return j(429, { error: '오늘 저장은 여기까지예요. 내일 이어서 해요.' });
    const rec = { state, updatedAt: nowIso(now), puts: { d: today, n: puts + 1 } };
    if (byteLen(rec) > STATE_MAX_BYTES) return j(413, { error: '기록이 너무 커서 저장할 수 없어요.' });
    await store.putState(code, rec);
    return j(200, { ok: true, updatedAt: rec.updatedAt });
  }

  /* 사진 — id 가 128비트 무작위라 그 자체가 열쇠다(가족 링크 토큰과 같은 방식). 내용이 바뀌지 않으니 오래 캐시한다 */
  const mImg = p.match(/^\/api\/letter\/img\/([a-f0-9]{32})$/);
  if (mImg && method === 'GET') {
    const rec = await store.getImage(mImg[1]);
    if (!rec || !rec.bytes) return j(404, { error: '사진을 찾을 수 없어요.' });
    return { status: 200, bytes: rec.bytes, headers: { 'Content-Type': (rec.meta && rec.meta.type) || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } };
  }
  /* 가족 링크 알림 구독 — 토큰이 곧 자격이다. 구독 키 f:<토큰> */
  if (p.startsWith('/api/letter/parent/push/')) {
    const t = q('t');
    const code = PTOKEN_RE.test(t) ? await store.getParentCode(t) : null;
    if (!code) return j(404, { error: '유효하지 않은 링크예요.' });
    if (p === '/api/letter/parent/push/key' && method === 'GET') { const key = ctx.push && ctx.push.publicKey; return j(200, key ? { ok: true, key } : { ok: false, reason: 'no-vapid' }); }
    if (p === '/api/letter/parent/push/subscribe' && method === 'POST') {
      const b = await body(); const bad = badBody(b); if (bad) return bad;
      const ep = subscriptionEndpoint(b); if (!ep) return j(400, { error: '유효한 구독이 아니에요.' });
      await store.putPush('f:' + t, { endpoint: ep, at: nowIso(now) });
      return j(200, { ok: true });
    }
    if (p === '/api/letter/parent/push/unsubscribe' && method === 'POST') { await store.delPush('f:' + t); return j(200, { ok: true }); }
    return j(404, { error: 'unknown api' });
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

  if (p === '/api/letter/push/key' && method === 'GET' && !who.admin) { const key = ctx.push && ctx.push.publicKey; return j(200, key ? { ok: true, key } : { ok: false, reason: 'no-vapid' }); }
  if (p === '/api/letter/push/subscribe' && method === 'POST' && !who.admin) {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const ep = subscriptionEndpoint(b); if (!ep) return j(400, { error: '유효한 구독이 아니에요.' });
    await store.putPush('s:' + who.code, { endpoint: ep, at: nowIso(now) });
    return j(200, { ok: true });
  }
  if (p === '/api/letter/push/unsubscribe' && method === 'POST' && !who.admin) { await store.delPush('s:' + who.code); return j(200, { ok: true }); }

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
    return j(200, { issues: recs.map((r) => ({ ...L.brief(r.issue), updatedAt: r.updatedAt || null, pushedAt: r.pushedAt || null, pushResult: r.pushResult || null, opened: opened[r.issue.id] || 0, visible: L.isVisible(r.issue, today) })), today });
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
    const updatedAt = nowIso(now);
    await saveIssue(store, issue.id, (prev) => ({ ...prev, issue, updatedAt }));
    if (!ids.includes(issue.id)) await store.putIssueIds(ids.concat([issue.id]));
    return j(200, { ok: true, id: issue.id, status: issue.status, warnings: r.warnings, updatedAt });
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
    const updatedAt = nowIso(now);
    const visibleNow = L.isVisible(issue, today);
    let pushInfo = null;
    /* 알림 키가 없거나 발송이 늦어도 발행 자체는 먼저 저장된다. */
    await saveIssue(store, id, (prev) => ({ ...prev, issue, updatedAt }));
    /* 지금 보이는 호를 처음 발행하면 바로 알림 — 발행일이 아직이면 07:00 크론이 그날 보낸다. 내렸다 다시 올려도 두 번 보내지 않는다 */
    if (visibleNow && !rec.pushedAt) {
      const run = (async () => {
        const r = await sendLetterPushes({ store, push: ctx.push, fetchFn: ctx.pushFetch, issue, now });
        if (r.reason !== 'no-vapid') await recordPush(store, id, r, now);
        return r;
      })();
      if (ctx.after) { ctx.after(run); pushInfo = { queued: true }; }
      else pushInfo = await run;
    }
    return j(200, { ok: true, id, status: issue.status, publishAt: issue.publishAt, visible: visibleNow, push: pushInfo });
  }
  /* 알림 다시 보내기 — 구독자 전원(그 호의 학년대가 있는 가정만) */
  if (p === '/api/letter/admin/push' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const id = String(b.id || '');
    const rec = ISSUE_ID_RE.test(id) ? await store.getIssue(id) : null;
    if (!rec || !rec.issue) return j(404, { error: '그 호를 찾을 수 없어요.' });
    if (!L.isVisible(rec.issue, today)) return j(409, { error: '아직 보이지 않는 호예요 — 발행일이 지나야 알림을 보낼 수 있어요.' });
    const r = await sendLetterPushes({ store, push: ctx.push, fetchFn: ctx.pushFetch, issue: rec.issue, now });
    if (r.reason === 'no-vapid') return j(200, { ok: false, reason: 'no-vapid' });
    await recordPush(store, id, r, now);
    return j(200, { ok: true, id, ...r });
  }
  if (p === '/api/letter/admin/push/status' && method === 'GET') {
    let student = 0, family = 0;
    for (const k of await store.listPushKeys()) { if (k.startsWith('s:')) student += 1; else if (k.startsWith('f:')) family += 1; }
    return j(200, { subscribers: student + family, byKind: { student, family }, vapid: !!(ctx.push && ctx.push.publicKey && ctx.push.privateJwk) });
  }
  /* ── 사진 ── */
  if (p === '/api/letter/admin/imgs' && method === 'GET') {
    const images = (await store.listImages()).map((m) => ({ ...m, url: '/api/letter/img/' + m.id }));
    images.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    return j(200, { images });
  }
  if (p === '/api/letter/admin/img' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    let bytes;
    try { bytes = b64decode(b.data); } catch (e) { return j(400, { error: '사진 데이터(base64)를 읽을 수 없어요.' }); }
    if (!bytes.length) return j(400, { error: '사진 데이터가 비었어요.' });
    if (bytes.length > IMG_MAX_BYTES) return j(413, { error: '사진이 너무 커요 — 1.5MB 이내로 줄여 주세요(관리 웹이 자동으로 줄입니다).' });
    const type = sniffImage(bytes);
    if (!type) return j(400, { error: 'JPEG·PNG·WebP 만 올릴 수 있어요.' });
    const id = ctx.randomToken ? ctx.randomToken() : crypto.randomUUID().replace(/-/g, '');
    /* src: 'ai' 는 AI 삽화 — 스니펫의 credit 이 「WB 편집실 · AI 생성」 이 된다(출처 표시를 사람이 고쳐 쓰지 않게) */
    const meta = { id, type, ext: IMG_TYPES[type], size: bytes.length, name: strMax(b.name, 80), w: Number.isInteger(b.w) ? b.w : null, h: Number.isInteger(b.h) ? b.h : null, at: nowIso(now), src: b.src === 'ai' ? 'ai' : 'upload' };
    await store.putImage(id, bytes, meta);
    return j(200, { ok: true, id, url: '/api/letter/img/' + id, size: bytes.length, type });
  }
  if (p === '/api/letter/admin/img' && method === 'DELETE') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const id = String(b.id || '');
    if (!IMG_ID_RE.test(id)) return j(400, { error: '사진 id 형식이 아니에요.' });
    if (!(await store.getImage(id))) return j(404, { error: '사진을 찾을 수 없어요.' });
    await store.deleteImage(id);
    return j(200, { ok: true, id });
  }
  /* AI 삽화 — 하루 한도는 AI 초안과 같은 장부(letter:aiuse)로 센다: 한 장에 몇십 원이라도 반복 실수를 막는 울타리는 하나면 된다 */
  if (p === '/api/letter/admin/img/gen' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const prompt = strMax(b.prompt, IMAGE_PROMPT_MAX).trim();
    if (prompt.length < 2) return j(400, { error: '어떤 그림을 만들지 한 줄로 적어 주세요.' });
    const ratio = b.ratio == null || b.ratio === '' ? '4:3' : String(b.ratio);
    if (!IMAGE_RATIOS.includes(ratio)) return j(400, { error: '비율은 ' + IMAGE_RATIOS.join(' · ') + ' 중 하나' });
    const ai = ctx.ai || {};
    if (!ai.imageKey) return j(200, { ok: false, reason: 'no-key' });
    const limits = readLetterAiLimit(ai.env);
    let useRec = store.getAiUse ? await store.getAiUse() : null;
    const quota = ai.quota || makeQuota({ rec: useRec, limits, now, onUse: (rec) => { useRec = rec; } });
    if (!quota.take()) return j(200, { ok: false, reason: 'quota', aiLeft: 0, aiCap: limits.total });
    const res = await callImage({ prompt, ratio, apiKey: ai.imageKey, model: ai.imageModel, fetchImpl: ai.fetchImpl });
    if (store.putAiUse && useRec) await store.putAiUse(useRec);
    const aiLeft = typeof quota.left === 'function' ? quota.left() : null;
    if (!res.ok) return j(200, { ok: false, reason: res.reason, aiLeft, aiCap: limits.total });
    return j(200, { ok: true, type: res.type, size: res.size, data: res.data, model: res.model, prompt, ratio, aiLeft, aiCap: limits.total });
  }
  /* ── 주제 달력 — 기본값은 배포본(letter/calendar.json), 관리 웹에서 고치면 KV 가 이긴다 ── */
  if (p === '/api/letter/admin/calendar' && method === 'GET') {
    const rec = store.getCalendar ? await store.getCalendar() : null;
    return j(200, { calendar: rec && rec.calendar ? rec.calendar : CALENDAR_DEFAULT, updatedAt: rec ? rec.updatedAt || null : null, source: rec && rec.calendar ? 'kv' : 'default', rotation: L.rotationFor(L.weekId(now)) });
  }
  if (p === '/api/letter/admin/calendar' && method === 'PUT') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const errs = L.checkCalendar(b.calendar);
    if (errs.length) return j(400, { error: '달력 검증 실패 — 오류 ' + errs.length + '건', errors: errs });
    const rec = { calendar: b.calendar, updatedAt: nowIso(now) };
    await store.putCalendar(rec);
    return j(200, { ok: true, updatedAt: rec.updatedAt });
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
    const byTier = {}; L.TIER_IDS.forEach((t) => { byTier[t] = { total: 0, opened: 0, done: 0, days: 0 }; });
    const unopened = [], progress = [], writes = [];
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
        /* 하루 한 장 — 요일 7칸. 가족 링크로 읽은 것도 /parent/state 로 올라오므로 여기 잡힌다 */
        const days = []; for (let d = 1; d <= 7; d++) days.push(!!(r.days && r.days[d]));
        byTier[tt].days += days.filter(Boolean).length;
        const nWrite = Object.keys(r.write || {}).length;
        progress.push({ code: c, name: s.name, cls: s.cls || '', tier: tt, days, done: !!r.doneAt, writes: nWrite });
        /* 원장이 다음 호 '지난 호 독자의 답'에 실을 문장을 고를 수 있게 — 이름은 관리 화면에서만 보이고 지면에는 원장이 줄여 적는다 */
        Object.keys(r.write || {}).slice(0, 8).forEach((k) => { if (writes.length < 200) writes.push({ code: c, name: s.name, tier: tt, key: k, text: String(r.write[k]).slice(0, 300) }); });
        Object.keys(r.quiz || {}).forEach((k) => { const x = qIndex[k]; if (!x) return; x.row.n += 1; if (r.quiz[k] === x.answer) x.row.correct += 1; });
      } else unopened.push({ code: c, name: s.name, cls: s.cls || '', tier: tt });
    }
    progress.sort((a, b) => L.TIER_IDS.indexOf(a.tier) - L.TIER_IDS.indexOf(b.tier) || a.name.localeCompare(b.name, 'ko'));
    const total = Object.values(byTier).reduce((a, b) => a + b.total, 0), opened = Object.values(byTier).reduce((a, b) => a + b.opened, 0);
    return j(200, { stats: { id, total, opened, byTier, unopened, quiz, progress, writes } });
  }
  if (p === '/api/letter/admin/draft' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const part = String(b.part || '');
    if (!DRAFT_PARTS.includes(part)) return j(400, { error: 'part 는 shared·K·E1·E2·E3·M·news 중 하나' });
    const week = /^\d{4}-W\d{2}$/.test(String(b.week || '')) ? b.week : L.weekId(now);
    const calRec = store.getCalendar ? await store.getCalendar() : null;
    const entry = L.calendarEntry(calRec && calRec.calendar ? calRec.calendar : CALENDAR_DEFAULT, week);
    /* 주제·지표를 안 주면 주제 달력에서 가져온다 — 매주 할 일이 "주차 확인" 하나로 준다 */
    const theme = strMax(b.theme, 200).trim() || entry.theme;
    if (!theme && part !== 'news') return j(400, { error: '이번 주 주제(theme)가 필요해요 — 주제 달력에도 이 주차의 주제가 없어요.' });
    const publishAt = L.isValidDate(b.publishAt) ? b.publishAt : (L.weekStart(week) || today);
    const brainIndex = part === 'shared' ? (isObj(b.brainIndex) ? b.brainIndex : entry.indices) : (L.WISC[b.brainIndex] ? b.brainIndex : entry.indices[part]);
    const ai = ctx.ai || {};
    if (!ai.apiKey) return j(200, { ok: false, reason: 'no-key', part });
    const limits = readLetterAiLimit(ai.env);
    let useRec = store.getAiUse ? await store.getAiUse() : null;
    const quota = ai.quota || makeQuota({ rec: useRec, limits, now, onUse: (rec) => { useRec = rec; } });
    if (!quota.take()) return j(200, { ok: false, reason: 'quota', part, aiLeft: 0, aiCap: limits.total });
    const notes = [strMax(b.notes, 1000).trim(), entry.notes ? '달력 메모: ' + entry.notes : ''].filter(Boolean).join('\n');
    const res = await callDraft({ userPrompt: draftUserPrompt({ part, theme, week, publishAt, brainIndex, notes, today }), apiKey: ai.apiKey, model: ai.model, fetchImpl: ai.fetchImpl, webSearch: part === 'news' });
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

/* 퇴원 처리 — 학생 기록과 알림 구독(학생 기기·가족 링크)을 지운다. 호·사진·달력은 학생 것이 아니다 */
export async function dropStudentLetter(store, code, ptoken) {
  await store.deleteState(code);
  if (store.delPush) { await store.delPush('s:' + code); if (ptoken) await store.delPush('f:' + ptoken); }
}
/* 백업 — 호 본문은 원장이 쓴 것이라 통째로 담는다(내신 팩과 달리 라이선스 원문이 아니다). 학생 기록·달력·알림 구독도 담는다.
   사진 바이트는 담지 않는다(수 MB 씩이라 스냅샷이 부푼다) — 목록(메타)만 남겨 무엇이 있었는지는 알게 한다 */
export async function dumpLetter(store) {
  const issues = {}, states = {}, push = {};
  for (const r of await allIssues(store)) issues[r.issue.id] = r;
  for (const c of await store.listStateCodes()) { const st = await store.getState(c); if (st) states[c] = st; }
  if (store.listPushKeys) for (const k of await store.listPushKeys()) { const rec = await store.getPush(k); if (rec) push[k] = rec; }
  const calendar = store.getCalendar ? await store.getCalendar() : null;
  const images = store.listImages ? await store.listImages() : [];
  return { issues, states, push, calendar, images };
}
