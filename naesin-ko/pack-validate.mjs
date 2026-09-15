#!/usr/bin/env node
/* WB 국어브레인 — 단원 팩 검증기.  node naesin-ko/pack-validate.mjs <팩 디렉터리>
 *
 * 팩 = 대단원 단위 콘텐츠 JSON 묶음. 콘텐츠는 라이선스 자료라 저장소에 없다 —
 * 이 검증기는 파이프라인의 "검수 게이트" 자동 검증 단계이며 로컬 팩 디렉터리를 검사한다.
 *
 * 검사 규칙은 전부 pack-check.js에 있다(관리 웹도 같은 파일을 쓴다) —
 * 이 파일은 파일을 읽어 합치고 결과를 사람이 읽게 찍는 껍데기다.
 *
 * 파일 구성 (있는 것만 읽는다):
 *   meta.json        팩 메타(packId·revision·publisher·grade·unit·source)
 *   works/*.json     작품 정본 ({work:{...}} 또는 {works:[...]})
 *   sets.json        지문 세트
 *   items-*.json     저장 문항
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CHECK = require('./pack-check.js');
const CONCEPTS = require('./concepts.json');

const dir = process.argv[2];
if (!dir) {
  console.error('사용법: node naesin-ko/pack-validate.mjs <팩 디렉터리>');
  process.exit(1);
}
if (!fs.existsSync(dir)) {
  console.error(`디렉터리가 없어요: ${dir}`);
  process.exit(1);
}

/* 디렉터리 안의 JSON을 전부 읽어 온다 — works/ 한 겹까지만 내려간다 */
function collect(base) {
  const out = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const full = path.join(base, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'works') {
        for (const f of fs.readdirSync(full)) {
          if (f.endsWith('.json')) out.push(path.join(full, f));
        }
      }
      continue;
    }
    if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

const files = [];
const parseErrors = [];
for (const f of collect(dir)) {
  const name = path.relative(dir, f);
  try {
    files.push({ name, json: JSON.parse(fs.readFileSync(f, 'utf8')) });
  } catch (e) {
    parseErrors.push(`${name}: JSON 파싱 실패 — ${e.message}`);
  }
}

if (!files.length && !parseErrors.length) {
  console.error(`${dir} 에 JSON 파일이 없어요.`);
  process.exit(1);
}

const { pack, notes } = CHECK.assemble(files);
const result = CHECK.checkPack(pack, { concepts: CONCEPTS });
const errors = parseErrors.concat(notes, result.errors);

console.log(`\n팩: ${pack.packId || '(packId 없음)'}  ·  파일 ${files.length}개`);
console.log('─'.repeat(60));
result.summary.forEach((s) => console.log(`  ${s}`));

if (result.warns.length) {
  console.log(`\n경고 ${result.warns.length}개 — 검수 화면에서 확인하세요`);
  result.warns.forEach((w) => console.log(`  ! ${w}`));
}

if (errors.length) {
  console.log(`\n오류 ${errors.length}개 — 배포할 수 없어요`);
  errors.forEach((e) => console.log(`  ✗ ${e}`));
  console.log('');
  process.exit(1);
}

console.log(`\n✓ 오류 없음 — 배포 가능${result.warns.length ? ' (경고는 확인하세요)' : ''}\n`);
