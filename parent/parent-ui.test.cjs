const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const taskHtml = fs.readFileSync(path.join(__dirname, '..', 'task', 'index.html'), 'utf8');
const headers = fs.readFileSync(path.join(__dirname, '_headers'), 'utf8');
const wrangler = fs.readFileSync(path.join(__dirname, '..', 'sync', 'wrangler.toml'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.webmanifest'), 'utf8'));

test('보호자 앱은 직원 앱과 분리된 모바일 웹앱이다', () => {
  assert.match(html, /WB 보호자/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /rel="manifest"/);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, './');
  assert.doesNotMatch(html, /serviceWorker|caches\.open|wb_taskboard/);
});

test('초대 코드는 fragment에서 즉시 지우고 HttpOnly 쿠키 세션만 쓴다', () => {
  assert.match(html, /new URLSearchParams\(location\.hash/);
  assert.match(html, /history\.replaceState\(null,'',location\.pathname\+location\.search\);try\{await post\(\{action:'exchange',code\}\)/);
  assert.match(html, /credentials:'include'/);
  assert.match(html, /const API='\/parent-portal'/);
  assert.doesNotMatch(html, /localStorage|sessionToken|searchParams\.get\('code'\)|studentId,code/);
});

test('보호자에게는 정형 보강 응답만 제공한다', () => {
  assert.match(html, /data-response="accept"/);
  assert.match(html, /data-response="decline"/);
  assert.match(html, /action:'respond'/);
  assert.doesNotMatch(html, /type="tel"|전화번호 입력|상담 메모|studentTraits|parentRequest/);
});

test('오늘 우리 아이는 v2 capability에서만 최소 수업·차량 상태를 읽기 전용 표시한다', () => {
  assert.match(html, /capabilities\.today===true/);
  assert.match(html, /오늘 수업/);
  assert.match(html, /오늘 차량/);
  assert.match(html, /출결 확인 전/);
  assert.match(html, /탑승 확인 전/);
  assert.match(html, /하차 확인/);
  assert.doesNotMatch(html, /하차·인계 완료|안전 귀가|실시간 위치/);
  assert.match(html, /timeZone:'Asia\/Seoul'/);
  assert.match(html, /내부 수업 메모, 정류장·주소, 연락처는 표시하지 않습니다/);
  assert.doesNotMatch(html, /row\.routeName|row\.stopName|row\.address|row\.guardianPhone/);
});

test('설치된 화면은 복귀·포커스·버튼에서 새로 읽고 마지막 확인 시각을 표시한다', () => {
  assert.match(html, /id="refreshButton"/);
  assert.match(html, /마지막 확인/);
  assert.match(html, /visibilitychange/);
  assert.match(html, /window\.addEventListener\('focus'/);
  assert.match(html, /refreshButton\.addEventListener\('click',\(\)=>refresh\(true\)\)/);
  assert.match(html, /if\(refreshing\|\|\(!force&&Date\.now\(\)-lastRefreshAt<1000\)\)return/);
});

test('출력은 escape하고 인증 오류 시 보호자 화면을 닫는다', () => {
  assert.match(html, /const esc=/);
  assert.match(html, /error\.status===401\|\|error\.status===410/);
  assert.match(html, /if\(clear\)\{logout\.hidden=true;refreshButton\.hidden=true\}/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /\.focus\(\)/);
});

test('직원 앱은 알림톡과 별도 웹앱 동의를 받고 1회 초대 링크만 복사한다', () => {
  assert.match(taskHtml, /action: 'access_set'/);
  assert.match(taskHtml, /웹앱 동의/);
  assert.match(taskHtml, /action: 'invite', studentId: student\.id/);
  assert.doesNotMatch(taskHtml, /state\.settings\.(?:parent|guardian).*code/i);
});

test('보호자 정적 자산은 Worker 별도 origin과 실제 응답 보안 헤더를 사용한다', () => {
  assert.match(wrangler, /\[assets\][\s\S]*directory\s*=\s*"\.\.\/parent"/);
  assert.match(wrangler, /binding\s*=\s*"ASSETS"/);
  assert.match(wrangler, /run_worker_first\s*=\s*true/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /X-Frame-Options:\s*DENY/);
  assert.match(headers, /Referrer-Policy:\s*no-referrer/);
  assert.match(headers, /X-Content-Type-Options:\s*nosniff/);
  assert.match(headers, /X-Robots-Tag:\s*noindex/);
  assert.match(headers, /Cache-Control:\s*no-store/);
});
