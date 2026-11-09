#!/usr/bin/env node
/* 지문 초안 검사 — node reading/draft-validate.mjs <지문.json> [...]
 *
 * 병합 전에 한 편씩 재어 본다. 규격은 reading/draft-check.js 에 있고
 * content.test.cjs 와 같은 수치를 쓴다.
 *
 *   --numbers   숫자가 든 문장을 모두 뽑아 준다(⑦ 수치 교차 확인용).
 *               숫자만 맞고 가리키는 양이 다른 종류를 사람이 보려면
 *               숫자를 그 문장째로 읽어야 한다.
 *
 * 어휘 카드의 한자 훈음은 저장소의 articles.json 과도 대조한다 — 한 글자를 지문마다
 * 다르게 적어 두면 같은 학생이 어휘 카드와 한자 카드에서 다른 훈을 읽는다.
 * content.test.cjs 가 오류로 막는 자리인데, 집필은 한 편씩 따로 하므로 병합할 때까지
 * 드러나지 않는다(2026-11-02 에 네 편에서 10건이 한꺼번에 나왔다). 미리 여기서 잡는다. */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkDraft, LEVELS, collectReadings, hanjaClash } = require('./draft-check.js');

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

/* 저장소의 articles.json 에서 글자당 훈음을 모은다 — 없으면 이 대조는 건너뛴다 */
function corpusReadings() {
  try {
    const db = JSON.parse(fs.readFileSync(new URL('./articles.json', import.meta.url), 'utf8'));
    return collectReadings(db.articles || []);
  } catch { return null; }
}
const CORPUS = corpusReadings();

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
      + (t.qCount ? ` · 최장=정답 ${t.lengthTell}/${t.qCount}` : '')
      + (t.answerPos ? ` · 정답자리 ${t.answerPos.join('·')}` : ''));
  }
  const clash = hanjaClash(a, CORPUS);
  clash.forEach((m) => console.log('  X', m));
  warns.forEach((w) => console.log('  WARN:', w));
  errors.forEach((e) => console.log('  X', e));
  bad += errors.length + clash.length;
  if (wantNumbers) {
    console.log('  — 숫자가 든 문장 (출처 문장과 뜻까지 맞는지 본다)');
    numbers(a).forEach((l) => console.log(l));
  }
}
console.log(bad === 0 ? '\n== 초안 검사 통과 (결함 0)' : `\n== 결함 ${bad}건`);
process.exit(bad === 0 ? 0 : 1);
