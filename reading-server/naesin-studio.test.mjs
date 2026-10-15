/* naesin-studio.mjs 검증 — 배포 판정이 CLI 검증기와 같아야 한다.
   실행: node reading-server/naesin-studio.test.mjs */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  handleStudio, assemble, publishGate, rowKey, jobBrief, newJobId, isStudioPath, JOB_STATUS, REVIEW_STATES,
} from './naesin-studio.mjs';

const require = createRequire(import.meta.url);
const CHECK = require('../naesin/pack-check.js');
const GEN = require('../naesin/gen.js');
const SAMPLE = require('../naesin/pack-sample.json');

let n = 0;
const t = async (name, fn) => { await fn(); n += 1; console.log('  ✓ ' + name); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const WHO = { code: '__admin__', admin: true };

/* 호스트 저장소를 메모리로 흉내낸다 — 워커 KV·로컬 db 어느 쪽이든 같은 모양이다 */
function memStore() {
  const jobs = new Map(), src = new Map(), packs = new Map();
  let ids = [];
  let aiUse = null;
  return {
    jobs, src, packs,
    getAiUse: async () => aiUse,
    putAiUse: async (rec) => { aiUse = rec; },
    peekAiUse: () => aiUse,
    getJob: async (id) => jobs.get(id) || null,
    putJob: async (id, rec) => { jobs.set(id, rec); },
    deleteJob: async (id) => { jobs.delete(id); },
    listJobs: async () => [...jobs.values()],
    getJobSrc: async (id) => src.get(id) || null,
    putJobSrc: async (id, rec) => { src.set(id, rec); },
    deleteJobSrc: async (id) => { src.delete(id); },
    getPack: async (id) => packs.get(id) || null,
    putPack: async (id, rec) => { packs.set(id, rec); },
    getPackIds: async () => ids,
    putPackIds: async (v) => { ids = v; },
  };
}
const call = (store, path, method, body, opts = {}) => handleStudio({
  path, method, who: opts.who === undefined ? WHO : opts.who, store,
  query: new URLSearchParams(opts.query || ''),
  getBody: async () => path === '/api/naesin/admin/job' && method === 'POST' && !opts.noRights
    ? { ...body, rights: body && body.rights || { basis: 'self_authored', holder: 'Synthetic test fixture', evidenceRef: 'fixture-only', studentUseAllowed: true, derivativeUseAllowed: true, externalAiAllowed: true } }
    : body,
  ai: opts.ai, rnd: opts.rnd, localPdfReview: opts.localPdfReview,
});

/* 샘플 팩을 초안 형태로 — 자체 창작 팩만 픽스처로 쓴다(라이선스 자료 금지) */
function draftFromSample() {
  const p = clone(SAMPLE);
  return {
    words: p.words, sentences: p.sentences, oddOneItems: p.oddOneItems,
    checkItems: p.checkItems, dialogues: p.dialogues, patterns: p.patterns, items: p.items,
  };
}
function approveAll(job) {
  job.review = {};
  for (const kind of Object.keys(job.draft)) {
    job.draft[kind].forEach((row, i) => { job.review[rowKey(kind, row, i)] = { state: 'ok', at: 'x' }; });
  }
}
await t('문제 전용 PDF 팩은 개별 교사 검수 후에만 게시하고 원본 위치는 학생 팩에서 제거한다',async()=>{
  const s=memStore();
  const cr=await call(s,'/api/naesin/admin/job','POST',{packId:'own-question-only',meta:{contentMode:'questions'}});
  const item={...clone(SAMPLE.items[0]),id:'own-question-1',_pdfReview:{flags:['REVIEW_REQUIRED'],locations:[{libraryId:'src-000001',page:1,bbox:[30,45,300,800]}]}};
  const body={jobId:cr.body.jobId,draft:{items:[item]}};
  assert.equal((await call(s,'/api/naesin/admin/job/draft','POST',body)).status,403);
  assert.equal((await call(s,'/api/naesin/admin/job/draft','POST',body,{localPdfReview:true})).status,200);
  assert.equal((await call(s,'/api/naesin/admin/job/publish','POST',{jobId:cr.body.jobId})).status,400);
  const job=await s.getJob(cr.body.jobId);approveAll(job);await s.putJob(job.jobId,job);
  assert.equal((await call(s,'/api/naesin/admin/job/publish','POST',{jobId:job.jobId})).status,200);
  const pack=(await s.getPack(job.packId)).pack;
  assert.equal(pack.contentMode,'questions');assert.deepEqual(pack.words,[]);assert.deepEqual(pack.sentences,[]);
  assert.equal(pack.items.length,1);assert.ok(!JSON.stringify(pack).includes('libraryId'));
  const wrong=clone(job);wrong.review={};wrong.draft.items[0]._pdfReview.locations[0].libraryId='../file';
  assert.equal(publishGate(wrong).ok,false);
});
await t('검수 완료 문항만 게시·반 배정 — 미검토·버림 제외, 기존 범위·권리·버전 보호',async()=>{
  const s=memStore(),exams=new Map();s.getExam=async key=>exams.get(key)||null;s.putExam=async(key,value)=>exams.set(key,value);
  const rights={basis:'self_authored',holder:'Own fixture',evidenceRef:'Synthetic only',studentUseAllowed:true,derivativeUseAllowed:true,externalAiAllowed:false};
  await s.putPack('own-existing',{pack:{...clone(SAMPLE),packId:'own-existing'},updatedAt:'x'});
  exams.set('cls:월수금',{mode:'practice',examDate:'',packIds:['own-existing']});
  const cr=await call(s,'/api/naesin/admin/job','POST',{packId:'own-reviewed',rights,meta:{contentMode:'questions'}});
  const items=[1,2,3,4].map(i=>({id:'own-'+i,no:i,formatType:'short',instructionKo:'Own question '+i,choices:[],answer:['Own answer '+i],_pdfReview:{flags:['REVIEW_REQUIRED'],locations:[{libraryId:'src-000001',page:1,bbox:[30,45,300,800]}]}}));
  await call(s,'/api/naesin/admin/job/draft','POST',{jobId:cr.body.jobId,draft:{items}},{localPdfReview:true});
  let job=await s.getJob(cr.body.jobId);const oldVersion=job.updatedAt;
  const publish=body=>call(s,'/api/naesin/admin/job/publish-reviewed','POST',{jobId:job.jobId,baseUpdatedAt:job.updatedAt,scope:'cls:월수금',...body});
  assert.equal((await publish({})).status,400,'미검수 0문항은 게시 금지');
  await call(s,'/api/naesin/admin/job/review','POST',{jobId:job.jobId,baseUpdatedAt:job.updatedAt,rows:[{key:'items:own-1',state:'ok'},{key:'items:own-3',state:'dropped'},{key:'items:own-4',state:'fixed',patch:{answer:['Corrected own answer']}}]});
  job=await s.getJob(job.jobId);
  assert.equal((await publish({baseUpdatedAt:oldVersion})).status,409);
  assert.equal((await publish({scope:'default'})).status,400);
  const result=await publish({});assert.equal(result.status,200);assert.equal(result.body.publishedItems,2);assert.equal(result.body.remainingItems,1);
  const pack=(await s.getPack(result.body.packId)).pack;
  assert.deepEqual(pack.items.map(i=>i.id),['own-1','own-4']);assert.deepEqual(pack.items[1].answer,['Corrected own answer']);
  assert.ok(!JSON.stringify(pack).includes('libraryId'));assert.equal(pack.rights.externalAiAllowed,false);
  assert.deepEqual(exams.get('cls:월수금').packIds,['own-existing',result.body.packId]);assert.equal(exams.get('cls:월수금').mode,'practice');assert.equal(exams.get('cls:월수금').examDate,'');
  job=await s.getJob(job.jobId);
  job.draft.sentences=clone(SAMPLE.sentences.slice(0,2));job.draft.sentences.forEach(s=>{s._pdfReview={flags:['SOURCE_NUMBER_PAIRED'],locations:[{page:1,bbox:[30,45,300,800]}]};delete s.wordIds;});
  job.review['sentences:s1']={state:'ok'};await s.putJob(job.jobId,job);
  const combined=await publish({});assert.equal(combined.status,200);assert.equal(combined.body.publishedSentences,1);
  const combinedPack=(await s.getPack(result.body.packId)).pack;assert.equal(combinedPack.sentences.length,1);assert.ok(!combinedPack.sentences[0]._pdfReview);assert.equal(combinedPack.items.length,2);
  job=await s.getJob(job.jobId);const before=await s.getPack(result.body.packId);job.review['items:own-1'].patch={answer:[]};
  assert.equal((await publish({})).status,400);assert.deepEqual(await s.getPack(result.body.packId),before,'오류 문항이 기존 게시본을 덮으면 안 된다');
});
const pdfWord = () => {
  const w = SAMPLE.words[0];
  return { id: w.id, headword: w.headword, pos: w.pos, meaningKo: clone(w.meaningKo), sections: clone(w.sections),
    senses: [{ senseNo: 1, pos: w.pos || '', meaningKo: w.meaningKo[0], example: { en: 'A sample ' + w.headword + ' appears.', ko: '갈매기가 보인다.' } }],
    _pdfReview: { flags: ['원본 대조 필요'], locations: [{ page: 1, bbox: [10, 20, 30, 40] }] } };
};
const pdfSentence = () => ({ seq: 1, dayGroup: '1', en: 'A toy is blue.', ko: '장난감이 파랗다.',
  chunks: [{ en: 'A toy', ko: '장난감은' }, { en: 'is blue.', ko: '파랗다.' }],
  keywords: [{ en: 'blue', ko: '파랗다' }],
  _pdfReview: { flags: ['REVIEW_REQUIRED', 'TEACHER_PAIRED'], locations: [{ page: 1, bbox: [40, 100, 365, 130] }, { page: 1, bbox: [370, 100, 560, 130] }] } });
const unannotatedPdfSentence = () => { const row = pdfSentence(); delete row.keywords; return row; };

console.log('naesin-studio — 팩 제작 스튜디오');

await t('인증·권한 — 학생 토큰은 403, 없으면 401', async () => {
  const s = memStore();
  assert.strictEqual((await call(s, '/api/naesin/admin/jobs', 'GET', null, { who: null })).status, 401);
  assert.strictEqual((await call(s, '/api/naesin/admin/jobs', 'GET', null, { who: { code: 'st-1' } })).status, 403);
});

await t('스튜디오 경로가 아니면 권한을 보기 전에 null — 학생 요청을 가로채면 앱이 통째로 막힌다', async () => {
  const s = memStore();
  for (const [p, m] of [['/api/naesin/state', 'GET'], ['/api/naesin/pack', 'GET'], ['/api/naesin/report', 'POST'],
    ['/api/naesin/admin/pack', 'POST'], ['/api/naesin/admin/exam', 'POST'], ['/api/naesin/admin/reports', 'GET']]) {
    assert.strictEqual(await call(s, p, m, null, { who: { code: 'st-1' } }), null, p + ' 를 가로채면 안 된다');
    assert.strictEqual(await call(s, p, m, null, { who: null }), null, p + ' 는 비인증도 넘겨야 한다');
  }
  /* 자기 경로는 확실히 잡는다 */
  assert.ok(isStudioPath('/api/naesin/admin/job'));
  assert.ok(isStudioPath('/api/naesin/admin/jobs'));
  assert.ok(isStudioPath('/api/naesin/admin/job/publish'));
  assert.ok(!isStudioPath('/api/naesin/admin/jobzzz'));
  assert.ok(!isStudioPath(undefined));
});

await t('작업 만들기 — 팩 id 규칙과 원천 종류를 검사한다', async () => {
  const s = memStore();
  assert.strictEqual((await call(s, '/api/naesin/admin/job', 'POST', { packId: 'ab' })).status, 400);
  const r = await call(s, '/api/naesin/admin/job', 'POST', {
    packId: '2022-ne-test-m2-L6',
    meta: { textbook: 'NE능률', grade: '중2', lesson: 6, lessonTitle: 'Sea' },
    sources: [{ name: 'words.txt', kind: 'words', text: '원천 A' }, { name: 'x', kind: 'zzz', text: '버려짐' }],
  });
  assert.strictEqual(r.status, 200);
  assert.ok(/^job-[a-z0-9]{6,20}$/.test(r.body.jobId), r.body.jobId);
  assert.strictEqual(r.body.job.sources.length, 1, '모르는 종류는 버린다');
  assert.strictEqual(r.body.job.status, 'draft');
  assert.strictEqual(r.body.job.meta.lesson, 6);
  const src = await s.getJobSrc(r.body.jobId);
  assert.strictEqual(src.parts.words, '원천 A');
  for (const rights of [{ ...r.body.job.meta.rights, forged: 'extra' }, { ...r.body.job.meta.rights, externalAiAllowed: 'false' }, { ...r.body.job.meta.rights, basis: 'purchased' }]) {
    const bad = await call(s, '/api/naesin/admin/job/rights', 'POST', { jobId: r.body.jobId, rights });
    assert.equal(bad.status, 400, '권리 메타의 추가 키·타입·열거값은 서버가 거절');
  }
});

await t('원천은 목록에 담기지 않는다(수 MB 조회 방지)', async () => {
  const s = memStore();
  const r = await call(s, '/api/naesin/admin/job', 'POST', {
    packId: '2022-ne-test-m2-L6', sources: [{ kind: 'words', text: 'x'.repeat(5000) }],
  });
  const list = await call(s, '/api/naesin/admin/jobs', 'GET', null);
  const brief = list.body.jobs[0];
  assert.strictEqual(JSON.stringify(brief).indexOf('xxxxx'), -1, '원천이 새어 나왔다');
  assert.strictEqual(brief.sources[0].chars, 5000, '길이는 알려 준다');
  assert.ok(r.body.ok);
});

await t('없는 작업은 404', async () => {
  const s = memStore();
  assert.strictEqual((await call(s, '/api/naesin/admin/job', 'GET', null, { query: 'id=job-nope00' })).status, 404);
  assert.strictEqual((await call(s, '/api/naesin/admin/job/extract', 'POST', { jobId: 'job-nope00', kind: 'words' })).status, 404);
});

await t('권리 미확인 작업은 추출 API 호출 전에 차단한다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: 'rights-test-m2-L1', sources: [{ kind: 'words', text: 'synthetic fixture' }] }, { noRights: true });
  let fetched = false;
  const r = await call(s, '/api/naesin/admin/job/extract', 'POST', { jobId: cr.body.jobId, kind: 'words' }, { ai: { apiKey: 'fake', fetchImpl: async () => { fetched = true; throw new Error('should not call'); } } });
  assert.equal(r.status, 400); assert.equal(fetched, false); assert.equal(r.body.error.includes('synthetic'), false);
  const blockedAiRights = { basis:'self_authored', holder:'Synthetic fixture', studentUseAllowed:true, derivativeUseAllowed:true, externalAiAllowed:false };
  const noAi = await call(s, '/api/naesin/admin/job', 'POST', { packId:'rights-noai-m2-L1', rights:blockedAiRights, sources:[{kind:'words',text:'synthetic'}] });
  let noAiFetch = false;
  const noAiResult = await call(s, '/api/naesin/admin/job/extract', 'POST', { jobId:noAi.body.jobId, kind:'words' }, { ai:{apiKey:'fake',fetchImpl:async()=>{noAiFetch=true;throw Error('blocked');}} });
  assert.equal(noAiResult.status,400); assert.equal(noAiFetch,false,'외부 AI 비허용은 호출 전 차단');
  const draft = await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: cr.body.jobId, draft: draftFromSample() });
  assert.equal(draft.status, 200);
  const job = await s.getJob(cr.body.jobId); approveAll(job); await s.putJob(job.jobId, job);
  const published = await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: job.jobId });
  assert.equal(published.status, 400); assert.equal(await s.getPack(job.packId), null, '미확인 권리의 배포 저장 금지');
  const expiredRights = { basis:'licensed', holder:'Synthetic fixture', evidenceRef:'contract-fixture', studentUseAllowed:true, derivativeUseAllowed:true, externalAiAllowed:true, expiresAt:'2000-01-01' };
  const expired = await call(s, '/api/naesin/admin/job', 'POST', { packId:'rights-expired-m2-L1', rights:expiredRights });
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId:expired.body.jobId, draft:draftFromSample() });
  const expiredJob=await s.getJob(expired.body.jobId); approveAll(expiredJob); await s.putJob(expiredJob.jobId,expiredJob);
  assert.equal((await call(s,'/api/naesin/admin/job/publish','POST',{jobId:expiredJob.jobId})).status,400,'만료 권리 증빙으로 발행 불가');
  assert.equal(await s.getPack(expiredJob.packId),null);
});

console.log('\\n== 추출 (fetch를 갈아 끼운다 — 실제 API 호출 금지)');

const fakeAi = (rows) => ({
  apiKey: 'k',
  fetchImpl: async () => ({
    ok: true, status: 200,
    json: async () => ({ model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(rows) }] }),
  }),
});

await t('추출 성공 — 초안이 채워지고 status 가 review 로', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: '2022-ne-test-m2-L6', sources: [{ kind: 'words', text: '원천' }] });
  const id = cr.body.jobId;
  const r = await call(s, '/api/naesin/admin/job/extract', 'POST', { jobId: id, kind: 'words' },
    { ai: fakeAi({ words: [{ id: 'w-001', headword: 'sea', meaningKo: ['바다'], sections: ['reading'] }] }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.count, 1);
  assert.strictEqual(r.body.job.status, 'review');
  assert.strictEqual(r.body.gate.pending, 1, '갓 추출한 행은 미검토다');
});

await t('추출 실패는 작업을 못 쓰게 만들지 않는다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: '2022-ne-test-m2-L6', sources: [{ kind: 'words', text: '원천' }] });
  const id = cr.body.jobId;
  const r = await call(s, '/api/naesin/admin/job/extract', 'POST', { jobId: id, kind: 'words' },
    { ai: { apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500 }) } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.reason, 'api-500');
  const job = await s.getJob(id);
  assert.notStrictEqual(job.status, 'failed', 'failed 로 굳히지 않는다(재시도 가능)');
  assert.ok(job.error.indexOf('api-500') >= 0, job.error);
});

await t('API 키가 없으면 no-key 로 내려간다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: '2022-ne-test-m2-L6', sources: [{ kind: 'words', text: '원천' }] });
  const r = await call(s, '/api/naesin/admin/job/extract', 'POST', { jobId: cr.body.jobId, kind: 'words' }, { ai: {} });
  assert.strictEqual(r.body.reason, 'no-key');
});

await t('원천 없는 종류는 400', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: '2022-ne-test-m2-L6', sources: [{ kind: 'words', text: '원천' }] });
  const r = await call(s, '/api/naesin/admin/job/extract', 'POST', { jobId: cr.body.jobId, kind: 'sentences' }, { ai: fakeAi({ sentences: [] }) });
  assert.strictEqual(r.status, 400);
});

await t('다시 추출하면 그 종류의 옛 검수는 버린다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', {
    packId: '2022-ne-test-m2-L6', sources: [{ kind: 'words', text: 'a' }, { kind: 'patterns', text: 'b' }],
  });
  const id = cr.body.jobId;
  const ai = fakeAi({ words: [{ id: 'w-001', headword: 'sea', meaningKo: ['바다'], sections: ['reading'] }] });
  await call(s, '/api/naesin/admin/job/extract', 'POST', { jobId: id, kind: 'words' }, { ai });
  await call(s, '/api/naesin/admin/job/extract', 'POST', { jobId: id, kind: 'patterns' },
    { ai: fakeAi({ patterns: [{ patternNo: 1, title: 'T', conceptKo: 'C', textbookExamples: ['e'] }] }) });
  let job = await s.getJob(id);
  job.review = { 'words:w-001': { state: 'ok', at: 'x' }, 'patterns:p1': { state: 'ok', at: 'x' } };
  await s.putJob(id, job);
  await call(s, '/api/naesin/admin/job/extract', 'POST', { jobId: id, kind: 'words' }, { ai });
  job = await s.getJob(id);
  assert.ok(!job.review['words:w-001'], '단어 검수는 버려야 한다');
  assert.ok(job.review['patterns:p1'], '다른 종류 검수는 남아야 한다');
});

await t('초안 직접 넣기 — 키 없이도 스튜디오를 쓸 수 있다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: '2022-ne-test-m2-L6' });
  const r = await call(s, '/api/naesin/admin/job/draft', 'POST', {
    jobId: cr.body.jobId,
    draft: { words: [{ id: 'w-001', headword: 'sea', meaningKo: ['바다'], sections: ['reading'] }], sentences: [] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.job.counts.words, 1);
  assert.ok(!('sentences' in r.body.job.counts), '빈 배열은 안 담는다');
  assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: cr.body.jobId, draft: {} })).status, 400);
});

await t('초안 종류·행 형태를 검사하고 거절 시 기존 초안·승인을 보존한다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId;
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: draftFromSample() });
  const job = await s.getJob(id); approveAll(job);
  const before = JSON.stringify(job);
  for (const draft of [{ unknown: [{}] }, { unknown: [] }, { words: {} }, { words: [null] },
    { kind: 'naesin-pdf-review-draft', version: 1, wordCandidates: [{}] }]) {
    assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft })).status, 400);
    assert.strictEqual(JSON.stringify(await s.getJob(id)), before);
  }
});

await t('본문 후보 추가는 단어 74행과 변경 없는 문장의 승인·교정·메모를 보존한다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId, words = Array.from({ length: 74 }, (_, i) => ({ ...pdfWord(), id: 'own-' + i }));
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { words, sentences: [pdfSentence()] } }, { localPdfReview: true });
  const job = await s.getJob(id); approveAll(job);
  job.review['sentences:s1'] = { state: 'fixed', patch: { ko: '자체 검수한 뜻' }, note: '직접 대조', at: 'original' };
  const beforeWords = clone(job.draft.words), beforeReview = clone(job.review);
  const next = pdfSentence(); next.seq = 2;
  const r = await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { sentences: [...clone(job.draft.sentences), next] } }, { localPdfReview: true });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(job.draft.words, beforeWords);
  assert.deepStrictEqual(job.review, beforeReview);
  assert.strictEqual(r.body.gate.pending, 1);
  assert.strictEqual(assemble(job).sentences[0].ko, '자체 검수한 뜻');
  assert.ok(r.body.gate.warns.some((w) => /^sentences\[1\].*PDF/.test(w.message)));
});

await t('같은 안정키라도 변경·삭제·추가한 원행은 이전 승인을 받지 않는다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId;
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { words: clone(SAMPLE.words).slice(0, 3), sentences: [pdfSentence()] } }, { localPdfReview: true });
  const job = await s.getJob(id); approveAll(job);
  const keys = job.draft.words.map((row, i) => rowKey('words', row, i));
  const kept = clone(job.review[keys[0]]), sentenceReview = clone(job.review['sentences:s1']);
  const changed = { ...job.draft.words[1], headword: 'changed original' }, added = { ...job.draft.words[2], id: 'own-new' };
  const r = await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { words: [clone(job.draft.words[0]), changed, added] } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(job.review, { [keys[0]]: kept, 'sentences:s1': sentenceReview });
  assert.strictEqual(r.body.gate.pending, 2);
});

await t('중복 안정키·빈 식별자·인덱스 fallback 및 그 충돌은 검수를 옮기지 않는다', async () => {
  const own = { headword: 'own', meaningKo: ['자체 뜻'], sections: ['reading'] };
  const cases = [
    { old: [{ ...own, id: 'same' }], next: [{ ...own, id: 'same' }, { ...own, id: 'same' }], key: 'words:same' },
    { old: [{ ...own, id: 'same' }, { ...own, id: 'same' }], next: [{ ...own, id: 'same' }], key: 'words:same' },
    { old: [own], next: [own], key: 'words:i0' },
    { old: [{ ...own, id: '' }], next: [{ ...own, id: '' }], key: 'words:' },
    { old: [{ ...own, id: {} }], next: [{ ...own, id: {} }], key: 'words:[object Object]' },
    { old: [{ ...own, id: 'i1' }, own], next: [{ ...own, id: 'i1' }], key: 'words:i1' },
    { old: [{ ...own, id: 'i1' }], next: [{ ...own, id: 'i1' }, own], key: 'words:i1' },
  ];
  for (const fixture of cases) {
    const s = memStore();
    const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
    const id = cr.body.jobId;
    await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { words: clone(fixture.old) } });
    const job = await s.getJob(id); job.review[fixture.key] = { state: 'fixed', patch: { headword: 'wrong if inherited' }, note: 'old' };
    assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { words: clone(fixture.next) } })).status, 200);
    assert.deepStrictEqual(job.review, {}, fixture.key);
    assert.strictEqual(publishGate(job).pending, fixture.next.length);
  }
});

await t('종류별 안정키는 배열 순서 변경에서도 원행 동일성을 요구하며 JSON 필드 순서 변경은 재검수한다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId;
  const draft = { words: [{ id: 'a', headword: 'own-a' }, { id: 'b', headword: 'own-b' }],
    sentences: [{ seq: 1, en: 'Own.' }], items: [{ no: 2, stem: 'Own?' }], patterns: [{ patternNo: 3, title: 'Own pattern' }] };
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: clone(draft) });
  const job = await s.getJob(id); approveAll(job); const originalReview = clone(job.review);
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { ...clone(draft), words: clone(draft.words).reverse() } });
  assert.deepStrictEqual(job.review, originalReview);
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { words: [{ headword: 'own-a', id: 'a' }] } });
  assert.deepStrictEqual(job.review, { 'sentences:s1': originalReview['sentences:s1'], 'items:n2': originalReview['items:n2'], 'patterns:p3': originalReview['patterns:p3'] });
});

await t('PDF 후보 DTO는 원내 권한이 확인된 PC만 받고 워커에서는 거절한다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const b = { jobId: cr.body.jobId, draft: { words: [pdfWord()] } };
  for (const localPdfReview of [undefined, false, 'true'])
    assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', b, { localPdfReview })).status, 403);
  const r = await call(s, '/api/naesin/admin/job/draft', 'POST', b, { localPdfReview: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.gate.pending, 1);
  assert.ok(r.body.gate.warns.some((w) => /^words\[0\].*PDF/.test(w.message)), '일괄 승인이 제외할 행 경고');
  assert.deepStrictEqual((await s.getJob(b.jobId)).draft.words[0]._pdfReview, b.draft.words[0]._pdfReview);
});

await t('PDF 본문 후보는 원내 PC만 받고 개별 대조 전에는 게시와 일괄 승인 대상에 들어가지 않는다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId, b = { jobId: id, draft: { words: clone(SAMPLE.words), sentences: [pdfSentence()] } };
  for (const localPdfReview of [undefined, false, 'true'])
    assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', b, { localPdfReview })).status, 403);
  const r = await call(s, '/api/naesin/admin/job/draft', 'POST', b, { localPdfReview: true });
  assert.strictEqual(r.status, 200);
  const job = await s.getJob(id);
  for (const [i, row] of job.draft.words.entries()) job.review[rowKey('words', row, i)] = { state: 'ok' };
  const gate = publishGate(job);
  assert.strictEqual(gate.pending, 1); assert.strictEqual(gate.ok, false);
  assert.ok(gate.warns.some((w) => /^sentences\[0\].*PDF/.test(w.message)));
  assert.strictEqual((await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id })).status, 400);
  assert.deepStrictEqual(assemble(job).sentences[0].chunks, b.draft.sentences[0].chunks);
  const reviewed = await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, key: 'sentences:s1', state: 'ok' });
  assert.strictEqual(reviewed.body.gate.ok, true);
  assert.strictEqual((await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id })).status, 200);
  const published = (await s.getPack(SAMPLE.packId)).pack;
  assert.ok(!JSON.stringify(published).includes('_pdfReview'));
  assert.ok(!JSON.stringify(published).includes('locations'));
});

await t('Phase 2E fresh review job removes all 28 chunk/grammarPoint structural errors without approving rows', async () => {
  const s=memStore(),created=await call(s,'/api/naesin/admin/job','POST',{packId:SAMPLE.packId}),id=created.body.jobId;
  const meta={flags:['REVIEW_REQUIRED','FULL_SENTENCE_CHUNK_REVIEW','CANONICAL_WHITESPACE_TOKENS'],locations:[{page:1,bbox:[0,0,0,0],sourceDocumentId:'02',printedPage:1,section:'fixture'}]};
  const words=Array.from({length:74},(_,i)=>({id:`w-source-${i+1}`,headword:`sourceword${i+1}`,pos:'n.',meaningKo:[`원문 뜻 ${i+1}`],sections:i<41?['conversation']:i<69?['reading']:[],irregularForms:[],notes:[],_pdfReview:{...clone(meta),flags:i<69?clone(meta.flags):[...meta.flags,'SECTION_UNRESOLVED']}}));
  const sentences=Array.from({length:25},(_,i)=>{const en=`Own source sentence ${i+1}.`,ko=`자체 원문 문장 ${i+1}.`;return{seq:i+1,dayGroup:'8/1',en,ko,chunks:[{en,ko}],keywords:[],tokens:en.trim().split(' '),verbForms:[],grammarChoices:[],writingKeywords:[],wordIds:[],grammarNotes:[],notes:[],_pdfReview:clone(meta)};});
  const patterns=Array.from({length:3},(_,i)=>({patternNo:i+1,title:`Pattern ${i+1}`,conceptKo:'원문 개념',grammarPoint:[['핵심 1',`원문 문법 설명 ${i+1}`]],textbookExamples:[{en:'We saw a fish.',ko:'물고기를 보았다.',origin:'교과서 본문'}],letsUseIt:[],notes:[],_pdfReview:clone(meta)}));
  const saved=await call(s,'/api/naesin/admin/job/draft','POST',{jobId:id,draft:{words,sentences,patterns}},{localPdfReview:true});assert.equal(saved.status,200);assert.equal(saved.body.gate.pending,102);
  const structural=saved.body.gate.errors.filter(e=>/grammarPoint|PDF 본문은 영·한 문장과 대응하는 청크가 필요함/.test(e.message));assert.deepStrictEqual(structural,[]);
  const residual=saved.body.gate.errors.map(e=>e.message),keywordErrors=residual.filter(message=>message.includes('1·3단계 문항을 만들 핵심어가 필요함')),unresolvedSections=residual.filter(message=>/sections 비었음$/.test(message));
  assert.equal(keywordErrors.length,25);assert.deepStrictEqual(unresolvedSections,Array.from({length:5},(_,i)=>`words[${69+i}](sourceword${70+i}) sections 비었음`));
  assert.deepStrictEqual(residual.filter(message=>!message.includes('1·3단계 문항을 만들 핵심어가 필요함')&&!/sections 비었음$/.test(message)),[]);
  const stored=await s.getJob(id);assert.equal(Object.keys(stored.review).length,0);assert.equal(stored.draft.words.length,74);assert.equal(stored.draft.words.filter(row=>row._pdfReview.flags.includes('SECTION_UNRESOLVED')).length,5);assert.ok(stored.draft.sentences.every(row=>row._pdfReview.flags.includes('REVIEW_REQUIRED')&&row._pdfReview.flags.includes('FULL_SENTENCE_CHUNK_REVIEW')&&row._pdfReview.flags.includes('CANONICAL_WHITESPACE_TOKENS')));
});

await t('folder-v4 최종 배열은 미검토로 저장되고 publish payload에서 출처 메타를 제거하며 빈 청크는 보완 전 게시하지 않는다', async () => {
  const s=memStore(),created=await call(s,'/api/naesin/admin/job','POST',{packId:SAMPLE.packId}),id=created.body.jobId;
  const meta={flags:['REVIEW_REQUIRED'],locations:[{page:1,bbox:[0,0,0,0],sourceDocumentId:'01',printedPage:1,section:'fixture'}]};
  const draft={dialogues:[{id:'d-own',title:'자체 대화',section:'A',lines:[{speaker:'G',en:'Hello.',ko:'안녕.'}],notes:[],_pdfReview:clone(meta)}],functions:[{name:'기능',pattern:'would like',explainKo:'원함',_pdfReview:clone(meta)}],keyExpressions:[{en:'Hello.',ko:'안녕.',blankAnswer:'Hello',_pdfReview:clone(meta)}],patterns:[{patternNo:1,title:'패턴',conceptKo:'개념',grammarPoint:[],textbookExamples:[],letsUseIt:[],notes:[],_pdfReview:clone(meta)}],items:[{no:1,footnoteNo:55,source:'08',section:'Pattern 1',formatType:'short',instructionKo:'Write the answer.',isNegative:false,answerCount:1,stimulus:{type:'text',parts:[]},choices:[],answer:['The original answer'],explanationKo:'',targetRefs:[{patternNo:1}],notes:[],_pdfReview:clone(meta)}]};
  const saved=await call(s,'/api/naesin/admin/job/draft','POST',{jobId:id,draft},{localPdfReview:true});assert.equal(saved.status,200);assert.equal(saved.body.gate.pending,5);
  const job=await s.getJob(id),pack=assemble(job);for(const kind of Object.keys(draft))assert.ok(!JSON.stringify(pack[kind]).includes('_pdfReview'));
  const empty={seq:1,dayGroup:'1',en:'A toy is blue.',ko:'장난감이 파랗다.',chunks:[],keywords:[],tokens:[],verbForms:[],grammarChoices:[],writingKeywords:[],wordIds:[],grammarNotes:[],notes:[],_pdfReview:clone(meta)};
  const second=await call(s,'/api/naesin/admin/job','POST',{packId:'own-empty-review'}),emptySaved=await call(s,'/api/naesin/admin/job/draft','POST',{jobId:second.body.jobId,draft:{sentences:[empty]}},{localPdfReview:true});assert.equal(emptySaved.status,200);
  const emptyJob=await s.getJob(second.body.jobId);approveAll(emptyJob);assert.ok(publishGate(emptyJob).errors.some(e=>/PDF 본문/.test(e.message)));
});

await t('로컬 시험 문항 id는 번호·순서 변경에도 같은 검수 키를 쓰며 변경한 원행은 재검수한다', async () => {
  const s = memStore(), created = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId }), id = created.body.jobId;
  const first = { ...clone(SAMPLE.items[0]), id: 'ic-05-00-001', source: '05', _pdfReview: { flags: ['REVIEW_REQUIRED'], locations: [{ page: 1, bbox: [0, 0, 0, 0], sourceDocumentId: '05s' }] } };
  assert.equal((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { items: [first] } }, { localPdfReview: true })).status, 200);
  const job = await s.getJob(id), key = rowKey('items', first, 0); job.review[key] = { state: 'ok', note: 'own review' };
  const inserted = { ...clone(first), id: 'ic-04-00-001', source: '04' }, renumbered = { ...clone(first), no: 2 };
  assert.equal(rowKey('items', renumbered, 1), key);
  const saved = await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { items: [inserted, renumbered] } }, { localPdfReview: true });
  assert.equal(saved.status, 200); assert.deepStrictEqual((await s.getJob(id)).review, {}, '번호가 바뀐 원행도 새 자료에 승인되지 않는다');
  assert.equal(assemble(await s.getJob(id)).items[1].id, first.id);
  const before = JSON.stringify(await s.getJob(id));
  for (const invalid of ['', '../private', 'x'.repeat(61), null]) {
    const bad = await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { items: [{ ...first, id: invalid }] } }, { localPdfReview: true });
    assert.equal(bad.status, 400); assert.equal(JSON.stringify(await s.getJob(id)), before);
  }
});

await t('스튜디오 게시도 공용 문항 관문을 쓰며 승인된 잘못된 문항이 이전 팩을 덮지 않는다', async () => {
  const s = memStore(), created = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId }), id = created.body.jobId;
  const original = { pack: clone(SAMPLE), updatedAt: 'own original' }; await s.putPack(SAMPLE.packId, original);
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: draftFromSample() });
  const job = await s.getJob(id); job.draft.items[0].answer = ['']; approveAll(job);
  const gate = publishGate(job), common = CHECK.checkPack(assemble(job));
  assert.equal(gate.ok, false); assert.deepStrictEqual(gate.errors, common.errors);
  assert.equal((await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id })).status, 400);
  assert.deepStrictEqual(await s.getPack(SAMPLE.packId), original);
});

await t('PDF 본문 필드·청크·좌표 오류는 기존 작업을 변경하지 않고 거절한다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId;
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { words: clone(SAMPLE.words) } });
  const job = await s.getJob(id); approveAll(job); const before = JSON.stringify(job);
  for (const mutate of [
    (r) => { r.raw = '합성 원천'; }, (r) => { r.tokens = 'invalid'; }, (r) => { r.seq = 0; }, (r) => { r.seq = '1'; },
    (r) => { r.dayGroup = ''; }, (r) => { r.en = ' '; }, (r) => { r.ko = []; },
    (r) => { r.chunks = [{ en: '', ko: '' }]; }, (r) => { r.chunks[0].raw = '합성'; }, (r) => { r.chunks[0].ko = ''; },
    (r) => { r.chunks[0].en = 'Different'; }, (r) => { r._pdfReview.locations[0].bbox[1] = -1; },
    (r) => { r._pdfReview.locations[0].page = 0; }, (r) => { r._pdfReview.rawText = '합성'; },
    (r) => { r.keywords = 'blue'; }, (r) => { r.keywords = null; }, (r) => { r.keywords = [null]; },
    (r) => { r.keywords[0].raw = '합성'; }, (r) => { r.keywords[0].en = ''; }, (r) => { r.keywords[0].ko = 1; },
  ]) {
    const row = pdfSentence(); mutate(row);
    assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { sentences: [row] } }, { localPdfReview: true })).status, 400);
    assert.strictEqual(JSON.stringify(await s.getJob(id)), before);
  }
  for (const kind of ['patterns', 'items', 'dialogues']) {
    assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { [kind]: [pdfSentence()] } }, { localPdfReview: true })).status, 400);
    assert.strictEqual(JSON.stringify(await s.getJob(id)), before);
  }
});

await t('미주석 PDF 본문은 초안으로 보존하지만 실제 1·3단계 문항이 없으면 승인 후에도 게시하지 않는다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId;
  for (const keywords of [undefined, [], [{ en: 'absent', ko: '파랗다' }], [{ en: 'blue', ko: '대응하지 않는 뜻' }], [{ en: 'blue', ko: '장난감이 파랗다.' }]]) {
    const row = unannotatedPdfSentence(); if (keywords !== undefined) row.keywords = keywords;
    const draft = { words: clone(SAMPLE.words), sentences: [row] };
    const saved = await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft }, { localPdfReview: true });
    assert.strictEqual(saved.status, 200, '미완 후보를 교사가 보완할 수 있어야 한다');
    const job = await s.getJob(id); approveAll(job);
    assert.strictEqual(CHECK.checkPack(assemble(job)).errors.length, 0, '구형 공통 검사 계약은 유지');
    assert.strictEqual(publishGate(job).ok, false);
    assert.ok(publishGate(job).errors.some((e) => /^sentences\[0\].*1·3단계/.test(e.message)));
    assert.strictEqual((await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id })).status, 400);
    const plain = clone(job); delete plain.draft.sentences[0]._pdfReview;
    assert.strictEqual(publishGate(plain).ok, true, '일반·구형 문장의 게시 규칙을 바꾸지 않는다');
  }
  const job = await s.getJob(id);
  const corrected = await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, key: 'sentences:s1', state: 'fixed', patch: { keywords: [{ en: 'blue', ko: '파랗다' }] } });
  assert.strictEqual(corrected.body.gate.ok, true);
  const sentence = assemble(job).sentences[0];
  assert.ok(GEN.koBlanks(sentence, 0).parts.some((p) => p.blank));
  assert.ok(GEN.keywordBlanks(sentence, 'en', 0).parts.some((p) => p.blank));
  assert.strictEqual((await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id })).status, 200);
  for (const keywords of [null, [], [{ en: 'absent', ko: '파랗다' }], [{ en: 'blue', ko: '다른 뜻' }]]) {
    const bad = await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, key: 'sentences:s1', state: 'fixed', patch: { keywords } });
    assert.strictEqual(bad.body.gate.ok, false, '교정으로 핵심어를 지우거나 대응을 깨는 우회 차단');
  }
});

await t('교차 미대응 핵심어나 정상 쌍에 섞인 미대응 쌍은 전체 1·3단계 생성으로 게시 관문을 우회하지 못한다', () => {
  for (const keywords of [[{ en: 'absent', ko: '파랗다' }, { en: 'blue', ko: '없는뜻' }],
    [{ en: 'blue', ko: '파랗다' }, { en: 'absent', ko: '파랗다' }]]) {
    const row = pdfSentence(); row.keywords = keywords;
    const job = { meta: { rights: clone(SAMPLE.rights) }, packId: SAMPLE.packId, draft: { words: clone(SAMPLE.words), sentences: [row] }, review: {} }; approveAll(job);
    assert.ok(GEN.koBlanks(row, 0)); assert.ok(GEN.keywordBlanks(row, 'en', 0));
    assert.strictEqual(publishGate(job).ok, false, '각 en/ko 쌍이 두 문항 모두를 만들 수 있어야 한다');
    assert.ok(publishGate(job).errors.some((e) => /1·3단계/.test(e.message)));
  }
});

await t('직접 입력한 짧은 1청크 문장은 허용하지만 교정으로 청크를 지우거나 대응을 깨면 게시되지 않는다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId, sentence = pdfSentence();
  sentence.en = 'Go!'; sentence.ko = '가!'; sentence.chunks = [{ en: 'Go!', ko: '가!' }];
  sentence.keywords = [{ en: 'Go', ko: '가' }];
  assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { words: clone(SAMPLE.words), sentences: [sentence] } }, { localPdfReview: true })).status, 200);
  const job = await s.getJob(id); approveAll(job); assert.strictEqual(publishGate(job).ok, true);
  for (const patch of [{ chunks: null }, { chunks: [] }, { chunks: [{ en: 'Stop!', ko: '멈춰!' }] }]) {
    const r = await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, key: 'sentences:s1', state: 'fixed', patch });
    assert.strictEqual(r.body.gate.ok, false);
    assert.ok(r.body.gate.errors.some((e) => /PDF 본문/.test(e.message)));
    assert.strictEqual((await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id })).status, 400);
  }
});

await t('같은 검수 키의 PDF 후보·일반 행 충돌은 반입을 거절하고 기존 중복·교정 후 충돌도 게시하지 않는다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId;
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { words: clone(SAMPLE.words) } });
  const job = await s.getJob(id); approveAll(job); const before = JSON.stringify(job);
  for (const plain of [false, true]) {
    const duplicate = pdfSentence(); if (plain) delete duplicate._pdfReview;
    const sentences = [pdfSentence(), duplicate];
    assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { sentences } }, { localPdfReview: true })).status, 400);
    assert.strictEqual(JSON.stringify(job), before);
    const old = { meta: { rights: clone(SAMPLE.rights) }, packId: SAMPLE.packId, draft: { words: clone(SAMPLE.words), sentences }, review: {} }; approveAll(old);
    const gate = publishGate(old);
    assert.strictEqual(gate.pending, 0, '하나의 키로 두 행을 승인한 기존 데이터');
    assert.strictEqual(gate.ok, false);
    assert.ok(gate.errors.some((e) => /검수 키가 중복/.test(e.message)));
  }
  for (const plain of [false, true]) {
    const first = pdfSentence(), second = pdfSentence(); second.seq = 2;
    if (plain) delete second._pdfReview;
    const old = { meta: { rights: clone(SAMPLE.rights) }, packId: SAMPLE.packId, draft: { words: clone(SAMPLE.words), sentences: [first, second] }, review: {} }; approveAll(old);
    assert.strictEqual(publishGate(old).ok, true);
    old.review['sentences:s1'] = { state: 'fixed', patch: { seq: 2 } };
    assert.strictEqual(CHECK.checkPack(assemble(old)).errors.length, 0, '조립기의 재번호가 충돌을 가리면 안 된다');
    assert.strictEqual(publishGate(old).ok, false);
    assert.ok(publishGate(old).errors.some((e) => /검수 키가 중복/.test(e.message)));
  }
  const words = [pdfWord(), pdfWord()];
  assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { words } }, { localPdfReview: true })).status, 400);
  assert.strictEqual(JSON.stringify(job), before);
});

await t('PDF 문장 교정의 표준 학습 필드는 허용하고 원천·비공개 필드만 공통 관문으로 차단한다', () => {
  const job = { meta: { rights: clone(SAMPLE.rights) }, packId: SAMPLE.packId, draft: { words: clone(SAMPLE.words), sentences: [pdfSentence()] }, review: {} }; approveAll(job);
  const patch = { keywords: [{ en: 'toy', ko: '장난감' }], tokens: ['A toy', 'is blue.'], grammarNotes: [{ target: 'is', note: '자체 문법 주석' }] };
  job.review['sentences:s1'] = { state: 'fixed', patch, note: '교사 추가' };
  assert.strictEqual(CHECK.checkPack(assemble(job)).errors.length, 0);
  assert.strictEqual(publishGate(job).ok, true);
  assert.deepStrictEqual(assemble(job).sentences[0].keywords, patch.keywords);
  for (const extra of [{ raw: '합성 원천' }, { grammarNotes: [{ target: 'is', note: '자체', raw: '합성' }] }]) {
    job.review['sentences:s1'].patch = { ...patch, ...extra };
    const gate = publishGate(job);
    assert.strictEqual(gate.ok, false);
    assert.ok(gate.errors.some((e) => /허용되지 않는 필드/.test(e.message)));
  }
});

await t('같은 밀리초에도 작업 버전은 증가하며 오래된 초안이 새 문장·교정·메모를 덮지 않는다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId, sources: [{ kind: 'words', text: '자체 원천' }] });
  const id = cr.body.jobId, job = await s.getJob(id), realNow = Date.now, frozen = Date.parse('2030-01-01T00:00:00.000Z');
  try {
    Date.now = () => frozen; job.updatedAt = new Date(frozen).toISOString();
    let baseUpdatedAt = job.updatedAt;
    assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, baseUpdatedAt, draft: { words: clone(SAMPLE.words), sentences: [pdfSentence()] } }, { localPdfReview: true })).status, 200);
    assert.strictEqual(Date.parse(job.updatedAt), frozen + 1);
    const stale = clone(job.draft), staleVersion = job.updatedAt, next = pdfSentence(); next.seq = 2;
    baseUpdatedAt = job.updatedAt;
    assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, baseUpdatedAt, draft: { sentences: [...clone(job.draft.sentences), next] } }, { localPdfReview: true })).status, 200);
    assert.strictEqual(Date.parse(job.updatedAt), frozen + 2);
    assert.strictEqual((await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, key: 'sentences:s2', state: 'fixed', patch: { ko: '교정된 자체 뜻' }, note: '새 교사 메모' })).status, 200);
    assert.strictEqual(Date.parse(job.updatedAt), frozen + 3);
    const before = JSON.stringify(job);
    assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, baseUpdatedAt: staleVersion, draft: stale }, { localPdfReview: true })).status, 409);
    assert.strictEqual(JSON.stringify(job), before, '새 문장과 교정·메모 모두 보존');
    assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, baseUpdatedAt: staleVersion, draft: { words: null } })).status, 409);
    assert.strictEqual(JSON.stringify(job), before, '오래된 잘못된 입력도 변이를 일으키지 않음');
    const extracted = await call(s, '/api/naesin/admin/job/extract', 'POST', { jobId: id, kind: 'words' }, { ai: fakeAi({ words: clone(SAMPLE.words) }) });
    assert.strictEqual(extracted.body.ok, true); assert.strictEqual(Date.parse(job.updatedAt), frozen + 4);
    const failed = await call(s, '/api/naesin/admin/job/extract', 'POST', { jobId: id, kind: 'words' }, { ai: {} });
    assert.strictEqual(failed.body.ok, false); assert.strictEqual(Date.parse(job.updatedAt), frozen + 5);
    assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { words: clone(SAMPLE.words) } })).status, 200, '구형 클라이언트 계약');
    assert.strictEqual(Date.parse(job.updatedAt), frozen + 6);
    baseUpdatedAt = job.updatedAt;
    const concurrent = await Promise.all([0, 1].map((i) => call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, baseUpdatedAt, draft: { words: [{ ...clone(SAMPLE.words[0]), headword: 'own-' + i }] } })));
    assert.deepStrictEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    assert.strictEqual(Date.parse(job.updatedAt), frozen + 7);
  } finally { Date.now = realNow; }
});

await t('이전 원문을 본 검수의 승인·교정·일괄 요청은 새 원문을 승인하지 않고 최신 개별 대조만 허용한다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId;
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: { words: clone(SAMPLE.words), sentences: [pdfSentence()] } }, { localPdfReview: true });
  const job = await s.getJob(id);
  await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, baseUpdatedAt: job.updatedAt,
    rows: job.draft.words.map((row, i) => ({ key: rowKey('words', row, i), state: 'ok' })) });
  const oldVersion = job.updatedAt, red = pdfSentence();
  red.en = 'A toy is red.'; red.ko = '장난감이 빨갛다.'; red.chunks[1] = { en: 'is red.', ko: '빨갛다.' };
  red.keywords = [{ en: 'red', ko: '빨갛다' }];
  assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, baseUpdatedAt: oldVersion, draft: { sentences: [red] } }, { localPdfReview: true })).status, 200);
  const before = JSON.stringify(job), old = { jobId: id, baseUpdatedAt: oldVersion, key: 'sentences:s1' };
  for (const request of [
    { ...old, state: 'ok' }, { ...old, state: 'fixed', patch: { ko: '장난감이 파랗다.' }, note: '본 적 없는 원문을 덮으면 안 됨' },
    { ...old, rows: [{ key: rowKey('words', job.draft.words[0], 0), state: 'pending' }, { key: 'sentences:s1', state: 'ok' }] },
    { ...old, state: 'typo' }, { ...old, baseUpdatedAt: null, state: 'ok' },
  ]) {
    assert.strictEqual((await call(s, '/api/naesin/admin/job/review', 'POST', request)).status, 409);
    assert.strictEqual(JSON.stringify(job), before, '원문·검수·교정·메모·버전 무변이');
    assert.strictEqual(publishGate(job).pending, 1);
    assert.strictEqual(publishGate(job).ok, false);
  }
  const latest = job.updatedAt;
  assert.strictEqual((await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, baseUpdatedAt: latest, key: 'sentences:s1', state: 'ok' })).status, 200);
  assert.strictEqual(publishGate(job).ok, true);
  assert.strictEqual(assemble(job).sentences[0].en, red.en);
  assert.strictEqual((await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, key: 'sentences:s1', state: 'pending' })).status, 200, 'base가 없는 기존 API 호출은 호환');
  const baseUpdatedAt = job.updatedAt;
  const concurrent = await Promise.all([0, 1].map((i) => call(s, '/api/naesin/admin/job/review', 'POST',
    { jobId: id, baseUpdatedAt, key: 'sentences:s1', state: 'fixed', patch: { ko: '직접 대조한 뜻 ' + i }, note: '자체 검수 ' + i })));
  assert.deepStrictEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
});

await t('PDF DTO에는 원문 부속물·다른 종류·잘못된 좌표가 들어오지 못한다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const mutations = [
    (w) => { w.raw = '합성'; }, (w) => { w.evidence = '합성'; },
    (w) => { w._pdfReview.raw = '합성'; }, (w) => { w._pdfReview.flags = 'pending'; },
    (w) => { w._pdfReview.locations[0].page = 0; },
    (w) => { w._pdfReview.locations[0].bbox = [1, 2, 0, 3]; },
    (w) => { w._pdfReview.locations[0].bbox = [1, 2, 3]; },
    (w) => { w._pdfReview.locations[0].bbox[0] = -1; },
    (w) => { w._pdfReview.locations[0].bbox[0] = '1'; },
    (w) => { w._pdfReview.locations[0].tokens = ['합성']; },
    (w) => { w._pdfReview.locations[0].sourceDocumentId = 'not-in-manifest'; },
    (w) => { w.senses[0].extra = 'forbidden'; },
    (w) => { w.senses[0].senseNo = 2; },
    (w) => { w.senses[0].example.en = ''; },
    (w) => { delete w.senses[0].example.ko; },
    (w) => { w.senses[0].meaningKo = 'meaning mismatch'; },
    (w) => { w.senses.push({ senseNo: 2, pos: 'n.', meaningKo: 'more', example: { en: 'More.', ko: '더.' }, extra: 'x' }, { senseNo: 3, pos: 'n.', meaningKo: 'more', example: { en: 'More.', ko: '더.' } }, { senseNo: 4, pos: 'n.', meaningKo: 'more', example: { en: 'More.', ko: '더.' } }); },
  ];
  for (const mutate of mutations) {
    const w = pdfWord(); mutate(w);
    const r = await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: cr.body.jobId, draft: { words: [w] } }, { localPdfReview: true });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual((await s.getJob(cr.body.jobId)).draft, {});
  }
  assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', {
    jobId: cr.body.jobId, draft: { sentences: [pdfWord()] },
  }, { localPdfReview: true })).status, 400);
});

await t('manifest 기반 PDF sourceDocumentId·인쇄 쪽·섹션을 검수 메타로 보존한다', async () => {
  const s=memStore();const cr=await call(s,'/api/naesin/admin/job','POST',{packId:SAMPLE.packId});
  const row=pdfWord();row._pdfReview.locations[0]={page:2,bbox:[0,0,0,0],sourceDocumentId:'03',printedPage:2,section:'word-list',questionNo:null};
  assert.equal((await call(s,'/api/naesin/admin/job/draft','POST',{jobId:cr.body.jobId,draft:{words:[row]}},{localPdfReview:true})).status,200);
  const saved=(await s.getJob(cr.body.jobId)).draft.words[0]._pdfReview.locations[0];
  assert.deepEqual(saved,{page:2,bbox:[0,0,0,0],sourceDocumentId:'03',printedPage:2,section:'word-list',questionNo:null});
});

await t('PDF 원본 메타는 편집으로 지워지지 않고 개별 검수 후 학생 팩에서 제거된다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId;
  await call(s, '/api/naesin/admin/job/draft', 'POST', {
    jobId: id, draft: { words: [pdfWord()], sentences: clone(SAMPLE.sentences) },
  }, { localPdfReview: true });
  const job = await s.getJob(id);
  for (const [i, row] of job.draft.sentences.entries()) job.review[rowKey('sentences', row, i)] = { state: 'ok' };
  const key = rowKey('words', job.draft.words[0], 0), original = clone(job.draft.words[0]._pdfReview);
  const pending = await call(s, '/api/naesin/admin/job/review', 'POST', {
    jobId: id, key, state: 'pending', patch: { _pdfReview: null },
  });
  assert.strictEqual(pending.body.gate.ok, false);
  assert.ok(pending.body.gate.warns.some((w) => /PDF/.test(w.message)));
  assert.deepStrictEqual(job.draft.words[0]._pdfReview, original);
  assert.ok(!Object.prototype.hasOwnProperty.call(job.review[key].patch, '_pdfReview'));
  const fixed = await call(s, '/api/naesin/admin/job/review', 'POST', {
    jobId: id, key, state: 'fixed', patch: { headword: job.draft.words[0].headword, _pdfReview: { flags: [] } },
  });
  assert.strictEqual(fixed.body.gate.ok, true, JSON.stringify(fixed.body.gate));
  assert.ok(!fixed.body.gate.warns.some((w) => /PDF/.test(w.message)));
  assert.deepStrictEqual(job.draft.words[0]._pdfReview, original);
  const published = await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id });
  assert.strictEqual(published.status, 200);
  const pack = (await s.getPack(SAMPLE.packId)).pack;
  assert.ok(!JSON.stringify(pack).includes('_pdfReview'));
  assert.ok(!JSON.stringify(pack).includes('locations'));
  assert.strictEqual(pack.words[0].headword, job.draft.words[0].headword);
  assert.deepStrictEqual(pack.words[0].senses, job.draft.words[0].senses);
});

await t('행 인덱스 경고는 버린 앞 행을 뺀 조립 순서에 맞고 승인 행은 사라진다', () => {
  const a = pdfWord(), b = pdfWord(), c = pdfWord(); b.id = 'w-pdf-b'; c.id = 'w-pdf-c';
  const job = { meta: { rights: clone(SAMPLE.rights) }, packId: SAMPLE.packId, draft: { words: [a, b, c], sentences: clone(SAMPLE.sentences) }, review: {} };
  job.review[rowKey('words', a, 0)] = { state: 'dropped' };
  job.review[rowKey('words', c, 2)] = { state: 'ok' };
  const warns = publishGate(job).warns.filter((w) => /PDF/.test(w.message));
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0].message, /^words\[0\]/);
  assert.ok(!JSON.stringify(assemble(job)).includes('_pdfReview'));
  job.review[rowKey('words', b, 1)] = { state: 'unknown' };
  const unresolved = publishGate(job);
  assert.ok(unresolved.pending > 0);
  assert.ok(unresolved.warns.some((w) => /^words\[0\].*PDF/.test(w.message)));
});

await t('옛 승인 초안도 unknown 배열·미검수 표시·중첩 원천이 있으면 배포되지 않는다', () => {
  for (const mutate of [
    (job) => { job.draft.extraRaw = [{ raw: '합성' }]; },
    (job) => { job.draft.words[0].reviewed = false; },
    (job) => { job.draft.words[0].example.evidence = '합성'; },
  ]) {
    const job = { meta: { rights: clone(SAMPLE.rights) }, packId: SAMPLE.packId, draft: draftFromSample(), review: {} };
    mutate(job); approveAll(job);
    const gate = publishGate(job);
    assert.strictEqual(gate.ok, false);
    assert.ok(gate.errors.length);
    assert.ok(!Object.prototype.hasOwnProperty.call(assemble(job), 'extraRaw'));
  }
});

await t('편집에서 지운 원천 부속물의 null patch는 학생 팩에서 실제로 제거한다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId, draft = draftFromSample();
  draft.words[0].raw = '합성 원천'; draft.words[0].reviewed = false;
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft });
  const job = await s.getJob(id); approveAll(job);
  assert.strictEqual(publishGate(job).ok, false);
  const key = rowKey('words', job.draft.words[0], 0);
  const r = await call(s, '/api/naesin/admin/job/review', 'POST', {
    jobId: id, key, state: 'fixed', patch: { raw: null, reviewed: null },
  });
  assert.strictEqual(r.body.gate.ok, true);
  const out = assemble(job).words[0];
  assert.ok(!Object.prototype.hasOwnProperty.call(out, 'raw'));
  assert.ok(!Object.prototype.hasOwnProperty.call(out, 'reviewed'));
  assert.strictEqual(job.draft.words[0].raw, '합성 원천', '검수 원본은 유지한다');
});

await t('교정 후 승인·버림·되돌리기는 patch/note를 보존하고 명시 null/빈 note만 지운다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId, w = pdfWord(); w.sections = [];
  await call(s, '/api/naesin/admin/job/draft', 'POST', {
    jobId: id, draft: { words: [w], sentences: clone(SAMPLE.sentences) },
  }, { localPdfReview: true });
  const job = await s.getJob(id);
  for (const [i, row] of job.draft.sentences.entries()) job.review[rowKey('sentences', row, i)] = { state: 'ok' };
  const key = rowKey('words', w, 0);
  const fixed = await call(s, '/api/naesin/admin/job/review', 'POST', {
    jobId: id, key, state: 'fixed', patch: { sections: ['reading'], _pdfReview: null }, note: '원본 확인',
  });
  assert.strictEqual(fixed.body.gate.ok, true);
  for (const state of ['ok', 'dropped', 'pending', 'ok']) {
    await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, key, state });
    assert.deepStrictEqual(job.review[key].patch, { sections: ['reading'] });
    assert.strictEqual(job.review[key].note, '원본 확인');
  }
  assert.strictEqual(publishGate(job).ok, true);
  assert.strictEqual((await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id })).status, 200);
  const pack = (await s.getPack(SAMPLE.packId)).pack;
  assert.deepStrictEqual(pack.words[0].sections, ['reading']);
  assert.ok(!Object.prototype.hasOwnProperty.call(pack.words[0], '_pdfReview'));
  await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, key, state: 'pending', patch: null, note: '' });
  assert.ok(!Object.prototype.hasOwnProperty.call(job.review[key], 'patch'));
  assert.ok(!Object.prototype.hasOwnProperty.call(job.review[key], 'note'));
  assert.strictEqual(publishGate(job).ok, false);
  assert.deepStrictEqual((await s.getPack(SAMPLE.packId)).pack, pack);
});

await t('잘못된 검수 상태는 PDF 후보를 승인하지 않고 누락·오타 요청을 거절한다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId, w = pdfWord();
  await call(s, '/api/naesin/admin/job/draft', 'POST', {
    jobId: id, draft: { words: [w], sentences: clone(SAMPLE.sentences) },
  }, { localPdfReview: true });
  const job = await s.getJob(id);
  for (const [i, row] of job.draft.sentences.entries()) job.review[rowKey('sentences', row, i)] = { state: 'ok' };
  const before = JSON.stringify(job), key = rowKey('words', w, 0);
  for (const state of [undefined, 'typo', '', 0]) {
    assert.strictEqual((await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, key, state })).status, 400);
    assert.strictEqual(JSON.stringify(await s.getJob(id)), before);
    assert.strictEqual(publishGate(job).ok, false);
    assert.strictEqual(publishGate(job).pending, 1);
  }
});

await t('잘못된 patch·메모·일괄 요청의 뒤 행은 기존 교정본을 부분 변경하지 않는다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId;
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: draftFromSample() });
  const job = await s.getJob(id); approveAll(job);
  const first = rowKey('words', job.draft.words[0], 0), last = rowKey('words', job.draft.words[1], 1);
  job.review[first] = { state: 'fixed', patch: { headword: 'fixed' }, note: '보존할 메모', at: 'x' };
  const before = JSON.stringify(job);
  for (const invalid of [
    { state: 'typo' }, { state: 'pending', patch: [] }, { state: 'pending', patch: 'wrong' },
    { state: 'pending', patch: false }, { state: 'pending', patch: 1 },
    { state: 'pending', note: null }, { state: 'pending', note: {} },
  ]) {
    const single = { jobId: id, key: first, ...invalid };
    assert.strictEqual((await call(s, '/api/naesin/admin/job/review', 'POST', single)).status, 400);
    assert.strictEqual(JSON.stringify(await s.getJob(id)), before);
    const batch = { jobId: id, rows: [
      { key: first, state: 'pending', patch: { headword: 'should-not-change' }, note: '바뀌면 안 됨' },
      { key: last, ...invalid },
    ] };
    assert.strictEqual((await call(s, '/api/naesin/admin/job/review', 'POST', batch)).status, 400);
    assert.strictEqual(JSON.stringify(await s.getJob(id)), before);
  }
});

await t('검수·내용 오류가 있으면 이전 발행 팩을 덮지 않는다', async () => {
  const s = memStore(), original = { pack: clone(SAMPLE), updatedAt: 'original' };
  await s.putPack(SAMPLE.packId, original); await s.putPackIds([SAMPLE.packId]);
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId;
  const draft = draftFromSample();
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft });
  assert.strictEqual((await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id })).status, 400);
  const job = await s.getJob(id); approveAll(job); job.draft.words[0].headword = '';
  assert.strictEqual((await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id })).status, 400);
  assert.deepStrictEqual(await s.getPack(SAMPLE.packId), original);
  assert.deepStrictEqual(await s.getPackIds(), [SAMPLE.packId]);
});

/* ── 비용 한도 (기획서 §13-8) ──
   요금이 걸린 자리라 '막힌다'만이 아니라 '얼마나 남았는지'까지 화면에 가야 한다. */
await t('AI 추출은 하루 한도를 받고, 남은 횟수를 화면에 돌려준다', async () => {
  const s2 = memStore();
  const cr = await call(s2, '/api/naesin/admin/job', 'POST', {
    packId: '2022-q-m2-L1', sources: [{ name: 'w.txt', kind: 'words', text: '원천' }],
  });
  const id = cr.body.jobId;
  const ai = { ...fakeAi({ words: [{ id: 'w-001', headword: 'sea', meaningKo: ['바다'], sections: ['reading'] }] }), env: { NAESIN_AI_DAILY: '2' } };
  const r1 = await call(s2, '/api/naesin/admin/job/extract', 'POST', { jobId: id, kind: 'words' }, { ai });
  assert.strictEqual(r1.body.ok, true, JSON.stringify(r1.body).slice(0, 200));
  assert.strictEqual(r1.body.aiCap, 2);
  assert.strictEqual(r1.body.aiLeft, 1, '남은 횟수가 화면에 가야 관리가 된다');
  assert.strictEqual(s2.peekAiUse().count, 1, '장부에 남는다');

  const r2 = await call(s2, '/api/naesin/admin/job/extract', 'POST', { jobId: id, kind: 'words' }, { ai });
  assert.strictEqual(r2.body.aiLeft, 0);
  const r3 = await call(s2, '/api/naesin/admin/job/extract', 'POST', { jobId: id, kind: 'words' }, { ai });
  assert.strictEqual(r3.body.ok, false);
  assert.strictEqual(r3.body.reason, 'quota', '한도를 넘으면 부르지 않는다');
  assert.strictEqual(s2.peekAiUse().count, 2, '막힌 요청은 장부를 올리지 않는다');
});

await t('환경변수가 없으면 기본 한도(80)를 쓴다 — 오타로 기능이 죽지 않게', async () => {
  const s2 = memStore();
  const cr = await call(s2, '/api/naesin/admin/job', 'POST', {
    packId: '2022-q-m2-L2', sources: [{ name: 'w.txt', kind: 'words', text: '원천' }],
  });
  const r = await call(s2, '/api/naesin/admin/job/extract', 'POST', { jobId: cr.body.jobId, kind: 'words' },
    { ai: { ...fakeAi({ words: [{ id: 'w-001', headword: 'sea', meaningKo: ['바다'], sections: ['reading'] }] }), env: {} } });
  assert.strictEqual(r.body.aiCap, 80);
  assert.strictEqual(r.body.aiLeft, 79);
});

console.log('\n== 검수');

await t('검수 — 승인·수정·버림, 모르는 키는 무시', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: '2022-ne-test-m2-L6' });
  const id = cr.body.jobId;
  await call(s, '/api/naesin/admin/job/draft', 'POST', {
    jobId: id, draft: { words: [
      { id: 'w-001', headword: 'sea', meaningKo: ['바다'], sections: ['reading'] },
      { id: 'w-002', headword: '', meaningKo: ['틀림'], sections: ['reading'] },
    ] },
  });
  const bad = await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, key: 'words:nope', state: 'ok' });
  assert.strictEqual(bad.status, 400, '모르는 키만 오면 400');
  const r = await call(s, '/api/naesin/admin/job/review', 'POST', { jobId: id, rows: [
    { key: 'words:w-001', state: 'ok' },
    { key: 'words:w-002', state: 'fixed', patch: { headword: 'tide' }, note: '표제어 누락' },
  ] });
  assert.strictEqual(r.body.applied, 2);
  assert.strictEqual(r.body.gate.pending, 0);
  const job = await s.getJob(id);
  assert.strictEqual(job.review['words:w-002'].note, '표제어 누락');
  assert.strictEqual(assemble(job).words[1].headword, 'tide', '고친 값이 조립에 반영돼야 한다');
});

await t('버린 행은 조립에서 빠지고 문장 seq 는 다시 매겨진다', async () => {
  const job = { meta: { rights: clone(SAMPLE.rights) }, packId: 'p-1', draft: { sentences: clone(SAMPLE.sentences) }, review: {} };
  job.review[rowKey('sentences', job.draft.sentences[1], 1)] = { state: 'dropped', at: 'x' };
  const pack = assemble(job);
  assert.strictEqual(pack.sentences.length, SAMPLE.sentences.length - 1);
  assert.deepStrictEqual(pack.sentences.map((s2) => s2.seq), pack.sentences.map((_, i) => i + 1));
});

await t('rowKey 는 배열 순서가 바뀌어도 같은 행을 가리킨다', () => {
  const row = { id: 'w-007', headword: 'keep' };
  assert.strictEqual(rowKey('words', row, 0), rowKey('words', row, 5));
  assert.strictEqual(rowKey('sentences', { seq: 3 }, 0), 'sentences:s3');
  assert.strictEqual(rowKey('items', { no: 12 }, 0), 'items:n12');
  assert.strictEqual(rowKey('patterns', { patternNo: 2 }, 0), 'patterns:p2');
  assert.strictEqual(rowKey('words', {}, 4), 'words:i4', 'id 가 없으면 순번으로');
});

console.log('\n== 배포 — CLI 검증기와 같은 판정');

await t('검증기와 판정이 같다(같은 팩을 두 경로에 걸어 비교)', async () => {
  const job = { packId: SAMPLE.packId, meta: { rights: clone(SAMPLE.rights) }, draft: draftFromSample(), review: {} };
  approveAll(job);
  const gate = publishGate(job);
  const direct = CHECK.checkPack(gate.pack);
  assert.deepStrictEqual(gate.errors, direct.errors);
  assert.deepStrictEqual(gate.warns, direct.warns);
  assert.deepStrictEqual(gate.errors, [], '샘플은 오류 0이어야 한다: ' + JSON.stringify(gate.errors));
  assert.strictEqual(gate.ok, true);
});

await t('CLI 검증기(pack-validate)와 같은 결과를 낸다', async () => {
  /* 같은 팩을 CLI 가 읽는 파일 구성으로 떨어뜨려 두 경로의 오류 수를 비교한다 */
  /* 경로는 이 파일 위치에서 뽑는다 — 절대 경로를 박으면 내 기계에서만 통과하고 CI 에서 깨진다 */
  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-studio-cmp-'));
  const p = clone(SAMPLE);
  p.sentences[0].chunks[0].en = '어긋난 청크';       // 오류를 하나 심는다
  const hdr = { rights: clone(SAMPLE.rights), packId: p.packId, textbook: p.textbook, grade: p.grade, lesson: p.lesson };
  fs.writeFileSync(path.join(dir, 'words.json'), JSON.stringify({ ...hdr, words: p.words }));
  fs.writeFileSync(path.join(dir, 'sentences.json'), JSON.stringify({ ...hdr, sentences: p.sentences, oddOneItems: p.oddOneItems, checkItems: p.checkItems }));
  const { execFileSync } = await import('node:child_process');
  let cliOut = '';
  try { cliOut = execFileSync(process.execPath, [path.join(ROOT, 'naesin', 'pack-validate.mjs'), dir], { cwd: ROOT, encoding: 'utf8' }); }
  catch (e) { cliOut = String(e.stdout || '') + String(e.stderr || ''); }
  const cliErrors = (cliOut.match(/^오류 (\d+)건/m) || [])[1];
  /* CLI 를 못 돌렸으면 비교가 아니라 통과가 된다 — 그 조용한 통과를 막는다(이 테스트의 존재 이유다) */
  assert.ok(cliErrors != null, 'CLI 검증기를 돌리지 못했다 — 비교가 성립하지 않는다:\n' + cliOut);

  const job = { packId: p.packId, meta: { rights: clone(SAMPLE.rights) }, draft: { words: p.words, sentences: p.sentences, oddOneItems: p.oddOneItems, checkItems: p.checkItems }, review: {} };
  approveAll(job);
  const gate = publishGate(job);
  assert.strictEqual(String(gate.errors.length), cliErrors, 'CLI ' + cliErrors + '건 vs 스튜디오 ' + gate.errors.length + '건\n' + cliOut);
  assert.ok(gate.errors.length >= 1, '심은 오류가 잡혀야 한다');
});

await t('미검토 행이 남으면 배포를 막는다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId;
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: draftFromSample() });
  const r = await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.pending > 0, JSON.stringify(r.body).slice(0, 200));
  assert.ok(r.body.error.indexOf('검수') >= 0, r.body.error);
  assert.strictEqual((await s.getPack(SAMPLE.packId)), null, '팩이 저장되지 않아야 한다');
});

await t('검사 오류가 남으면 배포를 막는다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const id = cr.body.jobId;
  const d = draftFromSample();
  d.words[0].headword = '';
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: d });
  const job = await s.getJob(id); approveAll(job); await s.putJob(id, job);
  const r = await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.errors.length >= 1);
});

await t('빈 초안은 배포를 막는다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId });
  const r = await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: cr.body.jobId });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.error.indexOf('비었') >= 0, r.body.error);
});

await t('통과하면 팩 저장소와 목록에 들어간다', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: SAMPLE.packId, meta: { textbook: '체험', grade: '중2', lesson: 0 } });
  const id = cr.body.jobId;
  await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: id, draft: draftFromSample() });
  const job = await s.getJob(id); approveAll(job); await s.putJob(id, job);
  const r = await call(s, '/api/naesin/admin/job/publish', 'POST', { jobId: id });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const rec = await s.getPack(SAMPLE.packId);
  assert.ok(rec && rec.pack && rec.pack.words.length === SAMPLE.words.length);
  assert.strictEqual(rec.pack.textbook, '체험', '메타가 팩에 실려야 한다');
  assert.deepStrictEqual(await s.getPackIds(), [SAMPLE.packId]);
  assert.strictEqual((await s.getJob(id)).status, 'published');
});

await t('작업 삭제는 원천도 함께 지운다(구매 자료)', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: '2022-ne-test-m2-L6', sources: [{ kind: 'words', text: '원천' }] });
  const id = cr.body.jobId;
  assert.ok(await s.getJobSrc(id));
  const r = await call(s, '/api/naesin/admin/job', 'DELETE', { jobId: id });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await s.getJob(id), null);
  assert.strictEqual(await s.getJobSrc(id), null, '원천이 남으면 안 된다');
});

await t('조회 — 원천은 요청할 때만(?src=1)', async () => {
  const s = memStore();
  const cr = await call(s, '/api/naesin/admin/job', 'POST', { packId: '2022-ne-test-m2-L6', sources: [{ kind: 'words', text: '비밀 원천' }] });
  const id = cr.body.jobId;
  const a = await call(s, '/api/naesin/admin/job', 'GET', null, { query: 'id=' + id });
  assert.ok(!a.body.sources, '기본 조회에는 원천이 없다');
  const b = await call(s, '/api/naesin/admin/job', 'GET', null, { query: 'id=' + id + '&src=1' });
  assert.strictEqual(b.body.sources.words, '비밀 원천');
});

await t('jobBrief·newJobId·상수', () => {
  const brief = jobBrief({ jobId: 'job-abc123', packId: 'p', status: 'draft', draft: { words: [{ id: 'w-001' }] }, review: {}, createdAt: 'a', updatedAt: 'b' });
  assert.strictEqual(brief.counts.words, 1);
  assert.strictEqual(brief.pending, 1);
  assert.ok(!('draft' in brief), '요약에 초안 본문이 들어가면 목록이 무거워진다');
  let i = 0;
  assert.ok(/^job-[a-z0-9]{10}$/.test(newJobId(() => { i += 0.1; return i % 1; })));
  assert.ok(JOB_STATUS.includes('published') && REVIEW_STATES.includes('dropped'));
});

console.log('\n통과 ' + n + '개 — 팩 제작 스튜디오 검증 완료');
