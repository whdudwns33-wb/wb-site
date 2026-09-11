import assert from 'node:assert/strict';
import test from 'node:test';

import {
  guardianAnnouncementTargetsAllowed,
  guardianDeliveryAllowed,
  guardianDeliveryAvailable,
  guardianDeliveryGloballyEnabled,
  guardianDeliveryStudentIds,
  parentFeedbackAllStudentsEnabled,
  parentFeedbackDeliveryAllowed
} from './guardian-delivery-policy.js';

test('전역 기능은 명시적으로 false일 때만 중지한다', () => {
  assert.equal(guardianDeliveryGloballyEnabled({}), true);
  assert.equal(guardianDeliveryAllowed({}, 'student-a'), true);
  assert.equal(guardianDeliveryGloballyEnabled({ WB_GUARDIAN_CONTACT_ENABLED: ' FALSE ' }), false);
  assert.equal(guardianDeliveryAvailable({ WB_GUARDIAN_CONTACT_ENABLED: 'false' }), false);
});

test('전역 중지 중에는 허용목록의 stable studentId만 정확히 통과한다', () => {
  const env = {
    WB_GUARDIAN_CONTACT_ENABLED: 'false',
    WB_GUARDIAN_CONTACT_STUDENT_IDS: ' student-b,student-a,student-a,../bad,student_c '
  };
  assert.deepEqual(guardianDeliveryStudentIds(env), ['student-a', 'student-b', 'student_c']);
  assert.equal(guardianDeliveryAvailable(env), true);
  assert.equal(guardianDeliveryAllowed(env, 'student-a'), true);
  assert.equal(guardianDeliveryAllowed(env, 'Student-a'), false);
  assert.equal(guardianDeliveryAllowed(env, 'student-other'), false);
});

test('선별 모드 공지는 허용된 학생을 직접 선택한 경우에만 허용한다', () => {
  const env = {
    WB_GUARDIAN_CONTACT_ENABLED: 'false',
    WB_GUARDIAN_CONTACT_STUDENT_IDS: 'student-a,student-b'
  };
  assert.equal(guardianAnnouncementTargetsAllowed(env, 'students', ['student-a', 'student-b']), true);
  assert.equal(guardianAnnouncementTargetsAllowed(env, 'students', []), false);
  assert.equal(guardianAnnouncementTargetsAllowed(env, 'students', ['student-a', 'student-c']), false);
  assert.equal(guardianAnnouncementTargetsAllowed(env, 'all', []), false);
});

test('피드백 전용 전체 학생 gate는 기존 보호자 기능을 켜지 않고 명시적 true만 허용한다', () => {
  const env = {
    WB_GUARDIAN_CONTACT_ENABLED: 'false',
    WB_PARENT_FEEDBACK_ALL_STUDENTS_ENABLED: 'true'
  };
  assert.equal(parentFeedbackAllStudentsEnabled(env), true);
  assert.equal(parentFeedbackDeliveryAllowed(env, 'student-any'), true);
  assert.equal(guardianDeliveryAllowed(env, 'student-any'), false);
  assert.equal(guardianDeliveryAvailable(env), false);
  assert.equal(guardianAnnouncementTargetsAllowed(env, 'students', ['student-any']), false);
  assert.equal(parentFeedbackAllStudentsEnabled({
    WB_PARENT_FEEDBACK_ALL_STUDENTS_ENABLED: 'TRUE'
  }), false);
});
