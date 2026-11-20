(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WBLessonProgressCore = api;
})(globalThis, function () {
  'use strict';

  /** 수업 화면은 생성 시기와 무관하게 같은 운영 5단계를 쓴다.
   *  예전 단계에 이미 체크한 날짜는 그날 기록을 그대로 보여 주고, 새 날짜부터 표준으로 전환한다. */
  const LESSON_OPERATIONAL_STEP_LABELS = [
    '지난 숙제·온라인 수행 확인',
    '교재와 오늘 진도 진행',
    '이해도·오답·학생 반응 확인',
    '다음 숙제 안내',
    '실제 진도와 특이사항 기록'
  ];

  function usesStandardLessonDisplay(t) {
    return !!(t && (t.taskKind === 'lesson_instruction' || /^\[수업\]/.test(t.title || '')));
  }

  function storedTaskSteps(t) { return t && Array.isArray(t.steps) ? t.steps : []; }

  function hasStandardLessonSteps(t) {
    const steps = storedTaskSteps(t);
    return steps.length === LESSON_OPERATIONAL_STEP_LABELS.length &&
      steps.every((step, index) => String(step.label || '') === LESSON_OPERATIONAL_STEP_LABELS[index]);
  }

  function taskSteps(t, c) {
    const stored = storedTaskSteps(t);
    if (!usesStandardLessonDisplay(t) || hasStandardLessonSteps(t)) return stored;
    const legacyProgress = c && c.steps && stored.some(step => c.steps[step.id]);
    if (legacyProgress) return stored;
    return LESSON_OPERATIONAL_STEP_LABELS.map((label, index) => ({
      id: String(t.id || 'lesson') + '-standard-step-' + (index + 1), label: label
    }));
  }

  function lessonReferenceSteps(t) {
    return usesStandardLessonDisplay(t) && !hasStandardLessonSteps(t) ? storedTaskSteps(t) : [];
  }

  function lessonCheckIsDone(task, c) {
    const steps = taskSteps(task, c);
    if (usesStandardLessonDisplay(task) && steps.length === LESSON_OPERATIONAL_STEP_LABELS.length) {
      return steps.every(step => c && c.steps && c.steps[step.id]);
    }
    return !!(c && c.done);
  }

  return { LESSON_OPERATIONAL_STEP_LABELS, usesStandardLessonDisplay, taskSteps, lessonReferenceSteps, lessonCheckIsDone };
});
