'use strict';
/* 관리 화면의 실제 인라인 함수를 작은 DOM·가짜 API로 실행한다. 운영 서버·AI·푸시는 부르지 않는다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('./letter.js');
const SAMPLE = require('./issue-sample.json');
const DEFAULT_CAL = require('./calendar.json');
const html = fs.readFileSync(path.join(__dirname, '../reading-server/public/letter-admin.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness(reply) {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: id === '#e_tier' ? 'E2' : '', innerHTML: '', textContent: '' });
    return nodes.get(id);
  };
  const document = {
    getElementById: (id) => node('#' + id), querySelector: node,
    querySelectorAll: (selector) => {
      if (selector !== 'tr[data-week]') return [];
      return [...node('#main').innerHTML.matchAll(/<tr data-week="([^"]+)">([\s\S]*?)<\/tr>/g)].map((m) => ({
        dataset: { week: m[1] },
        querySelector: (s) => {
          const field = s.match(/data-f="([^"]+)"/)[1];
          const input = m[2].match(new RegExp('<input data-f="' + field + '" value="([^"]*)"'));
          if (input) return { value: input[1] };
          const select = m[2].match(new RegExp('<select data-f="' + field + '">([\\s\\S]*?)</select>'));
          const selected = select && select[1].match(/<option value="([^"]*)" selected/);
          return { value: selected ? selected[1] : '' };
        },
      }));
    },
  };
  const context = vm.createContext({
    document, WBLETTER: L, WBAdminLogin: { mount() {} }, localStorage: { getItem: () => null },
    confirm: () => true, alert() {}, setTimeout: () => 0, clearTimeout() {},
    fetch: async (url, opt = {}) => {
      const call = { url, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : null };
      calls.push(call);
      const value = await reply(call);
      return { ok: true, status: 200, json: async () => value };
    },
  });
  vm.runInContext(script + '\n;globalThis.ui={edit,calendar,issues,creditOf,pushSummary,setEdit:v=>{EDIT=v;},getEdit:()=>EDIT};', context);
  return { ui: context.ui, node, calls };
}

(async () => {
  assert.doesNotThrow(() => new Function(script), '인라인 스크립트 파싱');
  let issue = { ...clone(SAMPLE), status: 'draft' };
  let rejectPublish = false;
  const editor = harness(({ url, method, body }) => {
    if (url === '/api/letter/admin/issue' && method === 'PUT') {
      issue = clone(body.issue);
      return { id: issue.id, status: issue.status, warnings: [] };
    }
    assert.equal(url, '/api/letter/admin/publish');
    if (rejectPublish) throw new Error('발행 실패');
    issue.status = body.status;
    return { id: issue.id, status: issue.status, visible: true, push: { sent: 0, failed: 1 } };
  });
  editor.ui.setEdit({ text: JSON.stringify(issue), id: issue.id, dirty: true });
  await editor.ui.edit();
  await editor.node('#e_save').onclick();
  assert.equal(issue.status, 'draft'); assert.equal(editor.calls.length, 1, '일반 저장은 발행 API를 부르지 않는다');
  await editor.node('#e_savepub').onclick();
  assert.deepEqual(editor.calls.slice(1).map((c) => [c.method, c.url]), [['PUT', '/api/letter/admin/issue'], ['POST', '/api/letter/admin/publish']]);
  assert.equal(editor.calls[1].body.issue.status, 'draft', '먼저 초안 그대로 저장한다');
  assert.equal(JSON.parse(editor.ui.getEdit().text).status, 'published');
  assert.match(editor.node('#e_msg').innerHTML, /실패 1건/);
  rejectPublish = true;
  editor.ui.setEdit({ text: JSON.stringify({ ...issue, status: 'draft' }), id: issue.id, dirty: true });
  await editor.ui.edit(); await editor.node('#e_savepub').onclick();
  assert.equal(JSON.parse(editor.ui.getEdit().text).status, 'draft');
  assert.match(editor.node('#e_msg').innerHTML, /내용은 저장됐지만 발행을 마치지 못했어요/);

  const savedCal = clone(DEFAULT_CAL); savedCal.weeks['2026-W40'].theme = 'CUSTOM_SAVED_THEME';
  let written = null;
  const calendar = harness(({ url, method, body }) => {
    if (url === '/letter/calendar.json') return clone(DEFAULT_CAL);
    if (url === '/api/letter/admin/issues') return { issues: [] };
    assert.equal(url, '/api/letter/admin/calendar');
    if (method === 'PUT') { written = body.calendar; return { updatedAt: '2026-09-22T01:00:00Z' }; }
    return { calendar: clone(savedCal), source: 'kv' };
  });
  await calendar.ui.calendar();
  assert.match(calendar.node('#main').innerHTML, /CUSTOM_SAVED_THEME/);
  await calendar.node('#c_reset').onclick();
  assert.ok(!calendar.node('#main').innerHTML.includes('CUSTOM_SAVED_THEME'));
  assert.ok(calendar.node('#main').innerHTML.includes(L.esc(DEFAULT_CAL.weeks['2026-W40'].theme)));
  assert.equal(written, null, '기본값 복원만으로 서버 저장하지 않는다');
  await calendar.node('#c_save').onclick();
  assert.equal(written.weeks['2026-W40'].theme, DEFAULT_CAL.weeks['2026-W40'].theme, '저장 버튼은 화면의 기본값을 저장한다');

  const photo = { id: 'a'.repeat(32), alt: '자체 제작 테스트 그림', credit: editor.ui.creditOf({ src: 'upload' }) };
  assert.equal(photo.credit, '', '일반 업로드의 출처를 추측하지 않는다');
  assert.ok(L.checkIssue({ ...clone(SAMPLE), cover: photo }).errors.some((e) => e.where === 'cover' && e.msg.includes('credit')));
  photo.credit = 'WB 편집실 · 자체 제작';
  assert.equal(L.checkIssue({ ...clone(SAMPLE), cover: photo }).errors.length, 0, '출처를 적으면 기존 검증을 통과한다');
  assert.equal(editor.ui.creditOf({ src: 'ai' }), 'WB 편집실 · AI 생성');
  const listing = harness(({ url }) => {
    if (url.endsWith('/calendar')) return { calendar: clone(DEFAULT_CAL), source: 'default' };
    if (url.endsWith('/push/status')) return { subscribers: 1, byKind: { student: 1, family: 0 }, vapid: true };
    return { today: '2026-09-22', issues: [{ ...L.brief(SAMPLE), visible: true, opened: 0, pushedAt: '2026-09-22', pushResult: { sent: 0, failed: 1 } }] };
  });
  await listing.ui.issues();
  assert.match(listing.node('#main').innerHTML, /알림 성공 0건 · 실패 1건/);
  assert.match(listing.node('#main').innerHTML, />알림 다시<\/button>/, '비동기 발송 결과에서도 기존 다시 보내기를 찾을 수 있다');
  console.log('admin-ui: 발행 경로·실패 안내·달력 복원/저장·출처 검증 통과');
})().catch((error) => { console.error(error); process.exitCode = 1; });
