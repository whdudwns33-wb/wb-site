'use strict';
/* 실제 HTTP 원내 모드 — 운영 데이터·원문·외부 AI 없이 자체 창작 샘플만 쓴다. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = fs.realpathSync(os.tmpdir());
const data = fs.mkdtempSync(path.join(tempRoot, 'wbr-inhouse-'));
const resolvedData = fs.realpathSync(data);
assert.equal(path.dirname(resolvedData), tempRoot, '시험 DB는 실제 임시 디렉터리의 바로 아래여야 한다');
const pack = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'naesin', 'pack-sample.json'), 'utf8'));
const code = 'INHOUSE01', studentToken = 'test-student-token', adminToken = 'test-admin-token';
const exp = Date.now() + 3600e3;
fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({
  students: { [code]: { code, name: '원내 시험 학생', cls: '시험반', grade: '중2', level: 'L3' } },
  states: {}, tokens: { [studentToken]: { code, admin: false, exp }, [adminToken]: { code: '__admin__', admin: true, exp } },
  pending: { 'test-nonce': { code, state: 'approved', token: studentToken, exp } },
  naesin: { packs: { [pack.packId]: { pack, updatedAt: new Date().toISOString() } },
    packIds: [pack.packId], states: {}, exams: { default: { examDate: '2099-12-31', packIds: [pack.packId] } } },
}));

const reserve = createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data,
  ADMIN_PIN: 'test-inhouse-pin-not-real', WB_INHOUSE_ONLY: '1', WB_INHOUSE_NETWORKS: '198.51.100.10',
  ANTHROPIC_API_KEY: 'test-inhouse-ai-key-not-real' };
delete env.WB_ADMIN_ONLY;
const server = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
const exited = once(server, 'exit');
let stderr = '';
server.stderr.on('data', chunk => { stderr += chunk; });
const base = `http://127.0.0.1:${port}`;
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
        resolve({ status: response.statusCode, text, json });
      });
    });
    send.on('error', reject);
    send.end(body ? JSON.stringify(body) : undefined);
  });
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode != null) throw new Error('원내 서버 기동 실패: ' + stderr);
    try { ready = (await req('/api/health', { token: null })).status === 200; if (ready) break; } catch { /* 기동 대기 */ }
    await sleep(50);
  }
  assert.ok(ready, '원내 서버가 제한 시간 내 기동하지 않았다: ' + stderr);

  await t('로컬 학생은 시험·자체 창작 팩을 인증 후 학습한다', async () => {
    const exam = await req('/api/naesin/exam');
    assert.equal(exam.status, 200);
    assert.equal(exam.json.scope, 'default');
    const content = await req('/api/naesin/pack?id=' + pack.packId);
    assert.equal(content.status, 200);
    assert.deepEqual(content.json.pack, pack);
    assert.equal((await req('/api/naesin/pack?id=' + pack.packId, { token: null })).status, 401, '로컬이어도 인증은 필요');
  });

  await t('CF 외부 학생은 로그인·승인 토큰·시험·팩이 403, 관리 토큰도 우회하지 못한다', async () => {
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
} finally {
  server.kill();
  await exited;
  assert.equal(fs.realpathSync(data), resolvedData, '시험 디렉터리의 실제 위치가 바뀌면 삭제하지 않는다');
  assert.equal(path.dirname(resolvedData), tempRoot, '삭제 대상이 임시 디렉터리 경계 밖이면 삭제하지 않는다');
  fs.rmSync(resolvedData, { recursive: true, force: true });
}
console.log('\n통과 ' + passed + '개 — 원내 서버 실제 HTTP 경계 검증');
