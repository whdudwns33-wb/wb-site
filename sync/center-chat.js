import { activeRosterStudent } from './book-order-student-scope.js';
import { isTaskWriteCasConflict, taskWriteCasGuardStatement } from './task-write-cas.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MESSAGE_ID = /^ccm_[A-Za-z0-9_-]{4,76}$/;
const EVENT_ID = /^cpe_[A-Za-z0-9_-]{4,76}$/;
const PRESENCE_STATUS = new Set(['arrived', 'left', 'absent']);
const MAX_BODY = 1000;
const MAX_ITEMS = 100;

function changes(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

function parsed(value) {
  try { return JSON.parse(String(value || '')); } catch (error) { return null; }
}

function kstDate(now = Date.now()) {
  return new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function cleanName(value, max) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanBody(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned && cleaned.length <= MAX_BODY ? cleaned : null;
}

function managerIds(env) {
  return new Set([env.TASK_MANAGER_STAFF_IDS, env.TASK_MANAGER_STAFF_IDS_CONFIG]
    .flatMap(value => String(value || '').split(','))
    .map(value => value.trim()).filter(value => SAFE_ID.test(value)));
}

async function tablesReady(env) {
  const result = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
    "('center_chat_events','center_chat_presence','center_chat_reads','center_chat_missing')"
  ).all();
  return (result.results || []).length === 4;
}

function actorView(actor) {
  return { id: actor.id, name: actor.name };
}

async function actorFor(env, app, auth) {
  if (!auth || !['all', 'own'].includes(String(auth.scope || ''))) return null;
  if (!auth.id && !auth.inspection) {
    return auth.scope === 'all' ? { id: 'director', name: '원장님', staffData: '' } : null;
  }
  const actorId = String(auth.inspection ? auth.managerId : auth.id || '');
  if (!SAFE_ID.test(actorId)) return null;
  if ((auth.inspection || auth.scope === 'all') && !managerIds(env).has(actorId)) return null;
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind(app, actorId).first();
  const staff = row && parsed(row.data);
  const name = cleanName(staff && staff.name, 80);
  if (!staff || staff.deleted || !name || (staff.id && String(staff.id) !== actorId)) return null;
  return { id: actorId, name, staffData: String(row.data) };
}

function actorCondition(actor, app, alias) {
  if (!actor.staffData) return { sql: '1=1', binds: [] };
  return {
    sql: 'EXISTS (SELECT 1 FROM staff ' + alias + ' WHERE ' + alias + '.app=? ' +
      'AND ' + alias + '.id=? AND ' + alias + '.data=?)',
    binds: [app, actor.id, actor.staffData]
  };
}

async function actorStillCurrent(env, app, actor) {
  if (!actor.staffData) return true;
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind(app, actor.id).first();
  return !!row && String(row.data) === actor.staffData;
}

async function rosterContext(env, app, date) {
  const row = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1')
    .bind(app).first();
  const document = row && parsed(row.data);
  const source = document && document.roster && Array.isArray(document.roster.students)
    ? document.roster.students : [];
  const students = source.filter(student => activeRosterStudent(student, date.slice(0, 7)))
    .map(student => ({
      id: String(student.id), name: cleanName(student.name, 40), grade: cleanName(student.grade, 20)
    }))
    .filter(student => SAFE_ID.test(student.id) && student.name)
    .sort((left, right) => left.name.localeCompare(right.name, 'ko') ||
      left.grade.localeCompare(right.grade, 'ko') || left.id.localeCompare(right.id));
  return { data: row ? String(row.data) : '', students };
}

function activeStudentCondition(app, rosterData, studentId, date, alias) {
  const month = date.slice(0, 7);
  return {
    sql: 'EXISTS (SELECT 1 FROM private_rosters ' + alias + '_roster, ' +
      "json_each(" + alias + "_roster.data,'$.roster.students') " + alias + '_student ' +
      'WHERE ' + alias + '_roster.app=? AND ' + alias + '_roster.data=? ' +
      'AND json_valid(' + alias + '_roster.data) ' +
      "AND CAST(json_extract(" + alias + "_student.value,'$.id') AS TEXT)=? " +
      "AND COALESCE(CAST(json_extract(" + alias + "_student.value,'$.start') AS TEXT),'')<=? " +
      "AND (COALESCE(CAST(json_extract(" + alias + "_student.value,'$.end') AS TEXT),'')='' " +
      "OR CAST(json_extract(" + alias + "_student.value,'$.end') AS TEXT)>?) " +
      "AND COALESCE(CAST(json_extract(" + alias + "_student.value,'$.reason') AS TEXT),'') " +
      "NOT GLOB '휴원 [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' " +
      "AND COALESCE(CAST(json_extract(" + alias + "_student.value,'$.reason') AS TEXT),'') " +
      "NOT GLOB '퇴원 [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')",
    binds: [app, rosterData, studentId, month, month]
  };
}

function eventView(row) {
  const common = {
    kind: String(row.kind), id: String(row.item_id), actorId: String(row.actor_staff_id),
    actorName: String(row.actor_name), createdAt: Number(row.created_at)
  };
  if (common.kind === 'message') {
    return { ...common, messageId: common.id, messageDate: String(row.event_date), body: String(row.body) };
  }
  return { ...common, eventId: common.id, studentId: String(row.student_id),
    status: String(row.status), revision: Number(row.revision) };
}

function presenceView(row) {
  return {
    studentId: String(row.student_id), status: String(row.status), revision: Number(row.revision),
    updatedAt: Number(row.updated_at), actorId: String(row.updated_by_staff_id),
    actorName: String(row.updated_by_name)
  };
}

async function unreadCount(env, app, date, actorId, afterSequence) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) count FROM center_chat_events WHERE app=? AND feed_seq>? AND actor_staff_id<>? " +
    "AND (kind='message' OR (kind='presence' AND event_date=?))"
  ).bind(app, Number(afterSequence) || 0, actorId, date).first();
  return Number(row && row.count || 0);
}

async function list(env, app, origin, actor, json) {
  const date = kstDate();
  const [roster, eventRows, currentRows, readRow] = await Promise.all([
    rosterContext(env, app, date),
    env.DB.prepare(
      "SELECT * FROM center_chat_events WHERE app=? AND (kind='message' OR event_date=?) " +
      'ORDER BY feed_seq DESC LIMIT ' + MAX_ITEMS
    ).bind(app, date).all(),
    env.DB.prepare(
      'SELECT student_id,status,revision,updated_at,updated_by_staff_id,updated_by_name ' +
      'FROM center_chat_presence WHERE app=? AND presence_date=? ORDER BY student_id'
    ).bind(app, date).all(),
    env.DB.prepare(
      'SELECT read_through_feed_seq,read_through_item_id FROM center_chat_reads ' +
      'WHERE app=? AND reader_staff_id=? LIMIT 1'
    ).bind(app, actor.id).first()
  ]);
  const descending = eventRows.results || [];
  const items = descending.slice().reverse().map(eventView);
  const activeIds = new Set(roster.students.map(student => student.id));
  const presence = (currentRows.results || []).filter(row => activeIds.has(String(row.student_id)))
    .map(presenceView);
  const readSequence = Number(readRow && readRow.read_through_feed_seq) || 0;
  const unread = await unreadCount(env, app, date, actor.id, readSequence);
  const visibleUnread = descending.filter(row => Number(row.feed_seq) > readSequence &&
    String(row.actor_staff_id) !== actor.id).length;
  const missingRows = await env.DB.prepare('SELECT * FROM center_chat_missing WHERE app=? AND request_date=? ORDER BY created_at DESC')
    .bind(app, date).all();
  const missing = (missingRows.results || []).filter(row => activeIds.has(row.student_id)).map(missingView);
  return json({
    missing, canHandleMissing: actor.id === 'director' || managerIds(env).has(actor.id),
    ok: true, date, actor: actorView(actor), students: roster.students, presence, items,
    lastItemId: descending.length ? String(descending[0].item_id) : '',
    unreadCount: unread, hiddenUnreadCount: Math.max(0, unread - visibleUnread)
  }, 200, origin);
}

function sameMessage(row, input) {
  return !!row && String(row.kind) === 'message' &&
    String(row.actor_staff_id) === input.actor.id && String(row.body) === input.body;
}

async function send(env, app, body, origin, actor, json) {
  const messageId = String(body.messageId || '');
  const messageBody = cleanBody(body.body);
  if (!MESSAGE_ID.test(messageId) || !messageBody) {
    return json({ ok: false, error: '메시지 ID와 1,000자 이내 내용을 확인해 주세요' }, 400, origin);
  }
  const requestNow = Date.now();
  const input = { date: kstDate(requestNow), actor, body: messageBody };
  const existing = await env.DB.prepare(
    'SELECT * FROM center_chat_events WHERE app=? AND item_id=? LIMIT 1'
  ).bind(app, messageId).first();
  if (existing) {
    if (!sameMessage(existing, input)) return json({ ok: false, code: 'CENTER_CHAT_MESSAGE_ID_CONFLICT',
      error: '같은 메시지 ID로 다른 내용이 이미 저장되어 있습니다' }, 409, origin);
    return json({ ok: true, idempotent: true, message: eventView(existing) }, 200, origin);
  }
  const actorGuard = actorCondition(actor, app, 'message_actor');
  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO center_chat_events ' +
    '(app,kind,item_id,event_date,actor_staff_id,actor_name,body,student_id,status,revision,created_at) ' +
    "SELECT ?,'message',?,?,?,?,?,NULL,NULL,NULL,? WHERE " + actorGuard.sql
  ).bind(app, messageId, input.date, actor.id, actor.name, messageBody, requestNow, ...actorGuard.binds).run();
  const saved = await env.DB.prepare(
    'SELECT * FROM center_chat_events WHERE app=? AND item_id=? LIMIT 1'
  ).bind(app, messageId).first();
  if (sameMessage(saved, input)) {
    return json({ ok: true, idempotent: changes(result) === 0, message: eventView(saved) }, 200, origin);
  }
  if (!saved && !await actorStillCurrent(env, app, actor)) {
    return json({ ok: false, code: 'CENTER_CHAT_ACTOR_CHANGED',
      error: '직원 정보가 변경되었습니다. 새로고침 후 다시 보내 주세요' }, 409, origin);
  }
  return json({ ok: false, code: 'CENTER_CHAT_MESSAGE_ID_CONFLICT',
    error: '같은 메시지 ID로 다른 내용이 이미 저장되어 있습니다' }, 409, origin);
}

function samePresenceEvent(row, input) {
  return !!row && String(row.kind) === 'presence' &&
    String(row.student_id) === input.studentId && String(row.status) === input.status &&
    Number(row.revision) === input.expectedRevision + 1 && String(row.actor_staff_id) === input.actor.id;
}

async function presence(env, app, body, origin, actor, json) {
  const eventId = String(body.eventId || '');
  const studentId = String(body.studentId || '');
  const status = String(body.status || '');
  const expectedRevision = Number(body.expectedRevision);
  if (!EVENT_ID.test(eventId) || !SAFE_ID.test(studentId) || !PRESENCE_STATUS.has(status) ||
      !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return json({ ok: false, error: '등원 이벤트·학생·상태·현재 revision을 확인해 주세요' }, 400, origin);
  }
  const requestNow = Date.now();
  const input = { date: kstDate(requestNow), studentId, status, expectedRevision, actor };
  const existingEvent = await env.DB.prepare(
    'SELECT * FROM center_chat_events WHERE app=? AND item_id=? LIMIT 1'
  ).bind(app, eventId).first();
  if (existingEvent) {
    if (!samePresenceEvent(existingEvent, input)) return json({ ok: false,
      code: 'CENTER_CHAT_EVENT_ID_CONFLICT', error: '같은 등원 이벤트 ID로 다른 내용이 이미 저장되어 있습니다' }, 409, origin);
    const eventDate = String(existingEvent.event_date);
    const current = await env.DB.prepare(
      'SELECT * FROM center_chat_presence WHERE app=? AND presence_date=? AND student_id=? LIMIT 1'
    ).bind(app, eventDate, studentId).first();
    return json({ ok: true, idempotent: true, event: eventView(existingEvent),
      presence: current && presenceView(current) }, 200, origin);
  }
  const roster = await rosterContext(env, app, input.date);
  if (!roster.students.some(student => student.id === studentId)) return json({ ok: false,
    code: 'CENTER_CHAT_STUDENT_INACTIVE', error: '현재 재원생 명단에서 학생을 다시 선택해 주세요' }, 409, origin);
  const current = await env.DB.prepare(
    'SELECT * FROM center_chat_presence WHERE app=? AND presence_date=? AND student_id=? LIMIT 1'
  ).bind(app, input.date, studentId).first();
  const currentRevision = Number(current && current.revision || 0);
  if (currentRevision !== expectedRevision) return json({ ok: false,
    code: 'CENTER_CHAT_PRESENCE_REVISION_CONFLICT', error: '다른 선생님이 먼저 등원 상태를 변경했습니다',
    current: current && presenceView(current) }, 409, origin);

  const revision = expectedRevision + 1;
  const now = Math.max(requestNow, Number(current && current.updated_at || 0) + 1);
  const rosterGuard = activeStudentCondition(app, roster.data, studentId, input.date, 'presence');
  const actorGuard = actorCondition(actor, app, 'presence_actor');
  const currentStatement = current
    ? env.DB.prepare(
      'UPDATE center_chat_presence SET status=?,revision=?,updated_at=?,updated_by_staff_id=?,updated_by_name=? ' +
      'WHERE app=? AND presence_date=? AND student_id=? AND revision=? ' +
      'AND ' + rosterGuard.sql + ' AND ' + actorGuard.sql
    ).bind(status, revision, now, actor.id, actor.name, app, input.date, studentId, expectedRevision,
      ...rosterGuard.binds, ...actorGuard.binds)
    : env.DB.prepare(
      'INSERT OR IGNORE INTO center_chat_presence ' +
      '(app,presence_date,student_id,status,revision,updated_at,updated_by_staff_id,updated_by_name) ' +
      'SELECT ?,?,?,?,1,?,?,? WHERE ' + rosterGuard.sql + ' AND ' + actorGuard.sql
    ).bind(app, input.date, studentId, status, now, actor.id, actor.name,
      ...rosterGuard.binds, ...actorGuard.binds);
  const casGuard = await taskWriteCasGuardStatement(env, app, 'center_chat_presence',
    [input.date, studentId, expectedRevision, revision, eventId].join('\n'), now);
  const eventStatement = env.DB.prepare(
    'INSERT INTO center_chat_events ' +
    '(app,kind,item_id,event_date,actor_staff_id,actor_name,body,student_id,status,revision,created_at) ' +
    "SELECT app,'presence',?,presence_date,updated_by_staff_id,updated_by_name,NULL,student_id,status,revision,updated_at " +
    'FROM center_chat_presence WHERE app=? AND presence_date=? AND student_id=? ' +
    'AND status=? AND revision=? AND updated_at=? AND updated_by_staff_id=?'
  ).bind(eventId, app, input.date, studentId, status, revision, now, actor.id);
  let results;
  try { results = await env.DB.batch([currentStatement, casGuard, eventStatement]); }
  catch (error) {
    const racedEvent = await env.DB.prepare(
      'SELECT * FROM center_chat_events WHERE app=? AND item_id=? LIMIT 1'
    ).bind(app, eventId).first();
    if (samePresenceEvent(racedEvent, input)) {
      const eventDate = String(racedEvent.event_date);
      const savedCurrent = await env.DB.prepare(
        'SELECT * FROM center_chat_presence WHERE app=? AND presence_date=? AND student_id=? LIMIT 1'
      ).bind(app, eventDate, studentId).first();
      return json({ ok: true, idempotent: true, event: eventView(racedEvent),
        presence: savedCurrent && presenceView(savedCurrent) }, 200, origin);
    }
    if (!isTaskWriteCasConflict(error) && !/center_chat|CENTER_CHAT|UNIQUE/i.test(String(error && error.message || error))) throw error;
    const latest = await env.DB.prepare(
      'SELECT * FROM center_chat_presence WHERE app=? AND presence_date=? AND student_id=? LIMIT 1'
    ).bind(app, input.date, studentId).first();
    return json({ ok: false, code: 'CENTER_CHAT_PRESENCE_REVISION_CONFLICT',
      error: '학생 또는 직원 정보가 변경되었거나 다른 선생님이 먼저 상태를 변경했습니다',
      current: latest && presenceView(latest) }, 409, origin);
  }
  if (!results.every(result => changes(result) === 1)) throw new Error('CENTER_CHAT_PRESENCE_BATCH_INCOMPLETE');
  const [savedEvent, savedCurrent] = await Promise.all([
    env.DB.prepare('SELECT * FROM center_chat_events WHERE app=? AND item_id=? LIMIT 1')
      .bind(app, eventId).first(),
    env.DB.prepare('SELECT * FROM center_chat_presence WHERE app=? AND presence_date=? AND student_id=? LIMIT 1')
      .bind(app, input.date, studentId).first()
  ]);
  return json({ ok: true, idempotent: false, event: eventView(savedEvent),
    presence: presenceView(savedCurrent) }, 200, origin);
}

async function read(env, app, body, origin, actor, json) {
  const itemId = String(body.itemId || '');
  if (!MESSAGE_ID.test(itemId) && !EVENT_ID.test(itemId)) {
    return json({ ok: false, error: '읽은 마지막 소통 항목을 다시 확인해 주세요' }, 400, origin);
  }
  const item = await env.DB.prepare(
    'SELECT feed_seq,item_id FROM center_chat_events WHERE app=? AND item_id=? LIMIT 1'
  ).bind(app, itemId).first();
  if (!item) return json({ ok: false, error: '소통 항목을 찾을 수 없습니다' }, 404, origin);
  const requestNow = Date.now();
  const actorGuard = actorCondition(actor, app, 'read_actor');
  const result = await env.DB.prepare(
    'INSERT INTO center_chat_reads ' +
    '(app,reader_staff_id,read_through_feed_seq,read_through_item_id,updated_at) ' +
    'SELECT ?,?,?,?,? WHERE ' + actorGuard.sql + ' ' +
    'ON CONFLICT(app,reader_staff_id) DO UPDATE SET ' +
    'read_through_feed_seq=excluded.read_through_feed_seq,' +
    'read_through_item_id=excluded.read_through_item_id,updated_at=excluded.updated_at ' +
    'WHERE excluded.read_through_feed_seq>center_chat_reads.read_through_feed_seq'
  ).bind(app, actor.id, Number(item.feed_seq), itemId, requestNow, ...actorGuard.binds).run();
  const saved = await env.DB.prepare(
    'SELECT read_through_feed_seq,read_through_item_id FROM center_chat_reads ' +
    'WHERE app=? AND reader_staff_id=? LIMIT 1'
  ).bind(app, actor.id).first();
  if (!saved || (changes(result) === 0 && !await actorStillCurrent(env, app, actor))) {
    return json({ ok: false, code: 'CENTER_CHAT_ACTOR_CHANGED',
      error: '직원 정보가 변경되었습니다. 새로고침 후 다시 확인해 주세요' }, 409, origin);
  }
  return json({ ok: true, idempotent: changes(result) === 0,
    lastItemId: String(saved.read_through_item_id),
    unreadCount: await unreadCount(env, app, kstDate(requestNow), actor.id, saved.read_through_feed_seq) }, 200, origin);
}

function missingView(row) {
  return { studentId: row.student_id, requestId: row.request_id, state: row.state,
    actorName: row.actor_name, createdAt: row.created_at, handlerName: row.handler_name };
}

async function missingArrival(env, app, body, origin, actor, json) {
  const studentId = String(body.studentId || '');
  const now = Date.now(), date = kstDate(now);
  const roster = await rosterContext(env, app, date);
  const student = roster.students.find(row => row.id === studentId);
  if (!student) return json({ ok: false, error: '현재 재원생을 다시 선택해 주세요' }, 409, origin);
  const actorGuard = actorCondition(actor, app, 'missing_actor');
  const rosterGuard = activeStudentCondition(app, roster.data, studentId, date, 'missing');
  if (body.action === 'missing_handle') {
    if (actor.id !== 'director' && !managerIds(env).has(actor.id)) {
      return json({ ok: false, error: '관리자만 확인 중으로 변경할 수 있습니다' }, 403, origin);
    }
    await env.DB.prepare("UPDATE center_chat_missing SET state='handling',handler_id=?,handler_name=?,handled_at=? " +
      "WHERE app=? AND request_date=? AND student_id=? AND request_id=? AND state='open' AND " + actorGuard.sql + ' AND ' + rosterGuard.sql)
      .bind(actor.id, actor.name, now, app, date, studentId, String(body.requestId || ''), ...actorGuard.binds, ...rosterGuard.binds).run();
  } else {
    const requestId = String(body.requestId || '');
    if (!MESSAGE_ID.test(requestId)) return json({ ok: false, error: '요청 ID를 확인해 주세요' }, 400, origin);
    // INSERT와 알림 생성은 trigger 한 트랜잭션이다. 중복 클릭·동시 요청은 알림을 늘리지 않는다.
    await env.DB.prepare('INSERT OR IGNORE INTO center_chat_missing ' +
      '(app,request_date,student_id,request_id,student_name,actor_id,actor_name,created_at) ' +
      'SELECT ?,?,?,?,?,?,?,? WHERE ' + actorGuard.sql + ' AND ' + rosterGuard.sql +
      ' AND NOT EXISTS(SELECT 1 FROM center_chat_presence WHERE app=? AND presence_date=? AND student_id=?)')
      .bind(app, date, studentId, requestId, student.name, actor.id, actor.name, now,
        ...actorGuard.binds, ...rosterGuard.binds, app, date, studentId).run();
  }
  const saved = await env.DB.prepare('SELECT * FROM center_chat_missing WHERE app=? AND request_date=? AND student_id=?')
    .bind(app, date, studentId).first();
  if (!saved || saved.state === 'resolved') return json({ ok: false,
    error: '이미 등원·하원·결석으로 처리되었거나 요청이 마무리되었습니다. 수업 간 이동은 메시지로 알려 주세요.' }, 409, origin);
  return json({ ok: true, missing: missingView(saved) }, 200, origin);
}

async function finishMissing(env, app, body, origin, actor, json) {
  const requestId = String(body.requestId || '');
  const studentId = String(body.studentId || '');
  const outcome = body.action === 'missing_arrived' ? 'arrived' : 'closed';
  if (!MESSAGE_ID.test(requestId) || !SAFE_ID.test(studentId)) return json({ ok: false, error: '알림을 다시 선택해 주세요' }, 400, origin);
  // 요청별 종결 ID를 고정해 재시도·동시 클릭으로 등원 메시지가 두 번 나가지 않는다.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(app + '\n' + requestId));
  const itemId = 'ccm_' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const row = await env.DB.prepare('SELECT * FROM center_chat_missing WHERE app=? AND request_id=? AND student_id=?')
    .bind(app, requestId, studentId).first();
  if (!row) return json({ ok: false, error: '미등원 알림을 찾을 수 없습니다' }, 404, origin);
  const messageBody = row.student_name + (outcome === 'arrived' ? ' 등원하였습니다.' : ' 미등원 알림을 종료했습니다.');
  const resultForClosed = async () => {
    const saved = await env.DB.prepare('SELECT * FROM center_chat_events WHERE app=? AND item_id=?').bind(app, itemId).first();
    return saved && saved.body === messageBody
      ? json({ ok: true, idempotent: true, message: eventView(saved) }, 200, origin)
      : json({ ok: false, error: '이미 다른 방식으로 마무리된 알림입니다. 최신 내용을 확인해 주세요.' }, 409, origin);
  };
  if (row.state === 'resolved') return resultForClosed();
  const now = Date.now();
  const guard = actorCondition(actor, app, 'finish_actor');
  const update = env.DB.prepare("UPDATE center_chat_missing SET state='resolved',resolved_at=? " +
    "WHERE app=? AND request_id=? AND student_id=? AND state IN ('open','handling') AND " + guard.sql)
    .bind(now, app, requestId, studentId, ...guard.binds);
  const cas = await taskWriteCasGuardStatement(env, app, 'center_chat_missing_finish', requestId + '\n' + outcome + '\n' + now, now);
  const message = env.DB.prepare('INSERT INTO center_chat_events(app,kind,item_id,event_date,actor_staff_id,actor_name,body,created_at) ' +
    "VALUES(?,'message',?,?,?,?,?,?)").bind(app, itemId, kstDate(now), actor.id, actor.name, messageBody, now);
  try { await env.DB.batch([update, cas, message]); }
  catch (error) {
    if (!isTaskWriteCasConflict(error) && !/UNIQUE/i.test(String(error.message))) throw error;
    return resultForClosed();
  }
  return json({ ok: true, idempotent: false }, 200, origin);
}

export async function handleCenterChat(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '센터 소통은 업무지시서에서만 사용할 수 있습니다' }, 400, origin);
  if (!await tablesReady(env)) return json({ ok: false, code: 'CENTER_CHAT_NOT_READY',
    error: '센터 소통 기능을 준비하고 있습니다' }, 503, origin);
  const actor = await actorFor(env, app, auth);
  if (!actor) return json({ ok: false, error: '현재 재직 중인 직원 인증으로 다시 열어 주세요' }, 403, origin);
  const action = String(body && body.action || 'list');
  if (action === 'missing_arrived' || action === 'missing_close') return finishMissing(env, app, body, origin, actor, json);
  if (action === 'missing' || action === 'missing_handle') return missingArrival(env, app, body, origin, actor, json);
  if (action === 'list') return list(env, app, origin, actor, json);
  if (action === 'send') return send(env, app, body, origin, actor, json);
  if (action === 'presence') return presence(env, app, body, origin, actor, json);
  if (action === 'read') return read(env, app, body, origin, actor, json);
  return json({ ok: false, error: '지원하지 않는 센터 소통 작업입니다' }, 400, origin);
}
