#!/usr/bin/env node
/* WB 내신 — 레슨 팩 검증기.  node naesin/pack-validate.mjs <팩 디렉터리>
 *
 * 팩 = 과 단위 콘텐츠 JSON 묶음 (이그잼포유 자료를 구조화한 것).
 * 콘텐츠는 라이선스 자료라 저장소에 없다 — 이 검증기는 파이프라인의
 * "검수 게이트" 자동 검증 단계이며, 로컬 팩 디렉터리를 검사한다.
 *
 * 검사 규칙은 여기 없다 — naesin/pack-check.js 하나에만 있다.
 * 같은 규칙을 관리 웹 업로드와 제작 스튜디오 배포도 쓰기 때문에, 규칙을 복제하면
 * "CLI는 통과인데 업로드가 막히는" 판정 불일치가 생긴다. 이 파일이 하는 일은
 * 파일을 읽어 하나의 팩으로 합치고, 파일 수준 오류(파싱 실패·packId 불일치)를
 * 붙인 뒤 결과를 사람이 읽게 찍는 것뿐이다.
 *
 * 파일 구성 (있는 것만 검사, 최소 1개는 있어야 함):
 *   words.json      단어 마스터        sentences.json  본문 문장 마스터
 *   dialogues.json  대화문 마스터      patterns.json   문법 패턴 마스터
 *   items-*.json    저장 문항
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CHECK = require('./pack-check.js');

const dir = process.argv[2];
if (!dir) { console.error('사용법: node naesin/pack-validate.mjs <팩 디렉터리>'); process.exit(1); }

const fileErrors = [];

function load(name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { fileErrors.push({ where: name, message: `JSON 파싱 실패 — ${e.message}` }); return null; }
}

/* 파일들을 하나의 팩으로 합친다 — 관리 웹 업로드가 브라우저에서 하는 것과 같은 병합이다.
   같은 배열 필드가 여러 파일에 있으면 처음 것을 쓴다(업로드 화면의 assemble 과 같은 규칙). */
const ARR_FIELDS = ['words', 'sentences', 'oddOneItems', 'checkItems', 'dialogues',
  'keyExpressions', 'functions', 'vocabSidebar', 'readingQA', 'patterns'];

const sources = [];
const where = {};
for (const [name, section] of [['words.json', 'words'], ['sentences.json', 'sentences'],
  ['dialogues.json', 'dialogues'], ['patterns.json', 'patterns']]) {
  const data = load(name);
  if (!data) continue;
  sources.push({ name, data });
  where[section] = name;
  /* sentences.json 이 어색한 곳·종합 Check 도 함께 싣는다 — 오류 위치를 그 파일로 보이게 한다 */
  if (section === 'sentences') { where.oddOneItems = name; where.checkItems = name; }
}
const itemFiles = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((n) => /^items-.*\.json$/.test(n)).sort()
  : [];
for (const name of itemFiles) {
  const data = load(name);
  if (data) sources.push({ name, data });
}

const pack = {};
for (const { data } of sources) {
  for (const k of ARR_FIELDS) {
    if (Array.isArray(data[k]) && data[k].length && !(Array.isArray(pack[k]) && pack[k].length)) pack[k] = data[k];
  }
  if (Array.isArray(data.items) && data.items.length && !(Array.isArray(pack.items) && pack.items.length)) pack.items = data.items;
  if (data.counts && !pack.counts) pack.counts = data.counts;
  if (data.passage && !pack.passage) pack.passage = data.passage;
  if (data.packId && !pack.packId) pack.packId = data.packId;
}
/* 문항 파일이 여러 개면 합쳐서 한 번에 본다 — 파일별로 나눠 보면 번호 중복을 못 잡는다 */
const allItems = [];
for (const { data } of sources) if (Array.isArray(data.items)) allItems.push(...data.items);
if (allItems.length) pack.items = allItems;

/* packId 는 파일 사이에서만 어긋날 수 있다(합친 뒤에는 하나뿐) — 여기서 본다 */
const packIds = [...new Set(sources.map(({ data }) => data.packId).filter(Boolean))];
if (packIds.length > 1) fileErrors.push({ where: '(공통)', message: `packId 불일치: ${packIds.join(' / ')}` });

const itemsLabel = itemFiles.length === 1 ? itemFiles[0] : (itemFiles.length ? `items(${itemFiles.length}개 파일)` : 'items');
const res = sources.length
  ? CHECK.checkPack(pack, { where, itemsLabel })
  : { errors: [{ where: '(공통)', message: '검사할 팩 파일이 하나도 없음' }], warns: [], summary: [] };

const errors = [...fileErrors, ...res.errors];
const line = (e) => `${e.where}: ${e.message}`;

console.log(`팩 검증 — ${dir}`);
res.summary.forEach((s) => console.log('  · ' + s));
if (res.warns.length) {
  console.log(`\n경고 ${res.warns.length}건:`);
  res.warns.slice(0, 30).forEach((w) => console.log('  ⚠ ' + line(w)));
  if (res.warns.length > 30) console.log(`  … 외 ${res.warns.length - 30}건`);
}
if (errors.length) {
  console.log(`\n오류 ${errors.length}건:`);
  errors.slice(0, 50).forEach((e) => console.log('  ✗ ' + line(e)));
  if (errors.length > 50) console.log(`  … 외 ${errors.length - 50}건`);
  process.exit(1);
}
console.log('\n통과 — 오류 없음' + (res.warns.length ? ` (경고 ${res.warns.length}건은 검수 화면에서 확인)` : ''));
