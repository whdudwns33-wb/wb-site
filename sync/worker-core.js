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
 *   POST /lesson-create { app, auth, staffId?, lesson } → 수업 1건 등록·수정
 *   POST /lesson-create-batch { app, auth, batchKind, lessons } → 한 학생의 여러 수업 또는 같은 수업의 여러 학생 원자적 등록
 *   POST /contact-log { app, auth, sourceTaskId, type, note } → 담당 수업 학생 연락 기록
 *   POST /staff-attendance { app, auth, action } → 본인 출근·퇴근을 서버 시각으로 최초 1회 기록
 *   POST /weekend-visit { app, auth, action, ... } → 토·일 실제 등·하원 기록
 *   POST /lesson-handoff { app, auth, dataGeneration, action, ... } → 당일 남은 수업 인계
 *   POST /feedback-request { app, auth, ... }     → 직원, 항목별 피드백 제출(제출 즉시 카카오 알림톡 자동 발송 시도)
 *   POST /feedback-review  { app, auth(admin) }   → 원장, 발송 이력·상태 확인(승인 클릭은 더 이상 발송 조건이 아님)
 *   POST /feedback-polish  { app, auth, ... }     → 최종 피드백 코멘트만 글자수 안에서 AI로 완곡하게 정리
 *   POST /parent-feedback-send { app, auth(admin), requestKey } → 막혔던 발송을 원장이 수동으로 재시도
 *   POST /guardian-contact { app, auth(admin), ... } → 원장, 보호자 연락처·발송 동의 등록/조회
 *   POST /lesson-change-request { app, auth, ... } → 직원, 원장이 등록한 지시서에 변경 제안
 *   POST /lesson-change-review  { app, auth(admin) } → 원장, 변경 제안 승인·반려
 *   POST /director-report-send { app, auth, reportDate, staffId? } → 고정된 원장 수신처 카카오 알림톡
 *   POST /book-order-send { app, auth, taskId } → 교재 주문 문자를 거래처에 실제 발송
 *   POST /book-order { app, auth, action:'create'|'cancel'|'cancel_item', ... } → 학생 정체성이 봉인된 주문 생성·취소
 *   POST /book-catalog { app, auth, action:'list'|'review_approve' } → 완료 일반 교재 목록·관리자 후보 확정
 *   POST /book-add-request { app, auth, ... }     → 직원, 새 교재를 교재 목록에 추가해 달라고 신청
 *   POST /book-add-review  { app, auth(admin) }   → 원장, 교재 추가 신청 승인·반려
 *   POST /book-edit-request { app, auth, ... }     → 직원, 기존 교재 정보를 고쳐 달라고 신청
 *   POST /book-edit-review  { app, auth(admin) }   → 원장, 교재 수정 신청 승인·반려
 *   POST /transport { app, auth, action, ... }      → 차량 노선 설정·승하차 상태
 *   POST /staff-deactivate { app, auth(all), staffId, expectedUpdatedAt } → 직원 비활성화 CAS + 링크 해지
 *   POST /onboarding-patch { app, auth, ... }       → 신규 학생 30일 기록 CAS 수정
 *   POST /makeup { app, auth, action, ... }          → 모든 학생의 결석·보강 일정 원장
 *   POST /session-pack { app, auth, action, ... }    → 지정 수업의 회차권·사용 원장
 *   POST /teacher-live-request { app, auth, action, ... } → 담당 선생님→모든 관리자 실시간 요청
 *   POST /tuition-alert { app, auth(admin), action, ... } → 학생 단위 4회제 3회 확정 알림
 *   POST /student-attendance { app, auth, studentId, month? } → 담당 학생 출결 달력·현재 4회 진행
 *   POST /parent-portal { app, action, ... }         → 보호자 초대·공개 수업·정형 요청함
 *   POST /consult-guardian { app:'consult', action, ... } → 컨설팅 리포트 보호자 읽기·확인
 *   POST /consult-curriculum-image multipart(app:'consult', auth, files[]) → 강의 목차 사진 일시 인식
 *   POST /consult-curriculum-url { app:'consult', auth, url } → 공개 강좌 주소 목차 인식
 *   POST /student-portal { app, action, ... }        → 학생 앱 동의·초대·관리자 미리보기
 *   POST /guardian-ops-send { app, auth, action, ... } → 보강·회차 운영 알림톡
 *   POST /consult-link-send { app:'consult', auth(admin), action, ... } → 학생 개인 링크 연락처·알림톡 접수
 *   POST /consult-reward { app:'consult', auth(admin), action, ... } → 문화상품권 교환 선점·상태 원장
 *   POST /revoke    { app, auth(admin), token|staffId } → { ok }
 *
 * 인증
 *   auth = { mode:'admin',  secret }            → 전체 접근
 *   auth = { mode:'admin_device', token }       → 연결된 원장 기기
 *   auth = { mode:'person', id, token }         → 본인 범위(task allowlist 관리 담당은 전체)
 */

import { handleLessonCreate, handleLessonCreateBatch } from './lesson-create.js';
import { handleLessonAssignmentRequest, handleLessonAssignmentReview } from './lesson-assignment-request.js';
import { handleDirectorReportSend } from './director-report-send.js';
import { handleLessonChangeRequest, handleLessonChangeReview } from './lesson-change-request.js';
import { handleBookOrderSend } from './book-order-send.js';
import { handleBookOrderCreate } from './book-order-create.js';
import { handleBookAddRequest, handleBookAddReview } from './book-add-request.js';
import { handleBookEditRequest, handleBookEditReview } from './book-edit-request.js';
import { handleGuardianContact } from './guardian-contact.js';
import {
  handleParentFeedbackSend,
  attemptParentFeedbackSend,
  resolveStudentName,
  feedbackMessageDeliveryState,
  MAX_PARENT_FEEDBACK_COMMENT_CHARS
} from './parent-feedback-send.js';
import { handleFeedbackPolish } from './feedback-polish.js';
import { handleRoster } from './roster.js';
import { handleStudentChange } from './student-change.js';
import { handleAdminDirective } from './admin-directive.js';
import { handleTeacherLiveRequest } from './teacher-live-request.js';
import { handleTuitionAlert, handleStudentAttendance } from './tuition-alert.js';
import { handleBookIssue } from './book-issue.js';
import { handleBookCatalog } from './completed-book-catalog.js';
import { handleTransport } from './transport.js';
import { handleOnboardingPatch } from './onboarding.js';
import { handleParentPortal } from './parent-portal.js';
import { handleStudentPortal } from './student-portal.js';
import { handleMakeup } from './makeup.js';
import { handleSessionPack } from './session-pack.js';
import { handleGuardianOpsSend } from './guardian-ops-send.js';
import { handleContactLog } from './contact-log.js';
import { handleStaffAttendance, inspectOwnStaffAttendanceChanges } from './staff-attendance.js';
import { handleWeekendVisit } from './weekend-visit.js';
import { handleLessonHandoff } from './lesson-handoff.js';
import { handleConsultSubmission, handleConsultSubmissionUpload } from './consult-submission.js';
import { handleConsultGuardian } from './consult-guardian.js';
import { handleConsultResults, handleConsultResultUpload } from './consult-results.js';
import { handleConsultCurriculumImage, isConsultDirectorOrManager } from './consult-curriculum-image.js';
import { handleConsultLinkSend } from './consult-link-send.js';

const APPS = ['task', 'consult'];
const MAX_CHANGES = 500;     // 요청당 상한 — D1 배치 한계와 악의적 대량 전송을 함께 막는다
const MAX_PULL = 2000;       // 응답당 상한. 초과하면 more:true로 알리고 다음 요청에서 이어받는다
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_REWARD_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const CONSULT_REWARD_PREFIX = '__rewardtx__';
const CONSULT_REWARD_TAKEOVER_MS = 30 * 60 * 1000;
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

function isRewardProcessingLockError(error) {
  return /REWARD_PROCESSING_LOCK/.test(String(error && error.message || error || ''));
}

function rewardProcessingLockResponse(origin, details) {
  return json(Object.assign({
    ok: false,
    code: 'REWARD_PROCESSING_LOCK',
    error: '문화상품권 교환 처리를 완료하거나 취소한 뒤 학생 삭제·대표·관리자 전환을 진행해 주세요'
  }, details || {}), 409, origin);
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

async function consultRewardActorHash(kind, credentialHash) {
  return tokenStorageValue(await sha256Hex(
    'consult-reward-actor:v1:' + String(kind || '') + ':' + String(credentialHash || '')
  ));
}

async function resolveAuth(env, app, auth) {
  if (!auth || typeof auth !== 'object') return null;
  if (auth.mode === 'admin') {
    const want = app === 'task' ? env.TASK_ADMIN_SECRET : env.CONSULT_ADMIN_SECRET;
    if (!want || !safeEqual(auth.secret, want)) return null;
    return app === 'consult'
      ? { scope: 'all', rewardActorHash: await consultRewardActorHash('admin', await sha256Hex(want)) }
      : { scope: 'all' };
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
    return row && row.staff_id === ADMIN_DEVICE_ID
      ? { scope: 'all', device: true,
        rewardActorHash: await consultRewardActorHash('admin_device', tokenHash) }
      : null;
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
  // 오래 열린 구형 직원 화면도 이미 확정된 출퇴근을 덮지 못한다. 최초 출근 또는
  // 기존 at을 보존한 최초 out 추가만 원자적으로 허용하며 관리자 범위는 이 제한을 받지 않는다.
  const staffAttendanceGuard = ownScope && table === 'checks' && /^__att__/.test(String(key || ''))
    ? " AND (" +
      "(COALESCE(json_extract(checks.data,'$.done'),0)<>1 OR COALESCE(json_extract(checks.data,'$.at'),0)<=0)" +
      " OR (json_extract(checks.data,'$.done')=1 AND COALESCE(json_extract(checks.data,'$.out'),0)=0" +
      " AND json_extract(excluded.data,'$.done')=1" +
      " AND json_extract(excluded.data,'$.at')=json_extract(checks.data,'$.at')" +
      " AND COALESCE(json_extract(excluded.data,'$.out'),0)>=json_extract(checks.data,'$.at'))" +
      ")"
    : '';
  // 검토와 실제 쓰기 사이에 보강 task가 생성되는 경우에도 generic LWW가 덮지 못한다.
  const makeupTaskGuard = table === 'tasks'
    ? " AND COALESCE(CAST(json_extract(tasks.data,'$.lessonInstanceType') AS TEXT),'')<>'makeup'" +
      " AND COALESCE(CAST(json_extract(tasks.data,'$.makeupCaseId') AS TEXT),'')=''"
    : '';
  return env.DB.prepare(
    'INSERT INTO ' + table + ' (app, ' + idCol + ', owner, data, updated_at, srv_at) ' +
    'VALUES (?, ?, ?, ' + insertData + ', ?, ?) ' +
    'ON CONFLICT(app, ' + idCol + ') DO UPDATE SET ' +
    '  owner=excluded.owner, data=' + updateData + ', ' +
    '  updated_at=excluded.updated_at, srv_at=excluded.srv_at ' +
    'WHERE excluded.updated_at > ' + table + '.updated_at' + ownGuard + onboardingGuard +
      staffAttendanceGuard + makeupTaskGuard
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

function hasStructuredLessonMarker(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const lessonFormVersion = Number(data.lessonFormVersion);
  const intakeVersion = Number(data.intakeVersion);
  return data.taskKind === 'lesson_instruction' ||
    (Number.isInteger(lessonFormVersion) && lessonFormVersion >= 1) ||
    (Number.isInteger(intakeVersion) && intakeVersion >= 1);
}

function isProtectedLessonTaskData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return hasStructuredLessonMarker(data) ||
    Object.prototype.hasOwnProperty.call(data, 'lessonFormVersion') ||
    Object.prototype.hasOwnProperty.call(data, 'intakeVersion') ||
    String(data.studentId || '').trim() !== '' ||
    /^\s*\[(?:수업|컨설팅)\]/.test(String(data.title || ''));
}

function isScheduledMakeupTaskData(data) {
  return !!(data && typeof data === 'object' && !Array.isArray(data) &&
    (String(data.lessonInstanceType || '') === 'makeup' || String(data.makeupCaseId || '').trim()));
}

/**
 * 보강 수업 task는 makeup_cases의 서버 투영본이다. 서버 행이 이미 있으면 로컬 사본의
 * 시각·revision·내용과 무관하게 무시하고, 이 sync 응답의 pull 정본으로 교체하게 한다.
 */
async function inspectScheduledMakeupTaskChanges(env, app, entries) {
  if (app !== 'task') return { skip: new Set(), forced: [] };
  const taskEntries = entries.filter(entry => entry.table === 'tasks' && entry.change);
  if (!taskEntries.length) return { skip: new Set(), forced: [] };

  const ids = [...new Set(taskEntries.map(entry => String(entry.change.id || '')).filter(Boolean))];
  const currentById = new Map();
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await env.DB.prepare(
      'SELECT id,owner,data,updated_at,srv_at FROM tasks WHERE app=? AND id IN (' + placeholders + ')'
    ).bind(app, ...chunk).all();
    for (const row of result.results || []) currentById.set(String(row.id), row);
  }

  const skip = new Set();
  const forcedById = new Map();
  for (const entry of taskEntries) {
    const stored = currentById.get(String(entry.change.id || ''));
    let current = null;
    try { current = stored == null ? null : JSON.parse(stored.data); } catch (error) { current = null; }
    if (isScheduledMakeupTaskData(current)) {
      skip.add(entry);
      if (!forcedById.has(String(entry.change.id || ''))) {
        const row = stored;
        forcedById.set(String(entry.change.id || ''), {
          table: 'tasks', key: String(entry.change.id || ''), owner: row.owner, data: current,
          updated_at: row.updated_at, srv_at: row.srv_at, authoritative: true
        });
      }
      continue;
    }
    if (isScheduledMakeupTaskData(entry.change.data)) {
      return { error: '보강수업은 보강 탭의 생성·완료·없음 기능으로만 변경할 수 있습니다' };
    }
  }
  return { skip, forced: [...forcedById.values()] };
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
  const protectedDeliveries = new Set([
    'scheduled_batch_v1', 'manual_online_v1', 'bound_print_v1', 'internal_book_v1'
  ]);
  const scheduled = entries.filter(entry => entry.table === 'tasks' && entry.change &&
    entry.change.data && protectedDeliveries.has(String(entry.change.data.orderDelivery || '')));
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
    return !row || !current || current.orderDelivery !== entry.change.data.orderDelivery ||
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
      if (isProtectedLessonTaskData(data)) {
        return { error: '학생 수업은 전용 수업 등록·승인 화면에서만 저장할 수 있습니다' };
      }
      if (data.origin !== 'staff') {
        return { error: '개인 링크에서는 직원이 직접 만든 업무만 새로 등록할 수 있습니다' };
      }
      newTaskIds.add(id);
      continue;
    }
    let currentData;
    try { currentData = JSON.parse(current.data); } catch (error) { currentData = null; }
    if (isProtectedLessonTaskData(currentData) || isProtectedLessonTaskData(data)) {
      if (sameTaskJson(current.data, data)) {
        skip.add(entry);
        continue;
      }
      return { error: '학생 수업은 전용 수업 등록·승인 화면에서만 변경할 수 있습니다' };
    }
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
  if (!checkEntries.length) return { error: null, skip: new Set() };
  const generalTaskIds = [];

  for (const entry of checkEntries) {
    const key = String(entry.change.k || '');
    const firstPipe = key.indexOf('|');
    if (firstPipe <= 0 || firstPipe !== key.lastIndexOf('|') || firstPipe === key.length - 1) {
      return { error: '체크 키 형식을 확인해 주세요', skip: new Set() };
    }
    const keyTaskId = key.slice(0, firstPipe);
    const keyDate = key.slice(firstPipe + 1);
    const data = entry.change.data;
    if (app === 'consult' && keyTaskId.startsWith(CONSULT_REWARD_PREFIX)) {
      return { error: '보상 교환 기록은 전용 원장에서만 변경할 수 있습니다', skip: new Set() };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { error: '체크 데이터 형식을 확인해 주세요', skip: new Set() };
    }
    if (Object.prototype.hasOwnProperty.call(data, 'taskId') && String(data.taskId) !== keyTaskId) {
      return { error: '체크 데이터의 taskId가 체크 키와 일치하지 않습니다', skip: new Set() };
    }
    if (Object.prototype.hasOwnProperty.call(data, 'date') && String(data.date) !== keyDate) {
      return { error: '체크 데이터의 날짜가 체크 키와 일치하지 않습니다', skip: new Set() };
    }

    const special = keyTaskId.match(/^__[A-Za-z]+__(.+)$/);
    if (special) {
      if (special[1] !== owner) return { error: '다른 담당자의 특수 체크는 저장할 수 없습니다', skip: new Set() };
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
    return { error: '본인에게 배정된 업무의 체크만 저장할 수 있습니다', skip: new Set() };
  }
  return await inspectOwnStaffAttendanceChanges(env, app, owner, checkEntries);
}

function checkIdentityFromKey(value) {
  const key = String(value || '');
  const pipe = key.indexOf('|');
  if (pipe <= 0 || pipe !== key.lastIndexOf('|') || pipe === key.length - 1) return null;
  const taskId = key.slice(0, pipe);
  const date = key.slice(pipe + 1);
  return SAFE_ID.test(taskId) && validIsoDate(date) ? { key, taskId, date } : null;
}

function session4AttendanceLockedAt(date, now) {
  const kst = new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString();
  const today = kst.slice(0, 10);
  return date < today || (date === today && kst.slice(11, 19) >= '23:50:00');
}

function attendanceValue(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !Object.prototype.hasOwnProperty.call(data, 'att') || data.att == null) return '';
  return String(data.att);
}

function makeupHistoryAllowsSessionLock(value) {
  let history;
  try { history = JSON.parse(value || '[]'); } catch (error) { return false; }
  const first = Array.isArray(history) && history[0] && typeof history[0] === 'object'
    ? history[0] : null;
  return !!(first && (first.action === 'create_from_absence' ||
    (first.action === 'create_manual' && first.reason === 'manual_absence')));
}

function makeupHistoryHasCompletion(value) {
  let history;
  try { history = JSON.parse(value || '[]'); } catch (error) { return false; }
  const last = Array.isArray(history) && history.length ? history[history.length - 1] : null;
  return !!(last && typeof last === 'object' && last.action === 'complete');
}

async function sessionAttendanceEventKeys(env, app, keys) {
  const found = new Set();
  for (let offset = 0; offset < keys.length; offset += 80) {
    const chunk = keys.slice(offset, offset + 80);
    const result = await env.DB.prepare(
      'SELECT check_key FROM student_session_attendance_events WHERE app=? AND check_key IN (' +
        chunk.map(() => '?').join(',') + ')'
    ).bind(app, ...chunk).all();
    for (const row of result.results || []) found.add(String(row.check_key));
  }
  return found;
}

async function currentCheckStates(env, app, keys) {
  const current = new Map();
  for (let offset = 0; offset < keys.length; offset += 80) {
    const chunk = keys.slice(offset, offset + 80);
    const result = await env.DB.prepare(
      'SELECT k,owner,data,updated_at,srv_at FROM checks WHERE app=? AND k IN (' +
        chunk.map(() => '?').join(',') + ')'
    ).bind(app, ...chunk).all();
    for (const row of result.results || []) {
      let data;
      try { data = JSON.parse(row.data || '{}'); } catch (error) { data = null; }
      current.set(String(row.k), { data, updatedAt: Number(row.updated_at) || 0 });
    }
  }
  return current;
}

async function changesLockedAttendance(env, app, candidates) {
  if (!candidates.length) return false;
  const keys = [...new Set(candidates.map(item => item.identity.key))];
  const current = await currentCheckStates(env, app, keys);
  for (const item of candidates) {
    const incoming = attendanceValue(item.entry.change.data);
    const stored = current.get(item.identity.key);
    const previous = stored ? attendanceValue(stored.data) : '';
    // LWW가 실제로 적용하지 않을 오래된 오프라인 재전송은 전체 sync를 실패시키지 않는다.
    const actuallyNewer = stored && (Number(item.entry.change.updated_at) || 0) > stored.updatedAt;
    if ((stored && actuallyNewer && incoming !== previous) ||
        (!current.has(item.identity.key) && incoming !== '')) return true;
  }
  return false;
}

/**
 * 구형·오프라인 화면도 23:50 이후 확정된 회차제 출결만큼은 다시 쓰지 못하게 한다.
 * taskId/studentId/check key의 stable ID 연결로만 판정하고 이름은 전혀 사용하지 않는다.
 */
async function inspectLockedSession4AttendanceChanges(env, app, entries, now) {
  if (app !== 'task') return { locked: false };
  const candidates = entries.map(entry => ({ entry, identity: entry.table === 'checks'
    ? checkIdentityFromKey(entry.change && entry.change.k) : null
  })).filter(item => item.identity && item.entry.change && item.entry.change.data &&
    typeof item.entry.change.data === 'object' && !Array.isArray(item.entry.change.data));
  if (!candidates.length) return { locked: false };

  // 원장에 이미 사용 근거가 들어간 check는 이후 학생 설정·보강 상태가 바뀌더라도 정본이다.
  // 동일 att의 메모 수정과 LWW상 무시될 stale replay만 허용한다.
  const candidateKeys = [...new Set(candidates.map(item => item.identity.key))];
  const eventKeys = await sessionAttendanceEventKeys(env, app, candidateKeys);
  const eventCandidates = candidates.filter(item => eventKeys.has(item.identity.key));
  if (await changesLockedAttendance(env, app, eventCandidates)) return { locked: true };

  const taskIds = [...new Set(candidates.map(item => item.identity.taskId))];
  const tasks = new Map();
  const storedTaskVersions = new Map();
  const registerTask = (row, data) => {
    if (!data || String(data.id || '') !== String(row.id || '') ||
        String(data.staffId || '') !== String(row.owner || '') ||
        !SAFE_ID.test(String(data.studentId || '')) || !hasStructuredLessonMarker(data)) return;
    const makeupCaseId = String(data.makeupCaseId || '').trim();
    const isMakeup = String(data.lessonInstanceType || '') === 'makeup' || !!makeupCaseId;
    if (isMakeup && (String(data.lessonInstanceType || '') !== 'makeup' ||
        !SAFE_ID.test(makeupCaseId) || String(row.id) !== 'makeup_lesson_' + makeupCaseId)) return;
    tasks.set(String(row.id), { owner: String(row.owner || ''), data,
      kind: isMakeup ? 'makeup' : 'regular', makeupCaseId });
  };
  for (let offset = 0; offset < taskIds.length; offset += 80) {
    const chunk = taskIds.slice(offset, offset + 80);
    const result = await env.DB.prepare(
      'SELECT id,owner,data,updated_at,srv_at FROM tasks WHERE app=? AND id IN (' +
        chunk.map(() => '?').join(',') + ')'
    ).bind(app, ...chunk).all();
    for (const row of result.results || []) {
      storedTaskVersions.set(String(row.id), Number(row.updated_at) || 0);
      let data;
      try { data = JSON.parse(row.data || '{}'); } catch (error) { continue; }
      registerTask(row, data);
    }
  }

  // 새 수업 task와 과거 check가 같은 all-scope batch에 들어오면 DB 조회만으로는 task를
  // 찾을 수 없다. 실제 LWW 결과가 될 batch task를 합쳐 check가 먼저 와도 선검증한다.
  const incomingTasks = new Map();
  for (const entry of entries) {
    if (entry.table !== 'tasks' || !entry.change || !taskIds.includes(String(entry.change.id || ''))) continue;
    const id = String(entry.change.id || '');
    const updatedAt = Number(entry.change.updated_at) || 0;
    const prior = incomingTasks.get(id);
    if (!prior || updatedAt > prior.updatedAt) incomingTasks.set(id, { entry, updatedAt });
  }
  for (const [id, incoming] of incomingTasks) {
    if (storedTaskVersions.has(id) && incoming.updatedAt <= storedTaskVersions.get(id)) continue;
    registerTask({ id, owner: incoming.entry.change.owner }, incoming.entry.change.data);
  }

  const makeupCaseIds = [...new Set([...tasks.values()]
    .filter(task => task.kind === 'makeup').map(task => task.makeupCaseId))];
  const makeupCases = new Map();
  for (let offset = 0; offset < makeupCaseIds.length; offset += 80) {
    const chunk = makeupCaseIds.slice(offset, offset + 80);
    const result = await env.DB.prepare(
      'SELECT case_id,student_id,status,confirmed_start_at,confirmed_end_at,confirmed_staff_id,' +
      'completed_at,completed_by,history ' +
      'FROM makeup_cases WHERE app=? AND case_id IN (' + chunk.map(() => '?').join(',') + ')'
    ).bind(app, ...chunk).all();
    for (const row of result.results || []) makeupCases.set(String(row.case_id), row);
  }
  const lessonCandidates = candidates.filter(item => {
    const task = tasks.get(item.identity.taskId);
    if (!task) return false;
    const date = item.identity.date;
    if ((task.data.start && date < String(task.data.start)) ||
        (task.data.end && date > String(task.data.end))) return false;
    if (task.data.deleted && !validIsoDate(String(task.data.end || ''))) return false;
    if (task.kind === 'makeup') {
      const makeup = makeupCases.get(task.makeupCaseId);
      const status = String(makeup && makeup.status || '');
      const statusAllowsDate = status === 'confirmed'
        ? String(makeup.confirmed_start_at || '').slice(0, 10) === date &&
          String(makeup.confirmed_end_at || '').slice(0, 10) === date
        : status === 'completed' && Number(makeup.completed_at) > 0 &&
          SAFE_ID.test(String(makeup.completed_by || '')) && makeupHistoryHasCompletion(makeup.history);
      return !!(makeup && statusAllowsDate &&
        String(makeup.student_id || '') === String(task.data.studentId || '') &&
        String(makeup.confirmed_staff_id || '') === task.owner &&
        String(task.data.start || '') === date && String(task.data.end || '') === date &&
        makeupHistoryAllowsSessionLock(makeup.history));
    }
    return true;
  });
  if (!lessonCandidates.length) return { locked: false };

  const rosterRow = await env.DB.prepare("SELECT data FROM private_rosters WHERE app='task' LIMIT 1").first();
  let roster;
  try { roster = JSON.parse(rosterRow && rosterRow.data || '{}'); } catch (error) { roster = null; }
  const students = roster && roster.roster && Array.isArray(roster.roster.students)
    ? roster.roster.students : [];
  const sessionStarts = new Map();
  for (const student of students) {
    const studentId = String(student && student.id || '');
    const start = String(student && student.sessionCycleStartDate || '');
    if (!SAFE_ID.test(studentId) || student && student.billingMode !== 'session4' || !validIsoDate(start) ||
        sessionStarts.has(studentId)) continue;
    sessionStarts.set(studentId, start);
  }

  const lockedCandidates = lessonCandidates.filter(item => {
    const task = tasks.get(item.identity.taskId);
    const start = sessionStarts.get(String(task && task.data.studentId || ''));
    return start && item.identity.date >= start && session4AttendanceLockedAt(item.identity.date, now);
  });
  if (!lockedCandidates.length) return { locked: false };
  return { locked: await changesLockedAttendance(env, app, lockedCandidates) };
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

async function consultRewardStaffConflicts(env, app, entries) {
  if (app !== 'consult') return [];
  const ids = [...new Set(entries.filter(entry => entry.table === 'staff')
    .filter(entry => {
      const data = entry.change && entry.change.data;
      return data && typeof data === 'object' && !Array.isArray(data) &&
        (data.deleted === true || data.owner === true || data.manager === true);
    })
    .map(entry => String(entry.change.id || ''))
    .filter(id => SAFE_ID.test(id)))];
  if (!ids.length) return [];
  const conflicts = new Set();
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await env.DB.prepare(
      'SELECT DISTINCT owner FROM checks WHERE app=? AND owner IN (' + placeholders + ') ' +
      "AND k GLOB '__rewardtx__*' AND json_valid(data)=1 " +
      "AND json_extract(data,'$.kind')='consult_reward_redemption' " +
      "AND json_extract(data,'$.staffId')=owner AND json_extract(data,'$.status')='processing'"
    ).bind('consult', ...chunk).all();
    for (const row of result.results || []) conflicts.add(String(row.owner || ''));
  }
  return ids.filter(id => conflicts.has(id));
}

async function consultRewardLockDetails(env, app, staffIds) {
  const ids = [...new Set((staffIds || []).map(id => String(id || '')).filter(id => SAFE_ID.test(id)))];
  if (app !== 'consult' || !ids.length) return {};
  const authoritativeStaff = [];
  const authoritativeRewardChecks = [];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await env.DB.prepare(
      'SELECT id,owner,data,updated_at,srv_at FROM staff WHERE app=? AND id IN (' + placeholders + ')'
    ).bind('consult', ...chunk).all();
    for (const row of result.results || []) {
      let data;
      try { data = JSON.parse(row.data || '{}'); }
      catch (error) { continue; }
      authoritativeStaff.push({
        table: 'staff', key: String(row.id || ''), owner: row.owner == null ? null : String(row.owner),
        data, updated_at: Number(row.updated_at) || 0, srv_at: Number(row.srv_at) || 0,
        authoritative: true
      });
    }
    const rewardResult = await env.DB.prepare(
      'SELECT k,owner,data,updated_at,srv_at FROM checks WHERE app=? AND owner IN (' + placeholders + ') ' +
      "AND json_valid(data)=1 AND json_extract(data,'$.kind')='consult_reward_redemption' " +
      "AND json_extract(data,'$.staffId')=owner AND json_extract(data,'$.status')='processing'"
    ).bind('consult', ...chunk).all();
    for (const row of rewardResult.results || []) {
      let data;
      try { data = JSON.parse(row.data || '{}'); }
      catch (error) { continue; }
      if (String(row.k || '') !== consultRewardKey(String(row.owner || ''), String(data.requestId || ''))) continue;
      delete data.claimActorHash;
      authoritativeRewardChecks.push({
        table: 'checks', key: String(row.k || ''), owner: row.owner == null ? null : String(row.owner),
        data, updated_at: Number(row.updated_at) || 0, srv_at: Number(row.srv_at) || 0,
        authoritative: true
      });
    }
  }
  return { conflictStaffIds: ids, authoritativeStaff, authoritativeRewardChecks };
}

function consultRewardKey(staffId, requestId) {
  return CONSULT_REWARD_PREFIX + staffId + '|' + requestId;
}

function parseConsultRewardRow(row, key, staffId, requestId) {
  if (!row || String(row.owner || '') !== staffId) return null;
  let data;
  try { data = JSON.parse(row.data || '{}'); }
  catch (error) { return null; }
  const status = String(data && data.status || '');
  if (!data || data.kind !== 'consult_reward_redemption' || Number(data.version) !== 1 ||
      data.staffId !== staffId || data.requestId !== requestId ||
      !['processing', 'fulfilled', 'cancelled'].includes(status)) return null;
  const claimActorHash = String(data.claimActorHash || '');
  if (!/^sha256:[0-9a-f]{64}$/.test(claimActorHash)) return null;
  const claimedAt = Number(data.claimedAt) || 0;
  const updatedAt = Number(data.updatedAt) || Number(row.updated_at) || 0;
  if (!claimedAt || !updatedAt) return null;
  return { key, status, claimedAt, updatedAt, data, dbUpdatedAt: Number(row.updated_at) || 0 };
}

async function readConsultReward(env, key, staffId, requestId) {
  const row = await env.DB.prepare(
    'SELECT owner,data,updated_at FROM checks WHERE app=? AND k=? LIMIT 1'
  ).bind('consult', key).first();
  return parseConsultRewardRow(row, key, staffId, requestId);
}

function consultRewardPayload(record, extra) {
  return Object.assign({
    ok: true,
    key: record.key,
    status: record.status,
    claimedAt: record.claimedAt,
    takenOverAt: Number(record.data.takenOverAt) || 0,
    updatedAt: record.updatedAt
  }, extra || {});
}

async function handleConsultReward(env, app, body, origin, auth) {
  if (app !== 'consult') {
    return json({ ok: false, error: '컨설팅 앱에서만 사용할 수 있습니다' }, 400, origin);
  }
  if (!auth || auth.scope !== 'all' || auth.device !== true ||
      !/^sha256:[0-9a-f]{64}$/.test(String(auth.rewardActorHash || ''))) {
    return json({ ok: false, code: 'ADMIN_DEVICE_REQUIRED',
      error: '원장 기기 로그인을 다시 연결한 뒤 문화상품권 교환을 처리해 주세요' }, 403, origin);
  }
  const action = String(body.action || '');
  if (!['claim', 'reject', 'takeover', 'fulfill', 'cancel'].includes(action)) {
    return json({ ok: false, error: 'action은 claim, reject, takeover, fulfill 또는 cancel이어야 합니다' }, 400, origin);
  }
  const allowedKeys = new Set(['app', 'auth', 'action', 'staffId', 'requestId']);
  if (Object.keys(body || {}).some(key => !allowedKeys.has(key))) {
    return json({ ok: false, error: '상품권 코드, URL 또는 지원하지 않는 값은 받을 수 없습니다' }, 400, origin);
  }
  const staffId = String(body.staffId || '');
  const requestId = String(body.requestId || '');
  if (!SAFE_ID.test(staffId)) {
    return json({ ok: false, error: '올바른 학생 ID가 필요합니다' }, 400, origin);
  }
  if (!SAFE_REWARD_REQUEST_ID.test(requestId)) {
    return json({ ok: false, error: '교환 요청 ID는 8~128자 영문, 숫자, _, -만 사용할 수 있습니다' }, 400, origin);
  }
  const key = consultRewardKey(staffId, requestId);
  if (action === 'reject') {
    const existing = await readConsultReward(env, key, staffId, requestId);
    if (existing) {
      if (existing.status === 'cancelled') {
        return json(consultRewardPayload(existing, { changed: false, owned: false }), 200, origin);
      }
      return json({ ok: false, error: '이미 처리 중이거나 지급 완료한 교환 신청은 접수 취소로 바꿀 수 없습니다' }, 409, origin);
    }
    const student = await activeStaffData(env, 'consult', staffId);
    if (!student || String(student.id || '') !== staffId || student.owner || student.manager) {
      return json({ ok: false, error: '활성 컨설팅 학생을 찾을 수 없습니다' }, 404, origin);
    }
    const stamp = Date.now();
    const data = {
      kind: 'consult_reward_redemption', version: 1, ledgerVersion: 'v1',
      staffId, requestId, status: 'cancelled', claimActorHash: auth.rewardActorHash,
      claimedAt: stamp, rejectedAt: stamp, cancelledAt: stamp, updatedAt: stamp
    };
    const requestKey = '__pointrequest__' + staffId + '|all';
    const inserted = await env.DB.prepare(
      'INSERT OR IGNORE INTO checks(app,k,owner,data,updated_at,srv_at) ' +
      'SELECT ?,?,?,?,?,? WHERE EXISTS (' +
      ' SELECT 1 FROM checks request_row, json_each(request_row.data, \'$.requests\') request_item' +
      ' WHERE request_row.app=? AND request_row.k=? AND request_row.owner=?' +
      " AND json_extract(request_item.value,'$.id')=?" +
      " AND json_extract(request_item.value,'$.status')='requested'" +
      " AND COALESCE(json_extract(request_item.value,'$.cancelledAt'),0)=0" +
      " AND COALESCE(json_extract(request_item.value,'$.requestedAt'),0)>0" +
      ') AND EXISTS (' +
      ' SELECT 1 FROM staff student_row WHERE student_row.app=? AND student_row.id=?' +
      " AND json_valid(student_row.data)=1 AND json_extract(student_row.data,'$.id')=?" +
      " AND COALESCE(json_extract(student_row.data,'$.deleted'),0)=0" +
      " AND COALESCE(json_extract(student_row.data,'$.owner'),0)=0" +
      " AND COALESCE(json_extract(student_row.data,'$.manager'),0)=0" +
      ')'
    ).bind(
      'consult', key, staffId, JSON.stringify(data), stamp, stamp,
      'consult', requestKey, staffId, requestId,
      'consult', staffId, staffId
    ).run();
    const record = await readConsultReward(env, key, staffId, requestId);
    if (record && record.status === 'cancelled') {
      return json(consultRewardPayload(record, {
        changed: Number(inserted && inserted.meta && inserted.meta.changes || 0) === 1,
        owned: false
      }), 200, origin);
    }
    if (record) return json({ ok: false, error: '다른 원장 기기에서 교환 처리를 먼저 시작했습니다' }, 409, origin);
    return json({ ok: false, error: '유효한 교환 신청을 찾을 수 없습니다' }, 409, origin);
  }

  if (action === 'claim') {
    // 한 번 생성된 원장 행은 이후 학생 상태나 신청 취소와 무관하게 권위가 있다.
    const existing = await readConsultReward(env, key, staffId, requestId);
    if (existing) {
      const owned = existing.status === 'processing' && safeEqual(existing.data.claimActorHash, auth.rewardActorHash);
      return json(consultRewardPayload(existing, { claimed: owned, owned, resumed: owned }), 200, origin);
    }
    const student = await activeStaffData(env, 'consult', staffId);
    if (!student || String(student.id || '') !== staffId || student.owner || student.manager) {
      return json({ ok: false, error: '활성 컨설팅 학생을 찾을 수 없습니다' }, 404, origin);
    }
    const stamp = Date.now();
    const data = {
      kind: 'consult_reward_redemption', version: 1,
      ledgerVersion: 'v1',
      staffId, requestId, status: 'processing',
      claimActorHash: auth.rewardActorHash,
      claimedAt: stamp, updatedAt: stamp
    };
    const requestKey = '__pointrequest__' + staffId + '|all';
    const rewardPrefix = CONSULT_REWARD_PREFIX + staffId + '|';
    const inserted = await env.DB.prepare(
      'INSERT OR IGNORE INTO checks(app,k,owner,data,updated_at,srv_at) ' +
      'SELECT ?,?,?,?,?,? WHERE EXISTS (' +
      ' SELECT 1 FROM checks request_row, json_each(request_row.data, \'$.requests\') request_item' +
      ' WHERE request_row.app=? AND request_row.k=? AND request_row.owner=?' +
      " AND json_extract(request_item.value,'$.id')=?" +
      " AND json_extract(request_item.value,'$.status')='requested'" +
      " AND COALESCE(json_extract(request_item.value,'$.cancelledAt'),0)=0" +
      " AND COALESCE(json_extract(request_item.value,'$.requestedAt'),0)>0" +
      ') AND EXISTS (' +
      ' SELECT 1 FROM staff student_row WHERE student_row.app=? AND student_row.id=?' +
      " AND json_valid(student_row.data)=1 AND json_extract(student_row.data,'$.id')=?" +
      " AND COALESCE(json_extract(student_row.data,'$.deleted'),0)=0" +
      " AND COALESCE(json_extract(student_row.data,'$.owner'),0)=0" +
      " AND COALESCE(json_extract(student_row.data,'$.manager'),0)=0" +
      ') AND NOT EXISTS (' +
      ' SELECT 1 FROM checks reward_row WHERE reward_row.app=? AND reward_row.owner=?' +
      ' AND substr(reward_row.k,1,?)=? AND json_valid(reward_row.data)=1' +
      " AND json_extract(reward_row.data,'$.kind')='consult_reward_redemption'" +
      " AND json_extract(reward_row.data,'$.staffId')=?" +
      " AND json_extract(reward_row.data,'$.status')='processing'" +
      ')'
    ).bind(
      'consult', key, staffId, JSON.stringify(data), stamp, stamp,
      'consult', requestKey, staffId, requestId,
      'consult', staffId, staffId,
      'consult', staffId, rewardPrefix.length, rewardPrefix, staffId
    ).run();
    const record = await readConsultReward(env, key, staffId, requestId);
    if (!record) {
      const processing = await env.DB.prepare(
        "SELECT 1 AS found FROM checks WHERE app=? AND owner=? AND substr(k,1,?)=? " +
        "AND json_valid(data)=1 AND json_extract(data,'$.kind')='consult_reward_redemption' " +
        "AND json_extract(data,'$.staffId')=? AND json_extract(data,'$.status')='processing' LIMIT 1"
      ).bind('consult', staffId, rewardPrefix.length, rewardPrefix, staffId).first();
      return processing
        ? json({ ok: false, code: 'REWARD_ALREADY_PROCESSING', error: '이 학생의 다른 교환 요청을 이미 처리 중입니다' }, 409, origin)
        : json({ ok: false, error: '유효한 교환 신청을 찾을 수 없습니다' }, 409, origin);
    }
    const owned = record.status === 'processing' && safeEqual(record.data.claimActorHash, auth.rewardActorHash);
    const created = Number(inserted && inserted.meta && inserted.meta.changes || 0) === 1;
    return json(consultRewardPayload(record, { claimed: owned, owned, resumed: owned && !created }), 200, origin);
  }

  const current = await readConsultReward(env, key, staffId, requestId);
  if (!current) return json({ ok: false, error: '교환 요청을 찾을 수 없습니다' }, 404, origin);
  const owned = safeEqual(current.data.claimActorHash, auth.rewardActorHash);

  if (action === 'takeover') {
    if (current.status !== 'processing') {
      return json({ ok: false, error: '처리 중인 교환만 다른 기기로 인계할 수 있습니다' }, 409, origin);
    }
    if (owned) return json(consultRewardPayload(current, { changed: false, owned: true }), 200, origin);
    const availableAt = current.updatedAt + CONSULT_REWARD_TAKEOVER_MS;
    if (Date.now() < availableAt) {
      return json({ ok: false, code: 'REWARD_TAKEOVER_NOT_READY', availableAt,
        error: '처리 시작 또는 최근 인계 후 30분이 지나야 다른 원장 기기로 인계할 수 있습니다' }, 409, origin);
    }
    const stamp = Math.max(Date.now(), current.updatedAt + 1);
    const data = Object.assign({}, current.data, {
      claimActorHash: auth.rewardActorHash,
      takenOverAt: stamp,
      updatedAt: stamp
    });
    const changed = await env.DB.prepare(
      "UPDATE checks SET data=?,updated_at=?,srv_at=? WHERE app=? AND k=? AND owner=? AND updated_at=? " +
      "AND json_extract(data,'$.status')='processing' AND json_extract(data,'$.claimActorHash')=?"
    ).bind(JSON.stringify(data), stamp, stamp, 'consult', key, staffId, current.dbUpdatedAt,
      current.data.claimActorHash).run();
    const latest = await readConsultReward(env, key, staffId, requestId);
    if (latest && latest.status === 'processing' && safeEqual(latest.data.claimActorHash, auth.rewardActorHash)) {
      return json(consultRewardPayload(latest, {
        changed: Number(changed && changed.meta && changed.meta.changes || 0) === 1,
        owned: true
      }), 200, origin);
    }
    return json({ ok: false, error: '다른 원장 기기에서 교환 처리를 먼저 인계했습니다' }, 409, origin);
  }

  if (!owned) {
    return json({ ok: false, code: 'REWARD_NOT_OWNER', error: '처리를 선점한 원장 기기에서만 완료하거나 취소할 수 있습니다' }, 403, origin);
  }
  const targetStatus = action === 'fulfill' ? 'fulfilled' : 'cancelled';
  if (current.status === targetStatus) {
    return json(consultRewardPayload(current, { changed: false, owned: true }), 200, origin);
  }
  if (current.status !== 'processing') {
    return json({ ok: false, error: current.status === 'fulfilled'
      ? '지급 완료한 교환은 취소할 수 없습니다'
      : '취소한 교환은 지급 완료로 바꿀 수 없습니다' }, 409, origin);
  }

  const stamp = Math.max(Date.now(), current.updatedAt + 1);
  const data = Object.assign({}, current.data, {
    status: targetStatus,
    updatedAt: stamp,
    [targetStatus === 'fulfilled' ? 'fulfilledAt' : 'cancelledAt']: stamp
  });
  const changed = await env.DB.prepare(
    "UPDATE checks SET data=?,updated_at=?,srv_at=? " +
    "WHERE app=? AND k=? AND owner=? AND updated_at=? AND json_extract(data,'$.status')='processing' " +
    "AND json_extract(data,'$.claimActorHash')=?"
  ).bind(JSON.stringify(data), stamp, stamp, 'consult', key, staffId, current.dbUpdatedAt,
    auth.rewardActorHash).run();
  const latest = await readConsultReward(env, key, staffId, requestId);
  if (!latest) return json({ ok: false, error: '교환 요청 상태를 확인할 수 없습니다' }, 409, origin);
  if (latest.status === targetStatus) {
    return json(consultRewardPayload(latest, {
      changed: Number(changed && changed.meta && changed.meta.changes || 0) === 1,
      owned: safeEqual(latest.data.claimActorHash, auth.rewardActorHash)
    }), 200, origin);
  }
  return json({ ok: false, error: '다른 원장 기기에서 교환 상태가 먼저 변경되었습니다' }, 409, origin);
}

async function handleSync(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);

  let dataGeneration = 0;
  try {
    const generationRow = await env.DB.prepare(
      'SELECT generation FROM app_data_generations WHERE app=? LIMIT 1'
    ).bind(app).first();
    const storedGeneration = Number(generationRow && generationRow.generation);
    dataGeneration = Number.isSafeInteger(storedGeneration) && storedGeneration >= 0 ? storedGeneration : 0;
  } catch (error) {
    // migration 적용 전의 로컬 테스트 DB만 기존 0세대로 호환한다.
    if (!/no such table.*app_data_generations/i.test(String(error && error.message || error))) throw error;
  }
  const requestedGeneration = body.dataGeneration == null ? 0 : Number(body.dataGeneration);
  if (!Number.isSafeInteger(requestedGeneration) || requestedGeneration < 0 || requestedGeneration !== dataGeneration) {
    return json({
      ok: false,
      code: 'DATA_GENERATION_MISMATCH',
      dataGeneration,
      error: '운영 데이터가 새 세대로 전환되었습니다. 기기 캐시를 비운 뒤 다시 동기화합니다'
    }, 409, origin);
  }

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
    // 상품권 교환 원장은 /consult-reward의 선점·CAS만이 쓸 수 있다.
    // 관리 화면이 내려받은 행을 generic LWW로 재전송해도 덮어쓰지 않는다.
    if (t === 'checks' && app === 'consult' && String(c.k || '').startsWith(CONSULT_REWARD_PREFIX)) {
      if (auth.scope === 'own') {
        return json({ ok: false, code: 'REWARD_TX_ENDPOINT_REQUIRED',
          error: '보상 교환 기록은 전용 원장에서만 변경할 수 있습니다' }, 403, origin);
      }
      continue;
    }
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
  const makeupInspection = await inspectScheduledMakeupTaskChanges(env, app, accepted);
  if (makeupInspection.error) {
    return json({ ok: false, code: 'MAKEUP_ENDPOINT_REQUIRED', error: makeupInspection.error }, 409, origin);
  }
  for (const entry of makeupInspection.skip) skipped.add(entry);
  if (auth.scope === 'own') {
    const inspected = await inspectOwnTaskChanges(env, app, auth.id, accepted.filter(entry => !skipped.has(entry)));
    if (inspected.error) return json({ ok: false, error: inspected.error }, 403, origin);
    for (const entry of inspected.skip) skipped.add(entry);
    for (const entry of accepted) {
      if (entry.table === 'staff') skipped.add(entry);
    }
    const checkInspection = await inspectOwnCheckChanges(env, app, auth.id, accepted, inspected.newTaskIds);
    if (checkInspection.error) {
      const payload = { ok: false, error: checkInspection.error };
      if (/출퇴근/.test(checkInspection.error)) payload.code = 'STAFF_ATTENDANCE_ADMIN_ONLY';
      return json(payload, 403, origin);
    }
    for (const entry of checkInspection.skip) skipped.add(entry);
  }
  const attendanceLock = await inspectLockedSession4AttendanceChanges(
    env, app, accepted.filter(entry => !skipped.has(entry)), now
  );
  if (attendanceLock.locked) {
    return json({ ok: false, code: 'SESSION4_ATTENDANCE_LOCKED',
      error: '회차제 출결은 수업일 23시 50분에 확정되어 변경할 수 없습니다. 메모는 출결 상태를 유지한 채 저장해 주세요' }, 409, origin);
  }
  let sealedInspection;
  try { sealedInspection = await inspectSealedOrderChanges(env, app, accepted.filter(entry => !skipped.has(entry))); }
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
  const rewardStaffConflicts = await consultRewardStaffConflicts(env, app, writeEntries);
  if (rewardStaffConflicts.length) {
    return rewardProcessingLockResponse(origin,
      await consultRewardLockDetails(env, app, rewardStaffConflicts));
  }
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
      if (isRewardProcessingLockError(error)) {
        const racedConflicts = await consultRewardStaffConflicts(env, app, writeEntries);
        return rewardProcessingLockResponse(origin,
          await consultRewardLockDetails(env, app, racedConflicts));
      }
      if (isBoardingLockError(error)) return boardingLockResponse(origin);
      if (/BOOK_ORDER_SEALED|BOOK_ORDER_SEND_ACTIVE/.test(String(error && error.message || error))) {
        return json({ ok: false, code: 'BOOK_ORDER_SEALED', error: '봉인된 교재 주문은 전용 주문 화면에서만 변경할 수 있습니다' }, 409, origin);
      }
      if (/SESSION4_ATTENDANCE_LOCKED/.test(String(error && error.message || error))) {
        return json({ ok: false, code: 'SESSION4_ATTENDANCE_LOCKED',
          error: '회차제 출결은 수업일 23시 50분에 확정되어 변경할 수 없습니다. 메모는 출결 상태를 유지한 채 저장해 주세요' }, 409, origin);
      }
      throw error;
    }
  }

  // CAS 행에 대한 generic LWW 시도가 막혔다면 since와 관계없이 서버 정본을 돌려준다.
  // Pages는 authoritative 표시된 casVersion=1 행만 로컬 시간스탬프보다 우선 적용한다.
  const forced = auth.scope === 'all'
    ? await canonicalOnboardingChanges(env, app, attemptedOnboardingKeys)
    : [];
  const makeupForced = (makeupInspection.forced || []).filter(change =>
    auth.scope === 'all' || String(change.owner || '') === String(auth.id || ''));
  const forcedRows = forced.concat(makeupForced);
  const forcedKeys = new Set(forcedRows.map(change => change.table + '\n' + change.key));

  // ── 내려받기 (since 이후)
  const out = forcedRows.slice();
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
      if (forcedKeys.has(t + '\n' + String(r.key))) continue;
      const data = JSON.parse(r.data);
      // 선점 actor 해시는 서버 CAS 검증용이다. 읽기 동기화 응답에도 내보내지 않는다.
      if (t === 'checks' && app === 'consult' && String(r.key || '').startsWith(CONSULT_REWARD_PREFIX) && data) {
        delete data.claimActorHash;
      }
      out.push({ table: t, key: r.key, owner: r.owner, data: data, updated_at: r.updated_at, srv_at: r.srv_at });
    }
  }

  // more일 때는 받은 것 중 가장 오래된 srv_at까지만 확정해야 빠지는 행이 없다
  const nextSince = more ? Math.max(since, ...out.map(r => r.srv_at)) : now;
  const authRole = auth.role === 'manager' ? 'manager' : (auth.scope === 'all' ? 'admin' : 'staff');
  return json({ ok: true, now: nextSince, more: more, changes: out, authRole, dataGeneration }, 200, origin);
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

// 알림톡이 확정 거절되거나 발송 직전 정본이 바뀐 경우, 방금 만든 그 코드만 폐기한다.
// 원문 코드는 저장·반환하지 않고 기존 bootstrap 저장 형식과 같은 hash로만 찾는다.
async function revokeIssuedBootstrap(env, app, staffId, code) {
  if (!APPS.includes(app) || !SAFE_ID.test(String(staffId || '')) ||
      !SAFE_BOOTSTRAP_CODE.test(String(code || ''))) return false;
  const codeHash = tokenStorageValue(await sha256Hex(code));
  const result = await env.DB.prepare(
    'UPDATE bootstrap_codes SET revoked=1 ' +
    'WHERE app=? AND staff_id=? AND code_hash=? AND revoked=0 AND consumed_at IS NULL'
  ).bind(app, staffId, codeHash).run();
  return Number(result && result.meta && result.meta.changes || 0) === 1;
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
const MAX_FEEDBACK_SUBJECT = 80;
const MAX_FEEDBACK_COMMENT = MAX_PARENT_FEEDBACK_COMMENT_CHARS;
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

function feedbackDateLabel(value) {
  const matched = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return matched ? matched[1] + '년 ' + Number(matched[2]) + '월 ' + Number(matched[3]) + '일' : '';
}

/** 클라이언트 미리보기와 카카오 승인 템플릿이 반드시 같은 본문인지 서버에서 다시 확인한다. */
function feedbackV2Body(studentName, date, subjectText, contentText, homeworkText, commentText) {
  return '안녕하세요, WB 웩슬러브레인센터(독해력학원) 입니다.\n\n' +
    studentName + ' 학생의 오늘 수업 피드백을 정리해 보내드립니다.\n\n' +
    '- 일시 : ' + feedbackDateLabel(date) + '\n\n' +
    '- 과목 : ' + subjectText + '\n\n' +
    '- 수업내용 · 진도 : ' + contentText + '\n\n' +
    '- 과제 : ' + homeworkText + '\n\n' +
    '- 코멘트 : ' + commentText + '\n\n' +
    '문의 사항이 있으시면 학원으로 연락부탁드립니다. 감사합니다.';
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

const FEEDBACK_WITH_LATEST_SEND_SELECT =
  'SELECT f.*,s.status AS send_status,s.provider_status_code AS send_provider_status_code,' +
  's.message_hash AS send_message_hash ' +
  'FROM feedback_requests f LEFT JOIN parent_feedback_sends s ON s.app=f.app AND s.send_id=(' +
    'SELECT latest.send_id FROM parent_feedback_sends latest ' +
    'WHERE latest.app=f.app AND latest.feedback_request_key=f.request_key AND latest.message_hash=(' +
      'SELECT newest.message_hash FROM parent_feedback_sends newest ' +
      'WHERE newest.app=f.app AND newest.feedback_request_key=f.request_key ' +
      'ORDER BY newest.created_at DESC,newest.send_id DESC LIMIT 1) ' +
    "ORDER BY CASE WHEN latest.status='accepted' AND latest.provider_status_code='4000' THEN 0 " +
    "WHEN latest.status='accepted' AND latest.provider_status_code='3000' THEN 1 " +
    "WHEN latest.status='accepted' AND latest.provider_status_code='2000' THEN 2 " +
    "WHEN latest.status IN ('reserved','dispatching','unknown') THEN 3 ELSE 4 END," +
    'latest.created_at DESC,latest.send_id DESC LIMIT 1) ';

async function feedbackView(row) {
  if (!row) return null;
  const templateVersion = String(row.template_version || '') === 'v2' ? 'v2' : 'v1';
  const fields = templateVersion === 'v2' ? {
    templateVersion,
    studentName: String(row.student_name || '').trim(),
    dateText: feedbackDateLabel(row.feedback_date),
    subjectText: String(row.subject_text || '').trim(),
    contentText: String(row.content_text || '').trim(),
    homeworkText: String(row.homework_text || '').trim(),
    commentText: String(row.comment_text || '').trim()
  } : {
    templateVersion,
    teacherName: String(row.teacher_name || '').trim(),
    studentName: String(row.student_name || '').trim(),
    contentText: String(row.content_text || '').trim(),
    plusText: String(row.plus_text || '').trim(),
    minusText: String(row.minus_text || '').trim()
  };
  const currentMessageHash = await sha256Hex(JSON.stringify(fields));
  const messageDeliveryState = currentMessageHash === String(row.send_message_hash || '')
    ? feedbackMessageDeliveryState(row) : '';
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
    subjectText: row.subject_text || '',
    homeworkText: row.homework_text || '',
    commentText: row.comment_text || '',
    plusText: row.plus_text || '',
    minusText: row.minus_text || '',
    revision: Number(row.revision),
    status: row.status,
    messageDeliveryState,
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
  if (!hasStructuredLessonMarker(taskData) || String(taskData.id || '') !== identity.taskId ||
      String(taskData.staffId || '') !== String(task.owner)) {
    return { response: json({ ok: false, error: '수업의 ID와 현재 담당자 연결을 확인해 주세요' }, 409, origin) };
  }
  return { task, taskData };
}

async function findFeedbackRequest(env, identity) {
  return await env.DB.prepare(
    FEEDBACK_WITH_LATEST_SEND_SELECT +
    'WHERE f.app=? AND f.task_id=? AND f.feedback_date=? ' +
    'AND f.feedback_type=? AND f.template_version=? LIMIT 1'
  ).bind('task', identity.taskId, identity.feedbackDate, identity.feedbackType, identity.templateVersion).first();
}

async function findFeedbackRequestByKey(env, app, requestKey) {
  return await env.DB.prepare(
    FEEDBACK_WITH_LATEST_SEND_SELECT + 'WHERE f.app=? AND f.request_key=? LIMIT 1'
  ).bind(app, requestKey).first();
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
      FEEDBACK_WITH_LATEST_SEND_SELECT + "WHERE f.app=? AND f.owner=? ORDER BY CASE f.status " +
      "WHEN 'revision_requested' THEN 0 WHEN 'approval_waiting' THEN 1 " +
      "WHEN 'content_approved_send_blocked' THEN 2 WHEN 'sent' THEN 3 WHEN 'cancelled' THEN 4 ELSE 5 END, f.updated_at DESC LIMIT " + limit
    ).bind('task', auth.id).all();
    return json({ ok: true, requests: await Promise.all((result.results || []).map(feedbackView)) }, 200, origin);
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
      return json({ ok: true, idempotent: true, request: await feedbackView(current) }, 200, origin);
    }
    const result = await env.DB.prepare(
      "UPDATE feedback_requests SET owner=?, status='cancelled', revision=revision+1, updated_at=?, " +
      'reviewed_at=NULL, reviewed_by=NULL, review_note=NULL WHERE app=? AND request_key=? AND revision=?'
    ).bind(owner, now, 'task', current.request_key, Number(current.revision)).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도해 주세요' }, 409, origin);
    }
    current = await findFeedbackRequestByKey(env, 'task', current.request_key);
    return json({ ok: true, idempotent: false, request: await feedbackView(current) }, 200, origin);
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
  const templateV2 = identity.templateVersion === 'v2';
  const hasSubjectText = Object.hasOwn(body, 'subjectText');
  const subjectText = templateV2
    ? normalizeFeedbackField(hasSubjectText
      ? body.subjectText : checked.taskData.subject || checked.taskData.className || '') : '';
  const homeworkText = templateV2 ? normalizeFeedbackField(body.homeworkText) : '';
  const commentText = templateV2 ? normalizeFeedbackBody(body.commentText) : '';
  if (!contentText || (!templateV2 && (!plusText || !minusText))) {
    return json({ ok: false, error: templateV2
      ? '수업내용·진도를 확인해 주세요'
      : '오늘 배운 내용·잘한 점·보완할 점을 모두 골라 주세요' }, 400, origin);
  }
  if (contentText.length > MAX_FEEDBACK_FIELD || plusText.length > MAX_FEEDBACK_FIELD || minusText.length > MAX_FEEDBACK_FIELD) {
    return json({ ok: false, error: '항목별 문구는 각각 ' + MAX_FEEDBACK_FIELD + '자까지 입력할 수 있습니다' }, 413, origin);
  }
  if (templateV2 && (!subjectText || !homeworkText || !commentText)) {
    return json({ ok: false, error: '과목·수업내용·과제·코멘트를 모두 확인해 주세요' }, 400, origin);
  }
  if (templateV2 && (subjectText.length > MAX_FEEDBACK_SUBJECT || homeworkText.length > MAX_FEEDBACK_FIELD ||
      commentText.length > MAX_FEEDBACK_COMMENT)) {
    return json({ ok: false, error: '과목은 ' + MAX_FEEDBACK_SUBJECT + '자, 과제는 ' + MAX_FEEDBACK_FIELD +
      '자, 코멘트는 ' + MAX_FEEDBACK_COMMENT + '자까지 입력할 수 있습니다' }, 413, origin);
  }
  if (templateV2 && message !== feedbackV2Body(
    studentName, identity.feedbackDate, subjectText, contentText, homeworkText, commentText
  )) {
    return json({
      ok: false,
      code: 'FEEDBACK_TEMPLATE_MISMATCH',
      error: '미리보기와 승인된 알림톡 형식이 일치하지 않습니다. 피드백 화면을 다시 열어 주세요'
    }, 409, origin);
  }

  const bodyHash = await sha256Hex(message);
  const requestKey = await feedbackRequestKey(identity);
  const sameFields = row => row && row.body_hash === bodyHash && row.body === message &&
    row.teacher_name === teacherName && row.student_id === studentId && row.student_name === studentName &&
    row.content_text === contentText && String(row.subject_text || '') === subjectText &&
    String(row.homework_text || '') === homeworkText && String(row.comment_text || '') === commentText &&
    row.plus_text === plusText && row.minus_text === minusText;

  if (!current) {
    const insertResult = await env.DB.prepare(
      'INSERT OR IGNORE INTO feedback_requests ' +
      '(app,request_key,task_id,owner,feedback_date,feedback_type,template_version,body,body_hash,' +
      'teacher_name,student_id,student_name,content_text,subject_text,homework_text,comment_text,plus_text,minus_text,' +
      'revision,status,created_at,updated_at,reviewed_at,reviewed_by,review_note) ' +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'approval_waiting',?,?,NULL,NULL,NULL)"
    ).bind('task', requestKey, identity.taskId, owner, identity.feedbackDate, identity.feedbackType,
      identity.templateVersion, message, bodyHash, teacherName, studentId, studentName, contentText,
      subjectText, homeworkText, commentText, plusText, minusText,
      now, now).run();
    current = await findFeedbackRequest(env, identity);
    if (!current) return json({ ok: false, error: '피드백 요청을 저장하지 못했습니다' }, 500, origin);
    const freshInsert = Number(insertResult && insertResult.meta && insertResult.meta.changes || 0) === 1;
    if (freshInsert) {
      current = await attemptSendAndReload(env, app, current);
      return json({ ok: true, idempotent: false, request: await feedbackView(current) }, 200, origin);
    }
    if (sameFields(current)) {
      return json({ ok: true, idempotent: true, request: await feedbackView(current) }, 200, origin);
    }
  }

  if (current.status === 'sent' && !sameFields(current)) {
    return json({
      ok: false,
      code: 'FEEDBACK_ALREADY_SENT',
      error: '이미 발송된 피드백은 내용을 바꾸어 다시 보낼 수 없습니다',
      request: await feedbackView(current)
    }, 409, origin);
  }

  if (sameFields(current) && current.status === 'revision_requested') {
    return json({
      ok: false,
      code: 'REVISION_UNCHANGED',
      error: '수정 요청을 반영해 문구를 변경한 뒤 다시 제출해 주세요',
      request: await feedbackView(current)
    }, 409, origin);
  }

  if (sameFields(current) && current.status !== 'cancelled') {
    // 내용은 그대로다 — 다만 이전에 막혀서 못 나갔을 수 있으니(보호자 등록 등) 재시도는 해본다.
    current = await attemptSendAndReload(env, app, current);
    return json({ ok: true, idempotent: true, request: await feedbackView(current) }, 200, origin);
  }

  const result = await env.DB.prepare(
    "UPDATE feedback_requests SET owner=?, body=?, body_hash=?, teacher_name=?, student_id=?, student_name=?, " +
    "content_text=?, subject_text=?, homework_text=?, comment_text=?, plus_text=?, minus_text=?, " +
    "revision=revision+1, status='approval_waiting', " +
    'updated_at=?, reviewed_at=NULL, reviewed_by=NULL, review_note=NULL ' +
    'WHERE app=? AND request_key=? AND revision=?'
  ).bind(owner, message, bodyHash, teacherName, studentId, studentName, contentText,
    subjectText, homeworkText, commentText, plusText, minusText,
    now, 'task', current.request_key, Number(current.revision)).run();
  if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
    return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도해 주세요' }, 409, origin);
  }
  current = await findFeedbackRequestByKey(env, 'task', current.request_key);
  current = await attemptSendAndReload(env, app, current);
  return json({ ok: true, idempotent: false, request: await feedbackView(current) }, 200, origin);
}

/** 제출 즉시 카카오 알림톡 발송을 시도하고, 상태가 바뀐 최신 행을 다시 읽어 돌려준다.
 *  attemptParentFeedbackSend가 실패해도(설정 안 됨, 보호자 미등록 등) 예외를 던지지 않고
 *  상태·사유를 review_note에 남기므로, 여기서는 그 결과를 그대로 반영한 최신 행만 반환한다. */
async function attemptSendAndReload(env, app, current) {
  await attemptParentFeedbackSend(env, app, current);
  return await findFeedbackRequestByKey(env, app, current.request_key);
}

async function handleFeedbackReview(env, app, body, origin) {
  if (app !== 'task') return json({ ok: false, error: '학부모 피드백은 task 앱에서만 사용할 수 있습니다' }, 400, origin);
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);
  if (auth.scope !== 'all') return json({ ok: false, error: '원장만 피드백 문구를 검토할 수 있습니다' }, 403, origin);
  const reviewedBy = auth.role === 'manager' ? auth.id : 'director';

  const action = String(body.action || 'list');
  if (action === 'list') {
    const clauses = ['f.app=?'];
    const binds = ['task'];
    if (body.status != null && body.status !== '') {
      const status = String(body.status);
      if (!FEEDBACK_STATUSES.has(status)) return json({ ok: false, error: '올바른 status가 필요합니다' }, 400, origin);
      clauses.push('f.status=?'); binds.push(status);
    }
    if (body.owner != null && body.owner !== '') {
      const owner = String(body.owner);
      if (!SAFE_ID.test(owner)) return json({ ok: false, error: '올바른 owner가 필요합니다' }, 400, origin);
      clauses.push('f.owner=?'); binds.push(owner);
    }
    if (body.feedbackDate != null && body.feedbackDate !== '') {
      const feedbackDate = String(body.feedbackDate);
      if (!validIsoDate(feedbackDate)) return json({ ok: false, error: 'feedbackDate는 YYYY-MM-DD 형식이어야 합니다' }, 400, origin);
      clauses.push('f.feedback_date=?'); binds.push(feedbackDate);
    }
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 100));
    const statement = env.DB.prepare(
      FEEDBACK_WITH_LATEST_SEND_SELECT + 'WHERE ' + clauses.join(' AND ') +
      " ORDER BY CASE f.status WHEN 'approval_waiting' THEN 0 WHEN 'revision_requested' THEN 1 " +
      "WHEN 'content_approved_send_blocked' THEN 2 WHEN 'sent' THEN 3 WHEN 'cancelled' THEN 4 ELSE 5 END, f.updated_at DESC LIMIT " + limit
    ).bind(...binds);
    const result = await statement.all();
    return json({ ok: true, requests: await Promise.all((result.results || []).map(feedbackView)) }, 200, origin);
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
  let current = await findFeedbackRequestByKey(env, 'task', requestKey);
  if (!current) return json({ ok: false, error: '피드백 요청을 찾을 수 없습니다' }, 404, origin);
  if (Number(current.revision) !== expectedRevision) {
    return json({ ok: false, error: '문구가 변경되었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
  }
  if (current.status === 'cancelled') return json({ ok: false, error: '취소된 요청은 검토할 수 없습니다' }, 409, origin);

  const now = Date.now();
  if (action === 'approve_content') {
    if (current.status === 'content_approved_send_blocked') {
      return json({ ok: true, idempotent: true, request: await feedbackView(current) }, 200, origin);
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
      return json({ ok: true, idempotent: true, request: await feedbackView(current) }, 200, origin);
    }
    const result = await env.DB.prepare(
      "UPDATE feedback_requests SET status='revision_requested', updated_at=?, reviewed_at=?, " +
      "reviewed_by=?, review_note=? WHERE app=? AND request_key=? AND revision=? AND status<>'cancelled'"
    ).bind(now, now, reviewedBy, note, 'task', requestKey, expectedRevision).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
    }
  }
  current = await findFeedbackRequestByKey(env, 'task', requestKey);
  return json({ ok: true, idempotent: false, request: await feedbackView(current) }, 200, origin);
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
  let target = publicUrlOrNull(url), res;
  for (let redirects = 0; redirects <= 3; redirects++) {
    res = await fetch(target, {
      redirect: 'manual', headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' }
    });
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get('location');
    target = location && publicUrlOrNull(new URL(location, target).toString());
    if (!target) throw new Error('안전하지 않은 이동 주소입니다');
    if (redirects === 3) throw new Error('페이지 이동 횟수가 너무 많습니다');
  }
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

async function handleCurriculum(env, app, body, origin, resolvedAuth) {
  const auth = resolvedAuth || await resolveAuth(env, app, body.auth);
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const parentSameOrigin = url.pathname === '/parent-portal' && origin === url.origin;
    const consultGuardianSameOrigin = url.pathname === '/consult-guardian' && origin === url.origin;
    const okOrigin = parentSameOrigin || consultGuardianSameOrigin || !allowed.length || allowed.includes(origin) ? (origin || '*') : null;

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

    // multipart는 request.json()으로 읽을 수 없으므로 이 한 경로만 먼저 분기한다.
    if (url.pathname === '/consult-submission-upload') {
      return await handleConsultSubmissionUpload(request, env, okOrigin, resolveAuth, json);
    }
    if (url.pathname === '/consult-result-upload') {
      return await handleConsultResultUpload(request, env, okOrigin, resolveAuth, json);
    }
    if (url.pathname === '/consult-curriculum-image') {
      return await handleConsultCurriculumImage(request, env, okOrigin, resolveAuth, json);
    }

    let body;
    try { body = await request.json(); }
    catch (e) { return json({ ok: false, error: '본문을 읽을 수 없습니다' }, 400, okOrigin); }

    const app = String(body.app || '');
    if (!APPS.includes(app)) return json({ ok: false, error: 'app은 task 또는 consult' }, 400, okOrigin);

    try {
      if (url.pathname === '/sync')   return await handleSync(env, app, body, okOrigin);
      if (url.pathname === '/consult-reward') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleConsultReward(env, app, body, okOrigin, auth);
      }
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
      if (url.pathname === '/lesson-create-batch') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleLessonCreateBatch(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/contact-log') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleContactLog(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/staff-attendance') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleStaffAttendance(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/weekend-visit') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleWeekendVisit(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/lesson-handoff') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleLessonHandoff(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/consult-submission') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleConsultSubmission(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/consult-result') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleConsultResults(env, app, body, okOrigin, auth, json);
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
      if (url.pathname === '/feedback-polish') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleFeedbackPolish(env, app, body, okOrigin, auth, json);
      }
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
      if (url.pathname === '/student-change') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleStudentChange(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/admin-directive') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleAdminDirective(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/teacher-live-request') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleTeacherLiveRequest(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/tuition-alert') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleTuitionAlert(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/student-attendance') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleStudentAttendance(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-issue') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookIssue(env, app, body, okOrigin, auth, json, ctx);
      }
      if (url.pathname === '/book-catalog') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookCatalog(env, app, body, okOrigin, auth, json);
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
          'publication_readiness_list', 'publication_list', 'publication_set', 'request_list', 'request_resolve',
          'announcement_list', 'announcement_save', 'announcement_publish', 'announcement_end'
        ]);
        const action = String(body.action || '');
        if (!authenticatedActions.has(action) && !parentSameOrigin) {
          return json({ ok: false, error: '보호자 앱과 같은 출처에서만 사용할 수 있습니다' }, 403, okOrigin);
        }
        const auth = authenticatedActions.has(action) ? await resolveAuth(env, app, body.auth) : null;
        return await handleParentPortal(env, app, body, okOrigin, auth, json, request);
      }
      if (url.pathname === '/consult-guardian') {
        const authenticatedActions = new Set(['access_list', 'access_set', 'invite', 'preview']);
        const action = String(body.action || '');
        if (!authenticatedActions.has(action) && !consultGuardianSameOrigin) {
          return json({ ok: false, error: '보호자 앱과 같은 출처에서만 사용할 수 있습니다' }, 403, okOrigin);
        }
        const auth = authenticatedActions.has(action) ? await resolveAuth(env, app, body.auth) : null;
        return await handleConsultGuardian(env, app, body, okOrigin, auth, json, request);
      }
      if (url.pathname === '/student-portal') {
        const authenticatedActions = new Set([
          'access_list', 'access_set', 'invite', 'preview', 'self_check_list', 'self_check_confirm'
        ]);
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
      if (url.pathname === '/consult-link-send') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleConsultLinkSend(
          env, app, body, okOrigin, auth, json,
          staffId => issueBootstrap(env, 'consult', staffId, BOOTSTRAP_TTL_MS),
          (staffId, code) => revokeIssuedBootstrap(env, 'consult', staffId, code)
        );
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
      if (url.pathname === '/consult-curriculum-url') {
        if (app !== 'consult') return json({ ok: false, error: '컨설팅 앱에서만 사용할 수 있습니다' }, 400, okOrigin);
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        if (!await isConsultDirectorOrManager(env, auth)) {
          return json({ ok: false, error: '원장 또는 관리자만 목차 주소를 읽을 수 있습니다' }, 403, okOrigin);
        }
        return await handleCurriculum(env, app, body, okOrigin, auth);
      }
      if (url.pathname === '/search') return await handleSearch(env, app, body, okOrigin);
      if (url.pathname === '/curriculum') return await handleCurriculum(env, app, body, okOrigin);
      return json({ ok: false, error: '없는 경로' }, 404, okOrigin);
    } catch (e) {
      if (isRewardProcessingLockError(e)) return rewardProcessingLockResponse(okOrigin);
      if (url.pathname === '/feedback-polish') {
        return json({ ok: false, code: 'FEEDBACK_STORAGE_BUSY',
          error: '피드백 저장소를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요. 기존 문구는 그대로 유지됩니다' },
        503, okOrigin);
      }
      return json({ ok: false, error: String(e && e.message || e) }, 500, okOrigin);
    }
  }
};
