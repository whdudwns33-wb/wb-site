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

function renderTabsHtml(sessionValue, manager, hasRoadmap = false) {
  const target = { innerHTML: '' };
  const source = functionSource('renderTabs');
  new Function(
    'session', 'isManager', 'alertsToday', '$', 'requestAnimationFrame', 'route', 'teamStaff', 'currentStaff', 'studyRoadmapActive',
    source + '; renderTabs();'
  )(
    sessionValue,
    () => manager,
    () => ({ total: 0 }),
    selector => selector === '#tabs' ? target : null,
    () => {},
    'today',
    () => [],
    () => ({ id: 'student-a' }),
    () => hasRoadmap
  );
  return target.innerHTML;
}

test('usage guide tab is available in the regular student and admin screens', () => {
  const student = renderTabsHtml({ isStaffLink: true, isAdmin: false }, false);
  const studentWithRoadmap = renderTabsHtml({ isStaffLink: true, isAdmin: false }, false, true);
  const manager = renderTabsHtml({ isStaffLink: true, isAdmin: false }, true);
  const admin = renderTabsHtml({ isStaffLink: false, isAdmin: true }, false);

  assert.match(student, /data-go="guide"[^>]*>사용 안내/);
  assert.doesNotMatch(manager, /data-go="guide"/);
  assert.match(admin, /data-go="guide"[^>]*>사용 안내/);
  assert.doesNotMatch(student, /data-go="roadmap"/);
  assert.doesNotMatch(manager, /data-go="roadmap"/);
  assert.match(studentWithRoadmap, /data-go="roadmap"[^>]*>로드맵/);
  assert.match(admin, /data-go="roadmap"[^>]*>로드맵/);

  const render = functionSource('render');
  assert.match(render, /:\s*\['guide', 'today', 'week', 'roadmap', 'month', 'academic', 'ingang', 'study'\]/);
  assert.match(render, /guide:\s*viewStudentGuide/);
  assert.match(render, /session\.isAdmin && !session\.isStaffLink/);

  const guide = functionSource('viewStudentGuide');
  assert.match(guide, /adminPreview/);
  assert.match(guide, /원장 확인용 · 학생 사용 안내/);
  assert.match(guide, /studentSelf \? studentSetupStatus\(me\.id\) : null/);
  assert.match(guide, /adminPreview \? '학생용 플래너'/);
});

test('student guide explains the required routine and optional modules', () => {
  const guide = functionSource('viewStudentGuide');
  [
    /오늘 배부된 공부/,
    /내 체크리스트로 가져오기/,
    /완료 표시/,
    /하루 마감/,
    /보고 문자 복사/,
    /내일로 이월/,
    /주간 마무리/,
    /월간 마무리/,
    /학생용 링크/
  ].forEach(pattern => assert.match(guide, pattern));
  assert.match(guide, /공부시간 기록과 인강 관리는 해당하는 학생만/);
  assert.match(guide, /반복 배정된 리더스아이·하루 비문학은 오늘 체크리스트에 자동으로 표시/);
  assert.match(guide, /온라인 학습은[^]*?<code>학습 완료 기록<\/code>을 눌러/);
  assert.match(guide, /온라인 학습 실행·완료 기록/);
  assert.match(guide, /순공시간 기록[\s\S]*?시간을 기록하는 학생/);
  assert.match(guide, /인강 관리[\s\S]*?등록된 인강이 있는 학생만/);
  assert.match(guide, /온라인 학습 사용 매뉴얼/);
  assert.match(guide, /브레인레터·청크브레인·어휘브레인·리더스아이·메타수학/);
  assert.match(guide, /Agency ID <code>wbbrain<\/code>/);
  assert.match(guide, /사이트를 닫는 것만으로는 완료 처리되지 않습니다/);
  assert.match(guide, /현재 학생 기기에만 저장되고 서버·원장 화면·백업으로 전송되지 않습니다/);
  assert.match(guide, /목표 학교와 교재 로드맵/);
  assert.match(guide, /전체 범위가 학습 요일에 자동으로 나뉘어/);
  assert.match(guide, /로드맵[^]*목표 학교·교재별 전체 진도율[^]*이번 주 배정 분량/);
  assert.match(guide, /원장 화면에서만 바꿀 수 있으므로/);
  assert.match(guide, /data-go="today"/);
});

test('student guide keeps the daily routine visible and folds reference sections', () => {
  const guide = functionSource('viewStudentGuide');
  const sections = guide.match(/<details class="card student-guide-section(?: [^"]*)?"(?: open)?>/g) || [];

  assert.equal(sections.length, 8);
  assert.equal(sections.filter(section => section.includes(' open')).length, 1);
  assert.match(guide, /<details class="card student-guide-section" open><summary class="student-guide-head">/);
  assert.ok(guide.indexOf('✅ 매일 반드시 할 것') < guide.indexOf('🎁 기프트 카드 받는 방법'));
  assert.ok(guide.indexOf('🎁 기프트 카드 받는 방법') < guide.indexOf('🔗 처음 연결과 매일 접속'));
  assert.match(guide, /student-guide-reward[^]*🎁 기프트 카드 받는 방법[^]*5,000P가 모이면 신청부터 수령까지 확인해요[^]*5,000P 교환/);
  assert.match(guide, /교환 가능 확인[^]*5,000P 교환 신청[^]*교환 확인 중[^]*교환 처리 중[^]*기프트 카드 받기/);
  assert.match(guide, /실제 발송이 완료되면 5,000P가 차감되고 <code>기프트 카드 교환 완료<\/code>로 기록됩니다/);
  assert.match(guide, /‘교환 확인 중’에는 신청을 취소할 수 있지만 ‘교환 처리 중’에는 취소할 수 없습니다/);
  assert.match(guide, /기프트 카드 번호·링크는 플래너에 저장되지 않습니다/);
  assert.doesNotMatch(guide, /유효 학습일 스탬프|포인트와 기프트 카드|예정 학습일 3일 이상/);
  assert.doesNotMatch(html, /student-guide-tip-more/);
  assert.match(html, /\.student-guide-reward \{[^}]*border: 2px solid[^}]*linear-gradient[^}]*box-shadow:/);
  assert.match(html, /\.student-guide-section > summary \{[^}]*cursor: pointer;[^}]*list-style: none;/);
  assert.match(html, /\.student-guide-section\[open\] > summary::after \{ content: '⌃'; \}/);
});

test('a newly connected student opens Today after successful sync and the guide stays optional', () => {
  const connect = functionSource('connectStudentLink');
  const exchangeAt = connect.indexOf('await sync.exchangeBootstrap(staffId, code)');
  const storedAt = connect.indexOf('resetStudentLinkCache(d.token)');
  const syncAt = connect.lastIndexOf('await sync.run(true)');
  const todayAt = connect.lastIndexOf("route = 'today'");
  const hashAt = connect.indexOf("location.hash = '#/today'");
  const catchAt = connect.indexOf('} catch');

  assert.equal((connect.match(/go\('guide'\)/g) || []).length, 0);
  assert.ok(exchangeAt >= 0 && exchangeAt < storedAt);
  assert.ok(storedAt < syncAt && syncAt < todayAt);
  assert.ok(todayAt < hashAt && hashAt < catchAt, 'failed link exchanges must not enter Today');

  assert.doesNotMatch(functionSource('absorbLinkParams'), /pendingStudentWelcome/);
  assert.doesNotMatch(html, /pendingStudentWelcome/);
  assert.doesNotMatch(connect, /startStudentSetup/);
  assert.match(html, /\[\['today', '오늘'/);
  assert.match(html, /\['guide', '사용 안내'/);
});

test('student guide layout remains single-column on small screens', () => {
  assert.match(html, /\.student-guide-steps, \.student-guide-options, \.student-guide-closes, \.student-guide-tabs, \.student-setup-summary \{ grid-template-columns: 1fr; \}/);
});
