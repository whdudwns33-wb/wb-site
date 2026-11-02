#!/usr/bin/env node
/* 지문 초안 검사 — node reading/draft-validate.mjs <지문.json> [...]
 *
 * 병합 전에 한 편씩 재어 본다. 규격은 reading/draft-check.js 에 있고
 * content.test.cjs 와 같은 수치를 쓴다.
 *
 *   --numbers   숫자가 든 문장을 모두 뽑아 준다(⑦ 수치 교차 확인용).
 *               숫자만 맞고 가리키는 양이 다른 종류를 사람이 보려면
 *               숫자를 그 문장째로 읽어야 한다. */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkDraft, LEVELS } = require('./draft-check.js');

const args = process.argv.slice(2);
const wantNumbers = args.includes('--numbers');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('쓰기: node reading/draft-validate.mjs <지문.json> [...] [--numbers]');
  process.exit(2);
}

/* 숫자를 그 숫자가 든 문장과 함께 보여 준다 */
function numbers(a) {
  const out = [];
  for (const lv of LEVELS) {
    const b = a.levels?.[lv];
    if (!b) continue;
    const text = (b.paragraphs || []).map((p) => p.join('')).join(' ');
    for (const s of text.split(/(?<=[.!?。])\s+|(?<=다\.)\s+/)) {
      if (/\d/.test(s)) out.push(`  ${lv}  ${s.trim()}`);
    }
    for (const q of [...(b.questions || []), ...(b.challenge || [])]) {
      for (const t of [q.q, ...(q.choices || []), q.explain]) {
        if (t && /\d/.test(t)) out.push(`  ${lv}* ${t}`);
      }
    }
  }
  return out;
}

let bad = 0;
for (const f of files) {
  if (!fs.existsSync(f)) { console.log('없음', f); bad++; continue; }
  let a;
  try { a = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { console.log('파싱 불가', f, '—', e.message); bad++; continue; }

  const { errors, warns, stats } = checkDraft(a);
  console.log(`\n### ${a.id} | ${a.category} | ${(a.careers || []).join(',')} | issue=${a.issue} | ${a.status}`);
  for (const s of a.sources || []) console.log('   출처:', s.url);
  for (const lv of LEVELS) {
    const t = stats[lv];
    if (!t) continue;
    console.log(`  ${lv}  ${t.chars}자 · ${t.segs}조각 · 평균 ${t.mean.toFixed(2)} · 최대 ${t.max}`
      + ` · 어휘 ${t.vocab} · 문항 ${t.q}+심화 ${t.challenge}`
      + (t.qCount ? ` · 최장=정답 ${t.lengthTell}/${t.qCount}` : ''));
  }
  warns.forEach((w) => console.log('  WARN:', w));
  errors.forEach((e) => console.log('  X', e));
  bad += errors.length;
  if (wantNumbers) {
    console.log('  — 숫자가 든 문장 (출처 문장과 뜻까지 맞는지 본다)');
    numbers(a).forEach((l) => console.log(l));
  }
}
console.log(bad === 0 ? '\n== 초안 검사 통과 (결함 0)' : `\n== 결함 ${bad}건`);
process.exit(bad === 0 ? 0 : 1);
