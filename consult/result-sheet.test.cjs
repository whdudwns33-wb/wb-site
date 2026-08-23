const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const consult = fs.readFileSync(__dirname + '/index.html', 'utf8');
const guardian = fs.readFileSync(__dirname + '/../parent/consult-guardian/index.html', 'utf8');
const version = JSON.parse(fs.readFileSync(__dirname + '/version.json', 'utf8'));

test('director gets a dedicated PDF result tab while student links stay excluded', () => {
  assert.match(consult, /\['results', '결과지'\]/);
  assert.match(consult, /function viewResults\(\) \{\s*if \(!session\.isAdmin \|\| session\.isStaffLink\) return '';/);
  assert.match(consult, /accept="application\/pdf,\.pdf"/);
  assert.match(consult, /PDF 파일 · 최대 10MB/);
  assert.doesNotMatch(consult.match(/const allowed = isManager\(\)[\s\S]*?if \(!allowed\.includes\(route\)\)/)[0], /results/);
});

test('result files use authenticated POSTs and never enter consult localStorage state', () => {
  assert.match(consult, /fetch\(SYNC_URL \+ '\/consult-result-upload'/);
  assert.match(consult, /action: 'read_media'/);
  assert.match(consult, /resultSheetUi = \{ owner: '', items: \[\]/);
  assert.doesNotMatch(consult, /state\.(?:tasks|checks|settings)\.(?:results|resultSheets)/);
  assert.equal(version.v, '2026-08-23.44');
  assert.match(consult, /const APP_VER = '2026-08-23\.44'/);
});

test('guardian portal presents read-only report/result tabs with no upload or delete controls', () => {
  assert.match(guardian, /data-tab="reports">학습 리포트/);
  assert.match(guardian, /data-tab="results">영어·수학 결과지/);
  assert.match(guardian, /action:'result_media'/);
  assert.match(guardian, /읽기 전용 · 수정하거나 삭제할 수 없습니다/);
  assert.doesNotMatch(guardian, /consult-result-upload|resultarchive|type="file"/);
});
