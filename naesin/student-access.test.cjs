'use strict';
/* 학생 화면 원본으로 계정 전환·구매팩 보관 금지·학원 연결 회수를 검사한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const inline = html.split('<script>')[1].split('</script>')[0];
const elementIds = new Set(Array.from(html.matchAll(/\bid=["']([^"']+)["']/g), match => match[1]));
const sample = require('./pack-sample.json');
const clone = value => JSON.parse(JSON.stringify(value));
const account = { code: 'ST1', token: 'self-created-token-1', name: '체험 학생' };
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

function screen() {
  const store = new Map([['wbr.auth', JSON.stringify(account)]]), nodes = new Map();
  const documentEvents = new Map(), windowEvents = new Map(), timers = new Map(), requests = [];
  let nextTimer = 0, fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  function node(id) {
    if (!elementIds.has(id)) return null;
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { innerHTML: '', textContent: '', value: '', hidden: false, style: {}, dataset: {},
        children: [], appendChild(child) { this.children.push(child); },
        classList: { contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value), toggle() {} },
        addEventListener() {}, focus() {}, querySelector: () => ({ textContent: '' }), querySelectorAll: () => [],
      });
    }
    return nodes.get(id);
  }
  const ctx = vm.createContext({
    localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    document: { getElementById: node, addEventListener: (type, fn) => documentEvents.set(type, fn), body: { style: {} }, contains: () => false,
      createElement: () => ({ textContent: '', attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key]; } }) },
    window: { addEventListener: (type, fn) => windowEvents.set(type, fn) }, navigator: {}, location: { reload() {} },
    WBNAESIN: require('./engine.js'), WBGRADE: require('./grade.js'), WBGEN: require('./gen.js'), AbortController,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    setInterval: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    fetch: async (url, opt) => { requests.push({ url, ...opt }); return fetchImpl(url, opt); },
  });
  const exportUi = `
  globalThis.ui={boot,api,checkAccount,checkAccess,stopStudy,clearPackCache,migrateLegacy,pullAdopt,pushState,persist,openDemo,renderItem,recoverStateStamps,loadDB,
    clock:now=>{Date.now=()=>now;},
    get:()=>({pack,PACKS,DB,studyStopped,pendingRemote}),
    setup:(a,p)=>{sessionCode=a.code;sessionToken=a.token;KEY='wbn.v1:'+a.code;DB={v:1,owner:a.code,packs:{},savedAt:100};
      pack=normPack(p);PACKS={[p.packId]:pack};packList=[p.packId];authed=true;demoMode=false;ensureStatesAll();},
    demo:()=>{sessionCode=null;sessionToken=null;KEY='wbn.v1:demo';DB={v:1,packs:{},savedAt:0};authed=false;},
    runner:value=>{RQ=value;},renderOff:()=>{render=function(){};}};`;
  assert.match(inline, /  boot\(\);/);
  vm.runInContext(inline.replace('  boot();', exportUi), ctx);
  ctx.ui.setup(account, clone(sample));
  return { ...ctx.ui, store, node, requests, timers, documentEvents, windowEvents,
    setFetch: fn => { fetchImpl = fn; }, changeAccount: a => store.set('wbr.auth', JSON.stringify(a)) };
}

(async () => {
  await t('실제 진단 문항의 모름 보기는 한 번만 나오고 기존 문항의 추가·일반 보기 동작도 유지한다', () => {
    const item = require('./gen.js').diagnosticSet(sample, () => 0.5)[0];
    for (const q of [item, { ...item, choices: item.choices.filter(c => c.key !== item.unknownKey) }, { ...item, unknownKey: undefined, choices: item.choices.filter(c => c.key !== item.unknownKey) }]) {
      const ui = screen();
      ui.renderItem(q, ui.node('rBody'));
      const choices = ui.node('chs').children;
      assert.equal(choices.filter(c => c.getAttribute('data-k') === item.unknownKey).length, q.unknownKey ? 1 : 0);
      assert.equal(choices.length, item.choices.length - (q.unknownKey ? 0 : 1));
    }
  });

  await t('옛 구매팩 캐시만 지우고 학생별 학습 기록은 보존한다', () => {
    const ui = screen();
    ui.store.set('wbn.packs', '{"private-pack":"old purchase"}');
    ui.store.set('wbn.pack', '{"private-pack":"older purchase"}');
    ui.store.set('wbn.v1:ST1', 'learning-record');
    ui.clearPackCache();
    assert.equal(ui.store.has('wbn.packs'), false);
    assert.equal(ui.store.has('wbn.pack'), false);
    assert.equal(ui.store.get('wbn.v1:ST1'), 'learning-record');
    assert.ok(!/function (cachePacks|loadPacksCache|cacheCurrentRange)\(/.test(inline), '구매팩 저장·오프라인 복원 경로가 남았다');
    assert.match(inline, /function boot\(\)\s*\{\s*clearPackCache\(\)/);
  });

  await t('다른 탭에서 학생이나 같은 학생의 토큰이 바뀌면 본문·러너를 닫고 쓰기를 막는다', async () => {
    for (const changed of [{ code: 'ST2', token: 'self-created-token-2' }, { code: 'ST1', token: 'new-token' }]) {
      const ui = screen();
      ui.persist();
      const prior = ui.store.get('wbn.v1:ST1');
      ui.node('rBody').innerHTML = 'private-question';
      ui.node('pjCh').innerHTML = 'private-answer-choices';
      ui.node('pjMsg').innerHTML = 'private-answer';
      ui.node('runner').classList.add('open');
      ui.runner({ timerId: 999, items: [{ prompt: 'private-question' }] });
      ui.changeAccount(changed);
      ui.windowEvents.get('storage')({ key: 'wbr.auth' });
      assert.equal(ui.get().studyStopped, true);
      assert.equal(ui.get().pack, null);
      assert.deepEqual(Object.keys(ui.get().PACKS), []);
      assert.equal(ui.node('runner').classList.contains('open'), false);
      assert.equal(ui.node('rBody').innerHTML, '');
      assert.equal(ui.node('pjCh').innerHTML, '');
      assert.equal(ui.node('pjMsg').innerHTML, '');
      assert.equal(ui.node('whoLine').innerHTML, '');
      assert.match(ui.node('wrap').innerHTML, /연동 학생이 바뀌었습니다/);
      ui.persist();
      await assert.rejects(ui.api('/state'), /account-changed/);
      assert.equal(ui.requests.length, 0);
      assert.equal(ui.store.get('wbn.v1:ST1'), prior);
      assert.equal(ui.store.has('wbn.v1:ST2'), false);
    }
  });

  await t('요청은 부팅 토큰을 쓰며 응답 도착 전에 계정이 바뀌면 채택하지 않는다', async () => {
    const ui = screen();
    let resolve;
    ui.setFetch(() => new Promise(r => { resolve = r; }));
    const pending = ui.api('/state');
    assert.equal(ui.requests[0].headers.Authorization, 'Bearer ' + account.token);
    assert.equal(ui.requests[0].cache, 'no-store');
    ui.changeAccount({ code: 'ST2', token: 'token-2' });
    resolve({ ok: true, status: 200, json: async () => ({ state: { owner: 'ST1' } }) });
    await assert.rejects(pending, /account-changed/);
    assert.equal(ui.get().studyStopped, true);
  });

  await t('소유자가 다른 원격·레거시 기록을 섞지 않고 원본 레거시는 남긴다', () => {
    const ui = screen();
    assert.equal(ui.pullAdopt({ owner: 'ST2', packs: { private: { savedAt: 999 } } }), false);
    assert.equal(ui.get().DB.packs.private, undefined);
    for (const legacy of [{ owner: 'ST2', packs: { private: {} } }, { packs: { private: {} } }]) {
      ui.store.set('wbn.v1', JSON.stringify(legacy));
      assert.equal(ui.migrateLegacy(), false);
      assert.equal(ui.get().DB.packs.private, undefined);
      assert.equal(ui.store.get('wbn.v1'), JSON.stringify(legacy));
    }
  });

  await t('기존 시험 조회로 연결을 확인하고 학원망 거절·단절·10초 무응답에는 자료를 닫는다', async () => {
    for (const failure of ['denied', 'offline', 'timeout']) {
      const ui = screen();
      ui.persist();
      const record = ui.store.get('wbn.v1:ST1');
      ui.setFetch((url, opt) => {
        if (failure === 'denied') return { ok: false, status: 403 };
        if (failure === 'offline') throw new Error('network');
        return new Promise((resolve, reject) => opt.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      });
      const pending = ui.checkAccess();
      assert.equal(ui.requests[0].url, '/api/naesin/exam');
      if (failure === 'timeout') [...ui.timers.values()].find(t => t.ms === 10000).fn();
      assert.equal(await pending, false);
      assert.equal(ui.get().pack, null);
      assert.deepEqual(Object.keys(ui.get().PACKS), []);
      assert.match(ui.node('wrap').innerHTML, /학원 연결을 확인/);
      assert.equal(ui.store.get('wbn.v1:ST1'), record);
    }
    const offline = screen();
    offline.windowEvents.get('offline')();
    assert.equal(offline.get().pack, null);
    assert.match(inline, /setInterval\(checkAccess, 30000\)/);
    assert.match(inline, /function onWake\(\)[\s\S]*?checkAccess\(\)/);
  });

  await t('연결 확인 성공은 자료를 유지하고 자체 창작 체험은 연결 검사 없이 열린다', async () => {
    const ui = screen();
    assert.equal(await ui.checkAccess(), true);
    assert.ok(ui.get().pack);
    const demo = screen();
    demo.demo(); demo.renderOff();
    demo.setFetch(url => { assert.equal(url, './pack-sample.json'); return { json: async () => clone(sample) }; });
    await demo.openDemo();
    assert.equal(demo.get().pack.packId, sample.packId);
    const count = demo.requests.length;
    assert.equal(await demo.checkAccess(), false);
    assert.equal(demo.requests.length, count);
    demo.windowEvents.get('offline')();
    assert.ok(demo.get().pack, '자체 창작 체험은 오프라인에서 닫지 않는다');
  });

  await t('서버 동률 확정은 채택하고 요청 뒤 새 학습 기록은 지키며 요약을 한 번 갱신한다', async () => {
    const ui = screen(); ui.renderOff();
    const pid = sample.packId, state = ui.get().DB;
    state.packs[pid].savedAt = 100;
    let count = 0;
    ui.setFetch((url, opt) => {
      count++;
      const sent = JSON.parse(opt.body).state;
      if (count === 1) { sent.packs[pid].diagDone = true; return { ok: true, status: 200, json: async () => ({ state: sent }) }; }
      assert.equal(sent.packs[pid].diagDone, true);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    await ui.pushState();
    assert.equal(count, 2);
    assert.equal(state.packs[pid].diagDone, true);
    const sent = clone(state), remote = clone(state);
    state.packs[pid].savedAt = 101; state.packs[pid].diagDone = false;
    remote.packs[pid].diagDone = true;
    assert.equal(ui.pullAdopt(remote, sent), false);
    assert.equal(state.packs[pid].diagDone, false);
  });

  await t('시계 정상화 뒤 미래 idle 과는 내용·due·last를 지키고 저장 시각만 0으로 회복한다', async () => {
    const ui = screen(), now = Date.now(), future = now + 10 * 60e3;
    ui.clock(now); ui.renderOff();
    const state = ui.get().DB;
    state.savedAt = future;
    state.packs['idle-lesson'] = { savedAt: future, marker: '원래 학습', states: { word: { due: future, last: future } } };
    ui.store.set('wbn.v1:ST1', JSON.stringify(state));
    const loaded = ui.loadDB();
    assert.equal(loaded.savedAt, 0);
    assert.equal(loaded.packs['idle-lesson'].savedAt, 0);
    assert.equal(loaded.packs['idle-lesson'].states.word.due, future);
    ui.setFetch((url, opt) => {
      const sent = JSON.parse(opt.body).state;
      assert.equal(sent.savedAt, 0);
      assert.deepEqual(sent.packs['idle-lesson'], { savedAt: 0, marker: '원래 학습', states: { word: { due: future, last: future } } });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    await ui.pushState();
    const remote = { owner: 'ST1', savedAt: future, packs: { 'other-lesson': { savedAt: future, marker: '원격 원본' } } };
    assert.equal(ui.pullAdopt(remote), true);
    assert.equal(ui.get().DB.packs['other-lesson'].savedAt, 0);
    assert.equal(ui.get().DB.packs['other-lesson'].marker, '원격 원본');
    const current = { owner: 'ST1', savedAt: now, packs: { 'idle-lesson': { savedAt: now, marker: '정상 시계의 서버 최신' } } };
    assert.equal(ui.pullAdopt(current), true);
    assert.equal(ui.get().DB.packs['idle-lesson'].marker, '정상 시계의 서버 최신');
  });

  await t('기기 시계가 여전히 미래면 자동으로 정상 학습을 꾸미지 않고 서버의 시계 확인 안내를 보여 준다', async () => {
    const ui = screen(), future = Date.now() + 10 * 60e3, state = ui.get().DB;
    ui.clock(future);
    state.savedAt = future; state.packs[sample.packId].savedAt = future;
    ui.setFetch((url, opt) => {
      const sent = JSON.parse(opt.body).state;
      assert.equal(sent.savedAt, future);
      assert.equal(sent.packs[sample.packId].savedAt, future);
      return { ok: false, status: 400, json: async () => ({ error: '학습 시각이 올바르지 않아요. 기기 시간을 확인해 주세요.' }) };
    });
    await ui.pushState();
    assert.match(ui.node('topBanner').textContent, /기기 시간을 확인/);
    assert.equal(state.savedAt, future);
  });

  await t('러너가 참조하는 기록은 서버 응답 도착 때 바꾸지 않고 종료 뒤에 채택한다', async () => {
    const ui = screen(); ui.renderOff();
    const pid = sample.packId, before = ui.get().DB.packs[pid];
    before.savedAt = 100;
    ui.runner({ items: [] });
    let count = 0;
    ui.setFetch((url, opt) => {
      count++;
      const state = JSON.parse(opt.body).state;
      if (count === 1) { state.packs[pid].diagDone = true; return { ok: true, status: 200, json: async () => ({ state }) }; }
      assert.equal(state.packs[pid].diagDone, true);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    await ui.pushState();
    assert.equal(ui.get().DB.packs[pid], before);
    assert.equal(before.diagDone, false);
    assert.ok(ui.get().pendingRemote);
    ui.runner(null);
    await ui.pushState();
    assert.equal(ui.get().DB.packs[pid].diagDone, true);
    assert.equal(ui.get().pendingRemote, null);
  });

  await t('서비스 워커는 앱 셸·자체 창작 샘플만 캐시하고 다른 앱 캐시는 보존한다', async () => {
    const events = new Map(), deleted = [], stored = [];
    const origin = 'https://academy.invalid';
    const ctx = vm.createContext({
      URL, location: { origin },
      self: { location: { href: origin + '/naesin/sw.js' }, addEventListener: (type, fn) => events.set(type, fn), clients: { claim() {} } },
      caches: {
        match: async () => null,
        open: async () => ({ put: async key => stored.push(key) }),
        keys: async () => ['wbn-shell-old', 'wbn-shell-dev', 'other-app-shell'],
        delete: async key => { deleted.push(key); },
      },
      fetch: async () => ({ clone: () => ({}) }),
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8'), ctx);
    for (const url of ['/api/naesin/pack?id=private', '/naesin/private-pack.json', '/admin/naesin-admin.html']) {
      events.get('fetch')({ request: { url: origin + url, method: 'GET' }, respondWith: () => { throw new Error('구매 자료·관리 화면 캐시 경로: ' + url); } });
    }
    let response;
    events.get('fetch')({ request: { url: origin + '/naesin/pack-sample.json', method: 'GET' }, respondWith: promise => { response = promise; } });
    await response;
    assert.equal(stored.length, 1, '자체 창작 체험은 오프라인 캐시');
    let activated;
    events.get('activate')({ waitUntil: promise => { activated = promise; } });
    await activated;
    assert.deepEqual(deleted, ['wbn-shell-old']);
  });
  console.log('통과 ' + passed);
})().catch(e => { console.error(e); process.exitCode = 1; });
