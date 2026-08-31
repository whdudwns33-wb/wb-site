#!/usr/bin/env node
/* 학생 계정 일괄 발급 — node reading-server/enroll.mjs <명단.csv> [--dry]
 *
 *   CSV (첫 줄은 머리글, UTF-8):  이름,학년,반
 *   예)  김서준,초4,화목B
 *
 * 학생 코드는 이 앱의 유일한 자격 증명이다(비밀번호가 없다).
 * wb-101, wb-102 처럼 순번을 매기면 옆자리 친구가 한 번에 알아맞힐 수 있으므로
 * 헷갈리는 글자(0/O, 1/l/I)를 뺀 31자 알파벳에서 6자를 무작위로 뽑는다.
 *
 * 환경변수: BASE(기본 https://wb-reading.whdudwns33.workers.dev), ADMIN_PIN(필수)
 */
import fs from 'node:fs';

const BASE = process.env.BASE || 'https://wb-reading.whdudwns33.workers.dev';
const PIN = process.env.ADMIN_PIN;
const DRY = process.argv.includes('--dry');
const file = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'));

if (!file) { console.error('사용법: node reading-server/enroll.mjs <명단.csv> [--dry]'); process.exit(1); }
if (!PIN && !DRY) { console.error('ADMIN_PIN 환경변수가 필요합니다. (--dry 는 PIN 없이 미리보기만)'); process.exit(1); }

/* 학년 → 읽는 글 */
const LEVEL_OF = { '7세':'L1','유치':'L1','초1':'L1','초2':'L1',
                   '초3':'L2','초4':'L2','초5':'L2','초6':'L2',
                   '중1':'L3','중2':'L3','중3':'L3',
                   '고1':'L4','고2':'L4','고3':'L4' };
const LEVEL_LABEL = { L1:'7세~초2', L2:'초3~6', L3:'중1~3', L4:'고1~3' };

const ALPHA = '23456789abcdefghjkmnpqrstuvwxyz';   // 0 O 1 l i o 제외
const newCode = () => 'wb-' + Array.from({length:6}, () => ALPHA[Math.floor(Math.random()*ALPHA.length)]).join('');

const rows = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/)
  .map(l => l.split(',').map(s => s.trim()))
  .filter(c => c.length >= 2 && c[0] && !/^(이름|name)$/i.test(c[0]))
  .map(([name, grade, cls]) => ({ name, grade: grade || '', cls: cls || '' }));

if (!rows.length) { console.error('명단이 비어 있습니다.'); process.exit(1); }

const bad = rows.filter(r => r.grade && !LEVEL_OF[r.grade]);
if (bad.length) {
  console.error('알 수 없는 학년: ' + bad.map(r => `${r.name}(${r.grade})`).join(', '));
  console.error('쓸 수 있는 값: ' + Object.keys(LEVEL_OF).join(' / '));
  process.exit(1);
}

const api = async (path, opts = {}, token) => {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → ${r.status} ${j.error || ''}`);
  return j;
};

const main = async () => {
  let token = null, taken = new Set();
  if (!DRY) {
    token = (await api('/api/admin/login', { method:'POST', body: JSON.stringify({ pin: PIN }) })).token;
    const ov = await api('/api/admin/overview', {}, token);
    taken = new Set((ov.students || []).map(s => s.code));
    console.log(`기존 등록 ${taken.size}명 — 코드 중복을 피해 발급합니다.\n`);
  }

  const out = [];
  for (const r of rows) {
    let code; do { code = newCode(); } while (taken.has(code));
    taken.add(code);
    const level = LEVEL_OF[r.grade] || '';
    if (!DRY) await api('/api/admin/students', { method:'POST', body: JSON.stringify({ ...r, code, level }) }, token);
    out.push({ ...r, code, level });
  }

  const w = (s, n) => String(s).padEnd(n - [...String(s)].filter(c => c.charCodeAt(0) > 0x1100).length);
  console.log(DRY ? '── 미리보기 (서버에 반영하지 않음) ──' : '── 발급 완료 ──');
  console.log(w('이름',10) + w('학년',8) + w('반',12) + w('학생 코드',14) + '읽는 글');
  out.forEach(s => console.log(w(s.name,10) + w(s.grade,8) + w(s.cls,12) + w(s.code,14) + (LEVEL_LABEL[s.level] || '-')));
  console.log(`\n총 ${out.length}명.`);

  const csv = '이름,학년,반,학생코드,읽는글\n' + out.map(s => [s.name, s.grade, s.cls, s.code, LEVEL_LABEL[s.level] || ''].join(',')).join('\n') + '\n';
  const outFile = file.replace(/\.csv$/i, '') + '-발급결과.csv';
  fs.writeFileSync(outFile, '﻿' + csv);
  console.log(`배부용 파일: ${outFile}`);
  console.log('학생 코드는 비밀번호나 마찬가지입니다 — 단체 채팅방에 한꺼번에 올리지 말고 개별로 전달하세요.');
};

main().catch(e => { console.error('실패:', e.message); process.exit(1); });
