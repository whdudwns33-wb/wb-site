// 운영 요청 원장(POST /api/requests) — sync/ops-request.js(01a73cb)를 desk 테이블로 이식한 것.
// 계정 발급·배정·문제지·후속 요청의 접수→담당→처리 상태와 소요를 문서(tasks) 밖에서 따로 센다.
// 학생은 SF 코드·students 문서 id 로만 가리키며 전화·이메일·주민번호 패턴은 어디에도 저장하지 않는다.
// 클라이언트(desk/lib/runbook-ui.js)는 예전 /ops-request 계약(액션·필드·오류 코드)으로 짜여 있어 그대로 유지한다.

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STUDENT_REF = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^opr_[A-Za-z0-9_-]{4,76}$/;
const SF_CODE = /^SF-\d{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REQ_TYPES = new Set(['account', 'assignment', 'worksheet', 'followup', 'other']);
const PROGRAMS = new Set(['studyforce', 'classcard', 'metamath', 'nelt', 'exam4you', 'jokbo', 'none']);
const ADMIN_VIAS = new Set(['app', 'kakao']);
const MAX_LINE = 300;
const MAX_URL = 500;
const MAX_REQUESTS = 500;
const ADMIN_ACTOR = 'admin';
const COLUMNS = 'request_id,req_type,program,target_ref,owner_id,assignee_id,via,needed_by,detail,' +
  'status,result_note,result_url,created_at,accepted_at,done_at,updated_at,updated_by';

// 실명은 정규식으로 가를 수 없으므로 전화·이메일·주민번호 "패턴"만 서버가 거부한다(기획서 A.5 개인정보 경계).
export const PII_PATTERNS = [
  /01[0-9]-?\d{3,4}-?\d{4}/,                              // 휴대전화 010-1234-5678 / 01012345678
  /0\d{1,2}-\d{3,4}-\d{4}/,                                // 유선 02-123-4567 / 031-1234-5678
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/,   // 이메일
  /\d{6}-?[1-4]\d{6}/                                      // 주민등록번호
];

// 전이표. from: 허용 출발 상태, to: 도착 상태(null 이면 상태 유지), who: 누를 수 있는 역할.
// admin(원장)은 모든 작업을 할 수 있고, assignee 는 처리 작업, owner 는 취소만 한다.
const TRANSITIONS = {
  assign: { from: ['requested', 'accepted', 'in_progress', 'blocked'], to: null, who: 'admin' },
  accept: { from: ['requested'], to: 'accepted', who: 'assignee' },
  start: { from: ['accepted'], to: 'in_progress', who: 'assignee' },
  done: { from: ['accepted', 'in_progress', 'blocked'], to: 'done', who: 'assignee' },
  block: { from: ['requested', 'accepted', 'in_progress'], to: 'blocked', who: 'assignee' },
  unblock: { from: ['blocked'], to: 'in_progress', who: 'assignee' },
  cancel: { from: ['requested'], to: 'cancelled', who: 'owner' }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

function changes(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

function validDate(value) {
  const date = String(value || '');
  if (!DATE_RE.test(date)) return false;
  const parts = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return parsed.getUTCFullYear() === parts[0] && parsed.getUTCMonth() === parts[1] - 1 &&
    parsed.getUTCDate() === parts[2];
}

// 한 줄 필드라 줄바꿈·제어문자는 공백으로 접고, 연속 공백은 하나로 줄인다.
function cleanLine(value, max) {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  return cleaned && cleaned.length <= max ? cleaned : null;
}

function optionalText(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

export function hasPii(text) {
  return PII_PATTERNS.some(pattern => pattern.test(String(text || '')));
}

// SF- 로 시작하면 반드시 SF-000 꼴이어야 한다 — 학생 id 규칙만으로는 'SF-12' 같은 오타를 학생 ID 로 오인한다.
function validTargetRef(value) {
  if (/^sf-/i.test(value)) return SF_CODE.test(value);
  return STUDENT_REF.test(value);
}

// 결과 링크는 https 만, 자격증명(user:pass@)이 박힌 주소는 저장하지 않는다.
function validResultUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL || /[\s\p{Cc}]/u.test(value)) return false;
  let parsed;
  try { parsed = new URL(value); } catch (error) { return false; }
  return parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password;
}

function newId(prefix) {
  return prefix + crypto.randomUUID().replace(/-/g, '');
}

// desk 인증은 {role:'admin'|'staff', staffId}. 원장은 scope all(actorId 'admin'), 직원은 own.
function actorOf(auth) {
  if (!auth || typeof auth !== 'object') return null;
  if (auth.role === 'admin') return { admin: true, id: ADMIN_ACTOR };
  const id = String(auth.staffId || '');
  return auth.role === 'staff' && SAFE_ID.test(id) ? { admin: false, id } : null;
}

function allowed(who, actor, row) {
  if (actor.admin) return true;
  if (who === 'assignee') return !!row.assignee_id && String(row.assignee_id) === actor.id;
  if (who === 'owner') return String(row.owner_id) === actor.id;
  return false;
}

function textOrNull(value) {
  return value === null || value === undefined ? null : String(value);
}

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

export function view(row) {
  return {
    id: String(row.request_id), reqType: String(row.req_type), program: String(row.program),
    targetRef: textOrNull(row.target_ref), ownerId: String(row.owner_id),
    assigneeId: textOrNull(row.assignee_id), via: String(row.via), neededBy: textOrNull(row.needed_by),
    detail: String(row.detail), status: String(row.status),
    resultNote: textOrNull(row.result_note), resultUrl: textOrNull(row.result_url),
    createdAt: Number(row.created_at), acceptedAt: numberOrNull(row.accepted_at),
    doneAt: numberOrNull(row.done_at), updatedAt: Number(row.updated_at)
  };
}

async function tablesReady(env) {
  const result = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('desk_requests','desk_request_events')"
  ).all();
  return (result.results || []).length === 2;
}

// 담당자는 재직 중(active=1)인 직원만 — 비활성 직원에게 배정되면 아무도 처리하지 못한다.
async function activeStaffExists(env, staffId) {
  if (!SAFE_ID.test(staffId)) return false;
  const row = await env.DB.prepare('SELECT id FROM desk_staff WHERE id=? AND active=1 LIMIT 1')
    .bind(staffId).first();
  return !!row;
}

async function loadRow(env, requestId) {
  return env.DB.prepare('SELECT ' + COLUMNS + ' FROM desk_requests WHERE request_id=? LIMIT 1')
    .bind(requestId).first();
}

function invalid(code, error, status = 400) {
  return json({ ok: false, code, error }, status);
}

function conflict(code, error, row) {
  return json({ ok: false, code, error, current: view(row) }, 409);
}

async function list(env, actor) {
  // staff 는 자기가 올렸거나 자기에게 배정된 요청만, admin 은 전체. 최근 갱신순.
  const where = actor.admin ? '' : ' WHERE (owner_id=? OR assignee_id=?)';
  const bindings = actor.admin ? [] : [actor.id, actor.id];
  const result = await env.DB.prepare(
    'SELECT ' + COLUMNS + ' FROM desk_requests' + where +
    ' ORDER BY updated_at DESC, request_id DESC LIMIT ' + MAX_REQUESTS
  ).bind(...bindings).all();
  return json({ ok: true, viewerId: actor.id, role: actor.admin ? 'admin' : 'staff',
    requests: (result.results || []).map(view) });
}

async function create(env, body, actor) {
  const reqType = String(body.reqType || '');
  const program = String(body.program || '');
  if (!REQ_TYPES.has(reqType) || !PROGRAMS.has(program)) {
    return invalid('OPS_INVALID', '요청 종류와 프로그램을 확인해 주세요');
  }
  const targetRef = optionalText(body.targetRef);
  if (targetRef !== null && !validTargetRef(targetRef)) {
    return invalid('OPS_TARGET', '대상은 SF 코드(SF-000) 또는 학생 ID만 적을 수 있습니다');
  }
  const neededBy = optionalText(body.neededBy);
  if (neededBy !== null && !validDate(neededBy)) {
    return invalid('OPS_INVALID', '필요일은 YYYY-MM-DD 형식의 실제 날짜여야 합니다');
  }
  const detail = cleanLine(body.detail, MAX_LINE);
  if (!detail) {
    return invalid('OPS_DETAIL', '요청 내용은 한 줄 1~300자로 적어 주세요');
  }
  if (hasPii(detail) || (targetRef !== null && hasPii(targetRef))) {
    return invalid('OPS_PII', '전화번호·이메일·주민번호는 적을 수 없습니다. 학생은 SF 코드나 학생 ID로만 가리켜 주세요');
  }
  // 직원 링크에서 올린 요청은 경로가 앱뿐이라 'app' 으로 고정한다. admin 은 카톡으로 받은 요청을 대신 적을 때 'kakao'.
  let via = 'app';
  const viaInput = optionalText(body.via);
  if (actor.admin && viaInput !== null) {
    if (!ADMIN_VIAS.has(viaInput)) return invalid('OPS_INVALID', '접수 경로는 app 또는 kakao만 가능합니다');
    via = viaInput;
  }
  const assigneeId = optionalText(body.assigneeId);
  if (assigneeId !== null) {
    if (!actor.admin) {
      return invalid('OPS_FORBIDDEN', '담당자 지정은 원장만 할 수 있습니다', 403);
    }
    if (!await activeStaffExists(env, assigneeId)) {
      return invalid('OPS_ASSIGNEE', '현재 재직 중인 직원만 담당자로 지정할 수 있습니다');
    }
  }
  // 클라이언트가 id 를 미리 만들어 보내면 네트워크 재시도가 같은 행으로 떨어진다. 없으면 서버가 만든다.
  const clientId = optionalText(body.id);
  const requestId = clientId === null ? newId('opr_') : clientId;
  if (!REQUEST_ID.test(requestId)) return invalid('OPS_INVALID', '요청 ID 형식을 확인해 주세요');
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO desk_requests (' + COLUMNS + ') ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,NULL,NULL,?,?)'
    ).bind(requestId, reqType, program, targetRef, actor.id, assigneeId, via, neededBy, detail,
      'requested', now, now, actor.id),
    // 이벤트는 직전 INSERT 가 실제로 행을 만들었을 때(changes()=1)만 붙는다 — 같은 ms 의 재전송이라도
    // 무시된 INSERT 에는 이벤트가 생기지 않는다.
    env.DB.prepare(
      'INSERT INTO desk_request_events (event_id,request_id,actor_id,action,from_status,to_status,created_at) ' +
      'SELECT ?,?,?,?,NULL,?,? WHERE changes() = 1'
    ).bind(newId('opre_'), requestId, actor.id, 'create', 'requested', now)
  ]);
  const saved = await loadRow(env, requestId);
  if (!saved) return invalid('OPS_ID_CONFLICT', '요청을 저장하지 못했습니다. 다시 시도해 주세요', 409);
  if (changes(results[0]) === 0) {
    if (String(saved.owner_id) !== actor.id) {
      return invalid('OPS_ID_CONFLICT', '같은 요청 ID가 이미 다른 요청자에게 있습니다', 409);
    }
    return json({ ok: true, idempotent: true, request: view(saved) });
  }
  return json({ ok: true, request: view(saved) });
}

async function transition(env, body, actor, action) {
  const requestId = String(body.id || '');
  const rule = TRANSITIONS[action];
  if (!REQUEST_ID.test(requestId) || !rule) {
    return invalid('OPS_INVALID', '요청 ID와 작업을 확인해 주세요');
  }
  const expected = Number(body.expectedUpdatedAt);
  if (!Number.isFinite(expected)) {
    return invalid('OPS_INVALID', '현재 갱신 시각(expectedUpdatedAt)을 함께 보내 주세요');
  }
  const row = await loadRow(env, requestId);
  if (!row) return invalid('OPS_NOT_FOUND', '운영 요청을 찾을 수 없습니다', 404);
  if (!allowed(rule.who, actor, row)) {
    return invalid('OPS_FORBIDDEN', '이 요청에 대해 이 작업을 할 권한이 없습니다', 403);
  }
  // 권한 다음에 CAS 를 먼저 본다 — 오래된 화면이 낸 전이는 상태 판정보다 "새로고침"이 맞는 답이다.
  if (Number(row.updated_at) !== expected) {
    return conflict('OPS_STALE', '다른 기기에서 먼저 갱신되었습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요', row);
  }
  if (!rule.from.includes(String(row.status))) {
    return conflict('OPS_TRANSITION', '현재 상태에서는 이 작업을 할 수 없습니다', row);
  }
  let assigneeId = textOrNull(row.assignee_id);
  if (action === 'assign') {
    const input = optionalText(body.assigneeId);
    if (input === null || !await activeStaffExists(env, input)) {
      return invalid('OPS_ASSIGNEE', '현재 재직 중인 직원만 담당자로 지정할 수 있습니다');
    }
    assigneeId = input;
  }
  // resultNote 는 어느 전이에서든 "마지막 한 줄"(막힘 사유·처리 결과)로 덮어쓰고, 안 보내면 이전 값을 지킨다.
  let resultNote = textOrNull(row.result_note);
  const noteInput = optionalText(body.resultNote);
  if (noteInput !== null) {
    const cleaned = cleanLine(noteInput, MAX_LINE);
    if (!cleaned) return invalid('OPS_DETAIL', '결과·사유 메모는 한 줄 1~300자로 적어 주세요');
    if (hasPii(cleaned)) {
      return invalid('OPS_PII', '전화번호·이메일·주민번호는 적을 수 없습니다');
    }
    resultNote = cleaned;
  }
  let resultUrl = textOrNull(row.result_url);
  const urlInput = optionalText(body.resultUrl);
  if (urlInput !== null) {
    if (action !== 'done' || !validResultUrl(urlInput)) {
      return invalid('OPS_URL', '결과 링크는 완료(done) 때 https 주소만 남길 수 있습니다');
    }
    resultUrl = urlInput;
  }
  const toStatus = rule.to || String(row.status);
  // 같은 ms 안에 두 번 갱신돼도 updated_at 이 반드시 커지도록 — CAS 와 update_guard 트리거가 이를 전제한다.
  const now = Math.max(Date.now(), Number(row.updated_at) + 1);
  const acceptedAt = action === 'accept' ? now : numberOrNull(row.accepted_at);
  const doneAt = action === 'done' ? now : numberOrNull(row.done_at);
  const results = await env.DB.batch([
    env.DB.prepare(
      'UPDATE desk_requests SET status=?, assignee_id=?, accepted_at=?, done_at=?, result_note=?, result_url=?, ' +
      'updated_at=?, updated_by=? WHERE request_id=? AND updated_at=? AND status=?'
    ).bind(toStatus, assigneeId, acceptedAt, doneAt, resultNote, resultUrl, now, actor.id,
      requestId, expected, String(row.status)),
    // 이벤트는 직전 CAS UPDATE 가 실제로 1행을 바꿨을 때만 붙는다 — 같은 사람이 같은 ms 에 두 번 눌러도
    // 진 쪽 호출은 이벤트를 남기지 않는다.
    env.DB.prepare(
      'INSERT INTO desk_request_events (event_id,request_id,actor_id,action,from_status,to_status,created_at) ' +
      'SELECT ?,?,?,?,?,?,? WHERE changes() = 1'
    ).bind(newId('opre_'), requestId, actor.id, action, String(row.status), toStatus, now)
  ]);
  const saved = await loadRow(env, requestId);
  if (changes(results[0]) === 0 || !saved) {
    return conflict('OPS_STALE', '다른 기기에서 먼저 갱신되었습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요', saved || row);
  }
  return json({ ok: true, request: view(saved) });
}

async function bodyOf(requestOrBody) {
  if (requestOrBody instanceof Request) {
    try { return await requestOrBody.json(); } catch (error) { return null; }
  }
  return requestOrBody;
}

/** 백업(/api/export)용 — 요청은 view 형태, 이벤트는 원본 열 그대로. */
export async function exportRequests(env) {
  const requests = await env.DB.prepare('SELECT ' + COLUMNS + ' FROM desk_requests ORDER BY created_at, request_id').all();
  const events = await env.DB.prepare(
    'SELECT event_id,request_id,actor_id,action,from_status,to_status,created_at FROM desk_request_events ORDER BY created_at, event_id'
  ).all();
  return { requests: (requests.results || []).map(view), events: events.results || [] };
}

/**
 * @param {Request|object} requestOrBody  Request 면 JSON 본문을 읽고, 이미 파싱된 객체면 그대로 쓴다.
 * @param {object} env  { DB }
 * @param {{role:'admin'|'staff', staffId:string}} auth  desk-api 가 Bearer 토큰으로 확정한 신원.
 */
export async function handleRequests(requestOrBody, env, auth) {
  if (!await tablesReady(env)) {
    return json({ ok: false, code: 'OPS_REQUEST_NOT_READY', error: '운영 요청 기능을 준비하고 있습니다' }, 503);
  }
  const actor = actorOf(auth);
  if (!actor) {
    return json({ ok: false, code: 'OPS_FORBIDDEN', error: '직원 링크 또는 원장 로그인으로 다시 열어 주세요' }, 403);
  }
  const body = await bodyOf(requestOrBody);
  if (!body || typeof body !== 'object') {
    return json({ ok: false, code: 'OPS_INVALID', error: 'JSON 본문이 필요합니다' }, 400);
  }
  const action = String(body.action || 'list');
  if (action === 'list') return list(env, actor);
  if (action === 'create') return create(env, body, actor);
  // 전이는 action 에 이름을 직접 넣거나({action:'accept'}), {action:'transition', transition:'accept'} 둘 다 받는다.
  if (action === 'transition') return transition(env, body, actor, String(body.transition || ''));
  if (TRANSITIONS[action]) return transition(env, body, actor, action);
  return json({ ok: false, code: 'OPS_INVALID', error: '지원하지 않는 운영 요청 작업입니다' }, 400);
}
