#!/usr/bin/env node
/* 묶을 주소(HOST) — node reading-server/host-bind.test.mjs
 *
 * 터널로 외부에 열 때 이 서버의 유일한 손님은 같은 PC 의 cloudflared 다. 그런데 서버가 모든 주소
 * (0.0.0.0)에 묶여 있으면 터널·Cloudflare Access 를 거치지 않는 입구가 원내 LAN 에 하나 더 남는다
 * — 같은 와이파이에 붙은 기기는 http://<PC 주소>:8890 으로 관리 로그인 화면까지 바로 온다.
 * 그래서 HOST=127.0.0.1 이면 정말로 루프백에서만 받는지 실제 소켓으로 확인한다.
 *
 * 함께 지키는 것: 관리 전용(WB_ADMIN_ONLY)인데 HOST 를 빠뜨려도 127.0.0.1 로 묶인다(#454 의 기본값 —
 * 원장 PC 의 start-admin.ps1·터널 키트 실행기 둘 다 HOST 를 주지만, 손으로 띄울 때 빠뜨리기 쉽다).
 * 원내 모드에서 HOST 를 비우면 예전 그대로 모든 주소에서 받는다(원내 LAN 사용이 깨지면 안 된다).
 * 이 PC(또는 CI)에 루프백 말고 IPv4 주소가 하나도 없으면 "LAN 에서 막히는가"는 확인할 수 없으니
 * 그 부분만 건너뛰고 그렇다고 출력한다 — 조용히 통과시키지 않는다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PIN = 'test-pin-not-a-real-secret';
const errors = [];
const notes = [];
const ok = (c, m) => { if (!c) errors.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 루프백이 아닌 IPv4 하나 — 이 주소로 붙어 보면 "LAN 의 다른 기기"를 흉내 낼 수 있다 */
function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

/* fetch 대신 TCP 연결만 본다 — 막혔는지(ECONNREFUSED)와 응답이 느린지를 섞지 않으려고 */
const canConnect = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(1500, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

/* 빈 포트를 운영체제에게 받는다 — 고정 범위(예전 8760~)는 sec-headers.test 의 8700~8789 와 겹쳐
   check.mjs 가 병렬로 돌릴 때 가끔 실패했다 */
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

async function boot(host, port, adminOnly = true) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-host-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: data, ADMIN_PIN: PIN };
  if (adminOnly) env.WB_ADMIN_ONLY = '1'; else delete env.WB_ADMIN_ONLY;
  if (host) env.HOST = host; else delete env.HOST;
  const srv = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (b) => { log += b; });
  srv.stderr.on('data', (b) => { log += b; });
  const ready = adminOnly ? /관리 전용/ : /학생 앱:/;
  for (let i = 0; i < 100 && !ready.test(log); i++) await sleep(100);
  return { srv, log: () => log, stop() { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); } };
}

const lan = lanIPv4();
try {
  /* ── HOST=127.0.0.1 ── */
  const p1 = await freePort();
  const a = await boot('127.0.0.1', p1);
  try {
    ok(/관리 전용/.test(a.log()), '서버가 뜨지 않았다: ' + a.log().slice(0, 300));
    ok(a.log().includes(`http://127.0.0.1:${p1}`), '기동 로그가 묶은 주소(127.0.0.1)를 찍지 않는다 — 터널 설정에 옮겨 적을 주소가 없다');
    const r = await fetch(`http://127.0.0.1:${p1}/api/health`);
    ok(r.status === 200, `127.0.0.1 에서 /api/health 가 ${r.status}`);
    if (lan) ok(!(await canConnect(lan, p1)), `HOST=127.0.0.1 인데 LAN 주소 ${lan} 에서 연결된다 — 터널을 거치지 않는 입구가 남는다`);
    else notes.push('루프백 말고 IPv4 가 없어 "LAN 에서 막히는가"는 확인하지 못했다');
  } finally { a.stop(); }

  /* ── 관리 전용인데 HOST 없음 — 그래도 루프백만 ── */
  const p2 = await freePort();
  const b = await boot('', p2);
  try {
    ok(/관리 전용/.test(b.log()), 'HOST 없는 관리 전용 서버가 뜨지 않았다: ' + b.log().slice(0, 300));
    ok(b.log().includes(`http://127.0.0.1:${p2}`), '관리 전용인데 HOST 를 빠뜨리면 127.0.0.1 로 묶여야 한다(기동 로그)');
    ok(await canConnect('127.0.0.1', p2), 'HOST 없는 관리 전용 서버에 127.0.0.1 로 연결되지 않는다');
    if (lan) ok(!(await canConnect(lan, p2)), `관리 전용인데 HOST 를 빠뜨리자 LAN 주소 ${lan} 에서 연결된다 — 터널을 거치지 않는 입구가 남는다`);
  } finally { b.stop(); }

  /* ── 원내 모드 + HOST 없음 — 예전 그대로 모든 주소 ── */
  const p3 = await freePort();
  const c = await boot('', p3, false);
  try {
    ok(/학생 앱:/.test(c.log()), '원내 모드 서버가 뜨지 않았다: ' + c.log().slice(0, 300));
    ok(c.log().includes(`http://localhost:${p3}`), '원내 모드 기동 로그가 바뀌었다');
    ok(await canConnect('127.0.0.1', p3), '원내 모드인데 127.0.0.1 에서 연결되지 않는다');
    /* 위의 "막혔다" 판정이 진짜인지 — 같은 방법으로 열려 있을 때는 붙는다는 것을 보인다 */
    if (lan) ok(await canConnect(lan, p3), `원내 모드에서 HOST 를 비웠는데 LAN 주소 ${lan} 에서 연결되지 않는다 — 원내 LAN 사용이 깨졌다`);
  } finally { c.stop(); }
} catch (e) {
  errors.push('예외: ' + (e && e.message));
}

if (errors.length) {
  console.error('실패 ' + errors.length + '건');
  errors.forEach((m) => console.error('  - ' + m));
  process.exit(1);
}
console.log('OK — HOST=127.0.0.1·관리 전용 기본값은 루프백에서만 받고, 원내 모드에서 비우면 예전처럼 모든 주소' + (notes.length ? ' (참고: ' + notes.join(' / ') + ')' : ''));
