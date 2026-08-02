"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSource = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("가져오기 검토 행은 같은 provider의 현재 원장과 반영 예정 값을 비교한다", () => {
  assert.match(indexSource, /const currentLearningState = learningStateFor\(student\)/);
  assert.match(indexSource, /program\.studentCode === student\.id && program\.providerId === row\.provider_id/);
  assert.match(indexSource, /currentSnapshot && currentSnapshot\.data/);
  assert.match(indexSource, /현재: 상태 /);
  assert.match(indexSource, / → 반영: 상태 /);
  assert.match(indexSource, /최근 이력은 프로그램별 최대 20건·8KB를 보존합니다/);
});

test("가져오기 UI는 행 선택과 명시 승인 후 승인 후보만 적용한다", () => {
  assert.match(indexSource, /data-lp-import-row/);
  assert.match(indexSource, /approveConfirmCandidates/);
  assert.match(indexSource, /approval\.approved_candidates\.forEach/);
  assert.doesNotMatch(indexSource, /lpImportReview\.candidates\.candidates\.forEach/);
});


test("가져오기 UI는 기본 미선택이며 한 행 이상 명시 선택해야 한다", () => {
  const marker = '<input type="checkbox" data-lp-import-row';
  const start = indexSource.indexOf(marker);
  assert.notEqual(start, -1);
  const checkbox = indexSource.slice(start, indexSource.indexOf('>', start) + 1);
  assert.equal(checkbox.includes(' checked'), false);
  assert.equal(indexSource.includes('기본 선택은 없습니다'), true);
  assert.equal(indexSource.includes('[data-lp-import-row]:checked'), true);
  assert.equal(indexSource.includes('반영할 행을 한 개 이상 선택해 주세요'), true);
});

test("가져오기 승인은 학생·검토 identity·중복·이중 실행을 방어한다", () => {
  assert.equal(indexSource.includes('let lpImportApplying = false'), true);
  assert.equal(indexSource.includes("lpImportApplying) return toast('프로그램 승인 반영이 이미 진행 중입니다"), true);
  assert.equal(indexSource.includes('finally { lpImportApplying = false; }'), true);
  assert.equal(indexSource.includes('previewSequence !== lpImportPreviewSequence'), true);
  assert.equal(indexSource.includes('activeStudent.id !== student.id'), true);
  assert.equal(indexSource.includes('review.reviewKey !== lpImportReviewKey'), true);
  assert.equal(indexSource.includes('expectedStudentCode: student.id'), true);
  assert.equal(indexSource.includes('alreadyApprovedDuplicateKeys: Array.from(currentKeys)'), true);
});

test("관리자 필수 근거는 플랫폼 영문 예외 전에 한국어로 안내한다", () => {
  assert.equal(indexSource.includes('완료 근거 참조를 입력해 주세요'), true);
  assert.equal(indexSource.includes('학생·보호자 동의 증빙 참조를 입력해 주세요'), true);
  assert.equal(indexSource.includes('평가 결과를 확인한 근거 참조를 입력해 주세요'), true);
  assert.equal(indexSource.includes('현재 단계를 확인한 근거 참조를 입력해 주세요'), true);
});
