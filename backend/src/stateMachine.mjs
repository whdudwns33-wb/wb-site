// 제출 상태머신 — 허용된 전이만 통과 (백엔드 설계 §2).

const TRANSITIONS = {
  created:         ['consent_pending'],
  consent_pending: ['uploaded', 'expired'],
  uploaded:        ['processing', 'expired'],
  processing:      ['reviewing', 'escalated'],
  reviewing:       ['confirmed', 'escalated', 'rejected'],
  escalated:       ['reviewing', 'rejected'],
  confirmed:       ['published'],
  published:       ['purged'],
  rejected:        ['purged'],
  expired:         ['purged'],
  purged:          []
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`잘못된 상태 전이: ${from} → ${to}`);
  }
}
