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

test('출력은 escape하고 인증 오류 시 보호자 화면을 닫는다', () => {
  assert.match(html, /const esc=/);
  assert.match(html, /error\.status===401\|\|error\.status===410/);
  assert.match(html, /if\(clear\)logout\.hidden=true/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
  assert.match(html, /aria-live="polite"/);
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
