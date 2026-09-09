const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* 외부 프로그램·자료 운영(제안 A 런북·요청함 / B 자산 원장 / C 수행 관제)이
   index.html에 걸어 둔 접점을 검사한다. 세 안의 화면 본체는 각자의 파일에 있고,
   여기서는 "그 파일을 부르는 자리"가 빠지거나 밀리지 않았는지만 본다. */
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8'));

test('공식 링크·런북 코어·런북 UI는 즉시 로드하고 현재 버전으로 캐시버스팅한다', () => {
  ['../shared/external-links.js', './runbook-core.js', './runbook-ui.js'].forEach(src => {
    assert.ok(html.includes('<script src="' + src + '?v=' + version.v + '"></script>'), src + ' 스크립트 태그');
  });
  // 런북 UI는 코어와 공식 링크 뒤에 와야 한다 — 로드 시점에 둘을 전제한다
  const order = ['external-links.js', 'runbook-core.js', 'runbook-ui.js'].map(name => html.indexOf(name));
  assert.ok(order[0] < order[1] && order[1] < order[2], '로드 순서: 링크 → 코어 → UI');
});

test('자산·수행 패널은 탭을 열 때만 코어 → UI 순서로 내려받는다', () => {
  assert.ok(html.includes('function loadScriptOnce(src)'), '로더');
  assert.ok(html.includes("el.src = src + '?v=' + APP_VER;"), '지연 로드도 같은 버전 스탬프를 쓴다');
  assert.ok(html.includes("lazyPanel('WBLedgerUI', ['./ledger-core.js', './ledger-ui.js']"), '자산 패널 순서');
  assert.ok(html.includes("lazyPanel('WBPerfPanel', ['./perf-core.js', './perf-panel.js']"), '수행 패널 순서');
  assert.ok(!/<script src="\.\/(ledger|perf)-/.test(html), '자산·수행 파일은 head에서 즉시 로드하지 않는다');
});

test('자산·수행 탭은 원장·관리 담당 목록에만 있고 직원 개인 링크에는 없다', () => {
  assert.ok(html.includes("['ledger', '자산', ledgerAlertCount()], ['perf', '수행', perfAlertCount()]"), '관리자 탭');
  assert.ok(/ledger: viewLedger, perf: viewPerf \};/.test(html), '라우트 맵');
  const staffTabs = html.split('\n').filter(l => l.includes("['today', '오늘 할 일']"));
  assert.equal(staffTabs.length, 1);
  assert.ok(!staffTabs[0].includes("'ledger'") && !staffTabs[0].includes("'perf'"), '직원 탭에 노출 금지');
  const allow = html.match(/const allowed = \[([^\]]*)\]/);
  assert.ok(allow && !allow[1].includes('ledger') && !allow[1].includes('perf'), '직원 라우트 허용 목록에도 없다');
});

/* 서버는 개인 링크의 '__프리픽스__<값>' 쓰기를 값 === 본인 staffId 일 때만 허용하고,
   조회도 owner 기준으로 나눈다. 자산 id·학생 id·프로그램 키가 owner 자리에 들어가면
   개인 링크에 남의 행이 섞이거나 저장이 조용히 실패한다. */
test('자산 원장·수행 기록 키는 직원 소유로 오인하지 않는다', () => {
  const fn = html.match(/function ownerOfCheck\(key\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'ownerOfCheck');
  const guard = fn[0].indexOf('/^__lic(?:ev|need)?__/.test(tid) || /^__perf(?:set|day)__/.test(tid) || /^__audit__/.test(tid)');
  assert.ok(guard > 0, '예외 분기');
  assert.ok(guard < fn[0].indexOf('__[a-zA-Z]+__'), '일반 접두 규칙보다 먼저 걸러야 한다');
  assert.ok(!fn[0].includes('/^__act__'), '조치(__act__<staffId>)는 담당 직원 소유라 예외 정규식에 넣지 않는다');
});

test('런북 슬롯은 예정 시각 + 여유(window)를 지나야 지연으로 센다', () => {
  const fn = html.match(/function alertsToday\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'alertsToday');
  assert.ok(fn[0].includes('WBRunbookCore.isRunbookTask(t) ? WBRunbookCore.dueLimit(t) : t.time'));
  assert.ok(fn[0].includes('if (limit && limit < hm) overdue++;'));
  assert.ok(!fn[0].includes('if (t.time && t.time < hm) overdue++;'), '옛 판정이 남아 있으면 두 번 센다');
});

test('지시서 등록은 런북 필드와 단계의 공식 링크 키만 통과시킨다', () => {
  const fn = html.match(/function runbookFieldsOf\(a\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'runbookFieldsOf');
  assert.ok(fn[0].includes('/^R-[A-Z0-9]+(?:-[A-Z0-9]+)*$/'), '슬롯 id 형식 검증');
  assert.ok(fn[0].includes('Math.min(600, Math.round(win))'), 'window 상한');
  const apply = html.match(/function applyAssignments\(input, preConfirmed\) \{[\s\S]*?\n\}/);
  assert.ok(apply && apply[0].includes('...runbookFieldsOf(a),'), '런북 필드 통과');
  assert.ok(apply[0].includes('window.WBExternalLinks.linkFor(ext)) step.ext = ext;'), '임의 URL이 아니라 승인된 키만');
});

test('오늘·직원 현황·마감 브리핑·단계 카드가 런북 UI를 부른다', () => {
  assert.ok(html.includes('if (window.WBRunbookUI) h += WBRunbookUI.todayBlocks(me, cursor);'), '오늘 화면 블록');
  assert.ok(html.includes('if (window.WBRunbookUI) h += WBRunbookUI.boardCard(cursor);'), '직원 현황 운영 카드');
  assert.ok(html.includes('if (window.WBRunbookUI) txt += WBRunbookUI.briefSection(date);'), '마감 브리핑 운영 절');
  assert.ok(html.includes("(window.WBRunbookUI ? WBRunbookUI.stepExt(s) : '')"), '단계 옆 공식 링크');
  // 오늘 블록은 관리자 지시·실시간 요청 카드보다 앞에 있어야 직원이 하루 순서를 먼저 본다
  assert.ok(html.indexOf('WBRunbookUI.todayBlocks(me, cursor)') < html.indexOf('h += teacherReceivedAdminDirectiveHtml(me.id);'));
});

test('수행 탭으로 옮긴 학생은 주간 횟수 손입력을 잠근다', () => {
  const fn = html.match(/function opModal\(name\) \{[\s\S]*?\n\}/);
  assert.ok(fn && fn[0].startsWith("function opModal(name) {\n  // 수행 탭(__perfset__)"), '첫 줄 가드');
  assert.ok(fn[0].includes('if (window.WBPerfPanel && WBPerfPanel.legacyOpModal(name)) return;'));
});

test('APP_VER 와 version.json 이 같다 (새 스크립트가 붙었으므로 판올림)', () => {
  const appVer = html.match(/const APP_VER = '([^']+)';/);
  assert.equal(appVer && appVer[1], version.v);
});
