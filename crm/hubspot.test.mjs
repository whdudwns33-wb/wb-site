// node --test crm/hubspot.test.mjs — HubSpot 클라이언트를 가짜 fetch 위에서 돌린다(망 안 탐). 토큰·실명은 자리표시.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient, contactProperties, leadFromContact, applyDealsToLead, noteBody, dealName, hsDate, HubSpotError, WB_PROPERTY_NAMES, WB_PROPERTIES } from './hubspot.mjs';

/** 경로 → 응답 함수 표. 요청은 calls 에 쌓인다. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const key = init.method + ' ' + u.pathname;
    calls.push({ key, url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const handler = routes[key] || routes[init.method + ' *'];
    if (!handler) return new Response(JSON.stringify({ message: 'no route ' + key }), { status: 404 });
    const out = typeof handler === 'function' ? handler(calls[calls.length - 1], u) : handler;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

test('토큰이 없으면 만들 수 없고, Bearer 헤더로 보낸다', async () => {
  assert.throws(() => createClient({ token: '' }), HubSpotError);
  const f = fakeFetch({ 'GET /account-info/v3/details': { portalId: 123, uiDomain: 'app-na2.hubspot.com', timeZone: 'US/Eastern' } });
  const hs = createClient({ token: 'pat-test', fetch: f.fetchImpl });
  const s = await hs.status();
  assert.deepEqual([s.ok, s.portalId, s.uiDomain, s.via], [true, '123', 'app-na2.hubspot.com', 'account-info']);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer pat-test');
});

test('account-info 스코프가 없으면(403) 연락처 1건 조회로 연결을 확인한다 · 401 은 그대로 실패', async () => {
  const f = fakeFetch({
    'GET /account-info/v3/details': new Response(JSON.stringify({ message: 'missing scope' }), { status: 403 }),
    'GET /crm/v3/objects/contacts': { results: [] }
  });
  const hs = createClient({ token: 't', fetch: f.fetchImpl });
  assert.equal((await hs.status()).via, 'contacts');
  const bad = fakeFetch({ 'GET /account-info/v3/details': new Response(JSON.stringify({ message: 'expired token', category: 'EXPIRED_AUTHENTICATION' }), { status: 401 }) });
  await assert.rejects(createClient({ token: 't', fetch: bad.fetchImpl }).status(), e => e instanceof HubSpotError && e.status === 401 && /expired/.test(e.message));
});

test('파이프라인은 displayOrder 로 정렬돼 돌아온다', async () => {
  const f = fakeFetch({ 'GET /crm/v3/pipelines/deals': { results: [
    { id: 'b', label: '학원 등록', displayOrder: 1, stages: [{ id: 's2', label: '활성', displayOrder: 1 }, { id: 's1', label: '트라이얼', displayOrder: 0 }] },
    { id: 'a', label: '검사 여정', displayOrder: 0, stages: [] }
  ] } });
  const p = await createClient({ token: 't', fetch: f.fetchImpl }).pipelines();
  assert.deepEqual(p.map(x => x.id), ['a', 'b']);
  assert.deepEqual(p[1].stages.map(s => s.id), ['s1', 's2']);
});

test('속성 점검·생성 — 없는 것만 만들고 enum 옵션을 붙인다', async () => {
  const f = fakeFetch({
    'GET /crm/v3/properties/contacts': { results: WB_PROPERTY_NAMES.filter(n => n !== 'wb_child_name' && n !== 'wb_lost_reason').map(n => ({ name: n, label: n, type: 'string' })) },
    'POST /crm/v3/properties/contacts': call => ({ name: call.body.name })
  });
  const hs = createClient({ token: 't', fetch: f.fetchImpl });
  const check = await hs.checkProperties();
  assert.deepEqual(check.missing, ['wb_child_name', 'wb_lost_reason']);
  const made = await hs.ensureProperties();
  assert.deepEqual(made.created, ['wb_child_name', 'wb_lost_reason']);
  const posts = f.calls.filter(c => c.key === 'POST /crm/v3/properties/contacts');
  assert.equal(posts.length, 2);
  assert.deepEqual(made.updated, []);
  assert.equal(posts[0].body.groupName, 'contactinformation');
  assert.deepEqual(posts[1].body.options.map(o => o.value), ['P', 'T', 'C', 'W', 'N', 'U']);
  assert.ok(posts[1].body.options.every(o => o.hidden === false && typeof o.displayOrder === 'number'));
});

test('ensureProperties — 이미 있는 선택형 속성에 빠진 선택지(파트너)를 PATCH 로 더하고 기존 선택지는 지킨다', async () => {
  const f = fakeFetch({
    'GET /crm/v3/properties/contacts': { results: WB_PROPERTY_NAMES.map(n => (n === 'wb_source_channel'
      ? { name: n, type: 'enumeration', options: [{ label: '맘카페', value: '맘카페' }, { label: '센터폰', value: '센터폰' }, { label: '옛채널', value: '옛채널' }] }
      : { name: n, type: 'string', options: ((WB_PROPERTIES.find(p => p.name === n) || {}).options || []).map(v => (typeof v === 'string' ? { label: v, value: v } : v)) })) },
    'PATCH /crm/v3/properties/contacts/wb_source_channel': call => ({ name: 'wb_source_channel', options: call.body.options })
  });
  const made = await createClient({ token: 't', fetch: f.fetchImpl }).ensureProperties();
  assert.deepEqual([made.created, made.updated, made.failed], [[], ['wb_source_channel'], []]);
  const patch = f.calls.find(c => c.key === 'PATCH /crm/v3/properties/contacts/wb_source_channel');
  const values = patch.body.options.map(o => o.value);
  assert.ok(values.includes('옛채널') && values.includes('파트너') && values.includes('맘카페'));
  assert.equal(values.length, 3 + (8 - 2), '기존 3 + 빠진 6');
  assert.ok(patch.body.options.every((o, i) => o.displayOrder === i));
});

test('findContact — 전화 두 꼴(+국제)과 이메일을 OR 그룹으로 검색하고 첫 결과를 준다', async () => {
  const f = fakeFetch({ 'POST /crm/v3/objects/contacts/search': { total: 1, results: [{ id: '77', properties: { firstname: 'A' } }] } });
  const hs = createClient({ token: 't', fetch: f.fetchImpl });
  const found = await hs.findContact('010-0000-0000', 'a@b.co');
  assert.equal(found.id, '77');
  const groups = f.calls[0].body.filterGroups;
  assert.ok(groups.length <= 5);
  const values = groups.map(g => g.filters[0].value);
  assert.ok(values.includes('01000000000') && values.includes('010-0000-0000'));
  assert.equal(await hs.findContact('', ''), null);
});

test('연락처·딜·노트 쓰기 — 경로·연결(association typeId 3·202)·본문', async () => {
  const f = fakeFetch({
    'POST /crm/v3/objects/contacts': { id: '100', properties: {} },
    'PATCH /crm/v3/objects/contacts/100': { id: '100', properties: { phone: 'x' } },
    'POST /crm/v3/objects/deals': { id: '500', properties: {} },
    'PATCH /crm/v3/objects/deals/500': { id: '500', properties: {} },
    'POST /crm/v3/objects/notes': { id: '900', properties: {} }
  });
  const hs = createClient({ token: 't', fetch: f.fetchImpl });
  assert.equal((await hs.createContact({ firstname: 'A' })).id, '100');
  assert.equal((await hs.updateContact('100', { phone: 'x' })).id, '100');
  const deal = await hs.createDeal({ dealname: 'd', pipeline: 'default', dealstage: 'appointmentscheduled' }, '100');
  assert.equal(deal.id, '500');
  const dealCall = f.calls.find(c => c.key === 'POST /crm/v3/objects/deals');
  assert.equal(dealCall.body.associations[0].types[0].associationTypeId, 3);
  assert.equal(dealCall.body.associations[0].to.id, '100');
  await hs.updateDeal('500', { dealstage: 'closedwon' });
  const note = await hs.createNote('<p>hi</p>', 1700000000000, '100');
  assert.equal(note.id, '900');
  const noteCall = f.calls.find(c => c.key === 'POST /crm/v3/objects/notes');
  assert.equal(noteCall.body.associations[0].types[0].associationTypeId, 202);
  assert.equal(noteCall.body.properties.hs_timestamp, '1700000000000');
});

test('변경분 가져오기 — since 필터·없는 속성 제외·페이지 커서, 연락처의 딜 묶음 읽기', async () => {
  const f = fakeFetch({
    'POST /crm/v3/objects/contacts/search': call => ({ total: 2, results: [{ id: '1', properties: { firstname: 'A' } }], paging: call.body.after ? undefined : { next: { after: '1' } } }),
    'POST /crm/v4/associations/contacts/deals/batch/read': { results: [{ from: { id: '1' }, to: [{ toObjectId: 500 }, { toObjectId: 501 }] }] },
    'POST /crm/v3/objects/deals/batch/read': { results: [{ id: '500', properties: { pipeline: 'default', dealstage: 'closedwon' } }, { id: '501', properties: { pipeline: 'x', dealstage: 'y' } }] }
  });
  const hs = createClient({ token: 't', fetch: f.fetchImpl });
  const available = new Set(['wb_source_channel']);
  const page1 = await hs.contactsModifiedSince(1700000000000, '', available);
  assert.deepEqual([page1.total, page1.results.length, page1.after], [2, 1, '1']);
  const body = f.calls[0].body;
  assert.equal(body.filterGroups[0].filters[0].propertyName, 'lastmodifieddate');
  assert.equal(body.filterGroups[0].filters[0].value, '1700000000000');
  assert.ok(body.properties.includes('wb_source_channel') && !body.properties.includes('wb_child_name') && body.properties.includes('firstname'));
  const page2 = await hs.contactsModifiedSince(1700000000000, '1', available);
  assert.equal(page2.after, '');
  const full = await hs.contactsModifiedSince(0, '', null);
  assert.equal(f.calls[2].body.filterGroups[0].filters[0].operator, 'HAS_PROPERTY');
  assert.ok(f.calls[2].body.properties.includes('wb_child_name'));
  assert.equal(full.results.length, 1);
  assert.deepEqual(await hs.dealIdsForContacts(['1', '1']), { 1: ['500', '501'] });
  const deals = await hs.readDeals(['500', '501']);
  assert.deepEqual(deals.map(d => d.id), ['500', '501']);
});

test('contactProperties — 이름은 HubSpot 성·이름 합친 것과 같으면 보내지 않고, 없는 속성은 뺀다, 성사 때만 customer', () => {
  const lead = { id: 'l1', name: '김보호', phone: '01000000000', email: 'A@B.CO', channel: '당근', child: { name: '아이', grade: '초3' }, inspection: { type: 'LCSI', date: '2026-09-01' },
    consultedAt: '2026-09-02', retestDue: '2028-08-31', status: 'won', outcome: { status: 'won' }, academyStatus: '재원', hubspot: { nameParts: { firstname: '보호', lastname: '김' } } };
  const p = contactProperties(lead, { creditBalance: 30000, referrerContactId: '9' }, new Set(['wb_source_channel', 'wb_credit_balance', 'wb_referrer_contact_id', 'wb_academy_status']));
  assert.equal(p.firstname, undefined);
  assert.deepEqual([p.phone, p.email, p.wb_source_channel, p.wb_credit_balance, p.wb_referrer_contact_id, p.wb_academy_status, p.lifecyclestage],
    ['010-0000-0000', 'a@b.co', '당근', '30000', '9', '재원', 'customer']);
  assert.equal(p.wb_child_name, undefined, '포털에 없는 속성은 보내지 않는다');
  const renamed = contactProperties(Object.assign({}, lead, { name: '박보호', status: 'open', outcome: null }), {}, null);
  assert.equal(renamed.firstname, '박보호');
  assert.equal(renamed.lifecyclestage, undefined);
  assert.equal(renamed.wb_lost_reason, '');
  assert.equal(renamed.wb_child_name, '아이');
  assert.equal(contactProperties({ name: 'x', academyStatus: '몰라' }, {}, null).wb_academy_status, undefined);
  assert.equal(contactProperties({ name: 'x', channel: '파트너' }, { partnerName: '가나수학' }, null).wb_partner, '가나수학');
  assert.equal(contactProperties({ name: 'x' }, {}, null).wb_partner, undefined);
});

test('leadFromContact — 성+이름, 전화 정규화, 날짜 두 형식, 기존 리드의 기록·메모는 보존', () => {
  const contact = { id: '77', updatedAt: '2026-10-01T00:00:00Z', properties: {
    firstname: '보호', lastname: '김', mobilephone: '01000000000', email: 'A@B.CO', wb_source_channel: '블로그', wb_child_birth: '1500000000000',
    wb_inspection_date: '2026-09-01', wb_inspection_type: '웩슬러', wb_consult_date: '2026-09-02T00:00:00Z', wb_credit_balance: '15000',
    wb_academy_status: '트라이얼', wb_referrer_contact_id: '5', createdate: '2026-08-30T10:00:00Z', lastmodifieddate: '1759276800000'
  } };
  const fresh = leadFromContact(contact, null, { today: '2026-10-06' });
  assert.deepEqual([fresh.name, fresh.phone, fresh.email, fresh.channel, fresh.createdAt, fresh.pipeline, fresh.stage],
    ['김보호', '010-0000-0000', 'a@b.co', '블로그', '2026-08-30', 'inspection', 'inquiry']);
  assert.equal(fresh.child.birth, '2017-07-14');
  assert.deepEqual([fresh.inspection.type, fresh.inspection.date, fresh.consultedAt, fresh.creditBalanceHs, fresh.academyStatus], ['웩슬러', '2026-09-01', '2026-09-02', 15000, '트라이얼']);
  assert.deepEqual([fresh.hubspot.contactId, fresh.hubspot.nameParts, fresh.hubspot.referrerContactId, fresh.hubspot.hsUpdatedAt], ['77', { firstname: '보호', lastname: '김' }, '5', 1759276800000]);
  const existing = { name: '옛이름', memo: '중요 메모', followups: [{ day: 3 }], channel: '맘카페', hubspot: { contactId: '77', deals: { inspection: { dealId: '1' } } } };
  const merged = leadFromContact({ id: '77', properties: { firstname: 'A', wb_source_channel: '없는값' } }, existing);
  assert.deepEqual([merged.name, merged.memo, merged.followups.length, merged.channel, merged.hubspot.deals.inspection.dealId], ['A', '중요 메모', 1, '맘카페', '1']);
  assert.equal(existing.memo, '중요 메모', '원본을 바꾸지 않는다');
  const nameless = leadFromContact({ id: '9', properties: { email: 'x@y.z' } }, null);
  assert.equal(nameless.name, 'x@y.z');
  assert.equal(hsDate('garbage'), '');
});

test('applyDealsToLead — 매핑된 파이프라인의 최신 딜로 단계를 정하고, 학원 등록 딜이 있으면 그쪽이 현재', () => {
  const map = { inspection: { pipelineId: 'default', stageMap: { tested: 'decisionmakerboughtin', won: 'closedwon' } }, academy: { pipelineId: '22', stageMap: { trial: 'a1' } } };
  const lead = { pipeline: 'inspection', stage: 'inquiry', status: 'open', hubspot: { contactId: '1' } };
  const one = applyDealsToLead(JSON.parse(JSON.stringify(lead)), [
    { id: '500', properties: { pipeline: 'default', dealstage: 'decisionmakerboughtin', hs_lastmodifieddate: '2026-09-01T00:00:00Z' } },
    { id: '501', properties: { pipeline: 'default', dealstage: 'closedwon', hs_lastmodifieddate: '2026-09-10T00:00:00Z' } }
  ], map);
  assert.deepEqual([one.pipeline, one.stage, one.status, one.stageAt, one.hubspot.deals.inspection.dealId], ['inspection', 'won', 'won', '2026-09-10', '501']);
  const two = applyDealsToLead(JSON.parse(JSON.stringify(lead)), [
    { id: '501', properties: { pipeline: 'default', dealstage: 'closedwon', hs_lastmodifieddate: '2026-09-10T00:00:00Z' } },
    { id: '600', properties: { pipeline: '22', dealstage: 'a1', hs_lastmodifieddate: '2026-09-11T00:00:00Z' } }
  ], map);
  assert.deepEqual([two.pipeline, two.stage, two.status, two.hubspot.deals.academy.dealId, two.hubspot.deals.inspection.dealId], ['academy', 'trial', 'open', '600', '501']);
  const unknown = applyDealsToLead(JSON.parse(JSON.stringify(lead)), [{ id: '7', properties: { pipeline: 'default', dealstage: 'zzz' } }], map);
  assert.deepEqual([unknown.pipeline, unknown.stage, unknown.hubspot.deals.inspection.stage], ['inspection', 'inquiry', '']);
  const none = applyDealsToLead(JSON.parse(JSON.stringify(lead)), [], map);
  assert.equal(none.stage, 'inquiry');
});

test('노트 본문·딜 이름', () => {
  const html = noteBody({ type: 'consult', result: 'reached', text: '첫 줄 <b>\n둘째 줄', at: '2026-10-05', followupDay: 3 }, '직원A');
  assert.ok(html.includes('[상담]') && html.includes('연락됨') && html.includes('D+3 팔로업1') && html.includes('직원A') && html.includes('2026-10-05'));
  assert.ok(html.includes('첫 줄 &lt;b&gt;<br>둘째 줄'), 'HTML 은 이스케이프, 줄바꿈은 <br>');
  assert.ok(noteBody({ type: 'stage', from: 'inquiry', to: 'booked' }, '').includes('신규문의 → 예약확정'));
  assert.equal(dealName({ name: '보호자A', child: { name: '아이' } }, 'inspection'), '보호자A · 아이 · 검사 여정');
});
