#!/usr/bin/env node
/* 코드 사본 — node reading-server/tunnel/app-copy.test.mjs
 *
 * 원장 PC 의 작업 스케줄러는 저장소가 아니라 관리자 전용 자리(C:\ProgramData\WB\app)에 복사한 코드를 SYSTEM 으로
 * 돌린다(저장소는 일반 사용자도 고칠 수 있어서). 그래서 두 가지가 틀리면 원장 PC 에서만 조용히 깨진다:
 *  ① 복사 목록(kit.mjs APP_DIRS)이 server.mjs 가 서빙·import 하는 폴더를 다 덮는가 —
 *     server.mjs 에 새 앱 폴더가 생기는 날 목록을 안 고치면 그 앱만 404 가 된다
 *  ② 실제로 복사한 사본에서 서버가 뜨고, 관리 웹과 그것이 쓰는 학생 앱 공용 모듈이 열리는가
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DIRS, APP_MARKER } from './kit.mjs';
import { deployApp } from './setup.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(DIR, '..');
const REPO = path.resolve(SERVER_DIR, '..');
const errors = [];
const ok = (c, m) => { if (!c) errors.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

/* ── ① 목록이 server.mjs 와 맞는가 ── */
const needed = new Set();
for (const f of fs.readdirSync(SERVER_DIR).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) {
  const src = fs.readFileSync(path.join(SERVER_DIR, f), 'utf8');
  for (const m of src.matchAll(/path\.join\([^)]*?'\.\.',\s*'([a-z-]+)'/g)) needed.add(m[1]);
  for (const m of src.matchAll(/from\s+'\.\.\/([a-z-]+)\//g)) needed.add(m[1]);
}
ok(needed.size >= 8, `server.mjs 에서 앱 폴더를 거의 못 찾았다(${needed.size}) — 이 테스트의 정규식이 낡았다`);
for (const d of needed) ok(APP_DIRS.includes(d), `server 가 쓰는 ${d}/ 가 코드 사본 목록(kit.mjs APP_DIRS)에 없다 — 원장 PC 에서 그 앱만 깨진다`);
for (const d of APP_DIRS) ok(fs.existsSync(path.join(REPO, d)), `APP_DIRS 의 ${d}/ 가 저장소에 없다`);

/* ── ② 실제 사본에서 뜨는가 ── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-appcopy-'));
const APP = path.join(TMP, 'app');
let srv = null;
let serverPid = 0;
try {
  deployApp(REPO, APP);
  ok(fs.existsSync(path.join(APP, APP_MARKER)), '사본 표식이 없다');
  ok(!fs.existsSync(path.join(APP, 'reading-server', 'data')), '로컬 학생 기록 폴더가 사본에 들어갔다');
  ok(!fs.existsSync(path.join(APP, 'reading-server', 'dist')), '빌드 산출물이 사본에 들어갔다');
  ok(!fs.existsSync(path.join(APP, 'workbench')) && !fs.existsSync(path.join(APP, '.git')), '서버와 무관한 폴더가 사본에 들어갔다');

  const port = await freePort();
  /* 설정 폴더와 자료 폴더는 겹치면 안 된다(실행기가 거절한다) — 따로 둔다 */
  fs.mkdirSync(path.join(TMP, 'conf'));
  const envFile = path.join(TMP, 'conf', 'server.env');
  fs.writeFileSync(envFile, ['ADMIN_PIN=app-copy-test-pin-123456', `DATA_DIR=${path.join(TMP, 'data')}`, `PORT=${port}`].join('\n'));
  /* 사본의 실행기를 돌린다 — 저장소 쪽 파일을 하나도 쓰지 않아야 한다 */
  srv = spawn(process.execPath, [path.join(APP, 'reading-server', 'tunnel', 'run-server.mjs'), '--env', envFile], { stdio: 'ignore', cwd: APP });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(base + '/api/health')).ok; } catch { await sleep(100); } }
  ok(up, '코드 사본에서 서버가 뜨지 않는다');
  if (up) {
    for (const p of ['/admin/', '/admin/naesin-admin.html', '/naesin/gen.js', '/chunk/lessons.js', '/haru/plan.js', '/letter/', '/hanja/', '/vocab/', '/']) {
      const r = await fetch(base + p);
      ok(r.status === 200, `사본에서 ${p} 가 ${r.status} — 그 폴더가 복사되지 않았거나 경로가 저장소를 가리킨다`);
    }
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ok(login.status === 403, `사본에서 학생 로그인이 ${login.status} — 관리 전용이 빠졌다`);
    const logDir = path.join(TMP, 'data', 'logs');
    const text = fs.existsSync(logDir) ? fs.readdirSync(logDir).map((n) => fs.readFileSync(path.join(logDir, n), 'utf8')).join('') : '';
    serverPid = Number((text.match(/pid (\d+)/) || [])[1]) || 0;
    ok(text.includes(`코드 ${APP}`), '실행기가 사본이 아닌 자리의 코드를 돌린다');
  }
} catch (e) {
  errors.push('예외: ' + (e && e.message));
} finally {
  if (srv && srv.exitCode == null) srv.kill('SIGKILL');
  if (serverPid) { try { process.kill(serverPid, 'SIGKILL'); } catch { /* 이미 끝났다 */ } }
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (errors.length) {
  console.error('실패 ' + errors.length + '건');
  errors.forEach((m) => console.error('  - ' + m));
  process.exit(1);
}
console.log(`OK — 코드 사본: 복사 목록이 server 가 쓰는 폴더 ${needed.size}개를 덮고, 사본에서 서버·관리 웹·공용 모듈이 뜬다(관리 전용)`);
