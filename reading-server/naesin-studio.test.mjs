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
const SAMPLE = require('../naesin/pack-sample.json');

let n = 0;
const t = async (name, fn) => { await fn(); n += 1; console.log('  ✓ ' + name); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const WHO = { code: '__admin__', admin: true };

/* 호스트 저장소를 메모리로 흉내낸다 — 워커 KV·로컬 db 어느 쪽이든 같은 모양이다 */
function memStore() {
  const jobs = new Map(), src = new Map(), packs = new Map();
  let ids = [];
  return {
    jobs, src, packs,
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
  getBody: async () => body,
  ai: opts.ai, rnd: opts.rnd,
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

console.log('\n== 추출 (fetch를 갈아 끼운다 — 실제 API 호출 금지)');

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
    draft: { words: [{ id: 'w-001', headword: 'sea', meaningKo: ['바다'], sections: ['reading'] }], empty: [] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.job.counts.words, 1);
  assert.ok(!('empty' in r.body.job.counts), '빈 배열은 안 담는다');
  assert.strictEqual((await call(s, '/api/naesin/admin/job/draft', 'POST', { jobId: cr.body.jobId, draft: {} })).status, 400);
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
  const job = { packId: 'p-1', draft: { sentences: clone(SAMPLE.sentences) }, review: {} };
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
  const job = { packId: SAMPLE.packId, meta: {}, draft: draftFromSample(), review: {} };
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
  const hdr = { packId: p.packId, textbook: p.textbook, grade: p.grade, lesson: p.lesson };
  fs.writeFileSync(path.join(dir, 'words.json'), JSON.stringify({ ...hdr, words: p.words }));
  fs.writeFileSync(path.join(dir, 'sentences.json'), JSON.stringify({ ...hdr, sentences: p.sentences, oddOneItems: p.oddOneItems, checkItems: p.checkItems }));
  const { execFileSync } = await import('node:child_process');
  let cliOut = '';
  try { cliOut = execFileSync(process.execPath, [path.join(ROOT, 'naesin', 'pack-validate.mjs'), dir], { cwd: ROOT, encoding: 'utf8' }); }
  catch (e) { cliOut = String(e.stdout || '') + String(e.stderr || ''); }
  const cliErrors = (cliOut.match(/^오류 (\d+)건/m) || [])[1];
  /* CLI 를 못 돌렸으면 비교가 아니라 통과가 된다 — 그 조용한 통과를 막는다(이 테스트의 존재 이유다) */
  assert.ok(cliErrors != null, 'CLI 검증기를 돌리지 못했다 — 비교가 성립하지 않는다:\n' + cliOut);

  const job = { packId: p.packId, meta: {}, draft: { words: p.words, sentences: p.sentences, oddOneItems: p.oddOneItems, checkItems: p.checkItems }, review: {} };
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
