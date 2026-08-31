const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let index = open; index < html.length; index++) {
    const char = html[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  assert.fail(name + ' function is incomplete');
}

function between(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, startMarker + ' section must exist');
  return html.slice(start, end);
}

function subscriptionApi(checks) {
  return Function('state',
    "const SUBSCRIPTION_ADMIN_OWNER = '!director';" +
    "const studentSubscriptionKey = staffId => '__subscription__' + SUBSCRIPTION_ADMIN_OWNER + '|' + staffId;" +
    "const studentSubscriptionPaymentKey = (staffId, month) => '__subscriptionpayment__' + SUBSCRIPTION_ADMIN_OWNER + '|' + staffId + '@' + month;" +
    functionSource('parseYmd') + '\n' + functionSource('ymAdd') + '\n' +
    "function today(){ return '2026-08-31'; }\n" +
    functionSource('normalizeStudentSubscription') + '\n' +
    functionSource('studentSubscription') + '\n' +
    functionSource('studentSubscriptionDueDate') + '\n' +
    functionSource('studentSubscriptionPaidAt') + '\n' +
    functionSource('studentSubscriptionPayment') + '\n' +
    'return { normalizeStudentSubscription, studentSubscription, studentSubscriptionDueDate, studentSubscriptionPaidAt, studentSubscriptionPayment };'
  )({ checks });
}

test('subscription records use an unclaimable director owner and never count as study activity', () => {
  const state = {
    staff: [{ id: 's1', name: '김학생' }],
    tasks: [{ id: '__subscription__!director', staffId: 's1', origin: 'staff' }],
    checks: { '__subscription__!director|s1': { staffId: 's1', active: true, updatedAt: 1 } }
  };
  const owner = Function('state', functionSource('ownerOfCheck') + '; return ownerOfCheck;')(state);
  const scoped = Function('state', functionSource('ownerOfCheck') + '\n' +
    functionSource('studentCacheScopedTo') + '; return studentCacheScopedTo;')(state);
  const activity = Function(functionSource('isStudentActivityCheck') + '; return isStudentActivityCheck;')();

  assert.equal(owner('__subscription__!director|s1'), '!director');
  assert.equal(owner('__subscriptionpayment__!director|s1@2026-08'), '!director');
  assert.equal(scoped('s1'), false);
  assert.equal(activity('__subscription__!director|s1', state.checks['__subscription__!director|s1']), false);
  assert.match(html, /const SUBSCRIPTION_ADMIN_OWNER = '!director'/);
  assert.match(html, /'__subscription__' \+ SUBSCRIPTION_ADMIN_OWNER/);
});

test('monthly payment state clamps short months and rolls the next due date across years', () => {
  const student = { id: 's1', name: '김학생' };
  const checks = {
    '__subscription__!director|s1': {
      staffId: 's1', active: true, billingDay: 31, startedAt: 1, updatedAt: 1
    }
  };
  const api = subscriptionApi(checks);

  assert.equal(api.studentSubscriptionDueDate(student, '2026-02'), '2026-02-28');
  assert.equal(api.studentSubscriptionPayment(student, '2026-08-30').status, 'upcoming');
  assert.equal(api.studentSubscriptionPayment(student, '2026-08-31').needsAttention, true);

  checks['__subscriptionpayment__!director|s1@2026-12'] = {
    staffId: 's1', month: '2026-12', paid: true, paidAt: 123, updatedAt: 123
  };
  const december = api.studentSubscriptionPayment(student, '2026-12-31');
  assert.equal(december.status, 'paid');
  assert.equal(december.nextDueDate, '2027-01-31');

  const normalized = api.normalizeStudentSubscription({
    active: true, billingDay: 99, startedAt: Infinity, endedAt: -1
  });
  assert.equal(normalized.billingDay, 31);
  assert.equal(normalized.startedAt, 0);
  assert.equal(normalized.endedAt, 0);
  assert.equal(api.normalizeStudentSubscription(null).active, false);
});

test('student management combines name search with subscription filters without reordering cards', () => {
  const cards = [
    { dataset: { staffSearchName: '가학생', staffSubscription: '1', staffPaymentAttention: '1' }, hidden: false },
    { dataset: { staffSearchName: '나학생', staffSubscription: '1', staffPaymentAttention: '0' }, hidden: false },
    { dataset: { staffSearchName: '다학생', staffSubscription: '0', staffPaymentAttention: '0' }, hidden: false }
  ];
  const nodes = {
    staffSearchResult: { textContent: '' }, staffSearchEmpty: { hidden: true },
    staffSearchEmptyText: { textContent: '' }, staffSearchClear: { hidden: true }
  };
  const api = Function('$', 'document',
    "let staffSearchQuery = ''; let staffListFilter = 'subscription';" +
    functionSource('normalizeStudentSearch') + '\n' + functionSource('normalizeStaffListFilter') + '\n' +
    functionSource('applyStaffSearchFilter') + '\n' +
    "return { apply: applyStaffSearchFilter, setFilter(value){ staffListFilter=value; } };"
  )(id => nodes[id.slice(1)] || null, { querySelectorAll: () => cards });

  api.apply('학생');
  assert.deepEqual(cards.map(card => card.hidden), [false, false, true]);
  api.setFilter('payment');
  api.apply('학생');
  assert.deepEqual(cards.map(card => card.hidden), [false, true, true]);
  api.apply('나');
  assert.deepEqual(cards.map(card => card.hidden), [true, true, true]);
  assert.equal(nodes.staffSearchEmpty.hidden, false);
  assert.deepEqual(cards.map(card => card.dataset.staffSearchName), ['가학생', '나학생', '다학생']);
});

test('director UI exposes subscription badges, payment actions, filters and non-blocking guidance', () => {
  const view = functionSource('viewStaffAdmin');
  const line = functionSource('studentSubscriptionLine');
  const access = functionSource('staffAccessPanels');
  const dialog = functionSource('studentSubscriptionModal');

  assert.match(view, /월 구독 관리/);
  assert.match(view, /data-staff-filter="/);
  assert.match(view, /aria-pressed=/);
  assert.match(view, /data-staff-subscription=/);
  assert.match(view, /data-staff-payment-attention=/);
  assert.match(view, /결제 확인 필요/);
  assert.match(view, /liveStaff\(\)\.slice\(\)\.sort\(studentNameCompare\)/);
  assert.match(line, /subscriptionpaytoggle/);
  assert.match(line, /구독 종료/);
  assert.match(access, /subscriptionopen/);
  assert.match(dialog, /학생 화면과 이용 기능은 바뀌지 않으며/);
  assert.match(dialog, /학생 웹을 차단하지 않습니다/);
});

test('subscription mutations are director-only and keep config separate from monthly payment rows', () => {
  const saveRecord = functionSource('saveStudentSubscription');
  const savePayment = functionSource('saveStudentSubscriptionPayment');
  const actions = between("case 'stafffilter':", "case 'staffsearchclear':");

  assert.match(saveRecord, /!session\.isAdmin \|\| session\.isStaffLink/);
  assert.match(saveRecord, /state\.checks\[key\] =/);
  assert.doesNotMatch(saveRecord, /state\.staff/);
  assert.doesNotMatch(saveRecord, /paidMonths/);
  assert.match(saveRecord, /if \(!save\(\)\)/);
  assert.match(saveRecord, /state\.checks\[key\] = previous/);
  assert.match(saveRecord, /queueSync\(\)/);
  assert.match(savePayment, /studentSubscriptionPaymentKey/);
  assert.match(savePayment, /month: month/);
  assert.match(savePayment, /paidAt: paid === true \? timestamp : 0/);
  assert.match(savePayment, /if \(!save\(\)\)/);
  assert.match(savePayment, /queueSync\(\)/);
  assert.match(actions, /case 'subscriptionsave'/);
  assert.match(actions, /case 'subscriptionend'/);
  assert.match(actions, /case 'subscriptionpaytoggle'/);
  assert.match(actions, /saveStudentSubscriptionPayment\(id, month, !wasPaid\)/);
  assert.match(actions, /active: false, endedAt: now\(\)/);
  assert.doesNotMatch(actions, /deleted\s*=\s*true/);
  assert.match(actions, /!session\.isAdmin \|\| session\.isStaffLink/g);
});

test('subscription management keeps consult storage and sync identity unchanged', () => {
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);
  assert.match(html, /staffListFilter = 'all'/);
  assert.match(functionSource('applyStaffListFilter'), /applyStaffSearchFilter/);
  assert.match(functionSource('viewStaffAdmin'), /if \(!students\.length\) staffListFilter = 'all'/);
  const clear = between("case 'staffsearchclear':", "case 'linkcontactsretry':");
  assert.doesNotMatch(clear, /staffListFilter\s*=/);
  const add = between("case 'addstaff':", "case 'delstaff':");
  assert.match(add, /staffSearchQuery = ''; staffListFilter = 'all'/);
});
