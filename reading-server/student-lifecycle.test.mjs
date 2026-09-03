#!/usr/bin/env node
/* 학생 한 명의 처음부터 끝까지 — node reading-server/student-lifecycle.test.mjs
 *
 * 등록 → 로그인 요청 → 강사 승인 → 학습 기록(진로독서·내신브레인) → 학부모 링크 → 퇴원 처리.
 * 이 흐름은 개학날 학원에서 실제로 일어나는 순서 그대로다.
 *
 * 특히 퇴원 처리를 꼼꼼히 본다. 학생이 남긴 키를 하나라도 덜 지우면
 * 같은 코드로 새 학생을 등록했을 때 앞 학생의 기록이 그대로 따라오고,
 * 지운 기기가 계속 로그인된 상태로 남는다. 눈에 잘 안 띄는 사고다.
 * 내신브레인의 개별 시험 배정(naesin:exam:<code>)이 그런 키였다 — 남으면 새 학생이
 * 앞 학생의 시험 범위(팩)를 그대로 받는다.
 *
 * 겸해서 로컬 서버의 몸통 상한(팩 4.5MB·기록 300KB → 413 JSON)과 큰 한글 몸통의
 * 조각 경계 디코딩, 예약어 코드('default') 등록 거부도 실제 HTTP 로 확인한다.
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

  /* ⑥-2 내신브레인 — 팩 업로드 → 이 학생만의 시험 배정 → 학습 기록. 퇴원 때 배정·기록이 지워져야 한다.
     팩 본문은 한글을 1MB 남짓 넣는다 — 몸통이 여러 조각으로 오면서 조각 경계에 걸린 한글이 깨지지 않는지 본다. */
  const PACK_ID = 'life-dummy-pack';
  const KO = '더미 문장 — 자체 창작 한글 본문. '.repeat(20000);
  const up = await req('/api/naesin/admin/pack', { method: 'POST', token: admin,
    body: { id: PACK_ID, pack: { packId: PACK_ID, words: [], sentences: [{ en: 'dummy', ko: KO }] } } });
  ok(up.body.ok, '⑥-2 내신 팩 업로드 실패: ' + JSON.stringify(up.body).slice(0, 200));
  const back = await req('/api/naesin/pack?id=' + PACK_ID, { token: admin });
  ok(back.status === 200 && back.body.pack && back.body.pack.sentences[0].ko === KO,
    '⑥-2 큰 한글 팩이 올린 그대로 돌아오지 않는다 — 조각 경계에서 글자가 깨졌다');
  ok((await req('/api/naesin/pack?id=' + PACK_ID, { token: stuTok })).status === 403, '⑥-2 배정 전인데 학생이 팩을 받는다');
  ok((await req('/api/naesin/admin/exam', { method: 'POST', token: admin,
    body: { scope: CODE, examDate: '2099-12-31', packIds: [PACK_ID], wordDeadlineDays: 10 } })).body.ok, '⑥-2 개별 시험 배정 실패');
  const exam = (await req('/api/naesin/exam', { token: stuTok })).body;
  ok(exam.scope === 'student' && exam.exam.wordDeadlineDays === 10, '⑥-2 개별 배정이 학생에게 안 보인다: ' + JSON.stringify(exam));
  ok((await req('/api/naesin/pack?id=' + PACK_ID, { token: stuTok })).status === 200, '⑥-2 배정된 팩을 학생이 못 받는다');
  ok((await req('/api/naesin/state', { method: 'PUT', token: stuTok,
    body: { state: { marker: 'naesin-life', summary: { packId: PACK_ID, word: { total: 1, reached: 1 } } } } })).body.ok, '⑥-2 내신 기록 저장 실패');
  ok((await req('/api/naesin/state', { token: stuTok })).body.state?.marker === 'naesin-life', '⑥-2 내신 기록을 다시 못 읽는다');
  const exams = (await req('/api/naesin/admin/exams', { token: admin })).body.exams || [];
  ok(exams.some(e => e.scope === CODE && e.name === '수명시험' && e.expired === false), '⑥-2 배정 현황에 학생별 배정이 없다');
  ok((await req('/api/naesin/admin/pack', { method: 'DELETE', token: admin, body: { id: PACK_ID } })).status === 409,
    '⑥-2 배정 중인 팩이 지워졌다 — 409 여야 한다');

  /* ⑥-3 몸통 상한 — 5MB 팩·400KB 기록은 413 JSON 으로 끝나야 한다(500·연결 끊김이 아니라).
     content-length 가 있는 요청(선검사)과 없는 chunked 요청(스트림 상한) 둘 다. */
  const huge = await req('/api/naesin/admin/pack', { method: 'POST', token: admin,
    body: { id: PACK_ID, pack: { packId: PACK_ID, blob: 'x'.repeat(5_000_000) } } });
  ok(huge.status === 413 && huge.body.error, '⑥-3 5MB 팩이 413 JSON 이 아니다: ' + huge.status);
  const bigState = await req('/api/naesin/state', { method: 'PUT', token: stuTok, body: { state: { blob: 'x'.repeat(400_000) } } });
  ok(bigState.status === 413, '⑥-3 400KB 기록이 413 이 아니다: ' + bigState.status);
  const chunkedBody = JSON.stringify({ state: { blob: 'y'.repeat(400_000) } });
  const chunked = await fetch(BASE + '/api/naesin/state', {
    method: 'PUT', duplex: 'half',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + stuTok },
    body: new ReadableStream({ start(c) { for (let i = 0; i < chunkedBody.length; i += 65536) c.enqueue(new TextEncoder().encode(chunkedBody.slice(i, i + 65536))); c.close(); } }),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  ok(chunked.status === 413 && chunked.body.error, '⑥-3 chunked 400KB 기록이 413 JSON 이 아니다: ' + chunked.status);
  ok((await req('/api/naesin/state', { token: stuTok })).body.state?.marker === 'naesin-life', '⑥-3 거절된 기록이 저장본을 덮어썼다');
  ok((await req('/api/naesin/pack?id=' + PACK_ID, { token: admin })).body.pack?.sentences?.[0]?.ko === KO, '⑥-3 거절된 팩이 저장본을 덮어썼다');

  /* ⑥-4 예약어 코드 — 'default' 는 내신 반 공통 배정 키라 학생 코드로 못 쓴다(대소문자 무관, 명단 붙여넣기도) */
  ok((await req('/api/admin/students', { method: 'POST', token: admin, body: { code: 'Default', name: '예약어' } })).status === 400,
    '⑥-4 default 코드로 학생이 등록됐다');
  const bulk = (await req('/api/admin/students/bulk', { method: 'POST', token: admin,
    body: { text: '예약어학생 | 중2 | A | DEFAULT\n정상학생 | 중2 | A | LIFEBULK01', cls: 'A' } })).body;
  ok(bulk.created === 1 && (bulk.errors || []).some(e => e.includes('DEFAULT')), '⑥-4 명단의 DEFAULT 줄이 걸러지지 않았다: ' + JSON.stringify(bulk));
  ok((await req('/api/admin/students', { method: 'DELETE', token: admin, body: { code: 'default' } })).status !== 200, '⑥-4 default 학생이 존재한다');
  await req('/api/admin/students', { method: 'DELETE', token: admin, body: { code: 'LIFEBULK01' } });

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
  ok(!((await req('/api/naesin/admin/exams', { token: admin })).body.exams || []).some(e => e.scope === CODE),
    '⑨ 퇴원했는데 내신 개별 시험 배정이 남아 있다');
  ok(!((await req('/api/naesin/admin/overview', { token: admin })).body.students || []).some(s => s.code === CODE),
    '⑨ 퇴원했는데 내신 성취도 목록에 남아 있다');

  /* ⑩ 같은 코드로 새 학생을 받으면 앞 학생 기록이 따라오면 안 된다 */
  await req('/api/admin/students', { method: 'POST', token: admin, body: { code: CODE, name: '새학생', level: 'L3' } });
  const relog = (await req('/api/login', { method: 'POST', body: { code: CODE, device: '새폰' } })).body;
  await req('/api/admin/pending', { method: 'POST', token: admin, body: { nonce: relog.nonce, action: 'approve' } });
  const newTok = (await req('/api/login/status?n=' + relog.nonce)).body.token;
  const carried = (await req('/api/pull', { token: newTok })).body.state?.readings;
  ok(!carried || !Object.keys(carried).length, '⑩ 같은 코드의 새 학생에게 앞 학생 기록이 따라왔다');
  ok(!Object.keys((await req('/api/naesin/state', { token: newTok })).body.state || {}).length, '⑩ 새 학생에게 앞 학생의 내신 기록이 따라왔다');
  ok((await req('/api/naesin/exam', { token: newTok })).body.scope !== 'student', '⑩ 새 학생에게 앞 학생의 개별 시험 배정이 따라왔다');
  ok((await req('/api/naesin/pack?id=' + PACK_ID, { token: newTok })).status === 403, '⑩ 새 학생이 앞 학생의 팩을 받는다');
  await req('/api/admin/students', { method: 'DELETE', token: admin, body: { code: CODE } });
  /* 배정이 없어졌으니 팩도 지워진다 — 목록에서도 빠진다 */
  ok((await req('/api/naesin/admin/pack', { method: 'DELETE', token: admin, body: { id: PACK_ID } })).body.ok, '⑩ 배정 해제 뒤에도 팩이 안 지워진다');
  ok(!((await req('/api/naesin/admin/packs', { token: admin })).body.packs || []).includes(PACK_ID), '⑩ 지운 팩이 목록에 남아 있다');

  await sleep(500); /* 저장은 300ms 디바운스 — 파일까지 반영되기를 기다린다 */
  const disk = fs.readFileSync(path.join(DATA, 'db.json'), 'utf8');
  ok(!disk.includes(CODE), '⑪ 저장 파일에 지운 학생 코드가 남아 있다');
  ok(!disk.includes(PACK_ID) && !disk.includes('자체 창작 한글 본문'), '⑪ 저장 파일에 지운 팩이 남아 있다');
  /* 일일 스냅샷은 팩 본문을 싣지 않는다 — 라이선스 원문이 백업 파일로 흩어지지 않게 */
  const snapDay = (await req('/api/admin/backup-now', { method: 'POST', token: admin })).body.day;
  const snap = (await req('/api/admin/export?backup=' + snapDay, { token: admin })).body;
  ok(snap.naesin && Array.isArray(snap.naesin.packIds) && !('packs' in snap.naesin) && 'textbookSrc' in snap, '⑪ 스냅샷 모양이 워커 fullDump 와 다르다: ' + Object.keys(snap.naesin || {}));
  const exp = (await req('/api/admin/export', { token: admin })).body;
  ok(exp.naesin && !('packs' in exp.naesin) && 'exams' in exp.naesin && 'textbookSrc' in exp, '⑪ export 에 팩 본문이 실리거나 내신·교재 원문이 빠졌다');
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
console.log('OK — 등록·승인 게이트·기록(진로독서·내신)·몸통 상한·예약어·학부모 링크·퇴원 처리(잔여 0) 통과');
