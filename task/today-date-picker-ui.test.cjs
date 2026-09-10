const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('teacher today view keeps arrow navigation and adds a collapsed date picker', () => {
  const start = html.indexOf('function viewToday()');
  const end = html.indexOf('function taskRow(', start);
  assert.ok(start >= 0 && end > start);
  const view = html.slice(start, end);
  assert.match(view, /data-act="day" data-n="-1"/);
  assert.match(view, /data-act="day" data-n="1"/);
  assert.match(view, /<details class="today-date-picker" data-persist-key="today-date-picker">/);
  assert.match(view, /type="date" data-today-date/);
  assert.match(view, /data-act="todaydate">오늘로/);
});

test('selected today-view date updates cursor while invalid values are rejected', () => {
  assert.match(html, /const todayDateInput = ev\.target\.closest\('\[data-today-date\]'\)/);
  assert.match(html, /cursor = value;\s*cursorPinned = cursor !== today\(\);\s*render\(\);/);
  assert.match(html, /case 'todaydate': cursor = today\(\); cursorPinned = false; render\(\); break;/);
});
