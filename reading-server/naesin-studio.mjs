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
 */

import { extract, KINDS } from './naesin-extract.mjs';
/* 팩 검사 규칙은 브라우저·Node 공용 모듈(IIFE + module.exports 가드)이다. 정적 import 로
   가져온다 — createRequire 를 쓰면 Cloudflare Workers 번들이 'node:module' 을 찾다가
   배포 자체가 실패한다(nodejs_compat 이 없고, 있어도 런타임 require 는 번들러가 못 푼다).
   기본 import 는 Node 의 CJS 상호운용과 esbuild 양쪽에서 module.exports 를 그대로 준다. */
import CHECK from '../naesin/pack-check.js';

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
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const strMax = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arrayKeyOf = (kind) => (kind === 'items' ? 'items' : kind);

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

/* 초안을 하나의 팩으로 조립 — 버린 행은 빼고, 고친 행은 고친 값으로.
   조립 결과가 곧 배포될 팩이라 검사도 이것으로 한다. */
export function assemble(job) {
  const draft = isObj(job && job.draft) ? job.draft : {};
  const review = isObj(job && job.review) ? job.review : {};
  const meta = isObj(job && job.meta) ? job.meta : {};
  const pack = { packId: (job && job.packId) || '' };
  for (const k of ['curriculum', 'textbook', 'grade', 'lesson', 'lessonTitle', 'source']) {
    if (meta[k] != null && meta[k] !== '') pack[k] = meta[k];
  }
  for (const kind of Object.keys(draft)) {
    const rows = Array.isArray(draft[kind]) ? draft[kind] : null;
    if (!rows) continue;
    const kept = [];
    rows.forEach((row, i) => {
      const rv = review[rowKey(kind, row, i)];
      if (rv && rv.state === 'dropped') return;
      kept.push(rv && isObj(rv.patch) ? { ...row, ...rv.patch } : row);
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
    const rows = Array.isArray(draft[kind]) ? draft[kind] : [];
    rows.forEach((row, i) => {
      total += 1;
      const rv = review[rowKey(kind, row, i)];
      if (!rv || rv.state === 'pending') pending += 1;
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
      if (!rv || rv.state === 'pending') pending += 1;
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

  /* 추출 — 종류 하나씩. 워커의 CPU 시간 한도가 있어 한 번에 다 돌리지 않는다.
     실패해도 작업을 못 쓰게 만들지 않는다(status 를 failed 로 굳히지 않고 error 만 남긴다). */
  if (p === '/api/naesin/admin/job/extract' && method === 'POST') {
    const b = await body();
    const bad = badBody(b); if (bad) return bad;
    const job = await jobOf(strMax(b.jobId, 40));
    if (!job) return j(404, { error: '작업을 찾을 수 없어요.' });
    const kind = KINDS.includes(b.kind) ? b.kind : null;
    if (!kind) return j(400, { error: '추출 종류가 올바르지 않아요.' });
    const src = await store.getJobSrc(job.jobId);
    const text = (src && src.parts && src.parts[kind]) || '';
    if (!text.trim()) return j(400, { error: '그 종류의 원천 텍스트가 없어요.' });

    const ai = ctx.ai || {};
    const res = await extract({
      kind, text, apiKey: ai.apiKey, model: ai.model, fetchImpl: ai.fetchImpl, quota: ai.quota,
    });
    if (!res.ok) {
      job.error = kind + ' 추출 실패: ' + res.reason;
      job.updatedAt = nowIso();
      await store.putJob(job.jobId, job);
      return j(200, { ok: false, reason: res.reason, parts: res.parts || [], job: jobBrief(job) });
    }
    job.draft = isObj(job.draft) ? job.draft : {};
    job.draft[kind] = res.rows;
    for (const k of Object.keys(res.extra || {})) job.draft[k] = res.extra[k];
    /* 다시 추출하면 그 종류의 검수 상태는 버린다 — 옛 승인이 새 행에 붙으면 검수가 무의미해진다 */
    job.review = Object.fromEntries(Object.entries(isObj(job.review) ? job.review : {})
      .filter(([key]) => key.split(':')[0] !== kind));
    job.status = 'review';
    job.error = null;
    job.updatedAt = nowIso();
    const gate = publishGate(job);
    job.issues = gate.errors.concat(gate.warns);
    await store.putJob(job.jobId, job);
    return j(200, {
      ok: true, kind, count: res.rows.length, parts: res.parts, model: res.model,
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
    const src = isObj(b.draft) ? b.draft : null;
    if (!src) return j(400, { error: 'draft 객체가 필요해요.' });
    const next = {};
    for (const [k, v] of Object.entries(src)) {
      if (!Array.isArray(v) || !v.length) continue;
      next[k] = v;
    }
    if (!Object.keys(next).length) return j(400, { error: '넣을 행이 없어요.' });
    job.draft = { ...(isObj(job.draft) ? job.draft : {}), ...next };
    job.review = Object.fromEntries(Object.entries(isObj(job.review) ? job.review : {})
      .filter(([key]) => !Object.prototype.hasOwnProperty.call(next, key.split(':')[0])));
    job.status = 'review';
    job.error = null;
    job.updatedAt = nowIso();
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
    const entries = Array.isArray(b.rows) ? b.rows : [{ key: b.key, state: b.state, patch: b.patch, note: b.note }];
    const known = new Set();
    const draft = isObj(job.draft) ? job.draft : {};
    for (const kind of Object.keys(draft)) {
      (Array.isArray(draft[kind]) ? draft[kind] : []).forEach((row, i) => known.add(rowKey(kind, row, i)));
    }
    job.review = isObj(job.review) ? job.review : {};
    let hit = 0;
    for (const e of entries) {
      if (!isObj(e)) continue;
      const key = strMax(e.key, 80);
      if (!known.has(key)) continue;
      const state = REVIEW_STATES.includes(e.state) ? e.state : 'ok';
      const rec = { state, at: nowIso() };
      if (isObj(e.patch)) rec.patch = e.patch;
      if (typeof e.note === 'string' && e.note.trim()) rec.note = strMax(e.note, NOTE_MAX);
      job.review[key] = rec;
      hit += 1;
    }
    if (!hit) return j(400, { error: '검수할 행을 찾지 못했어요.' });
    job.updatedAt = nowIso();
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
    job.updatedAt = rec.updatedAt;
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
