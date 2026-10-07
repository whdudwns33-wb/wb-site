// 센터앱은 원본, 이 API는 명시한 아동 고객번호의 읽기 전용 요약만 보관한다.
import CORE from './crm-core.js';
import { DOC_ID, json, fail, isPlainObject, readJson, loadDoc, parseJson, changesOf, randomOpaqueValue } from './crm-shared.mjs';

const ORIGIN = 'https://portal.wbcowork.com';
const MAX_BYTES = 256 * 1024;
export const PORTAL_HOLD = 'PORTAL_LINKED: 센터앱 연결 고객은 센터앱에서 HubSpot에 반영합니다';
export const portalId = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const version = value => Number.isSafeInteger(value) && value >= 0;

export async function portalLinked(env, leadId) {
  return !!await env.DB.prepare('SELECT lead_id FROM crm_portal_links WHERE lead_id=?').bind(leadId).first();
}
export async function portalOwnsContact(env, contactId) {
  return !!await env.DB.prepare("SELECT lead_id FROM crm_portal_links WHERE json_extract(snapshot,'$.hubspot.contactId')=? LIMIT 1").bind(contactId).first();
}
export async function portalOwnsDeal(env, dealId) {
  return !!await env.DB.prepare("SELECT p.lead_id FROM crm_portal_links p,json_each(p.snapshot,'$.hubspot.appointments') a WHERE json_extract(a.value,'$.dealId')=? LIMIT 1").bind(dealId).first();
}
// 45초짜리 HubSpot 요청보다 긴 임대. 실패한 워커도 2분 뒤 다른 작업을 막지 않는다.
export async function claimHubspot(env, leadId) {
  const token = randomOpaqueValue(), now = Date.now();
  const r = await env.DB.prepare('INSERT INTO crm_hs_inflight(lead_id,token,expires_at) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM crm_portal_links WHERE lead_id=?) ON CONFLICT(lead_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE crm_hs_inflight.expires_at<=?')
    .bind(leadId, token, now + 120000, leadId, now).run();
  return changesOf(r) ? token : null;
}
export async function releaseHubspot(env, leadId, token) {
  await env.DB.prepare('DELETE FROM crm_hs_inflight WHERE lead_id=? AND token=?').bind(leadId, token).run();
}
export async function canWriteHubspot(env, leadId, token) {
  return !!await env.DB.prepare('SELECT lead_id FROM crm_hs_inflight WHERE lead_id=? AND token=? AND expires_at>? AND NOT EXISTS (SELECT 1 FROM crm_portal_links WHERE lead_id=?)').bind(leadId, token, Date.now(), leadId).first();
}

function linkView(row) {
  return row ? { leadId: String(row.lead_id), familyId: String(row.family_id), updatedAt: Number(row.updated_at), checkedAt: Number(row.checked_at),
    snapshot: row.snapshot ? parseJson(row.snapshot) : null, sourceUrl: ORIGIN + '/admin/family/' + row.family_id } : null;
}
async function readLink(env, leadId) {
  return env.DB.prepare('SELECT * FROM crm_portal_links WHERE lead_id=?').bind(leadId).first();
}
const response = (env, row) => json({ ok: true, configured: !!env.WB_SALESDESK_READ_KEY, link: linkView(row) });

/** 두 서버의 계약을 새 객체로 투영한다. 이름·점수·메모·예상 밖 필드는 전달/저장하지 않는다. */
export function portalSummary(raw, familyId) {
  const bad = () => { throw new Error('PORTAL_FORMAT'); };
  const obj = value => { if (!isPlainObject(value)) bad(); return value; };
  const id = value => { if (!portalId(value)) bad(); return value; };
  const optionalId = value => value === null ? null : id(value);
  const pick = (value, allowed) => { if (!allowed.includes(value)) bad(); return value; };
  const bool = value => { if (typeof value !== 'boolean') bad(); return value; };
  const count = value => { if (!Number.isSafeInteger(value) || value < 0) bad(); return value; };
  const r = obj(raw), hs = obj(r.hubspot), membership = obj(r.membership), app = obj(r.app), benefits = obj(r.benefits), cs = obj(r.cs), brunch = obj(r.brunch);
  if (r.schemaVersion !== 1 || r.familyId !== familyId || !Array.isArray(hs.appointments) || hs.appointments.length > 1000) bad();
  if (cs.nextContactDate !== null && !CORE.validYmd(cs.nextContactDate)) bad();
  const seen = new Set();
  const appointments = hs.appointments.map(value => {
    const a = obj(value), appointmentId = id(a.appointmentId);
    if (seen.has(appointmentId)) bad();
    seen.add(appointmentId);
    return { appointmentId, dealId: optionalId(a.dealId) };
  });
  return { schemaVersion: 1, familyId,
    hubspot: { contactId: optionalId(hs.contactId), appointments },
    membership: { friend: pick(membership.friend, ['available', 'review_required', 'active', 'expired', 'review_confirmed', 'completed']), supporter: pick(membership.supporter, ['available', 'setup_required', 'active']) },
    app: { installation: pick(app.installation, ['unknown', 'guided', 'verified']), launchObserved: bool(app.launchObserved) },
    benefits: { parentAccess: pick(benefits.parentAccess, ['preparing', 'scheduled', 'active', 'expired']), brainAppsEligible: bool(benefits.brainAppsEligible) },
    cs: { pendingCount: count(cs.pendingCount), nextContactDate: cs.nextContactDate }, brunch: { attendedCount: count(brunch.attendedCount) } };
}

async function fetchSummary(env, familyId) {
  // 테스트에서만 fetch를 주입한다. 운영 주소/헤더를 클라이언트가 정할 수 없고 리다이렉트로 키를 보내지 않는다.
  const fetchImpl = typeof env.PORTAL_FETCH === 'function' ? env.PORTAL_FETCH : globalThis.fetch;
  const remote = await fetchImpl(ORIGIN + '/api/integrations/salesdesk/families/' + familyId, {
    method: 'GET', headers: { Authorization: 'Bearer ' + env.WB_SALESDESK_READ_KEY, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(8000)
  });
  if (!remote.ok) throw new Error(remote.status === 404 ? 'PORTAL_NOT_FOUND' : 'PORTAL_UNAVAILABLE');
  if (!remote.headers.get('content-type')?.toLowerCase().includes('application/json') || Number(remote.headers.get('content-length')) > MAX_BYTES) throw new Error('PORTAL_FORMAT');
  const reader = remote.body?.getReader();
  if (!reader) throw new Error('PORTAL_FORMAT');
  let bytes = 0, text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('PORTAL_FORMAT');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  return portalSummary(JSON.parse(text), familyId);
}

export async function handlePortalApi(request, env, auth) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, ''), method = request.method;
  if (!['/api/portal/link', '/api/portal/refresh'].includes(path)) return fail('NOT_FOUND', '없는 API 경로입니다', 404);
  if (method !== 'POST' && !(method === 'GET' && path === '/api/portal/link')) return fail('METHOD', '허용되지 않는 메서드입니다', 405);
  if (method === 'POST' && path === '/api/portal/link' && auth.role !== 'admin') return fail('FORBIDDEN', '센터앱 고객 연결은 원장만 바꿀 수 있습니다', 403);
  const body = method === 'POST' ? await readJson(request) : null;
  const leadId = method === 'GET' ? url.searchParams.get('leadId') : body?.leadId;
  if (typeof leadId !== 'string' || !DOC_ID.test(leadId)) return fail('INVALID', '고객 id가 올바르지 않습니다');
  const lead = await loadDoc(env, 'leads', leadId);
  if (!lead) return fail('NOT_FOUND', '고객을 찾을 수 없습니다', 404);
  const current = await readLink(env, leadId);
  if (method === 'GET') return response(env, current);
  if (!version(body?.expectedUpdatedAt)) return fail('INVALID', '연결 버전이 필요합니다 — 새 연결은 0');
  const stale = () => fail('STALE', '다른 기기에서 연결이 바뀌었습니다. 다시 확인해 주세요', 409);
  if (body.expectedUpdatedAt !== Number(current?.updated_at || 0)) return stale();
  const updatedAt = Math.max(Date.now(), body.expectedUpdatedAt + 1);
  if (path === '/api/portal/link') {
    if (!portalId(body.familyId)) return fail('INVALID', '센터앱 고객번호는 0으로 시작하지 않는 양의 정수입니다');
    if (current?.family_id === body.familyId) return response(env, current);
    const guards = "EXISTS (SELECT 1 FROM crm_documents WHERE collection='leads' AND id=? AND deleted=0) AND NOT EXISTS (SELECT 1 FROM crm_hs_inflight WHERE lead_id=? AND expires_at>?)";
    const args = [leadId, leadId, Date.now()];
    let saved;
    try {
      saved = current ? await env.DB.prepare('UPDATE crm_portal_links SET family_id=?,snapshot=NULL,checked_at=0,updated_at=?,updated_by=? WHERE lead_id=? AND updated_at=? AND ' + guards)
        .bind(body.familyId, updatedAt, auth.staffId, leadId, body.expectedUpdatedAt, ...args).run() :
        await env.DB.prepare('INSERT INTO crm_portal_links(lead_id,family_id,updated_at,updated_by) SELECT ?,?,?,? WHERE ' + guards + ' ON CONFLICT(lead_id) DO NOTHING')
          .bind(leadId, body.familyId, updatedAt, auth.staffId, ...args).run();
    } catch (error) {
      if (String(error?.message).includes('UNIQUE constraint failed')) return fail('DUPLICATE', '이 센터앱 고객번호는 다른 고객에 연결되어 있습니다', 409);
      throw error;
    }
    if (!changesOf(saved)) {
      const busy = await env.DB.prepare('SELECT lead_id FROM crm_hs_inflight WHERE lead_id=? AND expires_at>?').bind(leadId, Date.now()).first();
      return busy ? fail('SYNC_BUSY', 'HubSpot 반영이 진행 중입니다. 잠시 후 연결해 주세요', 409) : stale();
    }
    // 기존 큐는 지우지 않는다. 실행 시에도 연결표를 검사해 외부 반영을 보류한다.
    return response(env, await readLink(env, leadId));
  }
  if (!current) return fail('NOT_LINKED', '센터앱 고객번호를 먼저 연결해 주세요', 409);
  if (!env.WB_SALESDESK_READ_KEY) return fail('PORTAL_NOT_CONFIGURED', '센터앱 읽기 연결이 아직 설정되지 않았습니다', 409);
  let snapshot;
  try { snapshot = await fetchSummary(env, current.family_id); }
  catch (error) {
    const missing = error?.message === 'PORTAL_NOT_FOUND';
    return fail(missing ? 'PORTAL_NOT_FOUND' : 'PORTAL_UNAVAILABLE', missing ? '센터앱에서 고객번호를 찾지 못했습니다. 이전 확인 기록은 유지됩니다' : '센터앱 정보를 확인하지 못했습니다. 이전 확인 기록은 유지됩니다', 502);
  }
  const saved = await env.DB.prepare("UPDATE crm_portal_links SET snapshot=?,checked_at=?,updated_at=? WHERE lead_id=? AND updated_at=? AND family_id=? AND EXISTS (SELECT 1 FROM crm_documents WHERE collection='leads' AND id=? AND deleted=0)")
    .bind(JSON.stringify(snapshot), Date.now(), Math.max(Date.now(), updatedAt), leadId, body.expectedUpdatedAt, current.family_id, leadId).run();
  return changesOf(saved) ? response(env, await readLink(env, leadId)) : stale();
}
