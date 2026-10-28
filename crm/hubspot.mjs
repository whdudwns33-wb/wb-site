// WB 세일즈데스크 — HubSpot 연동 클라이언트. 표준 fetch/Request/Response 만 쓴다(워커·Node 22 공용, node: 모듈 없음).
// 토큰은 호출자가 env.HUBSPOT_ACCESS_TOKEN(워커 시크릿)에서 꺼내 넘긴다 — 이 파일은 토큰을 저장하거나 로그에 남기지 않는다.
// fetch 는 주입받는다(테스트가 가짜 fetch 로 요청을 기록). 비즈니스 판단(단계·팔로업)은 crm-core 가 하고 여기는 데이터 변환·전송만.
//
// 쓰는 API(HubSpot CRM v3/v4, Private App 토큰):
//   GET  /account-info/v3/details                         연결 확인·포털 id(화면 링크용)
//   GET  /crm/v3/pipelines/deals                          딜 파이프라인·단계 → 자동 매핑(crm-core.autoMapPipeline)
//   GET  /crm/v3/properties/contacts · POST 같은 경로      WB 사용자 속성 점검·생성
//   POST /crm/v3/objects/contacts/search                  전화·이메일 중복 찾기, 변경분 가져오기(lastmodifieddate)
//   POST /crm/v3/objects/contacts · PATCH /{id}           연락처 만들기·갱신
//   POST /crm/v3/objects/deals · PATCH /{id}              딜 만들기(연락처 연결 typeId 3)·단계 갱신
//   POST /crm/v3/objects/notes                            상담·CS 기록을 노트로(연락처 연결 typeId 202)
//   POST /crm/v4/associations/contacts/deals/batch/read   가져오기 때 연락처의 딜 찾기
//   POST /crm/v3/objects/deals/batch/read                 그 딜의 파이프라인·단계
import CORE from './crm-core.js';

export const DEFAULT_BASE = 'https://api.hubapi.com';
const ASSOC_DEAL_TO_CONTACT = 3;
const ASSOC_NOTE_TO_CONTACT = 202;
const PAGE = 100;

/* WB 사용자 속성 — 포털에 없는 것만 만든다(원장이 [없는 속성 만들기]를 눌렀을 때). 이미 있는 속성의 옵션은 건드리지 않는다. */
export const WB_PROPERTIES = [
  { name: 'wb_source_channel', label: 'WB 유입 채널', type: 'enumeration', fieldType: 'select', options: CORE.CHANNELS },
  { name: 'wb_academy_status', label: 'WB 학원 등록 상태', type: 'enumeration', fieldType: 'select', options: CORE.ACADEMY_STATUS },
  { name: 'wb_credit_balance', label: 'WB 소개 크레딧 잔액', type: 'number', fieldType: 'number' },
  { name: 'wb_referrer_contact_id', label: 'WB 소개자 Contact ID', type: 'string', fieldType: 'text' },
  { name: 'wb_retest_due_date', label: 'WB 재검사 예정일', type: 'date', fieldType: 'date' },
  { name: 'wb_risk_signals', label: 'WB 이탈 위험 신호', type: 'string', fieldType: 'text' },
  { name: 'wb_inspection_type', label: 'WB 검사 종류', type: 'enumeration', fieldType: 'select', options: CORE.INSPECTION_TYPES },
  { name: 'wb_inspection_date', label: 'WB 검사일', type: 'date', fieldType: 'date' },
  { name: 'wb_child_birth', label: 'WB 자녀 생년월일', type: 'date', fieldType: 'date' },
  { name: 'wb_child_name', label: 'WB 자녀 이름', type: 'string', fieldType: 'text' },
  { name: 'wb_child_grade', label: 'WB 자녀 학년', type: 'string', fieldType: 'text' },
  { name: 'wb_consult_date', label: 'WB 상담 완료일', type: 'date', fieldType: 'date' },
  { name: 'wb_lost_reason', label: 'WB 이탈 사유', type: 'enumeration', fieldType: 'select',
    options: CORE.LOST_REASONS.map(code => ({ value: code, label: code + ' ' + CORE.LOST_REASON_LABEL[code] })) },
  { name: 'wb_crm_lead_id', label: 'WB 세일즈데스크 리드 ID', type: 'string', fieldType: 'text' },
  { name: 'wb_partner', label: 'WB 연계 파트너 학원', type: 'string', fieldType: 'text' }
];
export const WB_PROPERTY_NAMES = WB_PROPERTIES.map(p => p.name);
/* 가져오기 때 읽는 표준 속성 */
const STANDARD_PROPERTIES = ['firstname', 'lastname', 'phone', 'mobilephone', 'email', 'createdate', 'lastmodifieddate', 'lifecyclestage'];
const DEAL_PROPERTIES = ['dealname', 'pipeline', 'dealstage', 'closedate', 'hs_lastmodifieddate'];
const ACADEMY_STATUS = new Set(CORE.ACADEMY_STATUS);

export class HubSpotError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'HubSpotError';
    this.status = Number(status) || 0;
    this.body = body === undefined ? null : body;
  }
}

function str(v) { return v == null ? '' : String(v); }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function esc(s) { return str(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** HubSpot 날짜·일시 값 → 'YYYY-MM-DD'. 문자열 ISO 와 ms 숫자열 둘 다 온다. */
export function hsDate(value) {
  const s = str(value).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^-?\d+$/.test(s)) { const d = new Date(Number(s)); return isNaN(d) ? '' : d.toISOString().slice(0, 10); }
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}
function hsMs(value) {
  const s = str(value).trim();
  if (!s) return 0;
  if (/^-?\d+$/.test(s)) return Number(s);
  const d = new Date(s);
  return isNaN(d) ? 0 : d.getTime();
}

/* ── 클라이언트 ─────────────────────────────────────────────────────── */

export function createClient(options) {
  const o = isObj(options) ? options : {};
  const token = str(o.token);
  const base = str(o.base || DEFAULT_BASE).replace(/\/+$/, '');
  const fetchImpl = typeof o.fetch === 'function' ? o.fetch : globalThis.fetch;
  if (!token) throw new HubSpotError('HubSpot 토큰이 없습니다 (HUBSPOT_ACCESS_TOKEN)', 0);

  async function request(method, path, body) {
    const init = { method, signal: AbortSignal.timeout(20000), redirect: 'manual', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let response;
    try { response = await fetchImpl(base + path, init); }
    catch (error) { throw new HubSpotError('HubSpot 연결 결과를 확인하지 못했습니다', 0); }
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (error) { json = null; }
    if (!response.ok) {
      const message = (json && (json.message || (json.errors && json.errors[0] && json.errors[0].message))) || ('HTTP ' + response.status);
      // 토큰 값은 메시지에 섞이지 않는다(HubSpot 응답은 토큰을 되돌려 주지 않지만, 혹시 몰라 잘라 둔다).
      throw new HubSpotError(str(message).slice(0, 300), response.status, json);
    }
    return json;
  }

  /** 연결 확인 — 포털 정보(id·화면 도메인·시간대). account-info 스코프가 없으면 연락처 1건 조회로 대신 확인한다. */
  async function status() {
    try {
      const info = await request('GET', '/account-info/v3/details');
      return { ok: true, portalId: str(info && info.portalId), uiDomain: str(info && info.uiDomain), timeZone: str(info && info.timeZone), via: 'account-info' };
    } catch (error) {
      if (!(error instanceof HubSpotError) || (error.status !== 403 && error.status !== 404)) throw error;
      await request('GET', '/crm/v3/objects/contacts?limit=1&properties=hs_object_id');
      return { ok: true, portalId: '', uiDomain: '', timeZone: '', via: 'contacts' };
    }
  }

  async function pipelines() {
    const res = await request('GET', '/crm/v3/pipelines/deals');
    return (res && Array.isArray(res.results) ? res.results : []).map(p => ({
      id: str(p.id), label: str(p.label), displayOrder: Number(p.displayOrder) || 0,
      stages: (Array.isArray(p.stages) ? p.stages : []).map(s => ({ id: str(s.id), label: str(s.label), displayOrder: Number(s.displayOrder) || 0 }))
        .sort((a, b) => a.displayOrder - b.displayOrder)
    })).sort((a, b) => a.displayOrder - b.displayOrder);
  }

  async function listContactProperties() {
    const res = await request('GET', '/crm/v3/properties/contacts');
    return (res && Array.isArray(res.results) ? res.results : []).map(p => ({
      name: str(p.name), label: str(p.label), type: str(p.type), fieldType: str(p.fieldType),
      // hidden·description 을 지켜야 선택지를 덧붙이는 PATCH 가 원장이 숨긴 옛 선택지를 되살리지 않는다
      options: (Array.isArray(p.options) ? p.options : []).map(x => ({ value: str(x.value), label: str(x.label), hidden: !!x.hidden, description: str(x.description) }))
    }));
  }

  /** WB 속성 점검 → { present:[name], missing:[name], all:[...] } */
  async function checkProperties() {
    const list = await listContactProperties();
    const names = new Set(list.map(p => p.name));
    return { present: WB_PROPERTY_NAMES.filter(n => names.has(n)), missing: WB_PROPERTY_NAMES.filter(n => !names.has(n)), available: names };
  }

  function optionRows(options) {
    return options.map((opt, i) => (typeof opt === 'string' ? { label: opt, value: opt, displayOrder: i, hidden: false } : { label: opt.label, value: opt.value, displayOrder: i, hidden: false }));
  }

  /** 없는 WB 속성을 만들고, 이미 있는 선택형 속성에 빠진 선택지(예: wb_source_channel 의 '파트너')를 더한다.
   *  돌려주는 값 { created:[name], updated:[name], failed:[{name,error}], present:[name] }. 기존 선택지·라벨은 건드리지 않는다. */
  async function ensureProperties() {
    const list = await listContactProperties();
    const names = new Set(list.map(p => p.name));
    const check = { present: WB_PROPERTY_NAMES.filter(n => names.has(n)), missing: WB_PROPERTY_NAMES.filter(n => !names.has(n)) };
    const created = [], updated = [], failed = [];
    for (const spec of WB_PROPERTIES) {
      if (!spec.options || !names.has(spec.name)) continue;
      const existing = list.find(p => p.name === spec.name);
      const have = new Set(existing.options.map(o => o.value));
      const missing = spec.options.filter(opt => !have.has(typeof opt === 'string' ? opt : opt.value));
      if (!missing.length) continue;
      const options = existing.options.map((o, i) => Object.assign({ label: o.label || o.value, value: o.value, displayOrder: i, hidden: !!o.hidden }, o.description ? { description: o.description } : {}))
        .concat(optionRows(missing).map((o, i) => Object.assign(o, { displayOrder: existing.options.length + i })));
      try { await request('PATCH', '/crm/v3/properties/contacts/' + encodeURIComponent(spec.name), { options }); updated.push(spec.name); }
      catch (error) { failed.push({ name: spec.name, error: str(error && error.message || error) }); }
    }
    for (const name of check.missing) {
      const spec = WB_PROPERTIES.find(p => p.name === name);
      const body = { name: spec.name, label: spec.label, type: spec.type, fieldType: spec.fieldType, groupName: 'contactinformation', description: 'WB 세일즈데스크가 쓰는 값' };
      if (spec.options) body.options = optionRows(spec.options);
      try { await request('POST', '/crm/v3/properties/contacts', body); created.push(name); }
      catch (error) { failed.push({ name, error: str(error && error.message || error) }); }
    }
    return { created, updated, failed, present: check.present.concat(created) };
  }

  async function searchContacts(filterGroups, properties, after, limit) {
    const body = { filterGroups, properties, limit: Math.min(Number(limit) || PAGE, 200),
      sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }] };
    if (after) body.after = str(after);
    const res = await request('POST', '/crm/v3/objects/contacts/search', body);
    return {
      total: Number(res && res.total) || 0,
      results: (res && Array.isArray(res.results) ? res.results : []).map(normalizeObject),
      after: str(res && res.paging && res.paging.next && res.paging.next.after)
    };
  }

  /** 이메일·전화로 이미 있는 연락처를 찾는다 — 만들기 전에 꼭 부른다(중복 생성 방지). 검색 API 는 OR 그룹을 5개까지만 받으므로
   *  이메일(유일 키)을 첫 자리에 두고, 전화는 HubSpot 이 서식을 벗겨 저장하는 계산 속성(hs_searchable_calculated_*)에 숫자만으로,
   *  그리고 우리 표기(010-0000-0000)로 phone·mobilephone 을 한 번 더 본다. */
  async function findContact(phone, email) {
    const groups = [];
    if (CORE.validEmail(email)) groups.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: str(email).toLowerCase() }] });
    const digits = str(phone).replace(/\D/g, '');
    if (digits) {
      const dashed = CORE.normalizePhone(digits);
      groups.push({ filters: [{ propertyName: 'hs_searchable_calculated_phone_number', operator: 'EQ', value: digits }] });
      groups.push({ filters: [{ propertyName: 'hs_searchable_calculated_mobile_number', operator: 'EQ', value: digits }] });
      groups.push({ filters: [{ propertyName: 'phone', operator: 'EQ', value: dashed }] });
      groups.push({ filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: dashed }] });
    }
    if (!groups.length) return null;
    const res = await searchContacts(groups.slice(0, 5), ['firstname', 'lastname', 'phone', 'mobilephone', 'email'], '', 5);
    return res.results[0] || null;
  }

  /** 연락처 id 들을 속성과 함께 읽는다(가져오기에서 건너뛴 연락처를 다음에 다시 볼 때). */
  async function readContacts(contactIds, available) {
    const ids = [...new Set((Array.isArray(contactIds) ? contactIds : []).map(str).filter(Boolean))];
    const props = STANDARD_PROPERTIES.concat(WB_PROPERTY_NAMES.filter(n => !available || available.has(n)));
    const out = [];
    for (let i = 0; i < ids.length; i += PAGE) {
      const res = await request('POST', '/crm/v3/objects/contacts/batch/read', { inputs: ids.slice(i, i + PAGE).map(id => ({ id })), properties: props });
      (res && Array.isArray(res.results) ? res.results : []).forEach(c => out.push(normalizeObject(c)));
    }
    return out;
  }

  async function createContact(properties) { return normalizeObject(await request('POST', '/crm/v3/objects/contacts', { properties })); }
  async function updateContact(id, properties) { return normalizeObject(await request('PATCH', '/crm/v3/objects/contacts/' + encodeURIComponent(str(id)), { properties })); }

  async function createDeal(properties, contactId) {
    const body = { properties };
    if (contactId) body.associations = [{ to: { id: str(contactId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC_DEAL_TO_CONTACT }] }];
    return normalizeObject(await request('POST', '/crm/v3/objects/deals', body));
  }
  async function updateDeal(id, properties) { return normalizeObject(await request('PATCH', '/crm/v3/objects/deals/' + encodeURIComponent(str(id)), { properties })); }

  async function createNote(bodyHtml, timestampMs, contactId) {
    const body = {
      properties: { hs_timestamp: String(Number(timestampMs) || Date.now()), hs_note_body: str(bodyHtml).slice(0, 60000) },
      associations: [{ to: { id: str(contactId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC_NOTE_TO_CONTACT }] }]
    };
    return normalizeObject(await request('POST', '/crm/v3/objects/notes', body));
  }

  /** 변경분 가져오기 — sinceMs 이후 수정된 연락처 한 페이지. available 은 포털에 있는 속성 이름 집합(없는 속성을 청하면 400). */
  async function contactsModifiedSince(sinceMs, after, available, untilMs, limit) {
    const props = STANDARD_PROPERTIES.concat(WB_PROPERTY_NAMES.filter(n => !available || available.has(n)));
    const filterGroups = sinceMs > 0 ? [{ filters: [{ propertyName: 'lastmodifieddate', operator: 'GTE', value: String(sinceMs) }] }]
      : [{ filters: [{ propertyName: 'hs_object_id', operator: 'HAS_PROPERTY' }] }];
    if (untilMs) filterGroups[0].filters.push({ propertyName: 'lastmodifieddate', operator: 'LTE', value: String(untilMs) });
    return searchContacts(filterGroups, props, after, limit || PAGE);
  }

  /** 전체 보정은 검색 인덱스 대신 기본 목록의 객체 커서를 사용한다. */
  async function listContacts(after, available, limit = 25) {
    const properties = STANDARD_PROPERTIES.concat(WB_PROPERTY_NAMES.filter(n => !available || available.has(n)));
    const query = new URLSearchParams({ limit: String(limit), properties: properties.join(',') });
    if (after) query.set('after', str(after));
    const result = await request('GET', '/crm/v3/objects/contacts?' + query);
    return { total: 0, results: (Array.isArray(result?.results) ? result.results : []).map(normalizeObject), after: str(result?.paging?.next?.after) };
  }

  /** 연락처 id 들의 딜 — { contactId: [dealId] } */
  async function dealIdsForContacts(contactIds) {
    const ids = [...new Set((Array.isArray(contactIds) ? contactIds : []).map(str).filter(Boolean))];
    const out = {};
    for (let i = 0; i < ids.length; i += PAGE) {
      const res = await request('POST', '/crm/v4/associations/contacts/deals/batch/read', { inputs: ids.slice(i, i + PAGE).map(id => ({ id })) });
      (res && Array.isArray(res.results) ? res.results : []).forEach(row => {
        const from = str(row && row.from && row.from.id);
        out[from] = (Array.isArray(row.to) ? row.to : []).map(t => str(t.toObjectId || (t.to && t.to.id))).filter(Boolean);
      });
    }
    return out;
  }

  async function readDeals(dealIds) {
    const ids = [...new Set((Array.isArray(dealIds) ? dealIds : []).map(str).filter(Boolean))];
    const out = [];
    for (let i = 0; i < ids.length; i += PAGE) {
      const res = await request('POST', '/crm/v3/objects/deals/batch/read', { inputs: ids.slice(i, i + PAGE).map(id => ({ id })), properties: DEAL_PROPERTIES });
      (res && Array.isArray(res.results) ? res.results : []).forEach(d => out.push(normalizeObject(d)));
    }
    return out;
  }

  return { request, status, pipelines, listContactProperties, checkProperties, ensureProperties, searchContacts, findContact, readContacts,
    createContact, updateContact, createDeal, updateDeal, createNote, contactsModifiedSince, listContacts, dealIdsForContacts, readDeals };
}

function normalizeObject(obj) {
  const o = isObj(obj) ? obj : {};
  return { id: str(o.id), properties: isObj(o.properties) ? o.properties : {}, updatedAt: str(o.updatedAt), createdAt: str(o.createdAt) };
}

/* ── 리드 ↔ 연락처 변환 ───────────────────────────────────────────────── */

/**
 * 리드 → 연락처 속성. available 이 있으면 포털에 없는 wb_* 는 뺀다(없는 속성을 쓰면 400).
 * extra: { creditBalance, referrerContactId } — 호출자가 DB 에서 계산해 넘긴다.
 * 이름은 HubSpot 쪽이 성·이름으로 나눠 가진 것과 합쳐서 같으면 건드리지 않는다(가져온 뒤 다시 밀어 넣을 때 덮어쓰지 않게).
 */
export function contactProperties(lead, extra, available) {
  const L = isObj(lead) ? lead : {};
  const x = isObj(extra) ? extra : {};
  const child = isObj(L.child) ? L.child : {};
  const ins = isObj(L.inspection) ? L.inspection : {};
  const hs = isObj(L.hubspot) ? L.hubspot : {};
  const props = {};
  const parts = isObj(hs.nameParts) ? hs.nameParts : null;
  const combined = parts ? (str(parts.lastname) + str(parts.firstname)).replace(/\s+/g, '') : '';
  // 보호자 이름 미입력은 원격 이름 삭제가 아니다. 학생 이름도 연락처 이름으로 대신 쓰지 않는다.
  if (str(L.name).trim() && (!parts || combined !== str(L.name).replace(/\s+/g, ''))) { props.firstname = str(L.name); props.lastname = ''; }
  props[hs.phoneSource === 'mobilephone' ? 'mobilephone' : 'phone'] = CORE.normalizePhone(L.phone);
  props.email = str(L.email).toLowerCase();
  const wb = {
    wb_source_channel: CORE.CHANNELS.includes(L.channel) ? L.channel : '기타',
    wb_child_name: str(child.name), wb_child_birth: str(child.birth), wb_child_grade: str(child.grade),
    wb_inspection_type: CORE.INSPECTION_TYPES.includes(ins.type) ? ins.type : '', wb_inspection_date: str(ins.date),
    wb_consult_date: str(L.consultedAt), wb_retest_due_date: str(L.retestDue),
    wb_lost_reason: L.status === 'lost' && isObj(L.outcome) && CORE.LOST_REASONS.includes(L.outcome.reason) ? L.outcome.reason : '',
    wb_crm_lead_id: str(L.id)
  };
  const academyStatus = CORE.academyStatusOf(L);
  if (!academyStatus || ACADEMY_STATUS.has(academyStatus)) wb.wb_academy_status = academyStatus;
  if (x.referrerContactId !== undefined) wb.wb_referrer_contact_id = str(x.referrerContactId);
  if (x.partnerName !== undefined) wb.wb_partner = str(x.partnerName);
  if (Number.isFinite(Number(x.creditBalance)) && x.creditBalance !== null && x.creditBalance !== undefined) wb.wb_credit_balance = String(Math.round(Number(x.creditBalance)));
  Object.keys(wb).forEach(k => { if (!available || available.has(k)) props[k] = wb[k]; });
  if (L.status === 'won') props.lifecyclestage = 'customer';   // 뒤로는 못 돌리는 값이라 성사 때만 올린다
  return props;
}

/** 변경한 필드만 보낸다 — 연락처 수정이 외부 크레딧·소개자·파트너 값을 덮지 않게 한다. */
export function contactPatchProperties(lead, extra, available, fields) {
  const properties = contactProperties(lead, extra, available);
  const map = {
    name: ['firstname', 'lastname'], phone: ['phone', 'mobilephone'], email: ['email'], channel: ['wb_source_channel'],
    child: ['wb_child_name', 'wb_child_birth', 'wb_child_grade'], inspection: ['wb_inspection_type', 'wb_inspection_date'],
    consultedAt: ['wb_consult_date'], retestDue: ['wb_retest_due_date'], academyStatus: ['wb_academy_status'],
    status: ['wb_lost_reason', 'lifecyclestage'], outcome: ['wb_lost_reason'], referrerLeadId: ['wb_referrer_contact_id'],
    partnerId: ['wb_partner'], creditBalance: ['wb_credit_balance']
  };
  const keys = new Set((Array.isArray(fields) ? fields : []).flatMap(field => map[field] || []));
  return Object.fromEntries(Object.entries(properties).filter(([key]) => keys.has(key)));
}

/** 연락처 → 리드 필드. HubSpot 값이 이기되 빈 학생 이름은 기존 값을 보존한다. 기록·팔로업·메모는 건드리지 않는다. */
export function leadFromContact(contact, existing, ctx) {
  const c = normalizeObject(contact);
  const p = c.properties;
  const E = isObj(existing) ? existing : null;
  const today = isObj(ctx) && ctx.today ? ctx.today : new Date().toISOString().slice(0, 10);
  const lead = E ? JSON.parse(JSON.stringify(E)) : { pipeline: 'inspection', stage: 'inquiry', status: 'open', followups: [], interests: [], memo: '', source: '' };
  const legacyAcademy = lead.pipeline === 'academy' && CORE.isLegacyAcademyStage(lead.stage);
  if (legacyAcademy) lead.academyStatus = CORE.academyStatusOf(lead);
  const first = str(p.firstname).trim(), last = str(p.lastname).trim();
  const name = (last && first ? last + first : (first || last)).trim();
  if (name) lead.name = name.slice(0, 40);
  else if (!lead.name) lead.name = '';
  const phoneSource = ['phone', 'mobilephone'].includes(E?.hubspot?.phoneSource) ? E.hubspot.phoneSource : p.phone ? 'phone' : p.mobilephone ? 'mobilephone' : 'phone';
  const phone = CORE.normalizePhone(p[phoneSource]);
  if ('phone' in p || 'mobilephone' in p) lead.phone = phone;
  if ('email' in p && (!p.email || CORE.validEmail(p.email))) lead.email = str(p.email).toLowerCase();
  if (CORE.CHANNELS.includes(p.wb_source_channel)) lead.channel = p.wb_source_channel;
  else if (!lead.channel) lead.channel = '기타';
  lead.child = Object.assign({ name: '', birth: '', grade: '', school: '' }, isObj(lead.child) ? lead.child : {});
  const childName = str(p.wb_child_name).trim();
  // 원격 미입력으로 보완한 학생 이름을 지우지 않는다. 둘 다 없을 때만 확인된 보호자 표기에서 채운다.
  if (childName) lead.child.name = childName.slice(0, 40);
  else if (!str(lead.child.name).trim()) lead.child.name = CORE.leadNames(lead).student;
  if ('wb_child_birth' in p) lead.child.birth = hsDate(p.wb_child_birth);
  if ('wb_child_grade' in p) lead.child.grade = str(p.wb_child_grade).slice(0, 20);
  lead.inspection = Object.assign({ type: '', date: '' }, isObj(lead.inspection) ? lead.inspection : {});
  if ('wb_inspection_type' in p && (!p.wb_inspection_type || CORE.INSPECTION_TYPES.includes(p.wb_inspection_type))) lead.inspection.type = str(p.wb_inspection_type);
  if ('wb_inspection_date' in p) lead.inspection.date = hsDate(p.wb_inspection_date);
  if ('wb_consult_date' in p) lead.consultedAt = hsDate(p.wb_consult_date);
  if ('wb_retest_due_date' in p) lead.retestDue = hsDate(p.wb_retest_due_date);
  if ('wb_academy_status' in p && (!p.wb_academy_status || ACADEMY_STATUS.has(str(p.wb_academy_status))) && !(legacyAcademy && !p.wb_academy_status)) lead.academyStatus = str(p.wb_academy_status);
  if (!legacyAcademy && CORE.LOST_REASONS.includes(p.wb_lost_reason)) lead.outcome = { ...lead.outcome, reason: p.wb_lost_reason };
  if (p.wb_credit_balance !== undefined && p.wb_credit_balance !== null && p.wb_credit_balance !== '') lead.creditBalanceHs = Number(p.wb_credit_balance) || 0;
  if (!E) lead.createdAt = hsDate(p.createdate) || today;
  lead.hubspot = Object.assign({}, isObj(lead.hubspot) ? lead.hubspot : {}, {
    contactId: c.id, phoneSource, nameParts: { firstname: first, lastname: last }, syncedAt: Date.now(), hsUpdatedAt: hsMs(p.lastmodifieddate || c.updatedAt),
    referrerContactId: str(p.wb_referrer_contact_id)
  });
  return lead;
}

/** 가져온 딜을 리드에 얹는다 — 매핑된 파이프라인의 딜만. 학원 등록 딜이 있으면 그쪽이 현재 파이프라인. */
export function applyDealsToLead(lead, deals, map) {
  const L = isObj(lead) ? lead : {};
  const M = isObj(map) ? map : {};
  const hs = Object.assign({}, isObj(L.hubspot) ? L.hubspot : {});
  const dealsBy = Object.assign({}, isObj(hs.deals) ? hs.deals : {});
  let current = null;
  CORE.PIPELINES.forEach(p => {
    const m = isObj(M[p]) ? M[p] : null;
    if (!m || !m.pipelineId) return;
    const mine = (Array.isArray(deals) ? deals : []).map(normalizeObject).filter(d => str(d.properties.pipeline) === str(m.pipelineId))
      .sort((a, b) => hsMs(b.properties.hs_lastmodifieddate || b.updatedAt) - hsMs(a.properties.hs_lastmodifieddate || a.updatedAt));
    if (!mine.length) return;
    const d = mine[0];
    const stage = CORE.localStageFor(M, p, d.properties.dealstage);
    dealsBy[p] = { dealId: d.id, pipelineId: str(m.pipelineId), stageId: str(d.properties.dealstage), stage: stage, updatedAt: hsMs(d.properties.hs_lastmodifieddate || d.updatedAt) };
    if (stage) current = { pipeline: p, stage: stage, at: hsDate(d.properties.hs_lastmodifieddate || d.updatedAt) };
  });
  // 이전 등록 후 단계를 신규 성사로 추측하지 않는다 — 담당자가 영업 단계를 확인하면 이후부터 양방향으로 움직인다.
  if (current && !(L.pipeline === 'academy' && CORE.isLegacyAcademyStage(L.stage))) {
    if (L.pipeline !== current.pipeline || L.stage !== current.stage) L.stageAt = current.at || L.stageAt;
    L.pipeline = current.pipeline;
    L.stage = current.stage;
    L.status = CORE.statusOf(current.stage, L.status);
    if (L.status === 'open' && isObj(L.outcome) && L.outcome.status !== 'hold') L.outcome = null;
  }
  hs.deals = dealsBy;
  L.hubspot = hs;
  return L;
}

export function dealName(lead, pipeline) {
  const L = isObj(lead) ? lead : {};
  return (CORE.leadLabel(L) || '리드') + ' · ' + (CORE.PIPELINE_LABEL[pipeline] || pipeline);
}

/** 기록 → 노트 본문(HTML). 누가·언제·무엇을. */
export function noteBody(activity, byName) {
  const a = isObj(activity) ? activity : {};
  const head = ['[' + (CORE.ACTIVITY_LABEL[a.type] || a.type) + ']', a.result ? CORE.RESULT_LABEL[a.result] || a.result : '',
    a.followupDay ? 'D+' + a.followupDay + ' ' + (CORE.FOLLOWUP_LABEL[a.followupDay] || '') : '',
    a.type === 'stage' && (a.from || a.to) ? (CORE.STAGE_LABEL[a.from] || a.from || '') + ' → ' + (CORE.STAGE_LABEL[a.to] || a.to || '') : '',
    byName ? '· ' + byName : '', a.at ? '· ' + a.at : ''].filter(Boolean).join(' ');
  const body = str(a.text).split('\n').map(esc).join('<br>');
  return '<p><strong>' + esc(head) + '</strong></p>' + (body ? '<p>' + body + '</p>' : '') + '<p><em>WB 세일즈데스크</em></p>';
}
