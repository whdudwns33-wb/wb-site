'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, 'parent.html'), 'utf8');
const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const parent = { name: '<샘플 학생>', today: { done: true, min: 12 }, week: { done: 3 }, lastMock: null, dist: null, milestones: [], notice: '자체 창작 샘플' };

// 부모 화면 전체를 실행해 샘플 주소에 운영 토큰이 있어도 네트워크로 넘기지 않는지 확인한다.
async function open(search, preview) {
  const nodes = { app: { innerHTML: '' }, preview: { hidden: true } }, calls = [];
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] }, location: { search }, URLSearchParams,
    fetch: async (...args) => { calls.push(args); return { ok: true, json: async () => ({ parent }) }; },
  });
  if (preview) context.WBHARU_PREVIEW = preview;
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  return { nodes, calls };
}

(async () => {
  const sample = { create: () => ({ parent: () => parent }) };
  let count = 0;
  for (const search of ['?preview=1', '?preview=1&t=운영+토큰']) {
    const { nodes, calls } = await open(search, sample);
    assert.equal(calls.length, 0);
    assert.equal(nodes.preview.hidden, false);
    assert.match(nodes.app.innerHTML, /&lt;샘플 학생&gt; 학생/);
    assert.match(nodes.app.innerHTML, /누적 3일/);
    count++;
  }
  for (const module of [undefined, { create() { throw new Error('샘플 오류'); } }]) {
    const { nodes, calls } = await open('?preview=1&t=운영+토큰', module);
    assert.equal(calls.length, 0);
    assert.equal(nodes.preview.hidden, false);
    assert.match(nodes.app.innerHTML, /샘플을 열지 못했어요/);
    count++;
  }
  const { nodes, calls } = await open('?preview=0&t=운영+토큰', sample);
  assert.equal(nodes.preview.hidden, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/haru/parent?t=' + encodeURIComponent('운영 토큰'));
  assert.equal(calls[0][1].cache, 'no-store');
  assert.match(nodes.app.innerHTML, /&lt;샘플 학생&gt; 학생/);
  count++;
  console.log('부모 샘플 네트워크 격리:', count, '개 통과');
})().catch(error => { console.error(error); process.exitCode = 1; });
