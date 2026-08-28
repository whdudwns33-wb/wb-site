const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('full view rerenders preserve every user-selected open or closed details state', () => {
  assert.match(html, /const persistentDetailsState = new Map\(\)/);
  assert.match(html, /function capturePersistentDetails\(root\)/);
  assert.match(html, /function restorePersistentDetails\(root\)/);
  assert.match(html, /persistentDetailsState\.set\(key, details\.open\)/);
  assert.match(html, /details\.open = persistentDetailsState\.get\(key\)/);
  assert.match(html, /function replaceView\(root, html\)[\s\S]*capturePersistentDetails\(root\)[\s\S]*restorePersistentDetails\(root\)/);
  assert.match(html, /replaceView\(v, \(map\[route\] \|\| viewToday\)\(\)\)/);
});

test('clearing schedule search no longer auto-closes panels it opened', () => {
  const start = html.indexOf('function applyScheduleSearch(');
  const end = html.indexOf('function scheduleKpisHtml(', start);
  const source = html.slice(start, end);
  assert.match(source, /delete details\.dataset\.searchOpened/);
  assert.doesNotMatch(source, /details\.open = false/);
});

test('teacher today live request panels retain independent user-controlled open states', () => {
  assert.match(html, /data-persist-key="today-admin-directive-received\|/);
  assert.match(html, /data-persist-key="today-teacher-live-request\|/);
  const receivedAt = html.indexOf('data-persist-key="today-admin-directive-received|');
  const composerAt = html.indexOf('data-persist-key="today-teacher-live-request|');
  assert.notEqual(receivedAt, composerAt);
});
