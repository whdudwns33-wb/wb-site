#!/usr/bin/env node
/* WB 한자브레인 — 단어장 검증기.  node hanja/book-validate.mjs <단어장.json 또는 .txt> [--id <id>] [--title <제목>]
 *
 * 단어장 = 문제집 한 권의 낱말·한자를 단원 순서대로 담은 JSON (관리 웹에 올리는 그 파일).
 * 구매 교재의 낱말은 라이선스 자료라 저장소에 없다 — 이 검증기는 업로드 전 로컬 검사다.
 *
 * 검사 규칙은 여기 없다 — hanja/book-check.js 하나에만 있다. 관리 웹 업로드 관문(서버)과
 * 미리보기(브라우저)도 같은 파일을 쓴다. 이 파일이 하는 일은 파일을 읽어(JSON 이면 그대로,
 * .txt 면 붙여넣기 형식으로 파싱) 결과를 사람이 읽게 찍는 것뿐이다.
 */
import fs from 'node:fs';
import CHECK from './book-check.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
if (!file) { console.error('사용법: node hanja/book-validate.mjs <단어장.json|.txt> [--id <id>] [--title <제목>] [--level L2] [--source own|textbook]'); process.exit(1); }

let res;
const text = fs.readFileSync(file, 'utf8');
if (/\.json$/i.test(file)) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { console.error('JSON 파싱 실패 — ' + e.message); process.exit(1); }
  if (opt('id')) raw.id = opt('id');
  if (opt('title')) raw.title = opt('title');
  if (opt('level')) raw.level = opt('level');
  if (opt('source')) raw.source = opt('source');
  res = CHECK.checkBook(raw);
} else {
  res = CHECK.parseBookText(text, { id: opt('id'), title: opt('title'), level: opt('level'), publisher: opt('publisher'), source: opt('source') });
}

for (const e of res.errors) console.log('  ✗ [' + e.where + '] ' + e.message);
for (const w of res.warns) console.log('  ! [' + w.where + '] ' + w.message);
for (const s of res.summary) console.log('  · ' + s);
if (!res.ok) { console.log('\nFAIL — 오류 ' + res.errors.length + '건. 고친 뒤 다시 검사하세요.'); process.exit(1); }
console.log('\nOK — 업로드할 수 있습니다' + (res.warns.length ? ' (경고 ' + res.warns.length + '건은 확인만 하면 됩니다)' : '') + '.');
if (opt('out')) { fs.writeFileSync(opt('out'), JSON.stringify(res.book, null, 1) + '\n'); console.log('정규화한 단어장을 ' + opt('out') + ' 에 썼습니다.'); }
