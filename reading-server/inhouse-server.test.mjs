'use strict';
/* 실제 HTTP 원내 모드 — 운영 데이터·원문·외부 AI 없이 자체 창작 샘플만 쓴다. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stampServiceWorker } from './sw-version.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = fs.realpathSync(os.tmpdir());
const data = fs.mkdtempSync(path.join(tempRoot, 'wbr-inhouse-'));
const resolvedData = fs.realpathSync(data);
assert.equal(path.dirname(resolvedData), tempRoot, '시험 DB는 실제 임시 디렉터리의 바로 아래여야 한다');
const pack = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'naesin', 'pack-sample.json'), 'utf8'));
const otherPack = { ...pack, packId: 'inhouse-pack-B' };
const code = 'INHOUSE01', otherCode = 'INHOUSE02', a = 'cls:시험 A반', b = 'cls:시험 B반';
const studentToken = randomUUID(), otherToken = randomUUID(), adminToken = randomUUID();
const parentToken = randomUUID().replace(/-/g, '');
const portalSecret = 'own-inhouse-portal-secret-not-real-32';
const exp = Date.now() + 3600e3;
fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({
  students: { [code]: { code, name: '원내 시험 A학생', cls: '시험 A반', grade: '중2', level: 'L3' },
    [otherCode]: { code: otherCode, name: '원내 시험 B학생', cls: '시험 B반', grade: '중2', level: 'L3', apps: ['naesin'] } },
  parents: { [parentToken]: code },
  states: { [code]: { state: { ownReadingSentinel: 'preserve' }, updatedAt: new Date().toISOString() } }, tokens: { [studentToken]: { code, admin: false, exp }, [otherToken]: { code: otherCode, admin: false, exp },
    [adminToken]: { code: '__admin__', admin: true, exp } },
  pending: { 'test-nonce': { code, state: 'approved', token: studentToken, exp } },
  naesin: { packs: { [pack.packId]: { pack, updatedAt: new Date().toISOString() }, [otherPack.packId]: { pack: otherPack } },
    packIds: [pack.packId, otherPack.packId],
    states: { [code]: { state: {}, updatedAt: new Date().toISOString() }, [otherCode]: { state: {}, updatedAt: new Date().toISOString() } },
    exams: { default: { examDate: '2099-12-31', packIds: [pack.packId] },
      [a]: { examDate: '2099-12-31', packIds: [pack.packId] }, [b]: { examDate: '2099-12-31', packIds: [otherPack.packId] } } },
}));

const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: data, ADMIN_ID: '', ADMIN_PASSWORD: '',
  ADMIN_PIN: 'test-inhouse-pin-not-real', WB_INHOUSE_ONLY: '1', WB_INHOUSE_NETWORKS: '198.51.100.10',
  ANTHROPIC_API_KEY: 'test-inhouse-ai-key-not-real', WB_PARENT_PORTAL_LINK_SECRET: portalSecret,
  VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_JWK: '' };
delete env.WB_ADMIN_ONLY;
const server = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(server, 'exit');
let stderr = '', stdout = '';
server.stderr.on('data', chunk => { stderr += chunk; });
server.stdout.on('data', chunk => { stdout += chunk; });
let base;
const outside = { host: 'academy.example', 'cf-connecting-ip': '203.0.113.99' };
const inside = { host: 'academy.example', 'cf-connecting-ip': '198.51.100.10' };
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function req(p, { token = studentToken, headers = {}, method = 'GET', body } = {}) {
  /* fetch는 Host를 자동 처리하므로 node:http로 실제 public Host를 전송한다. */
  return new Promise((resolve, reject) => {
    const send = request(base + p, { method, signal: AbortSignal.timeout(5000),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, response => {
      response.setEncoding('utf8');
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* 정적 HTML·JS도 같은 입구로 읽는다. */ }
        resolve({ status: response.statusCode, text, json, headers: response.headers });
      });
    });
    send.on('error', reject);
    send.end(body ? JSON.stringify(body) : undefined);
  });
}
const manage = (p, scope, opt = {}) => req('/api/naesin/admin/' + p + '?scope=' + encodeURIComponent(scope), { token: adminToken, ...opt });

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode != null) throw new Error('원내 서버 기동 실패: ' + stderr);
    const listening = stdout.match(/WB 진로독서 서버 http:\/\/localhost:(\d+)\r?\n/);
    if (listening) {
      assert.ok(Number(listening[1]) > 0 && Number(listening[1]) <= 65535);
      base = `http://127.0.0.1:${listening[1]}`;
      try { ready = (await req('/api/health', { token: null })).status === 200; if (ready) break; } catch { /* 기동 대기 */ }
    }
    await sleep(50);
  }
  assert.ok(ready, '원내 서버가 제한 시간 내 기동하지 않았다: ' + stderr);

  await t('PC 영어 서비스 워커는 현재 셸 내용으로 버전을 응답하며 원본과 다른 앱은 변경하지 않는다', async () => {
    const app = path.join(DIR, '..', 'naesin'), sw = path.join(app, 'sw.js'), original = fs.readFileSync(sw, 'utf8');
    const shell = ['index.html', 'engine.js', 'grade.js', 'gen.js', 'pack-sample.json', 'manifest.webmanifest', 'icon.svg'].map(file => path.join(app, file));
    const expected = stampServiceWorker(sw, shell.concat(path.join(DIR, '..', 'shared', 'voice.js')), 'wbn-shell');
    for (const headers of [{}, outside]) {
      const response = await req('/naesin/sw.js', { token: null, headers });
      assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
      assert.match(response.headers['content-type'], /javascript/);
      assert.equal(response.text, expected.source); assert.match(expected.tag, /^wbn-shell-[a-f0-9]{10}$/);
      assert.ok(!response.text.includes("const VERSION = 'wbn-shell-dev';"));
    }
    assert.equal(fs.readFileSync(sw, 'utf8'), original);
    const vocab = await req('/vocab/sw.js', { token: null });
    assert.equal(vocab.status, 200); assert.equal(vocab.text, fs.readFileSync(path.join(DIR, '..', 'vocab', 'sw.js'), 'utf8'));
  });

  await t('로컬 학생은 시험·자체 창작 팩을 인증 후 학습한다', async () => {
    const health = (await req('/api/health', { token: null })).json;
    assert.equal(health.runtime, 'node');
    assert.equal(health.localPdfReview, true);
    const exam = await req('/api/naesin/exam');
    assert.equal(exam.status, 200);
    assert.equal(exam.json.scope, 'class');
    const content = await req('/api/naesin/pack?id=' + pack.packId);
    assert.equal(content.status, 200);
    assert.deepEqual(content.json.pack, pack);
    assert.equal((await req('/api/naesin/pack?id=' + pack.packId, { token: null })).status, 401, '로컬이어도 인증은 필요');
  });

  await t('영어 PC도 학생 연동은 교사 승인 후 토큰을 내고 영어 기록만 저장한다', async () => {
    const login = await req('/api/login', { token: null, method: 'POST', body: { code, device: '자체 시험 기기' } });
    assert.equal(login.status, 200); assert.equal(login.json.pending, true);
    assert.equal((await req('/api/login/status?n=' + login.json.nonce, { token: null })).json.pending, true);
    assert.equal((await req('/api/admin/pending', { token: adminToken, method: 'POST', body: { nonce: login.json.nonce, action: 'approve' } })).status, 200);
    const approved = await req('/api/login/status?n=' + login.json.nonce, { token: null });
    assert.equal(approved.status, 200); assert.ok(approved.json.token); assert.equal(approved.json.student.code, code);
    assert.equal((await req('/api/naesin/exam', { token: approved.json.token })).status, 200);
    const state = { owner: code, savedAt: Date.now(), packs: { [pack.packId]: { savedAt: Date.now(), states: {}, own: 'English only' } } };
    assert.equal((await req('/api/naesin/state', { token: approved.json.token, method: 'PUT', body: { state } })).status, 200);
    assert.deepEqual((await req('/api/naesin/state', { token: approved.json.token })).json.state, state);
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8'));
    assert.deepEqual(saved.states[code].state, { ownReadingSentinel: 'preserve' });
    assert.deepEqual(saved.naesin.states[code].state, state);
  });

  await t('앱 제한 없는 학생 Bearer도 영어 PC의 독해·다른 앱·가족 경로를 읽거나 쓰지 못하고 DB가 그대로다', async () => {
    const before = fs.readFileSync(path.join(data, 'db.json'), 'utf8');
    const routes = [
      ['/api/pull'], ['/api/state', 'PUT', { state: { ownReadingSentinel: 'must not replace' } }], ['/api/league'], ['/api/pub'],
      ['/api/vocab/pull'], ['/api/vocab/state', 'PUT', { state: { own: true } }],
      ['/api/hanja/pull'], ['/api/hanja/state', 'PUT', { state: { own: true } }],
      ['/api/haru/state'], ['/api/haru/attempt', 'POST', { own: true }],
      ['/api/naesin-ko/state'], ['/api/naesin-ko/state', 'PUT', { state: { own: true } }],
      ['/api/chunk/state'], ['/api/chunk/state', 'PUT', { state: { own: true } }],
      ['/api/letter/state'], ['/api/letter/state', 'PUT', { state: { own: true } }],
      ['/api/parent/summary?t=' + parentToken], ['/api/haru/parent?t=' + parentToken],
      ['/api/chunk/parent?t=' + parentToken], ['/api/chunk/parent/state?t=' + parentToken, 'PUT', { state: { own: true } }],
      ['/api/letter/parent?t=' + parentToken], ['/api/letter/parent/state?t=' + parentToken, 'PUT', { state: { own: true } }],
      ['/api/letter/img/own-picture'], ['/api/portal/family-link', 'POST', { token: randomUUID().replace(/-/g, ''), name: '자체 가족' }],
    ];
    for (const [p, method = 'GET', body] of routes) {
      const blocked = await req(p, { method, body });
      assert.equal(blocked.status, 403, p); assert.match(blocked.json.error, /영어 내신브레인 전용/);
      assert.equal(fs.readFileSync(path.join(data, 'db.json'), 'utf8'), before, p + ' 이후 DB 무변이');
    }
  });

  await t('가족·포털 서비스 자격은 학생 Bearer와 구분하며 기존 독립 계약은 유지한다', async () => {
    assert.equal((await req('/api/parent/summary?t=' + parentToken, { token: null })).status, 200);
    const family = randomUUID().replace(/-/g, '');
    const linked = await req('/api/portal/family-link', { token: portalSecret, method: 'POST', body: { token: family, name: '자체 포털 가족' } });
    assert.equal(linked.status, 200); assert.equal(linked.json.token, family);
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8'));
    assert.deepEqual(saved.portalFamilies[family].apps, ['letter', 'chunk']);
  });

  await t('영어 전용 apps 학생도 토큰 갱신과 공용 알림 구독만 쓰고 어휘 기록은 받지 못한다', async () => {
    assert.equal((await req('/api/naesin/exam', { token: otherToken })).status, 200);
    const refreshed = await req('/api/token/refresh', { token: otherToken, method: 'POST', body: {} });
    assert.equal(refreshed.status, 200); assert.ok(refreshed.json.token);
    assert.equal((await req('/api/naesin/exam', { token: refreshed.json.token })).status, 200);
    assert.equal((await req('/api/vocab/push/key', { token: otherToken })).status, 200);
    assert.equal((await req('/api/vocab/push/subscribe', { token: otherToken, method: 'POST', body: { subscription: { endpoint: 'https://push.example/own-not-real' } } })).status, 200);
    assert.equal((await req('/api/vocab/push/unsubscribe', { token: otherToken, method: 'POST', body: {} })).status, 200);
    assert.equal((await req('/api/vocab/pull', { token: otherToken })).status, 403);
  });

  await t('관리자는 영어 PC에서도 기존 다른 앱의 관리 API를 유지한다', async () => {
    for (const p of ['/api/admin/overview', '/api/vocab/admin/overview', '/api/chunk/admin/overview', '/api/letter/admin/issues', '/api/naesin-ko/admin/packs'])
      assert.equal((await req(p, { token: adminToken })).status, 200, p);
  });

  await t('원내 관리 현황의 고정 영어 앱 메타는 접속망별 capability를 주며 외부 학생 QR을 만들 근거로 쓰지 않는다', async () => {
    for (const [headers, allowed] of [[{}, true], [inside, true], [outside, false]]) {
      const overview = await req('/api/admin/overview', { token: adminToken, headers });
      assert.equal(overview.status, 200); assert.equal(overview.json.studentApp, 'naesin');
      assert.equal(overview.json.localPdfReview, allowed);
      assert.ok(Array.isArray(overview.json.students));
    }
  });

  await t('CF 외부 학생은 로그인·승인 토큰·시험·팩이 403, 관리 토큰도 우회하지 못한다', async () => {
    assert.equal((await req('/api/health', { token: null, headers: outside })).json.localPdfReview, false);
    assert.equal((await req('/api/health', { token: null, headers: inside })).json.localPdfReview, true);
    assert.equal((await req('/api/login', { token: null, headers: outside, method: 'POST', body: { code } })).status, 403);
    const status = await req('/api/login/status?n=test-nonce', { token: null, headers: outside });
    assert.equal(status.status, 403);
    assert.equal(status.json.token, undefined);
    for (const token of [studentToken, adminToken]) for (const p of ['/api/naesin/exam', '/api/naesin/pack?id=' + pack.packId]) {
      const r = await req(p, { token, headers: outside });
      assert.equal(r.status, 403, p);
      assert.equal(r.json.pack, undefined);
      assert.equal(r.json.exam, undefined);
    }
  });

  await t('외부 관리자는 기존 인증으로 현황·배정 메타데이터·관리 화면과 공용 검사기를 받는다', async () => {
    for (const p of ['/api/naesin/admin/overview', '/api/naesin/admin/exams', '/api/naesin/admin/packs'])
      assert.equal((await req(p, { token: adminToken, headers: outside })).status, 200, p);
    assert.equal((await req('/api/naesin/admin/overview', { token: null, headers: outside })).status, 401);
    const html = await req('/admin/naesin-admin.html', { token: null, headers: outside });
    assert.equal(html.status, 200);
    assert.match(html.text, /\/admin\/pack-check\.js/);
    const checker = await req('/admin/pack-check.js', { token: null, headers: outside });
    assert.equal(checker.status, 200);
    assert.match(checker.text, /WBPACKCHECK/);
  });

  await t('외부 관리 토큰에도 raw export·import·팩·제작 원천·투사 문제 경로는 차단', async () => {
    const paths = [
      ['/api/admin/export'], ['/api/admin/import', 'POST'], ['/api/admin/textbook-src'],
      ['/api/naesin/admin/pack?id=' + pack.packId], ['/api/naesin/admin/pack', 'POST'],
      ['/api/naesin/admin/job?id=test-job'], ['/api/naesin/admin/jobs'], ['/api/naesin/admin/job', 'POST'],
      ['/api/naesin/admin/job/draft', 'POST'], ['/api/naesin/admin/live'], ['/api/naesin/admin/live/projector', 'POST'],
      ['/api/naesin/admin/source-library'],
    ];
    for (const [p, method = 'GET'] of paths) {
      const r = await req(p, { token: adminToken, headers: outside, method, ...(method === 'POST' ? { body: {} } : {}) });
      assert.equal(r.status, 403, p);
      assert.equal(r.json.pack, undefined);
      assert.equal(r.json.job, undefined);
      assert.equal(r.json.live, undefined);
    }
  });

  await t('허용된 학원 IP의 CF 접속은 학생 시험·팩과 관리 자료 열람을 허용한다', async () => {
    assert.equal((await req('/api/naesin/exam', { headers: inside })).status, 200);
    assert.equal((await req('/api/naesin/pack?id=' + pack.packId, { headers: inside })).status, 200);
    assert.equal((await req('/api/naesin/admin/pack?id=' + pack.packId, { token: adminToken, headers: inside })).status, 200);
  });

  await t('public Host에서 CF 헤더 누락·loopback 주소 위조·XFF 위조는 모두 차단', async () => {
    for (const headers of [{ host: 'academy.example' }, { host: 'academy.example', 'cf-connecting-ip': '127.0.0.1' },
      { host: 'academy.example', 'cf-connecting-ip': '::ffff:127.0.0.1' },
      { host: 'academy.example', 'x-forwarded-for': '198.51.100.10' }])
      assert.equal((await req('/api/naesin/pack?id=' + pack.packId, { headers })).status, 403, JSON.stringify(headers));
  });

  await t('로컬에서도 외부 AI 원천 추출은 API 키 설정 유무와 무관하게 403', async () => {
    const r = await req('/api/naesin/admin/job/extract', { token: adminToken, method: 'POST', body: { jobId: 'test-job', kind: 'words' } });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /외부 AI/);
  });

  await t('실제 query·readBody·파일 저장으로 반 과제를 분리하고 유효 과제·공통 폴백을 표시한다', async () => {
    const date = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    for (const [scope, title] of [['default', '공통 과제'], [a, 'A 과제'], [b, 'B 과제']])
      assert.equal((await manage('task', scope, { method: 'POST', body: { date, title, typeKeys: ['w-e2k'] } })).status, 200);
    assert.equal((await req('/api/naesin/task')).json.task.title, 'A 과제');
    assert.equal((await req('/api/naesin/task', { token: otherToken })).json.task.title, 'B 과제');
    const rows = (await req('/api/naesin/admin/overview', { token: adminToken })).json.students;
    assert.equal(rows.find(row => row.code === code).assignedTask.title, 'A 과제');
    assert.equal(rows.find(row => row.code === otherCode).assignedTask.title, 'B 과제');
    assert.equal((await manage('task', a, { method: 'DELETE' })).status, 200);
    assert.equal((await req('/api/naesin/task')).json.task.title, '공통 과제');
    assert.equal((await req('/api/naesin/task', { token: otherToken })).json.task.title, 'B 과제');
  });

  await t('두 반이 동시에 투사·응답해도 자기 범위·보드·투표만 받고 한 반 종료는 다른 반을 보존', async () => {
    for (const [scope, chosen] of [[a, pack], [b, otherPack]]) {
      assert.equal((await manage('live/phase', scope, { method: 'POST', body: { phase: { key: 'words', label: scope } } })).status, 200);
      const items = [{ ref: 'same-word-ref', prompt: scope + ' 자체 창작 질문',
        choices: [{ key: 'a', text: '가' }, { key: 'b', text: '나' }], answerKey: 'a' }];
      assert.equal((await manage('live/projector', scope, { method: 'POST', body: { packId: chosen.packId, items } })).status, 200);
    }
    for (const [token, scope, chosen] of [[studentToken, a, pack], [otherToken, b, otherPack]]) {
      const live = await req('/api/naesin/live', { token });
      assert.equal(live.json.scope, scope);
      assert.equal(live.json.live.projector.packId, chosen.packId);
      assert.equal(live.json.live.projector.item.answerKey, undefined);
      assert.equal((await req('/api/naesin/live/answer', { token, method: 'POST', body: { scope, ref: 'same-word-ref', key: 'b' } })).status, 200);
    }
    const aBoard = (await manage('live', a)).json, bBoard = (await manage('live', b)).json;
    assert.deepEqual(aBoard.board.map(row => row.code), [code]);
    assert.deepEqual(bBoard.board.map(row => row.code), [otherCode]);
    assert.deepEqual(Object.keys(aBoard.votes[0].picks), [code]);
    assert.deepEqual(Object.keys(bBoard.votes[0].picks), [otherCode]);
    assert.equal((await manage('live', a, { method: 'DELETE' })).status, 200);
    assert.equal((await manage('live', a)).json.live, null);
    assert.equal((await req('/api/naesin/live', { token: otherToken })).json.live.projector.packId, otherPack.packId);
    assert.equal((await manage('live', b)).json.votes[0].answered, 1);
  });

  await t('실제 HTTP에서도 다른 반 scope·교차 팩 열람·투사 응답을 거절한다', async () => {
    assert.equal((await req('/api/naesin/live?scope=' + encodeURIComponent(b))).status, 403);
    assert.equal((await req('/api/naesin/pack?id=' + otherPack.packId)).status, 403);
    assert.equal((await req('/api/naesin/live/answer', { method: 'POST', body: { scope: b, ref: 'same-word-ref', key: 'a' } })).status, 403);
    const items = [{ ref: 'same-word-ref', prompt: '범위 밖 자체 창작 질문',
      choices: [{ key: 'a', text: '가' }, { key: 'b', text: '나' }], answerKey: 'a' }];
    assert.equal((await manage('live/projector', a, { method: 'POST', body: { packId: otherPack.packId, items } })).status, 200);
    assert.equal((await req('/api/naesin/live')).json.live.projector, null, '관리자가 다른 팩을 띄워도 학생 범위 관문이 차단');
    assert.equal((await req('/api/naesin/live/answer', { method: 'POST', body: { scope: a, ref: 'same-word-ref', key: 'a' } })).status, 403);
  });

  await t('로컬 PDF 후보는 원내 PC 작업에만 저장되며 미검수 상태로 발행되지 않는다', async () => {
    const options = { token: adminToken, method: 'POST' };
    const created = await req('/api/naesin/admin/job', { ...options, body: { packId: 'local-review-fixture' } });
    assert.equal(created.status, 200);
    const jobId = created.json.jobId;
    const localHeaders = { ...inside };
    const localReviewPath = '/api/naesin/admin/job/local-review?id=' + jobId;
    const localPdfPath = '/api/naesin/admin/job/local-pdf?id=' + jobId + '&source=03&sha256=' + 'a'.repeat(64);
    assert.equal((await req(localReviewPath, { token: adminToken, headers: localHeaders })).status, 403, '권리 없는 PC 초안 열기 차단');
    assert.equal((await req(localPdfPath, { token: adminToken, headers: localHeaders })).status, 403, '권리 없는 PDF 원본 열기 차단');
    const rights = { basis:'self_authored', holder:'합성 테스트 전용', evidenceRef:'fixture', studentUseAllowed:true, derivativeUseAllowed:true, externalAiAllowed:false };
    for (const restricted of [{ ...rights, studentUseAllowed:false }, { ...rights, derivativeUseAllowed:false }, { ...rights, expiresAt:'2000-01-01' }]) {
      assert.equal((await req('/api/naesin/admin/job/rights', { token: adminToken, method:'POST', body:{jobId,rights:restricted} })).status, 200);
      assert.equal((await req(localReviewPath, { token: adminToken, headers: localHeaders })).status, 403);
      assert.equal((await req(localPdfPath, { token: adminToken, headers: localHeaders })).status, 403);
    }
    assert.equal((await req('/api/naesin/admin/job/rights', { token: adminToken, method:'POST', body:{jobId,rights} })).status, 200);
    const allowedReview = await req(localReviewPath, { token: adminToken, headers: localHeaders });
    assert.notEqual(allowedReview.status, 403, '권리확인 자료는 파일 부재 등 후속 검사까지 도달');
    const first = pack.words[0];
    const word = Object.fromEntries(['id', 'headword', 'pos', 'meaningKo', 'sections'].map(k => [k, first[k]]));
    word._pdfReview = { flags: ['REVIEW_REQUIRED'], locations: [{ page: 1, bbox: [57, 130, 215, 150] }] };
    const body = { jobId, draft: { words: [word] } };
    assert.equal((await req('/api/naesin/admin/job/draft', { ...options, headers: outside, body })).status, 403);
    const saved = await req('/api/naesin/admin/job/draft', { ...options, body });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.gate.pending, 1);
    assert.equal(saved.json.gate.ok, false);
    assert.ok(saved.json.gate.warns.some(w => w.message.includes('PDF 후보')));
    assert.equal((await req('/api/naesin/admin/job/publish', { ...options, body: { jobId } })).status, 400);
    const loaded = await req('/api/naesin/admin/job?id=' + jobId, { token: adminToken });
    assert.deepEqual(loaded.json.job.draft.words[0]._pdfReview, word._pdfReview);
    assert.equal((await req('/api/naesin/admin/pack?id=local-review-fixture', { token: adminToken })).status, 404);
  });
} finally {
  server.kill();
  await exited;
  assert.equal(fs.realpathSync(data), resolvedData, '시험 디렉터리의 실제 위치가 바뀌면 삭제하지 않는다');
  assert.equal(path.dirname(resolvedData), tempRoot, '삭제 대상이 임시 디렉터리 경계 밖이면 삭제하지 않는다');
  fs.rmSync(resolvedData, { recursive: true, force: true });
}
console.log('\n통과 ' + passed + '개 — 원내 서버 실제 HTTP 경계 검증');
