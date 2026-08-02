"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const persistence = require("./learning-persistence.js");
const platform = require("./learning-platform.js");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function planner(input) {
  return platform.createPlannerItem(Object.assign({
    studentCode: "SYNC-STUDENT",
    date: "2026-08-03",
    title: "과제",
    sourceType: "academy",
    createdAt: "2026-08-03T00:00:00.000Z",
    createdBy: "teacher"
  }, input));
}

function record(items, updatedAt, mutation) {
  const value = persistence.compactPlannerItemsForStorage(items, platform.createPlannerItem);
  const result = { taskId: "__lpplan__SYNC-STUDENT", date: "all", done: true, value, updatedAt };
  if (mutation) result.planMutation = mutation;
  return result;
}

function syncRuntime(initialState) {
  const start = html.indexOf("const sync = {");
  const end = html.indexOf("\nfunction queueSync()", start);
  const source = html.slice(start, end);
  const context = {
    state: initialState,
    window: { WBLearningPersistence: persistence, WBLearningPlatform: platform },
    WBLearningPersistence: persistence,
    WBLearningPlatform: platform,
    now() { return 200; },
    MAX_SYNC_ROUNDS: 10,
    SYNC_BATCH_SIZE: 1000,
    SYNC_APP: "consult",
    syncCursor() { return context.__cursor; },
    paintStatus() {},
    save() {},
    render() {},
    toast() {},
    console: { warn() {} }
  };
  context.__cursor = { pullAt: 10, pushAt: 5 };
  vm.createContext(context);
  vm.runInContext(source + "\nthis.__sync = sync;", context);
  return context;
}

test("consult sync.apply unions lpplan by item revision even at equal updatedAt and keeps local divergence", () => {
  const localA = planner({ itemId: "A", title: "로컬 제목", revision: 2 });
  const localOnly = planner({ itemId: "LOCAL", title: "로컬 전용", revision: 1 });
  const remoteA = planner({ itemId: "A", title: "원격 제목", revision: 2 });
  const remoteB = planner({ itemId: "B", title: "원격 추가", revision: 1 });
  const mutation = { id: "lpm_pending", items: [{ itemId: "A", baseRevision: 1, nextRevision: 2 }] };
  const key = "__lpplan__SYNC-STUDENT|all";
  const localRecord = record([localA, localOnly], 100, mutation);
  const remoteRecord = record([remoteA, remoteB], 100);
  const context = syncRuntime({ checks: { [key]: localRecord }, staff: [], tasks: [] });

  assert.equal(context.__sync.apply([{ table: "checks", key, data: remoteRecord }]), 1);
  const mergedRecord = context.state.checks[key];
  const merged = persistence.restorePlannerItemsFromStorage(mergedRecord.value, platform.createPlannerItem);
  assert.deepEqual(merged.map(item => item.itemId), ["A", "LOCAL", "B"]);
  assert.equal(merged.find(item => item.itemId === "A").title, "로컬 제목");
  assert.deepEqual(mergedRecord.planMutation, mutation);
  assert.equal(mergedRecord.updatedAt, 201);
  assert.ok(mergedRecord.updatedAt > 100, "conflict must remain eligible for the next push/409");

  const normalKey = "ordinary|all";
  context.state.checks[normalKey] = { value: "local", updatedAt: 10 };
  context.__sync.apply([{ table: "checks", key: normalKey, data: { value: "equal-remote", updatedAt: 10 } }]);
  assert.equal(context.state.checks[normalKey].value, "local");
  context.__sync.apply([{ table: "checks", key: normalKey, data: { value: "newer-remote", updatedAt: 11 } }]);
  assert.equal(context.state.checks[normalKey].value, "newer-remote");
});

test("planner record merge accepts semantic-equal compact items and higher remote revisions", () => {
  const local = planner({ itemId: "A", title: "같은 과제", revision: 2 });
  const compactEqual = persistence.compactPlannerItemForStorage(local, platform.createPlannerItem);
  const semantic = persistence.mergePlannerCheckRecords(
    record([local], 20, { id: "lpm_old", items: [] }),
    { taskId: "__lpplan__SYNC-STUDENT", date: "all", done: true, value: [compactEqual], updatedAt: 20 },
    platform.createPlannerItem
  );
  assert.deepEqual(semantic.conflicts, []);
  assert.equal(Object.hasOwn(semantic.record, "planMutation"), false);

  const remoteHigher = planner({ itemId: "A", title: "원격 최신", revision: 3 });
  const higher = persistence.mergePlannerCheckRecords(
    record([local], 20, { id: "lpm_old", items: [] }),
    record([remoteHigher], 21),
    platform.createPlannerItem
  );
  const restored = persistence.restorePlannerItemsFromStorage(higher.record.value, platform.createPlannerItem);
  assert.equal(restored[0].revision, 3);
  assert.equal(restored[0].title, "원격 최신");
  assert.equal(Object.hasOwn(higher.record, "planMutation"), false);
});


test("planner merge failure aborts sync run without advancing pull or push cursors", async () => {
  const key = "__lpplan__SYNC-STUDENT|all";
  const localRecord = record([planner({ itemId: "A", revision: 1 })], 10);
  const context = syncRuntime({ checks: { [key]: localRecord }, staff: [], tasks: [] });
  context.__sync.auth = () => ({ mode: "admin" });
  context.__sync.collect = () => [];
  context.__sync.post = async () => ({
    ok: true,
    changes: [{ table: "checks", key, data: { value: { malformed: true }, updatedAt: 20 } }],
    now: 20,
    more: false
  });

  await context.__sync.run();
  assert.deepEqual(context.__cursor, { pullAt: 10, pushAt: 5 });
  assert.equal(context.__sync.dirty, true);
  assert.match(context.__sync.err, /플래너 동기화 병합 실패/);
  assert.deepEqual(context.state.checks[key], localRecord);
});
