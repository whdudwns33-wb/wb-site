'use strict';
/* WB 내신 — PDF에서 뽑은 원천 텍스트를 팩 JSON 초안으로 바꾸는 AI 추출.
 *
 * 왜: 학교마다 출판사가 달라 한 학기에 필요한 팩이 출판사 × 학년 × 과로 수십 개다.
 * 팩 하나를 사람이 반나절에 만들면 다출판사 확장이 불가능하다 — 초안을 AI가 만들고
 * 사람은 자동 대조가 잡은 행만 검수하는 구조로 바꾼다.
 *
 * 호출 규약은 vocab-api.mjs 의 aiMnemonic 을 그대로 따른다(같은 헤더·fallbacks·refusal 처리).
 * 실패는 예외를 던지지 않고 {ok:false, reason} 으로 돌린다 — 추출 실패가 작업을 못 쓰게
 * 만들면 안 되고, 화면이 구간별로 다시 시도할 수 있어야 한다.
 *
 * 라이선스: 원천 텍스트는 구매 자료다. 여기서 만든 것은 추출 결과(JSON)뿐이고
 * 원문을 응답·로그에 되돌려 담지 않는다.
 */

import { dayKey } from './ai-quota.mjs';

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5';
const MAX_TOKENS = 8000;

/* 종류별 원천 분할 크기(글자) — 한 번에 다 보내면 응답이 max_tokens 에서 잘려
   파싱이 실패하고, 너무 잘게 보내면 문맥이 끊겨 품질이 떨어진다. */
export const CHUNK_CHARS = { words: 6000, sentences: 8000, dialogues: 8000, patterns: 6000, items: 6000 };
export const KINDS = ['words', 'sentences', 'dialogues', 'patterns', 'items'];

/* 스키마는 naesin/pack-schema.md 가 정본이다 — 여기 적는 것은 그 요약이고,
   스키마가 바뀌면 이 문장도 함께 고쳐야 한다(검증기가 통과시키지 않으면 바로 드러난다). */
const SCHEMA_HINT = {
  words: `{"words":[{"id":"w-001","headword":"tide","pos":"n.","meaningKo":["밀물과 썰물"],"sections":["reading"],`
    + `"example":{"en":"...","ko":"..."}|null,"definition":{"en":"...","ko":"..."}|null,`
    + `"senses":[{"senseNo":1,"pos":"v.","meaningKo":"...","example":{"en":"...","ko":"..."}}]|null,`
    + `"synonyms":[],"antonyms":[],"irregularForms":["keep","kept","kept"]|null}]}`,
  sentences: `{"sentences":[{"seq":1,"dayGroup":"8/1","dayHeaderEn":"...","dayHeaderKo":"...","en":"...","ko":"...",`
    + `"keywords":[{"en":"tide","ko":"조수"}],"tokens":["Last summer,","my family"],`
    + `"chunks":[{"en":"Last summer,","ko":"지난 여름,"}],"grammarNotes":[{"target":"After","note":"..."}],`
    + `"verbForms":[{"base":"arrive","answer":"arrived"}],"grammarChoices":[{"options":["a","b"],"answerIdx":1}],`
    + `"writingKeywords":["finally"]}]}`,
  dialogues: `{"dialogues":[{"id":"d-1","section":"Listen & Speak","lines":[{"speaker":"A","en":"...","ko":"..."}]}],`
    + `"keyExpressions":[{"en":"...","ko":"..."}],"vocabSidebar":[{"en":"...","ko":"..."}],"readingQA":[{"q":"...","a":"..."}]}`,
  patterns: `{"patterns":[{"patternNo":1,"title":"지각동사+목적어+v-ing","conceptKo":"...","textbookExamples":["..."]}]}`,
  items: `{"items":[{"no":1,"formatType":"mcq","promptKo":"...","stem":"...","choices":[{"label":"1","text":"..."}],`
    + `"answer":["1"],"answerCount":1,"explanationKo":"..."}]}`,
};

const SYSTEM = `너는 한국 중학교 영어 내신 교재를 구조화하는 데이터 추출기다.
주어진 교재 원천 텍스트에서 요청받은 종류만 뽑아 JSON 하나로 돌려준다.

규칙:
- 출력은 JSON 객체 하나뿐이다. 설명·머리말·코드펜스를 붙이지 않는다.
- 원문에 있는 것만 옮긴다. 없는 값은 null 또는 빈 배열로 두고 지어내지 않는다.
- 원문의 오탈자는 고치지 않고 그대로 옮긴다(교정은 사람이 검수 화면에서 한다).
- 영어 문장의 대소문자·구두점은 인쇄된 그대로 유지한다.
- chunks 를 만들 때는 조각을 공백으로 이어 붙이면 그 문장의 en 과 정확히 같아야 한다.
- chunks 의 ko 는 직독직해(끊어읽기) 순서 해석이다 — 문장 단위의 매끄러운 번역이 아니다.
- 한 조각(part)만 받았으면 그 조각에 있는 것만 뽑는다. seq·id 는 이어지는 번호를 쓴다.`;

function userPrompt(kind, text, part, parts, startIndex) {
  return [
    '종류: ' + kind,
    '스키마: ' + SCHEMA_HINT[kind],
    parts > 1 ? `이 원천은 ${parts}조각으로 나뉘어 있고 지금은 ${part}/${parts} 조각이다. 이어지는 번호는 ${startIndex + 1}부터 쓴다.` : null,
    '',
    '--- 원천 시작 ---',
    text,
    '--- 원천 끝 ---',
  ].filter((x) => x != null).join('\n');
}

/* 모델이 코드펜스나 앞말을 붙이는 경우가 있어 첫 { 부터 마지막 } 까지만 떼어 파싱한다 */
export function parseJsonBlock(text) {
  if (typeof text !== 'string') return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch (err) { return null; }
}

/* 원천을 조각으로 나눈다 — 줄 경계에서만 자른다(문장 중간에서 자르면 그 문장이 통째로 어긋난다) */
export function splitSource(text, limit) {
  const src = String(text == null ? '' : text);
  if (src.length <= limit) return [src];
  const lines = src.split('\n');
  const out = [];
  let buf = '';
  for (const ln of lines) {
    if (buf && buf.length + ln.length + 1 > limit) { out.push(buf); buf = ''; }
    buf = buf ? buf + '\n' + ln : ln;
  }
  if (buf) out.push(buf);
  return out;
}

const arrayKeyOf = (kind) => (kind === 'items' ? 'items' : kind);

/* 한 조각을 모델에 보낸다. fetchImpl 은 테스트가 갈아 끼운다(실제 호출 금지). */
async function callOnce({ kind, text, part, parts, startIndex, apiKey, model, fetchImpl }) {
  const f = fetchImpl || fetch;
  let r;
  try {
    r = await f(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        fallbacks: 'default',
        system: SYSTEM,
        messages: [{ role: 'user', content: userPrompt(kind, text, part, parts, startIndex) }],
      }),
    });
  } catch (e) { return { ok: false, reason: 'network' }; }
  if (!r || !r.ok) return { ok: false, reason: 'api-' + ((r && r.status) || 0) };
  let d;
  try { d = await r.json(); } catch (e) { return { ok: false, reason: 'parse' }; }
  if (d && d.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
  const out = (d && Array.isArray(d.content) ? d.content : [])
    .filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  const obj = parseJsonBlock(out);
  if (!obj) return { ok: false, reason: 'parse' };
  const key = arrayKeyOf(kind);
  const rows = Array.isArray(obj[key]) ? obj[key] : null;
  if (!rows) return { ok: false, reason: 'shape' };
  /* 대화문·문항은 배열 하나가 아니라 곁가지 배열(keyExpressions 등)도 함께 온다 */
  const extra = {};
  for (const k of Object.keys(obj)) if (k !== key && Array.isArray(obj[k])) extra[k] = obj[k];
  return { ok: true, rows, extra, model: (d && d.model) || null };
}

/* ── 공개 API ──
   extract({kind, text, apiKey, model, fetchImpl, quota}) →
     {ok:true, kind, rows, extra, parts:[{part, ok, count, reason?}], model}
     {ok:false, reason:'no-key'|'bad-kind'|'empty'|'quota'|'network'|'api-<n>'|'refused'|'parse'|'shape'}
   부분 실패는 성공분을 유지한다 — 조각 하나가 실패해도 나머지는 초안에 들어가고
   화면이 실패 구간만 다시 시도한다(전부 버리면 긴 원천은 영영 못 넘어간다). */
export async function extract({ kind, text, apiKey, model, fetchImpl, quota }) {
  if (!KINDS.includes(kind)) return { ok: false, reason: 'bad-kind' };
  if (!apiKey) return { ok: false, reason: 'no-key' };
  const src = String(text == null ? '' : text).trim();
  if (!src) return { ok: false, reason: 'empty' };
  const parts = splitSource(src, CHUNK_CHARS[kind] || 6000);
  /* 비용 거버넌스(기획서 §13-8) — 한도는 '추출 한 번'이 아니라 'API 호출 한 번'마다 센다.
     원천이 길면 조각 수만큼 부르므로, 앞에서 한 번만 세면 한도가 실제 비용의 몇 분의 일만
     막는다. 첫 조각도 못 부르면 그건 실패다. */
  const take = () => !quota || typeof quota.take !== 'function' || quota.take();
  if (!take()) return { ok: false, reason: 'quota' };
  const rows = [];
  const extra = {};
  const report = [];
  let usedModel = null;
  let anyOk = false;
  for (let i = 0; i < parts.length; i += 1) {
    /* 첫 조각 자리는 위에서 잡았다 — 두 번째부터 조각마다 새로 잡는다 */
    if (i > 0 && !take()) {
      report.push({ part: i + 1, ok: false, count: 0, reason: 'quota' });
      continue;
    }
    const res = await callOnce({
      kind, text: parts[i], part: i + 1, parts: parts.length,
      startIndex: rows.length, apiKey, model, fetchImpl,
    });
    if (res.ok) {
      anyOk = true;
      usedModel = usedModel || res.model;
      rows.push(...res.rows);
      for (const k of Object.keys(res.extra || {})) extra[k] = (extra[k] || []).concat(res.extra[k]);
      report.push({ part: i + 1, ok: true, count: res.rows.length });
    } else {
      report.push({ part: i + 1, ok: false, count: 0, reason: res.reason });
    }
  }
  /* 한 조각도 못 넘겼으면 실패다 — 첫 조각의 이유를 그대로 올려 화면이 원인을 말할 수 있게 */
  if (!anyOk) return { ok: false, reason: (report[0] && report[0].reason) || 'parse', parts: report };
  return { ok: true, kind, rows, extra, parts: report, model: usedModel };
}

/* ai-quota 의 일일 한도를 추출에 쓰는 어댑터.
   store 는 {get(), put(rec)} — 호스트가 KV/로컬 어느 쪽이든 같은 모양으로 넘긴다. */
export function makeQuota({ rec, limits, now, onUse }) {
  const day = dayKey(now == null ? Date.now() : now);
  /* 날짜가 바뀌면 저절로 0에서 시작한다 — 호스트 두 곳이 각자 날짜를 다루면 한쪽이 틀린다 */
  const already = (rec && rec.day === day && Number(rec.count)) || 0;
  const cap = (limits && limits.total) || 0;
  let used = 0;
  return {
    day,
    left: () => (cap ? Math.max(0, cap - already - used) : null),
    take() {
      if (cap && already + used + 1 > cap) return false;
      used += 1;
      if (typeof onUse === 'function') onUse({ day, count: already + used }, now);
      return true;
    },
    used: () => used,
  };
}

/* 팩 제작 추출의 하루 한도 (기획서 §13-8).
   비용 근거: 조각 하나가 대략 입력 5천·출력 5천 토큰이고 Opus 5 기준 $5/$25 per 1M 이라
   호출 한 번이 약 $0.15(=200원 안팎). 과 하나를 만드는 데 종류별 조각을 합쳐 10~15회쯤 부르므로
   팩 하나가 대략 $2(3천원 아래). 기본 한도 80회는 하루 대여섯 과를 만들 수 있고, 잘못된 반복
   호출이 있어도 그날 손실이 $12 선에서 멈춘다. NAESIN_AI_DAILY 로 올리거나 내릴 수 있다. */
export const EXTRACT_QUOTA_DEFAULT = 80;
export function readExtractLimit(env) {
  const n = Number((env || {}).NAESIN_AI_DAILY);
  return { total: Number.isFinite(n) && n > 0 ? Math.floor(n) : EXTRACT_QUOTA_DEFAULT };
}
