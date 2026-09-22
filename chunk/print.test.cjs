'use strict';
/* 실제 출력 화면을 실행해 촘촘한 판이 별도 선택한 한 줄 판을 삼키지 않는지 검사한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const R = require('./rules.js');
const LESSONS = require('./lessons.js');
const PASSAGES = require('./passages.js');
const html = fs.readFileSync(__dirname + '/print.html', 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

function open(band, passages = PASSAGES) {
  const elements = {};
  for (const [tag, id] of [...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map((m) => [m[0], m[1]])) {
    elements[id] = {
      value: (tag.match(/\bvalue="([^"]*)"/) || [])[1] || '',
      checked: /\bchecked\b/.test(tag), innerHTML: '', events: {},
      addEventListener(type, fn) { this.events[type] = fn; },
    };
  }
  vm.runInNewContext(script, {
    WBCHUNK: R, WBCHUNK_LESSONS: LESSONS, WBCHUNK_PASSAGES: passages,
    document: { getElementById: (id) => elements[id] },
    localStorage: { getItem: () => null }, location: { search: '?band=' + band }, URLSearchParams,
  }, { filename: 'print.html' });
  return elements;
}

const count = (text, fragment) => text.split(fragment).length - 1;
for (const band of ['G1', 'G2']) {
  const defaults = open(band), ps = PASSAGES.filter((p) => p.band === band);
  assert.equal(defaults['o-compact'].checked, true, band + ': 촘촘한 판 기본 선택');
  assert.equal(defaults['o-lines'].checked, true, band + ': 한 줄 판 기본 선택');
  assert.equal(count(defaults.book.innerHTML, ' compact">'), ps.length, band + ': 합본 출력');
  assert.equal(count(defaults.book.innerHTML, 'class="body lines"'), ps.length, band + ': 한 줄 판도 출력');

  for (const chars of [480, 481]) {
    const p = { id: 'test-print', band, title: '출력 검사', genre: '설명', paragraphs: [['가'.repeat(chars)]], q: null };
    const el = open(band, [p]);
    for (const id of ['o-cover', 'o-rules', 'o-key', 'o-record']) el[id].checked = false;
    for (const compact of [false, true]) for (const marked of [false, true])
      for (const plain of [false, true]) for (const lines of [false, true]) {
        for (const [id, value] of Object.entries({ compact, marked, plain, lines })) el['o-' + id].checked = value;
        el['o-compact'].events.change();
        const out = el.book.innerHTML, label = JSON.stringify({ band, chars, compact, marked, plain, lines });
        const combined = compact && marked && plain && chars <= 480;
        assert.equal(count(out, ' compact">'), +combined, label + ': 합본');
        assert.equal(count(out, 'class="body m-'), +marked, label + ': 표시본 중복 없음');
        assert.equal(count(out, 'class="body plain"'), +plain, label + ': 무표시본 중복 없음');
        assert.equal(count(out, 'class="body lines"'), +lines, label + ': 한 줄 판은 독립 선택');
        if (lines) assert.ok(out.includes('class="body lines"><p><span class="seg">' + '가'.repeat(chars)), label + ': 한 줄 판 본문');
      }
  }
}
console.log('chunk print: defaults and option matrix passed');
