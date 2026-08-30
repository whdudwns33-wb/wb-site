const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let i = open; i < html.length; i++) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(name + ' function is incomplete');
}

function renderTabsHtml(sessionValue, manager) {
  const target = { innerHTML: '' };
  const source = functionSource('renderTabs');
  new Function(
    'session', 'isManager', 'alertsToday', '$', 'requestAnimationFrame', 'route',
    source + '; renderTabs();'
  )(
    sessionValue,
    () => manager,
    () => ({ total: 0 }),
    selector => selector === '#tabs' ? target : null,
    () => {},
    'today'
  );
  return target.innerHTML;
}

test('usage guide tab is available only in the regular student screen', () => {
  const student = renderTabsHtml({ isStaffLink: true, isAdmin: false }, false);
  const manager = renderTabsHtml({ isStaffLink: true, isAdmin: false }, true);
  const admin = renderTabsHtml({ isStaffLink: false, isAdmin: true }, false);

  assert.match(student, /data-go="guide"[^>]*>사용 안내/);
  assert.doesNotMatch(manager, /data-go="guide"/);
  assert.doesNotMatch(admin, /data-go="guide"/);

  const render = functionSource('render');
  assert.match(render, /:\s*\['guide', 'today', 'week', 'month', 'academic', 'ingang', 'study'\]/);
  assert.match(render, /guide:\s*viewStudentGuide/);
});

test('student guide explains the required routine and optional modules', () => {
  const guide = functionSource('viewStudentGuide');
  [
    /오늘 배부된 공부/,
    /내 체크리스트로 가져오기/,
    /완료 표시/,
    /오늘 학습 마무리/,
    /보고 문자 복사/,
    /내일로 이월/,
    /주간 마무리/,
    /월간 마무리/,
    /개인 링크/
  ].forEach(pattern => assert.match(guide, pattern));
  assert.match(guide, /공부시간 기록과 인강 관리는 해당하는 학생만/);
  assert.match(guide, /공부시간·플래너[\s\S]*?시간을 기록하는 학생/);
  assert.match(guide, /인강 관리[\s\S]*?등록된 인강이 있는 학생만/);
  assert.match(guide, /data-go="today"/);
});

test('a newly connected student enters the guide after successful sync', () => {
  const connect = functionSource('connectStudentLink');
  const exchangeAt = connect.indexOf('await sync.exchangeBootstrap(staffId, code)');
  const storedAt = connect.indexOf('resetStudentLinkCache(d.token)');
  const syncAt = connect.indexOf('await sync.run()');
  const guideAt = connect.indexOf("go('guide')");
  const catchAt = connect.indexOf('} catch');

  assert.equal((connect.match(/go\('guide'\)/g) || []).length, 1);
  assert.ok(exchangeAt >= 0 && exchangeAt < storedAt);
  assert.ok(storedAt < syncAt && syncAt < guideAt);
  assert.ok(guideAt < catchAt, 'failed link exchanges must not enter the guide');

  assert.match(functionSource('absorbLinkParams'), /const tk = q\.get\('t'\);[\s\S]*?pendingStudentWelcome = true/);
  assert.match(html, /if \(pendingStudentWelcome && session\.isStaffLink && !isManager\(\)\) route = 'guide'/);
});

test('student guide layout remains single-column on small screens', () => {
  assert.match(html, /\.student-guide-steps, \.student-guide-options, \.student-guide-closes, \.student-guide-tabs \{ grid-template-columns: 1fr; \}/);
});
