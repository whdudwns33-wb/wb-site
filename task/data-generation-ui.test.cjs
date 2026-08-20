const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const relative of ['index.html', '../consult/index.html']) {
  test(relative + ' clears operational cache on generation mismatch while retaining settings', () => {
    const html = fs.readFileSync(path.join(__dirname, relative), 'utf8');
    assert.match(html, /dataGeneration: 0/);
    assert.match(html, /dataGeneration: Number\(state\.settings\.dataGeneration\) \|\| 0/);
    const start = html.indexOf("e.code === 'DATA_GENERATION_MISMATCH'");
    const mismatch = html.slice(start, start + 900);
    assert.ok(start > 0);
    assert.match(mismatch, /state\.staff = \[\]/);
    assert.match(mismatch, /state\.tasks = \[\]/);
    assert.match(mismatch, /state\.checks = \{\}/);
    assert.match(mismatch, /state\.settings\.dataGeneration = Number\(e\.dataGeneration\)/);
    assert.doesNotMatch(mismatch, /state\.settings = \{\}/);
  });
}
