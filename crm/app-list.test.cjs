'use strict';
/* node crm/app-list.test.cjs — 합성 고객으로 실제 목록 렌더와 이벤트를 실행한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const C = require('./crm-core.js');
const source = fs.readFileSync(path.join(__dirname, 'app/app.js'), 'utf8').replace(/\nstartApp\(\);\s*$/, '\n');

function decode(value) {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, x => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[x]));
}
function attributes(tag) {
  const attrs = {};
  for (const [, key, value] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[key] = decode(value);
  return attrs;
}

function harness(leads = [], canApprove = true) {
  const handlers = {}, fields = new Map(), timers = new Map(), storageWrites = [], errors = [];
  let timerId = 0;
  const view = { innerHTML: '', focus() {} }, host = { hidden: true };
  const document = {
    body: { classList: { toggle() {} } },
    addEventListener(name, fn) { handlers[name] = fn; },
    querySelector(selector) {
      if (selector === '#view') return view;
      if (selector === '#modalHost') return host;
      if (selector === '#lead-list-count') return view.innerHTML.includes('id="lead-list-count"') ? { focus() {} } : null;
      if (!selector.startsWith('#')) return null;
      const id = selector.slice(1);
      if (fields.has(id)) return fields.get(id);
      const matches = [...view.innerHTML.matchAll(/<(input|select)\b[^>]*>/g)];
      const match = matches.find(m => attributes(m[0]).id === id);
      if (!match) return null;
      const attrs = attributes(match[0]);
      const field = { id, value: attrs.value || '', dataset: {}, focus() { document.activeElement = this; },
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }, closest() { return null; } };
      if (match[1] === 'select') {
        const end = view.innerHTML.indexOf('</select>', match.index);
        field.options = [...view.innerHTML.slice(match.index, end).matchAll(/<option\b[^>]*>/g)].map(o => ({ value: attributes(o[0]).value || '', selected: /\sselected(?:\s|>)/.test(o[0]) }));
        field.value = (field.options.find(o => o.selected) || field.options[0] || {}).value || '';
      }
      fields.set(id, field);
      return field;
    }
  };
  let html = '';
  Object.defineProperty(view, 'innerHTML', { get() { return html; }, set(value) { html = value; fields.clear(); } });
  const location = { hash: '#/leads' };
  const history = { length: 1, replaceState(_state, _title, hash) { location.hash = hash; } };
  const context = vm.createContext({
    WBCrmCore: C, document, location, history,
    window: { addEventListener(name, fn) { handlers[name] = fn; } },
    localStorage: { getItem() { return ''; }, setItem(key, value) { storageWrites.push([key, value]); }, removeItem(key) { storageWrites.push([key]); } },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    clearInterval() {},
    requestAnimationFrame(fn) { fn(); }, console: { error(...args) { errors.push(args); } },
    fixture: JSON.parse(JSON.stringify(leads)), canApprove
  });
  const run = code => vm.runInContext(code, context);
  vm.runInContext(source, context, { filename: 'crm/app/app.js' });
  run("session = makeSession({role: canApprove ? 'admin' : 'staff', staffId: 'staff_a', name: '가상 직원'}); state.leads = fixture; state.staff = [{id:'staff_a',name:'가상 직원',active:true}]; today = () => '2026-10-16'; route = 'leads'; render();");
  const checkRender = () => { assert.deepEqual(errors, []); assert.ok(!html.includes('화면을 그리지 못했습니다')); };
  const buttons = () => [...html.matchAll(/<button\b[^>]*>/g)].map(m => ({ attrs: attributes(m[0]), disabled: /\sdisabled(?:\s|>)/.test(m[0]) }));
  return {
    context, run, storageWrites, document,
    get html() { checkRender(); return html; },
    read(code) { return JSON.parse(run('JSON.stringify(' + code + ')')); },
    render() { run('render()'); checkRender(); },
    rows() { return [...(this.html.match(/<tbody>([\s\S]*?)<\/tbody>/) || ['', ''])[1].matchAll(/href="#\/lead\/([^"]+)"/g)].map(m => decode(m[1])); },
    button(act, values = {}) { return buttons().find(b => b.attrs['data-act'] === act && Object.entries(values).every(([k, v]) => b.attrs['data-' + k] === String(v))); },
    async click(act, values = {}) {
      const button = this.button(act, values);
      assert.ok(button, '렌더된 버튼: ' + act + ' ' + JSON.stringify(values));
      assert.equal(button.disabled, false, '활성 버튼');
      const dataset = Object.fromEntries(Object.entries(button.attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5), v]));
      const el = { dataset, closest() { return this; } };
      await handlers.click({ target: el, preventDefault() {}, stopPropagation() {} });
      checkRender();
    },
    change(id, value) {
      const field = document.querySelector('#' + id);
      assert.ok(field, '렌더된 입력: ' + id);
      if (field.options) assert.ok(field.options.some(o => o.value === value), id + '의 선택지: ' + value);
      field.value = value;
      handlers.change({ target: field });
      checkRender();
    },
    input(value, isComposing = false) {
      const field = document.querySelector('#f-q');
      assert.ok(field);
      field.value = value; field.selectionStart = value.length; field.selectionEnd = value.length;
      handlers.input({ target: field, isComposing });
    },
    flushTimers() {
      for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
      checkRender();
    },
    search(value) { this.input(value); this.flushTimers(); },
    navigate(hash) { location.hash = hash; handlers.hashchange(); checkRender(); }
  };
}

function lead(id, patch = {}) {
  return Object.assign({ id, name: '가상 ' + id, child: { name: '가상 학생', school: '가상 학교' }, pipeline: 'inspection', stage: 'interpreted', status: 'open', owner: 'admin', channel: '맘카페', createdAt: '2026-10-01', followups: [] }, patch);
}
const due = date => [{ day: 3, due: date, status: 'pending' }];
const fixture = () => [
  lead('a', { followups: due('2026-10-16') }),
  lead('b', { stage: 'booked', followups: due('2026-10-15') }),
  lead('c', { status: 'hold', followups: due('2026-10-16') }),
  lead('d', { status: 'won', stage: 'won', channel: '블로그', owner: 'staff_a', followups: due('2026-10-16') }),
  lead('e', { pipeline: 'academy', stage: 'trial', owner: 'staff_a', followups: due('2026-10-17') }),
  lead('f', { channel: '블로그', owner: 'staff_a' }),
  lead('g', { status: 'lost', stage: 'lost', channel: '인스타', followups: due('2026-10-16') }),
  lead('h', { owner: 'staff_a', followups: due('2026-10-16') }),
  lead('i', { followups: due('invalid-date') })
];
const many = count => Array.from({ length: count }, (_, i) => lead('qa_' + String(i + 1).padStart(3, '0')));

test('학원 칸반은 HubSpot 다섯 영업 단계와 이전 학원 상태를 구분하고 원본을 바꾸지 않는다', () => {
  const stages = ['inquiry', 'trial', 'trial_review', 'won', 'lost', 'active', 'at_risk', 'churned'];
  const h = harness(stages.map(stage => lead('qa_' + stage, { pipeline: 'academy', stage, status: stage === 'won' ? 'won' : ['lost', 'churned'].includes(stage) ? 'lost' : 'open' })));
  const before = h.read('state.leads');
  h.run("ui.pipe='academy'; route='pipeline'; render();");
  const labels = [...h.html.matchAll(/class="col-head"><span>(.*?)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(labels, ['문의', '레벨테스트·체험', '등록 결정 대기', '등록(성사)', '미등록']);
  assert.ok(h.html.includes('이전 학원 상태 — 영업 단계 확인 필요'));
  for (const stage of stages) assert.equal((h.html.match(new RegExp('data-id="qa_' + stage + '"', 'g')) || []).length, 1, stage);
  assert.ok(h.html.includes('등록 후 관리 · 재원') && h.html.includes('등록 후 관리 · 이탈위험') && h.html.includes('등록 후 관리 · 이탈'));
  assert.deepEqual(h.read('state.leads'), before);
  assert.equal(h.run('outbox.size()'), 0);
});

test('학원 목록 필터는 새 단계 명칭을 쓰며 남아 있는 이전 학원 상태도 찾을 수 있다', () => {
  const h = harness([lead('qa_inquiry', { pipeline: 'academy', stage: 'inquiry' }), lead('qa_old', { pipeline: 'academy', stage: 'at_risk' })]);
  h.change('f-list-pipeline', 'academy');
  assert.ok(h.html.includes('<option value="trial">레벨테스트·체험</option>'));
  h.change('f-list-stage', 'at_risk');
  assert.deepEqual(h.rows(), ['qa_old']);
  h.change('f-list-stage', 'inquiry');
  assert.deepEqual(h.rows(), ['qa_inquiry']);
  assert.ok(h.html.includes('단계: 문의'));
});

test('205명도 마지막 고객까지 탐색하며 페이지당 개수·범위·이전/다음을 맞춘다', async () => {
  const h = harness(many(205));
  h.change('f-list-sort', 'name');
  assert.equal(h.rows().length, 25);
  assert.equal(h.rows()[0], 'qa_001');
  assert.ok(h.html.includes('전체 205명 중 1–25명'));
  assert.equal(h.button('lead-page', { page: 0 }).disabled, true);
  for (let page = 2; page <= 9; page++) await h.click('lead-page', { page });
  assert.deepEqual(h.rows(), ['qa_201', 'qa_202', 'qa_203', 'qa_204', 'qa_205']);
  assert.equal(h.read('ui.listPage'), 9);
  assert.ok(h.html.includes('전체 205명 중 201–205명'));
  assert.equal(h.button('lead-page', { page: 10 }).disabled, true);
  assert.ok(!h.html.includes('200건까지만'));
  await h.click('lead-page', { page: 8 });
  assert.equal(h.rows()[0], 'qa_176');
  h.change('f-list-size', '50');
  assert.equal(h.read('ui.listPage'), 1);
  assert.equal(h.rows().length, 50);
  h.change('f-list-size', '100');
  assert.equal(h.rows().length, 100);
  await h.click('lead-page', { page: 2 });
  assert.equal(h.rows()[0], 'qa_101');
  await h.click('lead-page', { page: 3 });
  assert.equal(h.rows().length, 5);
});

test('필터 변경은 첫 페이지로 돌아가고 재조회로 고객이 줄면 마지막 유효 페이지로 보정한다', async () => {
  const h = harness(many(80));
  h.change('f-list-sort', 'name');
  for (let page = 2; page <= 4; page++) await h.click('lead-page', { page });
  h.search('qa_001');
  assert.deepEqual(h.rows(), ['qa_001']);
  assert.equal(h.read('ui.listPage'), 1);
  await h.click('lead-filter-clear', { filter: 'q' });
  for (let page = 2; page <= 4; page++) await h.click('lead-page', { page });
  h.run('state.leads = state.leads.slice(0, 28);');
  h.render();
  assert.equal(h.read('ui.listPage'), 2);
  assert.deepEqual(h.rows(), ['qa_026', 'qa_027', 'qa_028']);
});

test('검색·상태·채널·담당·파이프라인·단계를 함께 적용하고 개별 조건만 해제한다', async () => {
  const h = harness(fixture());
  await h.click('lead-view', { view: 'all' });
  h.change('f-channel', '맘카페');
  h.change('f-owner', 'admin');
  h.change('f-list-pipeline', 'inspection');
  h.change('f-list-stage', 'interpreted');
  await h.click('status-filter', { s: 'open' });
  h.search('가상 a');
  assert.deepEqual(h.rows(), ['a']);
  for (const filter of ['q', 'status', 'channel', 'owner', 'pipeline', 'stage']) assert.ok(h.button('lead-filter-clear', { filter }), filter + ' 해제 버튼');
  await h.click('lead-filter-clear', { filter: 'q' });
  assert.deepEqual(h.rows().sort(), ['a', 'c', 'i']);
  assert.equal(h.read('ui.owner'), 'admin');
  await h.click('lead-filter-clear', { filter: 'owner' });
  assert.deepEqual(h.rows().sort(), ['a', 'c', 'h', 'i']);
  h.change('f-list-pipeline', 'academy');
  assert.equal(h.read('ui.listStage'), '');
  assert.deepEqual(h.rows(), ['e']);
  const stages = h.document.querySelector('#f-list-stage').options.map(o => o.value);
  assert.ok(stages.includes('trial'));
  assert.ok(!stages.includes('interpreted'));
});

test('빠른 보기는 기존 조건을 지우고 진행·보류와 오늘·지연 팔로업을 구별한다', async () => {
  const h = harness(fixture());
  assert.deepEqual(h.rows().sort(), ['a', 'b', 'c', 'e', 'f', 'h', 'i']);
  h.search('없는 고객');
  await h.click('lead-view', { view: 'all' });
  assert.equal(h.rows().length, 9);
  assert.equal(h.read('ui.q'), '');
  await h.click('lead-view', { view: 'today' });
  assert.deepEqual(h.rows().sort(), ['a', 'h']);
  assert.equal(h.button('lead-view', { view: 'today' }).attrs['aria-pressed'], 'true');
  assert.equal(h.read('ui.listPage'), 1);
  await h.click('lead-view', { view: 'overdue' });
  assert.deepEqual(h.rows(), ['b']);
  await h.click('lead-view', { view: 'open' });
  assert.equal(h.rows().length, 7);
  assert.equal(h.read('ui.listFollowup'), '');
  await h.click('lead-view', { view: 'mine' });
  assert.deepEqual(h.rows().sort(), ['a', 'b', 'c', 'g', 'i']);
  assert.equal(h.read('ui.owner'), 'admin');
});

test('팔로업 선택과 조건 해제는 표의 일정과 일치하고 빠른 보기 선택도 해제한다', async () => {
  const h = harness(fixture());
  h.change('f-list-followup', 'today');
  assert.deepEqual(h.rows().sort(), ['a', 'h']);
  assert.ok(h.html.includes('2026-10-16'));
  assert.equal(h.button('lead-view', { view: 'open' }).attrs['aria-pressed'], 'false');
  h.change('f-list-followup', 'overdue');
  assert.deepEqual(h.rows(), ['b']);
  assert.ok(h.html.includes('1일 지남'));
  await h.click('lead-filter-clear', { filter: 'followup' });
  assert.equal(h.rows().length, 7);
  assert.ok(!h.html.includes('invalid-date'));
});

test('조건 전체 해제는 검색 필터만 초기화하고 정렬·표시 개수는 보존한다', async () => {
  const h = harness(fixture());
  h.change('f-list-sort', 'name');
  h.change('f-list-size', '50');
  h.change('f-channel', '인스타');
  h.search('없는 가정');
  assert.equal(h.rows().length, 0);
  assert.ok(h.html.includes('조건에 맞는 고객이 없습니다'));
  assert.ok(h.html.includes('조건에 맞는 고객 0명'));
  await h.click('lead-filters-reset');
  assert.equal(h.rows().length, 9);
  assert.deepEqual(h.read('[ui.q,ui.status,ui.channel,ui.owner,ui.listPipeline,ui.listStage,ui.listFollowup]'), ['', 'all', '', '', '', '', '']);
  assert.equal(h.read('ui.listSort'), 'name');
  assert.equal(h.read('ui.listPageSize'), 50);
});

test('정렬 선택은 등록일·학생 이름·다음 연락 순서를 실제 표에 반영한다', () => {
  const h = harness([
    lead('third', { name: '가상 가부모', child: { name: '가상 다학생' }, createdAt: '2026-10-03', followups: [] }),
    lead('first', { name: '가상 나부모', child: { name: '가상 나학생' }, createdAt: '2026-10-01', followups: due('2026-10-17') }),
    lead('second', { name: '가상 다부모', child: { name: '가상 가학생' }, createdAt: '2026-10-02', followups: due('2026-10-15') })
  ]);
  assert.deepEqual(h.rows(), ['third', 'second', 'first']);
  h.change('f-list-sort', 'oldest');
  assert.deepEqual(h.rows(), ['first', 'second', 'third']);
  h.change('f-list-sort', 'name');
  assert.deepEqual(h.rows(), ['second', 'first', 'third']);
  h.change('f-list-sort', 'next');
  assert.deepEqual(h.rows(), ['second', 'first', 'third']);
});

test('직원에게 담당자 선택을 노출하지 않고 내 담당 보기는 로그인한 직원으로 제한한다', async () => {
  const h = harness(fixture(), false);
  assert.equal(h.document.querySelector('#f-owner'), null);
  await h.click('lead-view', { view: 'mine' });
  assert.equal(h.read('ui.owner'), 'staff_a');
  assert.deepEqual(h.rows().sort(), ['d', 'e', 'f', 'h']);
  assert.equal(h.document.querySelector('#f-owner'), null);
});

test('목록은 이름·학생·담당자 HTML을 escape하고 전화는 가린 채 검색한다', () => {
  const h = harness([lead('safe', { name: '<img src=x onerror=alert(1)>', phone: '010-0000-0000', child: { name: '<script>child</script>', school: '가상 학교' }, owner: 'staff_a' })]);
  h.run("state.staff[0].name = '<b>직원</b>';");
  h.render();
  assert.ok(h.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(h.html.includes('&lt;script&gt;child&lt;/script&gt;'));
  assert.ok(h.html.includes('&lt;b&gt;직원&lt;/b&gt;'));
  assert.ok(!h.html.includes('<img src=x'));
  assert.ok(!h.html.includes('<script>child'));
  assert.ok(h.html.includes(C.maskPhone('010-0000-0000')));
  assert.ok(!h.html.includes('010-0000-0000'));
  h.search('01000000000');
  assert.deepEqual(h.rows(), ['safe']);
  assert.deepEqual(h.storageWrites, []);
});

test('고객 상세 왕복은 목록 조건·정렬·페이지를 유지하고 고객이나 저장 큐를 수정하지 않는다', async () => {
  const h = harness(many(70));
  h.run('loadLeadQueue = async () => {}; loadPortalLink = async () => {};');
  h.change('f-list-sort', 'name');
  h.change('f-channel', '맘카페');
  h.search('가상');
  await h.click('lead-page', { page: 2 });
  const beforeState = h.read('state');
  const beforeUi = h.read('ui');
  const beforeRows = h.rows();
  h.navigate('#/lead/qa_026');
  assert.ok(h.html.includes('고객 정보'));
  await h.click('back');
  h.navigate('#/leads');
  assert.deepEqual(h.rows(), beforeRows);
  assert.deepEqual(h.read('ui'), beforeUi);
  assert.deepEqual(h.read('state'), beforeState);
  assert.equal(h.run('outbox.size()'), 0);
  assert.deepEqual(h.storageWrites, []);
});

test('한글 조합 중에는 입력을 다시 만들지 않고 검색 후 커서를 보존한다', () => {
  const h = harness([lead('ga', { name: '가상 가나다' }), lead('na', { name: '가상 나다라' })]);
  const before = h.html;
  h.input('가나', true);
  h.flushTimers();
  assert.equal(h.html, before);
  h.input('가나');
  h.flushTimers();
  assert.deepEqual(h.rows(), ['ga']);
  assert.equal(h.document.activeElement.id, 'f-q');
  assert.equal(h.document.activeElement.selectionStart, 2);
  assert.equal(h.document.activeElement.selectionEnd, 2);
});

test('검색 지연 중 상세로 이동하면 늦은 목록 렌더가 상세 화면을 덮지 않는다', () => {
  const h = harness(fixture());
  h.run('loadLeadQueue = async () => {}; loadPortalLink = async () => {};');
  h.input('가상 a');
  h.navigate('#/lead/a');
  const detail = h.html;
  h.flushTimers();
  assert.equal(h.html, detail);
  assert.equal(h.read('route'), 'lead');
});

test('로그아웃·인증 만료는 검색어와 목록 조건을 비워 다음 직원에게 남기지 않는다', async () => {
  for (const action of ['onAuthLost()', 'doLogout()']) {
    const h = harness(many(70));
    h.run('api = async () => ({}); loadHealth = async () => {};');
    h.change('f-owner', 'admin');
    h.change('f-list-pipeline', 'inspection');
    h.search('가상');
    await h.click('lead-page', { page: 2 });
    h.input('가상 검색 중');
    await h.run(action);
    h.flushTimers();
    assert.equal(h.read('session'), null);
    assert.equal(h.read('route'), 'login');
    assert.deepEqual(h.read('[ui.q,ui.status,ui.channel,ui.owner,ui.listPipeline,ui.listStage,ui.listFollowup,ui.listPage,ui.listView]'), ['', 'open', '', '', '', '', '', 1, 'open']);
    assert.equal(h.read('state.leads.length'), 0);
    assert.deepEqual(h.storageWrites, [['crm.token']]);
    assert.ok(!h.html.includes('가상 검색 중'));
  }
});
