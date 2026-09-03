#!/usr/bin/env node
/* 학생 한 명의 처음부터 끝까지 — node reading-server/student-lifecycle.test.mjs
 *
 * 등록 → 로그인 요청 → 강사 승인 → 학습 기록 → 학부모 링크 → 퇴원 처리.
 * 이 흐름은 개학날 학원에서 실제로 일어나는 순서 그대로다.
 *
 * 특히 퇴원 처리를 꼼꼼히 본다. 학생이 남긴 키를 하나라도 덜 지우면
 * 같은 코드로 새 학생을 등록했을 때 앞 학생의 기록이 그대로 따라오고,
 * 지운 기기가 계속 로그인된 상태로 남는다. 눈에 잘 안 띄는 사고다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8900 + (process.pid % 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-life-'));
const PIN = 'wb-admin-2026';
const BASE = `http://127.0.0.1:${PORT}`;
const errors = [];
const E = (m) => errors.push(m);
const ok = (cond, m) => { if (!cond) E(m); };

const srv = spawn(process.execPath, [path.join(DIR, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_PIN: PIN },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function req(p, opt = {}) {
  const r = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opt.token ? { Authorization: 'Bearer ' + opt.token } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

try {
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + '/api/health'); break; } catch { await sleep(100); }
  }

  const admin = (await req('/api/admin/login', { method: 'POST', body: { pin: PIN } })).body.token;
  ok(admin, '관리자 로그인 실패');

  const CODE = 'LIFETEST01';
  /* ① 등록 */
  ok((await req('/api/admin/students', { method: 'POST', token: admin,
    body: { code: CODE, name: '수명시험', grade: '중2', cls: 'A', level: 'L3' } })).body.ok, '① 학생 등록 실패');

  /* ② 학생이 코드를 넣으면 바로 들어가지지 않고 승인 대기여야 한다 */
  const login = (await req('/api/login', { method: 'POST', body: { code: CODE, device: '테스트폰' } })).body;
  ok(!login.token, '② 승인 없이 토큰이 바로 나왔다 — 승인 게이트가 뚫렸다');
  ok(login.nonce, '② 승인 대기 번호가 없다');

  /* ③ 강사 승인 전에는 여전히 못 들어간다 */
  ok(!(await req('/api/login/status?n=' + login.nonce)).body.token, '③ 승인 전인데 토큰이 나왔다');

  /* ④ 승인 줄에 보여야 강사가 누를 수 있다 */
  const pend = (await req('/api/admin/pending', { token: admin })).body.pending || [];
  ok(pend.some(x => x.code === CODE), '④ 승인 대기 목록에 안 보인다');

  /* ⑤ 승인 → 토큰 */
  await req('/api/admin/pending', { method: 'POST', token: admin, body: { nonce: login.nonce, action: 'approve' } });
  const stuTok = (await req('/api/login/status?n=' + login.nonce)).body.token;
  ok(stuTok, '⑤ 승인했는데 토큰이 안 나온다');

  /* ⑥ 학습 기록 저장 */
  ok((await req('/api/state', { method: 'PUT', token: stuTok,
    body: { state: { profile: { level: 'L3' }, readings: { 'nuri-space': { date: '2026-08-31' } } } } })).body.ok, '⑥ 기록 저장 실패');
  ok((await req('/api/pull', { token: stuTok })).body.state?.readings?.['nuri-space'], '⑥ 저장한 기록을 다시 못 읽는다');

  /* ⑥-2 내신 두 앱에도 기록을 남긴다 — 퇴원 처리가 이것들까지 지우는지 ⑪에서 확인한다.
     국어는 요약·서술형 답안·오버레이가 state와 다른 키에 있어 하나만 지워서는 안 된다
     (국어 기획서 §8 저장 예산 · §10-7 개인정보 삭제). */
  await req('/api/naesin/state', { method: 'PUT', token: stuTok, body: { state: { v: 1, packs: {} } } });
  await req('/api/naesin-ko/state', { method: 'PUT', token: stuTok,
    body: { state: { v: 1, packs: {} }, summary: { works: 1, complete: 0 } } });
  await req('/api/naesin-ko/review', { method: 'POST', token: stuTok,
    body: { review: { itemId: 'it-1', packId: 'dummy-ko-u1', answer: '학생이 쓴 서술형 답안', verdict: 'hold' } } });
  await req('/api/naesin-ko/admin/overlay', { method: 'POST', token: admin,
    body: { scope: CODE, overrides: [{ targetRef: 'b-1', answers: ['학교 정답'] }], notes: [] } });
  ok((await req('/api/naesin-ko/review', { token: stuTok })).body.reviews?.length === 1,
    '⑥-2 국어 서술형 제출이 저장되지 않았다');

  /* ⑦ 학부모 링크 */
  const ptok = (await req('/api/admin/parentlink', { method: 'POST', token: admin, body: { code: CODE } })).body.token;
  ok(ptok, '⑦ 학부모 링크 발급 실패');
  ok((await req('/api/parent/summary?t=' + ptok)).status === 200, '⑦ 학부모 링크로 요약을 못 본다');

  /* ⑧ 퇴원 처리 */
  const del = await req('/api/admin/students', { method: 'DELETE', token: admin, body: { code: CODE } });
  ok(del.body.ok, '⑧ 퇴원 처리 실패: ' + JSON.stringify(del.body));

  /* ⑨ 정말 다 지워졌는가 — 하나씩 확인한다 */
  ok((await req('/api/admin/students', { method: 'DELETE', token: admin, body: { code: CODE } })).status === 404,
    '⑨ 지운 학생이 아직 남아 있다');
  ok((await req('/api/pull', { token: stuTok })).status !== 200,
    '⑨ 퇴원한 학생의 기기 토큰이 아직 살아 있다 — 그 폰은 계속 기록을 본다');
  ok((await req('/api/parent/summary?t=' + ptok)).status !== 200,
    '⑨ 퇴원했는데 학부모 링크가 아직 열린다');
  ok(!((await req('/api/admin/pending', { token: admin })).body.pending || []).some(x => x.code === CODE),
    '⑨ 승인 대기 줄에 지운 학생이 남아 있다');
  ok((await req('/api/admin/student/' + CODE, { token: admin })).status === 404,
    '⑨ 지운 학생의 상세가 아직 200 이다 — 관리 화면이 빈 상세 창을 열다 터진다');

  /* ⑩ 같은 코드로 새 학생을 받으면 앞 학생 기록이 따라오면 안 된다 */
  await req('/api/admin/students', { method: 'POST', token: admin, body: { code: CODE, name: '새학생', level: 'L3' } });
  const relog = (await req('/api/login', { method: 'POST', body: { code: CODE, device: '새폰' } })).body;
  await req('/api/admin/pending', { method: 'POST', token: admin, body: { nonce: relog.nonce, action: 'approve' } });
  const newTok = (await req('/api/login/status?n=' + relog.nonce)).body.token;
  const carried = (await req('/api/pull', { token: newTok })).body.state?.readings;
  ok(!carried || !Object.keys(carried).length, '⑩ 같은 코드의 새 학생에게 앞 학생 기록이 따라왔다');
  await req('/api/admin/students', { method: 'DELETE', token: admin, body: { code: CODE } });

  await sleep(500); /* 저장은 300ms 디바운스 — 파일까지 반영되기를 기다린다 */
  const disk = fs.readFileSync(path.join(DATA, 'db.json'), 'utf8');
  ok(!disk.includes(CODE), '⑪ 저장 파일에 지운 학생 코드가 남아 있다');
  ok(!disk.includes('학생이 쓴 서술형 답안'),
    '⑪ 퇴원했는데 국어 서술형 답안이 남아 있다 — state만 지우면 review 키가 남는다');
} catch (e) {
  E('예외: ' + e.message);
} finally {
  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
}

if (errors.length) {
  errors.forEach(e => console.error('ERROR:', e));
  console.error(`\nFAIL — ${errors.length}건`);
  process.exit(1);
}
console.log('OK — 등록·승인 게이트·기록(진로독서·내신·국어)·학부모 링크·퇴원 처리(잔여 0) 12단계 통과');
