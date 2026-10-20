'use strict';
const assert = require('node:assert/strict');
const { search } = require('./roster-search-core');
const students = [
  {id:'a',name:'테스트가',school:'가초'},
  {id:'b',name:'테스트가',school:'나초'},
  {id:'c',name:'테스트나',school:'다초'}
];
assert.equal(search(students, '').length, 0);
assert.equal(search(students, '테 스 트').length, 3);
assert.deepEqual(search(students, '트가').map(s=>s.id), ['a','b']);
assert.equal(search(students.slice(0,1), '테스트').length, 1);
assert.equal(students.length,3);
console.log('roster search passed');
