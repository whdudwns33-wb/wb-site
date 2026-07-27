// 파이프라인 오케스트레이션 — S0(위기/품질) → S1(관찰) → S2(가설매핑) → S3a(초안/미리보기).
// 확정 후 S3c(정식 리포트)는 confirmSubmission에서 실행.

import { store } from './store.mjs';
import { assertTransition } from './stateMachine.mjs';
import { extractObservations, generateText } from './ai/claudeClient.mjs';
import { HTP_KB } from './ai/knowledgeBase.mjs';
import { assertHypothesisValid, assertNoBannedWords, assertPublishable } from './guardrails.mjs';

// 업로드 직후 실행. status: uploaded → processing → (escalated | reviewing)
export async function runPipeline(submissionId) {
  const sub = store.getSubmission(submissionId);
  assertTransition(sub.status, 'processing');
  store.updateSubmission(submissionId, { status: 'processing' });
  store.audit({ action: 'pipeline.start', target_type: 'submission', target_id: submissionId });

  const meta = sub.meta || {};
  const age = meta.age ?? (meta.birth_year ? new Date().getFullYear() - meta.birth_year : null);

  // S1 (Vision) — 관찰 + 위기 플래그
  const s1 = await extractObservations({
    testType: sub.test_type, age, sex: meta.sex,
    imageRef: sub.image_key, imageBase64: meta.image_base64
  });

  // S0 판정: 위기 신호 → 자동 해석 중단, 전문가 즉시 검토
  if ((s1.crisis_flags || []).length > 0) {
    store.createCrisis({ submission_id: submissionId, level: 'urgent', flags: s1.crisis_flags });
    assertTransition('processing', 'escalated');
    store.updateSubmission(submissionId, { status: 'escalated' });
    store.audit({ action: 'crisis.escalated', target_type: 'submission', target_id: submissionId, meta: { flags: s1.crisis_flags } });
    return { status: 'escalated', crisis_flags: s1.crisis_flags };
  }

  // 관찰 저장
  for (const o of s1.observations) {
    store.addObservation({ submission_id: submissionId, ...o, source: 'ai' });
  }

  // S2 — KB 매핑 + 연령보정 + 가드레일
  const hyps = mapHypotheses(s1.observations, sub.test_type, age);
  hyps.forEach(assertHypothesisValid);
  const saved = hyps.map((h) => store.addHypothesis({ submission_id: submissionId, ...h }));

  // S3a — 전문가 초안 + 학부모 미리보기
  const expertDraft = await generateText({ kind: 'expert_draft', payload: { hypotheses: saved } });
  const parentPreview = await generateText({ kind: 'parent_preview', payload: { hypotheses: saved } });
  assertNoBannedWords(expertDraft, '전문가 초안');
  assertNoBannedWords(parentPreview, '학부모 미리보기');
  store.saveInterpretation({ submission_id: submissionId, summary_expert: expertDraft, parent_preview: parentPreview });

  assertTransition('processing', 'reviewing');
  store.updateSubmission(submissionId, { status: 'reviewing' });
  store.audit({ action: 'pipeline.reviewing', target_type: 'submission', target_id: submissionId });
  return { status: 'reviewing', hypotheses: saved.length };
}

// S2: 관찰 → 가설 매핑 (실측/테스트에서도 실제 코드 재사용을 위해 export)
export function mapHypotheses(observations, testType, age) {
  const kb = testType === 'HTP' ? HTP_KB : {};
  const out = [];
  for (const o of observations) {
    const entry = kb[o.element];
    if (!entry) continue;

    // 속성 조건부(derive) 또는 단순 match/matchAbsent
    let r;
    if (entry.derive) {
      r = entry.derive(o);
    } else {
      const applies = entry.matchAbsent ? o.present === false : (entry.match ? entry.match(o.attributes) : true);
      if (!applies) continue;
      r = { hypothesis: entry.hypothesis, confidence: entry.confidence, caveats: entry.caveats, strength: !!entry.strength, ageNorm: entry.ageNorm };
    }
    if (!r) continue;

    let confidence = r.confidence;
    let age_adjustment = null;
    const ageNorm = r.ageNorm || entry.ageNorm;
    // 연령 보정: 정상범위 연령이면 신뢰도 강등 + 문구
    if (ageNorm && age != null && age < ageNorm.normalBelow) {
      confidence = downgrade(confidence);
      age_adjustment = ageNorm.note;
    }
    out.push({
      element: o.element,
      observation: o.note || o.element,
      text: r.hypothesis,
      confidence,
      age_adjustment,
      caveats: r.caveats,
      strength: !!r.strength
    });
  }
  return out;
}

function downgrade(c) { return c === 'high' ? 'mid' : c === 'mid' ? 'low' : 'low'; }

// 확정 게이트: 전문가 검수 후 정식 학부모 리포트 발행. reviewing → confirmed → published
export async function confirmSubmission(submissionId, expertId) {
  const sub = store.getSubmission(submissionId);
  assertTransition(sub.status, 'confirmed');
  const hyps = store.hypBySubmission(submissionId);
  const keep = assertPublishable(hyps);           // 최소 1건 + 전 가설 유효

  store.updateSubmission(submissionId, { status: 'confirmed' });
  const report = await generateText({ kind: 'parent_report', payload: { hypotheses: keep } });
  assertNoBannedWords(report, '학부모 리포트');

  const interp = store.interpBySubmission(submissionId) || store.saveInterpretation({ submission_id: submissionId });
  interp.summary_parent = report;
  interp.expert_id = expertId;
  interp.confirmed_at = new Date().toISOString();

  const token = randomToken();
  const expires = new Date(Date.now() + 30 * 864e5).toISOString();  // 30일
  store.createReport({ submission_id: submissionId, share_token: token, expires_at: expires });

  assertTransition('confirmed', 'published');
  store.updateSubmission(submissionId, { status: 'published' });
  store.audit({ action: 'interpretation.published', target_type: 'submission', target_id: submissionId, actor_id: expertId });
  return { status: 'published', share_token: token, kept: keep.length };
}

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
