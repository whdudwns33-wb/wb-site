// 안전 가드레일 — 발행 전 강제 검증 (엔진 스펙 §7 메타규칙).
// 위반 시 예외 → 상태 전이/발행 차단.

const BANNED = ['진단', '장애', '확진', '치료', '우울증', 'ADHD'];
// 허용: 부정형 면책 문구("진단이 아닙니다" 등)는 금지어로 보지 않음
const ALLOWED = [/진단이\s*아[님닙]\S*/g, /진단이\s*아니\S*/g, /진단[·\s]*치료(가|를)?\s*아[님닙]\S*/g];

export function assertNoBannedWords(text, where = '출력') {
  let t = text || '';
  ALLOWED.forEach((re) => { t = t.replace(re, ''); });
  const hit = BANNED.filter((w) => t.includes(w));
  if (hit.length) throw new GuardrailError(`${where}에 금지어 포함: ${hit.join(', ')}`);
}

// 각 가설: 근거수준 필수 + 연령보정 규칙 적용 여부 검증
export function assertHypothesisValid(h) {
  if (!['high', 'mid', 'low'].includes(h.confidence)) {
    throw new GuardrailError(`가설 근거수준 누락: ${h.element}`);
  }
  if (!Array.isArray(h.caveats) || h.caveats.length === 0) {
    throw new GuardrailError(`가설 경고(caveat) 누락: ${h.element}`);
  }
}

// 확정 게이트 전 검증: 최소 1건 반영, 전 가설 유효
export function assertPublishable(hypotheses) {
  const keep = hypotheses.filter((h) => h.status !== 'rejected');
  if (keep.length === 0) throw new GuardrailError('반영할 가설이 없어 발행 불가');
  hypotheses.forEach(assertHypothesisValid);
  return keep;
}

export class GuardrailError extends Error {}
