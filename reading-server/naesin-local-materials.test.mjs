'use strict';
/* 자체 작성 파일만으로 원내 PDF 경로·원본 대조·실제 HTTP 인증 경계를 확인한다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readLocalMaterials } from './naesin-local-materials.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempRoot, 'wbr-pdf-source-'));
assert.equal(path.dirname(fs.realpathSync(root)), tempRoot);
const data = path.join(root, 'server'), materials = path.join(root, 'naesin-materials');
const packId = 'own-local-source', packDir = path.join(materials, packId);
const analysis = path.join(packDir, 'analysis');
const olderDir = path.join(analysis, 'draft-20261012-120000-aaaaaa');
const latestDir = path.join(analysis, 'draft-20261012-125958-bbbbbb');
const draftPath = path.join(latestDir, 'review-draft.json');
const pdfs = { '02': Buffer.from('%PDF-1.4\n% Own passage fixture only.\n'), '03': Buffer.from('%PDF-1.4\n% Own vocabulary fixture only.\n') };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const draft = { kind: 'naesin-pdf-review-draft', version: 1, status: 'needs-review', publishable: false,
  sources: Object.fromEntries(['02', '03'].map(key => [key, { file: key + '_own.pdf', sha256: sha(pdfs[key]), pageCount: 1 }])),
  wordCandidates: [{ candidateId: 'own-word-01', headword: 'toy', meanings: ['장난감'], reviewFlags: ['REVIEW_REQUIRED'] }], passageColumns: [] };
fs.mkdirSync(data); fs.mkdirSync(olderDir, { recursive: true }); fs.mkdirSync(latestDir);
const writeDraft = value => fs.writeFileSync(draftPath, JSON.stringify(value));
const reset = () => { writeDraft(draft); for (const key of ['02', '03']) fs.writeFileSync(path.join(packDir, draft.sources[key].file), pdfs[key]); };
reset(); fs.writeFileSync(path.join(olderDir, 'review-draft.json'), JSON.stringify({ ...draft, wordCandidates: [] }));
const folderPackId='own-folder-source', folderPack=path.join(materials,folderPackId), folderAnalysis=path.join(folderPack,'analysis');
const folderSpecs=[['00','textbook','00_교과서본문.pdf'],['01','content_summary','01_내용정리.pdf'],['02','passage_workbook','02_본문워크북.pdf'],['03','vocabulary','03_단어시험.pdf'],['04s','pre_step_student','04_예상문제_PRE-STEP.pdf'],['04t','pre_step_teacher','04_예상문제_PRE-STEP_교사용.pdf'],['05s','exam_1_student','05_예상문제_1회.pdf'],['05t','exam_1_teacher','05_예상문제_1회_교사용.pdf'],['06s','exam_2_student','06_예상문제_2회.pdf'],['06t','exam_2_teacher','06_예상문제_2회_교사용.pdf'],['07','grammar_workbook','07_문법워크북.pdf'],['08','grammar_mcq','08_문법객관식.pdf'],['09','grammar_subjective','09_문법주관식.pdf']];
fs.mkdirSync(folderPack,{recursive:true});
const folderBytes=new Map(), folderDocs=[];
for(const [source,role,file] of folderSpecs){const bytes=Buffer.from('%PDF-1.4\\n% fixture '+source+'\\n');folderBytes.set(source,bytes);fs.writeFileSync(path.join(folderPack,file),bytes);folderDocs.push({sourceDocumentId:source,role,file,bytes:bytes.length,sha256:sha(bytes),pageCount:source==='00'?2:source==='01'?44:source==='02'?31:source==='03'?26:source==='04s'||source==='04t'?14:source==='05s'||source==='05t'?10:source==='06s'||source==='06t'?12:source==='07'?25:source==='08'?23:25});}
const folderLatest=path.join(folderAnalysis,'draft-20261013-120000-cccccc');fs.mkdirSync(folderLatest,{recursive:true});
const folderDraft={kind:'naesin-folder-review-draft',version:1,status:'needs-review',publishable:false,rights:{basis:'licensed',holder:'fixture',evidenceRef:'fixture',studentUseAllowed:true,derivativeUseAllowed:true,externalAiAllowed:false,notes:'원내 전용'},sourceDocuments:folderDocs,wordCandidates:[{candidateId:'wc-0001'}],sentenceCandidates:[{seq:1}]};
fs.writeFileSync(path.join(folderLatest,'review-draft.json'),JSON.stringify(folderDraft));
const jobId = 'job-ownpdf01', adminToken = randomUUID(), studentToken = randomUUID();
const originalDb = JSON.stringify({ students: { OWN01: { code: 'OWN01', name: '자체 시험 학생' } }, states: {},
  tokens: { [adminToken]: { admin: true, code: '__admin__', exp: Date.now() + 3600e3 }, [studentToken]: { admin: false, code: 'OWN01', exp: Date.now() + 3600e3 } },
  naesin: { jobs: { [jobId]: { jobId, packId, meta: { rights: { basis: 'self_authored', holder: '합성 원내 테스트', evidenceRef: 'fixture', studentUseAllowed: true, derivativeUseAllowed: true, externalAiAllowed: false } }, status: 'review', draft: { words: [] }, review: {}, updatedAt: '2026-10-12T12:00:00.000Z' }, 'job-folder01': { jobId:'job-folder01', packId:folderPackId, meta:{rights:folderDraft.rights}, status:'review', draft:{words:[]}, review:{}, updatedAt:'2026-10-13T12:00:00.000Z' } } } });
const inside = { host: 'academy.example', 'cf-connecting-ip': '198.51.100.10' };
const outside = { host: 'academy.example', 'cf-connecting-ip': '203.0.113.99' };
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };
const unavailable = () => assert.throws(() => readLocalMaterials(data, packId));

async function withServer(mode, fn) {
  fs.writeFileSync(path.join(data, 'db.json'), originalDb);
  const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: data, ADMIN_PIN: 'own-source-test-pin', ADMIN_ID: '', ADMIN_PASSWORD: '',
    WB_INHOUSE_ONLY: mode === 'inhouse' ? '1' : '', WB_INHOUSE_NETWORKS: '198.51.100.10', WB_ADMIN_ONLY: mode === 'admin-only' ? '1' : '',
    ANTHROPIC_API_KEY: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_JWK: '', WB_PARENT_PORTAL_LINK_SECRET: '' };
  const child = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  let stdout = '', stderr = '', base;
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const req = (route, { token = adminToken, headers = {}, method = 'GET' } = {}) => new Promise((resolve, reject) => {
    const send = request(base + route, { method, signal: AbortSignal.timeout(5000), headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { const bytes = Buffer.concat(chunks); let json; try { json = JSON.parse(bytes.toString('utf8')); } catch {} resolve({ status: response.statusCode, headers: response.headers, bytes, json }); });
    });
    send.on('error', reject); send.end();
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('자체 시험 서버 기동 실패: ' + stderr);
      const listening = stdout.match(/WB 진로독서 서버 http:\/\/localhost:(\d+)\r?\n/);
      if (listening) { base = 'http://127.0.0.1:' + listening[1]; try { ready = (await req('/api/health', { token: null })).status === 200; } catch {} if (ready) break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, '소유한 자식 서버 기동 확인');
    await fn(req);
  } finally { if (child.exitCode === null) child.kill(); await exit; }
}

try {
  await t('13문서 folder manifest를 모두 해시 검증하고 요청한 문서만 반환한다', () => {
    const loaded=readLocalMaterials(data,folderPackId);
    assert.equal(loaded.draft.sourceDocuments.length,13);
    assert.equal(loaded.pdfs.length,13);
    assert.equal(loaded.pdfs.reduce((n,p)=>n+p.pageCount,0),248);
    assert.deepEqual(readLocalMaterials(data,folderPackId,'00',folderDocs[0].sha256).bytes,folderBytes.get('00'));
    assert.deepEqual(readLocalMaterials(data,folderPackId,'09',folderDocs.at(-1).sha256).bytes,folderBytes.get('09'));
    assert.throws(()=>readLocalMaterials(data,folderPackId,'08','0'.repeat(64)));
  });
  await t('최신 정규 이름의 미검수 초안과 원본 메타를 읽고 파일은 변경하지 않는다', () => {
    const before = fs.readFileSync(draftPath);
    const result = readLocalMaterials(data, packId);
    assert.deepEqual(result.draft, draft);
    assert.deepEqual(result.pdfs, ['02', '03'].map(source => ({ source, file: source + '_own.pdf', pageCount: 1, sha256: draft.sources[source].sha256 })));
    assert.deepEqual(readLocalMaterials(data, packId, '02', draft.sources['02'].sha256).bytes, pdfs['02']);
    assert.deepEqual(readLocalMaterials(data, packId, '03', draft.sources['03'].sha256).bytes, pdfs['03']);
    assert.deepEqual(fs.readFileSync(draftPath), before);
  });
  await t('허용되지 않은 팩·자료 번호·파일 이름과 NTFS 대체 스트림을 거절한다', () => {
    for (const value of ['../own-local-source', 'own/local-source', '..\\own-local-source', '', 'x']) assert.throws(() => readLocalMaterials(data, value));
    for (const value of ['04', '../../02', null]) assert.throws(() => readLocalMaterials(data, packId, value));
    for (const file of ['../02_own.pdf', '02_../own.pdf', '02_..\\own.pdf', 'C:\\02_own.pdf', '02_own.pdf:stream.pdf', '02_own.pdf\0', '03_own.pdf']) {
      writeDraft({ ...draft, sources: { ...draft.sources, '02': { ...draft.sources['02'], file } } }); unavailable();
    }
    reset();
  });
  await t('원본 해시·PDF 서명·페이지 메타가 다르면 공개하지 않는다', () => {
    const fp = path.join(packDir, '02_own.pdf');
    fs.writeFileSync(fp, '%PDF-1.4\nDifferent own PDF'); unavailable();
    const bad = Buffer.from('Own text, not a PDF'); fs.writeFileSync(fp, bad);
    writeDraft({ ...draft, sources: { ...draft.sources, '02': { ...draft.sources['02'], sha256: sha(bad) } } }); unavailable();
    reset();
    for (const pageCount of [0, 1.5, 1001, '1']) { writeDraft({ ...draft, sources: { ...draft.sources, '02': { ...draft.sources['02'], pageCount } } }); unavailable(); }
    reset();
  });
  await t('잘못되거나 누락된 최신 초안을 과거 초안으로 대체하지 않는다', () => {
    fs.writeFileSync(draftPath, '{broken own JSON'); unavailable();
    fs.unlinkSync(draftPath); unavailable();
    for (const value of [{ ...draft, publishable: true }, { ...draft, status: 'approved' }, { ...draft, version: 2 }, { ...draft, passageColumns: null }]) { writeDraft(value); unavailable(); }
    reset();
  });
  await t('정규 이름 밖 임시 초안은 최신 자료로 선택하지 않는다', () => {
    const noise = path.join(analysis, 'draft-99999999-999999-nothex'); fs.mkdirSync(noise);
    assert.deepEqual(readLocalMaterials(data, packId).draft, draft);
    fs.rmdirSync(noise);
  });
  await t('다운로드 이름이 없으면 두 고정 보관 이름을 원본 해시로 읽고 기존 파일·초안을 보존한다', () => {
    const aliases = { '02': '02_본문워크북.pdf', '03': '03_단어시험.pdf' };
    const renamedDraft = { ...draft, sources: Object.fromEntries(['02', '03'].map(key => [key, { ...draft.sources[key], file: '(자체작성)_자료_[' + key + ']워크북 통합본 (4).pdf' }])) };
    for (const key of ['02', '03']) fs.writeFileSync(path.join(packDir, aliases[key]), pdfs[key]);
    writeDraft(renamedDraft);
    const before = fs.readFileSync(draftPath);
    try {
      const result = readLocalMaterials(data, packId);
      assert.deepEqual(result.draft, renamedDraft);
      assert.deepEqual(result.pdfs.map(meta => meta.file), ['02', '03'].map(key => aliases[key]));
      for (const key of ['02', '03']) assert.deepEqual(readLocalMaterials(data, packId, key, draft.sources[key].sha256).bytes, pdfs[key]);
      assert.deepEqual(fs.readFileSync(draftPath), before);
      for (const key of ['02', '03']) assert.deepEqual(fs.readFileSync(path.join(packDir, aliases[key])), pdfs[key]);
      const direct = Buffer.from('%PDF-1.4\n% Own exact download filename takes priority.\n');
      const directFile = path.join(packDir, renamedDraft.sources['02'].file);
      fs.writeFileSync(directFile, direct);
      writeDraft({ ...renamedDraft, sources: { ...renamedDraft.sources, '02': { ...renamedDraft.sources['02'], sha256: sha(direct) } } });
      assert.equal(readLocalMaterials(data, packId).pdfs[0].file, renamedDraft.sources['02'].file);
      assert.deepEqual(readLocalMaterials(data, packId, '02', sha(direct)).bytes, direct);
      fs.unlinkSync(directFile);
    } finally { for (const key of ['02', '03']) fs.unlinkSync(path.join(packDir, aliases[key])); reset(); }
  });
  await t('다운로드 별칭도 없는 파일·다른 원본·링크를 대신 읽지 않고 기존 접두 이름은 별칭으로 우회하지 않는다', () => {
    const aliases = { '02': '02_본문워크북.pdf', '03': '03_단어시험.pdf' };
    const renamedDraft = { ...draft, sources: Object.fromEntries(['02', '03'].map(key => [key, { ...draft.sources[key], file: '(자체작성)_[' + key + ']원본.pdf' }])) };
    writeDraft(renamedDraft); unavailable();
    for (const key of ['02', '03']) fs.writeFileSync(path.join(packDir, aliases[key]), pdfs[key]);
    try {
      fs.writeFileSync(path.join(packDir, aliases['02']), '%PDF-1.4\n% Wrong own alias.'); unavailable();
      fs.writeFileSync(path.join(packDir, aliases['02']), pdfs['02']);
      const direct = path.join(packDir, renamedDraft.sources['02'].file);
      fs.writeFileSync(direct, '%PDF-1.4\n% Wrong exact download original.'); unavailable(); fs.unlinkSync(direct);
      fs.linkSync(path.join(packDir, aliases['02']), direct); unavailable(); fs.unlinkSync(direct);
      writeDraft(draft); fs.unlinkSync(path.join(packDir, draft.sources['02'].file)); unavailable();
    } finally { for (const key of ['02', '03']) fs.unlinkSync(path.join(packDir, aliases[key])); reset(); }
  });
  await t('상한보다 큰 JSON과 PDF는 내용을 반환하지 않는다', () => {
    fs.writeFileSync(draftPath, Buffer.alloc(8 * 1024 * 1024 + 1)); unavailable(); reset();
    const fp = path.join(packDir, '02_own.pdf'); fs.truncateSync(fp, 32 * 1024 * 1024 + 1); unavailable(); reset();
  });
  await t('원본 하드링크와 빈 원본을 거절한다', () => {
    const link = path.join(root, 'own-hardlink.pdf'), fp = path.join(packDir, '02_own.pdf');
    fs.linkSync(fp, link); unavailable(); fs.unlinkSync(link);
    fs.writeFileSync(fp, ''); unavailable(); reset();
  });
  await t('자료 루트·팩·추출 폴더의 연결을 거절한다', () => {
    for (const target of [materials, packDir, analysis, latestDir]) {
      const saved = target + '-saved'; fs.renameSync(target, saved);
      fs.symlinkSync(saved, target, process.platform === 'win32' ? 'junction' : 'dir');
      try { unavailable(); } finally { fs.unlinkSync(target); fs.renameSync(saved, target); }
    }
  });
  await withServer('inhouse', async req => {
    const reviewRoute = '/api/naesin/admin/job/local-review?id=' + jobId;
    const pdfRoute = '/api/naesin/admin/job/local-pdf?id=' + jobId + '&source=03&sha256=' + draft.sources['03'].sha256;
    await t('실제 HTTP 관리자 응답에 13문서 manifest와 개별 source key PDF가 나온다', async () => {
      const review=await req('/api/naesin/admin/job/local-review?id=job-folder01',{headers:inside});
      assert.equal(review.status,200);assert.equal(review.json.pdfs.length,13);assert.equal(review.json.draft.sourceDocuments.length,13);
      const last=folderDocs.at(-1);const pdf=await req('/api/naesin/admin/job/local-pdf?id=job-folder01&source=09&sha256='+last.sha256,{headers:inside});
      assert.equal(pdf.status,200);assert.deepEqual(pdf.bytes,folderBytes.get('09'));
    });
    await t('실제 원내 관리자 GET은 초안과 PDF를 no-store로 내고 DB·검수 상태는 보존한다', async () => {
      const before = fs.readFileSync(path.join(data, 'db.json'), 'utf8');
      for (const headers of [{}, inside]) {
        const review = await req(reviewRoute, { headers }); assert.equal(review.status, 200); assert.deepEqual(review.json.draft, draft); assert.equal(review.headers['cache-control'], 'no-store');
        const pdf = await req(pdfRoute, { headers }); assert.equal(pdf.status, 200); assert.equal(pdf.headers['content-type'], 'application/pdf'); assert.equal(pdf.headers['cache-control'], 'no-store'); assert.match(pdf.headers['content-disposition'], /^inline;/); assert.deepEqual(pdf.bytes, pdfs['03']);
        assert.match(pdf.headers['x-robots-tag'], /noindex/); assert.equal(fs.readFileSync(path.join(data, 'db.json'), 'utf8'), before);
      }
    });
    await t('실제 HTTP에서도 다운로드 이름 대신 원본 확인값이 같은 고정 보관본만 연결한다', async () => {
      const before = fs.readFileSync(path.join(data, 'db.json'), 'utf8');
      const aliases = { '02': '02_본문워크북.pdf', '03': '03_단어시험.pdf' };
      const renamedDraft = { ...draft, sources: Object.fromEntries(['02', '03'].map(key => [key, { ...draft.sources[key], file: '(자체작성)_[' + key + ']다운로드 (2).pdf' }])) };
      for (const key of ['02', '03']) fs.writeFileSync(path.join(packDir, aliases[key]), pdfs[key]);
      writeDraft(renamedDraft);
      try {
        const review = await req(reviewRoute);
        assert.equal(review.status, 200); assert.deepEqual(review.json.draft, renamedDraft);
        assert.deepEqual(review.json.pdfs.map(meta => meta.file), ['02', '03'].map(key => aliases[key]));
        const pdf = await req(pdfRoute); assert.equal(pdf.status, 200); assert.deepEqual(pdf.bytes, pdfs['03']);
        fs.writeFileSync(path.join(packDir, aliases['03']), '%PDF-1.4\n% Own mismatched alias.');
        assert.equal((await req(reviewRoute)).status, 404); assert.equal((await req(pdfRoute)).status, 404);
        assert.equal(fs.readFileSync(path.join(data, 'db.json'), 'utf8'), before);
      } finally { for (const key of ['02', '03']) fs.unlinkSync(path.join(packDir, aliases[key])); reset(); }
    });
    await t('외부·학생·인증 없음·공개 호스트의 CF 헤더 없음은 원본을 받을 수 없다', async () => {
      for (const route of [reviewRoute, pdfRoute]) {
        assert.equal((await req(route, { headers: outside })).status, 403);
        assert.equal((await req(route, { headers: { host: 'academy.example' } })).status, 403);
        assert.equal((await req(route, { token: studentToken })).status, 403);
        assert.equal((await req(route, { token: null })).status, 401);
      }
    });
    await t('없는 작업·잘못된 번호·비GET 요청을 거절하고 임의 경로 쿼리는 읽지 않는다', async () => {
      assert.equal((await req('/api/naesin/admin/job/local-review?id=../file')).status, 400);
      assert.equal((await req('/api/naesin/admin/job/local-review?id=job-absent01')).status, 404);
      assert.equal((await req('/api/naesin/admin/job/local-pdf?id=' + jobId + '&source=04')).status, 400);
      for (const value of ['', 'not-a-hash', draft.sources['03'].sha256.toUpperCase()]) assert.equal((await req('/api/naesin/admin/job/local-pdf?id=' + jobId + '&source=03&sha256=' + value)).status, 400);
      for (const route of [reviewRoute, pdfRoute]) assert.equal((await req(route, { method: 'POST' })).status, 405);
      const result = await req(reviewRoute + '&path=../../db.json&file=../../db.json'); assert.equal(result.status, 200); assert.deepEqual(result.json.draft, draft);
    });
    await t('원본 변경 오류 응답은 파일 경로나 콘텐츠를 노출하지 않는다', async () => {
      fs.writeFileSync(path.join(packDir, '03_own.pdf'), '%PDF-1.4 changed own fixture');
      for (const route of [reviewRoute, pdfRoute]) { const result = await req(route); assert.equal(result.status, 404); assert.equal(result.bytes.toString().includes(root), false); assert.equal(result.bytes.toString().includes('changed own fixture'), false); }
      reset();
    });
    await t('초안 연결 뒤 새 원본이 들어오면 이전 해시로 다른 PDF를 대조하지 못한다', async () => {
      const before = fs.readFileSync(path.join(data, 'db.json'), 'utf8');
      const connected = (await req(reviewRoute)).json;
      const nextBytes = Buffer.from('%PDF-1.4\n% New own vocabulary fixture with same filename.\n');
      const nextDraft = { ...draft, sources: { ...draft.sources, '03': { ...draft.sources['03'], sha256: sha(nextBytes) } } };
      const nextDir = path.join(analysis, 'draft-20261013-090000-cccccc');
      fs.mkdirSync(nextDir); fs.writeFileSync(path.join(nextDir, 'review-draft.json'), JSON.stringify(nextDraft));
      fs.writeFileSync(path.join(packDir, draft.sources['03'].file), nextBytes);
      try {
        const previousHash = connected.pdfs.find(meta => meta.source === '03').sha256;
        const stale = await req('/api/naesin/admin/job/local-pdf?id=' + jobId + '&source=03&sha256=' + previousHash);
        assert.equal(stale.status, 409); assert.equal(stale.headers['content-type'].startsWith('application/json'), true); assert.equal(stale.bytes.includes(nextBytes), false);
        const refreshed = (await req(reviewRoute)).json;
        const current = await req('/api/naesin/admin/job/local-pdf?id=' + jobId + '&source=03&sha256=' + refreshed.pdfs.find(meta => meta.source === '03').sha256);
        assert.equal(current.status, 200); assert.deepEqual(current.bytes, nextBytes);
        assert.equal(fs.readFileSync(path.join(data, 'db.json'), 'utf8'), before);
      } finally { fs.unlinkSync(path.join(nextDir, 'review-draft.json')); fs.rmdirSync(nextDir); reset(); }
    });
  });
  for (const mode of ['generic', 'admin-only']) await withServer(mode, req => t(mode + ' Node에서는 관리자도 로컬 원본 경로를 사용할 수 없다', async () => {
    for (const route of ['/api/naesin/admin/job/local-review?id=' + jobId, '/api/naesin/admin/job/local-pdf?id=' + jobId + '&source=02&sha256=' + draft.sources['02'].sha256]) assert.equal((await req(route)).status, 403);
  }));
  await t('워커에는 Node 파일 로더나 로컬 원본 경로가 등록되지 않는다', () => {
    const worker = fs.readFileSync(path.join(DIR, 'worker.mjs'), 'utf8');
    assert.equal(worker.includes('naesin-local-materials'), false); assert.equal(worker.includes('/local-review'), false); assert.equal(worker.includes('/local-pdf'), false);
  });
} finally {
  assert.equal(path.dirname(fs.realpathSync(root)), tempRoot);
  assert.ok(path.basename(root).startsWith('wbr-pdf-source-'));
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('\n통과 ' + passed + '개 — 원내 원본 PDF 연결');
