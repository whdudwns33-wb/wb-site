// WB 세일즈데스크 — 파트너 학원 포털 API(/api/partner/*). 외부 사용자(파트너 학원)가 쓰는 유일한 출입구다.
// 경계(docs/파트너학원-연계-기획서-v0.md §6): 파트너 토큰은 여기서만 통하고, 응답에는 전화·이메일·메모·내부 단계가 없다.
// 파트너가 보낸 가정은 센터 리드로 바로 생긴다(채널 '파트너' + partnerId) — 리드가 두 곳에 생기지 않게 같은 D1 을 쓴다.
// 나중에 별도 워커로 떼어낼 때는 이 파일 + crm/partner/ + crm_partner_* 표를 옮긴다(crm-shared 의 도우미는 복사).
import CORE from './crm-core.js';
import { SYSTEM_ID, DOC_ID, PII_ALLOWED_PATHS, json, fail, hasPii, findPii, isPlainObject, changesOf, kstToday, readJson, sha256Hex, randomOpaqueValue, randomSlug,
  loadDoc, loadCollection, loadSettings, writeDocRaw, enqueueFor, LINK_CODE, CODE_TTL_MS } from './crm-shared.mjs';

const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const LAST_SEEN_WRITE_GAP_MS = 60 * 1000;
const MAX_MEMO = 300;
/* 한 파트너가 하루에 보낼 수 있는 소개 — 실수·오작동이 리드를 쏟아내지 않게. 넘으면 원장이 직접 받는다. */
const DAILY_REFERRAL_CAP = 20;

function partnerActor(partnerId) { return 'partner:' + String(partnerId); }

/* ── 토큰 ───────────────────────────────────────────────────────────── */

async function issueToken(env, partnerId) {
  const token = randomOpaqueValue();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO crm_partner_tokens(token_hash,partner_id,created_at,last_seen,revoked) VALUES(?,?,?,?,0)')
    .bind(await sha256Hex(token), partnerId, now, now).run();
  return { token, expiresAt: now + TOKEN_TTL_MS };
}

/** Bearer → { partnerId, partner(문서), tokenHash }. 일시 중지·삭제된 파트너는 토큰이 살아 있어도 null. */
export async function resolvePartnerAuth(request, env) {
  const header = String(request.headers.get('Authorization') || '').trim();
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{1,256})$/i.exec(header);
  if (!match) return null;
  const tokenHash = await sha256Hex(match[1]);
  const row = await env.DB.prepare('SELECT partner_id,last_seen FROM crm_partner_tokens WHERE token_hash=? AND revoked=0 LIMIT 1').bind(tokenHash).first();
  if (!row) return null;
  const now = Date.now();
  if (now - Number(row.last_seen || 0) > TOKEN_TTL_MS) return null;
  const doc = await loadDoc(env, 'partners', String(row.partner_id));
  if (!doc || doc.data.status !== 'active') return null;
  if (now - Number(row.last_seen || 0) > LAST_SEEN_WRITE_GAP_MS) {
    await env.DB.prepare('UPDATE crm_partner_tokens SET last_seen=? WHERE token_hash=? AND last_seen<?').bind(now, tokenHash, now).run();
  }
  return { partnerId: String(row.partner_id), partner: Object.assign({}, doc.data, { id: String(row.partner_id) }), tokenHash };
}

async function linkExchange(env, body) {
  const code = body && typeof body.code === 'string' ? body.code.trim() : '';
  if (!LINK_CODE.test(code)) return fail('CODE_INVALID', '연결 코드가 올바르지 않습니다', 401);
  const codeHash = await sha256Hex(code.toLowerCase());
  const now = Date.now();
  const row = await env.DB.prepare('SELECT partner_id,expires_at,consumed_at,revoked FROM crm_partner_codes WHERE code_hash=? LIMIT 1').bind(codeHash).first();
  if (!row || Number(row.revoked) || row.consumed_at !== null || Number(row.expires_at) < now) return fail('CODE_INVALID', '연결 코드가 만료되었거나 이미 사용되었습니다', 401);
  const doc = await loadDoc(env, 'partners', String(row.partner_id));
  if (!doc || doc.data.status !== 'active') return fail('PARTNER_INACTIVE', '연계가 중지된 파트너입니다. 센터에 문의해 주세요', 403);
  const consumed = await env.DB.prepare('UPDATE crm_partner_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL').bind(now, codeHash).run();
  if (changesOf(consumed) === 0) return fail('CODE_INVALID', '연결 코드가 이미 사용되었습니다', 401);
  const issued = await issueToken(env, String(row.partner_id));
  return json({ ok: true, token: issued.token, expiresAt: issued.expiresAt, partner: publicPartner(doc.data, String(row.partner_id)) });
}

/* ── 원장 쪽: 링크 발급·기기 해제 (POST /api/partners) ───────────────────── */

export async function partnerOp(env, auth, body) {
  if (auth.role !== 'admin') return fail('FORBIDDEN', '파트너 링크는 원장만 발급합니다', 403);
  const op = body ? String(body.op || '') : '';
  const partnerId = body ? String(body.partnerId || '') : '';
  if (!DOC_ID.test(partnerId)) return fail('INVALID', '파트너 id 형식이 올바르지 않습니다');
  const doc = await loadDoc(env, 'partners', partnerId);
  if (!doc) return fail('NOT_FOUND', '파트너를 찾을 수 없습니다', 404);
  const now = Date.now();
  if (op === 'link') {
    if (doc.data.status !== 'active') return fail('PARTNER_INACTIVE', '일시 중지된 파트너에게는 링크를 만들 수 없습니다', 409);
    const code = randomOpaqueValue();
    const expiresAt = now + CODE_TTL_MS;
    await env.DB.prepare('INSERT INTO crm_partner_codes(code_hash,partner_id,expires_at,consumed_at,revoked,created_at) VALUES(?,?,?,NULL,0,?)').bind(await sha256Hex(code), partnerId, expiresAt, now).run();
    return json({ ok: true, code, expiresAt, partnerId });
  }
  if (op === 'revoke') {
    const results = await env.DB.batch([
      env.DB.prepare('UPDATE crm_partner_tokens SET revoked=1 WHERE partner_id=? AND revoked=0').bind(partnerId),
      env.DB.prepare('UPDATE crm_partner_codes SET revoked=1 WHERE partner_id=? AND consumed_at IS NULL AND revoked=0').bind(partnerId)
    ]);
    return json({ ok: true, partnerId, revokedTokens: changesOf(results[0]), revokedCodes: changesOf(results[1]) });
  }
  if (op === 'devices') {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM crm_partner_tokens WHERE partner_id=? AND revoked=0').bind(partnerId).first();
    return json({ ok: true, partnerId, devices: Number(row && row.n || 0) });
  }
  return fail('INVALID', '지원하지 않는 작업입니다');
}

/* ── 파트너가 보는 모양 ───────────────────────────────────────────────── */

function publicPartner(p, id) {
  return { id, name: String(p.name || ''), kind: String(p.kind || ''), status: String(p.status || ''), terms: isPlainObject(p.terms) ? { inbound: String(p.terms.inbound || ''), outbound: String(p.terms.outbound || '') } : { inbound: '', outbound: '' } };
}
/** 들어온 소개(리드) — 보호자 이름·아이·학년·접수일·거친 단계뿐. 전화·이메일·메모·내부 단계는 내려가지 않는다. */
function inboundView(l) {
  return { id: String(l.id), name: String(l.name || ''), childName: String(l.child && l.child.name || ''), grade: String(l.child && l.child.grade || ''),
    createdAt: String(l.createdAt || ''), stage: CORE.coarseStage(l), closed: l.status === 'won' || l.status === 'lost' };
}
function outboundView(r, lead) {
  return { id: String(r.id), childName: String(lead && lead.child && lead.child.name || ''), grade: String(lead && lead.child && lead.child.grade || ''),
    guardian: String(lead && lead.name || ''), at: String(r.at || ''), note: String(r.note || ''), status: String(r.status || 'sent'), statusAt: String(r.statusAt || ''), partnerNote: String(r.partnerNote || '') };
}

async function me(env, auth) {
  const settings = await loadSettings(env);
  const leads = (await loadCollection(env, 'leads')).filter(l => l.partnerId === auth.partnerId);
  const referrals = (await loadCollection(env, 'referrals')).filter(r => r.partnerId === auth.partnerId);
  const stats = CORE.partnerStats(leads, referrals, [auth.partner], '')[0];
  return json({ ok: true, partner: publicPartner(auth.partner, auth.partnerId), org: settings.orgName || 'WB 웩슬러브레인센터', stats });
}

async function listReferrals(env, auth) {
  const leads = await loadCollection(env, 'leads');
  const byId = {};
  leads.forEach(l => { byId[l.id] = l; });
  const inbound = leads.filter(l => l.partnerId === auth.partnerId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(inboundView);
  const outbound = (await loadCollection(env, 'referrals')).filter(r => r.partnerId === auth.partnerId && r.direction === 'out')
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).map(r => outboundView(r, byId[r.leadId]));
  return json({ ok: true, inbound, outbound });
}

/** 소개 보내기 → 센터 리드. 동의 필수, 전화는 전화 칸에만, 하루 상한. */
async function createReferral(env, auth, body) {
  if (!body) return fail('INVALID', '내용이 없습니다');
  if (!body.consent) return fail('CONSENT', '보호자의 동의를 받은 뒤 보내 주세요(동의 확인 체크)');
  const memo = String(body.memo || '').trim().slice(0, MAX_MEMO);
  if (hasPii(memo)) return fail('PII', '메모에는 전화번호·이메일을 적을 수 없습니다 — 전화는 전화 칸에');
  const today = kstToday();
  const recent = (await loadCollection(env, 'leads')).filter(l => l.partnerId === auth.partnerId && l.createdAt === today).length;
  if (recent >= DAILY_REFERRAL_CAP) return fail('CAP', '오늘 보낼 수 있는 소개 수를 넘었습니다 — 센터로 직접 연락해 주세요', 429);
  const v = CORE.validateLead({
    name: body.name, relation: body.relation, phone: body.phone, channel: '파트너', partnerId: auth.partnerId, channelNote: String(auth.partner.name || '').slice(0, 120),
    child: { name: body.childName, grade: body.grade, birth: body.birth }, interests: ['검사'],
    source: '파트너 ' + String(auth.partner.name || '') + ' 소개' + (memo ? '\n' + memo : ''), pipeline: 'inspection', stage: 'inquiry', owner: 'admin', createdAt: today, stageAt: today
  }, { today });
  if (!v.ok) return fail('INVALID', v.error);
  const pii = findPii(v.data, '', PII_ALLOWED_PATHS);
  if (pii) return fail('PII', '이름·학년 칸에 전화번호·이메일을 적을 수 없습니다 — 전화는 전화 칸에');
  const id = 'ld_' + randomSlug(14);
  const data = Object.assign(v.data, { hubspot: {} });
  await writeDocRaw(env, 'leads', id, data, partnerActor(auth.partnerId));
  const settings = await loadSettings(env);
  if (settings.hubspot.enabled) await enqueueFor(env, { staffId: partnerActor(auth.partnerId) }, settings, 'leads', id, null, data);
  await writeDocRaw(env, 'activities', 'ac_' + randomSlug(14), { leadId: id, type: 'note', text: '파트너 포털에서 소개 접수' + (memo ? '\n' + memo : ''), result: '', at: today, ts: Date.now(), followupDay: 0, from: '', to: '', by: partnerActor(auth.partnerId), hubspot: {} }, partnerActor(auth.partnerId));
  return json({ ok: true, referral: inboundView(Object.assign({}, data, { id })) });
}

/** 받은 소개의 진행 상태 — 자기에게 온 나가는 소개만, 상태·메모만 바꾼다. */
async function updateStatus(env, auth, id, body) {
  if (!DOC_ID.test(id)) return fail('INVALID', 'id 형식');
  const doc = await loadDoc(env, 'referrals', id);
  if (!doc || doc.data.partnerId !== auth.partnerId || doc.data.direction !== 'out') return fail('NOT_FOUND', '받은 소개를 찾을 수 없습니다', 404);
  const status = body ? String(body.status || '') : '';
  if (!CORE.REFERRAL_STATUS.includes(status)) return fail('INVALID', '상태 값이 올바르지 않습니다');
  const partnerNote = body && body.note !== undefined ? String(body.note || '').trim().slice(0, MAX_MEMO) : String(doc.data.partnerNote || '');
  if (hasPii(partnerNote)) return fail('PII', '메모에는 전화번호·이메일을 적을 수 없습니다');
  const next = Object.assign({}, doc.data, { status, partnerNote, statusAt: status !== doc.data.status || !doc.data.statusAt ? kstToday() : doc.data.statusAt });
  await writeDocRaw(env, 'referrals', id, next, partnerActor(auth.partnerId));
  const lead = await loadDoc(env, 'leads', String(doc.data.leadId));
  return json({ ok: true, referral: outboundView(Object.assign({}, next, { id }), lead ? lead.data : null) });
}

/* ── 라우터 ──────────────────────────────────────────────────────────── */

function methodNotAllowed() { return fail('METHOD', '허용되지 않는 메서드입니다', 405); }

export async function handlePartnerApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = String(request.method || 'GET').toUpperCase();
  try {
    if (path === '/api/partner/link-exchange') return method === 'POST' ? linkExchange(env, await readJson(request)) : methodNotAllowed();
    const auth = await resolvePartnerAuth(request, env);
    if (!auth) return fail('AUTH', '파트너 연결이 필요합니다 — 센터에서 받은 링크로 열어 주세요', 401);
    if (path === '/api/partner/me') return method === 'GET' ? me(env, auth) : methodNotAllowed();
    if (path === '/api/partner/logout') {
      if (method !== 'POST') return methodNotAllowed();
      await env.DB.prepare('UPDATE crm_partner_tokens SET revoked=1 WHERE token_hash=?').bind(auth.tokenHash).run();
      return json({ ok: true });
    }
    if (path === '/api/partner/referrals') {
      if (method === 'GET') return listReferrals(env, auth);
      if (method === 'POST') return createReferral(env, auth, await readJson(request));
      return methodNotAllowed();
    }
    const m = /^\/api\/partner\/referrals\/([^/]+)\/status$/.exec(path);
    if (m) return method === 'POST' ? updateStatus(env, auth, decodeURIComponent(m[1]), await readJson(request)) : methodNotAllowed();
    return fail('NOT_FOUND', '없는 API 경로입니다', 404);
  } catch (error) {
    return fail('SERVER', String(error && error.message || error), 500);
  }
}
