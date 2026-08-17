const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pagePath = path.join(__dirname, 'consult-guardian', 'index.html');
const html = fs.readFileSync(pagePath, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'consult-guardian', 'manifest.webmanifest'), 'utf8'));
const assetsIgnore = fs.readFileSync(path.join(__dirname, '.assetsignore'), 'utf8');

test('보호자 학습 리포트는 독립된 모바일 웹앱이며 새 의존성이 없다', () => {
  assert.match(html, /WB 보호자 학습 리포트/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /font-family:system-ui/);
  assert.doesNotMatch(html, /https?:\/\/|@import|serviceWorker|caches\.open|<iframe|<script\s+src/);
  assert.doesNotThrow(() => new Function(script));
  assert.equal(manifest.scope, './');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.display, 'standalone');
  assert.match(assetsIgnore, /^\/consult-guardian-ui\.test\.cjs$/m,
    '테스트 소스는 Worker 정적 자산으로 배포하지 않는다');
});

test('fragment 초대 코드를 화면 시작 즉시 지운 뒤 same-origin exchange에만 전달한다', () => {
  const bootStart = script.indexOf('async function boot()');
  const bootEnd = script.indexOf("app.addEventListener('click'", bootStart);
  const boot = script.slice(bootStart, bootEnd);
  assert.match(script, /const API='\/consult-guardian'/);
  assert.match(boot, /const fragment=location\.hash,code=new URLSearchParams\(fragment\.replace\(\/\^#\/,''\)\)\.get\('code'\)\|\|'';/);
  assert.ok(boot.indexOf("history.replaceState(null,'',location.pathname+location.search)") < boot.indexOf("await post({action:'exchange',code})"));
  assert.match(script, /credentials:'include',cache:'no-store'/);
  assert.match(script, /Object\.assign\(\{app:'consult'\},body\)/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|document\.cookie|Authorization|Bearer|location\.search.*code/);
});

test('exchange는 view 포함 응답과 ok 전용 응답을 모두 처리한다', () => {
  assert.match(script, /let data=code\?await post\(\{action:'exchange',code\}\):await post\(\{action:'view'\}\)/);
  assert.match(script, /if\(!Array\.isArray\(data\.reports\)\)data=await post\(\{action:'view'\}\)/);
  assert.match(script, /data\.ok!==true/);
});

test('서버 목록에서도 최신 주간 한 건과 월간 한 건만 선택한다', () => {
  const start = script.indexOf('function latestReports(rows)');
  const end = script.indexOf('function summaryOf(report)', start);
  const latestReports = new Function('typeLabel', 'integer', script.slice(start, end) + ';return latestReports;')(
    type => type === 'week' ? '주간' : type === 'month' ? '월간' : '',
    value => Math.round(Number(value) || 0)
  );
  const rows = [
    { id: 'w1', reportType: 'week', periodEnd: '2026-08-09', reportRevision: 1, publishedAt: 10 },
    { id: 'w2', reportType: 'week', periodEnd: '2026-08-16', reportRevision: 1, publishedAt: 20 },
    { id: 'm1', reportType: 'month', periodEnd: '2026-07-31', reportRevision: 1, publishedAt: 15 },
    { id: 'x1', reportType: 'private', periodEnd: '2026-08-31', reportRevision: 99, publishedAt: 99 }
  ];
  assert.deepEqual(latestReports(rows).map(row => row.id), ['w2', 'm1']);
});

test('상세 화면은 허용된 리포트 DTO 값만 escape해 표시한다', () => {
  const start = script.indexOf('function summaryOf(report)');
  const end = script.indexOf('function render(data)', start);
  const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const safeDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '';
  const number = (value, max = 999999) => Math.min(max, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));
  const integer = (value, max) => Math.round(number(value, max));
  const statusLabel = status => ({ done: ['완료', 'ok'], blocked: ['보류', 'warn'], todo: ['예정', ''] }[status] || ['확인', '']);
  const [reportCard, reportDetail] = new Function('esc', 'num', 'integer', 'safeDate', 'typeLabel', 'statusLabel', 'minutes', 'stamp', 'period',
    script.slice(start, end) + ';return [reportCard,reportDetail];')(
      escapeHtml, number, integer, safeDate,
      type => type === 'week' ? '주간 리포트' : type === 'month' ? '월간 리포트' : '',
      statusLabel, value => Math.round(number(value) / 60) + '분', value => value ? '발행 시각' : '',
      report => report.periodStart + ' ~ ' + report.periodEnd
    );
  const attack = '<img src=x onerror=alert(1)>';
  const report = {
    id: 'public-ref', reportType: 'week', periodStart: '2026-08-10', periodEnd: '2026-08-16',
    reportRevision: 2, publishedAt: 1, acknowledgedAt: 0,
    snapshot: {
      summary: { done: 4, total: 5, pct: 80, blocked: 1, studySecs: 3600 },
      subjects: [{ label: attack, done: 2, total: 3, studySecs: 1200 }],
      days: [{ date: '2026-08-10', done: 2, total: 3, studySecs: 1200 }],
      rows: [{ date: '2026-08-10', title: attack, subject: 'math', status: 'done', hiddenSecret: attack }],
      reflection: attack, directorNote: attack, nextFocus: attack, hiddenSecret: attack
    }
  };
  const output = reportCard(report) + reportDetail(report, attack);
  assert.match(output, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(output, /수학/);
  assert.doesNotMatch(output, /<img\b|hiddenSecret|public-ref/);
  assert.match(output, /발행 시점 학생 기록 기준/);
  assert.match(output, /원장 피드백/);
  assert.match(script, /snapshot\.directorNote/);
  assert.doesNotMatch(script, /snapshot\.(?:note|guide)|taskId|student\.id|\.origin|\.url|\.photo|\.question/);
});

test('확인 응답은 현재 공개 참조와 판 번호만 보내고 갱신한다', () => {
  const start = script.indexOf('async function acknowledge');
  const end = script.indexOf('async function boot()', start);
  const source = script.slice(start, end);
  assert.match(source, /post\(\{action:'ack',reportId:report\.id,reportRevision:integer\(report\.reportRevision,999999\)\}\)/);
  assert.match(source, /if\(!Array\.isArray\(data\.reports\)\)data=await post\(\{action:'view'\}\)/);
  assert.doesNotMatch(source, /studentId|staffId|freeText|FormData/);
  assert.match(html, /확인했어요/);
});

test('상세 화면은 브라우저 인쇄와 PDF 저장을 지원한다', () => {
  assert.match(html, /인쇄 · PDF 저장/);
  assert.match(script, /data-print/);
  assert.match(script, /window\.print\(\)/);
  assert.match(html, /@media print/);
  assert.match(html, /@page\{size:A4/);
  assert.match(html, /\.screen-only\{display:none!important\}/);
});

test('로딩·빈 결과·오류·로그아웃과 모바일 접근성 상태를 갖춘다', () => {
  assert.match(html, /class="loading" role="status"/);
  assert.match(html, /아직 발행된 리포트가 없습니다/);
  assert.match(html, /role="alert" tabindex="-1"/);
  assert.match(html, /aria-live="polite" aria-atomic="true"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /@media\(max-width:580px\)/);
  assert.match(html, /min-height:44px/);
  assert.match(script, /post\(\{action:'logout'\}\)/);
  assert.match(script, /error\.status===401\|\|error\.status===410/);
  const start = script.indexOf('async function logout()');
  const end = script.indexOf("logoutButton.addEventListener('click',logout)", start);
  const logout = script.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(logout, /await post\(\{action:'logout'\}\)/);
  assert.match(logout, /로그아웃하지 못했습니다/);
  assert.match(logout, /data-logout-retry/);
  assert.doesNotMatch(logout, /catch\(error\)\{\}/);
  assert.ok(logout.indexOf('await post') < logout.indexOf('로그아웃했습니다'),
    '서버가 쿠키를 지운 뒤에만 로그아웃 성공을 표시한다');
});
