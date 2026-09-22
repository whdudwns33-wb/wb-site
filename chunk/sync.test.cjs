'use strict';
/* 실제 학생 앱의 저장 코드를 실행한다. 운영 계정·망 없이 계정 전환과 늦은 응답을 재현한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const R = require('./rules.js'), SC = require('./sched.js');
const html = fs.readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8');
const source = html.slice(html.indexOf('    const R = WBCHUNK,'), html.indexOf('    /* ── 화면 상태 ── */'));
const loginSource = html.slice(html.indexOf('    let poll = null,'), html.indexOf('    function copyRecord()'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const auth = (code) => ({ code, token: code });
const state = (id, at = 1000) => { const s = SC.blank(at); s.band = 'G3'; if (id) SC.record(s, id, { band: 'G3', score: 90 }, at); return s; };
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => clone(body) });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function app({ code = 'stu-a', family, local = new Map(), records = {}, fetchHook } = {}) {
  if (code) local.set('wbr.auth', JSON.stringify(auth(code)));
  const nodes = {}, calls = [], timers = new Map(); let serial = 0, offline = false;
  const context = vm.createContext({
    WBCHUNK: R, WBCHUNK_SCHED: SC, WBCHUNK_LESSONS: [], WBCHUNK_PASSAGES: [],
    localStorage: { getItem: (k) => local.get(k) || null, setItem: (k, v) => local.set(k, v), removeItem: (k) => local.delete(k) },
    document: { getElementById: (id) => nodes[id] || (nodes[id] = {}) },
    location: { search: family ? '?t=' + family : '' }, navigator: { platform: 'test' }, URLSearchParams, Date,
    setTimeout: (f) => { timers.set(++serial, f); return serial; }, clearTimeout: (id) => timers.delete(id),
    fetch: async (url, opt) => {
      const request = { url, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : null };
      calls.push(request);
      if (offline) throw new Error('offline');
      if (fetchHook) { const value = fetchHook(request); if (value) return value; }
      if (!url.includes('/state')) return response({ custom: [], assign: null });
      const owner = url.includes('/parent/') ? new URLSearchParams(url.split('?')[1]).get('t') : opt.headers.Authorization.slice(7);
      const rec = records[owner] || { state: null, updatedAt: null };
      if (request.method === 'GET') return response(rec);
      if (request.body.baseUpdatedAt !== rec.updatedAt) return response({ error: 'conflict' }, 409);
      records[owner] = { state: request.body.state, updatedAt: 'v' + (++serial) };
      return response({ ok: true, updatedAt: records[owner].updatedAt });
    },
  });
  const api = vm.runInContext(source + loginSource + `
    let sess = null, view = {};
    function recRelease() {} function stopSpeak() {} function applyBody() {} function render() {} function announce() {}
    ({ get state() { return S; }, get meta() { return sync; }, get key() { return stateKey; },
       save, pullState, refreshAccount, changeAccount, link,
       setAuth(a) { saveAuth(a); changeAccount(); }, setFamily(f) { saveFam(f); changeAccount(); } });`, context);
  return { api, local, records, calls, timers, nodes, offline: (v) => { offline = v; }, flush: () => new Promise(setImmediate) };
}

(async () => {
  const legacy = state('old-student');
  const local = new Map([['wbc.state', JSON.stringify(legacy)]]);
  const a = app({ code: 'stu-b', local });
  await a.api.refreshAccount();
  assert.equal(a.api.state.log.length, 0, '새 학생은 소유자 불명 공용 기록을 이어받지 않는다');
  assert.equal(a.calls.filter((c) => c.method === 'PUT').length, 0);
  assert.equal(JSON.parse(local.get('wbc.state')).log[0].id, 'old-student', '이전 원본은 남긴다');

  const family = 'family1234567890abcdef';
  const b = app({ family, records: { [family]: { state: state('center'), updatedAt: 'v1' } } });
  await b.api.refreshAccount();
  SC.record(b.api.state, 'home', { score: 90, band: 'G3' }, 2000); b.api.save();
  b.offline(true); await b.api.pullState();
  assert.equal(b.api.meta.dirty, true);
  assert.notEqual(b.nodes.savetxt.textContent, '저장됨');
  const reopened = app({ family, local: b.local, records: b.records });
  await reopened.api.refreshAccount();
  assert.deepEqual(reopened.records[family].state.log.map((x) => x.id), ['center', 'home']);
  assert.equal(reopened.api.meta.dirty, false);
  assert.equal(reopened.nodes.savetxt.textContent, '저장됨');
  assert.ok(reopened.calls.some((c) => c.method === 'PUT' && c.url.startsWith('/api/chunk/parent/state?t=')), '가족 전용 경로 유지');

  SC.record(reopened.api.state, 'local-next', { score: 90, band: 'G3' }, 3000); reopened.api.save();
  reopened.records[family] = { state: state('other-device', 4000), updatedAt: 'remote-new' };
  const putCount = reopened.calls.filter((c) => c.method === 'PUT').length;
  await reopened.api.pullState();
  assert.equal(reopened.calls.filter((c) => c.method === 'PUT').length, putCount);
  assert.equal(reopened.api.state.log.at(-1).id, 'local-next');
  assert.equal(reopened.records[family].state.log[0].id, 'other-device');
  assert.equal(reopened.api.meta.dirty, true);
  assert.equal(reopened.nodes.savetxt.textContent, '기록 확인 필요');

  const lost = app(); await lost.api.pullState();
  SC.record(lost.api.state, 'saved-but-no-response', { score: 90, band: 'G3' }, 2000); lost.api.save();
  lost.records['stu-a'] = { state: clone(lost.api.state), updatedAt: 'reply-lost' };
  await lost.api.pullState();
  assert.equal(lost.api.meta.base, 'reply-lost'); assert.equal(lost.api.meta.dirty, false);
  assert.equal(lost.nodes.savetxt.textContent, '저장됨', 'PUT 응답 유실도 동일 기록을 GET하면 복구한다');

  const writing = deferred(); let firstPut = true;
  const during = app({ fetchHook: (req) => {
    if (req.method !== 'PUT' || !firstPut) return null;
    firstPut = false; during.records['stu-a'] = { state: clone(req.body.state), updatedAt: 'first-put' };
    return writing.promise;
  } });
  await during.api.pullState(); SC.record(during.api.state, 'before-send', { score: 90, band: 'G3' }, 1000); during.api.save();
  const inFlight = during.api.pullState(); await during.flush();
  SC.record(during.api.state, 'while-sending', { score: 90, band: 'G3' }, 2000); during.api.save();
  writing.resolve(response({ ok: true, updatedAt: 'first-put' })); await inFlight;
  assert.equal(during.api.meta.dirty, true); assert.ok(during.timers.size > 0, 'PUT 중 새 학습은 다시 저장 예약');
  await during.api.pullState();
  assert.deepEqual(during.records['stu-a'].state.log.map((x) => x.id), ['before-send', 'while-sending']);
  assert.equal(during.api.meta.dirty, false);

  const get = deferred(); let delayed = true;
  const c = app({ fetchHook: (req) => req.url === '/api/chunk/state' && delayed ? (delayed = false, get.promise) : null });
  const pendingGet = c.api.pullState();
  c.api.setAuth(auth('stu-b')); await c.flush();
  get.resolve(response({ state: state('student-a'), updatedAt: 'old' })); await pendingGet;
  assert.equal(c.api.key, 'wbc.state:stu:stu-b');
  assert.equal(c.api.state.log.length, 0, '이전 학생의 늦은 GET 응답을 버린다');

  const put = deferred();
  const d = app({ fetchHook: (req) => req.method === 'PUT' ? put.promise : null });
  await d.api.pullState(); SC.record(d.api.state, 'a-only', { score: 90, band: 'G3' }, 1000); d.api.save();
  const pendingPut = d.api.pullState(); await d.flush();
  d.api.setAuth(auth('stu-b')); await d.flush();
  put.resolve(response({ ok: true, updatedAt: 'a-version' })); await pendingPut;
  assert.equal(d.api.meta.base, null, '이전 계정의 PUT 완료가 새 계정 동기화 기준을 바꾸지 않는다');
  assert.equal(d.api.state.log.length, 0);
  assert.equal(d.timers.size, 0, '계정 전환 때 예약 저장 취소');
  assert.equal(JSON.parse(d.local.get('wbc.state:stu:stu-a')).log[0].id, 'a-only');

  const e = app({ family, records: { [family]: { state: state('first-child'), updatedAt: 'v1' } } });
  await e.api.pullState(); e.api.setFamily({ t: 'another1234567890abcdef' }); await e.flush();
  assert.equal(e.api.state.log.length, 0, '가족 링크 전환도 이전 자녀 기록을 올리지 않는다');
  assert.equal(e.calls.filter((x) => x.method === 'PUT').length, 0);

  const approval = deferred();
  const f = app({ fetchHook: (req) => req.url === '/api/login' ? response({ nonce: 'n1' }) : req.url.startsWith('/api/login/status') ? approval.promise : null });
  f.api.link('stu-a'); await f.flush();
  const tick = [...f.timers.values()][0]; tick(); await f.flush();
  f.api.setAuth(auth('stu-b')); await f.flush();
  approval.resolve(response({ token: 'stu-a', student: { code: 'stu-a' } })); await f.flush();
  assert.equal(JSON.parse(f.local.get('wbr.auth')).code, 'stu-b', '늦은 로그인 승인도 계정을 되돌리지 않는다');
  console.log('OK — 학생/가족 기록 격리 · 오프라인 재시도 · 충돌 보존 · 늦은 계정 응답');
})().catch((e) => { console.error(e); process.exitCode = 1; });
