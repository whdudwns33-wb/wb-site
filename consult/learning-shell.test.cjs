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
  current = shell.applyCommand(current, {
    type: "wrong_advance", caseId: id, externalRef: "MM-RESULT-1", correctCount: 5, totalCount: 5
  }, { actorId: "teacher-1" });
  assert.equal(current.remediationCases[0].status, "verification_waiting");
  current = shell.applyCommand(current, { type: "wrong_advance", caseId: id, mastered: true }, { actorId: "teacher-1" });
  assert.equal(current.remediationCases[0].status, "mastered");
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
  assert.doesNotMatch(html, /planner_verify_all/);
});
