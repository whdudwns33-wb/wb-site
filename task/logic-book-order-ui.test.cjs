const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} 블록을 찾을 수 없습니다`);
  return html.slice(start, end);
}

const EXPECTED_SERIES = [
  ['logic_preparatory', '예비', [18000, 18000, 18000, 18000, 18000, 18000]],
  ['logic_basic', '기본', [24000, 24000, 26000, 24000, 24000, 24000, 24000, 24000, 24000, 24000, 24000, 24000]],
  ['logic_leap', '도약', [28000, 28000, 28000, 24000, 24000, 28000, 24000, 28000, 24000, 24000, 24000, 24000]],
  ['logic_growth', '성장', [24000, 24000, 24000, 26000, 24000, 24000, 24000, 24000, 24000, 24000, 24000, 24000]]
];

function harness() {
  const observations = { modals: [], confirmations: [], posts: [], toasts: [], renders: 0, reloads: 0, applied: [] };
  const controls = {
    link: { disabled: true }, submit: { disabled: true }, save: { disabled: true }, summary: { outerHTML: '' },
    radios: new Map(), volumes: new Map(), checkedStudents: []
  };
  const candidates = [{ id: '10000001', name: '테스트원생', school: '테스트초등학교', grade: '초3' },
    { id: '10000002', name: '다른원생', school: '테스트중학교', grade: '중1' }];
  const document = {
    activeElement: null,
    querySelectorAll(selector) {
      if (selector === '[data-internal-book-option]') return [...controls.radios.values()];
      if (selector === '[data-internal-book-volume]') return [...controls.volumes.values()];
      if (selector === '[data-internal-book-student]:checked') return controls.checkedStudents.map(value => ({ value }));
      throw new Error(`예상하지 못한 선택자: ${selector}`);
    },
    querySelector(selector) {
      return {
        '[data-act="internalbookstudentopen"]': controls.link,
        '[data-act="internalbookordersubmit"]': controls.submit,
        '[data-act="internalbookstudentlinksave"]': controls.save,
        '[data-internal-book-summary]': controls.summary
      }[selector] || null;
    }
  };
  const source = block('const INTERNAL_BOOK_OPTIONS =', 'const BOUND_BOOK_OPTIONS =');
  const functions = block('function internalBookOption(', 'function boundBookOption(');
  const change = block("  const internalBookOptionInput = ev.target.closest('[data-internal-book-option]');",
    "  const internalBookStudent = ev.target.closest('[data-internal-book-student]');");
  const api = new Function('env', `
    const { document, orderStudentCandidates, esc, staffStudentCompactLabel, modal, toast, closeModal,
      render, bookOrderStudentScopeText, bookOrderStudentSchoolGradeLabel, sync, uid, SYNC_APP,
      openBookOrderFinalConfirmation, applyCreatedLesson, loadBookIssues } = env;
    let bookIssueLoaded = true, bookIssueError = '';
    ${source}
    ${functions}
    function onChange(ev) { ${change} }
    return {
      options: INTERNAL_BOOK_OPTIONS, option: internalBookOption, price: internalBookUnitPrice,
      title: internalBookTitle, label: internalBookPriceLabel, volume: internalBookValidVolume,
      render: internalBookOrderOptionsHtml, renderVolumes: internalBookVolumeOptionsHtml,
      summary: internalBookOrderSummaryHtml, syncUi: syncInternalBookOrderUi,
      open: openInternalBookStudentModal, save: saveInternalBookStudentLink, submit: submitInternalBookOrder,
      onChange,
      getState: () => ({ code: internalBookOptionCode, volume: internalBookVolume,
        draft: internalBookDraft, submitting: internalBookSubmitting }),
      setState: (code, volume, draft) => { internalBookOptionCode = code; internalBookVolume = volume;
        internalBookDraft = draft; }
    };
  `)({
    document, orderStudentCandidates: () => candidates, esc: String,
    staffStudentCompactLabel: student => student.name + ' ' + student.grade,
    modal: (...args) => observations.modals.push(args), toast: message => observations.toasts.push(message),
    closeModal() {}, render: () => { observations.renders += 1; }, bookOrderStudentScopeText: () => '담당 학생',
    bookOrderStudentSchoolGradeLabel: student => student.grade,
    sync: {
      auth: () => ({ id: 'fixture-staff', token: 'fixture-only' }),
      post: async (url, body) => {
        observations.posts.push({ url, body: structuredClone(body) });
        return { task: { id: body.taskId, orderDelivery: 'internal_book_v1', orderIdentityVersion: 1 } };
      }
    },
    uid: () => 'fixture-order', SYNC_APP: 'task',
    openBookOrderFinalConfirmation: (kind, items) => observations.confirmations.push({ kind, items }),
    applyCreatedLesson: task => observations.applied.push(task),
    loadBookIssues: async () => { observations.reloads += 1; }
  });
  for (const option of api.options) {
    const price = { textContent: '' };
    const row = { selected: false, price, classList: { toggle: (_name, selected) => { row.selected = selected; } },
      querySelector: selector => selector === '[data-internal-book-price]' ? price : null };
    const radio = { value: option.productCode, checked: false, disabled: false,
      closest: selector => selector === '[data-internal-book-option]' ? radio : selector === '.internal-book-option' ? row : null };
    controls.radios.set(option.productCode, radio);
    if (option.maxVolume) {
      const select = { value: '', dataset: { productCode: option.productCode }, disabled: false,
        closest: selector => selector === '[data-internal-book-volume]' ? select : selector === '.internal-book-option' ? row : null };
      controls.volumes.set(option.productCode, select);
    }
  }
  return {
    api, controls, observations, document,
    choose(code) { api.onChange({ target: controls.radios.get(code) }); },
    chooseVolume(code, volume) {
      const input = controls.volumes.get(code);
      input.value = String(volume);
      document.activeElement = input;
      api.onChange({ target: input });
    },
    linkStudents(ids = ['10000001']) { controls.checkedStudents = ids; api.save(); }
  };
}

test('논리와 상상 4개 시리즈 42권의 제목·권수·권별 가격을 정확히 표시한다', () => {
  const { api } = harness();
  assert.deepEqual(api.options.filter(option => option.family === 'logic').map(option => option.productCode),
    EXPECTED_SERIES.map(([code]) => code));
  const markup = api.renderVolumes('logic');
  assert.equal((markup.match(/<select /g) || []).length, 4);
  assert.equal((markup.match(/<option value="">권번호 선택<\/option>/g) || []).length, 4);
  assert.doesNotMatch(markup, /\sselected(?:\s|>)/, '최초에는 권번호를 자동 선택하지 않습니다');
  let total = 0;
  for (const [code, label, prices] of EXPECTED_SERIES) {
    const option = api.option(code);
    assert.equal(option.maxVolume, prices.length);
    const dropdown = markup.split(`data-product-code="${code}"`)[1].split('</select>')[0];
    assert.deepEqual([...dropdown.matchAll(/<option value="(\d+)"/g)].map(match => Number(match[1])),
      prices.map((_, index) => index + 1));
    prices.forEach((price, index) => {
      const volume = index + 1;
      assert.equal(api.price(option, volume), price, `${label} ${volume}권 가격`);
      assert.equal(api.price(option, String(volume)), price, `${label} ${volume}권 문자열 가격`);
      assert.equal(api.title(option, volume), `논리와 상상 ${label} ${volume}권`);
      assert.ok(dropdown.includes(`>${volume}권 · ${price.toLocaleString('ko-KR')}원</option>`));
      total += 1;
    });
  }
  assert.equal(total, 42);
});

test('권번호 선택 전 또는 범위 밖 권번호로 학생 연결·주문을 진행할 수 없다', async () => {
  const h = harness();
  assert.match(h.api.render(), /data-act="internalbookstudentopen" disabled/);
  for (const [code, , prices] of EXPECTED_SERIES) {
    h.choose(code);
    assert.equal(h.controls.link.disabled, true);
    for (const invalid of ['', 0, -1, 1.5, prices.length + 1, '1e0', '1권', ' ', null, undefined]) {
      assert.equal(h.api.volume(h.api.option(code), invalid), null, `${code}: ${invalid}`);
      assert.equal(h.api.price(h.api.option(code), invalid), null, `${code}: ${invalid} 가격도 미정`);
      h.api.setState(code, invalid, { productCode: code, volume: invalid, studentIds: ['10000001'] });
      h.api.syncUi();
      assert.equal(h.controls.link.disabled, true);
      assert.equal(h.controls.submit.disabled, true);
      h.api.open();
      await h.api.submit(null, true);
    }
  }
  assert.equal(h.observations.modals.length, 0);
  assert.equal(h.observations.posts.length, 0);
});

test('권번호를 바꾸면 가격을 즉시 갱신하고 학생 연결 초안을 초기화하되 화면·포커스·접기 상태는 보존한다', () => {
  const h = harness();
  h.chooseVolume('logic_basic', 3);
  const select = h.controls.volumes.get('logic_basic');
  const row = select.closest('.internal-book-option');
  assert.equal(h.controls.link.disabled, false);
  assert.equal(row.price.textContent, '26,000원');
  h.linkStudents();
  assert.equal(h.controls.submit.disabled, false);
  assert.match(h.controls.summary.outerHTML, /논리와 상상 기본 3권/);
  assert.match(h.controls.summary.outerHTML, /권당 26,000원/);
  h.chooseVolume('logic_basic', 4);
  assert.equal(row.price.textContent, '24,000원');
  assert.equal(h.api.getState().draft, null);
  assert.equal(h.controls.submit.disabled, true);
  assert.equal(h.controls.link.disabled, false);
  assert.equal(h.document.activeElement, select, '기존 선택 요소를 교체하지 않습니다');
  assert.equal(h.observations.renders, 0, '권번호·학생 연결 변경에서 전체 화면을 다시 그리지 않습니다');
  h.linkStudents();
  h.chooseVolume('logic_growth', 4);
  assert.equal(select.value, '', '다른 시리즈를 선택하면 이전 권 선택은 해제됩니다');
  assert.equal(h.api.getState().draft, null);
  assert.equal(h.controls.submit.disabled, true);
  assert.equal(h.controls.volumes.get('logic_growth').closest('.internal-book-option').price.textContent, '26,000원');
  const ui = block('function syncInternalBookOrderUi(', 'function syncInternalBookStudentLinkButton(');
  assert.doesNotMatch(ui, /render\(\)|details[^\n]*(?:open|removeAttribute)|\.focus\(|\.innerHTML\s*=/);
  assert.match(html, /data-persist-key="book-order-internal-/);
});

test('42권 모두 학생 연결 팝업·주문 요약·최종 확인에 같은 확정 가격을 사용한다', async () => {
  for (const [code, label, prices] of EXPECTED_SERIES) {
    for (let index = 0; index < prices.length; index += 1) {
      const h = harness();
      const volume = index + 1;
      const price = prices[index];
      h.chooseVolume(code, volume);
      h.api.open();
      const [title, body] = h.observations.modals.at(-1);
      assert.equal(title, `학생 연결 — 논리와 상상 ${label} ${volume}권`);
      assert.ok(body.includes(`권당 ${price.toLocaleString('ko-KR')}원`));
      h.linkStudents(['10000001', '10000002']);
      assert.ok(h.api.summary().includes(`권당 ${price.toLocaleString('ko-KR')}원 · 2권`));
      await h.api.submit(null, false);
      assert.deepEqual(h.observations.confirmations.at(-1), { kind: 'internal', items: [{
        title: `논리와 상상 ${label} ${volume}권`, unitPrice: price, studentIds: ['10000001', '10000002']
      }] });
      assert.equal(h.observations.posts.length, 0, '최종 확인 전에는 주문하지 않습니다');
    }
  }
});

test('최종 확인 후에는 제품 코드·권번호·stable studentId만 보내고 서버 확정 이후 3단계를 다시 불러온다', async () => {
  const h = harness();
  h.chooseVolume('logic_leap', 8);
  h.linkStudents(['10000001', '10000002']);
  await h.api.submit(null, false);
  const success = await h.api.submit({ disabled: false, isConnected: true }, true);
  assert.equal(success, true);
  assert.equal(h.observations.posts.length, 1);
  assert.deepEqual(h.observations.posts[0], { url: '/book-order', body: {
    app: 'task', auth: { id: 'fixture-staff', token: 'fixture-only' }, action: 'create_internal',
    taskId: 'ord_fixture-order', productCode: 'logic_leap', volume: 8, studentIds: ['10000001', '10000002']
  } });
  for (const key of ['price', 'unitPrice', 'title', 'studentName', 'bookTitle']) {
    assert.equal(Object.hasOwn(h.observations.posts[0].body, key), false, `${key}는 서버에서 확정합니다`);
  }
  assert.equal(h.observations.reloads, 1);
  assert.equal(h.observations.applied.length, 1);
  assert.equal(h.api.getState().draft, null);
  assert.equal(h.api.getState().code, '');
  assert.ok(h.observations.toasts.some(message => message.includes('3단계 선생님 수령')));
});

test('선택과 초안의 권번호가 다르거나 연결 학생이 사라진 경우 최종 확인된 주문도 차단한다', async () => {
  const h = harness();
  h.api.setState('logic_basic', '4', { productCode: 'logic_basic', volume: 3, studentIds: ['10000001'] });
  await h.api.submit(null, true);
  h.api.setState('logic_basic', '3', { productCode: 'logic_basic', volume: 3, studentIds: ['missing-student'] });
  await h.api.submit(null, true);
  assert.equal(h.observations.posts.length, 0);
  assert.equal(h.observations.confirmations.length, 0);
});

test('기존 독해창의 권 선택과 어휘·스터디포스의 단일 가격 주문은 그대로 동작한다', async () => {
  for (const [code, volume, title, price] of [
    ['reading_bisang', 8, '독해창 비상 8권', 23000],
    ['reading_advanced', 12, '독해창 심화 12권', 19000],
    ['vocab_stage_1', '', '어휘가 독해다 1단계', 12500],
    ['studyforce_bound', '', '스터디포스 제본', 6000]
  ]) {
    const h = harness();
    if (volume) h.chooseVolume(code, volume); else h.choose(code);
    assert.equal(h.controls.link.disabled, false);
    h.linkStudents();
    await h.api.submit(null, false);
    assert.deepEqual(h.observations.confirmations.at(-1).items[0], { title, unitPrice: price, studentIds: ['10000001'] });
    assert.equal(await h.api.submit(null, true), true);
    assert.equal(h.observations.posts[0].body.volume, volume || undefined);
  }
});
