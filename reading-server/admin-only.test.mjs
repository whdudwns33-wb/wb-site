#!/usr/bin/env node
/* 관리 전용 모드 — node reading-server/admin-only.test.mjs
 *
 * 이 서버를 Cloudflare Tunnel 로 외부에 열 때 쓰는 모드다(docs/로컬-서버-외부공개-터널.md §1-A).
 * 학생 기록의 정본은 운영 워커의 KV 이고 이 서버는 db.json 이라 둘은 섞이지 않는다. 그래서
 * 학생이 어쩌다 외부 주소로 로그인하면 같은 학생의 진도가 두 곳에 따로 쌓인다 — 조용히 갈라지고
 * 되돌리기 어렵다. 막는 자리는 토큰 발급 하나다(토큰은 서명이 아니라 각 저장소에 든 난수라,
 * 워커가 내준 토큰은 여기서 검증되지 않는다).
 *
 * 함께 지키는 것: 관리 웹은 그대로 떠야 한다. 관리 화면들이 학생 앱의 공용 로직 모듈
 * (/naesin/gen.js · /chunk/lessons.js · /haru/plan.js …)을 직접 불러 쓰기 때문에,
 * 그 경로까지 막으면 모드를 켠 순간 관리 웹이 깨진다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PIN = 'test-pin-not-a-real-secret';
const errors = [];
const ok = (c, m) => { if (!c) errors.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(adminOnly, port) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-ao-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: data, ADMIN_PIN: PIN };
  if (adminOnly) env.WB_ADMIN_ONLY = '1'; else delete env.WB_ADMIN_ONLY;
  const srv = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/api/health'); break; } catch { await sleep(100); }
  }
  return { srv, base, data, stop() { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); } };
}
const post = (base, p, body, token) => fetch(base + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body),
});

try {
  /* ── 관리 전용 모드 ── */
  const on = await boot(true, 8610 + (process.pid % 40));
  try {
    const admin = await (await post(on.base, '/api/admin/login', { pin: PIN })).json();
    ok(admin.token, '관리 전용 모드에서 관리 로그인이 막혔다 — 관리 웹을 쓸 수 없다');

    /* 학생을 등록해 둔다. 코드가 실재해도 로그인이 거부되어야 한다 —
       "없는 코드라서 막힌 것" 과 구별하려고 일부러 만든다. */
    await post(on.base, '/api/admin/students',
      { code: 'AOTEST01', name: '관리전용시험', grade: '중2', cls: 'A', level: 'L3' }, admin.token);

    const login = await post(on.base, '/api/login', { code: 'AOTEST01', device: '테스트' });
    ok(login.status === 403, `학생 로그인이 403 이 아니다 (${login.status}) — 로컬에 학생 진도가 쌓인다`);
    const body = await login.json().catch(() => ({}));
    ok(/관리 전용/.test(body.error || ''), '거부 문구가 이유를 알려주지 않는다');

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
  } finally { on.stop(); }

  /* ── 기본(원내) 모드 — 끄면 예전 그대로 ── */
  const off = await boot(false, 8650 + (process.pid % 40));
  try {
    const admin = await (await post(off.base, '/api/admin/login', { pin: PIN })).json();
    await post(off.base, '/api/admin/students',
      { code: 'AOTEST02', name: '기본모드시험', grade: '중2', cls: 'A', level: 'L3' }, admin.token);
    const login = await post(off.base, '/api/login', { code: 'AOTEST02', device: '테스트' });
    ok(login.status === 200, `기본 모드에서 학생 로그인이 ${login.status} — 원내 사용이 막혔다`);
    const b = await login.json().catch(() => ({}));
    ok(b.pending === true && b.nonce, '기본 모드의 연동 요청 응답이 달라졌다');
  } finally { off.stop(); }
} catch (e) {
  errors.push('예외: ' + (e && e.message));
}

if (errors.length) {
  console.error('실패 ' + errors.length + '건');
  errors.forEach((m) => console.error('  - ' + m));
  process.exit(1);
}
console.log('OK — 관리 전용 모드가 학생 토큰 두 자리를 닫고, 관리 웹·공용 모듈·보안 헤더는 그대로 / 기본 모드는 영향 없음');
