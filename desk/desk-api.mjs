// WB 프로그램데스크 API(/api/*). 표준 Request/Response 만 쓴다 — Cloudflare Worker 와 Node 22(테스트·dev-server)
// 양쪽에서 같은 코드가 돈다. node: 모듈은 절대 import 하지 않는다(워커 번들 불가).
// 인증: 원장 비밀번호(PBKDF2) → Bearer 토큰, 직원은 1회용 링크 코드 → Bearer 토큰. 토큰은 sha256 만 저장한다.
// 문서(desk_documents)는 컬렉션별 규칙 함수가 검사하고, 전화번호는 students.guardian.phone 에만 허용한다.
import { handleRequests, exportRequests, hasPii } from './requests.mjs';

const APP_NAME = 'wb-desk';
const ADMIN_ID = 'admin';
const ADMIN_NAME = '원장';
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const PASSWORD_ITERATIONS = 100000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// TTL 은 last_seen 기준(쓰면 연장). 원장 기기는 짧게, 직원 폰은 재연결 부담을 줄이려 길게.
const TOKEN_TTL_MS = { admin: 30 * 24 * 60 * 60 * 1000, staff: 180 * 24 * 60 * 60 * 1000 };
// last_seen 은 요청마다 쓰지 않고 1분에 한 번만 — D1 쓰기 횟수를 줄인다.
const LAST_SEEN_WRITE_GAP_MS = 60 * 1000;
const STAFF_ID = /^[A-Za-z0-9_-]{3,64}$/;
const LINK_CODE = /^[a-f0-9]{48}$/i;
const DOC_ID = /^[A-Za-z0-9_|.:@-]{1,160}$/;
const COLLECTIONS = new Set(['students', 'tasks', 'checks', 'contacts', 'settings', 'cards', 'plans', 'apps', 'manuals']);
// 기획서 v1.1 — 프로그램 방 6개. students.programs 의 4개(구독)와 달리 자료 출처 2곳(이그잼포유·족보닷컴)이 더 있다.
const ROOMS = new Set(['studyforce', 'classcard', 'metamath', 'nelt', 'exam4you', 'jokbo']);
const CARD_STATUS = new Set(['todo', 'doing', 'done', 'blocked']);
const CARD_TARGETS = new Set(['student', 'app', 'text']);
const EVIDENCE_KINDS = new Set(['check', 'capture', 'file']);
const PLAN_KINDS = new Set(['recurring', 'apprange']);
const PLAN_TARGETS = new Set(['each', 'student', 'app', 'text']);
const RANGE_STATUS = new Set(['need', 'buying', 'uploading', 'have']);
const RANGE_SOURCES = new Set(['exam4you', 'jokbo', 'other']);
const MANUAL_SCOPES = new Set(['studyforce', 'classcard', 'metamath', 'nelt', 'exam4you', 'jokbo', 'app']);
const HTTPS_URL = /^https:\/\/[^\s"'<>]{1,200}$/;
const MAX_CHANGES = 200;
const MAX_DOC_BYTES = 64 * 1024;
const MAX_TASK_BYTES = 16 * 1024;
const EXT_KEY = /^[a-z_]{1,40}$/;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const PHONE = /^[0-9-]+$/;
const STUDENT_STATUS = new Set(['active', 'paused', 'ended']);
const PROGRAM_KEYS = new Set(['studyforce', 'classcard', 'metamath', 'nelt']);
const ACCOUNT_STATES = new Set(['none', 'requested', 'issued']);
const CONTACT_TYPES = new Set(['call', 'msg', 'visit']);
const CONTACT_RESULTS = new Set(['reached', 'no_answer', 'note']);
// checks 문서에서 "자유 텍스트"로 보는 키 — 여기만 300자 상한·PII 거부를 건다. id·시각 같은 값은 숫자열이라
// 주민번호 패턴에 오탐될 수 있어 전부를 훑지 않는다.
const FREE_TEXT_KEYS = new Set(['note', 'memo', 'reason', 'comment', 'remark', 'text', 'detail', 'desc',
  'description', 'message', 'msg', 'resultNote', 'blockNote', 'blockReason', 'summary']);
const MAX_FREE_TEXT = 300;
const LIC_PREFIX = '__lic__';
const LICEV_PREFIX = '__licev__';

const encoder = new TextEncoder();

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }, extraHeaders || {})
  });
}

function fail(code, error, status, extra) {
  return json(Object.assign({ ok: false, code, error }, extra || {}), status || 400);
}

/* ── 암호 도우미 (sync/worker-core.js 와 같은 방식) ─────────────────────── */

/** 상수 시간 비교 — 비밀키를 한 글자씩 떠보는 공격을 막는다 */
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function hexBytes(value) {
  const pairs = String(value || '').match(/.{2}/g) || [];
  return new Uint8Array(pairs.map(pair => parseInt(pair, 16)));
}

async function sha256Hex(value) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value || '')))));
}

async function passwordHash(password, saltHex, iterations) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(String(password || '')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexBytes(saltHex), iterations }, material, 256
  );
  return hex(new Uint8Array(bits));
}

function randomOpaqueValue() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

function randomSlug(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

function changesOf(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

function parseJson(text) {
  try { return JSON.parse(String(text)); } catch (error) { return null; }
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch (error) { return null; }
}

function byteLength(text) {
  return encoder.encode(text).length;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function absent(value) {
  return value === undefined || value === null || value === '';
}

/* ── 토큰 ───────────────────────────────────────────────────────────── */

async function issueToken(env, staffId, role) {
  const token = randomOpaqueValue();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO desk_tokens(token_hash,staff_id,role,created_at,last_seen,revoked) VALUES(?,?,?,?,?,0)'
  ).bind(await sha256Hex(token), staffId, role, now, now).run();
  return { token, expiresAt: now + TOKEN_TTL_MS[role] };
}

async function resolveAuth(request, env) {
  const header = String(request.headers.get('Authorization') || '').trim();
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{1,256})$/i.exec(header);
  if (!match) return null;
  const tokenHash = await sha256Hex(match[1]);
  const row = await env.DB.prepare(
    'SELECT staff_id,role,last_seen FROM desk_tokens WHERE token_hash=? AND revoked=0 LIMIT 1'
  ).bind(tokenHash).first();
  if (!row) return null;
  const role = row.role === 'admin' ? 'admin' : 'staff';
  const now = Date.now();
  const lastSeen = Number(row.last_seen || 0);
  if (now - lastSeen > TOKEN_TTL_MS[role]) return null;
  let staffId = ADMIN_ID;
  let name = ADMIN_NAME;
  if (role === 'staff') {
    // 비활성 직원의 토큰은 폐기하지 않아도 여기서 막힌다 — 다시 활성화하면 같은 기기로 바로 이어 쓸 수 있다.
    const staff = await env.DB.prepare('SELECT id,name,active FROM desk_staff WHERE id=? LIMIT 1')
      .bind(String(row.staff_id)).first();
    if (!staff || !Number(staff.active)) return null;
    staffId = String(staff.id);
    name = String(staff.name);
  }
  if (now - lastSeen > LAST_SEEN_WRITE_GAP_MS) {
    await env.DB.prepare('UPDATE desk_tokens SET last_seen=? WHERE token_hash=? AND last_seen<?')
      .bind(now, tokenHash, now).run();
  }
  return { role, staffId, name, tokenHash };
}

/* ── 인증 없는 경로 ───────────────────────────────────────────────────── */

async function adminRow(env) {
  return env.DB.prepare(
    'SELECT password_salt,password_hash,password_iterations,failed_attempts,locked_until FROM desk_admin WHERE id=1'
  ).first();
}

async function health(env) {
  let setup = false;
  try { setup = !!(await env.DB.prepare('SELECT id FROM desk_admin WHERE id=1').first()); } catch (error) { setup = false; }
  return json({ ok: true, app: APP_NAME, setup, now: Date.now() });
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX;
}

async function setup(env, body) {
  if (!body || !validPassword(body.password)) {
    return fail('INVALID', '비밀번호는 8~72자로 입력해 주세요');
  }
  if (await adminRow(env)) return fail('ALREADY_SETUP', '관리자 비밀번호가 이미 있습니다', 409);
  const salt = randomOpaqueValue();
  const hash = await passwordHash(body.password, salt, PASSWORD_ITERATIONS);
  // id=1 고정이라 동시에 두 번 들어와도 한 쪽만 만든다(INSERT OR IGNORE).
  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO desk_admin(id,password_salt,password_hash,password_iterations,failed_attempts,locked_until,created_at) ' +
    'VALUES(1,?,?,?,0,0,?)'
  ).bind(salt, hash, PASSWORD_ITERATIONS, Date.now()).run();
  if (changesOf(result) === 0) return fail('ALREADY_SETUP', '관리자 비밀번호가 이미 있습니다', 409);
  const issued = await issueToken(env, ADMIN_ID, 'admin');
  return json({ ok: true, role: 'admin', token: issued.token, expiresAt: issued.expiresAt });
}

async function login(env, body) {
  const row = await adminRow(env);
  if (!row) return fail('NOT_SETUP', '관리자 비밀번호를 먼저 만들어 주세요', 409);
  const now = Date.now();
  if (Number(row.locked_until || 0) > now) {
    return fail('LOGIN_LOCKED', '시도 횟수가 많습니다. 5분 후 다시 시도해 주세요', 429);
  }
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (password.length > PASSWORD_MAX) return fail('LOGIN_FAILED', '비밀번호가 맞지 않습니다', 401);
  const hash = await passwordHash(password, row.password_salt, Number(row.password_iterations));
  if (!safeEqual(hash, row.password_hash)) {
    const failures = Number(row.failed_attempts || 0) + 1;
    const locked = failures >= LOGIN_MAX_FAILURES;
    await env.DB.prepare('UPDATE desk_admin SET failed_attempts=?,locked_until=? WHERE id=1')
      .bind(locked ? 0 : failures, locked ? now + LOGIN_LOCK_MS : 0).run();
    return fail('LOGIN_FAILED', '비밀번호가 맞지 않습니다', 401);
  }
  await env.DB.prepare('UPDATE desk_admin SET failed_attempts=0,locked_until=0 WHERE id=1').run();
  const issued = await issueToken(env, ADMIN_ID, 'admin');
  return json({ ok: true, role: 'admin', token: issued.token, expiresAt: issued.expiresAt });
}

async function linkExchange(env, body) {
  const code = body && typeof body.code === 'string' ? body.code.trim() : '';
  if (!LINK_CODE.test(code)) return fail('CODE_INVALID', '연결 코드가 올바르지 않습니다', 401);
  const codeHash = await sha256Hex(code.toLowerCase());
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT staff_id,expires_at,consumed_at,revoked FROM desk_codes WHERE code_hash=? LIMIT 1'
  ).bind(codeHash).first();
  if (!row || Number(row.revoked) || row.consumed_at !== null || Number(row.expires_at) < now) {
    return fail('CODE_INVALID', '연결 코드가 만료되었거나 이미 사용되었습니다', 401);
  }
  const staff = await env.DB.prepare('SELECT id,name,active FROM desk_staff WHERE id=? LIMIT 1')
    .bind(String(row.staff_id)).first();
  if (!staff || !Number(staff.active)) return fail('STAFF_INACTIVE', '비활성 직원입니다. 원장에게 문의해 주세요', 403);
  // 같은 코드가 동시에 두 기기에서 오면 consumed_at IS NULL 조건으로 한 쪽만 이긴다.
  const consumed = await env.DB.prepare('UPDATE desk_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL')
    .bind(now, codeHash).run();
  if (changesOf(consumed) === 0) return fail('CODE_INVALID', '연결 코드가 이미 사용되었습니다', 401);
  const issued = await issueToken(env, String(staff.id), 'staff');
  return json({ ok: true, role: 'staff', staffId: String(staff.id), name: String(staff.name),
    token: issued.token, expiresAt: issued.expiresAt });
}

/* ── 계정·직원 ───────────────────────────────────────────────────────── */

async function changePassword(env, auth, body) {
  if (auth.role !== 'admin') return fail('FORBIDDEN', '원장만 할 수 있습니다', 403);
  const row = await adminRow(env);
  if (!row) return fail('NOT_SETUP', '관리자 비밀번호를 먼저 만들어 주세요', 409);
  const current = body && typeof body.password === 'string' ? body.password : '';
  if (!body || !validPassword(body.newPassword)) return fail('INVALID', '새 비밀번호는 8~72자로 입력해 주세요');
  const hash = await passwordHash(current, row.password_salt, Number(row.password_iterations));
  if (!safeEqual(hash, row.password_hash)) return fail('LOGIN_FAILED', '현재 비밀번호가 맞지 않습니다', 401);
  const salt = randomOpaqueValue();
  const next = await passwordHash(body.newPassword, salt, PASSWORD_ITERATIONS);
  await env.DB.batch([
    env.DB.prepare('UPDATE desk_admin SET password_salt=?,password_hash=?,password_iterations=?,failed_attempts=0,locked_until=0 WHERE id=1')
      .bind(salt, next, PASSWORD_ITERATIONS),
    // 비밀번호를 바꾸면 다른 원장 기기는 내려보낸다 — 지금 기기만 남긴다.
    env.DB.prepare('UPDATE desk_tokens SET revoked=1 WHERE staff_id=? AND role=? AND token_hash<>? AND revoked=0')
      .bind(ADMIN_ID, 'admin', auth.tokenHash)
  ]);
  return json({ ok: true });
}

function staffView(row) {
  return { id: String(row.id), name: String(row.name), role: 'staff', active: !!Number(row.active) };
}

async function loadStaff(env, staffId) {
  if (!STAFF_ID.test(staffId)) return null;
  return env.DB.prepare('SELECT id,name,role,active,updated_at FROM desk_staff WHERE id=? LIMIT 1').bind(staffId).first();
}

async function listStaff(env) {
  const result = await env.DB.prepare('SELECT id,name,role,active FROM desk_staff ORDER BY active DESC, name, id').all();
  return json({ ok: true, staff: (result.results || []).map(staffView) });
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
    await env.DB.prepare('INSERT INTO desk_staff(id,name,role,active,created_at,updated_at) VALUES(?,?,?,1,?,?)')
      .bind(id, name, 'staff', now, now).run();
    return json({ ok: true, staff: { id, name, role: 'staff', active: true } });
  }
  const staffId = body ? String(body.staffId || '') : '';
  const staff = await loadStaff(env, staffId);
  if (!staff) return fail('NOT_FOUND', '직원을 찾을 수 없습니다', 404);
  if (op === 'link') {
    if (!Number(staff.active)) return fail('STAFF_INACTIVE', '비활성 직원에게는 링크를 만들 수 없습니다', 409);
    const code = randomOpaqueValue();
    const expiresAt = now + CODE_TTL_MS;
    await env.DB.prepare('INSERT INTO desk_codes(code_hash,staff_id,expires_at,consumed_at,revoked,created_at) VALUES(?,?,?,NULL,0,?)')
      .bind(await sha256Hex(code), staffId, expiresAt, now).run();
    return json({ ok: true, code, expiresAt, staffId });
  }
  if (op === 'rename') {
    const name = cleanName(body.name, 40);
    if (!name) return fail('INVALID', '이름은 1~40자로 입력해 주세요');
    if (hasPii(name)) return fail('PII', '이름에 전화번호·이메일을 넣을 수 없습니다');
    // updated_at 이 반드시 커져야 GET /api/docs?since= 가 이름 변경을 다른 기기로 실어 나른다.
    await env.DB.prepare('UPDATE desk_staff SET name=?,updated_at=? WHERE id=?')
      .bind(name, Math.max(now, Number(staff.updated_at) + 1), staffId).run();
    return json({ ok: true, staff: staffView(Object.assign({}, staff, { name })) });
  }
  if (op === 'activate' || op === 'deactivate') {
    const active = op === 'activate' ? 1 : 0;
    await env.DB.prepare('UPDATE desk_staff SET active=?,updated_at=? WHERE id=?')
      .bind(active, Math.max(now, Number(staff.updated_at) + 1), staffId).run();
    return json({ ok: true, staff: staffView(Object.assign({}, staff, { active })) });
  }
  if (op === 'revoke') {
    const results = await env.DB.batch([
      env.DB.prepare('UPDATE desk_tokens SET revoked=1 WHERE staff_id=? AND role=? AND revoked=0').bind(staffId, 'staff'),
      env.DB.prepare('UPDATE desk_codes SET revoked=1 WHERE staff_id=? AND consumed_at IS NULL AND revoked=0').bind(staffId)
    ]);
    return json({ ok: true, staffId, revokedTokens: changesOf(results[0]), revokedCodes: changesOf(results[1]) });
  }
  return fail('INVALID', '지원하지 않는 직원 작업입니다');
}

/* ── 문서 규칙 ──────────────────────────────────────────────────────── */

/** 문자열 값을 전부 훑어 PII 패턴이 있는 첫 경로를 돌려준다. skip 에 든 경로(guardian.phone)는 건너뛴다. */
function findPii(value, path, skip) {
  if (typeof value === 'string') return hasPii(value) ? path : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findPii(value[i], path + '[' + i + ']', skip);
      if (found) return found;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const next = path ? path + '.' + key : key;
      if (skip && skip.has(next)) continue;
      const found = findPii(value[key], next, skip);
      if (found) return found;
    }
  }
  return null;
}

/** 자유 텍스트 키만 골라 길이·PII 를 본다(checks 용). */
function checkFreeText(value, path) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const bad = checkFreeText(value[i], path + '[' + i + ']');
      if (bad) return bad;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  for (const key of Object.keys(value)) {
    const next = path ? path + '.' + key : key;
    const item = value[key];
    if (typeof item === 'string' && FREE_TEXT_KEYS.has(key)) {
      if (item.length > MAX_FREE_TEXT) return { code: 'INVALID', error: next + '은(는) 300자까지 적을 수 있습니다' };
      if (hasPii(item)) return { code: 'PII', error: next + '에 전화번호·이메일·주민번호를 적을 수 없습니다' };
    } else if (item && typeof item === 'object') {
      const bad = checkFreeText(item, next);
      if (bad) return bad;
    }
  }
  return null;
}

function bad(code, error, status) {
  return { code, error, status: status || 400 };
}

function textField(out, key, max, label) {
  if (absent(out[key])) { delete out[key]; return null; }
  if (typeof out[key] !== 'string') return bad('INVALID', label + '은(는) 문자열이어야 합니다');
  out[key] = out[key].trim();
  if (out[key].length > max) return bad('INVALID', label + '은(는) ' + max + '자까지 적을 수 있습니다');
  if (!out[key]) delete out[key];
  return null;
}

function ruleStudents(data, ctx) {
  const out = Object.assign({}, data);
  const name = cleanName(out.name, 40);
  if (!name) return bad('INVALID', '학생 이름은 1~40자로 입력해 주세요');
  out.name = name;
  let err = textField(out, 'grade', 10, '학년') || textField(out, 'code', 20, '외부 코드') || textField(out, 'memo', 300, '메모');
  if (err) return err;
  if (absent(out.status)) out.status = 'active';
  if (!STUDENT_STATUS.has(out.status)) return bad('INVALID', 'status 는 active/paused/ended 중 하나여야 합니다');
  if (absent(out.since)) delete out.since;
  else if (typeof out.since !== 'string' || !YM.test(out.since)) return bad('INVALID', 'since 는 YYYY-MM 형식이어야 합니다');
  if (absent(out.programs)) delete out.programs;
  else {
    if (!isPlainObject(out.programs)) return bad('INVALID', 'programs 는 객체여야 합니다');
    const programs = {};
    for (const key of Object.keys(out.programs)) {
      if (!PROGRAM_KEYS.has(key)) return bad('INVALID', '모르는 프로그램: ' + key);
      const p = out.programs[key];
      if (!isPlainObject(p)) return bad('INVALID', 'programs.' + key + ' 는 객체여야 합니다');
      const q = Object.assign({}, p, { active: !!p.active });
      err = textField(q, 'plan', 40, 'programs.' + key + '.plan');
      if (err) return err;
      for (const dateKey of ['since', 'until']) {
        if (absent(q[dateKey])) delete q[dateKey];
        else if (typeof q[dateKey] !== 'string' || !YMD.test(q[dateKey])) {
          return bad('INVALID', 'programs.' + key + '.' + dateKey + ' 는 YYYY-MM-DD 형식이어야 합니다');
        }
      }
      if (absent(q.account)) q.account = 'none';
      if (!ACCOUNT_STATES.has(q.account)) return bad('INVALID', 'programs.' + key + '.account 는 none/requested/issued 중 하나여야 합니다');
      programs[key] = q;
    }
    out.programs = programs;
  }
  if (absent(out.guardian)) delete out.guardian;
  else {
    if (!isPlainObject(out.guardian)) return bad('INVALID', 'guardian 은 객체여야 합니다');
    const g = Object.assign({}, out.guardian, { consent: !!out.guardian.consent });
    err = textField(g, 'relation', 10, '보호자 관계');
    if (err) return err;
    if (absent(g.phone)) delete g.phone;
    else {
      if (typeof g.phone !== 'string') return bad('INVALID', '보호자 전화는 문자열이어야 합니다');
      g.phone = g.phone.trim();
      const digits = g.phone.replace(/-/g, '');
      if (!PHONE.test(g.phone) || digits.length < 8 || digits.length > 13) {
        return bad('INVALID', '보호자 전화는 숫자·하이픈만 8~13자리로 적어 주세요');
      }
    }
    out.guardian = g;
  }
  // 전화번호가 들어갈 자리는 guardian.phone 하나뿐 — 그 외 어디에 전화·이메일·주민번호 패턴이 있어도 거부한다.
  const pii = findPii(out, '', new Set(['guardian.phone']));
  if (pii) return bad('PII', pii + ' 에 전화번호·이메일·주민번호를 적을 수 없습니다. 보호자 전화는 guardian.phone 에만 둡니다');
  return { data: out };
}

function ruleTasks(data, ctx) {
  if (byteLength(JSON.stringify(data)) > MAX_TASK_BYTES) return bad('TOO_LARGE', 'task 문서는 16KB 까지입니다');
  if (!absent(data.steps)) {
    if (!Array.isArray(data.steps)) return bad('INVALID', 'steps 는 배열이어야 합니다');
    for (let i = 0; i < data.steps.length; i++) {
      const step = data.steps[i];
      if (!isPlainObject(step)) return bad('INVALID', 'steps[' + i + '] 는 객체여야 합니다');
      if (!absent(step.ext) && (typeof step.ext !== 'string' || !EXT_KEY.test(step.ext))) {
        return bad('INVALID', 'steps[' + i + '].ext 는 외부 링크 키(소문자·밑줄 1~40자)여야 합니다');
      }
    }
  }
  return { data };
}

function ruleChecks(data, ctx) {
  if (ctx.id.startsWith(LIC_PREFIX)) {
    // 자료 구매 승인은 원장의 몫 — requested 에서 approved/rejected 로 넘기는 쓰기만 admin 으로 제한한다.
    // 그 밖의 상태 전이(구매·등록·배정·제공)는 직원이 곧 운영자라 그대로 둔다.
    const prev = ctx.previous && ctx.previous.status;
    const next = data.status;
    if (prev === 'requested' && (next === 'approved' || next === 'rejected') && ctx.auth.role !== 'admin') {
      return bad('APPROVAL_ADMIN_ONLY', '자료 승인·반려는 원장만 할 수 있습니다', 403);
    }
  }
  if (ctx.id.startsWith(LICEV_PREFIX) && ctx.exists) {
    return bad('APPEND_ONLY', '자료 이벤트는 다시 쓸 수 없습니다', 409);
  }
  const text = checkFreeText(data, '');
  if (text) return bad(text.code, text.error);
  return { data };
}

function ruleContacts(data, ctx) {
  if (ctx.exists) return bad('APPEND_ONLY', '연락 기록은 고칠 수 없습니다. 새 기록을 남겨 주세요', 409);
  const out = Object.assign({}, data);
  if (typeof out.studentId !== 'string' || !DOC_ID.test(out.studentId)) return bad('INVALID', 'studentId 가 필요합니다');
  if (!CONTACT_TYPES.has(out.type)) return bad('INVALID', 'type 은 call/msg/visit 중 하나여야 합니다');
  if (!CONTACT_RESULTS.has(out.result)) return bad('INVALID', 'result 는 reached/no_answer/note 중 하나여야 합니다');
  const err = textField(out, 'note', 200, '연락 메모');
  if (err) return err;
  if (absent(out.at)) out.at = Date.now();
  out.at = Number(out.at);
  if (!Number.isFinite(out.at) || out.at <= 0) return bad('INVALID', 'at 은 ms 시각이어야 합니다');
  // 누가 남겼는지는 클라이언트 말을 믿지 않고 토큰의 신원으로 덮어쓴다.
  out.by = ctx.auth.staffId;
  const pii = findPii(out, '', null);
  if (pii) return bad('PII', pii + ' 에 전화번호·이메일·주민번호를 적을 수 없습니다');
  return { data: out };
}

function ruleSettings(data, ctx) {
  const out = Object.assign({}, data);
  const err = textField(out, 'orgName', 40, '조직 이름') || textField(out, 'requestPasscode', 40, '요청 접수 암호');
  if (err) return err;
  if (absent(out.runbookPack)) delete out.runbookPack;
  else if (!isPlainObject(out.runbookPack)) return bad('INVALID', 'runbookPack 은 객체여야 합니다');
  const pii = findPii(out, '', null);
  if (pii) return bad('PII', pii + ' 에 전화번호·이메일·주민번호를 적을 수 없습니다');
  return { data: out };
}

/* ── 기획서 v1.1 — 배정 카드·템플릿·앱 목적지·매뉴얼 ──────────────────────
 * 카드는 직원·원장 모두 쓴다(직원은 상태·증빙·메모를 바꾸며 일한다). 템플릿·앱·매뉴얼은 원장의 것이라 원장만 쓰되,
 * 앱 자료 범위(apprange)의 status·note 만은 직원이 갱신한다 — 구매·업로드를 실제로 하는 사람이 직원이기 때문. */

function ruleCards(data, ctx) {
  const out = Object.assign({}, data);
  if (!ROOMS.has(out.program)) return bad('INVALID', 'program 은 프로그램 방 6개 중 하나여야 합니다');
  if (!isPlainObject(out.target)) return bad('INVALID', 'target 은 객체여야 합니다');
  const target = { type: out.target.type };
  if (!CARD_TARGETS.has(target.type)) return bad('INVALID', 'target.type 은 student/app/text 중 하나여야 합니다');
  if (target.type === 'text') {
    target.label = typeof out.target.label === 'string' ? out.target.label.trim() : '';
    if (!target.label || target.label.length > 60) return bad('INVALID', 'target.label 은 1~60자여야 합니다');
  } else {
    if (typeof out.target.id !== 'string' || !DOC_ID.test(out.target.id)) return bad('INVALID', 'target.id 가 필요합니다');
    target.id = out.target.id;
  }
  out.target = target;
  if (typeof out.what !== 'string' || !out.what.trim() || out.what.trim().length > 120) return bad('INVALID', '무엇을(what)은 1~120자로 적어 주세요');
  out.what = out.what.trim();
  const err = textField(out, 'where', 120, '어디에') || textField(out, 'note', 300, '메모') || textField(out, 'blockedReason', 200, '막힘 사유') ||
    textField(out, 'source', 80, 'source') || textField(out, 'manualId', 160, 'manualId');
  if (err) return err;
  if (absent(out.due)) delete out.due;
  else if (typeof out.due !== 'string' || !YMD.test(out.due)) return bad('INVALID', 'due 는 YYYY-MM-DD 형식이어야 합니다');
  if (absent(out.status)) out.status = 'todo';
  if (!CARD_STATUS.has(out.status)) return bad('INVALID', 'status 는 todo/doing/done/blocked 중 하나여야 합니다');
  if (out.status === 'blocked' && !out.blockedReason) return bad('INVALID', '막힘에는 사유(blockedReason)를 한 줄 적어야 합니다');
  if (out.status !== 'blocked') delete out.blockedReason;
  if (absent(out.evidence)) delete out.evidence;
  else {
    if (!isPlainObject(out.evidence) || !EVIDENCE_KINDS.has(out.evidence.kind)) return bad('INVALID', 'evidence.kind 는 check/capture/file 중 하나여야 합니다');
    // 증빙을 남긴 사람은 토큰의 신원으로 고정한다.
    const ev = { kind: out.evidence.kind, at: Number(out.evidence.at) > 0 ? Number(out.evidence.at) : Date.now(), by: ctx.auth.staffId };
    if (!absent(out.evidence.note)) {
      if (typeof out.evidence.note !== 'string' || out.evidence.note.length > 300) return bad('INVALID', 'evidence.note 는 300자까지입니다');
      ev.note = out.evidence.note.trim();
    }
    out.evidence = ev;
  }
  const prev = ctx.exists && isPlainObject(ctx.previous) ? ctx.previous : null;
  // 만든 사람·시각은 첫 쓰기의 토큰 신원으로 고정한다 — 클라이언트 값을 믿지 않는다.
  out.createdAt = prev && Number(prev.createdAt) > 0 ? Number(prev.createdAt) : Date.now();
  out.createdBy = prev && typeof prev.createdBy === 'string' ? prev.createdBy : ctx.auth.staffId;
  out.byOwner = prev ? !!prev.byOwner : ctx.auth.role === 'admin';
  if (out.status === 'done') {
    const wasDone = !!(prev && prev.status === 'done');
    out.doneAt = wasDone && Number(prev.doneAt) > 0 ? Number(prev.doneAt) : (Number(out.doneAt) > 0 ? Number(out.doneAt) : Date.now());
    out.doneBy = wasDone && typeof prev.doneBy === 'string' ? prev.doneBy : ctx.auth.staffId;
  } else { delete out.doneAt; delete out.doneBy; }
  const pii = findPii(out, '', null);
  if (pii) return bad('PII', pii + ' 에 전화번호·이메일·주민번호를 적을 수 없습니다');
  return { data: out };
}

function ruleApps(data, ctx) {
  if (ctx.auth.role !== 'admin') return bad('FORBIDDEN', '앱 목적지는 원장만 등록·수정합니다', 403);
  const out = Object.assign({}, data);
  const name = cleanName(out.name, 40);
  if (!name) return bad('INVALID', '앱 이름은 1~40자로 입력해 주세요');
  out.name = name;
  const err = textField(out, 'format', 80, '자료 형식') || textField(out, 'note', 300, '메모') || textField(out, 'adminUrl', 200, '관리 웹 주소');
  if (err) return err;
  if (out.adminUrl && !HTTPS_URL.test(out.adminUrl)) return bad('INVALID', '관리 웹 주소는 https:// 로 시작해야 합니다');
  out.active = absent(out.active) ? true : !!out.active;
  const pii = findPii(out, '', null);
  if (pii) return bad('PII', pii + ' 에 전화번호·이메일·주민번호를 적을 수 없습니다');
  return { data: out };
}

function planTarget(raw) {
  if (!isPlainObject(raw)) return bad('INVALID', 'target 은 객체여야 합니다');
  const t = { type: raw.type };
  if (!PLAN_TARGETS.has(t.type)) return bad('INVALID', 'target.type 은 each/student/app/text 중 하나여야 합니다');
  if (t.type === 'student' || t.type === 'app') {
    if (typeof raw.id !== 'string' || !DOC_ID.test(raw.id)) return bad('INVALID', 'target.id 가 필요합니다');
    t.id = raw.id;
  } else if (t.type === 'text') {
    t.label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!t.label || t.label.length > 60) return bad('INVALID', 'target.label 은 1~60자여야 합니다');
  }
  return { target: t };
}

function stripForCompare(plan) {
  const copy = Object.assign({}, plan);
  delete copy.status; delete copy.note;
  return JSON.stringify(copy, Object.keys(copy).sort());
}

function rulePlans(data, ctx) {
  const out = Object.assign({}, data);
  if (!PLAN_KINDS.has(out.kind)) return bad('INVALID', 'kind 는 recurring/apprange 중 하나여야 합니다');
  let err = null;
  if (out.kind === 'recurring') {
    if (!ROOMS.has(out.program)) return bad('INVALID', 'program 은 프로그램 방 6개 중 하나여야 합니다');
    if (!Array.isArray(out.days) || !out.days.length || out.days.length > 7) return bad('INVALID', 'days 는 요일(0~6) 1~7개 배열이어야 합니다');
    const days = [];
    for (const d of out.days) {
      const n = Number(d);
      if (!Number.isInteger(n) || n < 0 || n > 6) return bad('INVALID', 'days 의 값은 0(일)~6(토)이어야 합니다');
      if (!days.includes(n)) days.push(n);
    }
    out.days = days.sort((a, b) => a - b);
    const t = planTarget(out.target);
    if (t.code) return t;
    out.target = t.target;
    if (typeof out.what !== 'string' || !out.what.trim() || out.what.trim().length > 120) return bad('INVALID', '무엇을(what)은 1~120자로 적어 주세요');
    out.what = out.what.trim();
    err = textField(out, 'where', 120, '어디에') || textField(out, 'manualId', 160, 'manualId') || textField(out, 'note', 300, '메모');
    if (err) return err;
    for (const key of ['start', 'end']) {
      if (absent(out[key])) delete out[key];
      else if (typeof out[key] !== 'string' || !YMD.test(out[key])) return bad('INVALID', key + ' 는 YYYY-MM-DD 형식이어야 합니다');
    }
    out.active = absent(out.active) ? true : !!out.active;
  } else {
    if (typeof out.appId !== 'string' || !DOC_ID.test(out.appId)) return bad('INVALID', 'appId 가 필요합니다');
    if (typeof out.unit !== 'string' || !out.unit.trim() || out.unit.trim().length > 80) return bad('INVALID', '범위(unit)는 1~80자로 적어 주세요');
    out.unit = out.unit.trim();
    err = textField(out, 'subject', 40, '과목') || textField(out, 'grade', 10, '학년') || textField(out, 'material', 40, '자료 종류') ||
      textField(out, 'note', 300, '메모');
    if (err) return err;
    if (absent(out.status)) out.status = 'need';
    if (!RANGE_STATUS.has(out.status)) return bad('INVALID', 'status 는 need/buying/uploading/have 중 하나여야 합니다');
    if (absent(out.source)) out.source = 'exam4you';
    if (!RANGE_SOURCES.has(out.source)) return bad('INVALID', 'source 는 exam4you/jokbo/other 중 하나여야 합니다');
  }
  if (ctx.auth.role !== 'admin') {
    // 직원은 앱 자료 범위의 진행(status)·메모만 옮길 수 있다. 그 밖의 템플릿 변경은 원장 몫.
    const prev = ctx.exists && isPlainObject(ctx.previous) ? ctx.previous : null;
    const allowed = out.kind === 'apprange' && prev && prev.kind === 'apprange' && stripForCompare(prev) === stripForCompare(out);
    if (!allowed) return bad('FORBIDDEN', '템플릿은 원장만 만들고 고칩니다 (직원은 앱 자료 범위의 진행 상태만)', 403);
  }
  const pii = findPii(out, '', null);
  if (pii) return bad('PII', pii + ' 에 전화번호·이메일·주민번호를 적을 수 없습니다');
  return { data: out };
}

function ruleManuals(data, ctx) {
  if (ctx.auth.role !== 'admin') return bad('FORBIDDEN', '매뉴얼은 원장만 고칩니다 — 다른 점은 요청함(기타)으로 올려 주세요', 403);
  const out = Object.assign({}, data);
  if (!MANUAL_SCOPES.has(out.scope)) return bad('INVALID', 'scope 는 프로그램 방 6개 또는 app 이어야 합니다');
  if (absent(out.appId)) delete out.appId;
  else if (typeof out.appId !== 'string' || !DOC_ID.test(out.appId)) return bad('INVALID', 'appId 형식이 올바르지 않습니다');
  if (typeof out.task !== 'string' || !out.task.trim() || out.task.trim().length > 40) return bad('INVALID', '작업 종류(task)는 1~40자여야 합니다');
  out.task = out.task.trim();
  if (typeof out.title !== 'string' || !out.title.trim() || out.title.trim().length > 80) return bad('INVALID', '제목은 1~80자여야 합니다');
  out.title = out.title.trim();
  const err = textField(out, 'purpose', 300, '목적');
  if (err) return err;
  const steps = [];
  if (!absent(out.steps)) {
    if (!Array.isArray(out.steps) || out.steps.length > 40) return bad('INVALID', 'steps 는 40개까지의 배열이어야 합니다');
    for (const s of out.steps) {
      const text = typeof s === 'string' ? s.trim() : (isPlainObject(s) && typeof s.text === 'string' ? s.text.trim() : '');
      if (!text || text.length > 300) return bad('INVALID', '단계는 각 1~300자여야 합니다');
      const step = { text };
      if (isPlainObject(s) && typeof s.note === 'string' && s.note.trim()) {
        if (s.note.length > 300) return bad('INVALID', '단계 메모는 300자까지입니다');
        step.note = s.note.trim();
      }
      steps.push(step);
    }
  }
  out.steps = steps;
  const cautions = [];
  if (!absent(out.cautions)) {
    if (!Array.isArray(out.cautions) || out.cautions.length > 20) return bad('INVALID', 'cautions 는 20개까지의 배열이어야 합니다');
    for (const c of out.cautions) {
      if (typeof c !== 'string' || !c.trim() || c.length > 300) return bad('INVALID', '주의점은 각 1~300자여야 합니다');
      cautions.push(c.trim());
    }
  }
  out.cautions = cautions;
  const links = [];
  if (!absent(out.links)) {
    if (!Array.isArray(out.links) || out.links.length > 10) return bad('INVALID', 'links 는 10개까지의 배열이어야 합니다');
    for (const l of out.links) {
      if (!isPlainObject(l) || typeof l.url !== 'string' || !HTTPS_URL.test(l.url.trim())) return bad('INVALID', '링크는 https:// 주소여야 합니다');
      const label = typeof l.label === 'string' ? l.label.trim() : '';
      if (!label || label.length > 40) return bad('INVALID', '링크 이름은 1~40자여야 합니다');
      links.push({ label, url: l.url.trim() });
    }
  }
  out.links = links;
  if (absent(out.lastCheckedAt)) delete out.lastCheckedAt;
  else if (typeof out.lastCheckedAt !== 'string' || !YMD.test(out.lastCheckedAt)) return bad('INVALID', 'lastCheckedAt 은 YYYY-MM-DD 형식이어야 합니다');
  out.version = Number.isInteger(Number(out.version)) && Number(out.version) > 0 ? Number(out.version) : 1;
  const pii = findPii(out, '', null);
  if (pii) return bad('PII', pii + ' 에 전화번호·이메일·주민번호를 적을 수 없습니다');
  return { data: out };
}

const RULES = {
  students: ruleStudents, tasks: ruleTasks, checks: ruleChecks, contacts: ruleContacts, settings: ruleSettings,
  cards: ruleCards, plans: rulePlans, apps: ruleApps, manuals: ruleManuals
};

function docView(row) {
  return {
    c: String(row.collection), id: String(row.id), data: parseJson(row.data) || {},
    updatedAt: Number(row.updated_at), updatedBy: String(row.updated_by), deleted: !!Number(row.deleted)
  };
}

function staffDoc(row) {
  return {
    c: 'staff', id: String(row.id), data: staffView(row),
    updatedAt: Number(row.updated_at), updatedBy: ADMIN_ID, deleted: false
  };
}

async function readDocs(env, url) {
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw === null || sinceRaw === '' ? null : Number(sinceRaw);
  if (since !== null && !Number.isFinite(since)) return fail('INVALID', 'since 는 ms 숫자여야 합니다');
  const where = since === null ? '' : ' WHERE updated_at>?';
  const bindings = since === null ? [] : [since];
  const rows = await env.DB.prepare(
    'SELECT collection,id,data,updated_at,updated_by,deleted FROM desk_documents' + where + ' ORDER BY updated_at, collection, id'
  ).bind(...bindings).all();
  // 직원 명단은 desk_staff 가 정본이지만 클라이언트는 문서 하나로 받는 편이 단순하다 — staff 문서로 함께 내려준다.
  const staffRows = await env.DB.prepare(
    'SELECT id,name,role,active,updated_at FROM desk_staff' + where + ' ORDER BY updated_at, id'
  ).bind(...bindings).all();
  const docs = (rows.results || []).map(docView).concat((staffRows.results || []).map(staffDoc));
  return json({ ok: true, now: Date.now(), docs });
}

function currentView(row) {
  return row ? { data: parseJson(row.data) || {}, updatedAt: Number(row.updated_at), updatedBy: String(row.updated_by), deleted: !!Number(row.deleted) } : null;
}

async function applyChange(env, auth, change) {
  const c = change && typeof change.c === 'string' ? change.c : '';
  const id = change && typeof change.id === 'string' ? change.id : '';
  const item = { c, id };
  const reject = (code, error, status, extra) => ({ status: status || 400, result: Object.assign(item, { error, code }, extra || {}) });
  if (!COLLECTIONS.has(c)) return reject('INVALID', '모르는 컬렉션입니다');
  if (!DOC_ID.test(id)) return reject('INVALID', '문서 id 형식이 올바르지 않습니다');
  const wantDelete = !!change.deleted;
  // 삭제는 컬렉션을 가리지 않고 원장만 — 직원 기기의 실수·오작동이 명단을 지우지 못하게.
  if (wantDelete && auth.role !== 'admin') return reject('FORBIDDEN', '삭제는 원장만 할 수 있습니다', 403);
  if (c === 'settings' && auth.role !== 'admin') return reject('FORBIDDEN', '설정은 원장만 바꿀 수 있습니다', 403);
  const row = await env.DB.prepare('SELECT data,updated_at,updated_by,deleted FROM desk_documents WHERE collection=? AND id=? LIMIT 1')
    .bind(c, id).first();
  const currentAt = row ? Number(row.updated_at) : 0;
  if (!absent(change.expectedUpdatedAt)) {
    const expected = Number(change.expectedUpdatedAt);
    if (!Number.isFinite(expected) || expected !== currentAt) {
      return reject('STALE', '다른 기기에서 먼저 바뀌었습니다', 409, { current: currentView(row) });
    }
  }
  let data = {};
  if (!wantDelete) {
    if (!isPlainObject(change.data)) return reject('INVALID', 'data 는 객체여야 합니다');
    if (byteLength(JSON.stringify(change.data)) > MAX_DOC_BYTES) return reject('TOO_LARGE', '문서는 64KB 까지입니다', 400);
    const exists = !!row && !Number(row.deleted);
    const verdict = RULES[c](change.data, { auth, id, exists, previous: exists ? parseJson(row.data) : null });
    if (verdict.code) return reject(verdict.code, verdict.error, verdict.status);
    data = verdict.data;
  }
  // 같은 ms 안에 두 번 써도 updated_at 이 커져야 since= 동기화와 CAS 가 순서를 잃지 않는다.
  const updatedAt = Math.max(Date.now(), currentAt + 1);
  await env.DB.prepare(
    'INSERT INTO desk_documents(collection,id,data,updated_at,updated_by,deleted) VALUES(?,?,?,?,?,?) ' +
    'ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,' +
    'updated_by=excluded.updated_by,deleted=excluded.deleted'
  ).bind(c, id, JSON.stringify(data), updatedAt, auth.staffId, wantDelete ? 1 : 0).run();
  return { status: 200, result: Object.assign(item, { updatedAt }) };
}

async function writeDocs(env, auth, body) {
  const changes = body && Array.isArray(body.changes) ? body.changes : null;
  if (!changes) return fail('INVALID', 'changes 배열이 필요합니다');
  if (changes.length > MAX_CHANGES) return fail('INVALID', '한 번에 ' + MAX_CHANGES + '건까지 보낼 수 있습니다');
  const results = [];
  let first = null;
  for (const change of changes) {
    const outcome = await applyChange(env, auth, isPlainObject(change) ? change : {});
    results.push(outcome.result);
    if (outcome.status !== 200 && !first) first = outcome;
  }
  const now = Date.now();
  if (!first) return json({ ok: true, now, results });
  // 한 건이라도 실패하면 상태 코드는 첫 실패를 따르되 results 는 전부 싣는다 — 성공한 건의 updatedAt 을 잃지 않게.
  return json({ ok: false, now, results, code: first.result.code, error: first.result.error }, first.status);
}

async function exportAll(env) {
  const rows = await env.DB.prepare('SELECT collection,id,data,updated_at,updated_by,deleted FROM desk_documents ORDER BY collection, id').all();
  const staff = await env.DB.prepare('SELECT id,name,role,active,created_at,updated_at FROM desk_staff ORDER BY id').all();
  const ledger = await exportRequests(env);
  const now = Date.now();
  const stamp = new Date(now).toISOString().slice(0, 10);
  return json({
    ok: true, app: APP_NAME, now,
    docs: (rows.results || []).map(docView),
    staff: (staff.results || []).map(row => Object.assign(staffView(row), { createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) })),
    requests: ledger.requests, events: ledger.events
  }, 200, { 'Content-Disposition': 'attachment; filename="wb-desk-export-' + stamp + '.json"' });
}

/* ── 라우터 ─────────────────────────────────────────────────────────── */

function methodNotAllowed() {
  return fail('METHOD', '허용되지 않는 메서드입니다', 405);
}

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = String(request.method || 'GET').toUpperCase();
  try {
    if (path === '/api/health') return method === 'GET' ? health(env) : methodNotAllowed();
    if (path === '/api/setup') return method === 'POST' ? setup(env, await readJson(request)) : methodNotAllowed();
    if (path === '/api/login') return method === 'POST' ? login(env, await readJson(request)) : methodNotAllowed();
    if (path === '/api/link-exchange') return method === 'POST' ? linkExchange(env, await readJson(request)) : methodNotAllowed();

    const auth = await resolveAuth(request, env);
    if (!auth) return fail('AUTH', '로그인이 필요합니다', 401);

    if (path === '/api/me') {
      return method === 'GET' ? json({ ok: true, role: auth.role, staffId: auth.staffId, name: auth.name }) : methodNotAllowed();
    }
    if (path === '/api/logout') {
      if (method !== 'POST') return methodNotAllowed();
      await env.DB.prepare('UPDATE desk_tokens SET revoked=1 WHERE token_hash=?').bind(auth.tokenHash).run();
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
      if (auth.role !== 'admin') return fail('FORBIDDEN', '내보내기는 원장만 할 수 있습니다', 403);
      return exportAll(env);
    }
    if (path === '/api/requests') {
      if (method !== 'POST') return methodNotAllowed();
      // body 의 app·auth(예전 sync 계약)는 무시하고 Bearer 로 확정한 신원만 넘긴다.
      return handleRequests((await readJson(request)) || {}, env, { role: auth.role, staffId: auth.staffId });
    }
    return fail('NOT_FOUND', '없는 API 경로입니다', 404);
  } catch (error) {
    return fail('SERVER', String(error && error.message || error), 500);
  }
}
