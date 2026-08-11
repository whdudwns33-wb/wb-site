const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('personal links use the validated staff query as a tablet mobile-layout switch', () => {
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0, viewport-fit=cover">/);
  assert.match(html, /const HAS_PERSON_SCOPE = !!SAFE_SCOPE_ID;/);
  assert.match(html, /classList\.toggle\('person-mobile', HAS_PERSON_SCOPE\)/);
  assert.match(html, /html\.person-mobile body \{ width: min\(100%, 480px\);[^}]*overflow-x: hidden;/);
  assert.match(html, /html\.person-mobile \.book-issue-grid,[\s\S]{0,140}html\.person-mobile \.transport-config-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(html, /html\.person-mobile \.schedule-kpis,[\s\S]{0,80}html\.person-mobile \.ops-kpis \{ grid-template-columns: repeat\(2,/);
  assert.match(html, /html\.person-mobile \.btn,[\s\S]{0,120}min-height: 44px;/);
});

test('personal home shortcut keeps its staff scope and is intentionally not a PWA', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  const scrub = html.slice(html.indexOf('function scrubBootstrapCodeFromAddress'), html.indexOf('function classifyPersonLinkError'));
  assert.doesNotMatch(head, /rel=["']manifest["']/i);
  assert.doesNotMatch(html, /serviceWorker\.register/);
  assert.match(html, /return location\.origin \+ location\.pathname \+ '\?u=' \+ encodeURIComponent\(id\) \+ '#c='/);
  assert.match(scrub, /new URLSearchParams\(location\.search\)/);
  assert.doesNotMatch(scrub, /\.delete\(["']u["']\)/);
  assert.match(scrub, /location\.pathname \+ \(q\.toString\(\) \? '\?' \+ q : ''\)/);
});

test('tablet QR instructions prevent Chrome desktop-mode setup mistakes', () => {
  const guide = html.match(/function showLinkQr\(s\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(guide, /데스크톱 사이트를 끄고 페이지 확대를 100%/);
  assert.match(guide, /연결이 끝난 주소에서 <b>홈 화면에 추가<\/b>/);
});

test('personal daily and weekly check controls keep 44px touch targets', () => {
  assert.match(html, /html\.person-mobile button\.box,[\s\S]{0,80}html\.person-mobile button\.dot \{[^}]*width: 44px;[^}]*height: 44px;/);
});

test('version reload preserves the personal query and replaces an existing cache key', () => {
  assert.match(html, /const next = new URL\(location\.href\);[\s\S]{0,160}next\.searchParams\.set\('v', String\(Date\.now\(\)\)\);[\s\S]{0,120}location\.replace\(next\.pathname \+ next\.search \+ next\.hash\)/);
  assert.doesNotMatch(html, /location\.search\.replace\(\/\[\?&\]v=/);
});
