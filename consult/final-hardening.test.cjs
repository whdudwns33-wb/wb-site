const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function between(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'source block not found: ' + start);
  return html.slice(a, b);
}

test('local save failure is persistent, non-destructive, and clears only after success', () => {
  const source = between('let state = blankState();', '/* ══════════════════════════════════════════════════════\n   2. 날짜 유틸');
  const alert = { hidden: true, innerHTML: '' };
  const submit = { disabled: false, dataset: {} };
  let fail = true;
  let persisted = 'existing-data';
  const api = new Function('blankState', 'localStorage', 'document', 'sync', 'paintStatus', 'LS_KEY', 'session',
    source + ';return {save,paintStorageAlert,canExportBackup,getError:()=>storageError,getBlocked:()=>saveFailedThisTurn};')(
      () => ({ staff: [], tasks: [], checks: {}, settings: {} }),
      { setItem(key, value) { assert.equal(key, 'wb_consult_v1'); if (fail) throw new Error('quota'); persisted = value; } },
      {
        getElementById(id) { return id === 'storageAlert' ? alert : null; },
        querySelectorAll() { return [submit]; }
      },
      { enabled: () => false },
      () => {},
      'wb_consult_v1',
      { isAdmin: true, isStaffLink: false }
    );

  assert.equal(api.save(), false);
  assert.equal(persisted, 'existing-data', '기존 저장값을 삭제하거나 덮지 않는다');
  assert.equal(api.getError(), 'LOCAL_SAVE_FAILED');
  assert.equal(api.getBlocked(), true);
  assert.equal(alert.hidden, false);
  assert.equal(submit.disabled, true, '원래 제출 버튼을 막아 신규 task/block 중복을 방지한다');
  assert.match(alert.innerHTML, /화면을 닫지 말고 백업/);
  api.paintStorageAlert({ isAdmin: false, isStaffLink: true });
  assert.doesNotMatch(alert.innerHTML, /data-act="export"/,
    '학생 저장 실패 화면에는 전체 백업을 노출하지 않는다');
  assert.equal(api.canExportBackup({ isAdmin: false, isStaffLink: true }), false);
  api.paintStorageAlert({ isAdmin: true, isStaffLink: false });

  fail = false;
  assert.equal(api.save(), true);
  assert.equal(api.getError(), '');
  assert.equal(alert.hidden, true);
  assert.equal(submit.disabled, false);
  assert.match(html, /if \(storageError\) msg = '기기 저장 실패/,
    '뒤따르는 성공 토스트가 저장 실패를 가리지 않는다');
  assert.match(html, /if \(saveFailedThisTurn\) return false/,
    '저장 실패와 같은 이벤트에서 성공 모달을 닫지 않는다');
  assert.match(html, /lockStorageFailureControls\(true\)/);
  assert.match(html, /if \(storageError\) lockStorageFailureControls\(true\)/,
    '저장 실패 뒤 새로 연 모달도 제출 버튼을 다시 활성화하지 않는다');
  assert.match(html, /const storageSafeActions = \['closemodal', 'storageretry', 'syncretry', 'syncnow', 'storagehelp', 'export'\]/);
  assert.match(html, /if \(storageError && !storageSafeActions\.includes\(act\)\)/,
    '저장 복구 전에는 새 mutation을 시작하지 않는다');
  const setCheckSource = between('function setCheck(taskId, date, patch) {', '/** 단계·수량을 고려한 개별 업무 진행률 */');
  assert.match(setCheckSource, /if \(storageError\)[\s\S]*return null/,
    '메모·체크 입력도 복구 전 추가 변경을 만들지 않는다');
  assert.match(setCheckSource, /const stored = save\(\)[\s\S]*return stored \? next : null/);
  assert.match(html, /data-act="storageretry"/);
  assert.match(html, /case 'storageretry':[\s\S]{0,180}if \(!save\(\)\) break/,
    '실패한 mutation을 다시 실행하지 않고 현재 상태만 저장한다');
  const retryCase = between("    case 'storageretry':", "    case 'syncnow':");
  assert.doesNotMatch(retryCase, /state\.(?:tasks|staff|checks)|\.push\(|setCheck|commitExamPlan/);
});

test('sync keeps all local changes, exposes retry, and does not erase active forms', () => {
  const run = between('  async run() {', '  /** 개인 링크용 토큰 발급');
  assert.match(run, /while \(pending\.length \|\| more\)/);
  assert.doesNotMatch(run, /guard\+\+ < 60/);
  assert.ok(run.indexOf('if (!pending.length && !localCursorSaved)') < run.indexOf('state.settings.pushAt = t0'),
    '모든 로컬 변경을 보낸 뒤 전송 커서를 전진한다');
  assert.match(run, /마지막 pullAt과 마지막 페이지의 원격 변경[\s\S]{0,120}save\(\)/);
  assert.match(run, /if \(applied\) renderAfterSync\(\)/);
  assert.match(html, /sync\.enabled\(\) && sync\.err[\s\S]{0,120}동기화 실패 · 다시 시도/);
  assert.match(html, /case 'syncretry':[\s\S]{0,220}sync\.run\(\)/);
  assert.match(html, /function activeViewEditor\(\)[\s\S]*closest\('#view'\)/);
  assert.match(html, /function renderAfterSync\(\)[\s\S]*sync\.pendingRender = true/);
  assert.match(html, /let viewInputDirty = false/);
  assert.match(html, /document\.addEventListener\('input'[\s\S]*viewInputDirty = true/);
  assert.match(html, /const stored = setCheck\(noteEl\.dataset\.id[\s\S]*if \(stored\) \{ viewInputDirty = false/,
    '자동 저장 메모는 저장 성공 뒤에만 입력 보류를 해제한다');
  assert.match(html, /loadSubmissions\([\s\S]*?finally[\s\S]*?renderAfterSync\(\)/);
  assert.doesNotMatch(html, /document\.addEventListener\('focusout'[\s\S]*renderAfterSync\(\)/,
    '포커스를 다른 폼 조작으로 옮겼다는 이유만으로 미저장 입력을 지우지 않는다');
  assert.match(html, /function render\(\) \{\s*sync\.pendingRender = false;\s*viewInputDirty = false/,
    '명시적 화면 전환·저장 렌더에서만 보류 상태를 해소한다');
});

test('student links refresh expired tokens only after a successful sync', () => {
  const helpers = between('async function ensureTokens(ids) {', '\n\nfunction orderText');
  assert.match(helpers, /await sync\.run\(\)/);
  assert.match(helpers, /if \(sync\.err\) throw/);
  assert.match(helpers, /Promise\.all\(list\.map\(s => sync\.issueToken\(s\.id\)\)\)/);
  assert.doesNotMatch(helpers, /if \(s\.token\) return/,
    '저장된 토큰은 만료·해제됐을 수 있으므로 새 링크에 재사용하지 않는다');
  const allLinks = between("    case 'alllinks':", "    case 'adminlink':");
  assert.match(allLinks, /ensureTokens\(list\.map\(s => s\.id\)\)/);
  assert.doesNotMatch(allLinks, /catch\(\(\) => null\)/,
    '일부 발급 실패를 숨긴 채 토큰 없는 링크를 복사하지 않는다');
  const textLinks = between("    case 'orderText':", "    case 'dailycloseopen':");
  assert.match(textLinks, /ensureToken\(id\)/);
  assert.match(html, /setTimeout\(\(\) => ensureToken\(t\.staffId\)/,
    '안내 문자에도 발급이 확인된 학생 링크만 넣는다');
});

test('backup export is fail-closed for student links', () => {
  const exportCase = between("    case 'export':", "    case 'import':");
  const guard = exportCase.indexOf('if (!session.isAdmin || session.isStaffLink)');
  const blob = exportCase.indexOf('new Blob');
  assert.ok(guard >= 0 && blob > guard, '권한 검사 뒤에만 백업 파일을 만든다');
  assert.match(exportCase, /return toast\('백업은 원장 화면에서만 할 수 있습니다'\)/);
});

test('write form keeps unfinished text while toggling options or editing the draft list', () => {
  const helpers = between('const WRITE_INPUT_IDS =', '\n\nfunction viewWrite()');
  assert.match(helpers, /'wTitle'/);
  assert.match(helpers, /'wDetail'/);
  assert.match(helpers, /'wGuide'/);
  assert.match(helpers, /'wSteps'/);
  assert.match(helpers, /function renderWritePreservingInputs\(\)[\s\S]*writeInputSnapshot\(\)[\s\S]*render\(\)[\s\S]*field\.value = snapshot\.values\[id\]/);
  const handlers = between("    case 'wcarry':", "    case 'wpublish':");
  const carry = handlers.slice(0, handlers.indexOf("    case 'wevidence':"));
  const evidence = handlers.slice(handlers.indexOf("    case 'wevidence':"), handlers.indexOf("    case 'wadd':"));
  assert.doesNotMatch(carry, /render\(\)/);
  assert.doesNotMatch(evidence, /render\(\)/);
  assert.match(handlers, /case 'wdel':[\s\S]{0,100}renderWritePreservingInputs\(\)/);
  assert.match(handlers, /case 'wclear':[\s\S]{0,100}renderWritePreservingInputs\(\)/);
});

test('shared modal has dialog semantics, focus trap, escape close, and focus return', () => {
  const modalSource = between('let modalReturnFocus = null;', 'function b64(str)');
  assert.match(modalSource, /role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1"/);
  assert.match(modalSource, /if \(!host\.firstElementChild\) rememberModalReturnFocus/);
  assert.match(modalSource, /requestAnimationFrame/);
  assert.match(modalSource, /restoreModalReturnFocus\(\)/);
  const keyboard = between('/* 모달 키보드 이동 · 엔터 제출 */', '/* 복귀 시 최신화 */');
  assert.match(keyboard, /ev\.key === 'Escape'/);
  assert.match(keyboard, /ev\.key === 'Tab'/);
  assert.match(keyboard, /ev\.shiftKey/);
  assert.match(keyboard, /last\.focus\(\)/);
  assert.match(keyboard, /first\.focus\(\)/);
  assert.match(modalSource, /clearSubmissionPreview\(\)/);
  assert.match(modalSource, /clearGuardianShareUi\(\)/);
});

test('consult cache version is isolated from the task app version', () => {
  const rootVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')).v;
  const consultVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).v;
  const taskHtml = fs.readFileSync(path.join(__dirname, '..', 'task', 'index.html'), 'utf8');
  assert.notEqual(consultVersion, rootVersion);
  assert.match(html, new RegExp("const APP_VER = '" + consultVersion.replaceAll('.', '\\.') + "'"));
  assert.match(html, /fetch\('\.\/version\.json\?t='/);
  assert.match(taskHtml, new RegExp("const APP_VER = '" + rootVersion.replaceAll('.', '\\.') + "'"));
  assert.match(taskHtml, /fetch\('\.\.\/version\.json\?t='/);
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);
});
