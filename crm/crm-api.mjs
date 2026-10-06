// WB 세일즈데스크 API(/api/*). 표준 Request/Response 만 쓴다 — Cloudflare Worker 와 Node 22(테스트·dev-server) 양쪽에서 같은 코드가 돈다.
// node: 모듈은 절대 import 하지 않는다(워커 번들 불가).
//
// 인증: 원장 비밀번호(PBKDF2) → Bearer 토큰, 직원은 1회용 링크 코드 → Bearer 토큰. 토큰은 sha256 만 저장한다(desk 와 같은 방식).
// 문서(crm_documents): leads(리드)·activities(상담·CS·통화 기록, append-only)·credits(소개 크레딧, 원장·append-only)·settings(원장).
// HubSpot: 리드·기록이 바뀌면 서버가 반영 큐(crm_sync_queue)에 한 줄을 만들고, 원장이 승인한 것만 push 가 HubSpot 에 쓴다.
//   빠른 입력(연락처·노트)은 설정으로 자동 승인할 수 있고, 딜 단계 전이는 항상 원장 승인이다(원장 CRM 운영 규칙 P4-A/B).
//   HubSpot 토큰은 env.HUBSPOT_ACCESS_TOKEN(워커 시크릿)으로만 들어온다 — 응답·로그·문서에 넣지 않는다.
import CORE from './crm-core.js';
import { createClient, contactProperties, leadFromContact, applyDealsToLead, dealName, noteBody, HubSpotError } from './hubspot.mjs';
import { SYSTEM_ID, SETTINGS_ID, DOC_ID, PII_ALLOWED_PATHS, json, fail, hasPii, isPlainObject, absent, parseJson, byteLength, changesOf, kstToday, readJson,
  safeEqual, hex, hexBytes, sha256Hex, passwordHash, randomOpaqueValue, randomSlug, loadDoc, loadCollection, loadSettings, writeDocRaw, patchDocFields, enqueueFor, same, findPii, LINK_CODE, CODE_TTL_MS } from './crm-shared.mjs';
import { handlePartnerApi, partnerOp } from './partner-api.mjs';

const APP_NAME = 'wb-crm';
const ADMIN_ID = 'admin';
const ADMIN_NAME = '원장';
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const PASSWORD_ITERATIONS = 100000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = { admin: 30 * 24 * 60 * 60 * 1000, staff: 180 * 24 * 60 * 60 * 1000 };
const LAST_SEEN_WRITE_GAP_MS = 60 * 1000;
const STAFF_ID = /^[A-Za-z0-9_-]{3,64}$/;
const QUEUE_ID = /^q_[a-z0-9]{12,40}$/;
const COLLECTIONS = new Set(CORE.COLLECTIONS.filter(c => c !== 'staff'));
const MAX_CHANGES = 200;
const MAX_DOC_BYTES = 64 * 1024;
const PUSH_LIMIT_DEFAULT = 10;
const PUSH_LIMIT_MAX = 25;
const PULL_PAGES_PER_CALL = 3;
const PROPS_CACHE_MS = 60 * 60 * 1000;


/* ── 토큰·인증 ───────────────────────────────────────────────────────── */

async function issueToken(env, staffId, role) {
  const token = randomOpaqueValue();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO crm_tokens(token_hash,staff_id,role,created_at,last_seen,revoked) VALUES(?,?,?,?,?,0)')
    .bind(await sha256Hex(token), staffId, role, now, now).run();
  return { token, expiresAt: now + TOKEN_TTL_MS[role] };
}

async function resolveAuth(request, env) {
  const header = String(request.headers.get('Authorization') || '').trim();
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{1,256})$/i.exec(header);
  if (!match) return null;
  const tokenHash = await sha256Hex(match[1]);
  const row = await env.DB.prepare('SELECT staff_id,role,last_seen FROM crm_tokens WHERE token_hash=? AND revoked=0 LIMIT 1').bind(tokenHash).first();
  if (!row) return null;
  const role = row.role === 'admin' ? 'admin' : 'staff';
  const now = Date.now();
  const lastSeen = Number(row.last_seen || 0);
  if (now - lastSeen > TOKEN_TTL_MS[role]) return null;
  let staffId = ADMIN_ID, name = ADMIN_NAME;
  if (role === 'staff') {
    const staff = await env.DB.prepare('SELECT id,name,active FROM crm_staff WHERE id=? LIMIT 1').bind(String(row.staff_id)).first();
    if (!staff || !Number(staff.active)) return null;
    staffId = String(staff.id); name = String(staff.name);
  }
  if (now - lastSeen > LAST_SEEN_WRITE_GAP_MS) {
    await env.DB.prepare('UPDATE crm_tokens SET last_seen=? WHERE token_hash=? AND last_seen<?').bind(now, tokenHash, now).run();
  }
  return { role, staffId, name, tokenHash };
}

async function adminRow(env) {
  return env.DB.prepare('SELECT password_salt,password_hash,password_iterations,failed_attempts,locked_until FROM crm_admin WHERE id=1').first();
}
async function health(env) {
  let setup = false;
  try { setup = !!(await env.DB.prepare('SELECT id FROM crm_admin WHERE id=1').first()); } catch (error) { setup = false; }
  return json({ ok: true, app: APP_NAME, setup, hubspot: !!env.HUBSPOT_ACCESS_TOKEN, now: Date.now() });
}
function validPassword(v) { return typeof v === 'string' && v.length >= PASSWORD_MIN && v.length <= PASSWORD_MAX; }

async function setup(env, body) {
  if (!body || !validPassword(body.password)) return fail('INVALID', '비밀번호는 8~72자로 입력해 주세요');
  if (await adminRow(env)) return fail('ALREADY_SETUP', '관리자 비밀번호가 이미 있습니다', 409);
  const salt = randomOpaqueValue();
  const hash = await passwordHash(body.password, salt, PASSWORD_ITERATIONS);
  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO crm_admin(id,password_salt,password_hash,password_iterations,failed_attempts,locked_until,created_at) VALUES(1,?,?,?,0,0,?)'
  ).bind(salt, hash, PASSWORD_ITERATIONS, Date.now()).run();
  if (changesOf(result) === 0) return fail('ALREADY_SETUP', '관리자 비밀번호가 이미 있습니다', 409);
  const issued = await issueToken(env, ADMIN_ID, 'admin');
  return json({ ok: true, role: 'admin', token: issued.token, expiresAt: issued.expiresAt });
}

async function login(env, body) {
  const row = await adminRow(env);
  if (!row) return fail('NOT_SETUP', '관리자 비밀번호를 먼저 만들어 주세요', 409);
  const now = Date.now();
  if (Number(row.locked_until || 0) > now) return fail('LOGIN_LOCKED', '시도 횟수가 많습니다. 5분 후 다시 시도해 주세요', 429);
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (password.length > PASSWORD_MAX) return fail('LOGIN_FAILED', '비밀번호가 맞지 않습니다', 401);
  const hash = await passwordHash(password, row.password_salt, Number(row.password_iterations));
  if (!safeEqual(hash, row.password_hash)) {
    const failures = Number(row.failed_attempts || 0) + 1;
    const locked = failures >= LOGIN_MAX_FAILURES;
    await env.DB.prepare('UPDATE crm_admin SET failed_attempts=?,locked_until=? WHERE id=1').bind(locked ? 0 : failures, locked ? now + LOGIN_LOCK_MS : 0).run();
    return fail('LOGIN_FAILED', '비밀번호가 맞지 않습니다', 401);
  }
  await env.DB.prepare('UPDATE crm_admin SET failed_attempts=0,locked_until=0 WHERE id=1').run();
  const issued = await issueToken(env, ADMIN_ID, 'admin');
  return json({ ok: true, role: 'admin', token: issued.token, expiresAt: issued.expiresAt });
}

async function linkExchange(env, body) {
  const code = body && typeof body.code === 'string' ? body.code.trim() : '';
  if (!LINK_CODE.test(code)) return fail('CODE_INVALID', '연결 코드가 올바르지 않습니다', 401);
  const codeHash = await sha256Hex(code.toLowerCase());
  const now = Date.now();
  const row = await env.DB.prepare('SELECT staff_id,expires_at,consumed_at,revoked FROM crm_codes WHERE code_hash=? LIMIT 1').bind(codeHash).first();
  if (!row || Number(row.revoked) || row.consumed_at !== null || Number(row.expires_at) < now) return fail('CODE_INVALID', '연결 코드가 만료되었거나 이미 사용되었습니다', 401);
  const staff = await env.DB.prepare('SELECT id,name,active FROM crm_staff WHERE id=? LIMIT 1').bind(String(row.staff_id)).first();
  if (!staff || !Number(staff.active)) return fail('STAFF_INACTIVE', '비활성 직원입니다. 원장에게 문의해 주세요', 403);
  const consumed = await env.DB.prepare('UPDATE crm_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL').bind(now, codeHash).run();
  if (changesOf(consumed) === 0) return fail('CODE_INVALID', '연결 코드가 이미 사용되었습니다', 401);
  const issued = await issueToken(env, String(staff.id), 'staff');
  return json({ ok: true, role: 'staff', staffId: String(staff.id), name: String(staff.name), token: issued.token, expiresAt: issued.expiresAt });
}

async function changePassword(env, auth, body) {
  if (auth.role !== 'admin') return fail('FORBIDDEN', '원장만 할 수 있습니다', 403);
  const row = await adminRow(env);
  if (!row) return fail('NOT_SETUP', '관리자 비밀번호를 먼저 만들어 주세요', 409);
  const current = body && typeof body.password === 'string' ? body.password : '';
  if (!body || !validPassword(body.newPassword)) return fail('INVALID', '새 비밀번호는 8~72자로 입력해 주세요');
  const hash = await passwordHash(current, row.password_salt, Number(row.password_iterations));
  // 401 은 클라이언트가 "로그인이 풀렸다"로 보고 세션을 버린다 — 현재 비밀번호 오타는 403 으로 알린다.
  if (!safeEqual(hash, row.password_hash)) return fail('LOGIN_FAILED', '현재 비밀번호가 맞지 않습니다', 403);
  const salt = randomOpaqueValue();
  const next = await passwordHash(body.newPassword, salt, PASSWORD_ITERATIONS);
  await env.DB.batch([
    env.DB.prepare('UPDATE crm_admin SET password_salt=?,password_hash=?,password_iterations=?,failed_attempts=0,locked_until=0 WHERE id=1').bind(salt, next, PASSWORD_ITERATIONS),
    env.DB.prepare('UPDATE crm_tokens SET revoked=1 WHERE staff_id=? AND role=? AND token_hash<>? AND revoked=0').bind(ADMIN_ID, 'admin', auth.tokenHash)
  ]);
  return json({ ok: true });
}

/* ── 직원 ──────────────────────────────────────────────────────────────── */

function staffView(row) { return { id: String(row.id), name: String(row.name), role: 'staff', active: !!Number(row.active) }; }
async function loadStaff(env, staffId) {
  if (!STAFF_ID.test(staffId)) return null;
  return env.DB.prepare('SELECT id,name,role,active,updated_at FROM crm_staff WHERE id=? LIMIT 1').bind(staffId).first();
}
async function listStaff(env) {
  const result = await env.DB.prepare('SELECT id,name,role,active FROM crm_staff ORDER BY active DESC, name, id').all();
  return json({ ok: true, staff: (result.results || []).map(staffView) });
}
async function staffNameOf(env, staffId) {
  if (!staffId || staffId === ADMIN_ID) return ADMIN_NAME;
  if (staffId === SYSTEM_ID) return 'HubSpot';
  const row = await loadStaff(env, String(staffId));
  return row ? String(row.name) : '직원';
}
function cleanName(value, max) {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return cleaned && cleaned.length <= max ? cleaned : null;
}

async function staffOp(env, auth, body) {
  if (auth.role !== 'admin') return fail('FORBIDDEN', '직원 관리는 원장만 할 수 있습니다', 403);
  const op = body ? String(body.op || '') : '';
  const now = Date.now();
  if (op === 'create') {
    const name = cleanName(body.name, 40);
    if (!name) return fail('INVALID', '이름은 1~40자로 입력해 주세요');
    if (hasPii(name)) return fail('PII', '이름에 전화번호·이메일을 넣을 수 없습니다');
    const id = 'st_' + randomSlug(12);
    await env.DB.prepare('INSERT INTO crm_staff(id,name,role,active,created_at,updated_at) VALUES(?,?,?,1,?,?)').bind(id, name, 'staff', now, now).run();
    return json({ ok: true, staff: { id, name, role: 'staff', active: true } });
  }
  const staffId = body ? String(body.staffId || '') : '';
  const staff = await loadStaff(env, staffId);
  if (!staff) return fail('NOT_FOUND', '직원을 찾을 수 없습니다', 404);
  if (op === 'link') {
    if (!Number(staff.active)) return fail('STAFF_INACTIVE', '비활성 직원에게는 링크를 만들 수 없습니다', 409);
    const code = randomOpaqueValue();
    const expiresAt = now + CODE_TTL_MS;
    await env.DB.prepare('INSERT INTO crm_codes(code_hash,staff_id,expires_at,consumed_at,revoked,created_at) VALUES(?,?,?,NULL,0,?)').bind(await sha256Hex(code), staffId, expiresAt, now).run();
    return json({ ok: true, code, expiresAt, staffId });
  }
  if (op === 'rename') {
    const name = cleanName(body.name, 40);
    if (!name) return fail('INVALID', '이름은 1~40자로 입력해 주세요');
    if (hasPii(name)) return fail('PII', '이름에 전화번호·이메일을 넣을 수 없습니다');
    await env.DB.prepare('UPDATE crm_staff SET name=?,updated_at=? WHERE id=?').bind(name, Math.max(now, Number(staff.updated_at) + 1), staffId).run();
    return json({ ok: true, staff: staffView(Object.assign({}, staff, { name })) });
  }
  if (op === 'activate' || op === 'deactivate') {
    const active = op === 'activate' ? 1 : 0;
    await env.DB.prepare('UPDATE crm_staff SET active=?,updated_at=? WHERE id=?').bind(active, Math.max(now, Number(staff.updated_at) + 1), staffId).run();
    return json({ ok: true, staff: staffView(Object.assign({}, staff, { active })) });
  }
  if (op === 'revoke') {
    const results = await env.DB.batch([
      env.DB.prepare('UPDATE crm_tokens SET revoked=1 WHERE staff_id=? AND role=? AND revoked=0').bind(staffId, 'staff'),
      env.DB.prepare('UPDATE crm_codes SET revoked=1 WHERE staff_id=? AND consumed_at IS NULL AND revoked=0').bind(staffId)
    ]);
    return json({ ok: true, staffId, revokedTokens: changesOf(results[0]), revokedCodes: changesOf(results[1]) });
  }
  return fail('INVALID', '지원하지 않는 직원 작업입니다');
}

/* ── 문서 규칙 ───────────────────────────────────────────────────────── */

function bad(code, error, status) { return { code, error, status: status || 400 }; }
const LEAD_PII_SKIP = new Set([...PII_ALLOWED_PATHS, 'hubspot', 'creditBalanceHs']);

function ruleLeads(data, ctx) {
  const today = kstToday();
  const v = CORE.validateLead(data, { today });
  if (!v.ok) return bad('INVALID', v.error);
  const out = v.data;
  const prev = ctx.previous;
  // hubspot(연결 id)·creditBalanceHs 는 서버가 가진다 — 클라이언트가 보낸 값은 버리고 이전 값을 잇는다. PII 검사도 이 둘은 보지 않는다(HubSpot id 는 숫자열).
  out.hubspot = prev && isPlainObject(prev.hubspot) ? prev.hubspot : {};
  if (prev && prev.creditBalanceHs !== undefined) out.creditBalanceHs = prev.creditBalanceHs;
  const pii = findPii(out, '', LEAD_PII_SKIP);
  if (pii) return bad('PII', pii + ' 에 전화번호·이메일·주민번호 패턴이 있습니다 — 전화는 전화 칸, 이메일은 이메일 칸에만 적어 주세요');
  if (!out.owner) out.owner = prev && prev.owner ? String(prev.owner) : ctx.auth.staffId;
  // 단계가 바뀐 날은 서버 기준으로 찍는다 — 기기 시계가 틀려도 "며칠 머물렀나"가 맞게.
  if (prev && prev.stage === out.stage && prev.pipeline === out.pipeline) out.stageAt = CORE.validYmd(prev.stageAt) ? prev.stageAt : out.stageAt;
  else if (prev) out.stageAt = today;
  if (prev && CORE.validYmd(prev.createdAt)) out.createdAt = prev.createdAt;
  return { data: out };
}

function ruleActivities(data, ctx) {
  if (ctx.exists) return bad('APPEND_ONLY', '기록은 쓴 뒤 바꿀 수 없습니다 — 새 기록을 더해 주세요', 409);
  const v = CORE.validateActivity(data, { today: kstToday() });
  if (!v.ok) return bad('INVALID', v.error);
  const out = v.data;
  const pii = findPii({ text: out.text, from: out.from, to: out.to }, '', null);
  if (pii) return bad('PII', '기록에 전화번호·이메일·주민번호를 적을 수 없습니다 — 전화는 리드의 전화 칸에만');
  out.by = ctx.auth.staffId;
  out.hubspot = {};
  return { data: out };
}

function ruleCredits(data, ctx) {
  if (ctx.auth.role !== 'admin') return bad('FORBIDDEN', '크레딧은 원장만 적습니다', 403);
  if (ctx.exists) return bad('APPEND_ONLY', '크레딧 원장은 바꿀 수 없습니다 — 조정(adjust) 한 줄을 더해 주세요', 409);
  const v = CORE.validateCredit(data, { today: kstToday() });
  if (!v.ok) return bad('INVALID', v.error);
  const out = v.data;
  if (hasPii(out.note)) return bad('PII', '메모에 전화번호·이메일을 적을 수 없습니다');
  out.by = ctx.auth.staffId;
  return { data: out };
}

function sanitizeMap(raw, pipeline) {
  const m = isPlainObject(raw) ? raw : {};
  const stageMap = {};
  const src = isPlainObject(m.stageMap) ? m.stageMap : {};
  CORE.stagesOf(pipeline).forEach(k => { const v = String(src[k] || '').trim(); if (v && v.length <= 40 && /^[A-Za-z0-9_-]+$/.test(v)) stageMap[k] = v; });
  const pipelineId = String(m.pipelineId || '').trim();
  return { pipelineId: /^[A-Za-z0-9_-]{1,40}$/.test(pipelineId) ? pipelineId : '', pipelineLabel: CORE.clean(m.pipelineLabel, 60), stageMap };
}
function ruleSettings(data, ctx) {
  if (ctx.id !== SETTINGS_ID) return bad('INVALID', '설정 문서 id 는 main 하나입니다');
  const hs = isPlainObject(data.hubspot) ? data.hubspot : {};
  const prevHs = ctx.previous && isPlainObject(ctx.previous.hubspot) ? ctx.previous.hubspot : {};
  const offsets = [...new Set((Array.isArray(data.followupOffsets) ? data.followupOffsets : []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 60))].sort((a, b) => a - b).slice(0, 5);
  const out = {
    orgName: CORE.clean(data.orgName, 40),
    followupOffsets: offsets.length ? offsets : CORE.FOLLOWUP_OFFSETS.slice(),
    hubspot: {
      enabled: hs.enabled !== false,
      autoApproveQuick: !!hs.autoApproveQuick,
      map: { inspection: sanitizeMap(isPlainObject(hs.map) ? hs.map.inspection : null, 'inspection'), academy: sanitizeMap(isPlainObject(hs.map) ? hs.map.academy : null, 'academy') },
      // 포털 정보는 /api/hubspot/status 가 채운다 — 클라이언트 값은 무시
      portal: isPlainObject(prevHs.portal) ? prevHs.portal : {}
    }
  };
  if (hasPii(out.orgName)) return bad('PII', '조직 이름에 전화번호를 넣을 수 없습니다');
  return { data: out };
}
function rulePartners(data, ctx) {
  if (ctx.auth.role !== 'admin') return bad('FORBIDDEN', '파트너 학원 등록·수정은 원장만 합니다', 403);
  const v = CORE.validatePartner(data, { today: kstToday() });
  if (!v.ok) return bad('INVALID', v.error);
  const out = v.data;
  const pii = findPii(out, '', PII_ALLOWED_PATHS);
  if (pii) return bad('PII', pii + ' 에 전화번호·이메일 패턴이 있습니다 — 담당자 전화는 전화 칸에만');
  if (ctx.previous && CORE.validYmd(ctx.previous.createdAt)) out.createdAt = ctx.previous.createdAt;
  return { data: out };
}

/** 나가는 소개 — 직원·원장이 만들고(가정 동의 필수), 이후엔 상태·메모만 바뀐다. 리드·파트너는 만든 뒤 고정. */
function ruleReferrals(data, ctx) {
  const v = CORE.validateReferral(data, { today: kstToday() });
  if (!v.ok) return bad('INVALID', v.error);
  const out = v.data;
  const prev = ctx.previous;
  if (!prev && !out.consent) return bad('CONSENT', '가정의 동의를 받은 뒤 소개할 수 있습니다 — 동의 확인을 켜 주세요');
  if (findPii({ note: out.note, partnerNote: out.partnerNote }, '', null)) return bad('PII', '소개 사유·메모에 전화번호·이메일을 적을 수 없습니다');
  if (prev) { out.leadId = String(prev.leadId); out.partnerId = String(prev.partnerId); out.at = CORE.validYmd(prev.at) ? prev.at : out.at; out.by = String(prev.by || ''); out.consent = true; }
  else out.by = ctx.auth.staffId;
  if (prev && prev.status !== out.status) out.statusAt = kstToday();
  return { data: out };
}
const RULES = { leads: ruleLeads, activities: ruleActivities, credits: ruleCredits, settings: ruleSettings, partners: rulePartners, referrals: ruleReferrals };

/* ── 문서 읽기·쓰기 ─────────────────────────────────────────────────── */

function docView(row) {
  return { c: String(row.collection), id: String(row.id), data: parseJson(row.data) || {}, updatedAt: Number(row.updated_at), updatedBy: String(row.updated_by), deleted: !!Number(row.deleted) };
}
function staffDoc(row) { return { c: 'staff', id: String(row.id), data: staffView(row), updatedAt: Number(row.updated_at), updatedBy: ADMIN_ID, deleted: false }; }

async function readDocs(env, url) {
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw === null || sinceRaw === '' ? null : Number(sinceRaw);
  if (since !== null && !Number.isFinite(since)) return fail('INVALID', 'since 는 ms 숫자여야 합니다');
  const where = since === null ? '' : ' WHERE updated_at>?';
  const bindings = since === null ? [] : [since];
  const rows = await env.DB.prepare('SELECT collection,id,data,updated_at,updated_by,deleted FROM crm_documents' + where + ' ORDER BY updated_at, collection, id').bind(...bindings).all();
  const staffRows = await env.DB.prepare('SELECT id,name,role,active,updated_at FROM crm_staff' + where + ' ORDER BY updated_at, id').bind(...bindings).all();
  return json({ ok: true, now: Date.now(), docs: (rows.results || []).map(docView).concat((staffRows.results || []).map(staffDoc)) });
}

function currentView(row) {
  return row ? { data: parseJson(row.data) || {}, updatedAt: Number(row.updated_at), updatedBy: String(row.updated_by), deleted: !!Number(row.deleted) } : null;
}

async function applyChange(env, auth, change, settings) {
  const c = change && typeof change.c === 'string' ? change.c : '';
  const id = change && typeof change.id === 'string' ? change.id : '';
  const item = { c, id };
  const reject = (code, error, status, extra) => ({ status: status || 400, result: Object.assign(item, { error, code }, extra || {}) });
  if (!COLLECTIONS.has(c)) return reject('INVALID', '모르는 컬렉션입니다');
  if (!DOC_ID.test(id)) return reject('INVALID', '문서 id 형식이 올바르지 않습니다');
  const wantDelete = !!change.deleted;
  if (wantDelete && auth.role !== 'admin') return reject('FORBIDDEN', '삭제는 원장만 할 수 있습니다', 403);
  if (wantDelete && c !== 'leads') return reject('APPEND_ONLY', '기록·크레딧·설정은 지우지 않습니다', 409);
  if (c === 'settings' && auth.role !== 'admin') return reject('FORBIDDEN', '설정은 원장만 바꿀 수 있습니다', 403);
  const row = await env.DB.prepare('SELECT data,updated_at,updated_by,deleted FROM crm_documents WHERE collection=? AND id=? LIMIT 1').bind(c, id).first();
  const currentAt = row ? Number(row.updated_at) : 0;
  if (!absent(change.expectedUpdatedAt)) {
    const expected = Number(change.expectedUpdatedAt);
    if (!Number.isFinite(expected) || expected !== currentAt) return reject('STALE', '다른 기기에서 먼저 바뀌었습니다', 409, { current: currentView(row) });
  }
  const exists = !!row && !Number(row.deleted);
  const previous = exists ? parseJson(row.data) : null;
  let data = {};
  if (!wantDelete) {
    if (!isPlainObject(change.data)) return reject('INVALID', 'data 는 객체여야 합니다');
    if (byteLength(JSON.stringify(change.data)) > MAX_DOC_BYTES) return reject('TOO_LARGE', '문서는 64KB 까지입니다', 400);
    const verdict = RULES[c](change.data, { auth, id, exists, previous });
    if (verdict.code) return reject(verdict.code, verdict.error, verdict.status);
    data = verdict.data;
    // 파트너 연결은 실제 파트너 문서를 가리켜야 한다 — 없는 id 가 붙으면 정산·포털이 엉킨다.
    if (c === 'leads' && data.partnerId && !(await loadDoc(env, 'partners', data.partnerId))) return reject('INVALID', '없는 파트너입니다');
    if (c === 'referrals' && !exists) {
      if (!(await loadDoc(env, 'leads', data.leadId))) return reject('INVALID', '없는 리드입니다');
      const partner = await loadDoc(env, 'partners', data.partnerId);
      if (!partner || partner.data.status !== 'active') return reject('INVALID', '연계 중인 파트너가 아닙니다');
    }
  }
  const updatedAt = Math.max(Date.now(), currentAt + 1);
  await env.DB.prepare(
    'INSERT INTO crm_documents(collection,id,data,updated_at,updated_by,deleted) VALUES(?,?,?,?,?,?) ' +
    'ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,updated_by=excluded.updated_by,deleted=excluded.deleted'
  ).bind(c, id, JSON.stringify(data), updatedAt, auth.staffId, wantDelete ? 1 : 0).run();
  if (wantDelete) {
    // 지운 리드의 반영 줄은 더 보낼 것이 없다 — 반려로 닫는다. 연결표는 남겨 둔다(가져오기가 같은 연락처를 새 리드로 되살리지 않게).
    await env.DB.prepare('UPDATE crm_sync_queue SET status=\'rejected\',error=?,decided_at=?,decided_by=?,updated_at=MAX(?,created_at) WHERE lead_id=? AND status IN (\'pending\',\'approved\')')
      .bind('리드 삭제', updatedAt, auth.staffId, updatedAt, id).run();
  }
  let queued = 0;
  if (!wantDelete && settings.hubspot.enabled) queued = await enqueueFor(env, auth, settings, c, id, previous, data);
  return { status: 200, result: Object.assign(item, { updatedAt, queued }) };
}

async function writeDocs(env, auth, body) {
  const changes = body && Array.isArray(body.changes) ? body.changes : null;
  if (!changes) return fail('INVALID', 'changes 배열이 필요합니다');
  if (changes.length > MAX_CHANGES) return fail('INVALID', '한 번에 ' + MAX_CHANGES + '건까지 보낼 수 있습니다');
  const settings = await loadSettings(env);
  const results = [];
  let first = null;
  for (const change of changes) {
    const outcome = await applyChange(env, auth, isPlainObject(change) ? change : {}, settings);
    results.push(outcome.result);
    if (outcome.status !== 200 && !first) first = outcome;
  }
  const now = Date.now();
  if (!first) return json({ ok: true, now, results });
  return json({ ok: false, now, results, code: first.result.code, error: first.result.error }, first.status);
}

/* ── HubSpot 반영 큐 ──────────────────────────────────────────────────── */

function queueView(row) {
  return {
    id: String(row.id), leadId: String(row.lead_id), kind: String(row.kind), track: String(row.track), status: String(row.status),
    payload: parseJson(row.payload) || {}, result: row.result ? parseJson(row.result) : null, error: row.error ? String(row.error) : '',
    attempts: Number(row.attempts || 0), createdAt: Number(row.created_at), createdBy: String(row.created_by),
    decidedAt: row.decided_at ? Number(row.decided_at) : 0, decidedBy: row.decided_by ? String(row.decided_by) : '', doneAt: row.done_at ? Number(row.done_at) : 0
  };
}
async function queueCounts(env) {
  const rows = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM crm_sync_queue GROUP BY status').all();
  const out = { pending: 0, approved: 0, done: 0, failed: 0, rejected: 0 };
  (rows.results || []).forEach(r => { out[String(r.status)] = Number(r.n); });
  return out;
}
async function listQueue(env, url) {
  const status = String(url.searchParams.get('status') || '');
  const leadId = String(url.searchParams.get('leadId') || '');
  const where = [], bind = [];
  if (status) { if (!CORE.SYNC_STATUS.includes(status)) return fail('INVALID', '모르는 상태입니다'); where.push('status=?'); bind.push(status); }
  if (leadId) { if (!DOC_ID.test(leadId)) return fail('INVALID', '리드 id 형식'); where.push('lead_id=?'); bind.push(leadId); }
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 300);
  const rows = await env.DB.prepare('SELECT * FROM crm_sync_queue' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT ' + limit).bind(...bind).all();
  return json({ ok: true, items: (rows.results || []).map(queueView), counts: await queueCounts(env) });
}
async function queueOp(env, auth, body) {
  if (auth.role !== 'admin') return fail('FORBIDDEN', 'HubSpot 반영 승인은 원장만 합니다', 403);
  const op = body ? String(body.op || '') : '';
  const now = Date.now();
  if (op === 'approveAll') {
    const r = await env.DB.prepare('UPDATE crm_sync_queue SET status=\'approved\',decided_at=?,decided_by=?,updated_at=MAX(?,created_at) WHERE status=\'pending\'').bind(now, auth.staffId, now).run();
    return json({ ok: true, changed: changesOf(r), counts: await queueCounts(env) });
  }
  const ids = (body && Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => QUEUE_ID.test(x)).slice(0, 200);
  if (!ids.length) return fail('INVALID', '대상 id 가 없습니다');
  const TRANSITION = { approve: ['pending', 'approved'], reject: ['pending', 'rejected'], retry: ['failed', 'approved'], unapprove: ['approved', 'pending'] };
  const t = TRANSITION[op];
  if (!t) return fail('INVALID', '지원하지 않는 작업입니다');
  let changed = 0;
  for (const id of ids) {
    const r = await env.DB.prepare('UPDATE crm_sync_queue SET status=?,decided_at=?,decided_by=?,error=CASE WHEN ?=\'approved\' THEN NULL ELSE error END,updated_at=MAX(?,created_at) WHERE id=? AND status=?')
      .bind(t[1], now, auth.staffId, t[1], now, id, t[0]).run();
    changed += changesOf(r);
  }
  return json({ ok: true, changed, counts: await queueCounts(env) });
}

/* ── HubSpot 호출 ─────────────────────────────────────────────────────── */

function hubspotClient(env) {
  if (!env.HUBSPOT_ACCESS_TOKEN) return null;
  // env.HUBSPOT_FETCH 는 테스트·로컬에서만 넣는 가짜 fetch. 운영 워커에는 없다(globalThis.fetch).
  return createClient({ token: env.HUBSPOT_ACCESS_TOKEN, fetch: typeof env.HUBSPOT_FETCH === 'function' ? env.HUBSPOT_FETCH : undefined, base: env.HUBSPOT_API_BASE || undefined });
}
async function kvGet(env, key) {
  const row = await env.DB.prepare('SELECT value FROM crm_kv WHERE key=?').bind(key).first();
  return row ? parseJson(row.value) : null;
}
async function kvSet(env, key, value) {
  await env.DB.prepare('INSERT INTO crm_kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .bind(key, JSON.stringify(value), Date.now()).run();
}
/** 포털에 있는 연락처 속성 이름 — 1시간 캐시(없는 속성을 쓰면 400 이라 매번 확인하되 매 호출마다 묻지는 않는다). */
async function availableProperties(env, client, force) {
  const cached = await kvGet(env, 'hs:props');
  if (!force && cached && Array.isArray(cached.names) && Date.now() - Number(cached.at || 0) < PROPS_CACHE_MS) return new Set(cached.names);
  const check = await client.checkProperties();
  await kvSet(env, 'hs:props', { names: [...check.available], at: Date.now() });
  return check.available;
}
function hsError(error) {
  if (error instanceof HubSpotError) return { code: error.status === 401 ? 'HUBSPOT_AUTH' : error.status === 429 ? 'HUBSPOT_RATE' : 'HUBSPOT', error: error.message, status: error.status };
  return { code: 'HUBSPOT', error: String(error && error.message || error), status: 0 };
}

async function hubspotStatus(env) {
  const client = hubspotClient(env);
  const counts = await queueCounts(env);
  const pull = await kvGet(env, 'hs:pull');
  const settings = await loadSettings(env);
  if (!client) return json({ ok: true, connected: false, reason: 'no_token', queue: counts, pull, portal: settings.hubspot.portal, map: settings.hubspot.map });
  try {
    const s = await client.status();
    const portal = { portalId: s.portalId, uiDomain: s.uiDomain, timeZone: s.timeZone, checkedAt: Date.now() };
    // 화면이 "HubSpot 에서 열기" 링크를 만들 수 있게 포털 정보를 설정 문서에 심는다(토큰은 아니다).
    const doc = await loadDoc(env, 'settings', SETTINGS_ID);
    const cur = doc ? doc.data : { orgName: '', followupOffsets: CORE.FOLLOWUP_OFFSETS.slice(), hubspot: { enabled: true, autoApproveQuick: false, map: {} } };
    const hs = Object.assign({}, isPlainObject(cur.hubspot) ? cur.hubspot : {});
    const strip = x => (isPlainObject(x) ? { portalId: x.portalId, uiDomain: x.uiDomain, timeZone: x.timeZone } : null);
    if (!doc || !same(strip(hs.portal), strip(portal))) { hs.portal = portal; await writeDocRaw(env, 'settings', SETTINGS_ID, Object.assign({}, cur, { hubspot: hs }), SYSTEM_ID); }
    return json({ ok: true, connected: true, portal, via: s.via, queue: counts, pull, map: settings.hubspot.map });
  } catch (error) {
    const e = hsError(error);
    return json({ ok: true, connected: false, reason: e.code, error: e.error, queue: counts, pull, portal: settings.hubspot.portal, map: settings.hubspot.map });
  }
}

async function hubspotPipelines(env) {
  const client = hubspotClient(env);
  if (!client) return fail('HUBSPOT_NO_TOKEN', 'HubSpot 토큰이 등록되지 않았습니다', 409);
  try {
    const pipelines = await client.pipelines();
    const suggested = {};
    CORE.PIPELINES.forEach(p => { suggested[p] = CORE.autoMapPipeline(pipelines, p); });
    return json({ ok: true, pipelines, suggested });
  } catch (error) { const e = hsError(error); return fail(e.code, e.error, 502); }
}

async function hubspotProperties(env, method) {
  const client = hubspotClient(env);
  if (!client) return fail('HUBSPOT_NO_TOKEN', 'HubSpot 토큰이 등록되지 않았습니다', 409);
  try {
    if (method === 'POST') {
      const made = await client.ensureProperties();
      await kvSet(env, 'hs:props', { names: [...new Set(made.present)], at: Date.now() });
      return json({ ok: true, created: made.created, failed: made.failed, present: made.present });
    }
    const check = await client.checkProperties();
    await kvSet(env, 'hs:props', { names: [...check.available], at: Date.now() });
    return json({ ok: true, present: check.present, missing: check.missing });
  } catch (error) { const e = hsError(error); return fail(e.code, e.error, 502); }
}

/* ── push: 승인된 큐 → HubSpot ─────────────────────────────────────────── */

async function linkOf(env, leadId) {
  const row = await env.DB.prepare('SELECT contact_id FROM crm_hs_links WHERE lead_id=?').bind(leadId).first();
  return row ? String(row.contact_id) : '';
}
async function saveLink(env, contactId, leadId) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM crm_hs_links WHERE lead_id=? AND contact_id<>?').bind(leadId, contactId),
    env.DB.prepare('INSERT INTO crm_hs_links(contact_id,lead_id,linked_at) VALUES(?,?,?) ON CONFLICT(contact_id) DO UPDATE SET lead_id=excluded.lead_id,linked_at=excluded.linked_at').bind(contactId, leadId, Date.now())
  ]);
}
async function creditBalanceOf(env, leadId) {
  const credits = await loadCollection(env, 'credits');
  return CORE.creditBalance(credits, leadId);
}
async function contactExtra(env, lead) {
  const extra = { creditBalance: await creditBalanceOf(env, lead.id) };
  if (lead.referrerLeadId) extra.referrerContactId = await linkOf(env, String(lead.referrerLeadId));
  if (lead.partnerId) { const p = await loadDoc(env, 'partners', String(lead.partnerId)); extra.partnerName = p ? String(p.data.name || '') : ''; }
  else if (lead.channel === '파트너' || (lead.hubspot && lead.hubspot.contactId)) extra.partnerName = lead.partnerId ? undefined : '';
  return extra;
}
/** 리드에 HubSpot 연락처를 보장한다 — 연결표 → 전화·이메일로 찾기 → 만들기. 돌려주는 값 { contactId, created }. */
async function leadOfContact(env, contactId) {
  const row = await env.DB.prepare('SELECT lead_id FROM crm_hs_links WHERE contact_id=?').bind(String(contactId)).first();
  return row ? String(row.lead_id) : '';
}
/** 리드 문서의 hubspot 부분만 고친다(CAS) — HubSpot 왕복 사이에 직원이 고친 다른 필드를 덮지 않는다. */
async function patchLeadHubspot(env, lead, patch) {
  const next = await patchDocFields(env, 'leads', lead.id, cur => Object.assign(cur, { hubspot: Object.assign({}, isPlainObject(cur.hubspot) ? cur.hubspot : {}, patch, { syncedAt: Date.now() }) }), SYSTEM_ID);
  if (next) lead.hubspot = next.hubspot;
  return next;
}
async function ensureContact(env, client, lead, available) {
  let contactId = await linkOf(env, lead.id) || String(lead.hubspot && lead.hubspot.contactId || '');
  if (contactId) return { contactId, created: false };
  const found = await client.findContact(lead.phone, lead.email);
  let created = false;
  const patch = {};
  if (found) {
    // 같은 전화·이메일의 연락처가 이미 다른 리드에 연결돼 있으면(형제 등) 조용히 가로채지 않는다 — 원장이 보고 정한다.
    const owner = await leadOfContact(env, found.id);
    if (owner && owner !== lead.id) throw new Error('LINKED: 같은 전화·이메일의 HubSpot 연락처(' + found.id + ')가 이미 다른 리드(' + owner + ')에 연결돼 있습니다 — 두 리드를 합치거나 이 리드의 전화·이메일을 바꿔 주세요');
    contactId = found.id;
    patch.nameParts = { firstname: String(found.properties.firstname || ''), lastname: String(found.properties.lastname || '') };
  } else {
    const made = await client.createContact(contactProperties(lead, await contactExtra(env, lead), available));
    contactId = made.id;
    created = true;
  }
  patch.contactId = contactId;
  await saveLink(env, contactId, lead.id);
  await patchLeadHubspot(env, lead, patch);
  return { contactId, created };
}

async function processItem(env, client, settings, available, item) {
  const doc = await loadDoc(env, 'leads', item.leadId);
  if (!doc) throw new Error('리드가 없습니다(삭제됨)');
  const lead = Object.assign({}, doc.data, { id: item.leadId });
  const ensured = await ensureContact(env, client, lead, available);
  const contactId = ensured.contactId;
  if (item.kind === 'contact') {
    if (ensured.created) return { contactId, action: 'created' };
    await client.updateContact(contactId, contactProperties(lead, await contactExtra(env, lead), available));
    await patchLeadHubspot(env, lead, {});
    return { contactId, action: 'updated' };
  }
  if (item.kind === 'deal') {
    const p = item.payload;
    const pipeline = CORE.PIPELINES.includes(p.pipeline) ? p.pipeline : lead.pipeline;
    const stage = CORE.stagesOf(pipeline).includes(p.stage) ? p.stage : lead.stage;
    const map = isPlainObject(settings.hubspot.map[pipeline]) ? settings.hubspot.map[pipeline] : {};
    const stageId = map.stageMap && map.stageMap[stage];
    if (!map.pipelineId || !stageId) throw new Error('UNMAPPED: ' + CORE.PIPELINE_LABEL[pipeline] + ' / ' + (CORE.STAGE_LABEL[stage] || stage) + ' 단계가 HubSpot 파이프라인에 매핑되지 않았습니다 — 허브스팟 탭에서 매핑을 저장하세요');
    const deals = Object.assign({}, lead.hubspot && lead.hubspot.deals);
    const existing = deals[pipeline] && deals[pipeline].dealId;
    const props = { pipeline: map.pipelineId, dealstage: stageId };
    if (CORE.isClosed(stage)) props.closedate = String(Date.now());
    let dealId;
    if (existing) { await client.updateDeal(existing, props); dealId = String(existing); }
    else { const made = await client.createDeal(Object.assign({ dealname: String(p.dealName || dealName(lead, pipeline)) }, props), contactId); dealId = made.id; }
    const entry = { dealId, pipelineId: map.pipelineId, stageId, stage, updatedAt: Date.now() };
    await patchDocFields(env, 'leads', lead.id, cur => {
      const hs = Object.assign({}, isPlainObject(cur.hubspot) ? cur.hubspot : {});
      hs.deals = Object.assign({}, isPlainObject(hs.deals) ? hs.deals : {}, { [pipeline]: entry });
      hs.syncedAt = Date.now();
      return Object.assign(cur, { hubspot: hs });
    }, SYSTEM_ID);
    return { contactId, dealId, action: existing ? 'stage' : 'created', pipeline, stage };
  }
  if (item.kind === 'note') {
    const act = await loadDoc(env, 'activities', String(item.payload.activityId || ''));
    if (!act) throw new Error('기록이 없습니다');
    if (act.data.hubspot && act.data.hubspot.noteId) return { contactId, noteId: act.data.hubspot.noteId, action: 'already' };
    const byName = await staffNameOf(env, act.data.by);
    const atMs = CORE.validYmd(act.data.at) ? new Date(act.data.at + 'T09:00:00+09:00').getTime() : Number(act.data.ts) || Date.now();
    const note = await client.createNote(noteBody(act.data, byName), Number(act.data.ts) || atMs, contactId);
    await patchDocFields(env, 'activities', String(item.payload.activityId), cur => Object.assign(cur, { hubspot: { noteId: note.id, syncedAt: Date.now() } }), SYSTEM_ID);
    return { contactId, noteId: note.id, action: 'created' };
  }
  throw new Error('모르는 큐 종류');
}

/** 승인된 큐를 만든 순서대로 HubSpot 에 쓴다. 429(속도 제한)면 멈추고 다음 번에. */
export async function flushQueue(env, limit) {
  const client = hubspotClient(env);
  if (!client) return { ok: false, code: 'HUBSPOT_NO_TOKEN', error: 'HubSpot 토큰이 등록되지 않았습니다', done: 0, failed: 0, remaining: 0 };
  const n = Math.min(Math.max(Number(limit) || PUSH_LIMIT_DEFAULT, 1), PUSH_LIMIT_MAX);
  const settings = await loadSettings(env);
  let available;
  try { available = await availableProperties(env, client, false); }
  catch (error) { const e = hsError(error); return Object.assign({ ok: false, done: 0, failed: 0, remaining: 0 }, e); }
  const rows = await env.DB.prepare('SELECT * FROM crm_sync_queue WHERE status=\'approved\' ORDER BY created_at LIMIT ?').bind(n).all();
  const items = (rows.results || []).map(queueView);
  let done = 0, failed = 0, stopped = '';
  const results = [];
  for (const item of items) {
    const now = Date.now();
    try {
      const result = await processItem(env, client, settings, available, item);
      await env.DB.prepare('UPDATE crm_sync_queue SET status=\'done\',result=?,error=NULL,attempts=attempts+1,done_at=?,updated_at=MAX(?,created_at) WHERE id=?').bind(JSON.stringify(result), now, now, item.id).run();
      done++;
      results.push({ id: item.id, ok: true, result });
    } catch (error) {
      const e = hsError(error);
      if (e.code === 'HUBSPOT_RATE' || e.code === 'HUBSPOT_AUTH') { stopped = e.code; results.push({ id: item.id, ok: false, error: e.error }); break; }
      await env.DB.prepare('UPDATE crm_sync_queue SET status=\'failed\',error=?,attempts=attempts+1,updated_at=MAX(?,created_at) WHERE id=?').bind(String(e.error).slice(0, 500), now, item.id).run();
      failed++;
      results.push({ id: item.id, ok: false, error: e.error });
    }
  }
  const counts = await queueCounts(env);
  return { ok: true, done, failed, remaining: counts.approved, stopped, results, counts };
}

/* ── pull: HubSpot 변경분 → 리드 ────────────────────────────────────────── */

async function pullContacts(env, body) {
  const client = hubspotClient(env);
  if (!client) return fail('HUBSPOT_NO_TOKEN', 'HubSpot 토큰이 등록되지 않았습니다', 409);
  const full = !!(body && body.full);
  const settings = await loadSettings(env);
  const today = kstToday();
  try {
    const available = await availableProperties(env, client, false);
    const saved = (await kvGet(env, 'hs:pull')) || {};
    let since = full ? 0 : Number(saved.since) || 0, after = full ? '' : String(saved.after || '');
    const startedAt = Date.now();
    const stat = { created: 0, updated: 0, conflicts: 0, invalid: 0, deleted: 0, seen: 0 };
    let maxWritten = since, more = false, total = 0, pageSeen = 0;
    const links = await env.DB.prepare('SELECT contact_id,lead_id FROM crm_hs_links').all();
    const linkByContact = {};
    (links.results || []).forEach(r => { linkByContact[String(r.contact_id)] = String(r.lead_id); });
    const openQueue = await env.DB.prepare('SELECT DISTINCT lead_id FROM crm_sync_queue WHERE status IN (\'pending\',\'approved\')').all();
    const busy = new Set((openQueue.results || []).map(r => String(r.lead_id)));
    // 지난번에 미반영 변경 때문에 건너뛴 연락처 — 커서는 지나갔으므로 id 로 따로 다시 읽는다(안 그러면 그 수정은 영영 안 들어온다).
    const retry = new Set((Array.isArray(saved.retry) ? saved.retry : []).map(String));

    /** 연락처 한 건 → 리드. 돌려주는 값: 'created'|'updated'|'conflict'|'invalid'|'deleted' */
    const importContact = async (contact, deals) => {
      let leadId = linkByContact[contact.id] || '';
      if (!leadId && contact.properties.wb_crm_lead_id && DOC_ID.test(String(contact.properties.wb_crm_lead_id))) {
        const byId = await loadDoc(env, 'leads', String(contact.properties.wb_crm_lead_id));
        if (byId) leadId = String(contact.properties.wb_crm_lead_id);
      }
      if (leadId) {
        const row = await env.DB.prepare('SELECT deleted FROM crm_documents WHERE collection=? AND id=? LIMIT 1').bind('leads', leadId).first();
        if (row && Number(row.deleted)) return 'deleted';          // 원장이 지운 리드는 되살리지 않는다
        if (busy.has(leadId)) { retry.add(contact.id); return 'conflict'; }   // 우리 쪽 미반영 변경이 있으면 덮지 않고 다음에 다시
      }
      const existing = leadId ? await loadDoc(env, 'leads', leadId) : null;
      if (!leadId) leadId = 'hs_' + contact.id;
      let lead = leadFromContact(contact, existing ? existing.data : null, { today });
      lead = applyDealsToLead(lead, deals, settings.hubspot.map);
      const v = CORE.validateLead(Object.assign({}, lead, { id: leadId }), { today });
      if (!v.ok) return 'invalid';
      const data = v.data;
      // HubSpot 쪽 이름·메모에 전화 패턴이 섞여 있으면 그 리드는 우리 규칙으로 다시 저장할 수 없다 — 들여오지 않고 센다.
      if (findPii(data, '', LEAD_PII_SKIP)) return 'invalid';
      if (!data.owner) data.owner = existing && existing.data.owner ? existing.data.owner : ADMIN_ID;
      if (lead.creditBalanceHs !== undefined) data.creditBalanceHs = lead.creditBalanceHs;
      await writeDocRaw(env, 'leads', leadId, data, SYSTEM_ID);
      await saveLink(env, contact.id, leadId);
      linkByContact[contact.id] = leadId;
      retry.delete(contact.id);
      return existing ? 'updated' : 'created';
    };
    const dealsFor = async contacts => {
      const dealIds = await client.dealIdsForContacts(contacts.map(c => c.id));
      const allDealIds = Object.values(dealIds).flat();
      const deals = allDealIds.length ? await client.readDeals(allDealIds) : [];
      const dealById = {};
      deals.forEach(d => { dealById[d.id] = d; });
      return c => (dealIds[c.id] || []).map(id => dealById[id]).filter(Boolean);
    };
    const count = r => { stat.seen++; if (r === 'conflict') stat.conflicts++; else if (r === 'created') stat.created++; else if (r === 'updated') stat.updated++; else if (r === 'invalid') stat.invalid++; else if (r === 'deleted') stat.deleted++; };

    // 1) 지난번 건너뛴 연락처 먼저
    if (retry.size && !after) {
      const ids = [...retry];
      const contacts = await client.readContacts(ids, available);
      const lookup = await dealsFor(contacts);
      ids.forEach(id => { if (!contacts.some(c => c.id === id)) retry.delete(id); });   // HubSpot 에서 사라진 연락처
      for (const contact of contacts) count(await importContact(contact, lookup(contact)));
    }
    // 2) 변경분
    for (let page = 0; page < PULL_PAGES_PER_CALL; page++) {
      const res = await client.contactsModifiedSince(since, after, available);
      total = res.total;
      const contacts = res.results;
      if (!contacts.length) { after = ''; break; }
      const lookup = await dealsFor(contacts);
      for (const contact of contacts) {
        const r = await importContact(contact, lookup(contact));
        count(r); pageSeen++;
        // 커서는 실제로 처리한(쓴·지워진·무효) 연락처까지만 — 건너뛴 것은 retry 목록이 맡는다
        const modified = Number(contact.properties.lastmodifieddate) || new Date(contact.updatedAt || 0).getTime() || 0;
        if (modified > maxWritten) maxWritten = modified;
      }
      after = res.after;
      if (!after) break;
      if (page === PULL_PAGES_PER_CALL - 1) more = true;
    }
    // 커서: 페이지가 남았으면 after 를 이어 가고, 끝났으면 다음엔 "이번에 본 마지막 수정 시각" 이후만 본다. retry 는 커서와 따로 간다.
    const cursor = after ? { since, after, at: startedAt, retry: [...retry], lastFullAt: saved.lastFullAt || 0 }
      : { since: pageSeen ? Math.max(maxWritten + 1, since) : since, after: '', at: startedAt, retry: [...retry], lastFullAt: full ? startedAt : saved.lastFullAt || 0 };
    await kvSet(env, 'hs:pull', cursor);
    return json(Object.assign({ ok: true, total, more, retry: retry.size, cursor }, stat));
  } catch (error) { const e = hsError(error); return fail(e.code, e.error, 502); }
}

/* ── 내보내기 ─────────────────────────────────────────────────────────── */

async function exportAll(env) {
  const rows = await env.DB.prepare('SELECT collection,id,data,updated_at,updated_by,deleted FROM crm_documents ORDER BY collection, id').all();
  const staff = await env.DB.prepare('SELECT id,name,role,active,created_at,updated_at FROM crm_staff ORDER BY id').all();
  const queue = await env.DB.prepare('SELECT * FROM crm_sync_queue ORDER BY created_at').all();
  const links = await env.DB.prepare('SELECT contact_id,lead_id,linked_at FROM crm_hs_links').all();
  const partnerCodes = await env.DB.prepare('SELECT partner_id, COUNT(*) AS n FROM crm_partner_tokens WHERE revoked=0 GROUP BY partner_id').all();
  const now = Date.now();
  return json({
    ok: true, app: APP_NAME, now, docs: (rows.results || []).map(docView),
    staff: (staff.results || []).map(r => Object.assign(staffView(r), { createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) })),
    queue: (queue.results || []).map(queueView), links: (links.results || []).map(r => ({ contactId: String(r.contact_id), leadId: String(r.lead_id), linkedAt: Number(r.linked_at) })),
    partnerDevices: (partnerCodes.results || []).map(r => ({ partnerId: String(r.partner_id), devices: Number(r.n) }))
  }, 200, { 'Content-Disposition': 'attachment; filename="wb-crm-export-' + new Date(now).toISOString().slice(0, 10) + '.json"' });
}

/* ── 라우터 ──────────────────────────────────────────────────────────── */

function methodNotAllowed() { return fail('METHOD', '허용되지 않는 메서드입니다', 405); }
function adminOnly(auth) { return auth.role === 'admin' ? null : fail('FORBIDDEN', '원장만 할 수 있습니다', 403); }

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = String(request.method || 'GET').toUpperCase();
  try {
    if (path === '/api/health') return method === 'GET' ? health(env) : methodNotAllowed();
    if (path === '/api/setup') return method === 'POST' ? setup(env, await readJson(request)) : methodNotAllowed();
    if (path === '/api/login') return method === 'POST' ? login(env, await readJson(request)) : methodNotAllowed();
    if (path === '/api/link-exchange') return method === 'POST' ? linkExchange(env, await readJson(request)) : methodNotAllowed();

    // 파트너 포털 API — 파트너 토큰만 받고 직원 토큰과 섞이지 않는다(partner-api.mjs). 다른 /api/* 는 파트너 토큰으로 열리지 않는다.
    if (path === '/api/partner' || path.startsWith('/api/partner/')) return handlePartnerApi(request, env, ctx);

    const auth = await resolveAuth(request, env);
    if (!auth) return fail('AUTH', '로그인이 필요합니다', 401);

    if (path === '/api/partners') return method === 'POST' ? partnerOp(env, auth, await readJson(request)) : methodNotAllowed();

    if (path === '/api/me') return method === 'GET' ? json({ ok: true, role: auth.role, staffId: auth.staffId, name: auth.name }) : methodNotAllowed();
    if (path === '/api/logout') {
      if (method !== 'POST') return methodNotAllowed();
      await env.DB.prepare('UPDATE crm_tokens SET revoked=1 WHERE token_hash=?').bind(auth.tokenHash).run();
      return json({ ok: true });
    }
    if (path === '/api/password') return method === 'POST' ? changePassword(env, auth, await readJson(request)) : methodNotAllowed();
    if (path === '/api/staff') {
      if (method === 'GET') return listStaff(env);
      if (method === 'POST') return staffOp(env, auth, await readJson(request));
      return methodNotAllowed();
    }
    if (path === '/api/docs') {
      if (method === 'GET') return readDocs(env, url);
      if (method === 'POST') return writeDocs(env, auth, await readJson(request));
      return methodNotAllowed();
    }
    if (path === '/api/export') {
      if (method !== 'GET') return methodNotAllowed();
      return adminOnly(auth) || exportAll(env);
    }
    if (path === '/api/hubspot/queue') {
      if (method === 'GET') return listQueue(env, url);
      if (method === 'POST') return queueOp(env, auth, await readJson(request));
      return methodNotAllowed();
    }
    if (path.startsWith('/api/hubspot/')) {
      const denied = adminOnly(auth);
      if (denied) return denied;
      if (path === '/api/hubspot/status') return method === 'GET' ? hubspotStatus(env) : methodNotAllowed();
      if (path === '/api/hubspot/pipelines') return method === 'GET' ? hubspotPipelines(env) : methodNotAllowed();
      if (path === '/api/hubspot/properties') return method === 'GET' || method === 'POST' ? hubspotProperties(env, method) : methodNotAllowed();
      if (path === '/api/hubspot/pull') return method === 'POST' ? pullContacts(env, await readJson(request)) : methodNotAllowed();
      if (path === '/api/hubspot/push') {
        if (method !== 'POST') return methodNotAllowed();
        const body = await readJson(request);
        const r = await flushQueue(env, body && body.limit);
        return r.ok ? json(r) : fail(r.code, r.error, r.code === 'HUBSPOT_NO_TOKEN' ? 409 : 502, r);
      }
    }
    return fail('NOT_FOUND', '없는 API 경로입니다', 404);
  } catch (error) {
    return fail('SERVER', String(error && error.message || error), 500);
  }
}
