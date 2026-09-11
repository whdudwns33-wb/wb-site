const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(startText, endText) {
  const start = html.indexOf(startText);
  const end = html.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `${startText} 구간을 찾을 수 있어야 한다`);
  return html.slice(start, end);
}

test('동기화 baseline 비교는 key map을 사용해 대형 관리자 캐시의 선형 탐색을 피한다', () => {
  const source = block('collect(since) {', '  /** 받은 변경을 반영한다');
  assert.match(source, /const canonical = new Map/);
  assert.match(source, /canonical\.get\(String\(table\) \+ '\\|' \+ String\(key\)\)/);
  assert.doesNotMatch(source, /syncRecoveryBaseline[^;]*\.some\(/);
});

test('동기화로 인한 연속 렌더는 한 프레임으로 합치고 입력 중 보류한다', () => {
  const source = block('let syncRenderPending = false;', 'const session = {');
  assert.match(source, /let syncRenderFrame = 0/);
  assert.match(source, /if \(syncRenderFrame\) return/);
  assert.match(source, /const enqueue = typeof requestAnimationFrame/);
  assert.match(source, /if \(isTaskEditorActive\(\)\) \{ syncRenderPending = true; return; \}/);
});

test('실시간 목록과 방문·인계 조회는 실제 변경이 있을 때만 전체 화면을 다시 그린다', () => {
  for (const name of ['loadTeacherLiveRequests', 'loadTuitionAlerts', 'loadAdminDirectives']) {
    const source = block(`async function ${name}`, '\n}\n');
    assert.match(source, /let shouldRender/);
    assert.match(source, /if \(shouldRender\) renderAfterSync\(\)/);
  }
  assert.match(block('async function loadLessonHandoffs', 'function ensureLessonHandoffDate'), /let scopeChanged = false/);
  assert.match(block('async function loadWeekendVisits', 'function activateWeekendVisitScope'), /scopeChanged &&/);
});

test('백그라운드 탭에서는 45초 전체 동기화를 실행하지 않고 복귀 시 visibilitychange로 갱신한다', () => {
  const source = block('function ensureSyncLoopStarted()', 'async function startSyncSession');
  assert.match(source, /if \(document\.visibilityState === 'visible'\) sync\.run\(\)/);
  assert.match(source, /}, 45000\)/);
  const visibility = block("document.addEventListener('visibilitychange'", 'let syncLoopStarted = false;');
  assert.match(visibility, /sync\.run\(\)/);
});
