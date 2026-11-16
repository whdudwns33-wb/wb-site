#!/usr/bin/env node
/* 관리 전용 모드 — node reading-server/admin-only.test.mjs
 *
 * 이 서버를 Cloudflare Tunnel 로 외부에 열 때 쓰는 모드다(docs/로컬-서버-외부공개-터널.md §1-A).
 * 학생 기록의 정본은 운영 워커의 KV 이고 이 서버는 db.json 이라 둘은 섞이지 않는다. 그래서
 * 학생이 어쩌다 외부 주소로 로그인하면 같은 학생의 진도가 두 곳에 따로 쌓인다 — 조용히 갈라지고
 * 되돌리기 어렵다. 토큰 발급·기존 로컬 학생 토큰·가족 링크 API를 모두 막는다.
 *
 * 함께 지키는 것: 관리 웹은 그대로 떠야 한다. 관리 화면들이 학생 앱의 공용 로직 모듈
 * (/naesin/gen.js · /chunk/lessons.js · /haru/plan.js …)을 직접 불러 쓰기 때문에,
 * 그 경로까지 막으면 모드를 켠 순간 관리 웹이 깨진다.
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PIN = 'test-pin-not-a-real-secret';
const OLD_TOKEN = 'a'.repeat(32), PARENT_TOKEN = 'b'.repeat(32), FAMILY_TOKEN = 'c'.repeat(32);
const IMAGE_ID = 'd'.repeat(32);
const FAMILY_SECRET = 'synthetic-admin-only-family-service-key';
const OLD_CODE = 'AOLEGACY';
const oldState = { state: { syntheticPreserved: true }, updatedAt: '2026-01-01T00:00:00.000Z' };
const seed = {
  students: { [OLD_CODE]: { code: OLD_CODE, name: '자체창작 기존학생', level: 'L3' } },
  states: { [OLD_CODE]: oldState },
  tokens: { [OLD_TOKEN]: { code: OLD_CODE, admin: false, exp: Date.now() + 86_400_000 } },
  parents: { [PARENT_TOKEN]: OLD_CODE },
  letter: { images: { [IMAGE_ID]: { type: 'image/jpeg' } } },
};
const errors = [];
const ok = (c, m) => { if (!c) errors.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(adminOnly) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const data = fs.mkdtempSync(path.join(tempRoot, 'wbr-ao-'));
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify(seed));
  fs.mkdirSync(path.join(data, 'letter-img'));
  fs.writeFileSync(path.join(data, 'letter-img', IMAGE_ID + '.bin'), Buffer.from([255, 216, 255, 217]));
  const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: data, ADMIN_PIN: PIN, ADMIN_ID: '', ADMIN_PASSWORD: '',
    WB_INHOUSE_ONLY: '0', WB_ADMIN_ONLY: adminOnly ? '1' : '0', WB_PARENT_PORTAL_LINK_SECRET: FAMILY_SECRET };
  const srv = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '', spawnError = null;
  srv.stdout.setEncoding('utf8').on('data', text => { output += text; });
  srv.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const exited = new Promise(resolve => { srv.once('exit', resolve); srv.once('error', error => { spawnError = error; resolve(); }); });
  let base;
  async function stop() {
    if (srv.exitCode == null && srv.signalCode == null && !spawnError) srv.kill();
    await exited;
    assert.equal(path.dirname(fs.realpathSync(data)), tempRoot, '정리 대상은 시험 임시 폴더 바로 아래여야 한다');
    fs.rmSync(data, { recursive: true, force: true });
  }
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      assert.ok(!spawnError && srv.exitCode == null && srv.signalCode == null, '소유한 시험 서버 기동 실패: ' + (spawnError?.message || stderr));
      /* OS가 소유 자식에 배정한 포트만 사용한다. 다른 서버의 health를 기동 증거로 삼지 않는다. */
      const listening = output.match(/WB 진로독서 서버 http:\/\/localhost:(\d+)\r?\n/);
      if (listening) {
        const port = Number(listening[1]);
        assert.ok(port > 0 && port <= 65535, 'PORT=0 기동 로그에는 실제 배정된 포트가 필요하다');
        base = `http://127.0.0.1:${port}`;
        try { ready = (await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) })).ok; } catch { /* 기동 대기 */ }
      }
      if (!ready) await sleep(50);
    }
    assert.ok(ready, '시험 서버가 제한 시간 내 기동하지 않았다: ' + stderr);
    return { srv, base, data, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
const post = (base, p, body, token) => fetch(base + p, {
  method: 'POST',
  signal: AbortSignal.timeout(5000),
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body),
});

try {
  /* ── 관리 전용 모드 ── */
  const on = await boot(true);
  try {
    const broken = await fetch(on.base + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'WB_SYNTHETIC_PRIVATE_TEXT',
    });
    ok(broken.status === 500, '관리 전용 JSON 예외의 기존 상태 코드가 달라졌다');
    ok(JSON.stringify(await broken.json()) === JSON.stringify({ error: '서버 오류' }), '로컬 오류 응답에 요청 원문·내부 예외가 실렸다');
    ok(fs.readFileSync(path.join(on.data, 'db.json'), 'utf8') === JSON.stringify(seed), '잘못된 요청이 원본 파일을 바꿨다');

    const admin = await (await post(on.base, '/api/admin/login', { pin: PIN })).json();
    assert.ok(admin.token, '관리 전용 모드에서 관리 로그인이 막혔다 — 관리 웹을 쓸 수 없다');

    /* 학생을 등록해 둔다. 코드가 실재해도 로그인이 거부되어야 한다 —
       "없는 코드라서 막힌 것" 과 구별하려고 일부러 만든다. */
    const registered = await post(on.base, '/api/admin/students',
      { code: 'AOTEST01', name: '관리전용시험', grade: '중2', cls: 'A', level: 'L3' }, admin.token);
    assert.equal(registered.status, 200, '관리 전용 모드 시험 학생 등록 실패');
    assert.equal((await registered.json()).student?.code, 'AOTEST01');

    const login = await post(on.base, '/api/login', { code: 'AOTEST01', device: '테스트' });
    ok(login.status === 403, `학생 로그인이 403 이 아니다 (${login.status}) — 로컬에 학생 진도가 쌓인다`);
    const body = await login.json().catch(() => ({}));
    ok(/관리 전용/.test(body.error || ''), '거부 문구가 이유를 알려주지 않는다');

    /* 토큰 발급만 막으면 이전 원내 모드의 토큰이 쓰기·갱신으로 계속 살아남는다. */
    const headers = { Authorization: 'Bearer ' + OLD_TOKEN, 'Content-Type': 'application/json' };
    for (const [p, method, payload] of [
      ['/api/pull', 'GET'], ['/api/state', 'PUT', { state: { overwritten: true } }],
      ['/api/token/refresh', 'POST', {}], ['/api/naesin-ko/state', 'PUT', { state: { packs: {} } }],
    ]) {
      const r = await fetch(on.base + p, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      ok(r.status === 403, `기존 학생 토큰의 ${p} 가 ${r.status} — 관리 전용 모드를 우회한다`);
    }
    for (const p of ['/api/parent/summary', '/api/haru/parent', '/api/chunk/parent', '/api/letter/parent',
      '/api/letter/parent/state', '/api/chunk/parent/push/key', '/api/letter/parent/push/key']) {
      const r = await fetch(on.base + p + '?t=' + PARENT_TOKEN);
      ok(r.status === 403, `가족 경로 ${p} 가 ${r.status} — 로컬 기록이 가정으로 나간다`);
    }
    const family = await post(on.base, '/api/portal/family-link', { token: FAMILY_TOKEN, name: '자체창작 가족' }, FAMILY_SECRET);
    ok(family.status === 403, '관리 전용 모드가 가족 자동 연결 서비스 키를 통과시켰다');
    const after = JSON.parse(fs.readFileSync(path.join(on.data, 'db.json'), 'utf8'));
    ok(JSON.stringify(after.states[OLD_CODE]) === JSON.stringify(oldState), '거절한 학생 요청이 기존 기록을 바꿨다');
    ok(!after.portalFamilies || !after.portalFamilies[FAMILY_TOKEN], '거절한 가족 연결이 저장됐다');

    /* 토큰이 실제로 나가는 자리도 닫혀 있어야 한다 — 남은 nonce 로 한 번 더 나가면 안 된다 */
    const st = await fetch(on.base + '/api/login/status?n=whatever');
    ok(st.status === 403, `/api/login/status 가 403 이 아니다 (${st.status})`);

    /* 관리 웹과 그것이 쓰는 공용 모듈은 살아 있어야 한다 */
    for (const p of ['/admin/', '/admin/naesin-admin.html', '/naesin/gen.js', '/chunk/lessons.js', '/haru/plan.js']) {
      const r = await fetch(on.base + p);
      ok(r.status === 200, `관리 전용 모드에서 ${p} 가 ${r.status} — 관리 웹이 깨진다`);
    }
    /* 외부에 열리는 모드이므로 보안 헤더는 그대로 */
    const h = await fetch(on.base + '/admin/');
    ok(/noindex/.test(h.headers.get('x-robots-tag') || ''), '관리 전용 모드에서 noindex 가 빠졌다');
    const adminHeaders = { Authorization: 'Bearer ' + admin.token };
    ok((await fetch(on.base + '/api/admin/overview', { headers: adminHeaders })).status === 200, '관리 현황 API가 막혔다');
    ok((await post(on.base, '/api/token/refresh', {}, admin.token)).status === 200, '관리 토큰 갱신이 막혔다');
    ok((await fetch(on.base + '/api/pub')).status === 200, '관리 화면의 발행 상태 지도가 막혔다');
    ok((await fetch(on.base + '/api/letter/img/' + IMAGE_ID)).status === 200, '관리 미리보기가 쓰는 사진 주소가 막혔다');
  } finally { await on.stop(); }

  /* ── 기본(원내) 모드 — 끄면 예전 그대로 ── */
  const off = await boot(false);
  try {
    ok((await fetch(off.base + '/api/pull', { headers: { Authorization: 'Bearer ' + OLD_TOKEN } })).status === 200,
      '기본 모드에서 기존 학생 토큰이 막혔다');
    ok((await fetch(off.base + '/api/parent/summary?t=' + PARENT_TOKEN)).status === 200, '기본 모드에서 기존 부모 링크가 막혔다');
    ok((await post(off.base, '/api/portal/family-link', { token: FAMILY_TOKEN, name: '자체창작 가족' }, FAMILY_SECRET)).status === 200,
      '기본 모드에서 기존 가족 연결 서비스가 막혔다');
    const admin = await (await post(off.base, '/api/admin/login', { pin: PIN })).json();
    assert.ok(admin.token, '기본 모드 관리 로그인 실패');
    const registered = await post(off.base, '/api/admin/students',
      { code: 'AOTEST02', name: '기본모드시험', grade: '중2', cls: 'A', level: 'L3' }, admin.token);
    assert.equal(registered.status, 200, '기본 모드 시험 학생 등록 실패');
    assert.equal((await registered.json()).student?.code, 'AOTEST02');
    const overview = await (await fetch(off.base + '/api/admin/overview', { headers: { Authorization: 'Bearer ' + admin.token }, signal: AbortSignal.timeout(5000) })).json();
    assert.ok(!Object.prototype.hasOwnProperty.call(overview, 'studentApp'), '일반 Node는 영어 전용 QR 메타를 추가하지 않는다');
    assert.ok(!Object.prototype.hasOwnProperty.call(overview, 'localPdfReview'), '일반 Node 기존 현황 계약 유지');
    const login = await post(off.base, '/api/login', { code: 'AOTEST02', device: '테스트' });
    ok(login.status === 200, `기본 모드에서 학생 로그인이 ${login.status} — 원내 사용이 막혔다`);
    const b = await login.json().catch(() => ({}));
    ok(b.pending === true && b.nonce, '기본 모드의 연동 요청 응답이 달라졌다');
    assert.equal((await post(off.base, '/api/admin/pending', { nonce: b.nonce, action: 'approve' }, admin.token)).status, 200);
    const approved = await (await fetch(off.base + '/api/login/status?n=' + b.nonce, { signal: AbortSignal.timeout(5000) })).json();
    assert.ok(approved.token, '기본 모드 교사 승인 뒤 토큰 발급');
    const headers = { Authorization: 'Bearer ' + approved.token, 'Content-Type': 'application/json' };
    const own = { books: [], ownReading: 'generic Node compatibility' };
    const written = await fetch(off.base + '/api/state', { method: 'PUT', headers, body: JSON.stringify({ state: own }), signal: AbortSignal.timeout(5000) });
    assert.equal(written.status, 200, 'WB_INHOUSE_ONLY=0은 기존 독해 쓰기를 유지');
    const pulled = await fetch(off.base + '/api/pull', { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(pulled.status, 200); assert.deepEqual((await pulled.json()).state, own);
    assert.equal((await fetch(off.base + '/api/vocab/pull', { headers, signal: AbortSignal.timeout(5000) })).status, 200, '기본 Node 다른 앱 접근 유지');
  } finally { await off.stop(); }
} catch (e) {
  errors.push('예외: ' + (e && e.message));
}

if (errors.length) {
  console.error('실패 ' + errors.length + '건');
  errors.forEach((m) => console.error('  - ' + m));
  process.exit(1);
}
console.log('OK — 관리 전용 모드가 학생 발급·기존 토큰·가족 API를 닫고, 관리 웹·공용 모듈·사진·보안 헤더는 그대로 / 기본 모드는 영향 없음');
