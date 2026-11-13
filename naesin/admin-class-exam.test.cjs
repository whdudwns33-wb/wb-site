'use strict';
/* 화면 원본을 실행해 반 선택·저장·해제와 시험 결과 명부를 검증한다. 예시는 자체 창작이다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const COV = require('./coverage.js');
const READY = require('./readiness.js');
const html = fs.readFileSync(path.join(__dirname, '../reading-server/public/naesin-admin.html'), 'utf8');
const inline = html.split('<script>')[1].split('</script>')[0];
const stop = inline.indexOf("$('#btnRefresh').onclick=refresh;");
assert.ok(stop > 1000, '관리 화면 초기화 경계를 찾지 못했다');
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

function screen(roster = [], exams = [], results = []) {
  const nodes = new Map(), requests = [], confirms = [];
  let saved = exams;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', value: '', hidden: false, focus() {}, querySelectorAll: () => [] });
    return nodes.get(id);
  };
  const ctx = vm.createContext({
    localStorage: { getItem: () => null }, WBNaesinCoverage: COV, WBNAESINREADY: READY,
    document: { querySelector: node, querySelectorAll: selector => selector === '#exPacks input:checked' ? [{ value: 'sample-L1' }] : [] },
    confirm: text => { confirms.push(text); return true; },
    fetch: async (url, opt) => {
      requests.push({ url, ...opt });
      const body = opt.body ? JSON.parse(opt.body) : null;
      if (opt.method === 'POST') { saved = [{ ...body, expired: false }]; return { status: 200, ok: true, json: async () => ({ scope: body.scope, exam: body }) }; }
      if (opt.method === 'DELETE') saved = saved.filter(ex => ex.scope !== body.scope);
      return { status: 200, ok: true, json: async () => ({ exams: saved, today: '2026-10-12' }) };
    },
  });
  vm.runInContext(inline.slice(0, stop) + `
    this.ui={scopeLabel,renderExamForm,renderExamList,saveExam,deleteExam,resultRoster,
      set:(roster,exams,results)=>{ROSTER=roster;EXAMS=exams;RESULTS=results;OV={students:[]};PACKS=['sample-L1'];}};`, ctx);
  ctx.ui.set(roster, Object.assign(exams, { today: '2026-10-12' }), results);
  return { ...ctx.ui, node, requests, confirms };
}
const roster = [
  { code: 'ST1', name: '학생 하나', cls: '가반' },
  { code: 'ST2', name: '학생 둘', cls: '  가반  ' },
  { code: 'ST3', name: '학생 셋', cls: '나반' },
  { code: 'ST4', name: '학생 넷', cls: '' },
  { code: 'cls', name: '기존 코드 학생', cls: 'cls' },
];

(async () => {
  await t('학습용 반 배정은 날짜·단어 마감 없이 저장하고 미정으로 표시한다', async () => {
    const ui = screen(roster);
    ui.renderExamForm();
    ui.node('#exMode').value = 'practice'; ui.node('#exMode').onchange();
    assert.equal(ui.node('#exDate').disabled, true); assert.equal(ui.node('#exWdd').disabled, true);
    ui.node('#exScope').value = 'cls:가반'; ui.node('#exDate').value = '2027-01-01'; ui.node('#exWdd').value = '7';
    await ui.saveExam();
    const body = JSON.parse(ui.requests.find(r => r.method === 'POST').body);
    assert.equal(body.mode, 'practice'); assert.equal(body.examDate, ''); assert.ok(!Object.hasOwn(body, 'wordDeadlineDays'));
    assert.match(ui.node('#examList').innerHTML, /미정/); assert.match(ui.node('#examList').innerHTML, /마감 없음/);
    ui.node('#exMode').value = 'exam'; ui.node('#exMode').onchange(); assert.equal(ui.node('#exDate').disabled, false);
  });
  await t('명부의 반만 선택지로 만들고 정규화·중복 제거·이스케이프한다', () => {
    const ui = screen([...roster, { code: 'ST5', cls: '<img src=x onerror=alert(1)>' }, { code: 'ST6', cls: '잘못\n반' }]);
    ui.renderExamForm();
    const form = ui.node('#examArea').innerHTML;
    assert.equal((form.match(/value="cls:가반"/g) || []).length, 1);
    assert.match(form, /<optgroup label="반 배정">/);
    assert.match(form, /value="cls:나반"/);
    assert.match(form, /value="cls:cls"/);
    assert.match(form, /value="cls"/);
    assert.match(form, /학생 개별 → 반 배정 → 전체 공통/);
    assert.ok(!form.includes('<img') && form.includes('&lt;img'));
    assert.ok(!form.includes('value="cls:잘못'));
  });

  await t('반 선택을 prefix 키로 저장하고 기존 학생·공통 저장도 유지한다', async () => {
    for (const scope of ['cls:가반', 'cls', 'ST1', 'default']) {
      const ui = screen(roster);
      ui.node('#exScope').value = scope;
      ui.node('#exDate').value = '2099-10-22';
      ui.node('#exWdd').value = '7';
      await ui.saveExam();
      const post = ui.requests.find(r => r.method === 'POST');
      assert.ok(post, scope + ' 저장 요청이 없다');
      assert.deepEqual(JSON.parse(post.body), { scope, examDate: '2099-10-22', packIds: ['sample-L1'], wordDeadlineDays: 7 });
      assert.match(ui.node('#examOut').innerHTML, /등록 완료/);
      if (scope === 'cls:가반') assert.match(ui.node('#examList').innerHTML, /가반 · 반 배정/);
    }
  });

  await t('깨진 반 키는 저장 전에 거절한다', async () => {
    for (const scope of ['cls:', 'cls:  가반', 'cls:가\n반', 'cls:' + '가'.repeat(81)]) {
      const ui = screen(roster);
      ui.node('#exScope').value = scope;
      await ui.saveExam();
      assert.equal(ui.requests.length, 0);
      assert.match(ui.node('#examOut').innerHTML, /반 이름을 확인/);
    }
  });

  await t('반·개별 만료 안내와 배정 해제 후 폴백을 구별한다', async () => {
    const ui = screen(roster, [{ scope: 'cls:가반', examDate: '2026-10-11', expired: true },
      { scope: 'ST1', examDate: '2026-10-11', expired: true }]);
    ui.renderExamList();
    assert.match(ui.node('#examList').innerHTML, /만료되어 전체 공통을 따름/);
    assert.match(ui.node('#examList').innerHTML, /만료되어 반 배정 → 전체 공통을 따름/);
    await ui.deleteExam('cls:가반');
    assert.deepEqual(JSON.parse(ui.requests.find(r => r.method === 'DELETE').body), { scope: 'cls:가반' });
    assert.match(ui.confirms[0], /개별 배정이 있으면 그것을, 없으면 전체 공통/);
    assert.ok(!ui.node('#examList').innerHTML.includes('data-scope="cls:가반"'));
    await ui.deleteExam('ST1');
    assert.match(ui.confirms[1], /반 배정 → 전체 공통/);
  });

  await t('시험 결과는 만료된 학생·반 배정을 유지하고 반 키를 학생으로 만들지 않는다', () => {
    const ui = screen(roster, [{ scope: 'default', examDate: '2026-10-10', expired: true },
      { scope: 'cls:가반', examDate: '2026-10-11', expired: true },
      { scope: 'ST1', examDate: '2026-10-09', expired: true }]);
    const codes = date => Array.from(ui.resultRoster(date).rows, s => s.code).sort();
    assert.deepEqual(codes('2026-10-09'), ['ST1']);
    assert.deepEqual(codes('2026-10-11'), ['ST2']);
    assert.deepEqual(codes('2026-10-10'), ['ST3', 'ST4', 'cls']);
    assert.equal(ui.resultRoster('2026-10-11').fallback, false);
    assert.ok(!codes('2026-10-11').some(code => code.startsWith('cls:')));
  });

  await t('기존 개별·공통 결과 명부와 삭제·퇴원 뒤 남은 결과를 보존한다', () => {
    const ui = screen(roster, [{ scope: 'default', examDate: '2026-10-10' },
      { scope: 'ST1', examDate: '2026-10-09' }, { scope: 'OLD1', examDate: '2026-10-09' }],
    [{ code: 'LEFT1', examDate: '2026-10-09', score: 70 }]);
    assert.deepEqual(Array.from(ui.resultRoster('2026-10-09').rows, s => s.code).sort(), ['LEFT1', 'OLD1', 'ST1']);
    assert.deepEqual(Array.from(ui.resultRoster('2026-10-10').rows, s => s.code).sort(), ['ST2', 'ST3', 'ST4', 'cls']);
    assert.equal(ui.resultRoster('2026-10-01').fallback, true, '임의 날짜 점수 입력도 보존');
    assert.deepEqual(Array.from(ui.resultRoster('2026-10-01').rows, s => s.code).sort(), ['ST1', 'ST2', 'ST3', 'ST4', 'cls'], '임의 날짜에는 현재 명부만');
  });
  console.log('통과 ' + passed);
})().catch(e => { console.error(e); process.exitCode = 1; });
