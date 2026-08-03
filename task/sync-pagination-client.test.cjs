const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' must exist');
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < html.length; index++) {
    if (html[index] === '{') depth++;
    if (html[index] === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(name + ' closing brace not found');
}

test('client normalizes and compares composite pull cursors', () => {
  const context = {};
  vm.runInNewContext(
    functionSource('normalizePullCursor') + '\n' +
    functionSource('samePullCursor') + '\n' +
    'result = {' +
      'modern: normalizePullCursor({srv_at:7,table_rank:2,key:"k"}, 0),' +
      'legacy: normalizePullCursor(null, 9),' +
      'same: samePullCursor({srv_at:7,table_rank:2,key:"k"},{srv_at:7,table_rank:2,key:"k"})' +
    '};',
    context
  );
  assert.equal(JSON.stringify(context.result.modern), JSON.stringify({ srv_at: 7, table_rank: 2, key: 'k' }));
  assert.equal(JSON.stringify(context.result.legacy), JSON.stringify({ srv_at: 9, table_rank: -1, key: '' }));
  assert.equal(context.result.same, true);
});

test('pullOnly and run send, persist, and guard the composite cursor', () => {
  assert.ok((html.match(/cursor: pullCursor/g) || []).length >= 2);
  assert.match(html, /state\.settings\.pullCursor = cursor/);
  assert.match(html, /response\.more && samePullCursor\(current, next\)/);
  assert.match(html, /state\.settings\.pullCursor = null/);
  assert.doesNotMatch(html, /state\.settings\.pullAt = d\.now/);
});
