'use strict';
/* 자체 창작 자료로 학생·강사 화면의 공용 렌더러를 검사한다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const R = require('./render.js');
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const poem = {
  workId: 'w-one', title: '테스트 시', author: '가상 작가',
  text: { stanzas: [{ no: 1, lines: ['바람 & 달', '창문 앞에 선다'] }, { no: 2, lines: ['달을 본다'] }] },
  marks: [{ symbol: '㉠', anchorText: '달' }],
  lineNotes: [{ anchor: '창문', note: '<마음>을 비추는 자리' }]
};
const prose = { workId: 'w-two', title: '테스트 산문', author: '가상 작가', text: { paragraphs: ['바람이 멈춘다.'] }, marks: [{ symbol: '㉣', anchorText: '바람' }] };
const pack = {
  works: [poem, prose], sets: [{
    setId: 's-one', works: [
      { workId: 'w-one', label: '(가)', kind: 'excerpt', text: { stanzas: [{ no: 1, lines: ['달을 본다'] }] } },
      { workId: 'w-two', label: '(나)', kind: 'excerpt', prefaceSummary: '앞 이야기 <요약>', text: { paragraphs: ['바람이 멈춘다.'] } }
    ],
    marks: [{ workId: 'w-one', symbol: '㉡', anchorText: '달' }, { workId: 'w-two', symbol: '㉢', anchorText: '바람' }]
  }]
};

t('브라우저 전역과 Node가 같은 네 함수를 내보낸다', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'render.js'), 'utf8'), context);
  assert.deepStrictEqual(Object.keys(context.WBKORENDER), Object.keys(R));
  assert.strictEqual(context.WBKORENDER.poemHtml(poem), R.poemHtml(poem));
});

t('본문·기호는 이스케이프하고 기호의 달러 문자열을 그대로 그린다', () => {
  assert.strictEqual(R.markUp('<script> & 달', [{ symbol: '<㉠> $&', anchorText: '달' }]),
    '&lt;script&gt; &amp; <span class="sym">&lt;㉠&gt; $&amp;</span><mark>달</mark>');
  assert.strictEqual(R.markUp('달', [{ symbol: '㉠', anchorText: '없는 구절' }]), '달');
});

t('연·행과 기호를 보존하고 날개풀이는 기본으로 감춘다', () => {
  const html = R.poemHtml(poem);
  assert.strictEqual((html.match(/class="st"/g) || []).length, 2);
  assert.strictEqual((html.match(/class="ln"/g) || []).length, 3);
  assert.ok(html.includes('바람 &amp; <span class="sym">㉠</span><mark>달</mark>'));
  assert.ok(!html.includes('class="note"'));
  assert.ok(!html.includes('마음'));
});

t('읽기에서만 날개풀이를 그리며 내용은 이스케이프한다', () => {
  const html = R.poemHtml(poem, true);
  assert.ok(html.includes('<span class="note">↳ &lt;마음&gt;을 비추는 자리</span>'));
  assert.strictEqual((html.match(/class="note"/g) || []).length, 1);
});

t('세트 기호가 정본 기호를 대체하고 빈 배열은 기호를 끈다', () => {
  const html = R.poemHtml(poem, false, [{ symbol: '㉡', anchorText: '창문' }]);
  assert.ok(html.includes('㉡</span><mark>창문</mark>'));
  assert.ok(!html.includes('㉠'));
  assert.ok(!R.poemHtml(poem, false, []).includes('<mark>'));
});

t('세트의 시·산문 발췌를 그리며 작품별 기호가 섞이지 않는다', () => {
  const html = R.passageHtml(pack, { setId: 's-one', workId: 'w-one' });
  assert.ok(html.includes('㉡</span><mark>달</mark>을 본다'));
  assert.ok(html.includes('<p><span class="sym">㉢</span><mark>바람</mark>이 멈춘다.</p>'));
  assert.ok(!html.includes('창문 앞에 선다'), '발췌 대신 전문을 그렸다');
  assert.ok(!html.includes('㉠') && !html.includes('㉣'));
  assert.ok(html.includes('앞 이야기 &lt;요약&gt;'));
  assert.ok(!html.includes('class="note"'));
});

t('세트에 기호가 없으면 정본 기호를 쓰고 텍스트가 없으면 정본으로 돌아간다', () => {
  const canonical = { works: pack.works, sets: [{ setId: 's-ref', works: [{ workId: 'w-one', kind: 'work' }, { workId: 'w-two', kind: 'work' }] }] };
  const html = R.passageHtml(canonical, { setId: 's-ref' });
  assert.ok(html.includes('㉠</span><mark>달</mark>'));
  assert.ok(html.includes('창문 앞에 선다'));
  assert.ok(html.includes('㉣</span><mark>바람</mark>'));
  const excerpt = { works: [poem], sets: [{ setId: 's-ref', works: [{ workId: 'w-one', text: { stanzas: [{ lines: ['달을 본다'] }] } }] }] };
  assert.ok(R.passageHtml(excerpt, { setId: 's-ref' }).includes('㉠</span><mark>달</mark>'));
});

t('세트 없는 문항은 정본 시·산문을 그린다', () => {
  assert.strictEqual(R.passageHtml(pack, { workId: 'w-one' }), '<div class="poem">' + R.poemHtml(poem) + '</div>');
  assert.strictEqual(R.passageHtml(pack, { workId: 'w-two' }), '<div class="poem"><p><span class="sym">㉣</span><mark>바람</mark>이 멈춘다.</p></div>');
});

t('메타데이터·구조도도 이스케이프하고 원본 객체는 바꾸지 않는다', () => {
  const hostile = { works: [{ workId: 'w', title: '<img>', author: '"작가"' }], sets: [{ setId: 's', works: [{ workId: 'w', label: '<가>', prefaceSummary: '<script>' }] }] };
  const before = JSON.stringify(pack);
  assert.ok(R.passageHtml(hostile, { setId: 's' }).includes('&lt;가&gt; &lt;img&gt; · &quot;작가&quot;'));
  assert.strictEqual(R.structureHtml({ branches: [{ category: '<주제>', children: ['바람 & 달', '창문'] }] }),
    '<div style="margin-bottom:6px"><b>&lt;주제&gt;</b> — 바람 &amp; 달, 창문</div>');
  R.passageHtml(pack, { setId: 's-one' });
  R.poemHtml(poem, true);
  assert.strictEqual(JSON.stringify(pack), before);
});

t('본문 미수록·없는 작품·빈 구조도는 빈 HTML이다', () => {
  assert.strictEqual(R.poemHtml({}), '');
  assert.strictEqual(R.passageHtml(pack, { workId: 'missing' }), '');
  assert.strictEqual(R.passageHtml(null, null), '');
  assert.strictEqual(R.structureHtml(null), '');
});

t('학생 앱은 공용 모듈을 먼저 불러오고 모든 기존 렌더링 경로에서 쓴다', () => {
  const app = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const renderAt = app.indexOf('<script src="./render.js"></script>');
  assert.ok(renderAt >= 0 && renderAt < app.indexOf('<script>'), '렌더러를 인라인 앱보다 먼저 불러오지 않는다');
  assert.ok(/R = window\.WBKORENDER/.test(app));
  assert.ok(!/function (markUp|poemHtml|passageHtml)\(/.test(app), '인라인 렌더러가 남았다');
  assert.strictEqual((app.match(/R\.poemHtml\(/g) || []).length, 3, '읽기·구절 적용·주석 복원 중 공용 호출이 빠졌다');
  assert.strictEqual((app.match(/R\.passageHtml\(S\.pack, it\)/g) || []).length, 2, '서술형·저장 문항 중 공용 호출이 빠졌다');
  assert.ok(/R\.structureHtml\(w\.structureMap\)/.test(app));
});

console.log('OK — ' + passed + '개 통과');
