// 외부 I/O가 없는 계약 시험용. 실제 서버에는 발송 어댑터를 연결하지 않는다.
export function planDelivery({ report, currentVersion, eligibility, now, actorRole, academyConnected }) {
  if (actorRole !== 'owner') return {status:'blocked',reason:'permission'};
  if (!academyConnected) return {status:'blocked',reason:'integration_pending'};
  if (report.status !== 'published' || report.version !== currentVersion) return {status:'blocked',reason:'stale_report'};
  if (!eligibility || !eligibility.studentActive || !eligibility.relationshipVerified || !eligibility.consent || eligibility.blocked || !eligibility.contactVerified) return {status:'blocked',reason:'ineligible'};
  if (!Number.isFinite(eligibility.checkedAt) || now - eligibility.checkedAt > 30000 || eligibility.checkedAt > now) return {status:'blocked',reason:'recheck_required'};
  return {status:'ready',key:[report.id,report.version,eligibility.guardianId,'approved-channel'].join(':'),contactRevision:eligibility.contactRevision};
}
export function deliveryTransition(current, event) {
  const transitions = {
    pending:{submit:'submitting'}, submitting:{accepted:'accepted',timeout:'unknown',failed:'failed'},
    accepted:{delivered:'delivered',failed:'failed',timeout:'unknown'},
    unknown:{reconciled_delivered:'delivered',reconciled_failed:'failed'}, delivered:{acknowledged:'acknowledged'}
  };
  return transitions[current]?.[event] || current;
}
