'use strict';
/* WB 내신 — 팩 제작 스튜디오 (/api/naesin/admin/job/*).
 *
 * 왜: 팩 하나를 사람이 반나절에 만들면 다출판사 확장이 불가능하다. 초안을 AI가 만들고
 * 사람은 자동 대조가 잡은 행만 검수해 배포하는 흐름으로 바꾼다.
 *
 * 배포 검사는 naesin/pack-check.js 의 checkPack 을 그대로 쓴다 — 규칙을 복제하면
 * CLI 검증기와 판정이 갈라져 "검증기는 통과인데 배포가 막히는" 일이 생긴다.
 *
 * 라이선스: 원천 텍스트와 초안은 구매 자료에서 나온 것이라 저장소에 남지 않는다.
 * 작업 저장소(KV naesin:job:*, naesin:jobsrc:*)에만 있고 작업을 지우면 원천도 함께 지운다.
 *
 * ctx 는 naesin-api.mjs 의 handleNaesin 과 같은 모양이다:
 *   { path, method, who, query, getBody, store, now?, ai? }
 * store (호스트가 KV/로컬로 구현):
 *   getJob(jobId) → rec|null            putJob(jobId, rec)        deleteJob(jobId)
 *   listJobs() → [rec]                  // 원천 본문은 담지 않는다
 *   getJobSrc(jobId) → {parts:{[kind]:string}}|null
 *   putJobSrc(jobId, rec)               deleteJobSrc(jobId)
 *   getPack(id) putPack(id, rec) getPackIds() putPackIds(ids)   // 배포용(naesin-api 와 같은 어댑터)
 *   getAiUse() putAiUse(rec)            // 팩 제작 AI 추출의 하루 장부 {day, count} (§13-8)
 */

import { extract, makeQuota, readExtractLimit, KINDS } from './naesin-extract.mjs';
/* 팩 검사 규칙은 브라우저·Node 공용 모듈(IIFE + module.exports 가드)이다. 정적 import 로
   가져온다 — createRequire 를 쓰면 Cloudflare Workers 번들이 'node:module' 을 찾다가
   배포 자체가 실패한다(nodejs_compat 이 없고, 있어도 런타임 require 는 번들러가 못 푼다).
   기본 import 는 Node 의 CJS 상호운용과 esbuild 양쪽에서 module.exports 를 그대로 준다. */
import CHECK from '../naesin/pack-check.js';
import GEN from '../naesin/gen.js';
import COVERAGE from '../naesin/coverage.js';
import { handleNaesin } from './naesin-api.mjs';

const PACK_ID_RE = /^[A-Za-z0-9-]{3,60}$/;
const JOB_ID_RE = /^job-[a-z0-9]{6,20}$/;
const SRC_MAX_CHARS = 400_000;      // 원천 한 종류 상한 — 과 단위 자료는 이보다 짧다
const SRC_KINDS_MAX = 6;
const NAME_MAX = 60;
const NOTE_MAX = 200;
const JOBS_MAX = 60;                // 동시에 굴리는 작업 수 — 넘으면 오래된 완료 작업을 지우게 안내한다
export const JOB_STATUS = ['draft', 'review', 'ready', 'published', 'failed'];
export const REVIEW_STATES = ['pending', 'ok', 'fixed', 'dropped'];

const nowIso = () => new Date().toISOString();
const nextJobVersion = (job) => new Date(Math.max(Date.now(), (Date.parse(job && job.updatedAt) || 0) + 1)).toISOString();
// shortcut: KV 읽기/쓰기는 원자적이지 않다. PC 정본의 원행 버전을 확인하며, 다중 서버 쓰기는 직렬화가 필요하다.
const staleJob = (b, job) => Object.prototype.hasOwnProperty.call(b, 'baseUpdatedAt') && b.baseUpdatedAt !== (job.updatedAt || null);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const strMax = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arrayKeyOf = (kind) => (kind === 'items' ? 'items' : kind);
const DRAFT_KINDS = CHECK.PACK_ARRAYS;
const PDF_ROW_KEYS = {
  words: ['id', 'headword', 'pos', 'meaningKo', 'sections', 'irregularForms', 'senses', 'notes', '_pdfReview'],
  sentences: ['seq', 'dayGroup', 'dayHeaderEn', 'dayHeaderKo', 'en', 'ko', 'chunks', 'keywords', 'tokens', 'verbForms', 'grammarChoices', 'writingKeywords', 'wordIds', 'grammarNotes', 'notes', '_pdfReview'],
  dialogues: ['id', 'title', 'section', 'lines', 'notes', '_pdfReview'],
  functions: ['name', 'pattern', 'explainKo', '_pdfReview'],
  keyExpressions: ['en', 'ko', 'blankAnswer', '_pdfReview'],
  patterns: ['patternNo', 'title', 'conceptKo', 'grammarPoint', 'textbookExamples', 'letsUseIt', 'notes', '_pdfReview'],
  items: ['id', 'no', 'footnoteNo', 'source', 'section', 'formatType', 'instructionKo', 'isNegative', 'answerCount', 'stimulus', 'choices', 'answer', 'explanationKo', 'targetRefs', 'notes', '_pdfReview'],
};
const ownKeys = (v, keys) => isObj(v) && Object.keys(v).every((k) => keys.includes(k));
function validPdfReview(v) {
  return ownKeys(v, ['flags', 'locations'])
    && Array.isArray(v.flags) && v.flags.length <= 100 && v.flags.every((f) => typeof f === 'string' && f.length <= 200)
    && Array.isArray(v.locations) && v.locations.length <= 100 && v.locations.every((loc) =>
      ownKeys(loc, ['page', 'bbox', 'sourceDocumentId', 'printedPage', 'section', 'questionNo', 'libraryId', 'librarySha256']) && Number.isInteger(loc.page) && loc.page > 0 && loc.page <= 1_000_000
      && (loc.libraryId === undefined || /^src-\d{6}$/.test(loc.libraryId))
      && (loc.librarySha256 === undefined || loc.libraryId !== undefined && /^[a-f0-9]{64}$/.test(loc.librarySha256))
      && Array.isArray(loc.bbox) && loc.bbox.length === 4 && loc.bbox.every((n) => Number.isFinite(n) && n >= 0)
      && loc.bbox[0] <= loc.bbox[2] && loc.bbox[1] <= loc.bbox[3]
      && (loc.sourceDocumentId === undefined || /^(?:00|01|02|03|04s|04t|05s|05t|06s|06t|07|08|09)$/.test(loc.sourceDocumentId))
      && (loc.printedPage === undefined || Number.isInteger(loc.printedPage) && loc.printedPage > 0)
      && (loc.section === undefined || loc.section === null || typeof loc.section === 'string' && loc.section.length <= 120)
      && (loc.questionNo === undefined || loc.questionNo === null || Number.isInteger(loc.questionNo) && loc.questionNo > 0));
}
function validPdfSenses(senses, meanings) {
  if (senses === null) return true;
  const keys = ['senseNo', 'pos', 'meaningKo', 'example'];
  if (!Array.isArray(senses) || senses.length > 3 || senses.some((sense, i) => !isObj(sense)
    || Object.keys(sense).length !== keys.length || Object.keys(sense).some((key) => !keys.includes(key))
    || !keys.every((key) => Object.prototype.hasOwnProperty.call(sense, key))
    || !Number.isInteger(sense.senseNo) || sense.senseNo !== i + 1 || sense.senseNo > 3
    || typeof sense.pos !== 'string' || sense.pos.length > 20
    || !CHECK.nonEmpty(sense.meaningKo) || sense.meaningKo.length > 1200
    || !isObj(sense.example) || Object.keys(sense.example).length !== 2
    || !Object.prototype.hasOwnProperty.call(sense.example, 'en') || !Object.prototype.hasOwnProperty.call(sense.example, 'ko')
    || !CHECK.nonEmpty(sense.example.en) || sense.example.en.length > 1200
    || !CHECK.nonEmpty(sense.example.ko) || sense.example.ko.length > 1200)) return false;
  return senses.length === 0 || Array.isArray(meanings) && JSON.stringify(meanings) === JSON.stringify(senses.map((sense) => sense.meaningKo));
}
function validPdfSentence(row, allowUnresolved = false) {
  const emptyChunks = Array.isArray(row && row.chunks) && row.chunks.length === 0;
  return isObj(row) && Number.isInteger(row.seq) && row.seq > 0
    && ['dayGroup', 'en', 'ko'].every((k) => CHECK.nonEmpty(row[k]))
    && Array.isArray(row.chunks) && (row.chunks.length >= 1 || (allowUnresolved && emptyChunks && row._pdfReview))
    && row.chunks.every((chunk) => ownKeys(chunk, ['en', 'ko']) && CHECK.nonEmpty(chunk.en) && CHECK.nonEmpty(chunk.ko))
    && ['dayHeaderEn', 'dayHeaderKo'].every((k) => row[k] === undefined || typeof row[k] === 'string')
    && (row.keywords === undefined || (Array.isArray(row.keywords)
      && row.keywords.every((kw) => ownKeys(kw, ['en', 'ko']) && CHECK.nonEmpty(kw.en) && CHECK.nonEmpty(kw.ko))))
    && ['tokens', 'writingKeywords', 'wordIds', 'notes'].every((k) => row[k] === undefined || (Array.isArray(row[k]) && row[k].every((v) => typeof v === 'string')))
    && (row.verbForms === undefined || (Array.isArray(row.verbForms) && row.verbForms.every((v) => ownKeys(v, ['base', 'answer']) && typeof v.base === 'string' && typeof v.answer === 'string')))
    && (row.grammarChoices === undefined || (Array.isArray(row.grammarChoices) && row.grammarChoices.every((v) => ownKeys(v, ['options', 'answerIdx']) && Array.isArray(v.options) && v.options.every((x) => typeof x === 'string') && Number.isInteger(v.answerIdx))))
    && (row.grammarNotes === undefined || (Array.isArray(row.grammarNotes) && row.grammarNotes.every((v) => ownKeys(v, ['target', 'note']) && typeof v.target === 'string' && typeof v.note === 'string')))
    && (emptyChunks || CHECK.flat(row.chunks.map((chunk) => chunk.en).join(' ')) === CHECK.flat(row.en));
}

export function newJobId(rnd) {
  const r = rnd || Math.random;
  let s = '';
  while (s.length < 10) s += Math.floor(r() * 36 ** 6).toString(36);
  return 'job-' + s.slice(0, 10);
}

/* 검수 키 — 행 하나를 가리키는 안정된 이름. 배열 순서가 바뀌어도 같은 행을 가리켜야
   승인해 둔 것이 엉뚱한 행으로 옮겨가지 않는다. id·seq 가 있으면 그것을 쓴다. */
export function rowKey(kind, row, index) {
  const r = isObj(row) ? row : {};
  const own = r.id != null ? String(r.id)
    : r.seq != null ? 's' + r.seq
    : r.no != null ? 'n' + r.no
    : r.patternNo != null ? 'p' + r.patternNo
    : 'i' + index;
  return kind + ':' + own;
}
function reviewedRow(row, rv) {
  const value = rv && isObj(rv.patch) ? { ...row, ...rv.patch } : { ...row };
  /* 기존 편집 화면은 지운 키를 null로 보낸다. */
  if (rv && isObj(rv.patch)) for (const k of Object.keys(rv.patch)) if (rv.patch[k] === null) delete value[k];
  delete value._pdfReview;
  return value;
}
function rowKeyCounts(kind, rows) {
  const counts = new Map();
  rows.forEach((row, i) => { const key = rowKey(kind, row, i); counts.set(key, (counts.get(key) || 0) + 1); });
  return counts;
}

/* 초안을 하나의 팩으로 조립 — 버린 행은 빼고, 고친 행은 고친 값으로.
   조립 결과가 곧 배포될 팩이라 검사도 이것으로 한다. */
export function assemble(job) {
  const draft = isObj(job && job.draft) ? job.draft : {};
  const review = isObj(job && job.review) ? job.review : {};
  const meta = isObj(job && job.meta) ? job.meta : {};
  const pack = { packId: (job && job.packId) || '' };
  for (const k of ['curriculum', 'textbook', 'grade', 'lesson', 'lessonTitle', 'source', 'contentMode']) {
    if (meta[k] != null && meta[k] !== '') pack[k] = meta[k];
  }
  if (pack.contentMode === 'questions') { pack.words = pack.words || []; pack.sentences = pack.sentences || []; }
  pack.rights = meta.rights || null;
  for (const kind of Object.keys(draft)) {
    if (!DRAFT_KINDS.includes(kind)) continue;
    const rows = Array.isArray(draft[kind]) ? draft[kind] : null;
    if (!rows) continue;
    const kept = [];
    rows.forEach((row, i) => {
      const rv = review[rowKey(kind, row, i)];
      if (rv && rv.state === 'dropped') return;
      kept.push(reviewedRow(row, rv));
    });
    if (kept.length) pack[arrayKeyOf(kind)] = kept;
  }
  /* 문장 seq 는 순번이어야 검증기를 통과한다 — 버린 행 때문에 생긴 구멍을 메운다 */
  if (Array.isArray(pack.sentences)) pack.sentences = pack.sentences.map((s, i) => ({ ...s, seq: i + 1 }));
  return pack;
}

/* 배포 전 판정 — 검사기 오류 + 미검토 행. 화면의 「배포」 활성 조건과 같은 함수를 쓴다. */
export function publishGate(job) {
  const pack = assemble(job);
  const res = CHECK.checkPack(pack);
  const draft = isObj(job && job.draft) ? job.draft : {};
  const review = isObj(job && job.review) ? job.review : {};
  let pending = 0, total = 0;
  for (const kind of Object.keys(draft)) {
    if (!DRAFT_KINDS.includes(kind)) res.errors.push({ where: '(공통)', message: kind + ' 허용되지 않는 초안 종류' });
    const rows = Array.isArray(draft[kind]) ? draft[kind] : [];
    const originalKeys = rowKeyCounts(kind, rows), effectiveKeys = new Map();
    rows.forEach((row, i) => {
      const rv = review[rowKey(kind, row, i)];
      if (rv && rv.state === 'dropped') return;
      const key = rowKey(kind, reviewedRow(row, rv), i);
      effectiveKeys.set(key, (effectiveKeys.get(key) || 0) + 1);
    });
    let kept = 0;
    rows.forEach((row, i) => {
      total += 1;
      const rv = review[rowKey(kind, row, i)];
      const resolved = rv && ['ok', 'fixed', 'dropped'].includes(rv.state);
      if (!resolved) pending += 1;
      const pdf = isObj(row) && Object.prototype.hasOwnProperty.call(row, '_pdfReview');
      if (pdf && (originalKeys.get(rowKey(kind, row, i)) !== 1
        || (!(rv && rv.state === 'dropped') && effectiveKeys.get(rowKey(kind, reviewedRow(row, rv), i)) !== 1)))
        res.errors.push({ where: kind, message: kind + '[' + i + '] PDF 후보의 검수 키가 중복되어 개별 대조할 수 없음' });
      if (rv && rv.state === 'dropped') return;
      const at = kind + '[' + kept++ + ']';
      if (pdf) {
        if (!PDF_ROW_KEYS[kind] || !validPdfReview(row._pdfReview))
          res.errors.push({ where: kind, message: at + ' PDF 검수 메타 형태가 올바르지 않음' });
        if (kind === 'sentences') {
          const sentence = pack.sentences[kept - 1];
          if (!validPdfSentence(sentence))
            res.errors.push({ where: kind, message: at + ' PDF 본문은 영·한 문장과 대응하는 청크가 필요함' });
          else if (!sentence.keywords || !sentence.keywords.length || sentence.keywords.some((keyword) => {
            const single = { ...sentence, keywords: [keyword] };
            return !GEN.koBlanks(single, 0) || !GEN.keywordBlanks(single, 'en', 0);
          }))
            res.errors.push({ where: kind, message: at + ' PDF 본문의 1·3단계 문항을 만들 핵심어가 필요함 — 영어 원문과 청크 한글에서 en/ko 쌍을 대조하세요.' });
        }
        if (!resolved)
          res.warns.push({ where: kind, message: at + ' PDF 후보 — 원본 위치를 대조해 개별 검수해야 함' });
      }
    });
  }
  return {
    ok: res.errors.length === 0 && pending === 0 && total > 0,
    errors: res.errors, warns: res.warns, summary: res.summary,
    pending, total, pack,
  };
}

/* 목록·조회용 — 초안 본문 대신 종류별 행 수와 검수 진행만 준다(목록이 수 MB가 되면 못 쓴다) */
export function jobBrief(job) {
  const draft = isObj(job.draft) ? job.draft : {};
  const review = isObj(job.review) ? job.review : {};
  const counts = {};
  let pending = 0, total = 0;
  for (const kind of Object.keys(draft)) {
    const rows = Array.isArray(draft[kind]) ? draft[kind] : [];
    counts[kind] = rows.length;
    rows.forEach((row, i) => {
      total += 1;
      const rv = review[rowKey(kind, row, i)];
      if (!rv || !['ok', 'fixed', 'dropped'].includes(rv.state)) pending += 1;
    });
  }
  return {
    jobId: job.jobId, packId: job.packId, meta: job.meta || {}, status: job.status,
    counts, pending, total,
    sources: Array.isArray(job.sources) ? job.sources : [],
    issueCount: Array.isArray(job.issues) ? job.issues.length : 0,
    error: job.error || null,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}

function rightsInputValid(r) {
  if (r == null) return true;
  if (!isObj(r)) return false;
  const allowed = ['basis','holder','evidenceRef','studentUseAllowed','derivativeUseAllowed','externalAiAllowed','expiresAt','notes'];
  if (Object.keys(r).some((k) => !allowed.includes(k))) return false;
  if (r.basis !== undefined && !['self_authored','open_license','licensed'].includes(r.basis)) return false;
  for (const k of ['holder','evidenceRef','expiresAt','notes']) if (r[k] !== undefined && typeof r[k] !== 'string') return false;
  for (const k of ['studentUseAllowed','derivativeUseAllowed','externalAiAllowed']) if (r[k] !== undefined && typeof r[k] !== 'boolean') return false;
  if ((r.holder || '').length > 120 || (r.evidenceRef || '').length > 300 || (r.expiresAt || '').length > 10 || (r.notes || '').length > 500) return false;
  return true;
}

function normalizeRights(r) {
  if (!isObj(r)) return null;
  return { basis: ['self_authored','open_license','licensed'].includes(r.basis) ? r.basis : '',
    holder: strMax(r.holder, 120), evidenceRef: strMax(r.evidenceRef, 300),
    studentUseAllowed: r.studentUseAllowed === true, derivativeUseAllowed: r.derivativeUseAllowed === true,
    externalAiAllowed: r.externalAiAllowed === true, expiresAt: strMax(r.expiresAt, 10), notes: strMax(r.notes, 500) };
}

function metaOf(b) {
  const m = isObj(b && b.meta) ? b.meta : {};
  const lesson = Number(m.lesson);
  return {
    curriculum: strMax(m.curriculum, NAME_MAX),
    textbook: strMax(m.textbook, NAME_MAX),
    grade: strMax(m.grade, NAME_MAX),
    lesson: Number.isFinite(lesson) ? Math.trunc(lesson) : null,
    lessonTitle: strMax(m.lessonTitle, NAME_MAX),
    source: strMax(m.source, NOTE_MAX),
    ...(m.contentMode === 'questions' ? {contentMode:'questions'} : {}),
    rights: normalizeRights(b.rights || m.rights),
  };
}

/* ── 라우터 ── */
/* 이 라우터가 맡는 경로 — 여기 없는 경로는 손대지 않고 null 을 돌려 다음 라우터로 넘긴다.
   경로를 보기 전에 권한을 검사하면 학생의 모든 요청이 여기서 403으로 끝난다. */
const STUDIO_PREFIX = '/api/naesin/admin/job';
export const isStudioPath = (p) => typeof p === 'string'
  && (p === STUDIO_PREFIX || p === '/api/naesin/admin/jobs' || p.startsWith(STUDIO_PREFIX + '/'));

export async function handleStudio(ctx) {
  const { path: p, method, who, store } = ctx;
  const j = (status, body) => ({ status, body });
  if (!isStudioPath(p)) return null;
  if (!who) return j(401, { error: '로그인이 필요합니다.' });
  if (!who.admin) return j(403, { error: '권한이 없습니다.' });

  const body = async () => { try { return await ctx.getBody(); } catch (e) { return null; } };
  const badBody = (b) => (isObj(b) ? null : j(400, { error: '올바른 JSON이 아니에요.' }));
  const jobOf = async (id) => (JOB_ID_RE.test(id) ? await store.getJob(id) : null);

  /* 작업 만들기 — 원천 텍스트를 종류별로 받아 둔다(추출은 종류마다 따로 돌린다) */
  if (p === '/api/naesin/admin/job' && method === 'POST') {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    if (b.rights !== undefined && !rightsInputValid(b.rights)) return j(400, { error: '권리 메타데이터 형식이 올바르지 않습니다.' });
    const packId = strMax(b.packId, 60);
    if (!PACK_ID_RE.test(packId)) return j(400, { error: '팩 id 규칙: 영문·숫자·하이픈 3~60자' });
    const list = (await store.listJobs()) || [];
    if (list.length >= JOBS_MAX) return j(409, { error: '작업이 너무 많아요. 끝난 작업을 지우고 다시 만드세요.' });
    const parts = {};
    const sources = [];
    const raw = Array.isArray(b.sources) ? b.sources.slice(0, SRC_KINDS_MAX) : [];
    for (const s of raw) {
      if (!isObj(s)) continue;
      const kind = KINDS.includes(s.kind) ? s.kind : null;
      const text = typeof s.text === 'string' ? s.text.slice(0, SRC_MAX_CHARS) : '';
      if (!kind || !text.trim()) continue;
      parts[kind] = parts[kind] ? parts[kind] + '\n\n' + text : text;
      sources.push({ name: strMax(s.name, NAME_MAX) || kind, kind, chars: text.length });
    }
    const jobId = newJobId(ctx.rnd);
    const rec = {
      jobId, packId, meta: metaOf(b), status: 'draft',
      sources, draft: {}, review: {}, issues: [], error: null,
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    await store.putJob(jobId, rec);
    if (Object.keys(parts).length) await store.putJobSrc(jobId, { parts });
    return j(200, { ok: true, jobId, job: jobBrief(rec) });
  }

  if (p === '/api/naesin/admin/jobs' && method === 'GET') {
    const list = ((await store.listJobs()) || []).filter(isObj).map(jobBrief);
    list.sort((a, b2) => String(b2.updatedAt).localeCompare(String(a.updatedAt)));
    return j(200, { jobs: list, time: nowIso() });
  }

  /* 작업 하나 — 초안과 검수 상태, 그리고 지금 판정(검사 오류·경고·미검토 수).
     원천은 요청할 때만 준다(?src=1) — 검수 화면이 좌측에 원문을 띄울 때만 필요하다. */
  if (p === '/api/naesin/admin/job' && method === 'GET') {
    const id = strMax((ctx.query && ctx.query.get('id')) || '', 40);
    const job = await jobOf(id);
    if (!job) return j(404, { error: '작업을 찾을 수 없어요.' });
    const gate = publishGate(job);
    const out = {
      job: { ...jobBrief(job), draft: job.draft || {}, review: job.review || {} },
      gate: { ok: gate.ok, errors: gate.errors, warns: gate.warns, summary: gate.summary, pending: gate.pending, total: gate.total },
    };
    if ((ctx.query && ctx.query.get('src')) === '1') {
      const src = await store.getJobSrc(id);
      out.sources = (src && src.parts) || {};
    }
    return j(200, out);
  }

  if (p === '/api/naesin/admin/job/rights' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const job = await jobOf(strMax(b.jobId, 40)); if (!job) return j(404, { error: '작업을 찾을 수 없어요.' });
    if (!rightsInputValid(b.rights)) return j(400, { error: '권리 메타데이터 형식이 올바르지 않습니다.' });
    job.meta = { ...(job.meta || {}), rights: normalizeRights(b.rights) };
    job.updatedAt = nextJobVersion(job); await store.putJob(job.jobId, job);
    const gate = publishGate(job); return j(200, { ok: true, job: jobBrief(job), gate: { ok: gate.ok, errors: gate.errors, warns: gate.warns } });
  }

  /* 추출 — 종류 하나씩. 워커의 CPU 시간 한도가 있어 한 번에 다 돌리지 않는다.
     실패해도 작업을 못 쓰게 만들지 않는다(status 를 failed 로 굳히지 않고 error 만 남긴다). */
  if (p === '/api/naesin/admin/job/extract' && method === 'POST') {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    const job = await jobOf(strMax(b.jobId, 40));
    if (!job) return j(404, { error: '작업을 찾을 수 없어요.' });
    const rights = job.meta && job.meta.rights;
    if (CHECK.rightsErrors(rights).length || rights.externalAiAllowed !== true)
      return j(400, { error: '권리 확인 또는 외부 AI 이용 허용이 없어 추출할 수 없습니다.' });
    const kind = KINDS.includes(b.kind) ? b.kind : null;
    if (!kind) return j(400, { error: '추출 종류가 올바르지 않아요.' });
    const src = await store.getJobSrc(job.jobId);
    const text = (src && src.parts && src.parts[kind]) || '';
    if (!text.trim()) return j(400, { error: '그 종류의 원천 텍스트가 없어요.' });

    /* 비용 한도(기획서 §13-8) — 호출 한 번마다 센다. 장부는 팩 제작 전용이라
       학생용 AI 한도와 서로를 먹지 않는다. 한도를 넘긴 구간은 res.parts 가 알린다. */
    const ai = ctx.ai || {};
    const limits = readExtractLimit(ai.env);
    let useRec = store.getAiUse ? await store.getAiUse() : null;
    const quota = ai.quota || makeQuota({
      rec: useRec, limits, now: ctx.now,
      onUse: (rec) => { useRec = rec; },
    });
    const res = await extract({
      kind, text, apiKey: ai.apiKey, model: ai.model, fetchImpl: ai.fetchImpl, quota,
    });
    /* 쓴 만큼은 성공·실패와 무관하게 남긴다 — 실패한 호출도 요금은 나간다 */
    if (store.putAiUse && useRec) await store.putAiUse(useRec);
    const aiLeft = typeof quota.left === 'function' ? quota.left() : null;
    if (!res.ok) {
      job.error = kind + ' 추출 실패: ' + res.reason;
      job.updatedAt = nextJobVersion(job);
      await store.putJob(job.jobId, job);
      return j(200, { ok: false, reason: res.reason, parts: res.parts || [], job: jobBrief(job), aiLeft, aiCap: limits.total });
    }
    job.draft = isObj(job.draft) ? job.draft : {};
    job.draft[kind] = res.rows;
    for (const k of Object.keys(res.extra || {})) job.draft[k] = res.extra[k];
    /* 다시 추출하면 그 종류의 검수 상태는 버린다 — 옛 승인이 새 행에 붙으면 검수가 무의미해진다 */
    job.review = Object.fromEntries(Object.entries(isObj(job.review) ? job.review : {})
      .filter(([key]) => key.split(':')[0] !== kind));
    job.status = 'review';
    job.error = null;
    job.updatedAt = nextJobVersion(job);
    const gate = publishGate(job);
    job.issues = gate.errors.concat(gate.warns);
    await store.putJob(job.jobId, job);
    return j(200, {
      ok: true, kind, count: res.rows.length, parts: res.parts, model: res.model,
      aiLeft, aiCap: limits.total,
      job: jobBrief(job),
      gate: { ok: gate.ok, errors: gate.errors, warns: gate.warns, summary: gate.summary, pending: gate.pending, total: gate.total },
    });
  }

  /* 초안 직접 넣기 — API 키가 없는 환경(또는 다른 도구로 만든 JSON)을 위한 길.
     이 경로가 없으면 키가 없는 원장은 스튜디오를 아예 못 쓴다. */
  if (p === '/api/naesin/admin/job/draft' && method === 'POST') {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    const job = await jobOf(strMax(b.jobId, 40));
    if (!job) return j(404, { error: '작업을 찾을 수 없어요.' });
    if (staleJob(b, job))
      return j(409, { error: '다른 곳에서 작업이 바뀌었어요. 최신 작업을 조회한 뒤 다시 넣으세요.' });
    const src = isObj(b.draft) ? b.draft : null;
    if (!src) return j(400, { error: 'draft 객체가 필요해요.' });
    const next = {};
    for (const [k, v] of Object.entries(src)) {
      if (!DRAFT_KINDS.includes(k)) return j(400, { error: '허용되지 않는 초안 종류: ' + k });
      if (!Array.isArray(v)) return j(400, { error: k + ' 초안은 배열이어야 해요.' });
      for (const row of v) {
        if (!isObj(row)) return j(400, { error: k + ' 행은 객체이어야 해요.' });
        if (!Object.prototype.hasOwnProperty.call(row, '_pdfReview')) continue;
        if (ctx.localPdfReview !== true) return j(403, { error: 'PDF 후보는 원내 PC에서만 검수할 수 있어요.' });
        if (!PDF_ROW_KEYS[k] || !ownKeys(row, PDF_ROW_KEYS[k]) || !validPdfReview(row._pdfReview)
          || (k === 'words' && row.senses !== undefined && !validPdfSenses(row.senses, row.meaningKo))
          || (k === 'items' && Object.prototype.hasOwnProperty.call(row, 'id') && (typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$/.test(row.id)))
          || (k === 'sentences' && !validPdfSentence(row, true)))
          return j(400, { error: 'PDF 후보의 필드·위치 정보가 올바르지 않아요.' });
      }
      const keys = rowKeyCounts(k, v);
      if (v.some((row, i) => Object.prototype.hasOwnProperty.call(row, '_pdfReview') && keys.get(rowKey(k, row, i)) !== 1))
        return j(400, { error: 'PDF 후보의 검수 키가 중복되어 개별 대조할 수 없어요.' });
      if (!v.length) continue;
      next[k] = v;
    }
    if (!Object.keys(next).length) return j(400, { error: '넣을 행이 없어요.' });
    /* 같은 원행만 옛 교정을 이어 쓴다 — 중복 키나 순번 fallback에는 승인을 옮기지 않는다. */
    const unchanged = new Set();
    for (const [kind, rows] of Object.entries(next)) {
      const originals = (list) => {
        const byKey = new Map();
        list.forEach((row, i) => {
          const r = isObj(row) ? row : {};
          const id = r.id != null ? r.id : r.seq != null ? r.seq : r.no != null ? r.no : r.patternNo;
          const stable = (typeof id === 'string' && id.trim()) || (typeof id === 'number' && Number.isFinite(id));
          const key = rowKey(kind, row, i);
          byKey.set(key, byKey.has(key) || !stable ? null : JSON.stringify(row));
        });
        return byKey;
      };
      const before = originals(Array.isArray(job.draft && job.draft[kind]) ? job.draft[kind] : []);
      for (const [key, original] of originals(rows))
        if (original !== null && before.get(key) === original) unchanged.add(key);
    }
    job.draft = { ...(isObj(job.draft) ? job.draft : {}), ...next };
    job.review = Object.fromEntries(Object.entries(isObj(job.review) ? job.review : {})
      .filter(([key]) => !Object.prototype.hasOwnProperty.call(next, key.split(':')[0]) || unchanged.has(key)));
    job.status = 'review';
    job.error = null;
    job.updatedAt = nextJobVersion(job);
    const gate = publishGate(job);
    job.issues = gate.errors.concat(gate.warns);
    await store.putJob(job.jobId, job);
    return j(200, {
      ok: true, job: jobBrief(job),
      gate: { ok: gate.ok, errors: gate.errors, warns: gate.warns, summary: gate.summary, pending: gate.pending, total: gate.total },
    });
  }

  /* 검수 — 행 하나를 승인·수정·버림. patch 가 오면 그 값으로 갈아 끼운다. */
  if (p === '/api/naesin/admin/job/review' && method === 'POST') {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    const job = await jobOf(strMax(b.jobId, 40));
    if (!job) return j(404, { error: '작업을 찾을 수 없어요.' });
    if (staleJob(b, job))
      return j(409, { error: '다른 곳에서 작업이 바뀌었어요. 최신 작업을 조회하고 원문을 대조한 뒤 다시 검수하세요.' });
    const entries = Array.isArray(b.rows) ? b.rows : [{ key: b.key, state: b.state, patch: b.patch, note: b.note }];
    const known = new Set();
    const draft = isObj(job.draft) ? job.draft : {};
    for (const kind of Object.keys(draft)) {
      (Array.isArray(draft[kind]) ? draft[kind] : []).forEach((row, i) => known.add(rowKey(kind, row, i)));
    }
    /* 뒤 행이 틀려도 앞 행의 교정본이 바뀌지 않도록 전체 요청을 먼저 검사한다. */
    for (const e of entries) {
      if (!isObj(e) || !known.has(strMax(e.key, 80))) continue;
      if (!REVIEW_STATES.includes(e.state)) return j(400, { error: '검수 상태가 올바르지 않아요.' });
      if (e.patch !== undefined && e.patch !== null && !isObj(e.patch))
        return j(400, { error: 'patch는 행 객체 또는 null이어야 해요.' });
      if (e.note !== undefined && typeof e.note !== 'string') return j(400, { error: '검수 메모는 문자열이어야 해요.' });
    }
    job.review = isObj(job.review) ? job.review : {};
    let hit = 0;
    for (const e of entries) {
      if (!isObj(e)) continue;
      const key = strMax(e.key, 80);
      if (!known.has(key)) continue;
      const state = e.state;
      const rec = { ...(isObj(job.review[key]) ? job.review[key] : {}), state, at: nowIso() };
      if (e.patch !== undefined) {
        if (isObj(e.patch)) rec.patch = { ...e.patch };
        else delete rec.patch;
      }
      /* 검수 위치는 원본 행에 고정한다 — 편집으로 개별 검수 경고를 우회하지 못한다. */
      if (isObj(rec.patch)) { rec.patch = { ...rec.patch }; delete rec.patch._pdfReview; }
      if (e.note !== undefined) {
        if (typeof e.note === 'string' && e.note.trim()) rec.note = strMax(e.note, NOTE_MAX);
        else delete rec.note;
      }
      job.review[key] = rec;
      hit += 1;
    }
    if (!hit) return j(400, { error: '검수할 행을 찾지 못했어요.' });
    job.updatedAt = nextJobVersion(job);
    const gate = publishGate(job);
    job.issues = gate.errors.concat(gate.warns);
    job.status = gate.ok ? 'ready' : 'review';
    await store.putJob(job.jobId, job);
    return j(200, {
      ok: true, applied: hit, job: jobBrief(job),
      gate: { ok: gate.ok, errors: gate.errors, warns: gate.warns, summary: gate.summary, pending: gate.pending, total: gate.total },
    });
  }

  /* 배포 — 검사기와 같은 판정을 통과했을 때만 팩 저장소로 넘긴다 */
  if (p === '/api/naesin/admin/job/publish-reviewed' && method === 'POST') {
    const b = await body(); const bad = badBody(b); if (bad) return bad;
    const job = await jobOf(strMax(b.jobId,40)); if (!job) return j(404,{error:'작업을 찾을 수 없어요.'});
    if (typeof b.baseUpdatedAt !== 'string' || staleJob(b,job)) return j(409,{error:'최신 검수 작업을 다시 읽고 게시하세요.'});
    const scope=strMax(b.scope,84),packId=job.packId+'-questions';
    if (!scope.startsWith('cls:') || COVERAGE.classScope(scope.slice(4))!==scope || !PACK_ID_RE.test(packId)) return j(400,{error:'반 배정 대상 또는 팩 id를 확인하세요.'});
    const reviews=job.review||{};
    const items=(job.draft.items||[]).flatMap((row,i)=>{const review=reviews[rowKey('items',row,i)];return review&&['ok','fixed'].includes(review.state)?[reviewedRow(row,review)]:[];});
    if (!items.length) return j(400,{error:'교사가 검수 완료한 문항이 없어요.'});
    const sentences=(job.draft.sentences||[]).flatMap((row,i)=>{const review=reviews[rowKey('sentences',row,i)];return review&&['ok','fixed'].includes(review.state)?[reviewedRow(row,review)]:[];});
    const pack=assemble({...job,packId,meta:{...job.meta,contentMode:'questions'},draft:{items,sentences},review:{}});
    const check=CHECK.checkPack(pack);if(check.errors.length)return j(400,{error:'검수 완료 문항에도 검사 오류가 남아 있어요.',errors:check.errors});
    const previous=await store.getExam(scope),packIds=[...new Set([...(previous&&previous.packIds||[]),packId])];
    if(packIds.length>20)return j(400,{error:'반에 배정된 팩이 20개를 넘습니다. 기존 범위를 먼저 정리하세요.'});
    const updatedAt=nowIso();await store.putPack(packId,{pack,updatedAt});
    const ids=(await store.getPackIds())||[];if(!ids.includes(packId))await store.putPackIds(ids.concat(packId));
    const assignment=previous&&previous.examDate?{examDate:previous.examDate,...(previous.wordDeadlineDays!=null?{wordDeadlineDays:previous.wordDeadlineDays}:{})}:{mode:'practice',examDate:''};
    const assigned=await handleNaesin({path:'/api/naesin/admin/exam',method:'POST',who,query:new URLSearchParams(),store,getBody:async()=>({scope,packIds,...assignment})});
    if(assigned.status!==200)return j(assigned.status,{error:'문항은 게시했지만 반 배정에 실패했어요. 배정 상태를 확인한 뒤 다시 시도하세요.',packId});
    job.updatedAt=nextJobVersion(job);await store.putJob(job.jobId,job);
    const remainingItems=(job.draft.items||[]).filter((row,i)=>!['ok','fixed','dropped'].includes((reviews[rowKey('items',row,i)]||{}).state)).length;
    return j(200,{ok:true,packId,scope,publishedItems:items.length,publishedSentences:sentences.length,remainingItems,updatedAt});
  }
  if (p === '/api/naesin/admin/job/publish' && method === 'POST') {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    const job = await jobOf(strMax(b.jobId, 40));
    if (!job) return j(404, { error: '작업을 찾을 수 없어요.' });
    const gate = publishGate(job);
    if (!gate.ok) {
      return j(400, {
        error: gate.total === 0 ? '초안이 비었어요.'
          : gate.errors.length ? '검사 오류가 남아 있어요.' : '검수하지 않은 행이 남아 있어요.',
        errors: gate.errors, warns: gate.warns, pending: gate.pending, total: gate.total,
      });
    }
    const rec = { pack: gate.pack, updatedAt: nowIso() };
    await store.putPack(job.packId, rec);
    const ids = (await store.getPackIds()) || [];
    if (!ids.includes(job.packId)) await store.putPackIds(ids.concat([job.packId]));
    job.status = 'published';
    job.publishedAt = rec.updatedAt;
    job.updatedAt = nextJobVersion(job);
    await store.putJob(job.jobId, job);
    return j(200, { ok: true, packId: job.packId, updatedAt: rec.updatedAt, summary: gate.summary, warns: gate.warns });
  }

  if (p === '/api/naesin/admin/job' && method === 'DELETE') {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    const id = strMax(b.jobId, 40);
    if (!JOB_ID_RE.test(id)) return j(400, { error: '작업 id가 올바르지 않아요.' });
    /* 원천은 구매 자료다 — 작업을 지우면 함께 지운다 */
    await store.deleteJob(id);
    await store.deleteJobSrc(id);
    return j(200, { ok: true, jobId: id });
  }

  return null;   /* 스튜디오 라우트가 아니면 호스트가 다음 라우터로 넘긴다 */
}
