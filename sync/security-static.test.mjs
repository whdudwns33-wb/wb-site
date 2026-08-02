import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const consult = fs.readFileSync(path.join(here, '..', 'consult', 'index.html'), 'utf8');
const task = fs.readFileSync(path.join(here, '..', 'task', 'index.html'), 'utf8');

test('두 관리자 앱은 PIN을 PBKDF2로 저장하고 구형 비밀정보 링크를 흡수하지 않는다', () => {
  for (const source of [consult, task]) {
    assert.match(source, /name: 'PBKDF2'/);
    assert.match(source, /iterations: 120000/);
    assert.match(source, /q\.delete\('s'\); touched = true/);
    assert.match(source, /q\.delete\('t'\); touched = true/);
    assert.match(source, /<meta name="referrer" content="no-referrer">/);
    assert.ok(source.includes("this.post('/exchange'"));
    assert.match(source, /'#c=' \+ encodeURIComponent\(code\)/);
    assert.match(source, /const linkCodeVault = new Map\(\)/);
    assert.doesNotMatch(source, /state\.settings\.myToken = tk/);
    assert.doesNotMatch(source, /'&t='/);
    assert.ok(source.indexOf('history.replaceState') < source.indexOf('const exchanged = await sync.exchangeBootstrap'));
    assert.match(source, /data-act="revokeaccess"/);
    assert.match(source, /개인 링크는 발급 후 24시간 안에 한 번 열어야 합니다/);
    assert.doesNotMatch(source, /if \(cfg\.k\) state\.settings\.syncSecret/);
    assert.doesNotMatch(source, /state\.settings\.adminPin = cfg\.p/);
  }
});

test('안전 백업 블록은 비밀키·PIN·개인 토큰을 내보내지 않는다', () => {
  const consultExport = consult.slice(consult.indexOf("case 'export':"), consult.indexOf("case 'import':"));
  const taskExport = task.slice(task.indexOf("case 'export':"), task.indexOf("case 'import':"));
  for (const block of [consultExport, taskExport]) {
    assert.doesNotMatch(block, /syncSecret\s*:/);
    assert.doesNotMatch(block, /adminPin(?:Hash|Salt|Version)?\s*:/);
    assert.doesNotMatch(block, /myToken\s*:/);
  }
});


test('task 저장소는 관리자와 검증된 개인 ID별로 격리하고 legacy는 관리자만 읽는다', () => {
  assert.ok(task.includes("const LEGACY_LS_KEY = 'wb_taskboard_v1'"));
  assert.ok(task.includes('const SAFE_SCOPE_ID = /^[A-Za-z0-9_-]'));
  assert.ok(task.includes("'wb_task_v2_person_' + (SAFE_SCOPE_ID || 'invalid')"));
  assert.ok(task.includes(": 'wb_task_v2_admin'"));
  assert.ok(task.includes("!HAS_PERSON_SCOPE ? localStorage.getItem(LEGACY_LS_KEY) : ''"));
  assert.ok(task.includes('get staffId() { return SAFE_SCOPE_ID; }'));
  assert.ok(task.includes('get isStaffLink() { return HAS_PERSON_SCOPE; }'));
  assert.doesNotMatch(task, /const LS_KEY = 'wb_taskboard_v1'/);
});
