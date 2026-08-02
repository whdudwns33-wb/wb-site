"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const lp = require("./learning-platform.js");
const shell = require("./learning-shell.js");

function state(stage = "elementary", grade = 3) {
  return shell.createInitialState({
    studentCode: "STU-1", displayName: "학생", academicStage: stage, grade
  });
}

test("초등 초기 상태는 학교 정기시험이 꺼져 있다", () => {
  const current = state();
  assert.equal(current.settings.schoolRegularExamEnabled, false);
  assert.doesNotMatch(shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" }), /value="school_regular"/);
});

test("표준 일정은 NELT 3개월·메타수학 주간·월말을 중복 없이 만든다", () => {
  let current = state();
  const command = { type: "schedules_generate", fromDate: "2026-08-03", toDate: "2027-08-03", weekday: 5 };
  current = shell.applyCommand(current, command, {});
  const firstCounts = [current.assessmentSchedules.length, current.assessmentOccurrences.length, current.plannerItems.length];
  current = shell.applyCommand(current, command, {});
  assert.deepEqual([current.assessmentSchedules.length, current.assessmentOccurrences.length, current.plannerItems.length], firstCounts);
  assert.equal(current.assessmentSchedules.some(item => item.providerId === "nelt"), true);
  assert.equal(current.assessmentSchedules.filter(item => item.providerId === "metamath").length, 2);
  const anchors = Object.fromEntries(current.assessmentSchedules.map(item => [item.scheduleType, item.anchorDate]));
  current = shell.applyCommand(current, {
    type: "schedules_generate", fromDate: "2026-08-04", toDate: "2027-08-04", weekday: 5
  }, {});
  assert.equal(current.assessmentSchedules.length, 3);
  current.assessmentSchedules.forEach(item => assert.equal(item.anchorDate, anchors[item.scheduleType]));
  const semanticDates = current.assessmentOccurrences.map(item => item.scheduleType + "|" + item.scheduledDate);
  assert.equal(new Set(semanticDates).size, semanticDates.length);
});

test("관리자 평가 승인 명령은 점수·근거를 검증하고 연결 플래너만 완료한다", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse("2026-08-08T00:00:00.000Z");
    let current = state();
    current = shell.applyCommand(current, {
      type: "schedules_generate", fromDate: "2026-08-03", toDate: "2026-08-10", weekday: 5,
      nelt: false
    }, {});
    const occurrence = current.assessmentOccurrences[0];
    const linkedPlanner = current.plannerItems.find((item) => item.occurrenceId === occurrence.occurrenceId);
    current = shell.applyCommand(current, {
      type: "planner_add", date: "2026-08-07", title: "별도 읽기", minutes: 10
    }, {});
    const separatePlanner = current.plannerItems.find((item) => item.occurrenceId === "");
    const beforeHtml = shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" });
    assert.match(beforeHtml, /id="lpAssessmentOccurrence"/);
    assert.match(beforeHtml, /data-act="lpassessmentapprove"/);
    assert.throws(() => shell.applyCommand(current, {
      type: "assessment_result_approve", occurrenceId: occurrence.occurrenceId, score: 7, maxScore: 10
    }, { actorId: "teacher-1", at: "2026-08-07T09:00:00.000Z" }), /evidenceRef/);
    current = shell.applyCommand(current, {
      type: "assessment_result_approve", occurrenceId: occurrence.occurrenceId,
      score: 7, maxScore: 10, evidenceRef: "teacher:checked", externalRef: "metamath:result"
    }, { actorId: "teacher-1", at: "2026-08-07T09:00:00.000Z" });
    assert.equal(current.plannerItems.find((item) => item.itemId === linkedPlanner.itemId).status, "completed");
    assert.equal(current.plannerItems.find((item) => item.itemId === separatePlanner.itemId).status, "planned");
    assert.match(shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" }), new RegExp("7/10"));
  } finally {
    Date.now = originalNow;
  }
});

test("중등에서 초등으로 바꾸면 캠페인 동의를 갱신하고 학교시험 플래너를 tombstone 처리한다", () => {
  let current = state("middle", 7);
  current = shell.applyCommand(current, {
    type: "campaign_add", campaignType: "school_regular", title: "중간고사", examDate: "2026-10-01"
  }, {});
  const schoolId = current.prepCampaigns[0].campaignId;
  current = shell.applyCommand(current, { type: "campaign_activate", campaignId: schoolId }, {
    actorId: "teacher-1", today: "2026-08-03", at: "2026-08-03T09:00:00.000Z"
  });
  current = shell.applyCommand(current, {
    type: "campaign_add", campaignType: "nelt", title: "중등 NELT", examDate: "2026-10-10"
  }, {});
  const neltId = current.prepCampaigns.find(item => item.campaignType === "nelt").campaignId;
  current = shell.applyCommand(current, { type: "campaign_activate", campaignId: neltId }, {
    actorId: "teacher-1", today: "2026-08-03", at: "2026-08-03T09:05:00.000Z"
  });
  const neltBefore = current.prepCampaigns.find(item => item.campaignId === neltId);
  neltBefore.status = "result_review";
  neltBefore.latestResult = { resultId: "result-keep", summary: "응시 결과" };
  neltBefore.resultHistory = [{ resultId: "result-keep", summary: "응시 결과" }];
  const linkedSchool = current.plannerItems.filter(item => item.campaignId === schoolId);
  assert.ok(linkedSchool.length > 0);
  const completedId = linkedSchool[0].itemId;
  const carryoverId = linkedSchool[1].itemId;
  const verificationId = linkedSchool[2].itemId;
  current.plannerItems = current.plannerItems.map(item => {
    if (item.itemId === completedId) {
      return lp.createPlannerItem(Object.assign({}, item, {
        status: "completed", completedAt: "2026-08-03T09:10:00.000Z", revision: item.revision + 1
      }));
    }
    if (item.itemId === verificationId) {
      return lp.createPlannerItem(Object.assign({}, item, {
        status: "verification_waiting", completedAt: "2026-08-03T09:11:00.000Z",
        evidenceRefs: ["student:submission"], revision: item.revision + 1
      }));
    }
    return item;
  });
  const carryoverBefore = current.plannerItems.find(item => item.itemId === carryoverId);
  current = shell.applyCommand(current, {
    type: "planner_carryover_request",
    itemId: carryoverId,
    date: lp.date.addDays(carryoverBefore.date, 1),
    reason: "시험 일정 조정 요청"
  }, { actorId: "teacher-requester", at: "2026-08-03T09:20:00.000Z" });
  const pendingCarryover = current.plannerItems.find(item => item.itemId === carryoverId);
  assert.equal(pendingCarryover.status, "carryover_candidate");
  assert.equal(pendingCarryover.carryoverDecision, "pending");

  current = shell.applyCommand(current, {
    type: "profile_update", academicStage: "elementary", grade: 6
  }, { actorId: "teacher-2", at: "2026-08-03T10:00:00.000Z" });
  const school = current.prepCampaigns.find(item => item.campaignId === schoolId);
  const nelt = current.prepCampaigns.find(item => item.campaignId === neltId);
  assert.equal(current.settings.schoolRegularExamEnabled, false);
  assert.equal(school.academicStage, "elementary");
  assert.equal(school.grade, 6);
  assert.equal(school.status, "draft");
  assert.equal(school.activationBlockedReason, "ELEMENTARY_REGULAR_EXAM_DISABLED");
  assert.equal(nelt.academicStage, "elementary");
  assert.equal(nelt.grade, 6);
  assert.equal(nelt.status, "check_needed");
  assert.equal(nelt.consentStatus, "pending");
  assert.equal(nelt.consentEvidenceRef, "");
  assert.equal(nelt.latestResult.resultId, "result-keep");
  assert.equal(nelt.resultHistory.length, 1);

  const completed = current.plannerItems.find(item => item.itemId === completedId);
  assert.equal(completed.status, "completed");
  assert.notEqual(completed.systemHidden, true);
  const verification = current.plannerItems.find(item => item.itemId === verificationId);
  assert.equal(verification.status, "verification_waiting");
  assert.deepEqual(verification.evidenceRefs, ["student:submission"]);
  assert.notEqual(verification.systemHidden, true);

  const closedCarryover = current.plannerItems.find(item => item.itemId === carryoverId);
  assert.equal(closedCarryover.status, "canceled");
  assert.equal(closedCarryover.systemHidden, true);
  assert.equal(closedCarryover.carryoverDecision, "rejected");
  assert.equal(closedCarryover.carryoverDecisionReason, "campaign_profile_transition");
  assert.equal(closedCarryover.carryoverReviewedBy, "teacher-2");
  assert.equal(closedCarryover.carryoverReviewedAt, "2026-08-03T10:00:00.000Z");
  assert.equal(closedCarryover.carryoverRequestedDate, pendingCarryover.carryoverRequestedDate);
  assert.equal(closedCarryover.carryoverRequestReason, "시험 일정 조정 요청");
  assert.equal(closedCarryover.carryoverRequestedBy, "teacher-requester");
  assert.equal(closedCarryover.history.some(event => event.action === "carryover_requested"), true);
  assert.equal(closedCarryover.history.some(event => event.action === "carryover_rejected"), true);
  assert.equal(closedCarryover.history.some(event => event.action === "canceled"), true);
  assert.equal(closedCarryover.revision, pendingCarryover.revision + 2);

  current.plannerItems.filter(item =>
    item.campaignId === schoolId && item.itemId !== completedId && item.itemId !== verificationId
  ).forEach(item => {
    assert.equal(item.status, "canceled");
    assert.equal(item.systemHidden, true);
    assert.equal(item.systemHiddenReason, "campaign_profile_transition");
    assert.equal(item.cancelReason, "campaign_profile_transition");
    assert.equal(item.history.some(event => event.action === "canceled"), true);
  });
  const controls = shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" });
  current.plannerItems.filter(item => item.systemHidden === true).forEach(item => {
    assert.doesNotMatch(controls, new RegExp('data-id="' + item.itemId + '"'));
  });
});

test("학생 완료요청 병합은 플래너만 확인대기로 바꾸고 다른 학습 원장은 유지한다", () => {
  let current = shell.createInitialState({ studentCode: "E-CLAIM", displayName: "학생", academicStage: "elementary", grade: 3 });
  current = lp.addPlannerItem(current, { studentCode: "E-CLAIM", date: "2026-08-03", title: "읽기", sourceType: "academy", verificationRequired: true });
  current.prepCampaigns.push({ campaignId: "keep-campaign", status: "draft" });
  const item = current.plannerItems[0];
  const stale = shell.applyCompletionClaims(current, [{ itemId: item.itemId, expectedRevision: item.revision + 1, date: item.date, claimedAt: "2026-08-03T01:00:00.000Z" }]);
  assert.equal(stale.plannerItems[0].status, "planned");
  const wrongDate = shell.applyCompletionClaims(current, [{ itemId: item.itemId, expectedRevision: item.revision, date: "2026-08-04", claimedAt: "2026-08-03T01:00:00.000Z" }]);
  assert.equal(wrongDate.plannerItems[0].status, "planned");
  const merged = shell.applyCompletionClaims(current, [{ itemId: item.itemId, expectedRevision: item.revision, date: item.date, claimedAt: "2026-08-03T01:00:00.000Z" }]);
  assert.equal(merged.plannerItems[0].status, "verification_waiting");
  assert.equal(merged.prepCampaigns[0].campaignId, "keep-campaign");
});

test("온라인 프로그램 명령은 자격정보를 거부하고 계정 참조만 저장한다", () => {
  assert.throws(() => shell.applyCommand(state(), {
    type: "program_upsert", providerId: "classcard", password: "secret"
  }), /must not be stored/);
  const next = shell.applyCommand(state(), {
    type: "program_upsert", providerId: "classcard", status: "active", accountIdRef: "CC-REF"
  });
  assert.equal(next.programStates[0].accountIdRef, "CC-REF");
});

test("초등 경시·NELT 캠페인은 선택 가능하고 학교시험은 활성화되지 않는다", () => {
  let current = shell.applyCommand(state(), {
    type: "campaign_add", campaignType: "nelt", title: "가을 NELT", examDate: "2026-09-10"
  });
  const nelt = current.prepCampaigns[0];
  assert.throws(() => shell.applyCommand(current, { type: "campaign_activate", campaignId: nelt.campaignId }, { actorId: "teacher-1", today: "2026-08-03", at: "2026-08-03T09:00:00.000Z" }), /evidenceRef/);
  current = shell.applyCommand(current, { type: "campaign_activate", campaignId: nelt.campaignId, consentEvidenceRef: "consent-form:STU-1" }, {
    actorId: "teacher-1", today: "2026-08-03", at: "2026-08-03T09:00:00.000Z"
  });
  assert.equal(current.prepCampaigns[0].status, "active");
  assert.equal(current.prepCampaigns[0].consentEvidenceRef, "consent-form:STU-1");
  assert.equal(current.prepCampaigns[0].consentApprovedBy, "teacher-1");
  assert.equal(current.prepCampaigns[0].consentApprovedAt, "2026-08-03T09:00:00.000Z");
  assert.ok(current.plannerItems.length > 0);

  current = shell.applyCommand(current, {
    type: "campaign_add", campaignType: "school_regular", title: "학교시험", examDate: "2026-10-01"
  });
  const school = current.prepCampaigns.find(item => item.campaignType === "school_regular");
  assert.equal(school.activationBlockedReason, "ELEMENTARY_REGULAR_EXAM_DISABLED");
});

test("초등 KMT 캠페인 관리 화면은 순차 단계와 결과 입력만 노출한다", () => {
  const currentAt = new Date(Date.now() - 60_000).toISOString();
  let current = shell.applyCommand(state(), {
    type: "campaign_add", campaignType: "kmt", title: "가을 KMT", examDate: "2026-10-10"
  }, {});
  const campaignId = current.prepCampaigns[0].campaignId;
  current = shell.applyCommand(current, {
    type: "campaign_activate", campaignId, consentEvidenceRef: "consent:STU-1"
  }, { actorId: "teacher-1", today: "2026-08-03", at: currentAt });
  let controls = shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" });
  assert.match(controls, /data-act="lpcampaignnext"/);
  assert.match(controls, /data-next="exam_ready"/);
  current = shell.applyCommand(current, {
    type: "campaign_transition", campaignId, toStatus: "exam_ready", evidenceRef: "checklist:ready"
  }, { actorId: "teacher-1", at: currentAt });
  assert.equal(current.prepCampaigns[0].status, "exam_ready");
  assert.equal(current.prepCampaigns[0].history.at(-1).evidenceRef, "checklist:ready");
  controls = shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" });
  assert.match(controls, /data-next="taken"/);
  assert.doesNotMatch(controls, /data-lp-campaign-result=/);
});

test("오답은 메타수학 참조를 거쳐도 사람 확인 전 숙달되지 않는다", () => {
  let current = shell.applyCommand(state(), {
    type: "wrong_add", textbookId: "BOOK-1", page: "12", problemNo: "3", skillCode: "fraction"
  }, { actorId: "teacher-1", at: "2026-08-03T00:00:00.000Z" });
  const id = current.remediationCases[0].caseId;
  current = shell.applyCommand(current, { type: "wrong_advance", caseId: id }, { actorId: "teacher-1" });
  current = shell.applyCommand(current, { type: "wrong_advance", caseId: id, externalRef: "MM-SET-1" }, { actorId: "teacher-1" });
  current = shell.applyCommand(current, { type: "wrong_advance", caseId: id }, { actorId: "teacher-1" });
  current = shell.applyCommand(current, { type: "wrong_advance", caseId: id, externalRef: "MM-ASSIGN-1" }, { actorId: "teacher-1" });
  current = shell.applyCommand(current, { type: "wrong_advance", caseId: id }, { actorId: "teacher-1" });
  const resultControls = shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" });
  assert.match(resultControls, new RegExp('data-lp-wrong-correct="' + id + '"'));
  assert.match(resultControls, new RegExp('data-lp-wrong-total="' + id + '"'));
  assert.throws(() => shell.applyCommand(current, {
    type: "wrong_advance", caseId: id, externalRef: "MM-RESULT-MISSING", totalCount: 5
  }, { actorId: "teacher-1" }), /correctCount is required/);
  current = shell.applyCommand(current, {
    type: "wrong_advance", caseId: id, externalRef: "MM-RESULT-1", correctCount: 5, totalCount: 5
  }, { actorId: "teacher-1" });
  assert.equal(current.remediationCases[0].status, "verification_waiting");
  assert.equal(current.remediationCases[0].attempts[0].correctCount, 5);
  assert.equal(current.remediationCases[0].attempts[0].totalCount, 5);
  assert.equal(shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" }).includes("최근 결과 5/5"), true);
  current = shell.applyCommand(current, { type: "wrong_advance", caseId: id, mastered: true }, { actorId: "teacher-1" });
  assert.equal(current.remediationCases[0].status, "mastered");
});

test("custom provider와 빈 수량은 셸 명령·모든 선택 목록에 일관되게 반영된다", () => {
  let current = shell.applyCommand(state(), {
    type: "provider_register", providerId: "future-reader", label: "미래 리더",
    capabilities: ["progress", "result"]
  }, { actorId: "manager-1", at: "2026-08-03T09:00:00.000Z" });
  let controls = shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" });
  assert.equal((controls.match(/value="future-reader"/g) || []).length >= 3, true);
  current = shell.applyCommand(current, {
    type: "program_upsert", providerId: "future-reader", status: "active",
    assignedCount: 10, completedCount: 4
  });
  current = shell.applyCommand(current, {
    type: "program_upsert", providerId: "future-reader", status: "partial",
    assignedCount: "", completedCount: ""
  });
  assert.equal(current.programStates[0].assignedCount, 10);
  assert.equal(current.programStates[0].completedCount, 4);
  current = shell.applyCommand(current, {
    type: "provider_toggle", providerId: "future-reader", active: false
  }, { actorId: "manager-1", at: "2026-08-03T10:00:00.000Z" });
  controls = shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" });
  assert.equal((controls.match(/value="future-reader"/g) || []).length, 0);
  assert.match(controls, /다시 사용/);
});

test("플래너 셸 명령은 편집·취소·이월 승인반려 이력을 만든다", () => {
  let current = shell.applyCommand(state(), {
    type: "planner_add", date: "2026-08-03", title: "읽기", minutes: 20
  }, { actorId: "teacher-1", at: "2026-08-03T08:00:00.000Z" });
  const id = current.plannerItems[0].itemId;
  current = shell.applyCommand(current, {
    type: "planner_edit", itemId: id, date: "2026-08-04", title: "읽기 수정", minutes: 25
  }, { actorId: "teacher-1", at: "2026-08-03T09:00:00.000Z" });
  assert.equal(current.plannerItems[0].history.at(-1).action, "edited");
  current = shell.applyCommand(current, {
    type: "planner_carryover_request", itemId: id, date: "2026-08-05", reason: "미완료"
  }, { actorId: "teacher-1", at: "2026-08-03T10:00:00.000Z" });
  current = shell.applyCommand(current, {
    type: "planner_carryover_review", itemId: id, approved: false, reason: "오늘 수행"
  }, { actorId: "manager-1", at: "2026-08-03T11:00:00.000Z" });
  assert.equal(current.plannerItems[0].status, "planned");
  current = shell.applyCommand(current, {
    type: "planner_carryover_request", itemId: id, date: "2026-08-05", reason: "재요청"
  }, { actorId: "teacher-1", at: "2026-08-03T12:00:00.000Z" });
  current = shell.applyCommand(current, {
    type: "planner_carryover_review", itemId: id, approved: true, date: "2026-08-05"
  }, { actorId: "manager-1", at: "2026-08-03T13:00:00.000Z" });
  assert.equal(current.plannerItems.length, 2);
  const controls = shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" });
  assert.match(controls, /data-act="lpplanedit"/);
  assert.match(controls, /data-act="lpplancancel"/);
  assert.match(controls, /row wraprow/);
});

test("플래너 관리 버튼은 도메인이 허용하는 상태에서만 노출된다", () => {
  let current = state();
  ["예정", "수행", "확인", "이월후보", "완료", "검증대기", "일시정지"].forEach((title, index) => {
    current = shell.applyCommand(current, {
      type: "planner_add", date: "2026-08-" + String(3 + index).padStart(2, "0"), title, minutes: 10
    }, { actorId: "teacher-1", at: "2026-08-03T08:00:00.000Z" });
  });
  const byTitle = title => current.plannerItems.find(item => item.title === title);
  current.plannerItems = current.plannerItems.map(item => {
    const statuses = { "수행": "in_progress", "확인": "check_needed", "완료": "completed", "검증대기": "verification_waiting", "일시정지": "paused" };
    return statuses[item.title] ? lp.createPlannerItem(Object.assign({}, item, { status: statuses[item.title] })) : item;
  });
  const carry = byTitle("이월후보");
  current = shell.applyCommand(current, {
    type: "planner_carryover_request", itemId: carry.itemId, date: "2026-08-07", reason: "요청"
  }, { actorId: "teacher-1", at: "2026-08-03T09:00:00.000Z" });
  const controls = shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" });
  const hasAction = (action, itemId) => new RegExp('data-act="' + action + '"[^>]*data-id="' + itemId + '"').test(controls);
  ["예정", "수행", "확인"].forEach(title => {
    const item = byTitle(title);
    ["lpplanedit", "lpplancancel", "lpplancarryrequest"].forEach(action => assert.equal(hasAction(action, item.itemId), true));
    assert.equal(hasAction("lpplancarryreview", item.itemId), false);
  });
  const candidate = byTitle("이월후보");
  assert.equal((controls.match(new RegExp('data-act="lpplancarryreview"[^>]*data-id="' + candidate.itemId + '"', 'g')) || []).length, 2);
  ["lpplanedit", "lpplancancel", "lpplancarryrequest"].forEach(action => assert.equal(hasAction(action, candidate.itemId), false));
  ["완료", "검증대기", "일시정지"].forEach(title => {
    const item = byTitle(title);
    ["lpplanedit", "lpplancancel", "lpplancarryrequest", "lpplancarryreview"].forEach(action => assert.equal(hasAction(action, item.itemId), false));
  });
});

test("index는 custom import registry·명시 행선택·플래너 관리 배선을 사용한다", () => {
  const html = fs.readFileSync(__dirname + "/index.html", "utf8");
  assert.match(html, /createProgramImportProviderDefinitions/);
  assert.match(html, /registry: importRegistry/);
  assert.match(html, /applyApprovedProgramImport\(learningState, candidate, learningRegistry\)/);
  assert.doesNotMatch(html, /data-lp-import-row value=.*checked/);
  assert.match(html, /case 'lpplanedit'/);
  assert.match(html, /case 'lpplancarryreview'/);
  assert.ok(html.includes("assignedCount: ($('#lpAssigned').value || '').trim()"));
});

test("플래너 확인은 항목별 approve 또는 reject와 근거 참조만 허용한다", () => {
  let current = state();
  current = shell.applyCommand(current, { type: "planner_add", date: "2026-08-03", title: "읽기 1", minutes: 20 });
  current = shell.applyCommand(current, { type: "planner_add", date: "2026-08-03", title: "읽기 2", minutes: 20 });
  const firstId = current.plannerItems[0].itemId;
  const secondId = current.plannerItems[1].itemId;
  current = lp.claimPlannerItemCompletion(current, firstId, "student-report:1", "2026-08-03T01:00:00.000Z");
  current = lp.claimPlannerItemCompletion(current, secondId, "student-report:2", "2026-08-03T01:10:00.000Z");
  const controls = shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" });
  assert.match(controls, /data-act="lpverifyitem"/);
  assert.doesNotMatch(controls, /확인대기 전체 검증|planner_verify_all/);
  current = shell.applyCommand(current, { type: "planner_verify", itemId: firstId, approved: true, evidenceRef: "teacher-check:first" }, { actorId: "teacher-1", at: "2026-08-03T02:00:00.000Z" });
  assert.equal(current.plannerItems.find((item) => item.itemId === firstId).status, "completed");
  assert.equal(current.plannerItems.find((item) => item.itemId === secondId).status, "verification_waiting");
  assert.throws(() => shell.applyCommand(current, { type: "planner_verify_all" }, { actorId: "teacher-1" }), /지원하지 않는/);
  current = shell.applyCommand(current, { type: "planner_verify", itemId: secondId, approved: false, evidenceRef: "teacher-check:second" }, { actorId: "teacher-1", at: "2026-08-03T02:10:00.000Z" });
  const rejected = current.plannerItems.find((item) => item.itemId === secondId);
  assert.equal(rejected.status, "check_needed");
  assert.equal(rejected.verificationDecision, "rejected");
  assert.deepEqual(rejected.verificationEvidenceRefs, ["teacher-check:second"]);
});

test("초기 1년 일정은 기본 해제되고 claim 이벤트는 revision과 날짜를 저장한다", () => {
  const html = fs.readFileSync(__dirname + "/index.html", "utf8");
  const checkbox = html.match(/<input[^>]*id="lpInitSchedules"[^>]*>/);
  assert.ok(checkbox);
  assert.doesNotMatch(checkbox[0], /\bchecked\b/);
  assert.match(html, /expectedRevision: action\.expectedRevision/);
  assert.match(html, /date: action\.date/);
  assert.match(html, /data-lp-wrong-correct/);
  assert.match(html, /data-lp-wrong-total/);
  assert.match(html, /correctCount: correctCount, totalCount: totalCount/);
  assert.match(html, /case 'lpassessmentapprove'/);
  assert.match(html, /type: 'assessment_result_approve'/);
  assert.match(html, /case 'lpcampaignnext'/);
  assert.match(html, /type: 'campaign_transition'/);
  assert.doesNotMatch(html, /planner_verify_all/);
});

test("중→초→중 왕복은 학교시험을 검토대기로만 해제하고 명시 활성화 때 tombstone을 복구한다", () => {
  let current = state("middle", 7);
  current = shell.applyCommand(current, {
    type: "campaign_add", campaignType: "school_regular", title: "2학기 중간고사", examDate: "2026-10-01"
  }, {});
  const campaignId = current.prepCampaigns[0].campaignId;
  current = shell.applyCommand(current, { type: "campaign_activate", campaignId }, {
    actorId: "teacher-1", today: "2026-08-03", at: "2026-08-03T09:00:00.000Z"
  });
  const originalIds = current.plannerItems.filter(item => item.campaignId === campaignId).map(item => item.itemId);
  assert.ok(originalIds.length > 0);
  current = shell.applyCommand(current, { type: "profile_update", academicStage: "elementary", grade: 6 }, {
    actorId: "teacher-2", at: "2026-08-03T10:00:00.000Z"
  });
  const tombstones = new Map(current.plannerItems.filter(item => originalIds.includes(item.itemId)).map(item => [item.itemId, JSON.parse(JSON.stringify(item))]));
  tombstones.forEach(item => {
    assert.equal(item.status, "canceled");
    assert.equal(item.systemHidden, true);
  });

  current = shell.applyCommand(current, { type: "profile_update", academicStage: "middle", grade: 7 }, {
    actorId: "teacher-3", at: "2026-08-03T10:30:00.000Z"
  });
  const review = current.prepCampaigns.find(item => item.campaignId === campaignId);
  assert.equal(review.status, "review_pending");
  assert.equal(review.activationBlockedReason, "");
  assert.equal(review.migrationReviewRequired, true);
  assert.equal(review.consentStatus, "not_required");
  tombstones.forEach((before, itemId) => {
    const stillHidden = current.plannerItems.find(item => item.itemId === itemId);
    assert.equal(stillHidden.systemHidden, true);
    assert.equal(stillHidden.revision, before.revision);
  });
  const controls = shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" });
  assert.match(controls, new RegExp('data-act="lpactivate" data-id="' + campaignId + '"'));

  current = shell.applyCommand(current, { type: "campaign_activate", campaignId }, {
    actorId: "teacher-4", today: "2026-08-03", at: "2026-08-03T11:00:00.000Z"
  });
  assert.equal(current.prepCampaigns.find(item => item.campaignId === campaignId).status, "active");
  assert.doesNotMatch(
    shell.renderManagementControls(current, { canManage: true, today: "2026-08-03" }),
    /취소 사유: campaign_profile_transition/
  );
  tombstones.forEach((before, itemId) => {
    const restored = current.plannerItems.find(item => item.itemId === itemId);
    assert.equal(restored.systemHidden, false);
    assert.equal(restored.revision, before.revision + 1);
    assert.equal(restored.systemReactivatedAt, "2026-08-03T11:00:00.000Z");
    assert.equal(restored.systemReactivatedBy, "teacher-4");
    assert.equal(restored.history.some(event => event.action === "campaign_profile_reactivated"), true);
    assert.equal(restored.history.some(event => event.action === "canceled"), true);
  });
  assert.equal(new Set(current.plannerItems.map(item => item.itemId)).size, current.plannerItems.length);
});
