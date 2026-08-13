const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const qr = require('./qr-core.js');

test('qr module is loaded by the app', () => {
  assert.ok(/<script src="\.\/qr-core\.js\?v=/.test(html), 'script tag with cache-busting version');
});

test('the QR button sits in staff admin next to the link actions', () => {
  assert.ok(html.includes('data-act="qrlink"'), 'button exists');
  const row = html.split('\n').filter(l => l.includes('data-act="qrlink"'))[0];
  assert.ok(row.includes('data-id="\' + s.id + \'"'), 'carries the staff id');
});

test('every QR action in the markup has a handler', () => {
  ['qrlink', 'copylinktext', 'handoffqr'].forEach(a => {
    assert.ok(html.includes('data-act="' + a + '"'), a + ' is rendered');
    assert.ok(html.includes("case '" + a + "':"), a + ' has a handler');
  });
});

test('staff popups use the browser top layer and stay on the current tab', () => {
  assert.match(html, /<dialog id="modalHost" class="modal"/);
  assert.match(html, /typeof host\.showModal === 'function'/);
  assert.match(html, /host\.showModal\(\)/);
  assert.match(html, /\.modal\[open\] \{ display: grid; \}/);
  const modalFn = html.match(/function modal\(title, bodyHtml, footHtml\) \{[\s\S]*?\n\}/);
  assert.ok(modalFn, 'shared modal function found');
  assert.doesNotMatch(modalFn[0], /\bgo\(|location\.hash|route\s*=/, 'opening a popup must not navigate away');
  const manageFn = html.match(/function manageTasks\(staffId\) \{[\s\S]*?\n\}/);
  assert.ok(manageFn, 'instruction-list popup found');
  assert.match(manageFn[0], /modal\(/, 'instruction list uses the same top-layer popup');
});

/* 링크는 1회용 코드를 담는다. 코드를 먼저 발급하지 않으면 이미 소모된
   링크가 QR에 박혀 태블릿에서 연결이 안 된다. */
test('the QR is drawn only after a fresh code is issued', () => {
  const handler = html.match(/case 'qrlink': \{[\s\S]*?\n    \}/);
  assert.ok(handler, 'qrlink handler found');
  const body = handler[0];
  assert.ok(body.includes('issueLinkCode(id)'), 'issues a code first');
  assert.ok(body.indexOf('issueLinkCode(id)') < body.indexOf('showLinkQr'), 'issue before draw');
  assert.ok(body.includes('.catch('), 'a failed issue must not leave a stale modal');
  assert.ok(/\.catch\([\s\S]*?closeModal\(\)/.test(body), 'closes the waiting modal on failure');
});

test('the QR view falls back to copying when the code cannot be scanned', () => {
  const fn = html.match(/function showLinkQr\(s\) \{[\s\S]*?\n\}\n/);
  assert.ok(fn, 'showLinkQr found');
  assert.ok(fn[0].includes('copylinktext'), 'offers a copy fallback');
  assert.ok(fn[0].includes('window.WBQRCore'), 'reads the shared encoder');
  assert.ok(/if \(!core\)/.test(fn[0]), 'survives the module failing to load');
  assert.ok(fn[0].includes('try {'), 'an encode failure must not blank the screen');
});

test('the QR view warns about one-time use and shows the granted role', () => {
  const fn = html.match(/function showLinkQr\(s\) \{[\s\S]*?\n\}\n/)[0];
  assert.ok(fn.includes('한 번만'), '1회용이라는 점을 알려야 재사용 시도를 막는다');
  assert.ok(fn.includes('원장 화면은 열지 마세요'), '태블릿에 관리 비밀번호가 남는 문제');
  assert.ok(fn.includes('관리 담당 권한 포함'));
  assert.ok(fn.includes('일반 직원 권한'));
});

test('a verified manager can hand the same manager identity to a tablet QR', () => {
  assert.match(html, /내 관리 담당 태블릿 QR/);
  assert.match(html, /case 'handoffqr':[\s\S]{0,120}createVerifiedHandoffLink\(true\)/);
  const fn = html.match(/async function createVerifiedHandoffLink\(asQr\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(fn, /storeLinkCode\(session\.staffId, issued\.code, issued\.expiresAt, issued\.authRole\)/);
  assert.match(fn, /showLinkQr\(staff\)/);
});

/* 실제 개인 링크 길이가 지원 범위에 드는지 — 못 들면 버튼이 늘 실패한다. */
test('a real personal link encodes within the supported versions', () => {
  const link = 'https://wb-academy.pages.dev/task/?u=' + '0123456789abcdef'.repeat(2) + '-abcd' +
    '#c=' + 'A'.repeat(48);
  const out = qr.encode(link);
  assert.ok(out.version <= 10, '버전 ' + out.version + ' — 표 범위 안');
  assert.ok(out.size <= 57, '한 화면에 들어가는 크기');
  const svg = qr.toSvg(out, { size: 268 });
  assert.ok(svg.length < 60000, 'SVG가 모달에 넣기에 과하지 않다');
});
