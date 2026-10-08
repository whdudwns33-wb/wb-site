'use strict';
/* 종이 시험지의 한 종류가 다른 종류의 정답을 드러내지 않는지 본다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync(__dirname + '/hanja-print.html', 'utf8');

assert.match(html, /<h2>강사 로그인<\/h2>/);
assert.doesNotMatch(html, /<h2>관리자 PIN<\/h2>/);
assert.match(html, /서로 정답이 보이는 시험은 한 종류씩 인쇄해 학생에게 따로 나눠 주세요/);

const start = html.indexOf('function make()');
const end = html.indexOf("$('#btnMake').addEventListener", start);
assert.ok(start >= 0 && end > start, '시험지 생성 함수를 찾지 못했다');

const elements = {
  '#unit': { value: 'u1', selectedOptions: [{ textContent: '첫 단원' }] },
  '#shuf': { checked: false }, '#tHun': { checked: false }, '#tWrite': { checked: false },
  '#tCharWord': { checked: false }, '#tMeaning': { checked: true }, '#tHanja': { checked: true },
  '#tKey': { checked: false }, '#preview': { innerHTML: '' }, '#stat': { textContent: '' },
};
const book = {
  title: '검사용 교재', chars: [],
  words: [{ unit: 'u1', word: '관측', meaning: '보고 재는 것', hanja: '觀測' }],
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
const page = (title, sub, body) => '<!--PAGE:' + title + '-->' + body + '<!--END-->';
const make = new Function('$', 'BOOK', 'shuffle', 'chunk', 'page', 'esc', html.slice(start, end) + '; return make;')(
  (id) => elements[id], book, (a) => a, chunk, page, esc,
);

make();
const output = elements['#preview'].innerHTML;
const meaning = output.slice(output.indexOf('<!--PAGE:낱말 뜻 쓰기'), output.indexOf('<!--END-->'));
assert.match(meaning, /관측/, '뜻 쓰기 면에 낱말이 없다');
assert.doesNotMatch(meaning, /觀測/, '뜻 쓰기 면이 한자어 표기 정답을 노출한다');
assert.match(output, /<!--PAGE:한자어 표기 쓰기/, '두 종류를 함께 골라도 한자어 표기 면이 빠졌다');

console.log('hanja print: answer isolation passed');
