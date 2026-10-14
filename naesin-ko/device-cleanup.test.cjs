'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
function setup() {
  const storage = new Map([['wbr.auth', 'other-app-login']]);
  const nodes = new Map();
  const calls = [], timers = new Map();
  const env = {
    window: { addEventListener() {}, WBVOICE: { stop() {} } }, navigator: {},
    document: { addEventListener() {}, getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { addEventListener() {} });
      return nodes.get(id);
    } },
    location: { replace(url) { calls.push({ redirect: url }); } },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, value); },
      removeItem(key) { storage.delete(key); }
    },
    confirm() { return true; }, alert(msg) { calls.push({ alert: msg }); },
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, opts) {
      calls.push({ url, opts });
      return Promise.resolve({ status: 200, json() { return Promise.resolve({}); } });
    }
  };
  vm.runInNewContext(script.replace(/  boot\(\);\s*\}\)\(\);/, 'summary = function () { return {}; };\nrender = function () { globalThis.redraws = (globalThis.redraws || 0) + 1; };\nglobalThis.app = { S, selectPack, backupState, persist, push, flush, loadPack, online };\n})();'), env);
  env.app.S.data = { v: 1, packs: { old: { states: { progress: 3 } } }, savedAt: 10 };
  env.app.S.packId = 'old';
  env.app.S.backupSavedAt = 10;
  return { env, app: env.app, storage, nodes, calls, timers };
}

(async function () {
  let t = setup();
  t.app.selectPack('new');
  assert.equal(t.app.S.data.packs.old, undefined);
  assert.equal(JSON.parse(t.storage.get('wbk.v1')).packs.old, undefined);
  assert.equal(t.app.backupState().packs.old.states.progress, 3, '기기 청소가 서버 백업의 이전 진도를 지우면 안 된다');
  t.app.S.data.packs.new = { states: { progress: 5 } };
  t.app.selectPack('old');
  assert.equal(t.app.S.data.packs.old.states.progress, 3, '되돌아온 단원의 진도를 복원한다');
  assert.equal(JSON.parse(t.storage.get('wbk.v1')).packs.new, undefined);
  assert.equal(t.app.backupState().packs.new.states.progress, 5);
  t.app.S.token = 'synthetic-test-token';
  t.app.persist(); t.app.flush();
  assert.equal(JSON.parse(t.calls[0].opts.body).state.packs.new.states.progress, 5, '실제 백업 요청에도 이전 진도가 들어간다');

  t = setup();
  t.app.S.token = 'synthetic-test-token';
  t.app.S.data.savedAt = 20;
  t.env.fetch = function (url) {
    const data = url.endsWith('/state') ? { state: { v: 1, packs: { remote: { states: { progress: 7 } } }, savedAt: 10 } } : {};
    return Promise.resolve({ status: 200, json() { return Promise.resolve(data); } });
  };
  await t.app.online();
  assert.equal(t.app.backupState().packs.remote.states.progress, 7, '기기 기록이 더 최신이어도 다른 단원의 서버 진도는 보존한다');
  assert.equal(JSON.parse(t.storage.get('wbk.v1')).packs.remote.states.progress, 7, '백업 미확인 상태에서는 원본을 기기에 유지한다');

  t = setup();
  t.app.S.token = 'synthetic-test-token'; t.app.persist(); t.app.selectPack('new');
  const local = t.storage.get('wbk.v1');
  t.app.S.session = { kind: 'blank' };
  t.nodes.get('wrap').innerHTML = '진행 중 문제와 입력';
  t.env.fetch = function () { return Promise.resolve({ status: 400, json() { return Promise.resolve({ error: '형식 오류 — 기록 보존' }); } }); };
  await t.app.push();
  assert.equal(t.nodes.get('backupNotice').textContent, '형식 오류 — 기록 보존', '학습 세션에서도 저장 거절이 바로 보여야 한다');
  assert.equal(t.nodes.get('backupNotice').hidden, false);
  assert.equal(t.env.redraws || 0, 0, '오류를 알리면서 문제·입력 화면을 다시 그리지 않는다');
  assert.equal(t.nodes.get('wrap').innerHTML, '진행 중 문제와 입력');
  assert.equal(t.app.S.backupSavedAt, 10);
  assert.equal(t.storage.get('wbk.v1'), local);
  t.env.fetch = function () { return Promise.resolve({ status: 200, json() { return Promise.resolve({}); } }); };
  await t.app.push();
  assert.equal(t.nodes.get('backupNotice').hidden, true, '실제 백업 성공 뒤에만 저장 오류 안내를 해제한다');

  t = setup();
  t.app.S.token = 'synthetic-test-token'; t.app.persist();
  const original = t.storage.get('wbk.v1');
  let resolveSave;
  t.env.fetch = function (url, opts) {
    t.calls.push({ url, opts });
    if (opts && opts.method === 'PUT') return new Promise(resolve => { resolveSave = resolve; });
    const status = url.endsWith('/state') ? 409 : 200;
    return Promise.resolve({ status, json() { return Promise.resolve(status === 409 ? { error: '서버 백업 확인' } : {}); } });
  };
  const oldSave = t.app.push();
  await t.app.online();
  assert.equal(t.app.S.backupBlocked, true);
  assert.equal(t.nodes.get('backupNotice').textContent, '서버 백업 확인');
  assert.equal(t.nodes.get('backupNotice').hidden, false);
  resolveSave({ status: 200, json() { return Promise.resolve({}); } });
  await oldSave;
  assert.equal(t.app.S.backupSavedAt, 10, '늦은 저장 성공 응답도 백업 확인 대기를 풀거나 기기 원본을 줄이지 않는다');
  assert.equal(t.nodes.get('backupNotice').textContent, '서버 백업 확인');
  t.app.S.demo = false; // 늦게 도착한 팩도 백업 보류를 풀 수 없다.
  await t.app.push(); t.app.flush(); await t.nodes.get('clearDevice').onclick();
  assert.equal(t.calls.filter(c => c.opts && c.opts.method === 'PUT').length, 1, '409를 확인한 뒤에는 추가로 서버 원본을 덮어쓰지 않는다');
  assert.equal(t.storage.get('wbk.v1'), original, '서버 확인 전 유일한 기기 진도를 지웠다');
  assert.equal(t.storage.get('wbr.auth'), 'other-app-login');
  assert.ok(t.calls.some(c => c.alert));
  assert.ok(!t.calls.some(c => c.redirect));

  t = setup();
  t.env.confirm = function () { return false; };
  t.storage.set('wbk.v1', 'original');
  await t.nodes.get('clearDevice').onclick();
  assert.equal(t.storage.get('wbk.v1'), 'original');
  assert.equal(t.calls.length, 0);

  t.env.confirm = function () { return true; };
  t.env.localStorage.removeItem = function () { throw new Error('storage unavailable'); };
  await t.nodes.get('clearDevice').onclick();
  assert.equal(t.storage.get('wbk.v1'), 'original');
  assert.ok(t.calls[0].alert);
  assert.ok(!t.calls.some((c) => c.redirect));

  t = setup();
  t.storage.set('wbk.v1', 'original');
  t.app.S.token = 'synthetic-test-token';
  let resolvePack;
  t.env.fetch = function () { return new Promise((resolve) => { resolvePack = resolve; }); };
  const pending = t.app.loadPack('late', true);
  await t.nodes.get('clearDevice').onclick();
  assert.equal(t.storage.has('wbk.v1'), false);
  assert.equal(t.storage.get('wbr.auth'), 'other-app-login');
  assert.deepEqual(t.calls, [{ redirect: '/' }]);
  resolvePack({ status: 200, json() { return Promise.resolve({ pack: { works: [] } }); } });
  await pending;
  t.app.persist(); t.app.selectPack('late'); t.app.push(); t.app.flush();
  assert.equal(t.storage.has('wbk.v1'), false, '늦게 온 응답·저장이 지운 칸을 다시 만들면 안 된다');
  assert.equal(t.timers.size, 0);
  assert.equal(t.app.S.packId, 'old');

  t = setup();
  t.app.S.token = 'synthetic-test-token';
  t.app.persist();
  t.app.selectPack('new');
  assert.equal(JSON.parse(t.storage.get('wbk.v1')).packs.old.states.progress, 3, '미저장 단원의 원본은 연결이 끊겨도 남는다');
  t.env.fetch = function () { return Promise.resolve({ status: 503, json() { return Promise.resolve({}); } }); };
  await t.app.push();
  assert.ok(JSON.parse(t.storage.get('wbk.v1')).packs.old);
  await t.nodes.get('clearDevice').onclick();
  assert.ok(t.storage.has('wbk.v1'), '서버가 못 받은 답안을 기기 청소로 지우지 않는다');
  assert.ok(t.calls.some((c) => c.alert));
  assert.ok(!t.calls.some((c) => c.redirect));
  t.env.fetch = function () { return Promise.resolve({ status: 200, json() { return Promise.resolve({}); } }); };
  await t.app.push();
  assert.equal(JSON.parse(t.storage.get('wbk.v1')).packs.old, undefined, '백업 확인 뒤 이전 단원 칸을 비운다');

  t = setup();
  t.app.S.token = 'synthetic-test-token';
  t.app.persist();
  await t.nodes.get('clearDevice').onclick();
  assert.equal(t.calls.filter((c) => c.url).length, 1, '3초 안에 지우더라도 최근 답안을 먼저 보관한다');
  assert.equal(t.storage.has('wbk.v1'), false);
  assert.ok(t.calls.some((c) => c.redirect));
  console.log('OK — 단원 기기 청소·서버 진도 보존·취소·저장 실패·늦은 응답 통과');
})().catch((err) => { console.error(err); process.exitCode = 1; });
