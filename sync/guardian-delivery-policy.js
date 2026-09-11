const SAFE_STUDENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function text(value) {
  return String(value == null ? '' : value).trim();
}

export function guardianDeliveryGloballyEnabled(env) {
  return text(env && env.WB_GUARDIAN_CONTACT_ENABLED).toLowerCase() !== 'false';
}

export function guardianDeliveryStudentIds(env) {
  const values = text(env && env.WB_GUARDIAN_CONTACT_STUDENT_IDS).split(',')
    .map(value => value.trim()).filter(value => SAFE_STUDENT_ID.test(value));
  return Array.from(new Set(values)).sort();
}

export function guardianDeliveryAllowed(env, studentId) {
  if (guardianDeliveryGloballyEnabled(env)) return true;
  const target = text(studentId);
  return !!target && guardianDeliveryStudentIds(env).includes(target);
}

/** 학부모 수업 피드백에만 적용하는 전체 학생 gate다. 기존 보호자 웹앱·공지·운영
 * 알림의 전역 gate와 의도적으로 분리하며, 명시적인 소문자 true만 활성화한다. */
export function parentFeedbackAllStudentsEnabled(env) {
  return text(env && env.WB_PARENT_FEEDBACK_ALL_STUDENTS_ENABLED) === 'true';
}

export function parentFeedbackDeliveryAllowed(env, studentId) {
  return parentFeedbackAllStudentsEnabled(env) || guardianDeliveryAllowed(env, studentId);
}

export function guardianDeliveryAvailable(env) {
  return guardianDeliveryGloballyEnabled(env) || guardianDeliveryStudentIds(env).length > 0;
}

export function guardianAnnouncementTargetsAllowed(env, targetType, studentIds) {
  if (guardianDeliveryGloballyEnabled(env)) return true;
  if (String(targetType || '') !== 'students') return false;
  const targets = Array.isArray(studentIds) ? studentIds.map(String) : [];
  return targets.length > 0 && targets.every(studentId => guardianDeliveryAllowed(env, studentId));
}
