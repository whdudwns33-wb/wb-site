// 엔진 실측 — 실제 렌더링된 두 그림을 Claude Opus(비전)가 직접 판독해 얻은
// 관찰(observations)을 실제 S2/S3 코드에 통과시켜 결과를 비교한다.
// 목적: 파이프라인이 canned mock이 아니라 '그림 내용'에 반응함을 증명.
// (API 키 없이, 관찰 추출은 사람=Claude가 이미지를 실제로 보고 수행함)

import { mapHypotheses } from '../src/pipeline.mjs';
import { generateText } from '../src/ai/claudeClient.mjs';
import { assertNoBannedWords, assertHypothesisValid } from '../src/guardrails.mjs';

// ── 실제 판독한 관찰 (apps/picture-test/samples/*.png) ──
const CASES = {
  'sample-a (만8세)': {
    age: 8,
    obs: [
      { element: 'house.roof', present: true, attributes: { size: 'large' }, note: '집 · 지붕 크게' },
      { element: 'house.door', present: true, attributes: { handle: false }, note: '집 · 문 손잡이 없음' },
      { element: 'tree.trunk', present: true, attributes: { width: 'thick' }, note: '나무 · 굵은 줄기' },
      { element: 'tree.root', present: true, attributes: { emphasis: 'strong' }, note: '나무 · 뿌리 강조' },
      { element: 'tree.foliage', present: true, attributes: { density: 'full' }, note: '나무 · 풍성한 잎' },
      { element: 'person.hand', present: false, attributes: {}, note: '사람 · 손 생략' },
      { element: 'person.face', present: true, attributes: { size: 'large', expression: 'smile' }, note: '사람 · 큰 눈·미소' }
    ]
  },
  'variant-b (만7세)': {
    age: 7,
    obs: [
      { element: 'house.roof', present: true, attributes: { size: 'small' }, note: '집 · 지붕 작음' },
      { element: 'house.door', present: true, attributes: { handle: true }, note: '집 · 문 손잡이 있음' },
      { element: 'house.fence', present: true, attributes: {}, note: '집 · 앞 울타리' },
      { element: 'tree.trunk', present: true, attributes: { width: 'thin', curved: true }, note: '나무 · 가는 줄기' },
      { element: 'tree.root', present: false, attributes: {}, note: '나무 · 뿌리 없음' },
      { element: 'tree.foliage', present: true, attributes: { density: 'sparse', direction: 'drooping' }, note: '나무 · 앙상·처진 가지' },
      { element: 'person.hand', present: true, attributes: {}, note: '사람 · 손 그림 있음' },
      { element: 'person.face', present: true, attributes: { size: 'small', expression: 'frown' }, note: '사람 · 작은 눈·처진 입' }
    ]
  }
};

const confKo = (c) => (c === 'high' ? '강' : c === 'mid' ? '중' : '약');

for (const [name, c] of Object.entries(CASES)) {
  console.log(`\n══════ ${name} · 관찰 ${c.obs.length}개 ══════`);
  const hyps = mapHypotheses(c.obs, 'HTP', c.age);
  hyps.forEach(assertHypothesisValid);
  console.log(`매칭된 가설: ${hyps.length}개`);
  for (const h of hyps) {
    console.log(`  • [${confKo(h.confidence)}] ${h.observation} → ${h.text}` + (h.age_adjustment ? `  ⚖연령보정` : '') + (h.strength ? '  ★강점' : ''));
  }
  const draft = await generateText({ kind: 'expert_draft', payload: { hypotheses: hyps } });
  assertNoBannedWords(draft, name + ' 초안');
  console.log('  가드레일(금지어) 통과: ✅');
}

// ── 대조: 두 케이스의 가설 element 집합이 겹치지 않아야 '내용 반응' 증명 ──
const setA = new Set(mapHypotheses(CASES['sample-a (만8세)'].obs, 'HTP', 8).map((h) => h.element));
const setB = new Set(mapHypotheses(CASES['variant-b (만7세)'].obs, 'HTP', 7).map((h) => h.element));
const overlap = [...setA].filter((e) => setB.has(e));
console.log(`\n══════ 대조 ══════`);
console.log(`sample-a 가설 element: ${[...setA].join(', ')}`);
console.log(`variant-b 가설 element: ${[...setB].join(', ')}`);
console.log(`겹치는 element: ${overlap.length ? overlap.join(', ') : '없음 → 파이프라인이 그림 내용에 반응함 ✅'}`);
