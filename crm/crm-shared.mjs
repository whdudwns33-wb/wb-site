// WB 세일즈데스크 — crm-api.mjs 와 partner-api.mjs 가 함께 쓰는 도우미(응답·암호·문서 읽기/쓰기·PII 규칙·반영 큐).
// 표준 Web API 만 쓴다(워커·Node 공용). 토큰·비밀번호 원문은 어디에도 저장하지 않는다.
import CORE from './crm-core.js';
import { dealName } from './hubspot.mjs';

export const SYSTEM_ID = 'hubspot';
export const SETTINGS_ID = 'main';
export const DOC_ID = /^[A-Za-z0-9_|.:@-]{1,160}$/;

// PII 규칙의 정본은 crm-core.js(화면도 같은 검사로 저장 전에 막는다). 전화는 phone, 이메일은 email 칸에만.
export const PII_ALLOWED_PATHS = new Set(CORE.PII_ALLOWED_PATHS);

const encoder = new TextEncoder();
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const LINK_CODE = /^[a-f0-9]{48}$/i;
export const CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
    }, extraHeaders || {})
  });
}
export function fail(code, error, status, extra) { return json(Object.assign({ ok: false, code, error }, extra || {}), status || 400); }
export function hasPii(text) { return CORE.hasPii(text); }
export function findPii(value, path, skip) { return CORE.findPii(value, path, skip); }
export function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
export function absent(v) { return v === undefined || v === null || v === ''; }
export function parseJson(text) { try { return JSON.parse(String(text)); } catch (error) { return null; } }
export function byteLength(text) { return encoder.encode(text).length; }
export function changesOf(result) { return Number(result && result.meta && result.meta.changes || 0); }
/** 서버는 UTC 로 돌지만 원장의 "오늘"은 한국 시간이다 — 기본 날짜는 KST 로 채운다. */
export function kstToday() { return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10); }
export async function readJson(request) {
  try { const body = await request.json(); return isPlainObject(body) ? body : null; } catch (error) { return null; }
}

/* ── 암호 도우미 ─────────────────────────────────────────────────────── */

export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export function hexBytes(value) { return new Uint8Array((String(value || '').match(/.{2}/g) || []).map(p => parseInt(p, 16))); }
export async function sha256Hex(value) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value || ''))))); }
export async function passwordHash(password, saltHex, iterations) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(String(password || '')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: hexBytes(saltHex), iterations }, material, 256);
  return hex(new Uint8Array(bits));
}
export function randomOpaqueValue() { const b = new Uint8Array(24); crypto.getRandomValues(b); return hex(b); }
export function randomSlug(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = new Uint8Array(length); crypto.getRandomValues(b);
  return Array.from(b, x => alphabet[x % alphabet.length]).join('');
}


/* ── 문서 읽기·쓰기 ─────────────────────────────────────────────────── */

export async function loadDoc(env, c, id) {
  const row = await env.DB.prepare('SELECT data,updated_at,updated_by,deleted FROM crm_documents WHERE collection=? AND id=? LIMIT 1').bind(c, id).first();
  return row && !Number(row.deleted) ? { data: parseJson(row.data) || {}, updatedAt: Number(row.updated_at) } : null;
}
export async function loadCollection(env, c) {
  const rows = await env.DB.prepare('SELECT id,data FROM crm_documents WHERE collection=? AND deleted=0').bind(c).all();
  return (rows.results || []).map(r => Object.assign({}, parseJson(r.data) || {}, { id: String(r.id) }));
}
export async function loadSettings(env) {
  const doc = await loadDoc(env, 'settings', SETTINGS_ID);
  const d = doc ? doc.data : {};
  const hs = isPlainObject(d.hubspot) ? d.hubspot : {};
  return { orgName: String(d.orgName || ''), followupOffsets: Array.isArray(d.followupOffsets) ? d.followupOffsets : CORE.FOLLOWUP_OFFSETS,
    hubspot: { enabled: hs.enabled !== false, autoApproveQuick: !!hs.autoApproveQuick, map: isPlainObject(hs.map) ? hs.map : {}, portal: isPlainObject(hs.portal) ? hs.portal : {} } };
}
/** 서버(hubspot)가 문서를 쓴다 — 규칙 검사 없이 값을 그대로. updated_at 은 반드시 커진다. */
/** 문서의 일부 필드만 고친다 — 현재 행을 다시 읽어 patchFn(data) 를 적용하고 updated_at 이 그대로일 때만 쓴다(CAS, 3회).
 *  HubSpot 왕복 사이에 직원이 같은 리드를 고쳤어도 그 편집을 덮지 않는다. 지워진 문서는 건드리지 않는다. */
export async function patchDocFields(env, c, id, patchFn, by) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await env.DB.prepare('SELECT data,updated_at,deleted FROM crm_documents WHERE collection=? AND id=? LIMIT 1').bind(c, id).first();
    if (!row || Number(row.deleted)) return null;
    const current = parseJson(row.data) || {};
    const next = patchFn(Object.assign({}, current));
    const updatedAt = Math.max(Date.now(), Number(row.updated_at) + 1);
    const r = await env.DB.prepare('UPDATE crm_documents SET data=?,updated_at=?,updated_by=? WHERE collection=? AND id=? AND updated_at=?')
      .bind(JSON.stringify(next), updatedAt, by || SYSTEM_ID, c, id, Number(row.updated_at)).run();
    if (changesOf(r) > 0) return next;
  }
  throw new Error('문서가 계속 바뀌어 HubSpot 연결 정보를 적지 못했습니다 — 다시 시도합니다');
}

export async function writeDocRaw(env, c, id, data, by) {
  const row = await env.DB.prepare('SELECT updated_at FROM crm_documents WHERE collection=? AND id=? LIMIT 1').bind(c, id).first();
  const updatedAt = Math.max(Date.now(), (row ? Number(row.updated_at) : 0) + 1);
  await env.DB.prepare(
    'INSERT INTO crm_documents(collection,id,data,updated_at,updated_by,deleted) VALUES(?,?,?,?,?,0) ' +
    'ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,updated_by=excluded.updated_by,deleted=0'
  ).bind(c, id, JSON.stringify(data), updatedAt, by || SYSTEM_ID).run();
  return updatedAt;
}

/* ── HubSpot 반영 큐 등록 ─────────────────────────────────────────────── */

/* 연락처 속성으로 HubSpot 에 가는 리드 필드 — 이 중 하나가 바뀌면 contact 큐 한 줄 */
const CONTACT_FIELDS = ['name', 'phone', 'email', 'channel', 'child', 'inspection', 'consultedAt', 'retestDue', 'academyStatus', 'status', 'outcome', 'referrerLeadId', 'partnerId'];

export function pick(obj, keys) { const o = {}; keys.forEach(k => { o[k] = obj ? obj[k] : undefined; }); return o; }
export function same(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }

/** 문서 변경 → 큐 줄. 같은 리드의 같은 종류(pending)가 있으면 payload 만 갈아 끼운다(한 리드에 한 줄). */
export async function enqueueFor(env, auth, settings, c, id, previous, data) {
  const now = Date.now();
  let n = 0;
  // 새 줄의 created_at 은 이 리드의 기존 줄보다 반드시 크다 — 합쳐진 줄(옛 created_at)과 새 줄의 처리 순서(검사 여정 성사 → 학원 트라이얼)가
  // 같은 ms 안에서도 섞이지 않게. flushQueue 가 created_at 순으로 보낸다.
  const last = await env.DB.prepare('SELECT MAX(created_at) AS m FROM crm_sync_queue WHERE lead_id=?').bind(c === 'leads' ? id : String(data.leadId || '')).first();
  let tick = Math.max(now, Number(last && last.m || 0) + 1);
  const put = async (leadId, kind, payload) => {
    const track = CORE.syncTrack(kind, payload);
    const status = track === 'quick' && settings.hubspot.autoApproveQuick ? 'approved' : 'pending';
    if (kind !== 'note') {
      // 같은 리드·같은 종류(딜은 같은 파이프라인)의 열린 줄이 있으면 그 줄을 갈아 끼운다 — 한 리드에 종류당 한 줄.
      const open = kind === 'deal'
        ? await env.DB.prepare('SELECT id,payload,track,status FROM crm_sync_queue WHERE lead_id=? AND kind=? AND status IN (\'pending\',\'approved\') AND json_extract(payload,\'$.pipeline\')=? ORDER BY created_at DESC LIMIT 1').bind(leadId, kind, String(payload.pipeline)).first()
        : await env.DB.prepare('SELECT id,payload,track,status FROM crm_sync_queue WHERE lead_id=? AND kind=? AND status IN (\'pending\',\'approved\') ORDER BY created_at DESC LIMIT 1').bind(leadId, kind).first();
      if (open) {
        const prevPayload = parseJson(open.payload) || {};
        const merged = kind === 'deal' ? Object.assign({}, payload, { transition: !!(payload.transition || prevPayload.transition) })
          : Object.assign({}, payload, { fields: [...new Set((prevPayload.fields || []).concat(payload.fields || []))] });
        const mergedTrack = CORE.syncTrack(kind, merged);
        // 원장이 이미 승인한 줄의 내용이 바뀌면(다른 단계로) 승인은 무효다 — 검토 트랙은 다시 승인 대기로. 빠른 입력은 자동 승인 설정을 따른다.
        let mergedStatus = open.status;
        if (mergedTrack === 'review') mergedStatus = (open.status === 'approved' && prevPayload.stage !== merged.stage) || open.track !== 'review' ? 'pending' : open.status;
        await env.DB.prepare('UPDATE crm_sync_queue SET payload=?,track=?,status=?,updated_at=MAX(?,created_at) WHERE id=?')
          .bind(JSON.stringify(merged), mergedTrack, mergedStatus, now, open.id).run();
        n++;
        return;
      }
    }
    await env.DB.prepare(
      'INSERT INTO crm_sync_queue(id,lead_id,kind,track,status,payload,attempts,created_at,created_by,updated_at) VALUES(?,?,?,?,?,?,0,?,?,?)'
    ).bind('q_' + randomSlug(16), leadId, kind, track, status, JSON.stringify(payload), tick, auth.staffId, tick).run();
    tick++;
    n++;
  };
  if (c === 'leads') {
    const isNew = !previous;
    if (isNew || CONTACT_FIELDS.some(k => !same(pick(previous, [k])[k], data[k]))) await put(id, 'contact', { fields: CONTACT_FIELDS.filter(k => isNew || !same(previous[k], data[k])) });
    const stageChanged = isNew || previous.pipeline !== data.pipeline || previous.stage !== data.stage;
    if (stageChanged) {
      // 검사 여정 → 학원 등록으로 넘어가면 검사 여정 딜은 성사로 닫힌다(등록했으니 학원 파이프라인으로 이어가는 것이다).
      const crossover = !isNew && previous.pipeline === 'inspection' && data.pipeline === 'academy' && previous.stage !== 'won';
      // 지금 가는 파이프라인이 아닌 열린 딜 줄은 더 이상 사실이 아니다(되돌아온 경우) — 반려로 닫아 옛 단계가 HubSpot 에 가지 않게.
      const keep = crossover ? [data.pipeline, 'inspection'] : [data.pipeline];
      await env.DB.prepare('UPDATE crm_sync_queue SET status=\'rejected\',error=?,decided_at=?,decided_by=?,updated_at=MAX(?,created_at) WHERE lead_id=? AND kind=\'deal\' AND status IN (\'pending\',\'approved\') AND json_extract(payload,\'$.pipeline\') NOT IN (' + keep.map(() => '?').join(',') + ')')
        .bind('리드가 다른 파이프라인으로 옮겨져 무효', now, 'system', now, id, ...keep).run();
      if (crossover) {
        await put(id, 'deal', { pipeline: 'inspection', stage: 'won', transition: true, dealName: dealName(data, 'inspection') });
      }
      const hadDeal = !!(data.hubspot && data.hubspot.deals && data.hubspot.deals[data.pipeline] && data.hubspot.deals[data.pipeline].dealId);
      await put(id, 'deal', { pipeline: data.pipeline, stage: data.stage, transition: !isNew && (hadDeal || previous.pipeline === data.pipeline), dealName: dealName(data, data.pipeline) });
    }
  } else if (c === 'activities') {
    // 단계 변경은 딜 갱신으로 이미 HubSpot 에 가므로 메모가 있을 때만 노트로. hubspot 종류(동기화 메모)는 보내지 않는다.
    if (data.type !== 'hubspot' && (data.type !== 'stage' || data.text)) await put(String(data.leadId), 'note', { activityId: id });
  } else if (c === 'credits') {
    await put(String(data.leadId), 'contact', { fields: ['creditBalance'] });
  }
  return n;
}

