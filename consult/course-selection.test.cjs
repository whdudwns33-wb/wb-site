const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);

test('consult inline javascript parses', () => {
  assert.ok(scripts.length > 0);
  scripts.forEach((source, index) => new vm.Script(source, { filename: 'consult-inline-' + index + '.js' }));
});

test('selecting a course does not immediately fetch a blocked curriculum page', () => {
  const block = html.match(/case 'inguse': \{[\s\S]*?\n\s*\}/)?.[0] || '';
  assert.ok(block);
  assert.match(block, /ingUrl/);
  assert.match(block, /ingName/);
  assert.match(block, /강좌를 선택했습니다/);
  assert.doesNotMatch(block, /ingFetch\(/);
});

test('curriculum fetch remains an explicit action with a paste fallback', () => {
  assert.match(html, /case 'ingfetch': ingFetch\(\)/);
  assert.match(html, /사이트가 막으면 ③에 목차를 붙여넣으면 됩니다/);
  assert.match(html, /목차를 복사해 위 칸에 그대로 붙여넣으면 됩니다/);
  assert.match(html, /data-title=/);
});
