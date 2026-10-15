import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("./app.html", import.meta.url), "utf8");
const section = (start, end) => {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing source section: ${start}`);
  return html.slice(a, b);
};
const source = [html.match(/^const esc=.*$/m)[0],
  section("function normCdf(", "const CUM9="),
  section("const ACH_TERMS=", "function renderHsSim(")].join("\n");

function setup() {
  const names = ["동명중학교 (지역가)", "동명중학교 (지역나)", "가상고등학교"];
  const subjects = ["국어", "영어", "수학", "사회", "과학"];
  const context = vm.createContext({
    BULK: { ach: { s: names, j: subjects, ambiguous: { 동명중학교: names.slice(0, 2) },
      r: names.flatMap((_, i) => subjects.map((_, j) =>
        [i, i === 2 ? 1 : 0, 25, 1, 1, j, 70, i === 1 ? 60 : 20, i === 1 ? 10 : 20, 10, 10, i === 1 ? 10 : 40])) } },
    db: { achdb: {} }, view: { achSchool: "동명중학교", hsAch: { "중1-1": "AAAAA" } },
    document: { getElementById: () => null },
    save() {}, render() {}, toast(message) { context.message = message; }
  });
  vm.runInContext(source, context);
  return context;
}

test("ambiguous names do not apply old manual data or overwrite it", () => {
  const c = setup(), old = { level: "중", rows: [] };
  c.db.achdb["동명중학교"] = old;
  assert.equal(c.achFor("동명중학교"), null);
  assert.equal(c.achResult().corr, null);
  assert.equal(c.achEff().corrected, false);
  c.achDoSave();
  assert.match(c.message, /지역을 포함한 학교/);
  assert.equal(c.db.achdb["동명중학교"], old);
  assert.match(c.achCorrHtml(), /지역을 포함한 학교/);
});

test("region selection uses its own distribution and retains qualified manual overrides", () => {
  const c = setup();
  const panel = c.achPanelHtml();
  assert.match(panel, /label for="achschool-region"/);
  assert.match(panel, /value="동명중학교 \(지역가\)"/);
  assert.match(panel, /value="동명중학교 \(지역나\)"/);
  assert.equal(c.achFor("동명중학교 (지역가)").rows[0].d[0], 20);
  assert.equal(c.achFor("동명중학교 (지역나)").rows[0].d[0], 60);
  c.view.achSchool = "동명중학교 (지역나)";
  assert.equal(c.achResult().corr.ok, true);
  assert.ok(!c.achPanelHtml().includes('id="achschool-region"'));
  const manual = { level: "중", rows: [] };
  c.db.achdb[c.view.achSchool] = manual;
  assert.equal(c.achFor(c.view.achSchool), manual);
});

test("legacy data and high-school correction guard still work", () => {
  const c = setup();
  delete c.BULK.ach.ambiguous;
  const manual = { level: "중", rows: [] };
  c.db.achdb["동명중학교"] = manual;
  assert.equal(c.achFor("동명중학교"), manual);
  c.view.achSchool = "가상고등학교";
  assert.equal(c.achResult().corr, null);
  assert.match(c.achHsHtml(c.view.achSchool), /공시 성취도/);
  assert.match(c.achHsHtml(c.view.achSchool), /1학년 공통/);
  c.view.achSchool = "constructor";
  assert.doesNotThrow(() => c.achPanelHtml());
});
