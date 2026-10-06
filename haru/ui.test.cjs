'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('./plan.js');
const student = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const admin = fs.readFileSync(path.join(__dirname, '../reading-server/public/haru-admin.html'), 'utf8');
const plan = { examDate: '2026-10-25', numbersOpenDays: 7 };
const openedAt = P.numbersOpenAt(plan);
const settle = () => new Promise(setImmediate);
const element = () => ({ attrs: {}, firstElementChild: { style: {} }, setAttribute(k, v) { this.attrs[k] = String(v); } });
let count = 0;
async function t(name, fn) { await fn(); count++; console.log('통과:', name); }

// 실제 화면 코드를 실행하되 최초 로그인만 억제한다. 별도 테스트용 생산 코드가 필요 없다.
async function adminContext({ now = openedAt - 1, students = [{ code: 'demo-a', cohort: 'cohort-a' }], fetchPlan = async () => ({ plan }) } = {}) {
  const nodes = Object.fromEntries(['#main', '#btnLogout', '#x_code', '#x_go', '#x_when', '#d_go'].map(k => [k, element()]));
  nodes['#x_code'].value = students[0] ? students[0].code : '';
  const context = vm.createContext({
    document: { querySelector: s => nodes[s], querySelectorAll: () => [] },
    localStorage: { getItem: () => null }, WBHARU_P: P,
    Date: class extends Date { static now() { return now; } },
  });
  const source = admin.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  assert.ok(source.includes("if(TOKEN)show('board');else renderLogin();"));
  vm.runInContext(source.replace("if(TOKEN)show('board');else renderLogin();", ''), context);
  context.reply = async p => p === '/haru/admin/students' ? { students } : p === '/haru/admin/plans' ? { plans: [] } : fetchPlan(p);
  vm.runInContext('api=reply;', context);
  await vm.runInContext('tools()', context);
  await settle();
  return { context, nodes };
}

// 학생 앱은 IIFE 안의 필요한 함수만 이웃 함수 경계로 잘라 실행한다.
function studentContext(names, mocks = {}) {
  const nodes = Object.fromEntries(['savedot', 'savetxt', 'home', 'more', 'left', 'reprobeBar'].map(k => [k, element()]));
  const context = vm.createContext({ $: id => nodes[id], document: { querySelectorAll: () => [] } });
  const functions = names.map(name => {
    const start = student.indexOf('    function ' + name + '(');
    const end = student.indexOf('\n    function ', start + 1);
    assert.ok(start >= 0 && end > start, name);
    return student.slice(start, end);
  }).join('\n');
  vm.runInContext("'use strict';\n" + student.match(/    var esc =[^\n]+/)[0] + '\n' + functions, context);
  Object.assign(context, mocks);
  return { context, nodes };
}

(async () => {
  await t('관리 표시만 한국어로 바꾸고 미등록 원값은 유지', async () => {
    const { context } = await adminContext();
    for (const [raw, shown] of [['paper', '종이'], ['digital', '전자'], ['confirmed', '확정'], ['kor', '국어'], ['own', '자체 창작'], ['__proto__', '__proto__']]) {
      assert.equal(vm.runInContext('label(' + JSON.stringify(raw) + ')', context), shown);
    }
    assert.equal(vm.runInContext("esc(label('<원값>'))", context), '&lt;원값&gt;');
    assert.match(admin, /data-origin="'\+esc\(k\.origin\)/);
  });
  await t('내보내기 개방 직전 비활성화, 경계에서 활성화', async () => {
    let { nodes } = await adminContext();
    assert.equal(nodes['#x_go'].disabled, true);
    assert.match(nodes['#x_when'].textContent, /11\/1 16:00 이후/);
    ({ nodes } = await adminContext({ now: openedAt }));
    assert.equal(nodes['#x_go'].disabled, false);
    assert.equal(nodes['#x_when'].textContent, '내보낼 수 있습니다');
    assert.match(admin, /id="x_go" disabled aria-describedby="x_when"/);
  });
  await t('선택 플랜의 숫자 개방 일수 재사용', async () => {
    const { nodes } = await adminContext({ now: openedAt, fetchPlan: async () => ({ plan: { ...plan, numbersOpenDays: 10 } }) });
    assert.equal(nodes['#x_go'].disabled, true);
    assert.match(nodes['#x_when'].textContent, /11\/4 16:00 이후/);
  });
  await t('학생·코호트·플랜 없음 및 조회 실패는 비활성화 유지', async () => {
    for (const [options, message] of [
      [{ students: [] }, /등록된 학생이 없습니다/],
      [{ students: [{ code: 'demo-a' }] }, /코호트 플랜이 없습니다/],
      [{ fetchPlan: async () => { throw new Error('플랜 없음'); } }, /확인하지 못했습니다/],
      [{ fetchPlan: async () => { throw new Error('네트워크 오류'); } }, /이 탭을 다시 여세요/],
    ]) {
      const { nodes } = await adminContext(options);
      assert.equal(nodes['#x_go'].disabled, true);
      assert.match(nodes['#x_when'].textContent, message);
    }
  });
  await t('느린 이전 학생의 성공·실패가 현재 학생의 표시를 덮지 않음', async () => {
    for (const failed of [false, true]) {
      let resolve, reject;
      const late = new Promise((yes, no) => { resolve = yes; reject = no; });
      const { nodes } = await adminContext({
        students: [{ code: 'demo-a', cohort: 'cohort-a' }, { code: 'demo-b', cohort: 'cohort-b' }],
        fetchPlan: p => p.endsWith('cohort-a') ? late : Promise.resolve({ plan: { examDate: '2026-09-01' } }),
      });
      assert.equal(nodes['#x_go'].disabled, true);
      nodes['#x_code'].value = 'demo-b';
      await nodes['#x_code'].onchange();
      assert.equal(nodes['#x_go'].disabled, false);
      if (failed) reject(new Error('이전 요청 실패')); else resolve({ plan });
      await settle();
      assert.equal(nodes['#x_go'].disabled, false);
      assert.equal(nodes['#x_when'].textContent, '내보낼 수 있습니다');
    }
  });
  await t('러너 전체 위치와 준비 중 진행률은 유효한 숫자', () => {
    const { context } = studentContext(['runHead'], { RUN: { si: 0, qi: 1, slots: [1, 2, 3], items: [1, 2, 3] } });
    const html = vm.runInContext("runHead({label:'처음 보는 칸'})", context);
    assert.match(html, /카드 1\/3 · 문항 2\/3/);
    assert.match(html, /role="progressbar"[^>]*aria-valuenow="11"/);
    context.RUN.items = [];
    const preparing = vm.runInContext("runHead({label:'처음 보는 칸'},true)", context);
    assert.match(preparing, /문항 준비 중/);
    assert.match(preparing, /aria-valuenow="0"/);
    assert.doesNotMatch(preparing, /NaN|Infinity/);
  });
  await t('저장 성공·실패 두 표시, 저장 중 숨김과 429 접근성 안내', async () => {
    const { context, nodes } = studentContext(['setDot', 'push'], {
      DB: { days: {}, mocks: [], paper: [], weekly: [] }, summary: () => ({}), pendingPut: false,
      api: async () => { const error = new Error('상한'); error.status = 429; throw error; },
    });
    vm.runInContext("setDot('saved')", context);
    assert.equal(nodes.savetxt.textContent, '저장됨');
    assert.equal(nodes.savedot.hidden, false);
    vm.runInContext("setDot('failed')", context);
    assert.equal(nodes.savetxt.textContent, '저장 못 함');
    vm.runInContext("setDot('pending','저장 중')", context);
    assert.equal(nodes.savedot.hidden, true);
    await vm.runInContext('push()', context);
    assert.equal(nodes.savedot.hidden, false);
    assert.equal(nodes.savedot.attrs['aria-label'], '저장 못 함 · 오늘 저장 상한');
    assert.equal(context.pendingPut, true);
    assert.match(student, /id="savedot" role="status" hidden/);
  });
  await t('0.5초 뒤에만 로딩 뼈대 표시, 접근성에서는 제외', () => {
    const { context } = studentContext(['loading']);
    const html = vm.runInContext("loading('문항 준비')", context);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /role="status">문항 준비/);
    assert.match(html, /class="skeleton" aria-hidden="true"/);
    assert.match(student, /\.skeleton\s*\{[^}]*visibility:hidden;[^}]*animation:skeleton-show 0s \.5s forwards;/);
  });
  await t('완료 화면 앉은 날 단위와 홈 우선순위, 추가 학습 상한 유지', async () => {
    let html;
    const day = { sat: true, blocks: 1 };
    const { context } = studentContext(['finishRunner'], {
      DB: { days: { '2026-10-06': day, '2026-10-05': { sat: false } } },
      PLAN: { phase: { extendMax: 2, extendBlockMin: 15 } }, RUN: { startedAt: Date.now() },
      dayRec: () => day, cache() {}, push: async () => {}, footer: () => '', render: h => { html = h; },
    });
    vm.runInContext('finishRunner()', context); await settle();
    assert.match(html, /앉은 날<\/span><b>1일<\/b>/);
    assert.ok(html.indexOf('id="home"') < html.indexOf('id="more"'));
    assert.match(html, /id="home">홈으로/);
    day.blocks = 3;
    vm.runInContext('finishRunner()', context); await settle();
    assert.doesNotMatch(html, /id="more"/);
    assert.match(html, /오늘은 여기까지/);
  });
  await t('반증 30→29초 막대와 0초 모름 전송·기록 유지', async () => {
    let html, interval, now = 0, clears = 0, explained = false;
    const calls = [], wrong = [], choices = [element(), element()];
    const { context, nodes } = studentContext(['reprobe', 'runHead', 'loading', 'bodyOf'], {
      RUN: { si: 0, qi: 1, slots: [1, 2, 3], items: [1, 2, 3] }, DB: { atoms: {} }, PLAN: null,
      Date: class extends Date { static now() { return now; } },
      document: { querySelectorAll: () => choices }, render: h => { html = h; }, itemHtml: () => '',
      fetchItems: async () => [{ gid: 'g:demo:2' }],
      setInterval: (fn, ms) => { assert.equal(ms, 1000); interval = fn; return 1; }, clearInterval: () => { clears++; },
      api: async (p, options) => { calls.push([p, JSON.parse(options.body)]); return { result: { ok: false } }; },
      atomState: () => ({}), M: { observe() {} }, R: { recordOk() {} },
      recordWrong: (...args) => { wrong.push(args[3]); }, showExplain: () => { explained = true; },
    });
    vm.runInContext("reprobe({source:'gen',atomId:'demo',label:'처음 보는 칸'},{gid:'g:demo:1'},{cause:'gap'},'A',[])", context);
    await settle();
    assert.match(html, /id="left">30<\/span>초/);
    assert.match(html, /id="reprobeBar"[^>]*aria-valuenow="30"/);
    assert.match(html, /시간이 다 되면 ‘모름’으로 기록돼요/);
    now += 1000; interval();
    assert.equal(nodes.left.textContent, 29);
    assert.equal(nodes.reprobeBar.attrs['aria-valuenow'], '29');
    assert.equal(parseFloat(nodes.reprobeBar.firstElementChild.style.width), 29 / 30 * 100);
    for (let i = 1; i < 30; i++) { now += 1000; interval(); }
    await settle();
    assert.equal(nodes.left.textContent, 0);
    assert.equal(nodes.reprobeBar.firstElementChild.style.width, '0%');
    assert.deepEqual(calls.map(([p, body]) => [p, body.gid, body.picked]), [['/probe', 'g:demo:2', 'skip'], ['/answer', 'g:demo:2', 'skip']]);
    assert.equal(calls[0][1].said, 'canDo');
    assert.ok(calls.every(([, body]) => body.ms === 30000));
    assert.equal(calls[1][1].cue, 0);
    assert.equal(calls[1][1].mixed, false);
    assert.ok(choices.every(b => b.disabled));
    assert.deepEqual(wrong, ['gap']);
    assert.equal(explained, true);
    assert.ok(clears > 0);
  });
  console.log('하루브레인 화면 회귀:', count, '개 통과');
})().catch(error => { console.error(error); process.exitCode = 1; });
