'use strict';
/* 실제 학생 연동 스크립트: 자체 코드·토큰·기록만으로 영어 입구와 기존 독서 흐름을 검사한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const inline = html.split('<script>')[1].split('</script>')[0];
const account = { code: 'OWN-A', name: '자체 학생 A', token: 'own-token-a' };
const other = { code: 'OWN-B', name: '자체 학생 B', token: 'own-token-b' };
const record = JSON.stringify({ v: 1, profile: { grade: '초5', level: 'L2', interests: [] }, readings: { own: { sec: 90 } } });
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

function screen(opt = {}) {
  const store = new Map([['wbr.v1', record]]), nodes = new Map(), events = new Map(), requests = [], writes = [], timers = new Map();
  if (opt.auth) store.set('wbr.auth', JSON.stringify(opt.auth));
  if (opt.rawAuth !== undefined) store.set('wbr.auth', opt.rawAuth);
  let timer = 0, fetchImpl = opt.fetch || (async url => {
    if (url === '/api/health') return reply({ ok: true });
    if (url === '/api/login') return reply({ nonce: 'own-pending', name: '자체 학생' });
    if (url.startsWith('/api/login/status')) return reply({ pending: true });
    if (url === '/api/naesin/exam') return reply({ exam: { packIds: [] } });
    if (url === '/api/pull') return reply({ state: null, level: null });
    if (url === './version.json') return reply({ v: 'own-version' });
    if (url.startsWith('./articles-')) return reply({ articles: [], diagnostics: {} });
    if (url === '/api/state') return reply({ ok: true });
    throw new Error('Unexpected own-fixture URL: ' + url);
  });
  const location = { search: opt.search || '?app=naesin', pathname: '/', origin: 'http://own-academy.test', replaced: [],
    replace(value) { this.replaced.push(value); }, reload() {} };
  function node(selector) {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, { innerHTML: '', textContent: '', value: '', hidden: false, dataset: {}, style: {}, removed: false,
        remove() { this.removed = true; }, setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {},
        querySelectorAll: () => [], classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle() {} } });
    }
    return nodes.get(selector);
  }
  const history = { state: null, replaceState(state, title, url) {
    this.state = state;
    if (url !== undefined) { const parsed = new URL(url, location.origin); location.search = parsed.search; location.pathname = parsed.pathname; }
  }, pushState(state) { this.state = state; } };
  const ctx = vm.createContext({ location, history, URLSearchParams, console,
    document: { title: 'WB 진로독서', querySelector: node, getElementById: id => node('#' + id), querySelectorAll: () => [],
      addEventListener: (type, fn) => events.set(type, fn) },
    window: { scrollY: 0, scrollTo() {}, matchMedia: () => ({ matches: false }), addEventListener: (type, fn) => events.set(type, fn) },
    navigator: { userAgent: 'own fixture' },
    localStorage: { getItem: k => store.get(k) || null, setItem(k, v) { writes.push(k); store.set(k, v); }, removeItem(k) { writes.push(k); store.delete(k); } },
    setTimeout: (fn, ms) => { timers.set(++timer, { fn, ms }); return timer; }, clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { timers.set(++timer, { fn, ms }); return timer; }, clearInterval: id => timers.delete(id),
    fetch: async (url, options) => { requests.push({ url, ...options }); return fetchImpl(url, options); },
  });
  const exportUi = `globalThis.ui={syncRequest,syncPoll,syncPull,syncPush,schedulePush,save,startNaesinLink,
    get:()=>({SYNC,sess,S,view,NAESIN_LINK}), setAuth:a=>{SYNC.auth=a;syncSaveAuth();}};globalThis.bootDone=`;
  assert.ok(inline.includes('(async function boot(){'));
  vm.runInContext(inline.replace('(async function boot(){', exportUi + '(async function boot(){'), ctx);
  return { ...ctx.ui, boot: ctx.bootDone, store, requests, writes, timers, node, location, document: ctx.document,
    setFetch: fn => { fetchImpl = fn; }, storedAuth: a => store.set('wbr.auth', JSON.stringify(a)),
    cancel: () => events.get('click')({ target: { closest: () => ({ dataset: { act: 'sync-cancel' } }) } }),
    pop: state => events.get('popstate')({ state }),
  };
}
function noReading(ui) {
  assert.equal(ui.store.get('wbr.v1'), record, '기존 독서 기록의 저장 문자열도 바꾸지 않는다');
  assert.ok(!ui.writes.includes('wbr.v1'));
  assert.ok(!ui.requests.some(r => /\/api\/(pull|state|league)|articles-|version\.json|hanja\.json/.test(r.url)));
}

(async () => {
  await t('영어 QR 승인 후 자동 이동하고 독서 기록·학년 온보딩을 건드리지 않는다', async () => {
    const ui = screen({ search: '?c=OWN-A&app=naesin' }); await ui.boot;
    assert.equal(ui.location.search, '?app=naesin'); assert.equal(ui.get().sess.pend.nonce, 'own-pending');
    assert.ok(!ui.node('#app').innerHTML.includes('ob-skip-link')); assert.ok(!ui.node('#app').innerHTML.includes('ob-grade'));
    assert.equal(ui.document.title, 'WB 내신브레인 · 학생 연동'); assert.equal(ui.node('.swap').removed, true);
    assert.equal(ui.node('#tabbar').hidden, true); assert.equal(ui.node('#headActions').innerHTML, '');
    ui.setFetch(async url => { assert.match(url, /^\/api\/login\/status\?/); return reply({ student: account, token: account.token }); });
    await ui.syncPoll(true);
    assert.deepEqual(ui.location.replaced, ['/naesin/']); assert.equal(JSON.parse(ui.store.get('wbr.auth')).code, account.code);
    await ui.syncPull(); await ui.syncPush(); ui.schedulePush(); ui.save();
    ui.pop({ wb: { name: 'report' } }); noReading(ui);
    assert.ok(!Array.from(ui.timers.values()).some(x => x.ms === 2500 || x.ms === 4000));
  });
  await t('코드 없는 영어 입구·새로고침도 영어 연동을 유지한다', async () => {
    const ui = screen(); await ui.boot; assert.match(ui.node('#app').innerHTML, /id="obCode"/);
    await ui.syncRequest(' OWN-A '); assert.equal(JSON.parse(ui.requests.at(-1).body).code, account.code);
    const refreshed = screen({ search: ui.location.search }); await refreshed.boot;
    assert.equal(refreshed.get().NAESIN_LINK, true); assert.match(refreshed.node('#app').innerHTML, /내신브레인 학생 연동/); noReading(refreshed);
  });
  await t('기존 연동은 시험 메타만 재확인하며 같은 학생 QR도 새 승인 없이 복귀한다', async () => {
    for (const search of ['?app=naesin', '?c=OWN-A&app=naesin']) {
      const ui = screen({ search, auth: account }); await ui.boot;
      assert.deepEqual(ui.requests.map(r => r.url), ['/api/health', '/api/naesin/exam']);
      assert.equal(ui.requests[1].headers.Authorization, 'Bearer ' + account.token);
      assert.deepEqual(ui.location.replaced, ['/naesin/']); noReading(ui);
    }
  });
  await t('만료·허가 실패·서버 끊김은 영어 연동에서 복구하며 독서로 넘어가지 않는다', async () => {
    for (const status of [401, 403, 503]) {
      const ui = screen({ auth: account, fetch: async url => url === '/api/health' ? reply({ ok: true }) : reply({ error: '자체 오류' }, status) });
      await ui.boot; assert.deepEqual(ui.location.replaced, []); assert.match(ui.node('#app').innerHTML, /obCode/);
      assert.equal(ui.store.has('wbr.auth'), status !== 401); noReading(ui);
    }
    const offline = screen({ fetch: async () => { throw new Error('own offline'); } }); await offline.boot;
    assert.match(offline.node('#app').innerHTML, /연결 다시 확인/); assert.ok(!offline.node('#app').innerHTML.includes('ob-grade')); noReading(offline);
  });
  await t('다른 학생 QR은 이전 계정으로 시험을 열지 않고 새 강사 승인을 요청한다', async () => {
    const ui = screen({ search: '?app=naesin&c=OWN-B', auth: account }); await ui.boot;
    assert.ok(!ui.store.has('wbr.auth')); assert.ok(!ui.requests.some(r => r.url === '/api/naesin/exam'));
    const login = ui.requests.find(r => r.url === '/api/login'); assert.equal(JSON.parse(login.body).code, other.code);
    assert.ok(!login.headers.Authorization); assert.deepEqual(ui.location.replaced, []); noReading(ui);
  });
  await t('잘못 저장된 인증도 무한 로딩 대신 학생 코드 입력을 연다', async () => {
    for (const rawAuth of ['{broken', '7', '"own"', '[]', '{"code":"OWN-A"}', '{"code":"OWN-A","token":8}']) {
      const ui = screen({ rawAuth }); await ui.boot;
      assert.equal(ui.get().SYNC.auth, null); assert.match(ui.node('#app').innerHTML, /obCode/);
      await ui.syncRequest(account.code); assert.ok(ui.get().sess.pend); noReading(ui);
    }
  });
  await t('기존 QR·알 수 없는 app 값은 기존 독서 복원·저장을 유지하고 임의 주소로 이동하지 않는다', async () => {
    for (const search of ['?c=OWN-A', '?app=other&c=OWN-A', '?app=https%3A%2F%2Fown-other.test&c=OWN-A']) {
      const ui = screen({ search }); await ui.boot;
      for (let i = 0; i < 8 && !ui.get().sess.pend; i++) await Promise.resolve();
      assert.ok(ui.get().sess.pend, '기존 QR 요청의 비동기 완료를 확인한다');
      ui.setFetch(async url => url.startsWith('/api/login/status') ? reply({ student: account, token: account.token }) : reply({ ok: true }));
      await ui.syncPoll(true);
      assert.equal(ui.get().NAESIN_LINK, false); assert.deepEqual(ui.location.replaced, []);
      assert.ok(ui.requests.some(r => r.url.includes('articles-L2'))); assert.ok(ui.requests.some(r => r.url === '/api/pull'));
      assert.ok(ui.requests.some(r => r.url === '/api/state' && r.method === 'PUT'));
      assert.equal(ui.store.get('wbr.v1'), record);
    }
  });
  await t('취소하거나 새 코드를 요청한 뒤 늦게 온 login·status는 옛 학생을 로그인시키지 않는다', async () => {
    for (const pathName of ['login', 'status']) {
      const ui = screen(); await ui.boot;
      if (pathName === 'status') await ui.syncRequest(account.code);
      const old = deferred(); ui.setFetch(() => old.promise);
      const pending = pathName === 'login' ? ui.syncRequest(account.code) : ui.syncPoll(true);
      ui.cancel(); ui.setFetch(async () => reply({ nonce: 'own-new', name: other.name })); await ui.syncRequest(other.code);
      old.resolve(reply({ student: account, token: account.token })); await pending;
      assert.equal(ui.get().sess.pend.nonce, 'own-new'); assert.ok(!ui.store.has('wbr.auth')); assert.deepEqual(ui.location.replaced, []); noReading(ui);
    }
  });
  await t('승인 확인의 수동 클릭·주기 폴링이 겹쳐도 승인 토큰을 잃지 않는다', async () => {
    const ui = screen(); await ui.boot; await ui.syncRequest(account.code);
    const approved = deferred(); let count = 0;
    ui.setFetch(() => { count++; return count === 1 ? approved.promise : Promise.resolve(reply({ error: 'own consumed nonce' }, 404)); });
    const first = ui.syncPoll(true), second = ui.syncPoll(false); await second; assert.equal(count, 1);
    approved.resolve(reply({ student: account, token: account.token })); await first;
    assert.deepEqual(ui.location.replaced, ['/naesin/']); assert.equal(JSON.parse(ui.store.get('wbr.auth')).code, account.code); noReading(ui);
  });
  await t('늦은 시험 401은 같은 탭이나 다른 탭에서 새로 로그인한 학생의 인증을 지우지 않는다', async () => {
    for (const storageOnly of [false, true]) {
      const old = deferred(); const ui = screen({ auth: account, fetch: async url => url === '/api/health' ? reply({ ok: true }) : old.promise });
      while (!ui.requests.some(r => r.url === '/api/naesin/exam')) await Promise.resolve();
      if (storageOnly) ui.storedAuth(other); else ui.setAuth(other);
      old.resolve(reply({ error: 'own expired' }, 401)); await ui.boot;
      assert.equal(JSON.parse(ui.store.get('wbr.auth')).token, other.token); assert.deepEqual(ui.location.replaced, []); noReading(ui);
    }
  });
  await t('다른 탭에서 인증이 바뀌면 늦은 승인 응답도 새 인증을 덮지 않는다', async () => {
    for (const pathName of ['login', 'status']) {
      const ui = screen(); await ui.boot;
      if (pathName === 'status') await ui.syncRequest(account.code);
      const old = deferred(); ui.setFetch(() => old.promise);
      const pending = pathName === 'login' ? ui.syncRequest(account.code) : ui.syncPoll(true);
      ui.storedAuth(other); old.resolve(reply({ student: account, token: account.token })); await pending;
      assert.equal(JSON.parse(ui.store.get('wbr.auth')).token, other.token); assert.deepEqual(ui.location.replaced, []); noReading(ui);
    }
  });
  console.log(`\nOK — 영어 학생 연동 ${passed}/${passed}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
