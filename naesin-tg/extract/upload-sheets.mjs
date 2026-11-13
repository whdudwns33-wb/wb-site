#!/usr/bin/env node
/* 문제지 파일(build-sheet.mjs 결과)을 운영 서버에 **닫힌 채로** 한꺼번에 올린다 — 관리 웹 대신 터미널에서.
   node naesin-tg/extract/upload-sheets.mjs <폴더|파일.sheet.json ...> [--first id,id] [--force] [--dry]

   환경변수: ADMIN_PIN 또는 ADMIN_ID·ADMIN_PASSWORD(관리 로그인, 필수) · BASE(기본 운영 워커)
   enroll.mjs 와 같은 길이다: 관리 로그인 → 관리 API. 서버가 관리 웹과 같은 검사를 한다.

   - 항상 open:false 로 올린다. 정답 입력과 「열기」는 관리 웹에서 강사가 한다.
   - 서버에 이미 있는 id 는 건너뛴다(--force 일 때만 덮어쓴다) — 강사가 넣은 정답과 「열기」를 지우지 않으려고.
   - 순서: 정보(닫힘) → 쪽 그림. 중간에 끊겨도 반쯤 올라간 문제지가 학생에게 보이지 않는다.
   - 구매 자료다: 파일은 저장소 밖에 두고, 여기서 지면 내용을 출력하지 않는다. */
import fs from 'node:fs';
import path from 'node:path';

export const BASE_DEFAULT = 'https://wb-reading.whdudwns33.workers.dev';

/* 올릴 파일 목록 — 폴더면 그 안의 *.sheet.json. --first 로 준 id 를 맨 앞에 둔다(첫 판 범위부터). */
export function collectFiles(inputs, first = []) {
  const files = [];
  for (const p of inputs) {
    if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) { if (f.endsWith('.sheet.json')) files.push(path.join(p, f)); }
    else files.push(p);
  }
  const rank = (f) => { const i = first.indexOf(path.basename(f, '.sheet.json')); return i < 0 ? first.length : i; };
  return files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/* 한 건 올리기 — api(path, body) 는 POST 하고 실패하면 던진다. 테스트가 가짜 api 를 넣는다. */
export async function uploadOne(api, file) {
  if (!file || !/^[A-Za-z0-9-]{3,60}$/.test(file.id || '') || !file.sheet || !Array.isArray(file.pages) || !file.pages.length) {
    throw new Error('build-sheet.mjs 가 만든 문제지 파일이 아니에요');
  }
  await api('/api/naesin-tg/admin/sheet', { id: file.id, sheet: { ...file.sheet, open: false } });
  for (let i = 0; i < file.pages.length; i += 1) await api('/api/naesin-tg/admin/page', { id: file.id, n: i + 1, data: file.pages[i] });
  return file.pages.length;
}

if (process.argv[1] && import.meta.url === new URL('file://' + path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf('--' + k); return i < 0 ? '' : args[i + 1]; };
  const flag = (k) => args.includes('--' + k);
  const inputs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--first');
  const BASE = process.env.BASE || BASE_DEFAULT;
  const login = process.env.ADMIN_ID ? { id: process.env.ADMIN_ID, password: process.env.ADMIN_PASSWORD || '' } : { pin: process.env.ADMIN_PIN || '' };
  if (!inputs.length || (!login.id && !login.pin)) {
    console.error('쓰는 법: ADMIN_PIN=… node naesin-tg/extract/upload-sheets.mjs <폴더|파일…> [--first id,id] [--force] [--dry]');
    process.exit(1);
  }
  const files = collectFiles(inputs, (opt('first') || '').split(',').filter(Boolean));
  const call = async (p, body, token) => {
    const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status + ' ' + (j.error || ''));
    return j;
  };
  const token = (await call('/api/admin/login', login)).token;
  const have = new Set(((await call('/api/naesin-tg/admin/sheets', null, token)).sheets || []).map((e) => e.id));
  let ok = 0, skip = 0, fail = 0;
  for (const f of files) {
    const id = path.basename(f, '.sheet.json');
    if (have.has(id) && !flag('force')) { skip += 1; console.log('· 건너뜀(이미 있음) ' + id); continue; }
    if (flag('dry')) { console.log('· 올릴 것 ' + id); continue; }
    try {
      const n = await uploadOne((p, b) => call(p, b, token), JSON.parse(fs.readFileSync(f, 'utf8')));
      ok += 1; console.log('✓ ' + id + ' (' + n + '쪽, 닫힘)');
    } catch (e) { fail += 1; console.log('✗ ' + id + ' — ' + e.message); }
  }
  console.log(`끝: 올림 ${ok} · 건너뜀 ${skip} · 실패 ${fail}` + (flag('dry') ? ' (--dry: 올리지 않음)' : ''));
  process.exit(fail ? 1 : 0);
}
