// 4종 검사(HTP·KFD·DAP·FREE) 지식베이스 확장 검증 — mock AI로 실행.
import { extractObservations, generateText } from '../src/ai/claudeClient.mjs';
import { mapHypotheses } from '../src/pipeline.mjs';
import { assertHypothesisValid, assertNoBannedWords } from '../src/guardrails.mjs';

const CASES = [
  { test: 'HTP', ref: 'sample-htp', age: 8 },
  { test: 'KFD', ref: 'sample-kfd', age: 9 },
  { test: 'DAP', ref: 'sample-dap', age: 7 },
  { test: 'FREE', ref: 'sample-free', age: 10 }
];
const confKo = (c) => (c === 'high' ? '강' : c === 'mid' ? '중' : '약');
let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m));

for (const c of CASES) {
  const s1 = await extractObservations({ testType: c.test, age: c.age, imageRef: c.ref });
  const hyps = mapHypotheses(s1.observations, c.test, c.age);
  console.log(`\n[${c.test}] 관찰 ${s1.observations.length} → 가설 ${hyps.length}`);
  hyps.forEach((h) => console.log(`   • [${confKo(h.confidence)}] ${h.observation} → ${h.text}` + (h.age_adjustment ? ' ⚖' : '') + (h.strength ? ' ★' : '')));
  ok(hyps.length > 0, `${c.test}: 가설 ${hyps.length}건 생성`);
  let allValid = true;
  hyps.forEach((h) => { try { assertHypothesisValid(h); } catch { allValid = false; } });
  ok(allValid, `${c.test}: 전 가설 근거수준·caveat 유효`);
  ok(!hyps.some((h) => h.confidence === 'high'), `${c.test}: '강' 남발 없음`);
  const draft = await generateText({ kind: 'expert_draft', payload: { hypotheses: hyps } });
  try { assertNoBannedWords(draft, c.test); ok(true, `${c.test}: 초안 가드레일(금지어) 통과`); }
  catch (e) { ok(false, `${c.test}: 가드레일 ${e.message}`); }
}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
