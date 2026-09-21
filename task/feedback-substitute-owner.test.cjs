'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8');
const fn = source.slice(source.indexOf('function feedbackCanonicalTask(task)'), source.indexOf('function feedbackOccurrenceIsMakeup'));
test('feedback display merges only the same student and teacher makeup', () => {
  const regular = { id: 'regular', staffId: 'a', studentId: 'student' };
  const canonical = new Function('state', fn + '; return feedbackCanonicalTask;')({ tasks: [regular] });
  const makeup = { id: 'makeup', lessonInstanceType: 'makeup', makeupSourceTaskId: 'regular', staffId: 'b', studentId: 'student' };
  assert.equal(canonical(makeup), makeup);
  assert.equal(canonical({ ...makeup, staffId: 'a' }), regular);
  const other = { ...makeup, staffId: 'a', studentId: 'other' };
  assert.equal(canonical(other), other);
});
