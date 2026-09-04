const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STAFF_ATTENDANCE_PREFIX = '__att__';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function staffAttendanceDate(value = Date.now()) {
  return new Date(Number(value) + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function staffAttendanceKey(staffId, date) {
  return STAFF_ATTENDANCE_PREFIX + String(staffId || '') + '|' + String(date || '');
}

function parseData(row) {
  if (!row) return null;
  try {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (error) {
    return null;
  }
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function timestampMatchesDate(value, date) {
  const stamp = finiteTimestamp(value);
  return !!stamp && staffAttendanceDate(stamp) === date;
}

function activeAttendance(data, date) {
  return !!data && data.done === true && timestampMatchesDate(data.at, date);
}

function completedAttendance(data, date) {
  if (!activeAttendance(data, date)) return false;
  if (data.out == null || data.out === '') return false;
  const out = finiteTimestamp(data.out);
  return !!out && out >= finiteTimestamp(data.at) && timestampMatchesDate(out, date);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function withoutClientRevision(data) {
  const copy = { ...data };
  delete copy.updatedAt;
  return canonical(copy);
}

function sameAttendanceData(left, right) {
  return JSON.stringify(withoutClientRevision(left)) === JSON.stringify(withoutClientRevision(right));
}

/**
 * 출퇴근 쓰기는 서버 시각을 사용하는 전용 endpoint만 허용한다. generic /sync는
 * 기존 정본의 의미가 완전히 같은 재전송만 no-op으로 받아 오래된 캐시의 동기화 실패를 막는다.
 */
export async function inspectOwnStaffAttendanceChanges(env, app, staffId, entries) {
  const result = { error: null, skip: new Set() };
  if (app !== 'task') return result;
  const attendanceEntries = entries.filter(entry => entry && entry.table === 'checks' &&
    String(entry.change && entry.change.k || '').startsWith(STAFF_ATTENDANCE_PREFIX));
  if (!attendanceEntries.length) return result;

  const seen = new Set();
  for (const entry of attendanceEntries) {
    const change = entry.change;
    const key = String(change.k || '');
    if (seen.has(key)) {
      result.error = '한 번의 동기화에서 같은 출퇴근 기록을 여러 번 바꿀 수 없습니다';
      return result;
    }
    seen.add(key);
    const incoming = change.data;
    const row = await env.DB.prepare(
      'SELECT owner,data,updated_at,srv_at FROM checks WHERE app=? AND k=? LIMIT 1'
    ).bind(app, key).first();
    if (row && String(row.owner || '') !== staffId) {
      result.error = '다른 담당자의 출퇴근 기록은 변경할 수 없습니다';
      return result;
    }
    const current = parseData(row);
    if (row && current && sameAttendanceData(current, incoming)) {
      result.skip.add(entry);
      continue;
    }
    result.error = row
      ? '이미 저장된 출퇴근 기록은 관리자만 수정할 수 있습니다'
      : '출퇴근 기록은 출퇴근 버튼으로만 새로 저장할 수 있습니다';
    return result;
  }
  return result;
}

async function readAttendance(env, app, key) {
  const row = await env.DB.prepare(
    'SELECT owner,data,updated_at,srv_at FROM checks WHERE app=? AND k=? LIMIT 1'
  ).bind(app, key).first();
  return row ? { ...row, parsed: parseData(row) } : null;
}

function resultPayload(row, key, idempotent) {
  return {
    ok: true,
    key,
    owner: String(row.owner || ''),
    record: row.parsed,
    updatedAt: Number(row.updated_at) || Number(row.parsed && row.parsed.updatedAt) || 0,
    idempotent: !!idempotent
  };
}

/** 선생님은 서버 시각으로 최초 출근과 최초 퇴근만 기록한다. 관리자 교정은 기존 관리 화면에서 한다. */
export async function handleStaffAttendance(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '업무지시서에서만 사용할 수 있습니다' }, 400, origin);
  const action = String(body.action || '');
  if (!['clock_in', 'clock_out'].includes(action)) {
    return json({ ok: false, error: 'action은 clock_in 또는 clock_out이어야 합니다' }, 400, origin);
  }
  const staffId = String(auth && auth.id || '');
  if (!SAFE_ID.test(staffId)) {
    return json({ ok: false, code: 'STAFF_ATTENDANCE_PERSON_REQUIRED',
      error: '선생님 개인 인증이 필요합니다' }, 403, origin);
  }

  const requestTime = Date.now();
  const date = staffAttendanceDate(requestTime);
  const key = staffAttendanceKey(staffId, date);
  let current = await readAttendance(env, app, key);
  if (current && String(current.owner || '') !== staffId) {
    return json({ ok: false, code: 'STAFF_ATTENDANCE_OWNER_MISMATCH',
      error: '출퇴근 기록 소유자를 확인할 수 없습니다' }, 409, origin);
  }

  if (action === 'clock_in') {
    if (current && activeAttendance(current.parsed, date)) {
      return json(resultPayload(current, key, true), 200, origin);
    }
    const updatedAt = Math.max(requestTime, Number(current && current.updated_at || 0) + 1);
    const record = {
      taskId: STAFF_ATTENDANCE_PREFIX + staffId,
      date,
      done: true,
      note: '',
      steps: {},
      count: 0,
      blocked: false,
      at: requestTime,
      out: null,
      updatedAt
    };
    if (current) {
      await env.DB.prepare(
        'UPDATE checks SET owner=?,data=?,updated_at=?,srv_at=? ' +
        'WHERE app=? AND k=? AND owner=? AND updated_at=?'
      ).bind(staffId, JSON.stringify(record), updatedAt, updatedAt,
        app, key, staffId, Number(current.updated_at) || 0).run();
    } else {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
      ).bind(app, key, staffId, JSON.stringify(record), updatedAt, updatedAt).run();
    }
    current = await readAttendance(env, app, key);
    if (current && String(current.owner || '') === staffId && activeAttendance(current.parsed, date)) {
      return json(resultPayload(current, key, finiteTimestamp(current.parsed.at) !== requestTime), 200, origin);
    }
    return json({ ok: false, code: 'STAFF_ATTENDANCE_CLOCK_IN_CONFLICT',
      error: '출근 기록이 다른 기기에서 변경되었습니다. 새로고침 후 확인해 주세요' }, 409, origin);
  }

  if (!current || !activeAttendance(current.parsed, date)) {
    return json({ ok: false, code: 'STAFF_ATTENDANCE_CLOCK_IN_REQUIRED',
      error: '먼저 출근을 기록해 주세요' }, 409, origin);
  }
  if (completedAttendance(current.parsed, date)) {
    return json(resultPayload(current, key, true), 200, origin);
  }
  const clockInAt = finiteTimestamp(current.parsed.at);
  const clockOutAt = Math.max(requestTime, clockInAt);
  const updatedAt = Math.max(requestTime, Number(current.updated_at) + 1);
  const record = { ...current.parsed, done: true, at: clockInAt, out: clockOutAt, updatedAt };
  await env.DB.prepare(
    'UPDATE checks SET data=?,updated_at=?,srv_at=? ' +
    'WHERE app=? AND k=? AND owner=? AND updated_at=? ' +
    "AND json_extract(data,'$.done')=1 AND COALESCE(json_extract(data,'$.at'),0)=? " +
    "AND COALESCE(json_extract(data,'$.out'),0)=0"
  ).bind(JSON.stringify(record), updatedAt, updatedAt,
    app, key, staffId, Number(current.updated_at) || 0, clockInAt).run();
  const latest = await readAttendance(env, app, key);
  if (latest && String(latest.owner || '') === staffId && completedAttendance(latest.parsed, date)) {
    return json(resultPayload(latest, key, finiteTimestamp(latest.parsed.out) !== clockOutAt), 200, origin);
  }
  return json({ ok: false, code: 'STAFF_ATTENDANCE_CLOCK_OUT_CONFLICT',
    error: '퇴근 기록이 다른 기기에서 변경되었습니다. 새로고침 후 확인해 주세요' }, 409, origin);
}
