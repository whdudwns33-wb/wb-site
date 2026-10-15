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
const source = [html.match(/^const esc=.*$/m)[0], html.match(/^function uniNorm.*$/m)[0],
  section("const FIELD_KW=", "const SPECIAL_KW="),
  section("const adigaText=", "function adigaNote("),
  section("function susiKey(", "function susiStudent("),
  section("function susiStudent(", "function susiSummaryText("),
  section("function susiSummaryText(", "function renderSusi("),
  section("function renderSusi(", "function renderIpsi("),
  section("const APL_KINDS=", "/* ═══════════ 월간 캘린더"),
  section("function exportJson()", "/* ═══════════ 렌더 루트")].join("\n");
const plain = value => JSON.parse(JSON.stringify(value));

function setup() {
  let id = 0;
  const elements = new Map();
  const c = vm.createContext({
    URL, db: { students: [{ id: "one", name: "SYNTHETIC_STUDENT", grade: "고3", apply: [],
      consult: { susi: { admissionYear: "2027", gradeScale: "9", gradeAverage: "3", gradeLabel: "합성 학기" } } }], meta: {}, adiga: [] },
    view: { stuId: "one", ipsiStu: "one", aplYear: "2027" },
    uid: () => `synthetic-${++id}`, today: () => "2026-10-15",
    $: key => { if (!elements.has(key)) elements.set(key, { innerHTML: "", value: "", files: [{}] }); return elements.get(key); },
    stu: () => c.db.students.find(s => s.id === c.view.stuId), allIpRows: () => c.rows || [],
    save(next) { if(next)c.db=next;c.saves = (c.saves || 0) + 1; }, render() {}, renderSide() {}, closeModal() {},
    toast(message) { c.message = message; }, confirm: () => true,
    dday: date => date ? 1 : null, ddayChip: () => "", openStu() {},
    saveFile(name, data) { c.exported = data; },
    FileReader: class { readAsText() { this.result = c.imported; this.onload(); } }
  });
  vm.runInContext(source, c);
  return c;
}

const candidate = changes => ({ univ: "가상대학교", major: "공학과", track: "학생부교과", kind: "교과", admissionYear: "2027", ...changes });
const config = changes => ({ admissionYear: "2027", gradeScale: "9", gradeAverage: "3", gradeLabel: "합성 학기", kind: "전체", field: "전체", region: "", query: "", ...changes });

test("application identity includes year and track, retains existing input, and isolates students", () => {
  const c = setup(), s = c.stu();
  const old = c.aplNew(candidate({ memo: "existing memo", min: { on: true, sum: 4 } }));
  s.apply.push(old);
  assert.equal(c.aplAddCandidate(s, candidate({ univ: "가상대", major: " 공학과 ", admissionYear: 2027 })).card, old);
  assert.equal(old.memo, "existing memo");
  assert.equal(old.min.sum, 4);
  assert.equal(old.min.status, undefined);
  assert.equal(c.aplAddCandidate(s, candidate({ track: "학생부종합" })).created, true);
  assert.equal(c.aplAddCandidate(s, candidate({ admissionYear: "2028" })).created, true);
  assert.equal(c.aplAddCandidate(s, candidate({ admissionYear: "" })).created, true);
  const other = { id: "two", apply: [] };
  assert.equal(c.aplAddCandidate(other, candidate()).created, true);
  assert.equal(s.apply.length, 4);
  assert.equal(other.apply.length, 1);
  assert.equal(c.saves, undefined);
  const p = candidate({ track: "논술", evidence: { note: { minimum: "원문 조건" } }, consultation: { limitations: ["미확인"] } });
  const saved = c.aplAddCandidate(s, p).card;
  p.evidence.note.minimum = "changed";
  p.consultation.limitations.push("changed");
  assert.equal(saved.evidence.note.minimum, "원문 조건");
  assert.deepEqual(plain(saved.consultation.limitations), ["미확인"]);
  assert.equal(c.aplNew({ ex: { date: "2026-11-01" }, res: {} }).ex.time, "");
});

test("new minimums stay unknown until explicitly confirmed and edits require rechecking", () => {
  const c = setup(), a = c.aplAddCandidate(c.stu(), candidate()).card;
  assert.equal(c.minCheck(a.min, {}).state, "unknown");
  assert.match(c.minText(a.min), /미확인/);
  c.aplMinStatus(0, "present");
  assert.equal(a.min.status, "unknown");
  assert.match(c.message, /먼저 입력/);
  c.aplSet(0, "min.on", true);
  c.aplMinStatus(0, "present");
  assert.equal(c.minCheck(a.min, { 국: 2, 수: 2, 영: 3, 탐1: 2 }).state, "ok");
  c.aplSet(0, "min.sum", 4);
  assert.equal(c.minCheck(a.min, {}).state, "unknown");
  c.aplMinStatus(0, "none");
  assert.equal(c.minCheck(a.min, {}).state, "na");
  assert.match(c.minText(a.min), /없음 \(확인\)/);
  c.aplSet(0, "consultation.eligibility", "met");
  c.aplSet(0, "consultation.decisionReason", "원문 확인");
  assert.equal(a.consultation.decisionReason, "원문 확인");
});

test("confirmed minimums retain boundary, missing-grade, history and inquiry rules", () => {
  const c = setup(), m = c.aplNew({ min: { on: true, status: "present" } }).min;
  assert.equal(c.minCheck({ on: false }, {}).state, "unknown");
  assert.equal(c.minCheck(m, { 국: 2, 수: 2, 영: 3, 탐1: 2 }).state, "ok");
  assert.equal(c.minCheck(m, { 국: 2, 수: 3, 영: 3, 탐1: 3 }).state, "edge");
  assert.equal(c.minCheck(m, { 국: 3, 수: 3, 영: 3, 탐1: 3 }).state, "fail");
  assert.equal(c.minCheck(m, { 국: 2 }).state, "nodata");
  assert.equal(c.minCheck({ ...m, hist: 3 }, { 국: 1, 수: 1, 영: 1, 탐1: 1, 한: 4 }).state, "fail");
  const inquiry = { ...m, areas: ["영", "탐"], tam: "2" };
  assert.equal(c.minCheck(inquiry, { 영: 2, 탐1: 3, 탐2: 4 }).state, "fail");
  assert.equal(c.minCheck({ ...inquiry, tam: "2t" }, { 영: 2, 탐1: 3, 탐2: 4 }).state, "edge");
  assert.equal(c.minCheck({ ...m, must: "수" }, { 국: 1, 수: 5, 영: 1, 탐1: 1 }).state, "fail");
});

test("legacy minimums remain unconfirmed on cards without changing stored fields", () => {
  const c=setup();
  for(const min of [undefined,{on:false},{on:true,areas:["국","영"],n:2,sum:5}]){
    const a={id:"legacy",univ:"가상대",major:"합성과",kind:"교과",min},before=JSON.stringify(a);
    assert.equal(c.minCheck(min,{국:1,영:1}).state,"unknown");
    assert.match(c.minText(min),/미확인/);
    const body=c.aplCard(a,0,c.minCheck(min,{}));
    assert.match(body,/option value="unknown" selected>미확인/);
    assert.equal(JSON.stringify(a),before);
  }
  assert.equal(c.minCheck({status:"present",on:false},{}).state,"bad");
  assert.equal(c.minCheck({status:"none",on:false},{}).state,"na");
});

test("minimum calculation and input reject invalid grades instead of rounding or clamping", () => {
  const c=setup(),s=c.stu(),m={status:"present",on:true,areas:["국","영"],n:2,sum:5,tam:"1"};
  for(const grade of [-1,0,1.5,10,"oops",true,Infinity]){
    assert.equal(c.minCheck(m,{국:grade,영:2}).state,"bad");
    assert.equal(c.minCheck({...m,areas:["영","탐"]},{영:2,탐1:1,탐2:grade}).state,"bad");
  }
  assert.equal(c.minCheck(m,{국:"",영:2}).state,"nodata");
  assert.equal(c.minCheck(m,{국:"1",영:2}).state,"ok");
  s.mockRef={exam:"합성 모평",국:3};
  for(const grade of ["0","1.5","10","oops"]){c.aplRef("국",grade);assert.equal(s.mockRef.국,3);}
  assert.equal(c.saves,undefined);
  c.aplRef("국","");assert.equal(s.mockRef.국,"");
});

test("invalid saved susi averages never calculate or enter an application card", () => {
  const c=setup(),g={...candidate(),records:[{year:"2026",cut70:"3",gradeScale:"5"}]};
  for(const gradeAverage of ["7","oops","0","Infinity"]){
    const p=config({gradeScale:"5",gradeAverage}),before=JSON.stringify(p),r=c.susiAssess(g,p,[]);
    assert.equal(r.diff,null);assert.equal(r.comparison,"비교 보류");
    assert.ok(r.missing.some(x=>x.includes("저장된 수시 입력 확인 필요")));
    assert.equal(JSON.stringify(p),before);
    c.stu().consult.susi=p;c.view.susiShown=[r];c.susiSave(0);
    assert.equal(c.stu().apply.length,0);
  }
  c.rows=[{...candidate({track:"일반전형(가군)"}),year:"2026",pct:85}];
  c.db.adiga=[{...candidate({track:"나군 일반전형"})}];
  assert.equal(c.susiGroups(config()).length,0);
});

test("susi drafts survive rerender and student changes without changing saved comparisons", () => {
  const c=setup(),s=c.stu();s.consult.susi=config();
  c.rows=[{...candidate(),year:"2026",cut70:"3.2",gradeScale:"9"}];
  c.susiDraftSet("gradeAverage","4.5");c.susiDraftSet("query","temporary query");
  c.renderSusi();
  assert.match(c.$("#main").innerHTML,/id="susi_gradeAverage"[^>]*value="4.5"/);
  assert.equal(c.view.susiShown[0].diff,0.2);
  assert.equal(s.consult.susi.gradeAverage,"3");
  c.db.students.push({id:"two",name:"SYNTHETIC_OTHER",apply:[],consult:{susi:config({gradeAverage:"1"})}});
  c.view.ipsiStu="two";c.renderSusi();assert.equal(c.susiDraft(c.db.students[1]).gradeAverage,"1");
  c.view.ipsiStu="one";c.renderSusi();assert.equal(c.susiDraft(s).gradeAverage,"4.5");
  for(const [k,v] of Object.entries(config({gradeAverage:"4.5"})))c.$("#susi_"+k).value=v;
  c.save=()=>{throw Error("synthetic storage failure");};c.susiRun();
  assert.equal(c.susiDraft(s).gradeAverage,"4.5");
  c.save=()=>{};c.susiRun();assert.equal(c.view.susiDrafts.one,undefined);
  assert.equal(s.consult.susi.gradeAverage,"4.5");
});

test("cards show both note and database provenance and track edits require rechecking", () => {
  const c = setup(), a = c.aplAddCandidate(c.stu(), candidate({ evidence: {
    dbYear: "2025", metric: "70%컷", cut: 3.2, source: "합성 입결 출처", checked: "2026-10-01",
    note: { ...candidate(), resultYear: "2026", source: "합성 전형 출처", checked: "2026-10-10", url: "https://example.org/admission" }
  }, consultation: { eligibility: "met", decisionReason: "기존 근거", limitations: [] } })).card;
  let rendered = c.aplCard(a, 0, c.minCheck(a.min, {}));
  assert.match(rendered, /DB 표기 학년도: 2025/);
  assert.match(rendered, /70%컷 3\.2/);
  assert.match(rendered, /입결 결과학년도: 2026/);
  assert.match(c.susiSummaryText(c.stu()), /DB 표기\s*학년도: 2025/);
  assert.match(c.susiSummaryText(c.stu()), /입결 결과학년도: 2026/);
  const note = a.evidence.note;
  c.aplSet(0, "track", "학생부종합");
  assert.equal(a.evidence.note, note);
  assert.equal(a.evidence.note.track, "학생부교과");
  assert.equal(a.min.status, "unknown");
  assert.equal(a.consultation.eligibility, "unknown");
  assert.equal(a.consultation.decisionReason, "기존 근거");
  rendered = c.aplCard(a, 0, c.minCheck(a.min, {}));
  assert.match(rendered, /저장 당시 근거/);
});

test("year filters count only their cards and retain source indexes and safe interest imports", () => {
  const c = setup(), s = c.stu();
  for (const admissionYear of ["2026", "", "2027"]) c.aplAddCandidate(s, candidate({ admissionYear }));
  s.univs = [candidate(), candidate({ track: "종합 '특별|전형'", major: "<가상>학과" })];
  c.tabApply();
  let body = c.$("#tabbody").innerHTML;
  assert.match(body, /수시 1\/6장/);
  assert.match(body, /aplSet\(2,'memo'/);
  assert.match(body, /option value="1"/);
  c.aplFromUniv("1");
  assert.equal(s.apply[3].track, "종합 '특별|전형'");
  assert.equal(s.apply[3].admissionYear, "2027");
  c.aplFromUniv("1");
  assert.equal(s.apply.length, 4);
  c.view.applyYear = "2027";
  c.renderApply();
  assert.match(c.$("#main").innerHTML, />2\/6</);
  assert.match(c.$("#main").innerHTML, /최저 미확인 2/);
  c.view.aplYear = "";
  c.tabApply();
  body = c.$("#tabbody").innerHTML;
  assert.match(body, /수시 1\/6장/);
  assert.match(body, /aplSet\(1,'memo'/);
  assert.equal(s.apply[1].admissionYear, "");
  assert.equal(c.aplKindOf("학생부종합(지역인재)"), "종합");
  assert.equal(c.aplKindOf("지역인재"), "기타");
  const clash = { apply: [c.aplNew(candidate({ ex: { date: "2026-11-01" } })), c.aplNew(candidate({ admissionYear: "2028", ex: { date: "2026-11-01" } }))] };
  assert.equal(c.aplConflicts(clash, "2027").length, 0);
  c.view.page = "apply";
  c.view.applyYear = "2026";
  c.openApl("one");
  assert.equal(c.view.aplYear, "2026");
});

test("susi input validates scale, year and numeric bounds without inventing a grade", () => {
  const c = setup();
  assert.equal(c.susiConfig(config({ gradeAverage: "" })).gradeAverage, "");
  for (const p of [config({ gradeScale: "" }), config({ admissionYear: "202x" }), ...["0", "5.1", "3foo", "Infinity"].map(gradeAverage => config({ gradeScale: "5", gradeAverage }))]) {
    assert.throws(() => c.susiConfig(p));
  }
  assert.equal(c.susiConfig(config({ gradeScale: "5", gradeAverage: "5" })).gradeAverage, "5");
});

test("comparisons require matching verified scales, keep metrics separate and never infer eligibility", () => {
  const c = setup();
  const g = { ...candidate(), records: [{ year: "2026", cut70: "3.2", cut50: "2.8", gradeScale: "9" }] };
  let result = c.susiAssess(g, config(), []);
  assert.equal(result.diff, 0.2);
  assert.equal(result.cut.metric, "70%컷");
  assert.equal(result.excluded.length, 0);
  assert.ok(result.missing.includes("지원자격 미확인"));
  assert.equal(c.susiAssess(g, config({ gradeScale: "5" }), []).diff, null);
  assert.equal(c.susiAssess({ ...g, records: [{ year: "2026", cut70: "8", gradeScale: "5" }] }, config({ gradeScale: "5" }), []).diff, null);
  const qualitative = c.susiAssess({ ...g, track: "학생부종합(지역인재)" }, config(), []);
  assert.equal(qualitative.diff, null);
  assert.ok(qualitative.limitations.some(v => /정성평가.*미반영/.test(v)));
  assert.equal(c.susiAssess(g, config({ gradeLabel: "" }), []).diff, null);
  const unknown = { ...g, records: [{ year: "2026", cut70: "3.2" }] };
  assert.equal(c.susiAssess(unknown, config(), []).diff, null);
  assert.equal(c.susiAssess(unknown, config(), [{ univ: g.univ, admissionYear: "2027", resultYear: "2026", gradeScale: "9" }]).diff, null);
  const general = c.susiAssess(unknown, config(), [{ univ: g.univ, admissionYear: "2027", kind: "종합", seats: "30", eligibility: "다른 모집단위의 일반 안내" }]);
  assert.equal(general.note, null);
  assert.equal(general.kind, "교과");
  assert.ok(general.missing.includes("지원자격 미확인"));
  const exact = { ...candidate(), resultYear: "2026", gradeScale: "9" };
  assert.equal(c.susiAssess(unknown, config(), [{ ...exact, regular: { group: "가" } }]).note, null);
  c.db.adiga = [{ ...exact, track: "일반전형", regular: { group: "가" } }];
  assert.equal(c.susiGroups(config()).length, 0);
  assert.equal(c.susiAssess(unknown, config(), [exact]).diff, 0.2);
  assert.equal(c.susiAssess(unknown, config(), [{ ...exact, resultYear: "2025" }]).diff, null);
  const invalid = c.susiAssess(unknown, config(), [{ ...exact, kind: "학생부종합", resultYear: "2026학년도", checked: "2026-02-30", url: "javascript:alert(1)" }]);
  assert.equal(invalid.kind, "종합");
  assert.equal(invalid.diff, null);
  for (const message of ["원문 링크 미확인", "확인일 미확인", "결과학년도 미확인"]) assert.ok(invalid.missing.includes(message));
  assert.deepEqual(plain(c.susiCut({ cut70: "미공개", cut50: "2.8" })), { value: 2.8, metric: "50%컷" });
  assert.equal(c.susiCut({ cut70: "3.2 (참고)" }), null);
});

test("merge and backup round trips preserve current counseling and application details", () => {
  const c = setup(), s = c.stu();
  s.consult.susi = config();
  s.consult.susiDecisions = { decision: { excluded: true, reason: "existing" } };
  s.apply = [c.aplNew(candidate({ id: "card", memo: "existing", min: { on: true, sum: 4 } }))];
  c.imported = JSON.stringify({ students: [{ name: s.name, consult: { susi: config({ gradeAverage: "1" }), susiDecisions: { decision: { reason: "incoming" } } },
    apply: [c.aplNew(candidate({ id: "replacement", memo: "incoming" })), c.aplNew(candidate({ id: "new", admissionYear: "2028" }))] }] });
  c.doImport();
  const merged=c.stu();
  assert.equal(merged.consult.susi.gradeAverage, "3");
  assert.equal(merged.consult.susiDecisions.decision.reason, "existing");
  assert.equal(merged.apply.length, 2);
  assert.equal(merged.apply[0].memo, "existing");
  assert.equal(merged.apply[0].min.sum, 4);
  c.exportJson();
  const exported = JSON.parse(c.exported);
  assert.deepEqual(exported.students[0].consult, plain(merged.consult));
  assert.deepEqual(exported.students[0].apply, plain(merged.apply));
  c.imported = c.exported;
  c.doRestore();
  assert.deepEqual(plain(c.db.students[0].apply), exported.students[0].apply);
});
