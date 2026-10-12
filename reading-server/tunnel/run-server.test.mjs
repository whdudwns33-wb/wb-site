#!/usr/bin/env node
/* 관리 서버 실행기 — node reading-server/tunnel/run-server.test.mjs
 *
 * 원장 PC 의 작업 스케줄러가 부팅 때 띄우는 것이 이 실행기다. 화면이 없는 자리라 틀려도 아무도 못 본다.
 * 그래서 실제로 띄워서 확인한다:
 *  - 설정이 틀리면 띄우지 않고, 오류에 비밀 값을 찍지 않는다
 *  - 띄우면 관리 전용(학생 로그인 403) + 127.0.0.1 이고, 출력이 날짜별 로그 파일에 남는다
 *  - 실행기를 띄운 셸에 남아 있던 옛 PIN 으로는 관리 로그인이 안 된다(파일 값만 쓴다)
 *  - 실행기가 강제로 죽어도 서버가 고아로 남아 포트를 잡고 있지 않는다
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(DIR, 'run-server.mjs');
const errors = [];
const ok = (c, m) => { if (!c) errors.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canConnect = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(1000, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

/* 빈 포트를 운영체제에게 받는다 — 고정 범위는 check.mjs 가 병렬로 돌리는 다른 서버 테스트와 겹친다 */
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-run-'));
const PORT = await freePort();
const PASSWORD = 'file-password-not-real-123';
const writeEnv = (name, lines) => { const f = path.join(TMP, name); fs.writeFileSync(f, lines.join('\r\n')); return f; };

let launcher = null;
try {
  /* ── 틀린 설정은 띄우지 않는다 ── */
  const SHORT = 'shortpin-xyz';
  const bad = writeEnv('bad.env', [`ADMIN_PIN=${SHORT}`, `DATA_DIR=${path.join(TMP, 'data-bad')}`, 'HOST=0.0.0.0']);
  const rb = spawnSync(process.execPath, [RUN, '--env', bad, '--check'], { encoding: 'utf8' });
  ok(rb.status === 1, `틀린 설정인데 종료 코드가 ${rb.status}`);
  ok(/ADMIN_PIN/.test(rb.stderr) && /HOST/.test(rb.stderr), '무엇이 틀렸는지 알려주지 않는다: ' + rb.stderr);
  ok(!rb.stderr.includes(SHORT) && !rb.stdout.includes(SHORT), '오류 출력에 PIN 값이 찍혔다');
  ok(!fs.existsSync(path.join(TMP, 'data-bad')), '틀린 설정인데 자료 폴더를 만들었다');

  const missing = spawnSync(process.execPath, [RUN, '--env', path.join(TMP, 'none.env'), '--check'], { encoding: 'utf8' });
  ok(missing.status === 1 && /setup\.mjs env/.test(missing.stderr), '설정 파일이 없을 때 견본 만드는 법을 알려주지 않는다');

  /* ── 깨진 db.json 이면 띄우지 않는다(빈 DB 가 원본을 덮어쓰는 길을 막는다) ── */
  const BROKEN = path.join(TMP, 'data-broken');
  fs.mkdirSync(BROKEN, { recursive: true });
  const brokenBody = '{"students": {"A": ';
  fs.writeFileSync(path.join(BROKEN, 'db.json'), brokenBody);
  const benv = writeEnv('broken.env', ['ADMIN_PIN=pin-long-enough-1234567', `DATA_DIR=${BROKEN}`, `PORT=${PORT}`]);
  const rbk = spawnSync(process.execPath, [RUN, '--env', benv], { encoding: 'utf8', timeout: 15000 });
  ok(rbk.status === 2, `깨진 db.json 인데 종료 코드가 ${rbk.status} — 서버를 띄웠을 수 있다`);
  ok(fs.readFileSync(path.join(BROKEN, 'db.json'), 'utf8') === brokenBody, '깨진 db.json 을 건드렸다 — 되살릴 원본이 사라진다');
  ok(!(await canConnect(PORT)), '깨진 db.json 인데 서버가 떠 있다');
  const blog = fs.readdirSync(path.join(BROKEN, 'logs')).map((n) => fs.readFileSync(path.join(BROKEN, 'logs', n), 'utf8')).join('');
  ok(/띄우지 않습니다/.test(blog), '깨진 db.json 을 로그에 남기지 않는다 — 화면 없는 PC 에서 아무도 모른다');

  /* ── 정상 설정 ── */
  const DATA = path.join(TMP, 'data');
  const good = writeEnv('server.env', ['# 시험', 'ADMIN_ID=wonjang', `ADMIN_PASSWORD="${PASSWORD}"`, `DATA_DIR=${DATA}`, `PORT=${PORT}`]);
  const rc = spawnSync(process.execPath, [RUN, '--env', good, '--check'], { encoding: 'utf8' });
  ok(rc.status === 0 && /설정 확인 ✓/.test(rc.stdout), '정상 설정이 --check 를 통과하지 못한다: ' + rc.stdout + rc.stderr);
  ok(!rc.stdout.includes(PASSWORD), '--check 출력에 비밀번호가 찍혔다');

  /* 셸에 옛 PIN·HOST·관리 전용 끔이 남아 있는 상황을 일부러 만든다 */
  const STALE_PIN = 'stale-shell-pin-should-not-work';
  launcher = spawn(process.execPath, [RUN, '--env', good], {
    env: { ...process.env, ADMIN_PIN: STALE_PIN, HOST: '0.0.0.0', WB_ADMIN_ONLY: '0' }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(base + '/api/health')).ok; } catch { await sleep(100); } }
  ok(up, '실행기가 서버를 띄우지 못했다');
  if (up) {
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'X', device: 't' }) });
    ok(login.status === 403, `학생 로그인이 ${login.status} — 관리 전용이 강제되지 않았다`);
    const stale = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: STALE_PIN }) });
    ok(stale.status !== 200, '셸에 남은 옛 PIN 으로 관리 로그인이 됐다');
    const real = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'wonjang', password: PASSWORD }) });
    ok(real.status === 200, `설정 파일의 아이디·비밀번호로 관리 로그인이 안 된다(${real.status})`);

    await sleep(300);
    const logs = fs.existsSync(path.join(DATA, 'logs')) ? fs.readdirSync(path.join(DATA, 'logs')) : [];
    ok(logs.some((n) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(n)), '날짜별 로그 파일이 없다: ' + logs.join(','));
    const text = logs.map((n) => fs.readFileSync(path.join(DATA, 'logs', n), 'utf8')).join('');
    ok(/\[관리 전용\]/.test(text), '로그에 [관리 전용] 줄이 없다');
    ok(text.includes(`http://127.0.0.1:${PORT}`), '로그에 묶은 주소가 없다');
    ok(!text.includes(PASSWORD) && !text.includes(STALE_PIN), '로그에 비밀이 찍혔다');

    /* 실행기를 강제로 죽인다(작업 끝내기·비정상 종료 흉내) — 서버도 같이 사라져야 한다 */
    launcher.kill('SIGKILL');
    let closed = false;
    for (let i = 0; i < 50 && !closed; i++) { await sleep(100); closed = !(await canConnect(PORT)); }
    ok(closed, '실행기가 죽었는데 서버가 고아로 남아 포트를 잡고 있다');
  }
} catch (e) {
  errors.push('예외: ' + (e && e.message));
} finally {
  if (launcher && launcher.exitCode == null) launcher.kill('SIGKILL');
  await sleep(200);
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (errors.length) {
  console.error('실패 ' + errors.length + '건');
  errors.forEach((m) => console.error('  - ' + m));
  process.exit(1);
}
console.log('OK — 실행기: 틀린 설정 거절(값 비노출) · 깨진 db.json 이면 띄우지 않음(원본 보존) · 관리 전용·127.0.0.1 강제 · 셸의 옛 비밀 무시 · 날짜별 로그 · 실행기가 죽으면 서버도 정리');
