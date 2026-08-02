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
