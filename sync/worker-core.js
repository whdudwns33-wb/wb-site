/**
 * WB 동기화 워커 (Cloudflare Workers + D1)
 *
 * 왜 만들었나
 *   기존 Apps Script 방식은 동기화 한 번에 전체 상태(모든 학생·업무·체크)를 주고받고,
 *   서버는 시트를 통째로 지운 뒤 다시 썼다. 학생 100명 규모에서는 동시 실행 한계에 걸려
 *   요청이 실패하기 시작한다. 여기서는 두 가지를 바꾼다.
 *     · 델타 — srv_at 이후 바뀐 행만 주고받는다
 *     · 분할 — 개인 링크로 접속하면 자기 데이터만 오간다
 *
 * 엔드포인트
 *   GET  /health
 *   POST /sync    { app, auth, since, changes[] } → { ok, now, changes[] }
 *   POST /token     { app, auth(admin), staffId } → { ok, token }   구형 개인 링크 호환
 *   POST /bootstrap { app, auth(admin), staffId } → { ok, code }    1회용 링크 발급
 *   POST /exchange  { app, staffId, code }        → { ok, token }   1회 교환
 *   POST /handoff   { app, auth(person) }         → { ok, code }    본인 새 브라우저 이동
 *   POST /admin-handoff { app:'consult', auth(admin) } → { ok, code } 원장 새 기기 연결
 *   POST /admin-account { app:'consult', auth(admin), action:'set', loginId, password } 원장 계정 설정
 *   POST /admin-login { app:'consult', loginId, password } → { ok, token } 원장 기기 로그인
 *   POST /lesson-create { app, auth, staffId?, lesson } → 수업 9항목 등록
 *   POST /contact-log { app, auth, sourceTaskId, type, note } → 담당 수업 학생 연락 기록
 *   POST /feedback-request { app, auth, ... }     → 직원, 항목별 피드백 제출(제출 즉시 카카오 알림톡 자동 발송 시도)
 *   POST /feedback-review  { app, auth(admin) }   → 원장, 발송 이력·상태 확인(승인 클릭은 더 이상 발송 조건이 아님)
 *   POST /parent-feedback-send { app, auth(admin), requestKey } → 막혔던 발송을 원장이 수동으로 재시도
 *   POST /guardian-contact { app, auth(admin), ... } → 원장, 보호자 연락처·발송 동의 등록/조회
 *   POST /lesson-change-request { app, auth, ... } → 직원, 원장이 등록한 지시서에 변경 제안
 *   POST /lesson-change-review  { app, auth(admin) } → 원장, 변경 제안 승인·반려
 *   POST /director-report-send { app, auth, reportDate, staffId? } → 고정된 원장 수신처 카카오 알림톡
 *   POST /book-order-send { app, auth, taskId } → 교재 주문 문자를 거래처에 실제 발송
 *   POST /book-order { app, auth, action:'create'|'cancel', ... } → 학생 정체성이 봉인된 주문 생성·취소
 *   POST /book-add-request { app, auth, ... }     → 직원, 새 교재를 교재 목록에 추가해 달라고 신청
 *   POST /book-add-review  { app, auth(admin) }   → 원장, 교재 추가 신청 승인·반려
 *   POST /book-edit-request { app, auth, ... }     → 직원, 기존 교재 정보를 고쳐 달라고 신청
 *   POST /book-edit-review  { app, auth(admin) }   → 원장, 교재 수정 신청 승인·반려
 *   POST /transport { app, auth, action, ... }      → 차량 노선 설정·승하차 상태
 *   POST /staff-deactivate { app, auth(all), staffId, expectedUpdatedAt } → 직원 비활성화 CAS + 링크 해지
 *   POST /onboarding-patch { app, auth, ... }       → 신규 학생 30일 기록 CAS 수정
 *   POST /makeup { app, auth, action, ... }          → 모든 학생의 결석·보강 일정 원장
 *   POST /session-pack { app, auth, action, ... }    → 지정 수업의 회차권·사용 원장
 *   POST /parent-portal { app, action, ... }         → 보호자 초대·공개 수업·정형 요청함
 *   POST /student-portal { app, action, ... }        → 학생 앱 동의·초대·관리자 미리보기
 *   POST /guardian-ops-send { app, auth, action, ... } → 보강·회차 운영 알림톡
 *   POST /revoke    { app, auth(admin), token|staffId } → { ok }
 *
 * 인증
 *   auth = { mode:'admin',  secret }            → 전체 접근
 *   auth = { mode:'admin_device', token }       → 연결된 원장 기기
 *   auth = { mode:'person', id, token }         → 본인 범위(task allowlist 관리 담당은 전체)
 */

import { handleLessonCreate } from './lesson-create.js';
import { handleLessonAssignmentRequest, handleLessonAssignmentReview } from './lesson-assignment-request.js';
import { handleDirectorReportSend } from './director-report-send.js';
import { handleLessonChangeRequest, handleLessonChangeReview } from './lesson-change-request.js';
import { handleBookOrderSend } from './book-order-send.js';
import { handleBookOrderCreate } from './book-order-create.js';
import { handleBookAddRequest, handleBookAddReview } from './book-add-request.js';
import { handleBookEditRequest, handleBookEditReview } from './book-edit-request.js';
import { handleGuardianContact } from './guardian-contact.js';
import { handleParentFeedbackSend, attemptParentFeedbackSend, resolveStudentName } from './parent-feedback-send.js';
import { handleRoster } from './roster.js';
import { handleBookIssue } from './book-issue.js';
import { handleTransport } from './transport.js';
import { handleOnboardingPatch } from './onboarding.js';
import { handleParentPortal } from './parent-portal.js';
import { handleStudentPortal } from './student-portal.js';
import { handleMakeup } from './makeup.js';
import { handleSessionPack } from './session-pack.js';
import { handleGuardianOpsSend } from './guardian-ops-send.js';
import { handleContactLog } from './contact-log.js';

const APPS = ['task', 'consult'];
const MAX_CHANGES = 500;     // 요청당 상한 — D1 배치 한계와 악의적 대량 전송을 함께 막는다
const MAX_PULL = 2000;       // 응답당 상한. 초과하면 more:true로 알리고 다음 요청에서 이어받는다
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_HASH_PREFIX = 'sha256:';
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
const HANDOFF_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_BOOTSTRAPS = 3;
const MAX_ACTIVE_PERSON_SESSIONS = 3;
const MAX_ACTIVE_ADMIN_SESSIONS = 5;
const SAFE_BOOTSTRAP_CODE = /^[a-f0-9]{48}$/i;
const ADMIN_DEVICE_ID = '__admin__';
const SAFE_ADMIN_LOGIN_ID = /^[A-Za-z0-9._@-]{3,64}$/;
const ADMIN_PASSWORD_MIN_LENGTH = 8;
const ADMIN_PASSWORD_MAX_LENGTH = 128;
const ADMIN_PASSWORD_ITERATIONS = 100000;
const ADMIN_LOGIN_MAX_FAILURES = 5;
const ADMIN_LOGIN_LOCK_MS = 5 * 60 * 1000;

const json = (obj, status, origin) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: {
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }
});

function isBoardingLockError(error) {
  return /BOARDING_LOCK/.test(String(error && error.message || error || ''));
}

function boardingLockResponse(origin) {
  return json({
    ok: false,
    code: 'BOARDING_LOCK',
    error: '승차 후 미하차 기록이 남아 있어 변경할 수 없습니다. 차량 화면에서 하차·인계 또는 사유 있는 상태 초기화를 먼저 완료해 주세요'
  }, 409, origin);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

/** 상수 시간 비교 — 비밀키를 한 글자씩 떠보는 공격을 막는다 */
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function hexBytes(value) {
  const pairs = String(value || '').match(/.{2}/g) || [];
  return new Uint8Array(pairs.map(pair => parseInt(pair, 16)));
}

async function passwordHash(password, saltHex, iterations) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(password || '')), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: hexBytes(saltHex), iterations
  }, material, 256);
  return Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
}

function tokenStorageValue(digest) {
  return TOKEN_HASH_PREFIX + String(digest || '').toLowerCase();
}

function randomOpaqueValue() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function taskManagerIds(env) {
  return new Set([env.TASK_MANAGER_STAFF_IDS, env.TASK_MANAGER_STAFF_IDS_CONFIG]
    .flatMap(value => String(value || '').split(','))
    .map(id => id.trim())
    .filter(id => SAFE_ID.test(id)));
}

async function resolveAuth(env, app, auth) {
  if (!auth || typeof auth !== 'object') return null;
  if (auth.mode === 'admin') {
    const want = app === 'task' ? env.TASK_ADMIN_SECRET : env.CONSULT_ADMIN_SECRET;
    if (!want || !safeEqual(auth.secret, want)) return null;
    return { scope: 'all' };
  }
  if (auth.mode === 'admin_device' && app === 'consult') {
    const token = String(auth.token || '');
    if (!token || token.length > 256 || token.startsWith(TOKEN_HASH_PREFIX)) return null;
    const tokenHash = tokenStorageValue(await sha256Hex(token));
    const createdAfter = Date.now() - TOKEN_TTL_MS;
    const row = await env.DB.prepare(
      'SELECT staff_id FROM tokens WHERE app=? AND token IN (?,?) AND revoked=0 ' +
      'AND (token=? OR created_at>=?) LIMIT 1'
    ).bind(app, tokenHash, token, token, createdAfter).first();
    return row && row.staff_id === ADMIN_DEVICE_ID ? { scope: 'all', device: true } : null;
  }
  if (auth.mode === 'person') {
    const id = String(auth.id || '');
    const token = String(auth.token || '');
    if (!SAFE_ID.test(id) || !token || token.length > 256 || token.startsWith(TOKEN_HASH_PREFIX)) return null;
    const tokenHash = tokenStorageValue(await sha256Hex(token));
    const createdAfter = Date.now() - TOKEN_TTL_MS;
    const row = await env.DB.prepare(
      'SELECT staff_id FROM tokens WHERE app=? AND token IN (?,?) AND revoked=0 ' +
      'AND (token=? OR created_at>=?) LIMIT 1'
    ).bind(app, tokenHash, token, token, createdAfter).first();
    const staff = await activeStaffData(env, app, id);
    if (!row || row.staff_id !== id || !staff) return null;
    // 수정 가능한 staff 메타데이터가 아니라 배포 환경의 명시적 allowlist만 task 관리 권한을 준다.
    if (app === 'task' && taskManagerIds(env).has(id)) return { scope: 'all', id: id, role: 'manager' };
    return { scope: 'own', id: id };
  }
  return null;
}

/** 들어온 변경을 테이블별 upsert 문으로. updated_at이 더 최신일 때만 덮는다 (LWW) */
function upsertStmt(env, table, app, c, now, ownScope, managerTask) {
  const idCol = table === 'checks' ? 'k' : 'id';
  const key = table === 'checks' ? c.k : c.id;
  const ownGuard = ownScope
    ? (' AND ' + table + '.owner=excluded.owner' +
      (table === 'tasks' ? " AND json_extract(tasks.data,'$.origin')='staff'" : ''))
    : '';
  const insertData = managerTask
    ? "json_set(?, '$.origin', 'manager', '$.lastEditBy', 'manager')"
    : '?';
  const updateData = managerTask
    ? "json_set(excluded.data, '$.origin', COALESCE(json_extract(tasks.data,'$.origin'),'manager'), '$.lastEditBy', 'manager')"
    : 'excluded.data';
  // CAS endpoint를 한 번 통과한 onboarding 행은 예전 클라이언트의 generic LWW가 덮지 못한다.
  // casVersion이 없는 기존 행은 Worker→Pages 배포 창 동안만 기존 저장과 호환한다.
  const onboardingGuard = table === 'checks' && /^__onboarding__/.test(String(key || ''))
    ? " AND COALESCE(json_extract(checks.data,'$.casVersion'),0)<>1"
    : '';
  return env.DB.prepare(
    'INSERT INTO ' + table + ' (app, ' + idCol + ', owner, data, updated_at, srv_at) ' +
    'VALUES (?, ?, ?, ' + insertData + ', ?, ?) ' +
    'ON CONFLICT(app, ' + idCol + ') DO UPDATE SET ' +
    '  owner=excluded.owner, data=' + updateData + ', ' +
    '  updated_at=excluded.updated_at, srv_at=excluded.srv_at ' +
    'WHERE excluded.updated_at > ' + table + '.updated_at' + ownGuard + onboardingGuard
  ).bind(app, key, c.owner || null, JSON.stringify(c.data), Number(c.updated_at) || 0, now);
}

async function canonicalOnboardingChanges(env, app, keys) {
  const unique = [...new Set(keys)].filter(key => /^__onboarding__/.test(key));
  const changes = [];
  // D1의 bind 개수 한도 안에서 실패 없이 조회한다.
  for (let offset = 0; offset < unique.length; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await env.DB.prepare(
      'SELECT k AS key,owner,data,updated_at,srv_at FROM checks ' +
      "WHERE app=? AND k IN (" + placeholders + ") AND json_extract(data,'$.casVersion')=1"
    ).bind(app, ...chunk).all();
    for (const row of result.results || []) {
      changes.push({ table: 'checks', key: row.key, owner: row.owner, data: JSON.parse(row.data),
        updated_at: row.updated_at, srv_at: row.srv_at, authoritative: true });
    }
  }
  return changes;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key]);
    return out;
  }
  return value;
}

function sameTaskJson(stored, incoming) {
  try {
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return JSON.stringify(canonicalJson(parsed)) === JSON.stringify(canonicalJson(incoming));
  } catch (error) {
    return false;
  }
}

async function inspectSealedOrderChanges(env, app, entries) {
  const taskEntries = entries.filter(entry => entry.table === 'tasks');
  if (!taskEntries.length) return { skip: new Set() };
  const ids = [...new Set(taskEntries.map(entry => String(entry.change.id || '')).filter(Boolean))];
  const sealed = new Map();
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await env.DB.prepare(
      'SELECT DISTINCT snapshot.task_id,task.data FROM book_order_student_snapshots snapshot ' +
      'LEFT JOIN tasks task ON task.app=snapshot.app AND task.id=snapshot.task_id ' +
      'WHERE snapshot.app=? AND snapshot.task_id IN (' + placeholders + ')'
    ).bind(app, ...chunk).all();
    for (const row of result.results || []) sealed.set(String(row.task_id), row.data);
  }
  const skip = new Set();
  for (const entry of taskEntries) {
    const stored = sealed.get(String(entry.change.id || ''));
    if (stored === undefined) continue;
    if (stored && sameTaskJson(stored, entry.change.data)) skip.add(entry);
    else return { error: '봉인된 교재 주문은 전용 주문 화면에서만 변경할 수 있습니다' };
  }
  return { skip };
}

function sameLegacyOrderCancellation(stored, incoming) {
  let current;
  try { current = typeof stored === 'string' ? JSON.parse(stored) : stored; }
  catch (error) { return false; }
  if (!current || current.deleted || !incoming || incoming.deleted !== true) return false;
  const withoutCancellation = value => {
    const clean = { ...value };
    for (const key of ['deleted', 'updatedAt', 'lastEditBy', 'orderCancelledAt']) delete clean[key];
    return canonicalJson(clean);
  };
  return JSON.stringify(withoutCancellation(current)) === JSON.stringify(withoutCancellation(incoming));
}

async function hasUnsafeGenericScheduledOrder(env, app, entries) {
  const scheduled = entries.filter(entry => entry.table === 'tasks' && entry.change &&
    entry.change.data && entry.change.data.orderDelivery === 'scheduled_batch_v1');
  const ids = [...new Set(scheduled.map(entry => String(entry.change.id || '')).filter(Boolean))];
  if (!ids.length) return false;
  const existing = new Map();
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await env.DB.prepare(
      'SELECT id,owner,data FROM tasks WHERE app=? AND id IN (' + placeholders + ')'
    ).bind(app, ...chunk).all();
    for (const row of result.results || []) existing.set(String(row.id), row);
  }
  return scheduled.some(entry => {
    const row = existing.get(String(entry.change.id || ''));
    let current;
    try { current = row && JSON.parse(row.data || '{}'); } catch (error) { current = null; }
    return !row || !current || current.orderDelivery !== 'scheduled_batch_v1' ||
      String(row.owner || '') !== String(entry.change.owner || '') ||
      (!sameTaskJson(row.data, entry.change.data) && !sameLegacyOrderCancellation(row.data, entry.change.data));
  });
}

async function inspectOwnTaskChanges(env, app, owner, entries) {
  const taskEntries = entries.filter(entry => entry.table === 'tasks');
  if (!taskEntries.length) return { skip: new Set(), newTaskIds: new Set() };
  const ids = [...new Set(taskEntries.map(entry => String(entry.change.id)))];
  const placeholders = ids.map(() => '?').join(',');
  const ownRows = await env.DB.prepare(
    'SELECT id,data FROM tasks WHERE app=? AND owner=? AND id IN (' + placeholders + ')'
  ).bind(app, owner, ...ids).all();
  const allRows = await env.DB.prepare(
    'SELECT id,owner FROM tasks WHERE app=? AND id IN (' + placeholders + ')'
  ).bind(app, ...ids).all();
  const ownById = new Map((ownRows.results || []).map(row => [String(row.id), row]));
  const ownerById = new Map((allRows.results || []).map(row => [String(row.id), String(row.owner || '')]));
  const skip = new Set();
  const newTaskIds = new Set();

  for (const entry of taskEntries) {
    const change = entry.change;
    const id = String(change.id);
    const data = change.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        String(data.id || '') !== id || String(data.staffId || '') !== owner) {
      return { error: '업무의 id와 담당자 정보가 개인 인증과 일치하지 않습니다' };
    }
    const storedOwner = ownerById.get(id);
    if (storedOwner && storedOwner !== owner) {
      return { error: '다른 담당자의 업무 ID는 사용할 수 없습니다' };
    }
    const current = ownById.get(id);
    if (!current) {
      if (data.origin !== 'staff') {
        return { error: '개인 링크에서는 직원이 직접 만든 업무만 새로 등록할 수 있습니다' };
      }
      newTaskIds.add(id);
      continue;
    }
    let currentData;
    try { currentData = JSON.parse(current.data); } catch (error) { currentData = null; }
    if (!currentData || currentData.origin !== 'staff') {
      if (sameTaskJson(current.data, data)) {
        skip.add(entry);
        continue;
      }
      return { error: '원장이 등록한 업무는 개인 링크에서 수정하거나 삭제할 수 없습니다' };
    }
    if (data.origin !== 'staff') {
      return { error: '직원 업무의 등록 주체를 변경할 수 없습니다' };
    }
  }
  return { skip, newTaskIds };
}

async function inspectOwnCheckChanges(env, app, owner, entries, newTaskIds) {
  const checkEntries = entries.filter(entry => entry.table === 'checks');
  if (!checkEntries.length) return null;
  const generalTaskIds = [];

  for (const entry of checkEntries) {
    const key = String(entry.change.k || '');
    const firstPipe = key.indexOf('|');
    if (firstPipe <= 0 || firstPipe !== key.lastIndexOf('|') || firstPipe === key.length - 1) {
      return '체크 키 형식을 확인해 주세요';
    }
    const keyTaskId = key.slice(0, firstPipe);
    const keyDate = key.slice(firstPipe + 1);
    const data = entry.change.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return '체크 데이터 형식을 확인해 주세요';
    }
    if (Object.prototype.hasOwnProperty.call(data, 'taskId') && String(data.taskId) !== keyTaskId) {
      return '체크 데이터의 taskId가 체크 키와 일치하지 않습니다';
    }
    if (Object.prototype.hasOwnProperty.call(data, 'date') && String(data.date) !== keyDate) {
      return '체크 데이터의 날짜가 체크 키와 일치하지 않습니다';
    }

    const special = keyTaskId.match(/^__[A-Za-z]+__(.+)$/);
    if (special) {
      if (special[1] !== owner) return '다른 담당자의 특수 체크는 저장할 수 없습니다';
    } else {
      generalTaskIds.push(keyTaskId);
    }
  }

  const idsToFind = [...new Set(generalTaskIds.filter(id => !newTaskIds.has(id)))];
  const allowed = new Set(newTaskIds);
  if (idsToFind.length) {
    const placeholders = idsToFind.map(() => '?').join(',');
    const result = await env.DB.prepare(
      'SELECT id FROM tasks WHERE app=? AND owner=? AND id IN (' + placeholders + ')'
    ).bind(app, owner, ...idsToFind).all();
    for (const row of (result.results || [])) allowed.add(String(row.id));
  }
  if (generalTaskIds.some(id => !allowed.has(id))) {
    return '본인에게 배정된 업무의 체크만 저장할 수 있습니다';
  }
  return null;
}

async function effectiveStaffDeactivations(env, app, entries) {
  if (app !== 'task') return [];
  // 같은 직원이 한 동기화 묶음에 여러 번 있으면 실제 LWW 결과(가장 큰 updated_at,
  // 동률이면 batch에서 먼저 적용되는 항목)만 검사한다. 중간 tombstone 때문에 최종 활성
  // 상태까지 잘못 BOARDING_LOCK 되는 일을 막는다.
  const finalById = new Map();
  for (const entry of entries) {
    if (entry.table !== 'staff' || !entry.change) continue;
    const id = String(entry.change.id || '');
    if (!id) continue;
    const updatedAt = Number(entry.change.updated_at) || 0;
    const previous = finalById.get(id);
    if (!previous || updatedAt > previous.updatedAt) finalById.set(id, { entry, updatedAt });
  }
  const requested = [...finalById.values()]
    .filter(item => !item.entry.change.data || item.entry.change.data.deleted)
    .map(item => item.entry);
  if (!requested.length) return [];

  const currentById = new Map();
  const ids = [...new Set(requested.map(entry => String(entry.change.id || '')).filter(Boolean))];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await env.DB.prepare(
      'SELECT id,data,updated_at FROM staff WHERE app=? AND id IN (' + placeholders + ')'
    ).bind(app, ...chunk).all();
    for (const row of result.results || []) currentById.set(String(row.id), row);
  }

  const effective = [];
  for (const entry of requested) {
    const id = String(entry.change.id || '');
    const current = currentById.get(id);
    if (!current || Number(entry.change.updated_at) <= Number(current.updated_at)) continue;
    let data;
    try { data = JSON.parse(current.data); } catch (error) { data = null; }
    if (data && !data.deleted) effective.push(id);
  }
  return [...new Set(effective)];
}

function foldStaffEntries(entries) {
  const finalById = new Map();
  for (const entry of entries) {
    if (entry.table !== 'staff' || !entry.change) continue;
    const id = String(entry.change.id || '');
    if (!id) continue;
    const updatedAt = Number(entry.change.updated_at) || 0;
    const previous = finalById.get(id);
    // 동일 timestamp는 기존 batch에서 먼저 나온 항목만 적용(WHERE excluded.updated_at > current)된다.
    if (!previous || updatedAt > previous.updatedAt) finalById.set(id, { entry, updatedAt });
  }
  return entries.filter(entry => entry.table !== 'staff' ||
    (entry.change && finalById.get(String(entry.change.id || ''))?.entry === entry));
}

async function boardedDriverConflicts(env, app, staffIds) {
  if (app !== 'task' || !staffIds.length) return [];
  const boarded = await env.DB.prepare(
    "SELECT date,route_id,student_id FROM transport_states WHERE app=? AND status='boarded'"
  ).bind(app).all();
  const boardedRows = boarded.results || [];
  if (!boardedRows.length) return [];

  const configRow = await env.DB.prepare('SELECT data FROM transport_configs WHERE app=? LIMIT 1')
    .bind(app).first();
  if (!configRow) return staffIds.slice();
  let config;
  try { config = JSON.parse(configRow.data); } catch (error) { config = null; }
  if (!config || !Array.isArray(config.routes) || !Array.isArray(config.vehicles)) return staffIds.slice();
  const routes = new Map(config.routes.filter(Boolean).map(route => [String(route.id || ''), route]));
  const vehicles = new Set(config.vehicles.filter(Boolean).map(vehicle => String(vehicle.id || '')));
  const rosterRow = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  let rosterStudents = [];
  try {
    const document = rosterRow && JSON.parse(rosterRow.data);
    rosterStudents = document && document.roster && Array.isArray(document.roster.students)
      ? document.roster.students : [];
  } catch (error) { rosterStudents = []; }
  const rosterById = new Map(rosterStudents.filter(Boolean).map(student => [String(student.id || ''), student]));
  const staffRows = await env.DB.prepare('SELECT id,data FROM staff WHERE app=?').bind(app).all();
  const active = new Set();
  for (const row of staffRows.results || []) {
    try {
      const data = JSON.parse(row.data);
      if (data && !data.deleted) active.add(String(row.id));
    } catch (error) { /* 손상된 직원은 활성 기사로 인정하지 않는다 */ }
  }
  const boardedDrivers = new Set();
  for (const row of boardedRows) {
    const route = routes.get(String(row.route_id || ''));
    const date = String(row.date || '');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + 'T00:00:00Z').getUTCDay() : -1;
    const month = date.slice(0, 7);
    const student = rosterById.get(String(row.student_id || ''));
    const activeStudent = student && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) &&
      String(student.start || '') <= month && (!student.end || String(student.end) > month);
    const assigned = route && Array.isArray(route.stops) && route.stops.some(stop => stop &&
      Array.isArray(stop.studentIds) && stop.studentIds.includes(String(row.student_id || '')));
    if (!route || !route.active || !Array.isArray(route.days) || !route.days.includes(day) || !assigned ||
        !vehicles.has(String(route.vehicleId || '')) || !active.has(String(route.driverId || '')) || !activeStudent) {
      return staffIds.slice();
    }
    boardedDrivers.add(String(route.driverId));
  }
  return staffIds.filter(id => boardedDrivers.has(id));
}

async function handleSync(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);

  const now = Date.now();
  const since = Number(body.since) || 0;
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (changes.length > MAX_CHANGES) {
    return json({ ok: false, error: '한 번에 보낼 수 있는 변경은 ' + MAX_CHANGES + '건까지입니다' }, 413, origin);
  }

  // ── 올리기
  const accepted = [];
  const attemptedOnboardingKeys = new Set();
  let forbidden = false;
  for (const c of changes) {
    if (!c || !c.table || !APPS.includes(app)) continue;
    const t = c.table;
    if (t !== 'staff' && t !== 'tasks' && t !== 'checks') continue;
    if (!(t === 'checks' ? c.k : c.id)) continue;
    // 연락 기록은 서버 검증이 있는 /contact-log에서만 저장한다.
    // 클라이언트 캐시에 내려온 행이 generic LWW로 되올라와 정본을 덮지 않게 무시한다.
    if (t === 'checks' && /^__contact__/.test(String(c.k || ''))) continue;
    const onboardingKey = t === 'checks' && /^__onboarding__/.test(String(c.k || ''));
    if (onboardingKey && c.reconcile === true) {
      if (auth.scope === 'all') attemptedOnboardingKeys.add(String(c.k));
      continue;
    }
    if (onboardingKey) attemptedOnboardingKeys.add(String(c.k));
    if (auth.role === 'manager' && t === 'tasks') {
      const data = c.data;
      if (!SAFE_ID.test(String(c.id || '')) || !SAFE_ID.test(String(c.owner || '')) ||
          !data || typeof data !== 'object' || Array.isArray(data) ||
          String(data.id || '') !== String(c.id) || String(data.staffId || '') !== String(c.owner)) {
        return json({ ok: false, error: '업무의 id와 담당자 정보가 일치하지 않습니다' }, 403, origin);
      }
    }
    // 개인 접속은 자기 것만 쓸 수 있다. 남의 owner를 붙여 보내도 서버에서 막는다.
    if (auth.scope === 'own') {
      // 직원 명부는 서버/원장 소유다. 구형 개인 UI가 명부 행을 다시 올려도 안전하게 무시한다.
      if (t === 'staff') {
        accepted.push({ table: t, change: c });
        continue;
      }
      if (c.owner !== auth.id) {
        forbidden = true;
        break;
      }
    }
    accepted.push({ table: t, change: c });
  }
  if (forbidden) return json({ ok: false, error: '개인 링크에서는 본인 업무만 저장할 수 있습니다' }, 403, origin);
  let skipped = new Set();
  if (auth.scope === 'own') {
    const inspected = await inspectOwnTaskChanges(env, app, auth.id, accepted);
    if (inspected.error) return json({ ok: false, error: inspected.error }, 403, origin);
    skipped = inspected.skip;
    for (const entry of accepted) {
      if (entry.table === 'staff') skipped.add(entry);
    }
    const checkError = await inspectOwnCheckChanges(env, app, auth.id, accepted, inspected.newTaskIds);
    if (checkError) return json({ ok: false, error: checkError }, 403, origin);
  }
  let sealedInspection;
  try { sealedInspection = await inspectSealedOrderChanges(env, app, accepted); }
  catch (error) {
    if (/no such table.*book_order_student_snapshots/i.test(String(error && error.message || error))) {
      return json({ ok: false, code: 'ORDER_LEDGER_NOT_READY', error: '교재 주문 원장을 준비하고 있습니다' }, 503, origin);
    }
    throw error;
  }
  if (sealedInspection.error) {
    return json({ ok: false, code: 'BOOK_ORDER_SEALED', error: sealedInspection.error }, 409, origin);
  }
  for (const entry of sealedInspection.skip) skipped.add(entry);
  if (app === 'task' && await hasUnsafeGenericScheduledOrder(env, app, accepted)) {
    return json({ ok: false, code: 'BOOK_ORDER_CREATE_REQUIRED',
      error: '자동 발송 교재 주문은 전용 주문 화면에서 등록해 주세요' }, 409, origin);
  }
  const writeEntries = foldStaffEntries(accepted.filter(entry => !skipped.has(entry)));
  const deactivations = await effectiveStaffDeactivations(env, app, writeEntries);
  const boardedDrivers = await boardedDriverConflicts(env, app, deactivations);
  if (boardedDrivers.length) {
    return json({
      ok: false,
      code: 'BOARDING_LOCK',
      error: '탑승 후 미하차 학생을 담당하는 기사는 삭제하거나 비활성화할 수 없습니다. 차량 화면에서 하차·인계 또는 사유 있는 상태 초기화를 먼저 완료해 주세요'
    }, 409, origin);
  }
  const stmts = writeEntries
    .map(entry => upsertStmt(env, entry.table, app, entry.change, now, auth.scope === 'own',
      auth.role === 'manager' && entry.table === 'tasks'));
  if (stmts.length) {
    try { await env.DB.batch(stmts); }
    catch (error) {
      if (isBoardingLockError(error)) return boardingLockResponse(origin);
      if (/BOOK_ORDER_SEALED|BOOK_ORDER_SEND_ACTIVE/.test(String(error && error.message || error))) {
        return json({ ok: false, code: 'BOOK_ORDER_SEALED', error: '봉인된 교재 주문은 전용 주문 화면에서만 변경할 수 있습니다' }, 409, origin);
      }
      throw error;
    }
  }

  // CAS 행에 대한 generic LWW 시도가 막혔다면 since와 관계없이 서버 정본을 돌려준다.
  // Pages는 authoritative 표시된 casVersion=1 행만 로컬 시간스탬프보다 우선 적용한다.
  const forced = auth.scope === 'all'
    ? await canonicalOnboardingChanges(env, app, attemptedOnboardingKeys)
    : [];
  const forcedKeys = new Set(forced.map(change => change.key));

  // ── 내려받기 (since 이후)
  const out = forced.slice();
  let more = false;
  for (const t of ['staff', 'tasks', 'checks']) {
    const idCol = t === 'checks' ? 'k' : 'id';
    const sql = 'SELECT ' + idCol + ' AS key, owner, data, updated_at, srv_at FROM ' + t +
      ' WHERE app=? AND srv_at > ?' + (auth.scope === 'own' ? ' AND owner=?' : '') +
      ' ORDER BY srv_at LIMIT ' + (MAX_PULL + 1);
    const st = auth.scope === 'own'
      ? env.DB.prepare(sql).bind(app, since, auth.id)
      : env.DB.prepare(sql).bind(app, since);
    const res = await st.all();
    const rows = (res.results || []);
    if (rows.length > MAX_PULL) { more = true; rows.length = MAX_PULL; }
    for (const r of rows) {
      if (t === 'checks' && forcedKeys.has(String(r.key))) continue;
      out.push({ table: t, key: r.key, owner: r.owner, data: JSON.parse(r.data), updated_at: r.updated_at, srv_at: r.srv_at });
    }
  }

  // more일 때는 받은 것 중 가장 오래된 srv_at까지만 확정해야 빠지는 행이 없다
  const nextSince = more ? Math.max(since, ...out.map(r => r.srv_at)) : now;
  const authRole = auth.role === 'manager' ? 'manager' : (auth.scope === 'all' ? 'admin' : 'staff');
  return json({ ok: true, now: nextSince, more: more, changes: out, authRole }, 200, origin);
}

async function handleToken(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장만 발급할 수 있습니다' }, 401, origin);
  const staffId = String(body.staffId || '');
  if (!staffId) return json({ ok: false, error: 'staffId 필요' }, 400, origin);
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  await env.DB.prepare(
    'INSERT INTO tokens (app, token, staff_id, created_at, revoked) VALUES (?,?,?,?,0)'
  ).bind(app, token, staffId, Date.now()).run();
  return json({ ok: true, token: token }, 200, origin);
}

async function activeStaffData(env, app, staffId) {
  if (!SAFE_ID.test(staffId)) return false;
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind(app, staffId).first();
  if (!row) return false;
  try {
    const staff = JSON.parse(row.data);
    return staff && !staff.deleted ? staff : false;
  } catch (error) { return false; }
}

async function activeStaff(env, app, staffId) {
  return !!await activeStaffData(env, app, staffId);
}

async function issueBootstrap(env, app, staffId, ttlMs) {
  if (staffId !== ADMIN_DEVICE_ID && !await activeStaff(env, app, staffId)) {
    throw new Error('활성 직원을 찾을 수 없습니다');
  }
  const code = randomOpaqueValue();
  const codeHash = tokenStorageValue(await sha256Hex(code));
  const createdAt = Date.now();
  const expiresAt = createdAt + ttlMs;
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE bootstrap_codes SET revoked=1 ' +
      'WHERE app=? AND staff_id=? AND revoked=0 AND consumed_at IS NULL AND expires_at<?'
    ).bind(app, staffId, createdAt),
    env.DB.prepare(
      'INSERT INTO bootstrap_codes(app,code_hash,staff_id,created_at,expires_at,consumed_at,revoked) ' +
      'VALUES(?,?,?,?,?,NULL,0)'
    ).bind(app, codeHash, staffId, createdAt, expiresAt),
    // 최근 미사용 링크를 소수만 함께 유지한다. 새 링크 하나가 기존 전달분을 즉시 끊지는 않되,
    // 무제한으로 살아 있는 연결 링크가 쌓이는 것도 막는다. 방금 발급한 링크는 항상 보존한다.
    env.DB.prepare(
      'UPDATE bootstrap_codes SET revoked=1 ' +
      'WHERE app=? AND staff_id=? AND revoked=0 AND consumed_at IS NULL AND code_hash<>? ' +
      'AND code_hash NOT IN (' +
      'SELECT code_hash FROM bootstrap_codes ' +
      'WHERE app=? AND staff_id=? AND revoked=0 AND consumed_at IS NULL AND code_hash<>? AND expires_at>=? ' +
      'ORDER BY created_at DESC, code_hash DESC LIMIT ' + (MAX_PENDING_BOOTSTRAPS - 1) + ')'
    ).bind(app, staffId, codeHash, app, staffId, codeHash, createdAt)
  ]);
  return { code, expiresAt };
}

async function handleBootstrap(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장만 발급할 수 있습니다' }, 401, origin);
  const staffId = String(body.staffId || '');
  if (!SAFE_ID.test(staffId)) return json({ ok: false, error: '올바른 staffId 필요' }, 400, origin);
  try {
    const issued = await issueBootstrap(env, app, staffId, BOOTSTRAP_TTL_MS);
    const authRole = app === 'task' && taskManagerIds(env).has(staffId) ? 'manager' : 'staff';
    return json({ ok: true, code: issued.code, expiresAt: issued.expiresAt, authRole }, 200, origin);
  } catch (error) {
    return json({ ok: false, error: String(error && error.message || error) }, 409, origin);
  }
}

async function handleExchange(env, app, body, origin) {
  const staffId = String(body.staffId || '');
  const code = String(body.code || '');
  if (!SAFE_ID.test(staffId) || !SAFE_BOOTSTRAP_CODE.test(code)) {
    return json({ ok: false, code: 'LINK_INVALID', error: '올바른 개인 링크가 필요합니다' }, 400, origin);
  }
  const adminDevice = app === 'consult' && staffId === ADMIN_DEVICE_ID;
  const activeSessionLimit = adminDevice ? MAX_ACTIVE_ADMIN_SESSIONS : MAX_ACTIVE_PERSON_SESSIONS;
  if (!adminDevice && !await activeStaff(env, app, staffId)) {
    return json({ ok: false, code: 'LINK_INVALID', error: '접근할 수 없는 개인 링크입니다' }, 401, origin);
  }

  const codeHash = tokenStorageValue(await sha256Hex(code));
  const consumedAt = Date.now();
  const markerBytes = new Uint32Array(1);
  crypto.getRandomValues(markerBytes);
  const consumeMarker = -(consumedAt * 1000 + (markerBytes[0] % 1000));
  const token = randomOpaqueValue();
  const storedHash = tokenStorageValue(await sha256Hex(token));
  const results = await env.DB.batch([
    env.DB.prepare(
      'UPDATE bootstrap_codes SET consumed_at=? ' +
      'WHERE app=? AND code_hash=? AND staff_id=? AND revoked=0 AND consumed_at IS NULL AND expires_at>=?'
    ).bind(consumeMarker, app, codeHash, staffId, consumedAt),
    env.DB.prepare(
      'INSERT INTO tokens(app,token,staff_id,created_at,revoked) ' +
      'SELECT ?,?,?,?,0 WHERE EXISTS (' +
      'SELECT 1 FROM bootstrap_codes WHERE app=? AND code_hash=? AND staff_id=? AND consumed_at=?)'
    ).bind(app, storedHash, staffId, consumedAt, app, codeHash, staffId, consumeMarker),
    env.DB.prepare(
      'UPDATE tokens SET revoked=1 ' +
      'WHERE app=? AND staff_id=? AND revoked=0 AND created_at<? AND EXISTS (' +
      'SELECT 1 FROM bootstrap_codes WHERE app=? AND code_hash=? AND staff_id=? AND consumed_at=?)'
    ).bind(app, staffId, consumedAt - TOKEN_TTL_MS, app, codeHash, staffId, consumeMarker),
    // 새 기기를 포함해 최근 세 세션만 유지한다. 새 연결 자체는 반드시 남기고,
    // 나머지 중 생성 시각이 가장 최근인 두 세션만 보존한다.
    env.DB.prepare(
      'UPDATE tokens SET revoked=1 ' +
      'WHERE app=? AND staff_id=? AND revoked=0 AND token<>? AND token NOT IN (' +
      'SELECT token FROM tokens WHERE app=? AND staff_id=? AND revoked=0 AND token<>? ' +
      'ORDER BY created_at DESC, token DESC LIMIT ' + (activeSessionLimit - 1) + ') AND EXISTS (' +
      'SELECT 1 FROM bootstrap_codes WHERE app=? AND code_hash=? AND staff_id=? AND consumed_at=?)'
    ).bind(app, staffId, storedHash, app, staffId, storedHash, app, codeHash, staffId, consumeMarker),
    env.DB.prepare(
      'UPDATE bootstrap_codes SET consumed_at=? WHERE app=? AND code_hash=? AND staff_id=? AND consumed_at=?'
    ).bind(consumedAt, app, codeHash, staffId, consumeMarker)
  ]);
  const changed = index => Number(results[index] && results[index].meta && results[index].meta.changes || 0);
  if (changed(0) !== 1 || changed(1) !== 1 || changed(4) !== 1) {
    const row = await env.DB.prepare(
      'SELECT consumed_at,revoked,expires_at FROM bootstrap_codes ' +
      'WHERE app=? AND code_hash=? AND staff_id=? LIMIT 1'
    ).bind(app, codeHash, staffId).first();
    if (!row) return json({ ok: false, code: 'LINK_INVALID', error: '올바르지 않은 개인 링크입니다' }, 410, origin);
    if (row.consumed_at !== null && row.consumed_at !== undefined) {
      return json({ ok: false, code: 'LINK_USED', error: '이미 사용한 개인 링크입니다' }, 410, origin);
    }
    if (Number(row.expires_at) < consumedAt) {
      return json({ ok: false, code: 'LINK_EXPIRED', error: '사용 시간이 지난 개인 링크입니다' }, 410, origin);
    }
    if (Number(row.revoked)) {
      return json({ ok: false, code: 'LINK_REPLACED', error: '더 최근에 발급된 링크를 사용해 주세요' }, 410, origin);
    }
    return json({ ok: false, code: 'LINK_USED', error: '다른 화면에서 먼저 사용된 개인 링크입니다' }, 409, origin);
  }
  return json({ ok: true, token, expiresAt: consumedAt + TOKEN_TTL_MS,
    activeSessionLimit }, 200, origin);
}

async function handleHandoff(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || !SAFE_ID.test(auth.id) || (auth.scope !== 'own' && auth.role !== 'manager')) {
    return json({ ok: false, code: 'AUTH_REQUIRED', error: '개인 인증이 필요합니다' }, 401, origin);
  }
  const issued = await issueBootstrap(env, app, auth.id, HANDOFF_TTL_MS);
  return json({ ok: true, code: issued.code, expiresAt: issued.expiresAt,
    authRole: auth.role === 'manager' ? 'manager' : 'staff' }, 200, origin);
}

async function handleAdminHandoff(env, app, body, origin) {
  if (app !== 'consult') {
    return json({ ok: false, error: '원장 기기 연결은 consult 앱에서만 사용할 수 있습니다' }, 400, origin);
  }
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.scope !== 'all') {
    return json({ ok: false, code: 'AUTH_REQUIRED', error: '원장 인증이 필요합니다' }, 401, origin);
  }
  const issued = await issueBootstrap(env, app, ADMIN_DEVICE_ID, HANDOFF_TTL_MS);
  return json({ ok: true, code: issued.code, expiresAt: issued.expiresAt }, 200, origin);
}

async function issueAdminDeviceToken(env) {
  const token = randomOpaqueValue();
  const storedHash = tokenStorageValue(await sha256Hex(token));
  const createdAt = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
    ).bind('consult', storedHash, ADMIN_DEVICE_ID, createdAt),
    env.DB.prepare(
      'UPDATE tokens SET revoked=1 WHERE app=? AND staff_id=? AND revoked=0 AND created_at<?'
    ).bind('consult', ADMIN_DEVICE_ID, createdAt - TOKEN_TTL_MS),
    env.DB.prepare(
      'UPDATE tokens SET revoked=1 WHERE app=? AND staff_id=? AND revoked=0 AND token<>? AND token NOT IN (' +
      'SELECT token FROM tokens WHERE app=? AND staff_id=? AND revoked=0 AND token<>? ' +
      'ORDER BY created_at DESC, token DESC LIMIT ' + (MAX_ACTIVE_ADMIN_SESSIONS - 1) + ')'
    ).bind('consult', ADMIN_DEVICE_ID, storedHash, 'consult', ADMIN_DEVICE_ID, storedHash)
  ]);
  return { token, expiresAt: createdAt + TOKEN_TTL_MS };
}

function adminLoginId(value) {
  return String(value || '').trim().toLowerCase();
}

async function handleAdminAccount(env, app, body, origin) {
  if (app !== 'consult') {
    return json({ ok: false, error: '원장 로그인 계정은 consult 앱에서만 사용할 수 있습니다' }, 400, origin);
  }
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.scope !== 'all') {
    return json({ ok: false, code: 'AUTH_REQUIRED', error: '원장 인증이 필요합니다' }, 401, origin);
  }
  const action = String(body.action || 'get');
  if (action === 'get') {
    const row = await env.DB.prepare('SELECT login_id,updated_at FROM admin_accounts WHERE app=? LIMIT 1')
      .bind('consult').first();
    return json({ ok: true, configured: !!row, loginId: row ? row.login_id : '',
      updatedAt: row ? row.updated_at : null }, 200, origin);
  }
  if (action !== 'set') return json({ ok: false, error: '올바른 action이 필요합니다' }, 400, origin);

  const loginId = adminLoginId(body.loginId);
  const password = String(body.password || '');
  if (!SAFE_ADMIN_LOGIN_ID.test(loginId)) {
    return json({ ok: false, error: '아이디는 영문·숫자·._@- 조합 3~64자로 입력해 주세요' }, 400, origin);
  }
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH || password.length > ADMIN_PASSWORD_MAX_LENGTH) {
    return json({ ok: false, error: '비밀번호는 8~128자로 입력해 주세요' }, 400, origin);
  }
  const salt = randomOpaqueValue();
  const hash = await passwordHash(password, salt, ADMIN_PASSWORD_ITERATIONS);
  const updatedAt = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO admin_accounts(app,login_id,password_salt,password_hash,password_iterations,' +
      'failed_attempts,locked_until,updated_at) VALUES(?,?,?,?,?,0,0,?) ' +
      'ON CONFLICT(app) DO UPDATE SET login_id=excluded.login_id,password_salt=excluded.password_salt,' +
      'password_hash=excluded.password_hash,password_iterations=excluded.password_iterations,' +
      'failed_attempts=0,locked_until=0,updated_at=excluded.updated_at'
    ).bind('consult', loginId, salt, hash, ADMIN_PASSWORD_ITERATIONS, updatedAt),
    env.DB.prepare('UPDATE tokens SET revoked=1 WHERE app=? AND staff_id=? AND revoked=0')
      .bind('consult', ADMIN_DEVICE_ID)
  ]);
  const issued = await issueAdminDeviceToken(env);
  return json({ ok: true, loginId, token: issued.token, expiresAt: issued.expiresAt,
    activeSessionLimit: MAX_ACTIVE_ADMIN_SESSIONS }, 200, origin);
}

async function handleAdminLogin(env, app, body, origin) {
  if (app !== 'consult') {
    return json({ ok: false, error: '원장 로그인은 consult 앱에서만 사용할 수 있습니다' }, 400, origin);
  }
  const row = await env.DB.prepare(
    'SELECT login_id,password_salt,password_hash,password_iterations,failed_attempts,locked_until ' +
    'FROM admin_accounts WHERE app=? LIMIT 1'
  ).bind('consult').first();
  if (!row) {
    return json({ ok: false, code: 'ACCOUNT_NOT_CONFIGURED',
      error: '기존 원장 기기의 설정에서 로그인 계정을 먼저 만들어 주세요' }, 409, origin);
  }
  const now = Date.now();
  if (Number(row.locked_until || 0) > now) {
    return json({ ok: false, code: 'LOGIN_LOCKED', error: '시도 횟수가 많습니다. 5분 후 다시 시도해 주세요' }, 429, origin);
  }
  const loginId = adminLoginId(body.loginId);
  const password = String(body.password || '');
  if (loginId.length > 64 || password.length > ADMIN_PASSWORD_MAX_LENGTH) {
    return json({ ok: false, code: 'LOGIN_FAILED', error: '아이디 또는 비밀번호가 맞지 않습니다' }, 401, origin);
  }
  const hash = await passwordHash(password, row.password_salt, Number(row.password_iterations));
  const valid = safeEqual(loginId, row.login_id) && safeEqual(hash, row.password_hash);
  if (!valid) {
    const failures = Number(row.failed_attempts || 0) + 1;
    const lockedUntil = failures >= ADMIN_LOGIN_MAX_FAILURES ? now + ADMIN_LOGIN_LOCK_MS : 0;
    await env.DB.prepare(
      'UPDATE admin_accounts SET failed_attempts=?,locked_until=? WHERE app=?'
    ).bind(failures >= ADMIN_LOGIN_MAX_FAILURES ? 0 : failures, lockedUntil, 'consult').run();
    return json({ ok: false, code: 'LOGIN_FAILED', error: '아이디 또는 비밀번호가 맞지 않습니다' }, 401, origin);
  }
  await env.DB.prepare('UPDATE admin_accounts SET failed_attempts=0,locked_until=0 WHERE app=?')
    .bind('consult').run();
  const issued = await issueAdminDeviceToken(env);
  return json({ ok: true, loginId: row.login_id, token: issued.token, expiresAt: issued.expiresAt,
    activeSessionLimit: MAX_ACTIVE_ADMIN_SESSIONS }, 200, origin);
}

async function handleRevoke(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장만 해지할 수 있습니다' }, 401, origin);
  const staffId = String(body.staffId || '');
  if (staffId) {
    if (!SAFE_ID.test(staffId)) return json({ ok: false, error: '올바른 staffId 필요' }, 400, origin);
    await env.DB.batch([
      env.DB.prepare('UPDATE tokens SET revoked=1 WHERE app=? AND staff_id=?').bind(app, staffId),
      env.DB.prepare('UPDATE bootstrap_codes SET revoked=1 WHERE app=? AND staff_id=?').bind(app, staffId)
    ]);
  } else {
    await env.DB.prepare('UPDATE tokens SET revoked=1 WHERE app=? AND token=?')
      .bind(app, String(body.token || '')).run();
  }
  return json({ ok: true }, 200, origin);
}

function authoritativeStaffRecord(row) {
  if (!row) return null;
  let data = null;
  try { data = JSON.parse(row.data); } catch (error) { /* 손상된 행은 정본 메타데이터만 반환한다 */ }
  return {
    id: String(row.id), owner: row.owner == null ? null : String(row.owner), data,
    updated_at: Number(row.updated_at), srv_at: Number(row.srv_at), authoritative: true
  };
}

async function handleStaffDeactivate(env, app, body, origin) {
  if (app !== 'task') {
    return json({ ok: false, error: '직원 비활성화는 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  }
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.scope !== 'all') {
    return json({ ok: false, error: '전체 관리 권한이 필요합니다' }, 401, origin);
  }
  const staffId = String(body.staffId || '');
  const expected = Number(body.expectedUpdatedAt);
  if (!SAFE_ID.test(staffId) || !Number.isSafeInteger(expected) || expected < 0) {
    return json({ ok: false, error: '올바른 staffId와 expectedUpdatedAt이 필요합니다' }, 400, origin);
  }

  const select = () => env.DB.prepare(
    'SELECT id,owner,data,updated_at,srv_at FROM staff WHERE app=? AND id=? LIMIT 1'
  ).bind(app, staffId).first();
  let current = await select();
  let currentData = null;
  try { currentData = current && JSON.parse(current.data); } catch (error) { /* 아래에서 stale로 처리 */ }
  if (!current || Number(current.updated_at) !== expected || !currentData ||
      typeof currentData !== 'object' || Array.isArray(currentData) || currentData.deleted) {
    return json({
      ok: false, code: 'STALE_REVISION',
      error: '직원 정보가 바뀌었습니다. 새로고침 후 다시 처리해 주세요',
      staff: authoritativeStaffRecord(current), updatedAt: current ? Number(current.updated_at) : 0
    }, 409, origin);
  }

  const now = Date.now();
  const nextUpdatedAt = Math.max(now, expected + 1);
  const tombstone = { ...currentData, id: staffId, deleted: true, updatedAt: nextUpdatedAt };
  const owner = current.owner == null ? staffId : String(current.owner);
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        'UPDATE staff SET owner=?,data=?,updated_at=?,srv_at=? ' +
        "WHERE app=? AND id=? AND updated_at=? AND json_valid(data) AND json_type(data)='object' " +
        "AND COALESCE(json_extract(data,'$.deleted'),0)=0"
      ).bind(owner, JSON.stringify(tombstone), nextUpdatedAt, now, app, staffId, expected),
      env.DB.prepare(
        "UPDATE tokens SET revoked=1 WHERE app=? AND staff_id=? AND EXISTS (" +
        "SELECT 1 FROM staff WHERE app=? AND id=? AND updated_at=? " +
        "AND json_valid(data) AND json_type(data)='object' AND COALESCE(json_extract(data,'$.deleted'),0)<>0)"
      ).bind(app, staffId, app, staffId, nextUpdatedAt),
      env.DB.prepare(
        "UPDATE bootstrap_codes SET revoked=1 WHERE app=? AND staff_id=? AND EXISTS (" +
        "SELECT 1 FROM staff WHERE app=? AND id=? AND updated_at=? " +
        "AND json_valid(data) AND json_type(data)='object' AND COALESCE(json_extract(data,'$.deleted'),0)<>0)"
      ).bind(app, staffId, app, staffId, nextUpdatedAt)
    ]);
  } catch (error) {
    if (isBoardingLockError(error)) return boardingLockResponse(origin);
    throw error;
  }
  const changed = Number(results[0] && results[0].meta && results[0].meta.changes || 0);
  current = await select();
  if (changed !== 1 || !current || Number(current.updated_at) !== nextUpdatedAt) {
    return json({
      ok: false, code: 'STALE_REVISION',
      error: '직원 정보가 다른 화면에서 먼저 바뀌었습니다. 새로고침 후 다시 처리해 주세요',
      staff: authoritativeStaffRecord(current), updatedAt: current ? Number(current.updated_at) : 0
    }, 409, origin);
  }
  return json({
    ok: true, idempotent: false, staff: authoritativeStaffRecord(current), updatedAt: nextUpdatedAt
  }, 200, origin);
}


/* ══════════════════════════════════════════════════════
   학부모 피드백 — 항목 제출 + 실제 발송
   2026-08 원장 지시: 별도 승인 클릭 없이, 직원이 항목(오늘 배운 내용·잘한 점·보완할 점)을
   골라 제출하는 순간 카카오 알림톡 실발송을 바로 시도한다(parent-feedback-send.js의
   attemptParentFeedbackSend). status는 그 시도 결과 — 'sent'는 성공, 'content_approved_
   send_blocked'는 "아직 못 나감"(사유는 review_note)이다. /feedback-review는 원장이
   발송 이력을 확인하고, 막힌 건을 수동으로 재시도하는 용도로 남아 있다.
   ══════════════════════════════════════════════════════ */
const FEEDBACK_STATUSES = new Set([
  'approval_waiting',
  'content_approved_send_blocked',
  'sent',
  'revision_requested',
  'cancelled'
]);
const SAFE_FEEDBACK_PART = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_FEEDBACK_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FEEDBACK_BODY = 5000;
const MAX_REVIEW_NOTE = 1000;
const MAX_FEEDBACK_FIELD = 300;   // 알림톡 항목별 변수 하나당 상한 — 900자 총합 체크는 발송 시점에 다시 한다
const MAX_STUDENT_NAME = 40;

/** 제출한 선생님의 실제 이름을 서버가 직접 찾는다 — 클라이언트가 이름을 자유롭게
 *  적어 보내게 하면(직원이 다른 선생님 이름으로 보낼 수도 있어) 신뢰하지 않는다. */
async function activeStaffName(env, app, staffId) {
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind(app, staffId).first();
  if (!row) return null;
  try {
    const data = JSON.parse(row.data || '{}');
    const name = String(data.name || '').replace(/\s+/g, ' ').trim();
    if (String(data.id || staffId) !== staffId || data.deleted || !name || name.length > 40 ||
        /[\r\n\u0000-\u001f]/.test(name) || !/^[가-힣A-Za-z·.\- ]+$/.test(name)) {
      return null;
    }
    return name;
  } catch (error) {
    return null;
  }
}

function normalizeFeedbackField(value) {
  return String(value == null ? '' : value).replace(/[\r\n\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function validIsoDate(value) {
  const text = String(value || '');
  if (!SAFE_FEEDBACK_DATE.test(text)) return false;
  const date = new Date(text + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function normalizeFeedbackBody(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
}

function feedbackIdentity(body) {
  const taskId = String(body.taskId || '');
  const feedbackDate = String(body.feedbackDate || '');
  const feedbackType = String(body.feedbackType || 'class_feedback');
  const templateVersion = String(body.templateVersion || 'v1');
  if (!SAFE_ID.test(taskId)) return { error: '올바른 taskId가 필요합니다' };
  if (!validIsoDate(feedbackDate)) return { error: 'feedbackDate는 YYYY-MM-DD 형식이어야 합니다' };
  if (!SAFE_FEEDBACK_PART.test(feedbackType)) return { error: '올바른 feedbackType이 필요합니다' };
  if (!SAFE_FEEDBACK_PART.test(templateVersion)) return { error: '올바른 templateVersion이 필요합니다' };
  return { taskId, feedbackDate, feedbackType, templateVersion };
}

async function feedbackRequestKey(identity) {
  const raw = [identity.taskId, identity.feedbackDate, identity.feedbackType, identity.templateVersion].join('\u001f');
  return 'fbr_' + (await sha256Hex(raw)).slice(0, 48);
}

function feedbackView(row) {
  if (!row) return null;
  return {
    requestKey: row.request_key,
    taskId: row.task_id,
    owner: row.owner,
    feedbackDate: row.feedback_date,
    feedbackType: row.feedback_type,
    templateVersion: row.template_version,
    message: row.body,
    bodyHash: row.body_hash,
    teacherName: row.teacher_name || '',
    studentId: row.student_id || '',
    studentName: row.student_name || '',
    contentText: row.content_text || '',
    plusText: row.plus_text || '',
    minusText: row.minus_text || '',
    revision: Number(row.revision),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewNote: row.review_note == null ? '' : String(row.review_note)
  };
}

async function taskForFeedback(env, identity, auth, origin) {
  const task = await env.DB.prepare('SELECT owner, data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind('task', identity.taskId).first();
  if (!task) return { response: json({ ok: false, error: '업무를 찾을 수 없습니다' }, 404, origin) };
  if (!task.owner || !SAFE_ID.test(String(task.owner))) {
    return { response: json({ ok: false, error: '담당자가 지정된 업무만 요청할 수 있습니다' }, 409, origin) };
  }
  if (auth.scope === 'own' && task.owner !== auth.id) {
    return { response: json({ ok: false, error: '본인 업무의 피드백만 요청할 수 있습니다' }, 403, origin) };
  }
  let taskData;
  try {
    taskData = JSON.parse(task.data || '{}');
    if (taskData.deleted) {
      return { response: json({ ok: false, error: '삭제된 업무에는 요청할 수 없습니다' }, 409, origin) };
    }
  } catch (error) {
    return { response: json({ ok: false, error: '업무 데이터가 올바르지 않습니다' }, 409, origin) };
  }
  return { task, taskData };
}

async function findFeedbackRequest(env, identity) {
  return await env.DB.prepare(
    'SELECT * FROM feedback_requests WHERE app=? AND task_id=? AND feedback_date=? ' +
    'AND feedback_type=? AND template_version=? LIMIT 1'
  ).bind('task', identity.taskId, identity.feedbackDate, identity.feedbackType, identity.templateVersion).first();
}

async function handleFeedbackRequest(env, app, body, origin) {
  if (app !== 'task') return json({ ok: false, error: '학부모 피드백은 task 앱에서만 사용할 수 있습니다' }, 400, origin);
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);

  const action = String(body.action || 'submit');
  if (action !== 'submit' && action !== 'cancel' && action !== 'list') {
    return json({ ok: false, error: 'action은 submit, cancel 또는 list여야 합니다' }, 400, origin);
  }
  if (action === 'list') {
    if (auth.scope !== 'own') {
      return json({ ok: false, error: '직원 본인의 피드백 요청만 확인할 수 있습니다' }, 403, origin);
    }
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 100));
    const result = await env.DB.prepare(
      "SELECT * FROM feedback_requests WHERE app=? AND owner=? ORDER BY CASE status " +
      "WHEN 'revision_requested' THEN 0 WHEN 'approval_waiting' THEN 1 " +
      "WHEN 'content_approved_send_blocked' THEN 2 WHEN 'sent' THEN 3 WHEN 'cancelled' THEN 4 ELSE 5 END, updated_at DESC LIMIT " + limit
    ).bind('task', auth.id).all();
    return json({ ok: true, requests: (result.results || []).map(feedbackView) }, 200, origin);
  }
  const identity = feedbackIdentity(body);
  if (identity.error) return json({ ok: false, error: identity.error }, 400, origin);
  const checked = await taskForFeedback(env, identity, auth, origin);
  if (checked.response) return checked.response;

  const owner = String(checked.task.owner);
  const now = Date.now();
  let current = await findFeedbackRequest(env, identity);

  if (action === 'cancel') {
    if (!current) return json({ ok: false, error: '취소할 피드백 요청을 찾을 수 없습니다' }, 404, origin);
    if (current.status === 'cancelled') {
      return json({ ok: true, idempotent: true, request: feedbackView(current) }, 200, origin);
    }
    const result = await env.DB.prepare(
      "UPDATE feedback_requests SET owner=?, status='cancelled', revision=revision+1, updated_at=?, " +
      'reviewed_at=NULL, reviewed_by=NULL, review_note=NULL WHERE app=? AND request_key=? AND revision=?'
    ).bind(owner, now, 'task', current.request_key, Number(current.revision)).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도해 주세요' }, 409, origin);
    }
    current = await env.DB.prepare('SELECT * FROM feedback_requests WHERE app=? AND request_key=? LIMIT 1')
      .bind('task', current.request_key).first();
    return json({ ok: true, idempotent: false, request: feedbackView(current) }, 200, origin);
  }

  const message = normalizeFeedbackBody(body.message);
  if (!message) return json({ ok: false, error: '피드백 문구를 입력해 주세요' }, 400, origin);
  if (message.length > MAX_FEEDBACK_BODY) {
    return json({ ok: false, error: '피드백 문구는 ' + MAX_FEEDBACK_BODY + '자까지 입력할 수 있습니다' }, 413, origin);
  }

  // 항목별 변수 — 카카오 알림톡 발송이 그대로 쓰는 값이다. 선생님 이름은 클라이언트가
  // 자유롭게 못 적게 서버가 owner(auth.id)로 직접 찾고, 학생 이름도 지시서에서 서버가 뽑는다.
  const teacherName = await activeStaffName(env, app, owner);
  if (!teacherName) return json({ ok: false, error: '담당 직원 정보를 확인할 수 없어 제출할 수 없습니다' }, 409, origin);
  const studentId = String(checked.taskData.studentId || '').trim();
  if (!SAFE_ID.test(studentId)) {
    return json({
      ok: false,
      code: 'STUDENT_ID_REQUIRED',
      error: '원생 명단에서 학생을 선택해 만든 수업 지시서에서만 학부모 알림을 보낼 수 있습니다'
    }, 409, origin);
  }
  const studentName = resolveStudentName(checked.taskData);
  if (!studentName || studentName.length > MAX_STUDENT_NAME) {
    return json({ ok: false, error: '지시서에서 학생 이름을 찾을 수 없습니다' }, 409, origin);
  }
  const contentText = normalizeFeedbackField(body.contentText);
  const plusText = normalizeFeedbackField(body.plusText);
  const minusText = normalizeFeedbackField(body.minusText);
  if (!contentText || !plusText || !minusText) {
    return json({ ok: false, error: '오늘 배운 내용·잘한 점·보완할 점을 모두 골라 주세요' }, 400, origin);
  }
  if (contentText.length > MAX_FEEDBACK_FIELD || plusText.length > MAX_FEEDBACK_FIELD || minusText.length > MAX_FEEDBACK_FIELD) {
    return json({ ok: false, error: '항목별 문구는 각각 ' + MAX_FEEDBACK_FIELD + '자까지 입력할 수 있습니다' }, 413, origin);
  }

  const bodyHash = await sha256Hex(message);
  const requestKey = await feedbackRequestKey(identity);
  const sameFields = row => row && row.body_hash === bodyHash && row.body === message &&
    row.teacher_name === teacherName && row.student_id === studentId && row.student_name === studentName &&
    row.content_text === contentText && row.plus_text === plusText && row.minus_text === minusText;

  if (!current) {
    const insertResult = await env.DB.prepare(
      'INSERT OR IGNORE INTO feedback_requests ' +
      '(app,request_key,task_id,owner,feedback_date,feedback_type,template_version,body,body_hash,' +
      'teacher_name,student_id,student_name,content_text,plus_text,minus_text,' +
      'revision,status,created_at,updated_at,reviewed_at,reviewed_by,review_note) ' +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'approval_waiting',?,?,NULL,NULL,NULL)"
    ).bind('task', requestKey, identity.taskId, owner, identity.feedbackDate, identity.feedbackType,
      identity.templateVersion, message, bodyHash, teacherName, studentId, studentName, contentText, plusText, minusText,
      now, now).run();
    current = await findFeedbackRequest(env, identity);
    if (!current) return json({ ok: false, error: '피드백 요청을 저장하지 못했습니다' }, 500, origin);
    const freshInsert = Number(insertResult && insertResult.meta && insertResult.meta.changes || 0) === 1;
    if (freshInsert) {
      current = await attemptSendAndReload(env, app, current);
      return json({ ok: true, idempotent: false, request: feedbackView(current) }, 200, origin);
    }
    if (sameFields(current)) {
      return json({ ok: true, idempotent: true, request: feedbackView(current) }, 200, origin);
    }
  }

  if (sameFields(current) && current.status === 'revision_requested') {
    return json({
      ok: false,
      code: 'REVISION_UNCHANGED',
      error: '수정 요청을 반영해 문구를 변경한 뒤 다시 제출해 주세요',
      request: feedbackView(current)
    }, 409, origin);
  }

  if (sameFields(current) && current.status !== 'cancelled') {
    // 내용은 그대로다 — 다만 이전에 막혀서 못 나갔을 수 있으니(보호자 등록 등) 재시도는 해본다.
    current = await attemptSendAndReload(env, app, current);
    return json({ ok: true, idempotent: true, request: feedbackView(current) }, 200, origin);
  }

  const result = await env.DB.prepare(
    "UPDATE feedback_requests SET owner=?, body=?, body_hash=?, teacher_name=?, student_id=?, student_name=?, " +
    "content_text=?, plus_text=?, minus_text=?, revision=revision+1, status='approval_waiting', " +
    'updated_at=?, reviewed_at=NULL, reviewed_by=NULL, review_note=NULL ' +
    'WHERE app=? AND request_key=? AND revision=?'
  ).bind(owner, message, bodyHash, teacherName, studentId, studentName, contentText, plusText, minusText,
    now, 'task', current.request_key, Number(current.revision)).run();
  if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
    return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도해 주세요' }, 409, origin);
  }
  current = await env.DB.prepare('SELECT * FROM feedback_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind('task', current.request_key).first();
  current = await attemptSendAndReload(env, app, current);
  return json({ ok: true, idempotent: false, request: feedbackView(current) }, 200, origin);
}

/** 제출 즉시 카카오 알림톡 발송을 시도하고, 상태가 바뀐 최신 행을 다시 읽어 돌려준다.
 *  attemptParentFeedbackSend가 실패해도(설정 안 됨, 보호자 미등록 등) 예외를 던지지 않고
 *  상태·사유를 review_note에 남기므로, 여기서는 그 결과를 그대로 반영한 최신 행만 반환한다. */
async function attemptSendAndReload(env, app, current) {
  await attemptParentFeedbackSend(env, app, current);
  return await env.DB.prepare('SELECT * FROM feedback_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind(app, current.request_key).first();
}

async function handleFeedbackReview(env, app, body, origin) {
  if (app !== 'task') return json({ ok: false, error: '학부모 피드백은 task 앱에서만 사용할 수 있습니다' }, 400, origin);
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);
  if (auth.scope !== 'all') return json({ ok: false, error: '원장만 피드백 문구를 검토할 수 있습니다' }, 403, origin);
  const reviewedBy = auth.role === 'manager' ? auth.id : 'director';

  const action = String(body.action || 'list');
  if (action === 'list') {
    const clauses = ['app=?'];
    const binds = ['task'];
    if (body.status != null && body.status !== '') {
      const status = String(body.status);
      if (!FEEDBACK_STATUSES.has(status)) return json({ ok: false, error: '올바른 status가 필요합니다' }, 400, origin);
      clauses.push('status=?'); binds.push(status);
    }
    if (body.owner != null && body.owner !== '') {
      const owner = String(body.owner);
      if (!SAFE_ID.test(owner)) return json({ ok: false, error: '올바른 owner가 필요합니다' }, 400, origin);
      clauses.push('owner=?'); binds.push(owner);
    }
    if (body.feedbackDate != null && body.feedbackDate !== '') {
      const feedbackDate = String(body.feedbackDate);
      if (!validIsoDate(feedbackDate)) return json({ ok: false, error: 'feedbackDate는 YYYY-MM-DD 형식이어야 합니다' }, 400, origin);
      clauses.push('feedback_date=?'); binds.push(feedbackDate);
    }
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 100));
    const statement = env.DB.prepare(
      'SELECT * FROM feedback_requests WHERE ' + clauses.join(' AND ') +
      " ORDER BY CASE status WHEN 'approval_waiting' THEN 0 WHEN 'revision_requested' THEN 1 " +
      "WHEN 'content_approved_send_blocked' THEN 2 WHEN 'sent' THEN 3 WHEN 'cancelled' THEN 4 ELSE 5 END, updated_at DESC LIMIT " + limit
    ).bind(...binds);
    const result = await statement.all();
    return json({ ok: true, requests: (result.results || []).map(feedbackView) }, 200, origin);
  }

  if (action !== 'approve_content' && action !== 'request_revision') {
    return json({ ok: false, error: 'action은 list, approve_content 또는 request_revision이어야 합니다' }, 400, origin);
  }
  const requestKey = String(body.requestKey || '');
  const expectedRevision = Number(body.revision);
  if (!SAFE_ID.test(requestKey) || !requestKey.startsWith('fbr_')) {
    return json({ ok: false, error: '올바른 requestKey가 필요합니다' }, 400, origin);
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return json({ ok: false, error: '현재 revision이 필요합니다' }, 400, origin);
  }
  let current = await env.DB.prepare('SELECT * FROM feedback_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind('task', requestKey).first();
  if (!current) return json({ ok: false, error: '피드백 요청을 찾을 수 없습니다' }, 404, origin);
  if (Number(current.revision) !== expectedRevision) {
    return json({ ok: false, error: '문구가 변경되었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
  }
  if (current.status === 'cancelled') return json({ ok: false, error: '취소된 요청은 검토할 수 없습니다' }, 409, origin);

  const now = Date.now();
  if (action === 'approve_content') {
    if (current.status === 'content_approved_send_blocked') {
      return json({ ok: true, idempotent: true, request: feedbackView(current) }, 200, origin);
    }
    if (current.status !== 'approval_waiting') {
      return json({ ok: false, error: '수정된 문구가 다시 제출된 뒤 승인할 수 있습니다' }, 409, origin);
    }
    const result = await env.DB.prepare(
      "UPDATE feedback_requests SET status='content_approved_send_blocked', updated_at=?, reviewed_at=?, " +
      "reviewed_by=?, review_note=NULL WHERE app=? AND request_key=? AND revision=? AND status='approval_waiting'"
    ).bind(now, now, reviewedBy, 'task', requestKey, expectedRevision).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
    }
  } else {
    const note = normalizeFeedbackBody(body.note);
    if (!note) return json({ ok: false, error: '수정 요청 내용을 입력해 주세요' }, 400, origin);
    if (note.length > MAX_REVIEW_NOTE) return json({ ok: false, error: '수정 요청은 ' + MAX_REVIEW_NOTE + '자까지 입력할 수 있습니다' }, 413, origin);
    if (current.status === 'revision_requested' && String(current.review_note || '') === note) {
      return json({ ok: true, idempotent: true, request: feedbackView(current) }, 200, origin);
    }
    const result = await env.DB.prepare(
      "UPDATE feedback_requests SET status='revision_requested', updated_at=?, reviewed_at=?, " +
      "reviewed_by=?, review_note=? WHERE app=? AND request_key=? AND revision=? AND status<>'cancelled'"
    ).bind(now, now, reviewedBy, note, 'task', requestKey, expectedRevision).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
    }
  }
  current = await env.DB.prepare('SELECT * FROM feedback_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind('task', requestKey).first();
  return json({ ok: true, idempotent: false, request: feedbackView(current) }, 200, origin);
}


/* ══════════════════════════════════════════════════════
   인강 커리큘럼 자동 가져오기
   앱은 정적 페이지라 외부 사이트를 직접 못 읽는다(CORS). 워커가 대신 가져와 파싱한다.
   · /search      네이버 검색으로 강좌 페이지 주소를 찾는다
   · /curriculum  그 주소에서 목차(회차·제목·시간)를 뽑는다
   파서는 사이트별 선택자가 아니라 "회차 번호 + 시간 표기" 패턴 기반이라
   사이트가 개편돼도 잘 버틴다. 다만 자바스크립트로 목록을 그리는 페이지는
   여기서도 못 잡으므로, 그 경우 목차 붙여넣기로 안내한다.
   ══════════════════════════════════════════════════════ */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SEARCH_DOMAINS = {
  '엘리하이': 'mbest.co.kr', '엠베스트': 'mbest.co.kr', '메가스터디': 'megastudy.net',
  '이투스': 'etoos.com', '대성마이맥': 'mimacstudy.com'
};

/** 내부망·로컬 주소로 워커를 대신 찔러보게 하는 것을 막는다 */
function publicUrlOrNull(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return null;
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0 ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
        (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254)) return null;
  }
  if (h === '[::1]' || h.startsWith('[fc') || h.startsWith('[fd')) return null;
  return u.toString();
}

/** 한국 강의 사이트는 아직 euc-kr을 쓰는 곳이 있어 인코딩을 판별해 읽는다 */
async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' } });
  if (!res.ok) throw new Error('페이지를 가져오지 못했습니다 (HTTP ' + res.status + ')');
  const buf = await res.arrayBuffer();
  const dec = enc => { try { return new TextDecoder(enc).decode(buf); } catch (e) { return null; } };
  const m = (res.headers.get('content-type') || '').match(/charset=["\']?([\w-]+)/i);
  if (m) { const t = dec(m[1]); if (t) return t; }
  const utf = dec('utf-8') || '';
  if ((utf.match(/\uFFFD/g) || []).length > 5) { const t = dec('euc-kr'); if (t) return t; }
  return utf;
}

const TAGRE = /<[^>]+>/g;
function unesc(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
    .replace(/&amp;/g, '&');
}
/** 커리큘럼 행 판별 — "12:34" 같은 시간 표기 또는 "3강"으로 시작하는 줄 */
const LEC_LINE = /\d{1,2}:\d{2}|^\d{1,3}\s*강[\s.]/;

function extractCurriculum(html) {
  html = String(html).replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const lines = [];
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    let text = cells.map(function (c) { return c.replace(TAGRE, ' '); }).join(' ');
    text = unesc(text.replace(/\s+/g, ' ')).trim();
    if (text && LEC_LINE.test(text)) lines.push(text);
  }
  if (!lines.length) {
    // 표가 아닌 페이지 — 시간 표기가 있는 줄만 건진다
    html.replace(TAGRE, '\n').split('\n').forEach(function (ln) {
      ln = unesc(ln.replace(/\s+/g, ' ')).trim();
      if (ln.length > 6 && /\d{1,2}:\d{2}/.test(ln)) lines.push(ln);
    });
  }
  return lines.join('\n');
}

async function handleSearch(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);
  if (!env.NAVER_ID || !env.NAVER_SECRET) {
    return json({ ok: false, error: '네이버 검색 키가 설정되지 않았습니다' }, 400, origin);
  }
  const q = String(body.q || '').trim();
  if (!q) return json({ ok: false, error: '검색어를 입력해 주세요' }, 400, origin);
  const platform = String(body.platform || '');
  const dom = SEARCH_DOMAINS[platform];
  const query = (dom ? platform + ' ' : '') + q + ' 강좌';

  const res = await fetch(
    'https://openapi.naver.com/v1/search/webkr.json?display=20&query=' + encodeURIComponent(query),
    { headers: { 'X-Naver-Client-Id': env.NAVER_ID, 'X-Naver-Client-Secret': env.NAVER_SECRET } });
  if (!res.ok) return json({ ok: false, error: '네이버 검색 실패 (HTTP ' + res.status + ')' }, 502, origin);
  const d = await res.json();

  const out = [];
  for (const it of (d.items || [])) {
    const link = it.link || '';
    if (!/^https?:\/\//i.test(link)) continue;
    if (dom && link.indexOf(dom) < 0) continue;      // 고른 플랫폼 도메인만 남긴다
    out.push({
      title: unesc(String(it.title || '').replace(TAGRE, '')).replace(/\s+/g, ' ').trim(),
      url: link,
      desc: unesc(String(it.description || '').replace(TAGRE, '')).replace(/\s+/g, ' ').trim().slice(0, 120)
    });
  }
  // 강좌 상세 페이지일 가능성이 큰 주소를 위로
  out.sort(function (a, b) {
    const A = /detail|chr_cd|lecture/i.test(a.url) ? 0 : 1;
    const B = /detail|chr_cd|lecture/i.test(b.url) ? 0 : 1;
    return A - B;
  });
  return json({ ok: true, items: out.slice(0, 8) }, 200, origin);
}

async function handleCurriculum(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);
  const url = publicUrlOrNull(body.url);
  if (!url) return json({ ok: false, error: '주소가 올바르지 않습니다' }, 400, origin);
  let html;
  try { html = await fetchPage(url); }
  catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 502, origin); }
  const text = extractCurriculum(html);
  if (!text) {
    return json({ ok: true, text: '', count: 0,
      hint: '강의 목록을 찾지 못했습니다. 로그인이 필요하거나 자바스크립트로 그려지는 페이지일 수 있어요 — 사이트에서 목차를 복사해 붙여넣어 주세요.' }, 200, origin);
  }
  return json({ ok: true, text: text, count: text.split('\n').length }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const parentSameOrigin = url.pathname === '/parent-portal' && origin === url.origin;
    const okOrigin = parentSameOrigin || !allowed.length || allowed.includes(origin) ? (origin || '*') : null;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(okOrigin || 'null') });
    }
    if (url.pathname === '/health') {
      return json({ ok: true, now: Date.now() }, 200, okOrigin);
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'POST만 허용' }, 405, okOrigin);
    if (okOrigin === null) return json({ ok: false, error: '허용되지 않은 출처' }, 403, '*');

    let body;
    try { body = await request.json(); }
    catch (e) { return json({ ok: false, error: '본문을 읽을 수 없습니다' }, 400, okOrigin); }

    const app = String(body.app || '');
    if (!APPS.includes(app)) return json({ ok: false, error: 'app은 task 또는 consult' }, 400, okOrigin);

    try {
      if (url.pathname === '/sync')   return await handleSync(env, app, body, okOrigin);
      if (url.pathname === '/token')  return await handleToken(env, app, body, okOrigin);
      if (url.pathname === '/bootstrap') return await handleBootstrap(env, app, body, okOrigin);
      if (url.pathname === '/exchange') return await handleExchange(env, app, body, okOrigin);
      if (url.pathname === '/handoff') return await handleHandoff(env, app, body, okOrigin);
      if (url.pathname === '/admin-handoff') return await handleAdminHandoff(env, app, body, okOrigin);
      if (url.pathname === '/admin-account') return await handleAdminAccount(env, app, body, okOrigin);
      if (url.pathname === '/admin-login') return await handleAdminLogin(env, app, body, okOrigin);
      if (url.pathname === '/revoke') return await handleRevoke(env, app, body, okOrigin);
      if (url.pathname === '/staff-deactivate') return await handleStaffDeactivate(env, app, body, okOrigin);
      if (url.pathname === '/lesson-create') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleLessonCreate(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/contact-log') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleContactLog(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/lesson-assignment-request') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleLessonAssignmentRequest(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/lesson-assignment-review') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleLessonAssignmentReview(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/feedback-request') return await handleFeedbackRequest(env, app, body, okOrigin);
      if (url.pathname === '/feedback-review') return await handleFeedbackReview(env, app, body, okOrigin);
      if (url.pathname === '/parent-feedback-send') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleParentFeedbackSend(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/guardian-contact') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleGuardianContact(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/roster') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleRoster(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-issue') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookIssue(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/transport') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleTransport(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/onboarding-patch') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleOnboardingPatch(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/parent-portal') {
        const authenticatedActions = new Set([
          'invite', 'access_list', 'access_set', 'preview',
          'publication_list', 'publication_set', 'request_list', 'request_resolve',
          'announcement_list', 'announcement_save', 'announcement_publish', 'announcement_end'
        ]);
        const action = String(body.action || '');
        if (!authenticatedActions.has(action) && !parentSameOrigin) {
          return json({ ok: false, error: '보호자 앱과 같은 출처에서만 사용할 수 있습니다' }, 403, okOrigin);
        }
        const auth = authenticatedActions.has(action) ? await resolveAuth(env, app, body.auth) : null;
        return await handleParentPortal(env, app, body, okOrigin, auth, json, request);
      }
      if (url.pathname === '/student-portal') {
        const authenticatedActions = new Set(['access_list', 'access_set', 'invite', 'preview']);
        const action = String(body.action || '');
        if (!authenticatedActions.has(action)) {
          return json({ ok: false, error: '학생 연결 작업은 학생 앱 전용 주소에서만 사용할 수 있습니다' }, 403, okOrigin);
        }
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleStudentPortal(env, app, body, okOrigin, auth, json, request);
      }
      if (url.pathname === '/makeup') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleMakeup(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/session-pack') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleSessionPack(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/guardian-ops-send') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleGuardianOpsSend(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/lesson-change-request') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleLessonChangeRequest(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/lesson-change-review') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleLessonChangeReview(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/director-report-send') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleDirectorReportSend(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-order-send') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookOrderSend(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-order') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookOrderCreate(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-add-request') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookAddRequest(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-add-review') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookAddReview(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-edit-request') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookEditRequest(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-edit-review') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookEditReview(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/search') return await handleSearch(env, app, body, okOrigin);
      if (url.pathname === '/curriculum') return await handleCurriculum(env, app, body, okOrigin);
      return json({ ok: false, error: '없는 경로' }, 404, okOrigin);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500, okOrigin);
    }
  }
};
