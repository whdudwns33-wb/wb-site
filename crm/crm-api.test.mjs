// node crm/crm-api.test.mjs — crm-api.mjs 를 node:sqlite 대역 위에서 직접 호출한다(desk/worker.test.mjs 와 같은 방식).
// HubSpot 은 env.HUBSPOT_FETCH 에 가짜 fetch 를 넣어 흉내 낸다 — 망을 타지 않고 토큰은 'pat-test' 자리표시.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { handleApi, flushQueue } from './crm-api.mjs';
import worker from './worker.mjs';

const migrationDir = new URL('./migrations/', import.meta.url);
const migration = fs.readdirSync(migrationDir).filter(n => n.endsWith('.sql')).sort().map(n => fs.readFileSync(new URL(n, migrationDir), 'utf8')).join('\n');
const BASE = 'https://crm.test';
const PASSWORD = 'crm-password-1';

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  async run() { return this.runSync(); }
  runSync() { const r = this.database.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes || 0) } }; }
}
class TestD1 {
  constructor() { this.database = new DatabaseSync(':memory:'); this.database.exec(migration); this.database.exec(migration); }
  prepare(sql) { return new Statement(this.database, sql); }
  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try { const r = statements.map(s => s.runSync()); this.database.exec('COMMIT'); return r; }
    catch (e) { this.database.exec('ROLLBACK'); throw e; }
  }
}

/** HubSpot 가짜 — 경로별 응답. calls 에 요청이 쌓인다. */
function fakeHubspot(overrides) {
  const calls = [];
  const state = { nextId: 1000 };
  const routes = Object.assign({
    'GET /account-info/v3/details': () => ({ portalId: 245, uiDomain: 'app-na2.hubspot.com', timeZone: 'Asia/Seoul' }),
    'GET /crm/v3/pipelines/deals': () => ({ results: [
      { id: 'default', label: '검사 여정', displayOrder: 0, stages: [
        { id: 'appointmentscheduled', label: '신규문의', displayOrder: 0 }, { id: 'qualifiedtobuy', label: '연락완료', displayOrder: 1 },
        { id: 'presentationscheduled', label: '예약확정', displayOrder: 2 }, { id: 'decisionmakerboughtin', label: '검사완료', displayOrder: 3 },
        { id: 'contractsent', label: '해석완료', displayOrder: 4 }, { id: 'closedwon', label: '성사된 거래', displayOrder: 5 },
        { id: '3551668965', label: '업셀제안', displayOrder: 6 }, { id: 'closedlost', label: '성사되지 않은 거래', displayOrder: 7 }] },
      { id: '2206970568', label: '학원 등록', displayOrder: 1, stages: [
        { id: 'a1', label: '트라이얼', displayOrder: 0 }, { id: 'a2', label: '트라이얼검토', displayOrder: 1 }, { id: 'a3', label: '활성', displayOrder: 2 },
        { id: 'a4', label: '이탈위험', displayOrder: 3 }, { id: 'a5', label: '이탈', displayOrder: 4 }, { id: 'a6', label: '성사된 거래', displayOrder: 5 }, { id: 'a7', label: '성사되지 않은 거래', displayOrder: 6 }] }
    ] }),
    'GET /crm/v3/properties/contacts': () => ({ results: ['wb_source_channel', 'wb_academy_status', 'wb_credit_balance', 'wb_referrer_contact_id', 'wb_retest_due_date', 'wb_risk_signals'].map(n => ({ name: n })) }),
    'POST /crm/v3/properties/contacts': c => ({ name: c.body.name }),
    'POST /crm/v3/objects/contacts/search': () => ({ total: 0, results: [] }),
    'POST /crm/v3/objects/contacts': c => ({ id: String(++state.nextId), properties: c.body.properties }),
    'PATCH /crm/v3/objects/contacts/*': c => ({ id: c.path.split('/').pop(), properties: c.body.properties }),
    'POST /crm/v3/objects/deals': c => ({ id: 'd' + (++state.nextId), properties: c.body.properties }),
    'PATCH /crm/v3/objects/deals/*': c => ({ id: c.path.split('/').pop(), properties: c.body.properties }),
    'POST /crm/v3/objects/notes': () => ({ id: 'n' + (++state.nextId) }),
    'POST /crm/v4/associations/contacts/deals/batch/read': () => ({ results: [] }),
    'POST /crm/v3/objects/deals/batch/read': () => ({ results: [] })
  }, overrides || {});
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const call = { method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization };
    calls.push(call);
    const exact = routes[init.method + ' ' + u.pathname];
    const wild = Object.keys(routes).find(k => k.endsWith('/*') && (init.method + ' ' + u.pathname).startsWith(k.slice(0, -1)));
    const handler = exact || (wild ? routes[wild] : null);
    if (!handler) return new Response(JSON.stringify({ message: 'no route ' + init.method + ' ' + u.pathname }), { status: 404 });
    const out = await handler(call, u);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls, routes, state };
}

function envFor(hs) {
  const env = { DB: new TestD1() };
  if (hs) { env.HUBSPOT_ACCESS_TOKEN = 'pat-test'; env.HUBSPOT_FETCH = hs.fetchImpl; }
  return env;
}
async function call(env, method, path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = 'Bearer ' + options.token;
  const response = await handleApi(new Request(BASE + path, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }), env, {});
  return { status: response.status, headers: response.headers, body: await response.json() };
}
async function setupAdmin(env) {
  const r = await call(env, 'POST', '/api/setup', { body: { password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
async function makeStaff(env, adminToken, name) {
  const created = await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'create', name } });
  const link = await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'link', staffId: created.body.staff.id } });
  const ex = await call(env, 'POST', '/api/link-exchange', { body: { code: link.body.code } });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  return { id: created.body.staff.id, token: ex.body.token };
}
async function putDoc(env, token, c, id, data, extra = {}) {
  return call(env, 'POST', '/api/docs', { token, body: { changes: [Object.assign({ c, id, data }, extra)] } });
}
function lead(overrides) {
  return Object.assign({ name: '보호자A', relation: '모', phone: '010-0000-0000', channel: '맘카페', child: { name: '아이', grade: '초3' }, pipeline: 'inspection', stage: 'inquiry', source: '맘카페 보고 연락', memo: '' }, overrides || {});
}
async function queue(env, token, q) { return (await call(env, 'GET', '/api/hubspot/queue' + (q || ''), { token })).body; }
async function saveMapping(env, token, hs) {
  const p = await call(env, 'GET', '/api/hubspot/pipelines', { token });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const r = await putDoc(env, token, 'settings', 'main', { orgName: 'WB', hubspot: { enabled: true, autoApproveQuick: false, map: p.body.suggested } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return p.body.suggested;
}

test('마이그레이션은 멱등이고 표·인덱스를 만든다 · 워커는 /api 만 코드로 받는다', async () => {
  const db = new TestD1();
  const names = db.database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'crm_%' OR name LIKE 'idx_crm%' ORDER BY name").all().map(r => r.name);
  for (const n of ['crm_admin', 'crm_staff', 'crm_codes', 'crm_tokens', 'crm_documents', 'crm_hs_links', 'crm_sync_queue', 'crm_kv', 'idx_crm_sync_queue_status']) assert.ok(names.includes(n), n);
  const env = { DB: db, ASSETS: { fetch: async () => new Response('asset', { status: 200 }) } };
  assert.equal(await (await worker.fetch(new Request(BASE + '/index.html'), env, {})).text(), 'asset');
  const api = await worker.fetch(new Request(BASE + '/api/health'), env, {});
  assert.equal((await api.json()).app, 'wb-crm');
  // 토큰이 없으면 크론은 아무것도 하지 않는다
  let waited = false;
  await worker.scheduled({}, env, { waitUntil: () => { waited = true; } });
  assert.equal(waited, false);
});

test('health → setup → login 실패·잠금, 직원 링크 교환은 1회, /api/me', async () => {
  const env = envFor();
  const h = await call(env, 'GET', '/api/health');
  assert.deepEqual([h.body.ok, h.body.setup, h.body.hubspot], [true, false, false]);
  assert.equal((await call(env, 'POST', '/api/setup', { body: { password: 'short' } })).status, 400);
  const admin = await setupAdmin(env);
  assert.equal((await call(env, 'POST', '/api/setup', { body: { password: PASSWORD } })).status, 409);
  assert.equal((await call(env, 'POST', '/api/login', { body: { password: 'wrong-password' } })).status, 401);
  for (let i = 0; i < 4; i++) await call(env, 'POST', '/api/login', { body: { password: 'wrong-password' } });
  assert.equal((await call(env, 'POST', '/api/login', { body: { password: PASSWORD } })).status, 429);
  const me = await call(env, 'GET', '/api/me', { token: admin });
  assert.deepEqual([me.body.role, me.body.staffId], ['admin', 'admin']);
  const wrongCur = await call(env, 'POST', '/api/password', { token: admin, body: { password: 'nope-nope-nope', newPassword: 'crm-password-2' } });
  assert.deepEqual([wrongCur.status, wrongCur.body.code], [403, 'LOGIN_FAILED'], '401 이면 클라이언트가 세션을 버린다');
  assert.equal((await call(env, 'GET', '/api/me', { token: admin })).status, 200, '토큰은 그대로다');
  const staff = await makeStaff(env, admin, '실장A');
  const me2 = await call(env, 'GET', '/api/me', { token: staff.token });
  assert.deepEqual([me2.body.role, me2.body.name], ['staff', '실장A']);
  assert.equal((await call(env, 'GET', '/api/docs')).status, 401);
  assert.equal((await call(env, 'POST', '/api/staff', { token: staff.token, body: { op: 'create', name: 'x' } })).status, 403);
});

test('리드 문서 — 검증·정규화, 전화는 전화 칸에만(PII), hubspot 필드는 서버 소유, 삭제는 원장만', async () => {
  const env = envFor();
  const admin = await setupAdmin(env);
  const staff = await makeStaff(env, admin, '실장A');
  const ok = await putDoc(env, staff.token, 'leads', 'l1', lead({ phone: '01000000000', hubspot: { contactId: 'FAKE' } }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const docs = (await call(env, 'GET', '/api/docs', { token: staff.token })).body.docs;
  const l1 = docs.find(d => d.c === 'leads' && d.id === 'l1');
  assert.deepEqual([l1.data.phone, l1.data.status, l1.data.owner, l1.data.hubspot], ['010-0000-0000', 'open', staff.id, {}]);
  assert.ok(docs.some(d => d.c === 'staff' && d.id === staff.id), '직원 명단이 문서로 함께 내려온다');
  const pii = await putDoc(env, staff.token, 'leads', 'l1', lead({ memo: '엄마 번호 010-1234-5678' }));
  assert.deepEqual([pii.status, pii.body.code], [400, 'PII']);
  assert.equal((await putDoc(env, staff.token, 'leads', 'l1', lead({ hubspot: { contactId: '1234561234567', deals: { inspection: { dealId: '9012341234567' } } } }))).status, 200, '서버 소유 hubspot 필드의 숫자열은 PII 검사 대상이 아니다');
  assert.equal((await putDoc(env, staff.token, 'leads', 'l1', lead({ name: '' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, staff.token, 'leads', 'l1', {}, { deleted: true })).status, 403);
  assert.equal((await putDoc(env, admin, 'leads', 'l1', {}, { deleted: true })).status, 200);
  assert.equal((await putDoc(env, admin, 'leads', 'bad id!', lead())).body.code, 'INVALID');
  assert.equal((await putDoc(env, admin, 'nope', 'x', {})).body.code, 'INVALID');
  // 낙관적 잠금
  await putDoc(env, admin, 'leads', 'l2', lead());
  const stale = await putDoc(env, admin, 'leads', 'l2', lead({ name: 'B' }), { expectedUpdatedAt: 1 });
  assert.deepEqual([stale.status, stale.body.code], [409, 'STALE']);
  assert.ok(stale.body.results[0].current.data.name === '보호자A');
});

test('단계가 바뀌면 stageAt 은 서버가 오늘로 찍고, 안 바뀌면 이전 값을 지킨다', async () => {
  const env = envFor();
  const admin = await setupAdmin(env);
  await putDoc(env, admin, 'leads', 'l1', lead({ stageAt: '2026-01-01' }));
  let d = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs.find(x => x.id === 'l1').data;
  assert.equal(d.stageAt, '2026-01-01', '새 리드는 클라이언트가 보낸 날짜(백필)를 받는다');
  await putDoc(env, admin, 'leads', 'l1', lead({ stageAt: '2025-01-01', memo: '메모만' }));
  d = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs.find(x => x.id === 'l1').data;
  assert.equal(d.stageAt, '2026-01-01');
  await putDoc(env, admin, 'leads', 'l1', lead({ stage: 'booked', stageAt: '2025-01-01' }));
  d = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs.find(x => x.id === 'l1').data;
  assert.match(d.stageAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(d.stageAt, '2025-01-01');
});

test('기록·크레딧은 append-only, 크레딧·설정은 원장만, 설정은 정규화된다', async () => {
  const env = envFor();
  const admin = await setupAdmin(env);
  const staff = await makeStaff(env, admin, '실장A');
  await putDoc(env, staff.token, 'leads', 'l1', lead());
  const a = await putDoc(env, staff.token, 'activities', 'a1', { leadId: 'l1', type: 'consult', text: '상담 메모', result: 'reached' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal((await putDoc(env, staff.token, 'activities', 'a1', { leadId: 'l1', type: 'consult', text: '고침' })).body.code, 'APPEND_ONLY');
  assert.equal((await putDoc(env, staff.token, 'activities', 'a2', { leadId: 'l1', type: 'note', text: '연락처 010-1111-2222' })).body.code, 'PII');
  assert.equal((await putDoc(env, staff.token, 'activities', 'a3', { leadId: 'l1', type: 'note', text: '' })).body.code, 'INVALID');
  assert.equal((await putDoc(env, admin, 'activities', 'a1', {}, { deleted: true })).body.code, 'APPEND_ONLY');
  const act = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs.find(x => x.id === 'a1').data;
  assert.equal(act.by, staff.id, '기록자는 토큰 신원으로 고정');
  assert.equal((await putDoc(env, staff.token, 'credits', 'c1', { leadId: 'l1', type: 'accrue', amount: 15000 })).status, 403);
  assert.equal((await putDoc(env, admin, 'credits', 'c1', { leadId: 'l1', type: 'accrue', amount: 15000 })).status, 200);
  assert.equal((await putDoc(env, admin, 'credits', 'c1', { leadId: 'l1', type: 'accrue', amount: 1 })).body.code, 'APPEND_ONLY');
  assert.equal((await putDoc(env, staff.token, 'settings', 'main', { orgName: 'x' })).status, 403);
  assert.equal((await putDoc(env, admin, 'settings', 'other', { orgName: 'x' })).body.code, 'INVALID');
  const s = await putDoc(env, admin, 'settings', 'main', { orgName: ' WB센터 ', followupOffsets: [7, 3, 3, 99, 'x'], hubspot: { autoApproveQuick: 'yes', portal: { portalId: 'FAKE' }, map: { inspection: { pipelineId: 'default', stageMap: { inquiry: 'appointmentscheduled', bogus: 'x', won: 'bad id!' } } } } });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const settings = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs.find(x => x.c === 'settings').data;
  assert.deepEqual([settings.orgName, settings.followupOffsets, settings.hubspot.autoApproveQuick, settings.hubspot.portal], ['WB센터', [3, 7], true, {}]);
  assert.deepEqual(settings.hubspot.map.inspection.stageMap, { inquiry: 'appointmentscheduled' });
});

test('반영 큐 — 리드 생성은 contact(quick)+deal(quick), 단계 전이는 deal(review)로 합쳐지고, 기록은 note, 승인 작업은 원장만', async () => {
  const env = envFor();
  const admin = await setupAdmin(env);
  const staff = await makeStaff(env, admin, '실장A');
  const r = await putDoc(env, staff.token, 'leads', 'l1', lead());
  assert.equal(r.body.results[0].queued, 2);
  let q = await queue(env, staff.token);
  assert.deepEqual(q.items.map(i => [i.kind, i.track, i.status]).sort(), [['contact', 'quick', 'pending'], ['deal', 'quick', 'pending']]);
  // 메모만 바꾸면 큐가 늘지 않는다(연락처 필드가 아니다)
  await putDoc(env, staff.token, 'leads', 'l1', lead({ memo: '메모' }));
  assert.equal((await queue(env, staff.token)).items.length, 2);
  // 단계 전이 → 같은 리드의 deal 줄에 합쳐지고 review 가 된다
  await putDoc(env, staff.token, 'leads', 'l1', lead({ stage: 'booked' }));
  q = await queue(env, staff.token);
  const deal = q.items.find(i => i.kind === 'deal');
  assert.deepEqual([q.items.length, deal.track, deal.payload.stage, deal.payload.transition], [2, 'review', 'booked', true]);
  // 전화 변경 → contact 줄 payload 갱신(줄 수 그대로)
  await putDoc(env, staff.token, 'leads', 'l1', lead({ stage: 'booked', phone: '010-0000-1111' }));
  q = await queue(env, staff.token);
  assert.equal(q.items.length, 2);
  assert.ok(q.items.find(i => i.kind === 'contact').payload.fields.includes('phone'));
  // 기록 → note
  await putDoc(env, staff.token, 'activities', 'a1', { leadId: 'l1', type: 'call', text: '통화', result: 'reached' });
  await putDoc(env, staff.token, 'activities', 'a2', { leadId: 'l1', type: 'hubspot', text: '동기화 메모' });
  q = await queue(env, staff.token);
  assert.equal(q.items.filter(i => i.kind === 'note').length, 1, 'hubspot 종류 기록은 노트로 보내지 않는다');
  assert.deepEqual(q.counts, { pending: 3, approved: 0, done: 0, failed: 0, rejected: 0 });
  // 승인은 원장만
  assert.equal((await call(env, 'POST', '/api/hubspot/queue', { token: staff.token, body: { op: 'approveAll' } })).status, 403);
  const noteId = q.items.find(i => i.kind === 'note').id;
  const rej = await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'reject', ids: [noteId] } });
  assert.equal(rej.body.changed, 1);
  const all = await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approveAll' } });
  assert.deepEqual([all.body.changed, all.body.counts.approved, all.body.counts.rejected], [2, 2, 1]);
  const un = await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'unapprove', ids: [deal.id] } });
  assert.equal(un.body.changed, 1);
  // 원장이 승인한 딜 줄의 단계가 그 뒤에 바뀌면 승인은 무효 — 다시 승인 대기
  await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approve', ids: [deal.id] } });
  assert.equal((await queue(env, admin, '?leadId=l1&status=approved')).items.length, 2, '연락처 줄 + 딜 줄');
  await putDoc(env, staff.token, 'leads', 'l1', lead({ stage: 'lost', phone: '010-0000-1111' }));
  const again = (await queue(env, admin, '?leadId=l1')).items.find(i => i.kind === 'deal');
  assert.deepEqual([again.id, again.status, again.payload.stage], [deal.id, 'pending', 'lost'], '승인 없이 다른 단계가 나가면 안 된다');
  await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approve', ids: [deal.id] } });
  await putDoc(env, staff.token, 'leads', 'l1', lead({ stage: 'lost', phone: '010-0000-1111', memo: '같은 단계' }));
  assert.equal((await queue(env, admin, '?leadId=l1')).items.find(i => i.kind === 'deal').status, 'approved', '단계가 그대로면 승인은 유지');
  assert.equal((await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approve', ids: ['bad'] } })).status, 400);
  assert.equal((await queue(env, admin, '?status=pending')).items.length, 0);
  assert.equal((await queue(env, admin, '?leadId=l1&status=approved')).items.length, 2);
});

test('빠른 입력 자동 승인을 켜면 contact·note 는 approved 로 태어나고 deal 전이는 pending, 연동을 끄면 큐가 생기지 않는다', async () => {
  const env = envFor();
  const admin = await setupAdmin(env);
  await putDoc(env, admin, 'settings', 'main', { hubspot: { enabled: true, autoApproveQuick: true } });
  await putDoc(env, admin, 'leads', 'l1', lead());
  await putDoc(env, admin, 'activities', 'a1', { leadId: 'l1', type: 'note', text: '메모' });
  await putDoc(env, admin, 'leads', 'l1', lead({ stage: 'tested' }));
  const q = await queue(env, admin);
  assert.deepEqual(q.items.map(i => [i.kind, i.status]).sort(), [['contact', 'approved'], ['deal', 'pending'], ['note', 'approved']]);
  await putDoc(env, admin, 'settings', 'main', { hubspot: { enabled: false } });
  const r = await putDoc(env, admin, 'leads', 'l2', lead());
  assert.equal(r.body.results[0].queued, 0);
});

test('검사 여정 → 학원 등록으로 넘기면 검사 여정 딜은 성사로, 학원 딜은 트라이얼로 두 줄이 생긴다', async () => {
  const env = envFor();
  const admin = await setupAdmin(env);
  await putDoc(env, admin, 'leads', 'l1', lead({ stage: 'upsell' }));
  await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approveAll' } });
  await putDoc(env, admin, 'leads', 'l1', lead({ pipeline: 'academy', stage: 'trial' }));
  const q = await queue(env, admin, '?status=pending');
  const deals = q.items.filter(i => i.kind === 'deal').map(i => [i.payload.pipeline, i.payload.stage, i.track]).sort();
  assert.deepEqual(deals, [['academy', 'trial', 'quick'], ['inspection', 'won', 'review']]);
  const order = q.items.filter(i => i.kind === 'deal').sort((a, b) => a.createdAt - b.createdAt).map(i => i.payload.pipeline);
  assert.deepEqual(order, ['inspection', 'academy'], '검사 여정 성사가 학원 트라이얼보다 먼저 처리된다');
  // 되돌아오면 학원 등록 줄은 반려되고 검사 여정 줄 하나만 남는다
  const back = await putDoc(env, admin, 'leads', 'l1', lead({ pipeline: 'inspection', stage: 'interpreted' }));
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const open = (await queue(env, admin, '?leadId=l1')).items.filter(i => i.kind === 'deal' && (i.status === 'pending' || i.status === 'approved'));
  assert.deepEqual(open.map(i => [i.payload.pipeline, i.payload.stage]), [['inspection', 'interpreted']]);
  assert.equal((await queue(env, admin, '?leadId=l1&status=rejected')).items.filter(i => i.payload.pipeline === 'academy').length, 1);
});

test('HubSpot 상태 — 토큰 없음 → connected:false, 토큰 있음 → 포털 정보를 설정 문서에 심는다, 원장만', async () => {
  const env = envFor();
  const admin = await setupAdmin(env);
  const staff = await makeStaff(env, admin, '실장A');
  const none = await call(env, 'GET', '/api/hubspot/status', { token: admin });
  assert.deepEqual([none.status, none.body.connected, none.body.reason], [200, false, 'no_token']);
  assert.equal((await call(env, 'GET', '/api/hubspot/status', { token: staff.token })).status, 403);
  const hs = fakeHubspot();
  const env2 = envFor(hs);
  const admin2 = await setupAdmin(env2);
  const s = await call(env2, 'GET', '/api/hubspot/status', { token: admin2 });
  assert.deepEqual([s.body.connected, s.body.portal.portalId, s.body.portal.uiDomain], [true, '245', 'app-na2.hubspot.com']);
  assert.equal(hs.calls[0].auth, 'Bearer pat-test');
  const settingsDoc = (await call(env2, 'GET', '/api/docs', { token: admin2 })).body.docs.find(x => x.c === 'settings');
  assert.equal(settingsDoc.data.hubspot.portal.portalId, '245');
  await call(env2, 'GET', '/api/hubspot/status', { token: admin2 });
  const settingsAgain = (await call(env2, 'GET', '/api/docs', { token: admin2 })).body.docs.find(x => x.c === 'settings');
  assert.equal(settingsAgain.updatedAt, settingsDoc.updatedAt, '포털 정보가 같으면 설정 문서를 다시 쓰지 않는다(클라이언트 저장이 STALE 로 거절되지 않게)');
  assert.ok(!JSON.stringify(s.body).includes('pat-test'), '응답에 토큰이 새지 않는다');
  const bad = fakeHubspot({ 'GET /account-info/v3/details': () => new Response(JSON.stringify({ message: 'bad token' }), { status: 401 }) });
  const env3 = envFor(bad);
  const admin3 = await setupAdmin(env3);
  const s3 = await call(env3, 'GET', '/api/hubspot/status', { token: admin3 });
  assert.deepEqual([s3.body.connected, s3.body.reason], [false, 'HUBSPOT_AUTH']);
});

test('파이프라인 제안·속성 점검·생성', async () => {
  const hs = fakeHubspot();
  const env = envFor(hs);
  const admin = await setupAdmin(env);
  const p = await call(env, 'GET', '/api/hubspot/pipelines', { token: admin });
  assert.equal(p.body.pipelines.length, 2);
  assert.equal(p.body.suggested.inspection.stageMap.upsell, '3551668965');
  assert.equal(p.body.suggested.academy.stageMap.churned, 'a5');
  const props = await call(env, 'GET', '/api/hubspot/properties', { token: admin });
  assert.ok(props.body.missing.includes('wb_child_name') && props.body.present.includes('wb_source_channel'));
  const made = await call(env, 'POST', '/api/hubspot/properties', { token: admin });
  assert.equal(made.body.created.length, props.body.missing.length);
  assert.equal((await call(env, 'GET', '/api/hubspot/pipelines', { token: admin })).status, 200);
  const noToken = envFor();
  const a2 = await setupAdmin(noToken);
  assert.equal((await call(noToken, 'GET', '/api/hubspot/pipelines', { token: a2 })).status, 409);
});

test('push — 승인된 큐를 HubSpot 에 쓴다: 연락처 생성(중복 검색 먼저)·딜 생성·노트, 리드에 id 가 심기고 연결표가 남는다', async () => {
  const hs = fakeHubspot();
  const env = envFor(hs);
  const admin = await setupAdmin(env);
  await saveMapping(env, admin, hs);
  await putDoc(env, admin, 'leads', 'l1', lead({ stage: 'tested', inspection: { type: '웩슬러', date: '2026-10-01' } }));
  await putDoc(env, admin, 'activities', 'a1', { leadId: 'l1', type: 'consult', text: '첫 상담', result: 'reached' });
  const before = await call(env, 'POST', '/api/hubspot/push', { token: admin, body: {} });
  assert.deepEqual([before.body.done, before.body.remaining], [0, 0], '승인 전에는 아무것도 보내지 않는다');
  await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approveAll' } });
  const pushed = await call(env, 'POST', '/api/hubspot/push', { token: admin, body: {} });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
  assert.deepEqual([pushed.body.done, pushed.body.failed, pushed.body.remaining], [3, 0, 0]);
  const paths = hs.calls.map(c => c.method + ' ' + c.path);
  assert.ok(paths.includes('POST /crm/v3/objects/contacts/search'), '만들기 전에 중복을 찾는다');
  assert.ok(paths.includes('POST /crm/v3/objects/contacts') && paths.includes('POST /crm/v3/objects/deals') && paths.includes('POST /crm/v3/objects/notes'));
  const contactCreate = hs.calls.find(c => c.method === 'POST' && c.path === '/crm/v3/objects/contacts');
  assert.deepEqual([contactCreate.body.properties.firstname, contactCreate.body.properties.phone, contactCreate.body.properties.wb_source_channel], ['보호자A', '010-0000-0000', '맘카페']);
  assert.equal(contactCreate.body.properties.wb_child_name, undefined, '포털에 없는 속성은 보내지 않는다(캐시된 속성 목록)');
  const dealCreate = hs.calls.find(c => c.method === 'POST' && c.path === '/crm/v3/objects/deals');
  assert.deepEqual([dealCreate.body.properties.pipeline, dealCreate.body.properties.dealstage, dealCreate.body.associations[0].to.id], ['default', 'decisionmakerboughtin', '1001']);
  const note = hs.calls.find(c => c.method === 'POST' && c.path === '/crm/v3/objects/notes');
  assert.ok(note.body.properties.hs_note_body.includes('[상담]') && note.body.properties.hs_note_body.includes('첫 상담'));
  const docs = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs;
  const l1 = docs.find(d => d.id === 'l1').data;
  assert.equal(l1.hubspot.contactId, '1001');
  assert.equal(l1.hubspot.deals.inspection.dealId, 'd1002');
  assert.equal(docs.find(d => d.id === 'a1').data.hubspot.noteId, 'n1003');
  assert.equal(docs.find(d => d.id === 'l1').updatedBy, 'hubspot');
  const link = env.DB.database.prepare('SELECT * FROM crm_hs_links').all();
  assert.deepEqual([link.length, link[0].contact_id, link[0].lead_id], [1, '1001', 'l1']);
  // 단계 전이 → 기존 딜 PATCH, 연락처는 PATCH(생성 안 함)
  await putDoc(env, admin, 'leads', 'l1', lead({ stage: 'won', inspection: { type: '웩슬러', date: '2026-10-01' } }));
  await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approveAll' } });
  const n0 = hs.calls.length;
  const p2 = await call(env, 'POST', '/api/hubspot/push', { token: admin, body: {} });
  assert.equal(p2.body.done, 2);
  const after = hs.calls.slice(n0).map(c => c.method + ' ' + c.path);
  assert.ok(after.includes('PATCH /crm/v3/objects/deals/d1002') && after.includes('PATCH /crm/v3/objects/contacts/1001'));
  assert.ok(!after.includes('POST /crm/v3/objects/contacts'));
  const dealPatch = hs.calls.slice(n0).find(c => c.path === '/crm/v3/objects/deals/d1002');
  assert.equal(dealPatch.body.properties.dealstage, 'closedwon');
  assert.ok(dealPatch.body.properties.closedate);
  const contactPatch = hs.calls.slice(n0).find(c => c.path === '/crm/v3/objects/contacts/1001');
  assert.equal(contactPatch.body.properties.lifecyclestage, 'customer');
  // 이미 있는 연락처는 검색으로 찾아 연결만 한다
  hs.routes['POST /crm/v3/objects/contacts/search'] = () => ({ total: 1, results: [{ id: '555', properties: { firstname: '기존', lastname: '' } }] });
  await putDoc(env, admin, 'leads', 'l2', lead({ name: '기존', phone: '010-0000-2222' }));
  await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approveAll' } });
  const n1 = hs.calls.length;
  await call(env, 'POST', '/api/hubspot/push', { token: admin, body: {} });
  const created = hs.calls.slice(n1).filter(c => c.method === 'POST' && c.path === '/crm/v3/objects/contacts');
  assert.equal(created.length, 0);
  const l2 = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs.find(d => d.id === 'l2').data;
  assert.equal(l2.hubspot.contactId, '555');
  // 같은 연락처가 이미 l2 에 연결돼 있다 — l3 은 가로채지 못하고 실패로 남는다
  await putDoc(env, admin, 'leads', 'l3', lead({ name: '형제', phone: '010-0000-2222' }));
  await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approveAll' } });
  const p3 = await call(env, 'POST', '/api/hubspot/push', { token: admin, body: {} });
  assert.ok(p3.body.failed >= 1);
  const failedRow = (await queue(env, admin, '?leadId=l3&status=failed')).items[0];
  assert.match(failedRow.error, /LINKED/);
  assert.equal(env.DB.database.prepare('SELECT lead_id FROM crm_hs_links WHERE contact_id=?').get('555').lead_id, 'l2', '연결표가 바뀌지 않는다');
  // HubSpot 왕복 사이에 직원이 고친 메모는 살아남는다(문서 전체가 아니라 hubspot 필드만 고친다)
  hs.routes['POST /crm/v3/objects/contacts/search'] = () => ({ total: 0, results: [] });
  hs.routes['POST /crm/v3/objects/contacts'] = async c => { await putDoc(env, admin, 'leads', 'l4', lead({ name: '보호자D', phone: '010-0000-4444', memo: '왕복 중 고친 메모' })); return { id: '4444', properties: c.body.properties }; };
  await putDoc(env, admin, 'leads', 'l4', lead({ name: '보호자D', phone: '010-0000-4444', memo: '처음 메모' }));
  await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approveAll' } });
  await call(env, 'POST', '/api/hubspot/push', { token: admin, body: {} });
  const l4 = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs.find(d => d.id === 'l4').data;
  assert.deepEqual([l4.memo, l4.hubspot.contactId], ['왕복 중 고친 메모', '4444']);
});

test('push — 매핑 없는 딜은 failed(UNMAPPED), 재시도(retry)는 approved 로, 429 는 멈추고 큐를 남긴다, 지운 리드는 실패', async () => {
  const hs = fakeHubspot();
  const env = envFor(hs);
  const admin = await setupAdmin(env);
  await putDoc(env, admin, 'leads', 'l1', lead());
  await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approveAll' } });
  const r = await call(env, 'POST', '/api/hubspot/push', { token: admin, body: {} });
  assert.deepEqual([r.body.done, r.body.failed], [1, 1]);
  let q = await queue(env, admin, '?status=failed');
  assert.ok(/UNMAPPED/.test(q.items[0].error));
  await saveMapping(env, admin, hs);
  const retry = await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'retry', ids: [q.items[0].id] } });
  assert.equal(retry.body.changed, 1);
  assert.equal((await call(env, 'POST', '/api/hubspot/push', { token: admin, body: {} })).body.done, 1);
  // 429
  hs.routes['PATCH /crm/v3/objects/contacts/*'] = () => new Response(JSON.stringify({ message: 'rate limit' }), { status: 429 });
  await putDoc(env, admin, 'leads', 'l1', lead({ phone: '010-0000-3333' }));
  await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approveAll' } });
  const lim = await call(env, 'POST', '/api/hubspot/push', { token: admin, body: {} });
  assert.deepEqual([lim.body.done, lim.body.failed, lim.body.stopped, lim.body.remaining], [0, 0, 'HUBSPOT_RATE', 1]);
  // 지운 리드의 열린 큐 줄은 반려로 닫힌다 — 보낼 것이 없다
  delete hs.routes['PATCH /crm/v3/objects/contacts/*'];
  hs.routes['PATCH /crm/v3/objects/contacts/*'] = c => ({ id: c.path.split('/').pop() });
  await putDoc(env, admin, 'leads', 'l1', {}, { deleted: true });
  const gone = await call(env, 'POST', '/api/hubspot/push', { token: admin, body: {} });
  assert.deepEqual([gone.body.done, gone.body.failed, gone.body.remaining], [0, 0, 0]);
  assert.equal((await queue(env, admin, '?leadId=l1&status=rejected')).items.length, 1);
  // flushQueue 를 직접(크론 경로) — 토큰 없으면 코드로 알린다
  const none = await flushQueue({ DB: new TestD1() }, 5);
  assert.deepEqual([none.ok, none.code], [false, 'HUBSPOT_NO_TOKEN']);
});

test('pull — 변경분 연락처를 리드로 들여오고(딜 → 단계), 미반영 큐가 있는 리드는 건너뛰고, 커서가 남는다', async () => {
  const hs = fakeHubspot({
    'POST /crm/v3/objects/contacts/search': c => {
      const since = c.body.filterGroups[0].filters[0];
      if (since.propertyName === 'lastmodifieddate' && Number(since.value) > 1700000000000) return { total: 0, results: [] };
      return { total: 2, results: [
        { id: '901', updatedAt: '2026-10-01T00:00:00Z', properties: { firstname: '보호', lastname: '김', phone: '01000005555', wb_source_channel: '당근', lastmodifieddate: '1700000000000', createdate: '2026-09-01T00:00:00Z' } },
        { id: '902', updatedAt: '2026-10-02T00:00:00Z', properties: { firstname: 'B', wb_crm_lead_id: 'local1', lastmodifieddate: '1700000000500' } }
      ] };
    },
    'POST /crm/v4/associations/contacts/deals/batch/read': () => ({ results: [{ from: { id: '901' }, to: [{ toObjectId: 'd77' }] }] }),
    'POST /crm/v3/objects/deals/batch/read': () => ({ results: [{ id: 'd77', properties: { pipeline: 'default', dealstage: 'contractsent', hs_lastmodifieddate: '2026-09-20T00:00:00Z' } }] })
  });
  const env = envFor(hs);
  const admin = await setupAdmin(env);
  await saveMapping(env, admin, hs);
  await putDoc(env, admin, 'leads', 'local1', lead({ name: '로컬B', memo: '우리 메모' }));
  // local1 에는 미반영 큐가 있다 → 첫 pull 에서 건너뛰고 retry 목록에 남는다
  let r = await call(env, 'POST', '/api/hubspot/pull', { token: admin, body: { full: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.created, r.body.updated, r.body.conflicts, r.body.more, r.body.retry], [1, 0, 1, false, 1]);
  let docs = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs;
  const imported = docs.find(d => d.id === 'hs_901').data;
  assert.deepEqual([imported.name, imported.phone, imported.channel, imported.stage, imported.pipeline, imported.hubspot.contactId, imported.hubspot.deals.inspection.dealId, imported.createdAt, imported.owner],
    ['김보호', '010-0000-5555', '당근', 'interpreted', 'inspection', '901', 'd77', '2026-09-01', 'admin']);
  assert.equal(docs.find(d => d.id === 'local1').data.name, '로컬B');
  // 큐를 비우면 증분 pull 이 커서와 상관없이 건너뛴 연락처를 id 로 다시 읽어 local1 에 들여온다 — wb_crm_lead_id 로 연결되고 메모는 지킨다
  await call(env, 'POST', '/api/hubspot/queue', { token: admin, body: { op: 'approveAll' } });
  const ids = (await queue(env, admin, '?status=approved')).items.map(i => i.id);
  env.DB.database.prepare("UPDATE crm_sync_queue SET status='done'").run();
  assert.ok(ids.length);
  hs.routes['POST /crm/v3/objects/contacts/batch/read'] = c => ({ results: c.body.inputs.filter(i => i.id === '902').map(() => ({ id: '902', updatedAt: '2026-10-02T00:00:00Z', properties: { firstname: 'B', wb_crm_lead_id: 'local1', lastmodifieddate: '1700000000500' } })) });
  r = await call(env, 'POST', '/api/hubspot/pull', { token: admin, body: {} });
  assert.deepEqual([r.body.created, r.body.updated, r.body.conflicts, r.body.retry], [0, 1, 0, 0]);
  assert.ok(hs.calls.some(c => c.path === '/crm/v3/objects/contacts/batch/read'));
  docs = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs;
  const local = docs.find(d => d.id === 'local1').data;
  assert.deepEqual([local.name, local.memo, local.hubspot.contactId], ['B', '우리 메모', '902']);
  const links = env.DB.database.prepare('SELECT contact_id, lead_id FROM crm_hs_links ORDER BY contact_id').all().map(r => ({ contact_id: r.contact_id, lead_id: r.lead_id }));
  assert.deepEqual(links, [{ contact_id: '901', lead_id: 'hs_901' }, { contact_id: '902', lead_id: 'local1' }]);
  // 증분: 커서 since 가 마지막 수정 시각+1 → 가짜는 빈 결과
  const cursor = JSON.parse(env.DB.database.prepare("SELECT value FROM crm_kv WHERE key='hs:pull'").get().value);
  assert.equal(cursor.since, 1700000000501);
  r = await call(env, 'POST', '/api/hubspot/pull', { token: admin, body: {} });
  assert.deepEqual([r.body.seen, r.body.created], [0, 0]);
  const status = await call(env, 'GET', '/api/hubspot/status', { token: admin });
  assert.equal(status.body.pull.since, 1700000000501);
  // 원장이 지운 리드는 전체 가져오기로도 되살아나지 않는다
  await putDoc(env, admin, 'leads', 'hs_901', {}, { deleted: true });
  r = await call(env, 'POST', '/api/hubspot/pull', { token: admin, body: { full: true } });
  assert.equal(r.body.deleted, 1);
  assert.equal((await call(env, 'GET', '/api/docs', { token: admin })).body.docs.find(d => d.id === 'hs_901').deleted, true);
  // HubSpot 쪽 이름에 전화 패턴이 섞인 연락처는 들여오지 않고 invalid 로 센다
  hs.routes['POST /crm/v3/objects/contacts/search'] = () => ({ total: 1, results: [{ id: '903', updatedAt: '2026-10-03T00:00:00Z', properties: { firstname: '엄마 010-1111-2222', lastmodifieddate: '1700000000900' } }] });
  r = await call(env, 'POST', '/api/hubspot/pull', { token: admin, body: { full: true } });
  assert.deepEqual([r.body.invalid, r.body.created], [1, 0]);
});

async function makePartner(env, admin, name) {
  const id = 'pt_' + name.length + Math.random().toString(36).slice(2, 8);
  const r = await putDoc(env, admin, 'partners', id, { name, kind: '수학', phone: '010-0000-9999', terms: { inbound: '검사비 20% 할인', outbound: '첫 달 10% 할인' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const link = await call(env, 'POST', '/api/partners', { token: admin, body: { op: 'link', partnerId: id } });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const ex = await call(env, 'POST', '/api/partner/link-exchange', { body: { code: link.body.code } });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  return { id, token: ex.body.token, code: link.body.code };
}

test('파트너 — 등록은 원장만, 링크는 1회, 파트너 토큰은 /api/partner/* 만 열고 응답에 전화·메모가 없다', async () => {
  const env = envFor();
  const admin = await setupAdmin(env);
  const staff = await makeStaff(env, admin, '실장A');
  assert.equal((await putDoc(env, staff.token, 'partners', 'pt_x', { name: '가나수학' })).status, 403);
  assert.equal((await putDoc(env, admin, 'partners', 'pt_x', { name: '가나수학', memo: '담당 010-1111-2222' })).body.code, 'PII');
  const partner = await makePartner(env, admin, '가나수학');
  assert.equal((await call(env, 'POST', '/api/partner/link-exchange', { body: { code: partner.code } })).status, 401, '코드는 한 번만');
  assert.equal((await call(env, 'POST', '/api/partners', { token: staff.token, body: { op: 'link', partnerId: partner.id } })).status, 403);
  const me = await call(env, 'GET', '/api/partner/me', { token: partner.token });
  assert.deepEqual([me.body.partner.name, me.body.partner.terms.inbound, me.body.stats.inbound], ['가나수학', '검사비 20% 할인', 0]);
  assert.ok(!JSON.stringify(me.body).includes('010-'), '파트너 응답에 전화번호가 없다');
  assert.equal((await call(env, 'GET', '/api/docs', { token: partner.token })).status, 401, '파트너 토큰으로 직원 API 를 열 수 없다');
  assert.equal((await call(env, 'GET', '/api/partner/me', { token: staff.token })).status, 401, '직원 토큰으로 파트너 API 를 열 수 없다');
});

test('파트너 포털 — 소개 보내기 → 센터 리드(채널 파트너)·반영 큐·기록, 동의·PII·상한, 중지되면 막힘', async () => {
  const env = envFor();
  const admin = await setupAdmin(env);
  const partner = await makePartner(env, admin, '가나수학');
  const noConsent = await call(env, 'POST', '/api/partner/referrals', { token: partner.token, body: { name: '보호자B', phone: '01000001234', childName: '아이', grade: '초4' } });
  assert.deepEqual([noConsent.status, noConsent.body.code], [400, 'CONSENT']);
  assert.equal((await call(env, 'POST', '/api/partner/referrals', { token: partner.token, body: { name: '보호자B', consent: true, memo: '연락 010-1111-2222' } })).body.code, 'PII');
  assert.equal((await call(env, 'POST', '/api/partner/referrals', { token: partner.token, body: { consent: true } })).body.code, 'INVALID');
  assert.equal((await call(env, 'POST', '/api/partner/referrals', { token: partner.token, body: { name: '김엄마 010-1234-5678', consent: true } })).body.code, 'PII');
  const made = await call(env, 'POST', '/api/partner/referrals', { token: partner.token, body: { name: '보호자B', phone: '01000001234', childName: '아이', grade: '초4', memo: '독해가 약해요', consent: true } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.deepEqual([made.body.referral.name, made.body.referral.stage, made.body.referral.childName], ['보호자B', '접수', '아이']);
  const docs = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs;
  const lead = docs.find(d => d.c === 'leads' && d.data.name === '보호자B');
  assert.deepEqual([lead.data.channel, lead.data.partnerId, lead.data.phone, lead.data.channelNote, lead.updatedBy], ['파트너', partner.id, '010-0000-1234', '가나수학', 'partner:' + partner.id]);
  assert.ok(lead.data.source.includes('파트너 가나수학 소개') && lead.data.source.includes('독해가 약해요'));
  assert.ok(docs.some(d => d.c === 'activities' && d.data.leadId === lead.id && /포털/.test(d.data.text)));
  const q = await queue(env, admin, '?leadId=' + lead.id);
  assert.deepEqual(q.items.map(i => i.kind).sort(), ['contact', 'deal']);
  const list = await call(env, 'GET', '/api/partner/referrals', { token: partner.token });
  assert.equal(list.body.inbound.length, 1);
  assert.equal(list.body.inbound[0].phone, undefined);
  // 센터가 단계를 옮기면 포털엔 거친 단계만
  await putDoc(env, admin, 'leads', lead.id, Object.assign({}, lead.data, { stage: 'upsell' }));
  assert.equal((await call(env, 'GET', '/api/partner/referrals', { token: partner.token })).body.inbound[0].stage, '검사 완료');
  // 하루 상한
  for (let i = 0; i < 19; i++) await call(env, 'POST', '/api/partner/referrals', { token: partner.token, body: { name: '보호자' + i, consent: true } });
  assert.equal((await call(env, 'POST', '/api/partner/referrals', { token: partner.token, body: { name: '보호자Z', consent: true } })).status, 429);
  // 일시 중지 → 토큰이 있어도 막힌다
  const pdoc = docs.find(d => d.c === 'partners' && d.id === partner.id).data;
  await putDoc(env, admin, 'partners', partner.id, Object.assign({}, pdoc, { status: 'paused' }));
  assert.equal((await call(env, 'GET', '/api/partner/me', { token: partner.token })).status, 401);
  assert.equal((await call(env, 'POST', '/api/partners', { token: admin, body: { op: 'link', partnerId: partner.id } })).status, 409);
  const rv = await call(env, 'POST', '/api/partners', { token: admin, body: { op: 'revoke', partnerId: partner.id } });
  assert.equal(rv.body.revokedTokens, 1);
});

test('나가는 소개 — 직원이 동의와 함께 만들고, 파트너는 자기 것만 보고 상태·메모만 바꾼다, 리드·파트너 존재 검사', async () => {
  const env = envFor();
  const admin = await setupAdmin(env);
  const staff = await makeStaff(env, admin, '실장A');
  const partner = await makePartner(env, admin, '가나수학');
  const other = await makePartner(env, admin, '다라영어');
  await putDoc(env, staff.token, 'leads', 'l1', lead({ child: { name: '아이', grade: '초5' } }));
  assert.equal((await putDoc(env, staff.token, 'referrals', 'r1', { leadId: 'l1', partnerId: partner.id, note: '수학 보강' })).body.code, 'CONSENT');
  assert.equal((await putDoc(env, staff.token, 'referrals', 'r1', { leadId: 'nope', partnerId: partner.id, consent: true })).body.code, 'INVALID');
  assert.equal((await putDoc(env, staff.token, 'referrals', 'r1', { leadId: 'l1', partnerId: 'pt_none', consent: true })).body.code, 'INVALID');
  assert.equal((await putDoc(env, staff.token, 'leads', 'l2', lead({ channel: '파트너', partnerId: 'pt_none' }))).body.code, 'INVALID');
  const ok = await putDoc(env, staff.token, 'referrals', 'r1', { leadId: 'l1', partnerId: partner.id, note: '수학 보강 권함', consent: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const mine = await call(env, 'GET', '/api/partner/referrals', { token: partner.token });
  assert.deepEqual([mine.body.outbound.length, mine.body.outbound[0].childName, mine.body.outbound[0].grade, mine.body.outbound[0].status, mine.body.outbound[0].note], [1, '아이', '초5', 'sent', '수학 보강 권함']);
  assert.equal(mine.body.outbound[0].phone, undefined);
  assert.equal((await call(env, 'GET', '/api/partner/referrals', { token: other.token })).body.outbound.length, 0, '다른 파트너에게는 안 보인다');
  assert.equal((await call(env, 'POST', '/api/partner/referrals/r1/status', { token: other.token, body: { status: 'enrolled' } })).status, 404);
  assert.equal((await call(env, 'POST', '/api/partner/referrals/r1/status', { token: partner.token, body: { status: 'bogus' } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/partner/referrals/r1/status', { token: partner.token, body: { status: 'enrolled', note: '연락처 010-1111-2222' } })).body.code, 'PII');
  const up = await call(env, 'POST', '/api/partner/referrals/r1/status', { token: partner.token, body: { status: 'enrolled', note: '10월부터 수강' } });
  assert.deepEqual([up.status, up.body.referral.status, up.body.referral.partnerNote], [200, 'enrolled', '10월부터 수강']);
  assert.match(up.body.referral.statusAt, /^\d{4}-\d{2}-\d{2}$/);
  const doc = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs.find(d => d.c === 'referrals' && d.id === 'r1');
  assert.deepEqual([doc.data.status, doc.data.by, doc.updatedBy], ['enrolled', staff.id, 'partner:' + partner.id]);
  // 직원이 상태를 고쳐도 리드·파트너는 고정
  const edit = await putDoc(env, staff.token, 'referrals', 'r1', { leadId: 'other', partnerId: other.id, status: 'declined', consent: false });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const after = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs.find(d => d.c === 'referrals' && d.id === 'r1').data;
  assert.deepEqual([after.leadId, after.partnerId, after.status, after.consent], ['l1', partner.id, 'declined', true]);
  const stats = await call(env, 'GET', '/api/partner/me', { token: partner.token });
  assert.deepEqual([stats.body.stats.outbound, stats.body.stats.outboundDeclined], [1, 1]);
});

test('내보내기는 원장만 — 문서·직원·큐·연결표', async () => {
  const env = envFor();
  const admin = await setupAdmin(env);
  const staff = await makeStaff(env, admin, '실장A');
  await putDoc(env, admin, 'leads', 'l1', lead());
  assert.equal((await call(env, 'GET', '/api/export', { token: staff.token })).status, 403);
  const ex = await call(env, 'GET', '/api/export', { token: admin });
  assert.equal(ex.status, 200);
  assert.ok(ex.body.docs.length >= 1 && ex.body.staff.length === 1 && ex.body.queue.length === 2 && Array.isArray(ex.body.links));
  assert.match(ex.headers.get('content-disposition'), /wb-crm-export-/);
});

const membership = (program = 'friend', overrides = {}) => ({ leadId: 'rel-lead', program, startDate: '2025-01-01', status: 'active', benefitState: 'unchecked', ...overrides });
const programExam = (membershipId, overrides = {}) => ({ membershipId, cycleStart: '2025-01-01', cycleEnd: '2025-03-31', dueDate: '2025-03-31', ...overrides });
const relationWrite = (env, token, c, id, data, at = 0) => putDoc(env, token, c, id, data, { expectedUpdatedAt: at });
async function relationDoc(env, token, c, id) {
  return (await call(env, 'GET', '/api/docs', { token })).body.docs.find(d => d.c === c && d.id === id);
}

// 두 요청이 같은 이전 버전을 읽은 뒤 함께 진행해야 DB CAS를 실제로 검증한다.
async function raceWrites(env, collection, ids, writes) {
  const prepare = env.DB.prepare.bind(env.DB);
  let reads = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  env.DB.prepare = sql => {
    const s = prepare(sql), first = s.first.bind(s);
    if (sql === 'SELECT data,updated_at,updated_by,deleted FROM crm_documents WHERE collection=? AND id=? LIMIT 1') s.first = async () => {
      const row = await first();
      if (s.args[0] === collection && ids.includes(s.args[1]) && reads < 2) { if (++reads === 2) release(); await gate; }
      return row;
    };
    return s;
  };
  try { return await Promise.all(writes.map(write => write())); }
  finally { env.DB.prepare = prepare; }
}

test('관계 참여 — 직원 저장·고객 참조·고정 id·필수 CAS, 파트너 차단과 HubSpot 분리', async () => {
  const env = envFor(), admin = await setupAdmin(env), staff = await makeStaff(env, admin, '관계 담당');
  const id = 'rel-lead__friend', raw = membership();
  assert.equal((await relationWrite(env, staff.token, 'memberships', id, raw)).body.code, 'INVALID', '없는 고객은 연결하지 않는다');
  await putDoc(env, admin, 'leads', 'rel-lead', lead({ stage: 'won' }));
  const queueBefore = await queue(env, admin);
  assert.equal((await putDoc(env, staff.token, 'memberships', id, raw)).body.code, 'INVALID', '버전 생략은 거절한다');
  assert.equal((await putDoc(env, staff.token, 'memberships', id, raw, { expectedUpdatedAt: '0' })).body.code, 'INVALID');
  assert.equal((await relationWrite(env, staff.token, 'memberships', 'random-id', raw)).body.code, 'INVALID');
  assert.equal((await relationWrite(env, staff.token, 'memberships', id, { ...raw, note: 'a@example.test' })).body.code, 'PII');
  const created = await relationWrite(env, staff.token, 'memberships', id, raw);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.results[0].queued, 0);
  let doc = await relationDoc(env, admin, 'memberships', id);
  assert.equal(doc.data.owner, staff.id);
  assert.equal((await relationWrite(env, staff.token, 'memberships', id, { ...raw, program: 'supporter' }, doc.updatedAt)).body.code, 'IMMUTABLE');
  assert.equal((await relationWrite(env, staff.token, 'memberships', id, raw)).body.code, 'STALE');
  const race = await raceWrites(env, 'memberships', [id], ['한 번', '다른 메모'].map(note => () => relationWrite(env, staff.token, 'memberships', id, { ...raw, note }, doc.updatedAt)));
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
  assert.equal(race.find(r => r.status === 409).body.code, 'STALE');
  doc = await relationDoc(env, admin, 'memberships', id);
  assert.ok(['한 번', '다른 메모'].includes(doc.data.note));
  assert.equal((await relationWrite(env, staff.token, 'memberships', 'rel-lead__supporter', membership('supporter'))).status, 200, '동일 고객의 다른 프로그램은 독립 기록이다');
  assert.deepEqual((await queue(env, admin)).items, queueBefore.items, '프로그램 저장은 딜·메모 큐를 만들지 않는다');
  assert.equal((await putDoc(env, admin, 'memberships', id, {}, { deleted: true, expectedUpdatedAt: doc.updatedAt })).body.code, 'APPEND_ONLY');
  const partner = await makePartner(env, admin, '검증학원');
  assert.equal((await relationWrite(env, partner.token, 'memberships', id, raw, doc.updatedAt)).status, 401);
  assert.equal((await call(env, 'GET', '/api/docs', { token: partner.token })).status, 401);
  await putDoc(env, admin, 'leads', 'rel-lead', {}, { deleted: true });
  assert.equal((await relationWrite(env, staff.token, 'memberships', id, raw, doc.updatedAt)).body.code, 'INVALID', '삭제된 고객은 참조하지 않는다');
});

test('프로그램 활동 — 친구 리뷰만·서포터즈 별도, 확인자 서버 신원과 월 고정·PII·미래일', async () => {
  const env = envFor(), admin = await setupAdmin(env), staff = await makeStaff(env, admin, '확인 담당');
  await putDoc(env, admin, 'leads', 'rel-lead', lead());
  for (const program of ['friend', 'supporter']) assert.equal((await relationWrite(env, admin, 'memberships', 'rel-lead__' + program, membership(program))).status, 200);
  const raw = { membershipId: 'rel-lead__friend', month: '2025-02', date: '2025-02-02', kind: 'review', status: 'pending', evidence: '센터에서 원본 확인', by: 'forged' };
  assert.equal((await relationWrite(env, staff.token, 'programActivities', 'missing', { ...raw, membershipId: 'missing' })).body.code, 'INVALID');
  assert.equal((await relationWrite(env, staff.token, 'programActivities', 'a1', { ...raw, kind: 'referral' })).body.code, 'INVALID');
  assert.equal((await relationWrite(env, staff.token, 'programActivities', 'a1', { ...raw, evidence: '010-1111-2222' })).body.code, 'PII');
  assert.equal((await relationWrite(env, staff.token, 'programActivities', 'a1', { ...raw, date: '2025-02-30' })).body.code, 'INVALID');
  assert.equal((await relationWrite(env, staff.token, 'programActivities', 'a1', { ...raw, month: '9999-01', date: '9999-01-01', status: 'confirmed' })).body.code, 'INVALID');
  assert.equal((await relationWrite(env, staff.token, 'programActivities', 'a1', raw)).status, 200);
  let doc = await relationDoc(env, admin, 'programActivities', 'a1');
  assert.equal(doc.data.by, staff.id);
  assert.equal((await relationWrite(env, admin, 'programActivities', 'a1', { ...raw, month: '2025-03', date: '2025-03-02' }, doc.updatedAt)).body.code, 'IMMUTABLE');
  assert.equal((await relationWrite(env, admin, 'programActivities', 'a1', { ...raw, membershipId: 'rel-lead__supporter' }, doc.updatedAt)).body.code, 'IMMUTABLE');
  assert.equal((await relationWrite(env, admin, 'programActivities', 'a1', { ...raw, status: 'confirmed' }, doc.updatedAt)).status, 200);
  doc = await relationDoc(env, admin, 'programActivities', 'a1');
  assert.deepEqual([doc.data.by, doc.data.status], ['admin', 'confirmed'], '마지막 확인자를 서버가 기록한다');
  for (const kind of ['referral', 'brunch']) assert.equal((await relationWrite(env, staff.token, 'programActivities', kind, { ...raw, membershipId: 'rel-lead__supporter', kind })).status, 200);
  assert.equal((await relationDoc(env, admin, 'memberships', 'rel-lead__friend')).data.benefitState, 'unchecked', '활동 확인이 혜택을 자동 승인하지 않는다');
});

test('프로그램 검사 — 회차 누적·활동 수동 확인, 완료 보존과 친구 1회 동시 완료 차단', async () => {
  const env = envFor(), admin = await setupAdmin(env);
  await putDoc(env, admin, 'leads', 'rel-lead', lead());
  for (const program of ['friend', 'supporter']) await relationWrite(env, admin, 'memberships', 'rel-lead__' + program, membership(program));
  const support = programExam('rel-lead__supporter', { completedDate: '2025-03-31', activitiesChecked: true });
  assert.equal((await relationWrite(env, admin, 'programExams', 'e1', { ...support, activitiesChecked: false })).body.code, 'INVALID');
  assert.equal((await relationWrite(env, admin, 'programExams', 'e1', { ...support, completedDate: '9999-01-01' })).body.code, 'INVALID');
  assert.equal((await relationWrite(env, admin, 'programExams', 'e1', support)).status, 200, '활동 건수를 추정하지 않고 담당 확인을 저장한다');
  const first = await relationDoc(env, admin, 'programExams', 'e1');
  for (const patch of [{ completedDate: '' }, { completedDate: '2025-03-30' }, { cycleStart: '2025-01-02' }, { membershipId: 'rel-lead__friend' }]) {
    assert.equal((await relationWrite(env, admin, 'programExams', 'e1', { ...support, ...patch }, first.updatedAt)).body.code, 'IMMUTABLE');
  }
  assert.equal((await relationWrite(env, admin, 'programExams', 'e2', programExam('rel-lead__supporter', { cycleStart: '2025-04-01', cycleEnd: '2025-06-30', dueDate: '2025-06-30', completedDate: '2025-06-30', activitiesChecked: true }))).status, 200);
  assert.deepEqual((await relationDoc(env, admin, 'programExams', 'e1')).data, first.data, '다음 3개월 회차가 이전 회차를 덮지 않는다');
  const friend = programExam('rel-lead__friend', { completedDate: '2025-03-31' });
  const race = await raceWrites(env, 'programExams', ['friend-a', 'friend-b'], ['friend-a', 'friend-b'].map(id => () => relationWrite(env, admin, 'programExams', id, friend)));
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
  assert.equal(race.find(r => r.status === 409).body.code, 'DUPLICATE', '서로 다른 문서 id도 두 번 완료할 수 없다');
  assert.equal((await relationWrite(env, admin, 'programExams', 'friend-c', friend)).body.code, 'DUPLICATE');
  const docs = (await call(env, 'GET', '/api/docs', { token: admin })).body.docs;
  assert.equal(docs.filter(d => d.c === 'programExams' && d.data.membershipId === 'rel-lead__friend' && d.data.completedDate).length, 1);
  assert.equal(docs.filter(d => d.c === 'programExams' && d.data.membershipId === 'rel-lead__supporter').length, 2);
  assert.ok(docs.filter(d => d.c === 'memberships').every(d => d.data.status === 'active' && d.data.benefitState === 'unchecked'));
});

test('맘스쿨 — 검사 증거·보호자 확인·정원·중복 검증, 동시 참석 변경은 CAS로 보존', async () => {
  const env = envFor(), admin = await setupAdmin(env), staff = await makeStaff(env, admin, '모임 담당');
  for (let i = 0; i < 7; i++) await putDoc(env, admin, 'leads', 'g-lead-' + i, lead({ stage: i === 6 ? 'inquiry' : 'tested', consultedAt: '2025-01-01' }));
  const participant = i => ({ leadId: 'g-lead-' + i, status: 'invited', inspectionConfirmed: true });
  const raw = { topic: '아이 독서 이야기', date: '2025-05-01', time: '10:30', place: '센터', capacity: 4, participants: Array.from({ length: 6 }, (_, i) => participant(i)) };
  assert.equal((await relationWrite(env, staff.token, 'gatherings', 'g1', { ...raw, participants: [participant(6)] })).body.code, 'INVALID', '상담 완료만으로 검사 완료를 추정하지 않는다');
  assert.equal((await relationWrite(env, staff.token, 'gatherings', 'g1', { ...raw, participants: [{ ...participant(0), inspectionConfirmed: false }] })).body.code, 'INVALID');
  assert.equal((await relationWrite(env, staff.token, 'gatherings', 'g1', { ...raw, participants: [participant(0), participant(0)] })).body.code, 'INVALID');
  assert.equal((await relationWrite(env, staff.token, 'gatherings', 'g1', { ...raw, participants: [{ ...participant(0), nextContactDate: '2025-05-02' }] })).body.code, 'INVALID');
  assert.equal((await relationWrite(env, staff.token, 'gatherings', 'g1', { ...raw, participants: [{ ...participant(0), note: '990101-1234567' }] })).body.code, 'PII');
  assert.equal((await relationWrite(env, staff.token, 'gatherings', 'g1', raw)).status, 200, '초대 후보는 정원을 넘을 수 있다');
  const doc = await relationDoc(env, admin, 'gatherings', 'g1');
  const full = { ...raw, participantsChecked: true, participants: raw.participants.map((p, i) => ({ ...p, status: i < 4 ? 'confirmed' : 'invited' })) };
  assert.equal((await relationWrite(env, staff.token, 'gatherings', 'g1', { ...full, participantsChecked: false }, doc.updatedAt)).body.code, 'INVALID');
  assert.equal((await relationWrite(env, staff.token, 'gatherings', 'g1', { ...full, participants: raw.participants.map(p => ({ ...p, status: 'confirmed' })) }, doc.updatedAt)).body.code, 'INVALID');
  const race = await raceWrites(env, 'gatherings', ['g1'], [full, { ...raw, note: '다른 직원 메모' }].map(data => () => relationWrite(env, staff.token, 'gatherings', 'g1', data, doc.updatedAt)));
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
  assert.equal(race.find(r => r.status === 409).body.code, 'STALE');
  const current = await relationDoc(env, admin, 'gatherings', 'g1');
  const completed = { ...full, status: 'completed', participants: full.participants.map((p, i) => ({ ...p, status: i < 2 ? 'attended' : 'absent' })) };
  assert.equal((await relationWrite(env, staff.token, 'gatherings', 'g1', completed, current.updatedAt)).status, 200, '결석으로 실제 참석이 4명 미만이어도 기록한다');
  assert.equal((await relationDoc(env, admin, 'gatherings', 'g1')).data.participants.length, 6, '결석 기록도 보존한다');
});
