"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("학습 조각과 import ledger는 한 localStorage 쓰기 후 한 번만 동기화한다", () => {
  const start = html.indexOf("function saveLearningState(");
  const end = html.indexOf("function viewLearning", start);
  assert.ok(start >= 0 && end > start);
  const body = html.slice(start, end);
  assert.match(body, /const nextChecks = Object\.assign\(\{\}, state\.checks\)/);
  assert.match(body, /localStorage\.setItem\(LS_KEY, serialized\)/);
  assert.match(body, /state = candidateState;\s*queueSync\(\)/);
  assert.doesNotMatch(body, /setCheck\(/);
  assert.equal((body.match(/queueSync\(\)/g) || []).length, 1);
});

test("완료 검증과 프로그램 import는 상태와 보조 원장을 같은 배치에 넣는다", () => {
  assert.match(html, /saveLearningState\(student\.id, next, command && command\.type === 'planner_verify'[\s\S]*clearClaimItemId/);
  assert.match(html, /saveLearningState\(student\.id, learningState, \{ importLedger: ledger \}\)/);
  assert.doesNotMatch(html, /saveLearningState\(student\.id, learningState\);\s*saveLpImportLedger/);
});

test("브리지 저장은 조각·전체 크기를 제한하고 저장 실패를 성공으로 처리하지 않는다", () => {
  assert.match(html, /bytes > 56 \* 1024/);
  assert.match(html, /serialized\)\.length > 4 \* 1024 \* 1024/);
  assert.match(html, /브라우저 저장 공간이 부족해 변경을 저장하지 않았습니다/);
  assert.match(html, /while \(size\(\) > 52 \* 1024/);
});
