/**
 * 차량 운행 API. 설정은 전체 관리 권한만 교체하고, 기사 개인 링크는 오늘 본인 노선의
 * 승차·하차·결석만 기록한다. 노선 설정의 학원·공개 정류장 주소 외에 전화·보호자 정보나
 * 원생 명단의 개인 주소는 읽지도 응답하지도 않는다.
 *
 * POST /transport
 *   { action:'list', date }
 *   { action:'replace', config, revision }
 *   { action:'state', date, routeId, studentId, next, revision, reason? }
 *   { action:'plan', baseAddress, direction, startTime, dwellMinutes, stops }
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIRECTIONS = new Set(['pickup', 'dropoff']);
const STATES = new Set(['boarded', 'dropped', 'absent']);
const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_MAPS_BODY_BYTES = 256 * 1024;
const MAPS_TIMEOUT_MS = 25000;
const MAPS_GEOCODE_URL = 'https://maps.apigw.ntruss.com/map-geocode/v2/geocode';
const MAPS_DIRECTIONS_URL = 'https://maps.apigw.ntruss.com/map-direction/v1/driving';

function problem(message, status = 400, code = '') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) problem(path + ': 객체여야 합니다');
  return value;
}

function exactKeys(value, required, optional, path) {
  record(value, path);
  const allowed = new Set([...required, ...(optional || [])]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) problem(path + '.' + key + ': 필수 항목입니다');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) problem(path + '.' + key + ': 허용되지 않은 항목입니다');
  }
}

function cleanText(value, path, max, allowEmpty = false) {
  if (typeof value !== 'string') problem(path + ': 문자열이어야 합니다');
  const result = value.trim();
  if (!allowEmpty && !result) problem(path + ': 비어 있을 수 없습니다');
  if (result.length > max) problem(path + ': ' + max + '자를 넘을 수 없습니다');
  if (/[\u0000-\u001f\u007f]/.test(result)) problem(path + ': 제어 문자를 포함할 수 없습니다');
  return result;
}

function cleanId(value, path) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) problem(path + ': 올바른 ID가 아닙니다');
  return value;
}

function minutesOf(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function hhmm(minutes) {
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) problem(path + ': 0 이상의 정수여야 합니다');
  return value;
}

function parseDate(value, path = 'date') {
  const date = String(value || '');
  const parsed = new Date(date + 'T00:00:00Z');
  if (!ISO_DATE.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    problem(path + ': YYYY-MM-DD 형식의 실제 날짜여야 합니다');
  }
  return date;
}

function boundedLegacyDateKey(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 40 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function isBoardingLockError(error) {
  return /BOARDING_LOCK/.test(String(error && error.message || error || ''));
}

function kstToday(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(now));
}

function dayDistance(a, b) {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}

function weekday(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

function actor(auth) {
  if (auth && auth.id) return String(auth.id);
  return 'director';
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch (error) { return fallback; }
}

async function loadRoster(env) {
  const row = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind('task').first();
  if (!row) problem('원생 데이터가 아직 등록되지 않았습니다', 409, 'ROSTER_MISSING');
  const document = parseJson(row.data, null);
  const students = document && document.roster && document.roster.students;
  if (!Array.isArray(students)) problem('저장된 원생 데이터 형식이 올바르지 않습니다', 500, 'ROSTER_INVALID');
  return students;
}

function studentsForMonth(students, date) {
  const month = date.slice(0, 7);
  return students.filter(student => student && SAFE_ID.test(String(student.id || '')) &&
    String(student.start || '') <= month && (!student.end || String(student.end) > month));
}

async function activeStaff(env) {
  const result = await env.DB.prepare('SELECT id,data FROM staff WHERE app=?').bind('task').all();
  const map = new Map();
  for (const row of (result.results || [])) {
    const data = parseJson(row.data, null);
    if (!data || data.deleted || !SAFE_ID.test(String(row.id || ''))) continue;
    map.set(String(row.id), {
      id: String(row.id), staffId: String(row.id),
      name: String(data.name || row.id).trim().slice(0, 80) || String(row.id)
    });
  }
  return map;
}

function vehicle(value, index) {
  const path = 'config.vehicles[' + index + ']';
  exactKeys(value, ['id', 'name', 'plate', 'capacity'], [], path);
  if (!Number.isInteger(value.capacity) || value.capacity < 1 || value.capacity > 100) {
    problem(path + '.capacity: 1~100 사이의 정수여야 합니다');
  }
  return {
    id: cleanId(value.id, path + '.id'),
    name: cleanText(value.name, path + '.name', 80),
    plate: cleanText(value.plate, path + '.plate', 30),
    capacity: value.capacity
  };
}

function stop(value, routeIndex, index) {
  const path = 'config.routes[' + routeIndex + '].stops[' + index + ']';
  exactKeys(value, ['id', 'name', 'time', 'studentIds'], ['address'], path);
  if (!HHMM.test(String(value.time || ''))) problem(path + '.time: HH:MM 형식이어야 합니다');
  if (!Array.isArray(value.studentIds) || value.studentIds.length > 100) {
    problem(path + '.studentIds: 최대 100명의 배열이어야 합니다');
  }
  const result = {
    id: cleanId(value.id, path + '.id'),
    name: cleanText(value.name, path + '.name', 100),
    time: value.time,
    studentIds: value.studentIds.map((id, studentIndex) => cleanId(id, path + '.studentIds[' + studentIndex + ']'))
  };
  if (Object.prototype.hasOwnProperty.call(value, 'address')) {
    result.address = cleanText(value.address, path + '.address', 200, true);
  }
  return result;
}

function savedPlan(value, routeIndex) {
  const path = 'config.routes[' + routeIndex + '].plan';
  exactKeys(value, ['provider', 'distanceMeters', 'driveMinutes', 'serviceMinutes', 'dwellMinutes', 'plannedAt'], [], path);
  if (value.provider !== 'naver') problem(path + '.provider: naver여야 합니다');
  const distanceMeters = nonNegativeInteger(value.distanceMeters, path + '.distanceMeters');
  const driveMinutes = nonNegativeInteger(value.driveMinutes, path + '.driveMinutes');
  const serviceMinutes = nonNegativeInteger(value.serviceMinutes, path + '.serviceMinutes');
  const dwellMinutes = nonNegativeInteger(value.dwellMinutes, path + '.dwellMinutes');
  if (dwellMinutes > 60) problem(path + '.dwellMinutes: 60분을 초과할 수 없습니다');
  if (serviceMinutes < driveMinutes) problem(path + '.serviceMinutes: 운전 시간보다 짧을 수 없습니다');
  const plannedAt = nonNegativeInteger(value.plannedAt, path + '.plannedAt');
  return { provider: 'naver', distanceMeters, driveMinutes, serviceMinutes, dwellMinutes, plannedAt };
}

function route(value, index) {
  const path = 'config.routes[' + index + ']';
  exactKeys(value,
    ['id', 'name', 'direction', 'vehicleId', 'driverId', 'days', 'startTime', 'stops', 'active'], ['plan'], path);
  if (!DIRECTIONS.has(value.direction)) problem(path + '.direction: pickup 또는 dropoff여야 합니다');
  if (!Array.isArray(value.days) || !value.days.length || value.days.length > 7) {
    problem(path + '.days: 0~6 요일을 하나 이상 선택해야 합니다');
  }
  const days = value.days.map(Number);
  if (days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(days).size !== days.length) {
    problem(path + '.days: 중복 없는 0~6 정수 배열이어야 합니다');
  }
  if (!HHMM.test(String(value.startTime || ''))) problem(path + '.startTime: HH:MM 형식이어야 합니다');
  if (!Array.isArray(value.stops) || !value.stops.length || value.stops.length > 100) {
    problem(path + '.stops: 1~100개의 정류장이 필요합니다');
  }
  if (typeof value.active !== 'boolean') problem(path + '.active: true 또는 false여야 합니다');
  const result = {
    id: cleanId(value.id, path + '.id'),
    name: cleanText(value.name, path + '.name', 100),
    direction: value.direction,
    vehicleId: cleanId(value.vehicleId, path + '.vehicleId'),
    driverId: cleanId(value.driverId, path + '.driverId'),
    days: days.slice().sort((a, b) => a - b),
    startTime: value.startTime,
    stops: value.stops.map((item, stopIndex) => stop(item, index, stopIndex)),
    active: value.active
  };
  if (Object.prototype.hasOwnProperty.call(value, 'plan')) result.plan = savedPlan(value.plan, index);
  return result;
}

export function validateTransportConfig(raw, staffById, rosterById) {
  exactKeys(raw, ['vehicles', 'routes'], ['drivers', 'baseAddress'], 'config');
  if (!Array.isArray(raw.vehicles) || raw.vehicles.length > 100) problem('config.vehicles: 최대 100대의 배열이어야 합니다');
  if (!Array.isArray(raw.routes) || raw.routes.length > 300) problem('config.routes: 최대 300개 노선의 배열이어야 합니다');
  if (raw.drivers != null && !Array.isArray(raw.drivers)) problem('config.drivers: 배열이어야 합니다');
  const config = { vehicles: raw.vehicles.map(vehicle), routes: raw.routes.map(route) };
  if (Object.prototype.hasOwnProperty.call(raw, 'baseAddress')) {
    config.baseAddress = cleanText(raw.baseAddress, 'config.baseAddress', 200, true);
  }
  const vehicleById = new Map();
  const vehiclePlates = new Set();
  for (const item of config.vehicles) {
    if (vehicleById.has(item.id)) problem('config.vehicles: 중복 차량 ID가 있습니다: ' + item.id);
    const normalizedPlate = item.plate.toUpperCase().replace(/[^0-9A-Z가-힣]/g, '');
    if (vehiclePlates.has(normalizedPlate)) problem('config.vehicles: 중복 차량번호가 있습니다');
    vehiclePlates.add(normalizedPlate);
    vehicleById.set(item.id, item);
  }
  const routeIds = new Set();
  const assigned = new Set();
  for (const item of config.routes) {
    if (routeIds.has(item.id)) problem('config.routes: 중복 노선 ID가 있습니다: ' + item.id);
    routeIds.add(item.id);
    const assignedVehicle = vehicleById.get(item.vehicleId);
    if (!assignedVehicle) problem('config.routes.' + item.id + ': 등록된 차량을 선택해 주세요');
    if (!staffById.has(item.driverId)) problem('config.routes.' + item.id + ': 활성 운전 담당자를 선택해 주세요');
    const stopIds = new Set();
    const routeStudents = new Set();
    let previousStopMinutes = minutesOf(item.startTime);
    for (const itemStop of item.stops) {
      if (stopIds.has(itemStop.id)) problem('config.routes.' + item.id + ': 중복 정류장 ID가 있습니다: ' + itemStop.id);
      stopIds.add(itemStop.id);
      const stopMinutes = minutesOf(itemStop.time);
      if (stopMinutes < previousStopMinutes) {
        problem('config.routes.' + item.id + ': 정류장 시간은 출발시간부터 운행 순서대로 같거나 늦어야 합니다');
      }
      previousStopMinutes = stopMinutes;
      for (const studentId of itemStop.studentIds) {
        if (!rosterById.has(studentId)) problem('config.routes.' + item.id + ': 현재 원생이 아닌 학생입니다: ' + studentId);
        if (routeStudents.has(studentId)) problem('config.routes.' + item.id + ': 학생이 두 정류장에 중복 배정됐습니다: ' + studentId);
        routeStudents.add(studentId);
        if (item.active) {
          for (const day of item.days) {
            const key = item.direction + '|' + day + '|' + studentId;
            if (assigned.has(key)) problem('같은 요일·방향에 학생이 두 노선에 중복 배정됐습니다: ' + studentId);
            assigned.add(key);
          }
        }
      }
    }
    if (item.plan && minutesOf(item.startTime) + item.plan.serviceMinutes < previousStopMinutes) {
      problem('config.routes.' + item.id + ': 지도 계산 시간이 마지막 정류장 시간보다 짧을 수 없습니다');
    }
    if (routeStudents.size > assignedVehicle.capacity) {
      problem('config.routes.' + item.id + ': 탑승 학생 수가 차량 정원을 초과합니다');
    }
    if (item.plan && minutesOf(item.startTime) + item.plan.serviceMinutes > 1439) {
      problem('config.routes.' + item.id + ': 운행이 자정을 넘을 수 없습니다');
    }
  }
  const activeRoutes = config.routes.filter(item => item.active);
  for (let leftIndex = 0; leftIndex < activeRoutes.length; leftIndex += 1) {
    const left = activeRoutes[leftIndex];
    const leftStart = minutesOf(left.startTime);
    const leftCalculatedEnd = Math.max(minutesOf(left.stops.at(-1).time),
      left.plan ? leftStart + left.plan.serviceMinutes : leftStart);
    const leftEnd = Math.max(leftStart + 1, leftCalculatedEnd);
    for (let rightIndex = leftIndex + 1; rightIndex < activeRoutes.length; rightIndex += 1) {
      const right = activeRoutes[rightIndex];
      if (!left.days.some(day => right.days.includes(day))) continue;
      const rightStart = minutesOf(right.startTime);
      const rightCalculatedEnd = Math.max(minutesOf(right.stops.at(-1).time),
        right.plan ? rightStart + right.plan.serviceMinutes : rightStart);
      const rightEnd = Math.max(rightStart + 1, rightCalculatedEnd);
      if (leftStart >= rightEnd || rightStart >= leftEnd) continue;
      if (left.driverId === right.driverId) {
        problem('같은 요일·시간에 한 기사가 두 활성 노선을 운행할 수 없습니다: ' + left.name + ', ' + right.name);
      }
      if (left.vehicleId === right.vehicleId) {
        problem('같은 요일·시간에 한 차량을 두 활성 노선에 배정할 수 없습니다: ' + left.name + ', ' + right.name);
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(config)).length > MAX_CONFIG_BYTES) problem('config: 저장 용량을 초과했습니다', 413);
  return config;
}

async function loadConfig(env) {
  const row = await env.DB.prepare('SELECT data,updated_at,updated_by FROM transport_configs WHERE app=? LIMIT 1')
    .bind('task').first();
  if (!row) return { config: { vehicles: [], routes: [] }, revision: 0, updatedBy: '' };
  const config = parseJson(row.data, null);
  if (!config || !Array.isArray(config.vehicles) || !Array.isArray(config.routes)) {
    problem('저장된 차량 설정 형식이 올바르지 않습니다', 500, 'CONFIG_INVALID');
  }
  return { config, revision: Number(row.updated_at), updatedBy: String(row.updated_by || '') };
}

function studentStop(route, studentId) {
  for (const item of route.stops) if (item.studentIds.includes(studentId)) return item;
  return null;
}

function ensureReplaceDoesNotHideBoarded(oldConfig, nextConfig, rows) {
  const oldRoutes = new Map(oldConfig.routes.map(item => [item.id, item]));
  const nextRoutes = new Map(nextConfig.routes.map(item => [item.id, item]));
  const oldVehicles = new Map(oldConfig.vehicles.map(item => [item.id, item]));
  const nextVehicles = new Map(nextConfig.vehicles.map(item => [item.id, item]));
  for (const row of rows) {
    const oldRoute = oldRoutes.get(String(row.route_id));
    const nextRoute = nextRoutes.get(String(row.route_id));
    if (!nextRoute || !nextRoute.active || !studentStop(nextRoute, String(row.student_id))) {
      problem('승차 후 미하차 학생이 있는 노선·학생은 제거하거나 비활성화할 수 없습니다', 409, 'BOARDING_LOCK');
    }
    if (!oldRoute) continue; // 손상된 이전 설정을 정상 노선으로 복구하는 경우
    const oldVehicle = oldVehicles.get(oldRoute.vehicleId);
    const nextVehicle = nextVehicles.get(nextRoute.vehicleId);
    if (JSON.stringify(oldRoute) !== JSON.stringify(nextRoute) ||
        JSON.stringify(oldVehicle || null) !== JSON.stringify(nextVehicle || null)) {
      problem('승차 후 미하차 학생이 있는 노선·차량·담당자는 변경할 수 없습니다', 409, 'BOARDING_LOCK');
    }
  }
}

function stateView(row, includeHistory) {
  const result = {
    routeId: String(row.route_id), studentId: String(row.student_id), status: String(row.status),
    revision: Number(row.revision), boardedAt: row.boarded_at == null ? null : Number(row.boarded_at),
    boardedBy: row.boarded_by || '', droppedAt: row.dropped_at == null ? null : Number(row.dropped_at),
    droppedBy: row.dropped_by || '', absentAt: row.absent_at == null ? null : Number(row.absent_at),
    absentBy: row.absent_by || '', updatedAt: Number(row.updated_at)
  };
  if (includeHistory) result.history = parseJson(row.history, []);
  return result;
}

function scopedConfig(config, auth, drivers) {
  if (auth.scope === 'all') return { ...config, drivers: [...drivers.values()] };
  const routes = config.routes.filter(item => item.driverId === auth.id).map(routeForOwn);
  const vehicleIds = new Set(routes.map(item => item.vehicleId));
  return {
    vehicles: config.vehicles.filter(item => vehicleIds.has(item.id)),
    drivers: drivers.has(auth.id) ? [drivers.get(auth.id)] : [], routes
  };
}

function routeForOwn(item) {
  const { plan: _plan, ...routeItem } = item;
  return {
    ...routeItem,
    stops: item.stops.map(stopItem => {
      const { address: _address, ...safeStop } = stopItem;
      return safeStop;
    })
  };
}

function mapsCredentials(env) {
  const mapsId = String(env.NAVER_MAPS_ID || '').trim();
  const mapsSecret = String(env.NAVER_MAPS_SECRET || '').trim();
  if (mapsId && mapsSecret) {
    return { id: mapsId, secret: mapsSecret };
  }
  problem('지도 자동 계산 설정이 아직 완료되지 않았습니다', 503, 'MAPS_NOT_CONFIGURED');
}

function mapsConfigured(env) {
  return !!(String(env.NAVER_MAPS_ID || '').trim() && String(env.NAVER_MAPS_SECRET || '').trim());
}

function mapsFailure(status) {
  if (status === 401 || status === 403) {
    problem('지도 자동 계산 인증 설정을 확인해 주세요', 502, 'MAPS_AUTH_FAILED');
  }
  if (status === 429) {
    problem('네이버 클라우드에서 Geocoding과 Directions 5 API 사용 설정을 확인해 주세요', 502,
      'MAPS_NOT_ENABLED');
  }
  if (status >= 500) problem('지도 서비스가 잠시 응답하지 않습니다', 503, 'MAPS_UNAVAILABLE');
  problem('지도 서비스가 요청을 처리하지 못했습니다', 502, 'MAPS_PROVIDER_REJECTED');
}

async function boundedMapsJson(response, signal) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_MAPS_BODY_BYTES) {
    try { await response.body?.cancel(); } catch (error) { /* 응답 폐기 실패는 결과에 노출하지 않는다 */ }
    problem('지도 서비스 응답 형식이 올바르지 않습니다', 502, 'MAPS_INVALID_RESPONSE');
  }
  if (!response.body) problem('지도 서비스 응답 형식이 올바르지 않습니다', 502, 'MAPS_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MAPS_BODY_BYTES) {
        await reader.cancel();
        problem('지도 서비스 응답 형식이 올바르지 않습니다', 502, 'MAPS_INVALID_RESPONSE');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error && Number.isInteger(error.status) && /^MAPS_[A-Z_]+$/.test(String(error.code || ''))) throw error;
    if (signal.aborted) problem('지도 자동 계산 시간이 초과됐습니다', 504, 'MAPS_TIMEOUT');
    problem('지도 서비스 응답을 읽지 못했습니다', 503, 'MAPS_UNAVAILABLE');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    problem('지도 서비스 응답 형식이 올바르지 않습니다', 502, 'MAPS_INVALID_RESPONSE');
  }
}

async function fetchMapsJson(url, credentials, signal) {
  let response;
  try {
    response = await fetch(url, {
      method: 'GET', signal,
      headers: {
        Accept: 'application/json',
        'x-ncp-apigw-api-key-id': credentials.id,
        'x-ncp-apigw-api-key': credentials.secret
      }
    });
  } catch (error) {
    if (signal.aborted) problem('지도 자동 계산 시간이 초과됐습니다', 504, 'MAPS_TIMEOUT');
    problem('지도 서비스에 연결하지 못했습니다', 503, 'MAPS_UNAVAILABLE');
  }
  if (!response.ok) mapsFailure(response.status);
  return boundedMapsJson(response, signal);
}

function providerAddress(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function geocodeMaps(address, label, credentials, signal) {
  const url = new URL(MAPS_GEOCODE_URL);
  url.searchParams.set('query', address);
  url.searchParams.set('count', '1');
  const data = await fetchMapsJson(url.toString(), credentials, signal);
  const result = data && Array.isArray(data.addresses) ? data.addresses[0] : null;
  if (!result) problem(label + ' 위치를 찾을 수 없습니다', 422, 'ADDRESS_NOT_FOUND');
  const x = Number(result.x);
  const y = Number(result.y);
  const resolvedAddress = providerAddress(result.roadAddress) || providerAddress(result.jibunAddress);
  if (!Number.isFinite(x) || x < -180 || x > 180 || !Number.isFinite(y) || y < -90 || y > 90 ||
      !resolvedAddress) {
    problem('지도 서비스 응답 형식이 올바르지 않습니다', 502, 'MAPS_INVALID_RESPONSE');
  }
  return { x, y, address: resolvedAddress };
}

async function directionsLeg(start, goal, credentials, signal) {
  const url = new URL(MAPS_DIRECTIONS_URL);
  url.searchParams.set('start', start.x + ',' + start.y);
  url.searchParams.set('goal', goal.x + ',' + goal.y);
  url.searchParams.set('option', 'traoptimal');
  const data = await fetchMapsJson(url.toString(), credentials, signal);
  if (Number(data && data.code) !== 0) {
    problem('입력한 정류장 사이의 차량 경로를 찾을 수 없습니다', 422, 'ROUTE_NOT_FOUND');
  }
  const candidates = data && data.route && data.route.traoptimal;
  const summary = Array.isArray(candidates) && candidates[0] && candidates[0].summary;
  const distance = Number(summary && summary.distance);
  const duration = Number(summary && summary.duration);
  if (!Number.isSafeInteger(distance) || distance < 0 || !Number.isFinite(duration) || duration < 0) {
    problem('지도 서비스 응답 형식이 올바르지 않습니다', 502, 'MAPS_INVALID_RESPONSE');
  }
  return { distance, minutes: Math.ceil(duration / 60000) };
}

function planStop(value, index) {
  const path = 'stops[' + index + ']';
  exactKeys(value, ['id', 'name', 'address'], [], path);
  return {
    id: cleanId(value.id, path + '.id'),
    name: cleanText(value.name, path + '.name', 100),
    address: cleanText(value.address, path + '.address', 200)
  };
}

async function planTransport(env, body, auth) {
  if (auth.scope !== 'all') problem('노선 자동 계산은 전체 관리 권한만 사용할 수 있습니다', 403, 'FORBIDDEN');
  exactKeys(body, ['action', 'baseAddress', 'direction', 'startTime', 'dwellMinutes', 'stops'],
    ['app', 'auth'], 'request');
  const baseAddress = cleanText(body.baseAddress, 'baseAddress', 200);
  if (!DIRECTIONS.has(body.direction)) problem('direction: pickup 또는 dropoff여야 합니다');
  if (!HHMM.test(String(body.startTime || ''))) problem('startTime: HH:MM 형식이어야 합니다');
  if (!Number.isInteger(body.dwellMinutes) || body.dwellMinutes < 0 || body.dwellMinutes > 60) {
    problem('dwellMinutes: 0~60 사이의 정수여야 합니다');
  }
  if (!Array.isArray(body.stops) || body.stops.length < 1 || body.stops.length > 15) {
    problem('stops: 1~15개의 정류장이 필요합니다');
  }
  const stops = body.stops.map(planStop);
  if (new Set(stops.map(item => item.id)).size !== stops.length) problem('stops: 중복 정류장 ID가 있습니다');
  const credentials = mapsCredentials(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAPS_TIMEOUT_MS);
  try {
    const base = await geocodeMaps(baseAddress, '학원 주소', credentials, controller.signal);
    const resolvedStops = [];
    for (let index = 0; index < stops.length; index += 1) {
      resolvedStops.push(await geocodeMaps(stops[index].address, '정류장 ' + (index + 1),
        credentials, controller.signal));
    }
    // 등원은 학원 차고지 출발 → 각 정류장 승차 → 학원 도착 전체를 계산한다.
    // 첫 정류장부터 계산하면 실제 출발·기사/차량 점유 시간이 과소 표시된다.
    const points = body.direction === 'dropoff' ? [base, ...resolvedStops] : [base, ...resolvedStops, base];
    const legs = [];
    for (let index = 1; index < points.length; index += 1) {
      legs.push(await directionsLeg(points[index - 1], points[index], credentials, controller.signal));
    }
    const suggestedStops = [];
    let elapsed = 0;
    if (body.direction === 'pickup') {
      for (let index = 0; index < stops.length; index += 1) {
        elapsed += legs[index].minutes;
        suggestedStops.push({ id: stops[index].id, time: hhmm(minutesOf(body.startTime) + elapsed),
          address: resolvedStops[index].address });
        elapsed += body.dwellMinutes;
      }
      elapsed += legs.at(-1).minutes;
    } else {
      for (let index = 0; index < legs.length; index += 1) {
        elapsed += legs[index].minutes;
        suggestedStops.push({ id: stops[index].id, time: hhmm(minutesOf(body.startTime) + elapsed),
          address: resolvedStops[index].address });
        elapsed += body.dwellMinutes;
      }
    }
    if (minutesOf(body.startTime) + elapsed > 1439) {
      problem('자동 계산한 운행이 자정을 넘습니다. 출발시간이나 노선을 조정해 주세요', 422,
        'ROUTE_CROSSES_MIDNIGHT');
    }
    const plan = {
      provider: 'naver',
      distanceMeters: legs.reduce((sum, item) => sum + item.distance, 0),
      driveMinutes: legs.reduce((sum, item) => sum + item.minutes, 0),
      serviceMinutes: elapsed,
      dwellMinutes: body.dwellMinutes,
      plannedAt: Date.now()
    };
    return { ok: true, plan, suggestedStops, trafficBased: true };
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}

async function listTransport(env, body, auth) {
  const date = parseDate(body.date);
  const today = kstToday();
  if (Math.abs(dayDistance(date, today)) > 31) problem('오늘 기준 31일 이내의 운행만 조회할 수 있습니다', 400, 'DATE_RANGE');
  const loaded = await loadConfig(env);
  const drivers = await activeStaff(env);
  const roster = await loadRoster(env);
  const rosterById = new Map(studentsForMonth(roster, date).map(item => [String(item.id), item]));
  const scopeRoutes = loaded.config.routes.filter(item => auth.scope === 'all' || item.driverId === auth.id);
  const dayRoutes = scopeRoutes.filter(item => item.active && item.days.includes(weekday(date)));
  const stateRows = await env.DB.prepare('SELECT * FROM transport_states WHERE app=? AND date=? ORDER BY route_id,student_id')
    .bind('task', date).all();
  const allowedRouteIds = new Set(scopeRoutes.map(item => item.id));
  const rows = (stateRows.results || []).filter(row => auth.scope === 'all' || allowedRouteIds.has(String(row.route_id)));
  const byKey = new Map(rows.map(row => [String(row.route_id) + '|' + String(row.student_id), row]));
  const routes = dayRoutes.map(item => {
    const students = [];
    for (const itemStop of item.stops) {
      for (const studentId of itemStop.studentIds) {
        const student = rosterById.get(studentId);
        if (!student) continue;
        const state = byKey.get(item.id + '|' + studentId);
        students.push({
          id: studentId, name: String(student.name || ''), grade: String(student.grade || ''),
          stop: { id: itemStop.id, name: itemStop.name, time: itemStop.time },
          status: state ? String(state.status) : 'scheduled', revision: state ? Number(state.revision) : 0
        });
      }
    }
    return { ...(auth.scope === 'all' ? item : routeForOwn(item)), students };
  });
  const warnings = [];
  const configRoutes = new Map(loaded.config.routes.map(item => [item.id, item]));
  if (auth.scope === 'all') {
    const vehicleIds = new Set(loaded.config.vehicles.map(item => item.id));
    for (const row of rows) {
      if (row.status !== 'boarded') continue;
      const routeItem = configRoutes.get(String(row.route_id));
      if (!routeItem || !routeItem.active || !routeItem.days.includes(weekday(date)) ||
          !studentStop(routeItem, String(row.student_id)) || !vehicleIds.has(routeItem.vehicleId) ||
          !drivers.has(routeItem.driverId) || !rosterById.has(String(row.student_id))) {
        warnings.push({ code: 'ORPHAN_BOARDED', routeId: String(row.route_id), studentId: String(row.student_id),
          message: '설정에서 누락된 승차 후 미하차 기록이 있습니다' });
      }
    }
  }
  const statusByKey = new Map();
  for (const item of routes) {
    for (const student of item.students) statusByKey.set(item.id + '|' + student.id, student.status);
  }
  const expected = statusByKey.size;
  for (const warning of warnings) {
    if (warning.code === 'ORPHAN_BOARDED') {
      statusByKey.set(warning.routeId + '|' + warning.studentId, 'boarded');
    }
  }
  const counts = { scheduled: 0, boarded: 0, dropped: 0, absent: 0 };
  for (const status of statusByKey.values()) counts[status] += 1;
  let unresolved = [];
  if (auth.scope === 'all') {
    const allBoarded = await env.DB.prepare(
      "SELECT date,route_id,student_id,status,revision FROM transport_states " +
      "WHERE app=? AND status='boarded' ORDER BY date,updated_at LIMIT 101"
    ).bind('task').all();
    const unresolvedRows = allBoarded.results || [];
    const rosterAllById = new Map(roster.filter(item => item && item.id).map(item => [String(item.id), item]));
    unresolved = unresolvedRows.slice(0, 100).map(row => {
      const routeItem = configRoutes.get(String(row.route_id));
      const student = rosterAllById.get(String(row.student_id));
      return {
        date: String(row.date), routeId: String(row.route_id), studentId: String(row.student_id),
        revision: Number(row.revision), status: 'boarded',
        routeName: routeItem ? String(routeItem.name || '').slice(0, 100) : '설정에서 제외된 노선',
        studentName: student ? String(student.name || '').slice(0, 40) : '명단에서 제외된 학생'
      };
    });
    if (unresolvedRows.length > 100) {
      warnings.push({ code: 'UNRESOLVED_TRUNCATED', message: '미하차 기록이 100건을 초과해 오래된 100건만 표시합니다' });
    }
  }
  const response = {
    ok: true, date, config: scopedConfig(loaded.config, auth, drivers), routes,
    states: rows.map(row => stateView(row, auth.scope === 'all')), revision: loaded.revision,
    warnings, summary: { expected, ...counts, completed: expected > 0 && counts.scheduled === 0 && counts.boarded === 0 }
  };
  if (auth.scope === 'all') {
    response.unresolved = unresolved;
    response.capabilities = { mapsPlanning: mapsConfigured(env) };
  }
  return response;
}

async function replaceConfig(env, body, auth) {
  if (auth.scope !== 'all') problem('차량 설정은 전체 관리 권한만 변경할 수 있습니다', 403, 'FORBIDDEN');
  const expected = Number(body.revision);
  if (!Number.isSafeInteger(expected) || expected < 0) problem('현재 설정 revision이 필요합니다');
  const loaded = await loadConfig(env);
  if (loaded.revision !== expected) problem('차량 설정이 바뀌었습니다. 새로고침 후 다시 저장해 주세요', 409, 'STALE_REVISION');
  const today = kstToday();
  const roster = await loadRoster(env);
  const rosterById = new Map(studentsForMonth(roster, today).map(item => [String(item.id), item]));
  const drivers = await activeStaff(env);
  const next = validateTransportConfig(body.config, drivers, rosterById);
  const boarded = await env.DB.prepare(
    "SELECT date,route_id,student_id FROM transport_states WHERE app=? AND status='boarded'"
  ).bind('task').all();
  ensureReplaceDoesNotHideBoarded(loaded.config, next, boarded.results || []);
  const now = Date.now();
  const nextRevision = Math.max(now, loaded.revision + 1);
  let result;
  if (!loaded.revision) {
    result = await env.DB.prepare(
      'INSERT OR IGNORE INTO transport_configs(app,data,updated_at,updated_by) VALUES(?,?,?,?)'
    ).bind('task', JSON.stringify(next), nextRevision, actor(auth)).run();
  } else {
    result = await env.DB.prepare(
      'UPDATE transport_configs SET data=?,updated_at=?,updated_by=? WHERE app=? AND updated_at=?'
    ).bind(JSON.stringify(next), nextRevision, actor(auth), 'task', expected).run();
  }
  if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
    problem('차량 설정이 바뀌었습니다. 새로고침 후 다시 저장해 주세요', 409, 'STALE_REVISION');
  }
  return { ok: true, config: { ...next, drivers: [...drivers.values()] }, revision: nextRevision };
}

function appendHistory(row, event) {
  const history = row ? parseJson(row.history, []) : [];
  const safe = Array.isArray(history) ? history.slice(-99) : [];
  safe.push(event);
  return JSON.stringify(safe);
}

async function resetState(env, date, routeId, studentId, expected, reason, auth) {
  const current = await env.DB.prepare(
    'SELECT * FROM transport_states WHERE app=? AND date=? AND route_id=? AND student_id=? LIMIT 1'
  ).bind('task', date, routeId, studentId).first();
  const revision = current ? Number(current.revision) : 0;
  if (revision !== expected) problem('상태가 바뀌었습니다. 새로고침 후 다시 처리해 주세요', 409, 'STALE_REVISION');
  if (!current) return { ok: true, idempotent: true, state: { routeId, studentId, status: 'scheduled', revision: 0 } };
  if (current.status === 'scheduled') return { ok: true, idempotent: true, state: stateView(current, true) };
  const now = Date.now();
  const by = actor(auth);
  const event = { from: String(current.status), to: 'scheduled', at: now, by, reason };
  const reset = await env.DB.prepare(
    "UPDATE transport_states SET status='scheduled',revision=revision+1," +
    'boarded_at=NULL,boarded_by=NULL,dropped_at=NULL,dropped_by=NULL,absent_at=NULL,absent_by=NULL,' +
    'history=?,updated_at=? WHERE app=? AND date=? AND route_id=? AND student_id=? AND revision=? AND status=?'
  ).bind(appendHistory(current, event), now, 'task', date, routeId, studentId, expected, String(current.status)).run();
  if (Number(reset && reset.meta && reset.meta.changes || 0) !== 1) {
    problem('상태가 바뀌었습니다. 새로고침 후 다시 처리해 주세요', 409, 'STALE_REVISION');
  }
  const saved = await env.DB.prepare(
    'SELECT * FROM transport_states WHERE app=? AND date=? AND route_id=? AND student_id=? LIMIT 1'
  ).bind('task', date, routeId, studentId).first();
  return { ok: true, idempotent: false, state: stateView(saved, true) };
}

async function changeState(env, body, auth) {
  const routeId = cleanId(body.routeId, 'routeId');
  const studentId = cleanId(body.studentId, 'studentId');
  const expected = Number(body.revision);
  if (!Number.isInteger(expected) || expected < 0) problem('현재 상태 revision이 필요합니다');
  const next = String(body.next || '');
  if (!STATES.has(next) && next !== 'scheduled') problem('next는 boarded, dropped, absent 또는 scheduled여야 합니다');
  const reason = body.reason == null ? '' : cleanText(body.reason, 'reason', 500, true);
  if (next === 'scheduled' && auth.scope !== 'all') problem('상태 초기화는 전체 관리 권한만 할 수 있습니다', 403, 'RESET_FORBIDDEN');
  if (next === 'scheduled' && !reason) problem('상태 초기화 사유를 입력해 주세요');
  let date;
  try { date = parseDate(body.date); }
  catch (error) {
    // 023 이전에 잘못 저장된 날짜 키도 원장이 정확한 PK와 revision을 지정하면
    // 이력은 보존한 채 scheduled로 되돌릴 수 있다. 새 상태 기록에는 계속 ISO 날짜만 허용한다.
    if (next === 'scheduled' && auth.scope === 'all' && boundedLegacyDateKey(body.date)) {
      return await resetState(env, body.date, routeId, studentId, expected, reason, auth);
    }
    throw error;
  }
  const today = kstToday();
  if (auth.scope === 'own' && date !== today) problem('기사 개인 링크에서는 오늘 운행만 처리할 수 있습니다', 403, 'DATE_FORBIDDEN');
  if (next === 'scheduled') return await resetState(env, date, routeId, studentId, expected, reason, auth);
  if (auth.scope === 'all' && Math.abs(dayDistance(date, today)) > 31) problem('오늘 기준 31일 이내의 운행만 처리할 수 있습니다', 400, 'DATE_RANGE');
  const loaded = await loadConfig(env);
  const routeItem = loaded.config.routes.find(item => item.id === routeId);
  if (!routeItem || !routeItem.active || !routeItem.days.includes(weekday(date))) {
    problem('해당 날짜에 운행하는 활성 노선을 찾을 수 없습니다', 409, 'ROUTE_INACTIVE');
  }
  const drivers = await activeStaff(env);
  if (!drivers.has(routeItem.driverId) || !loaded.config.vehicles.some(item => item.id === routeItem.vehicleId)) {
    problem('노선의 차량 또는 운전 담당자 설정을 확인해 주세요', 409, 'ROUTE_INVALID');
  }
  if (auth.scope === 'own' && routeItem.driverId !== auth.id) problem('본인 담당 노선만 처리할 수 있습니다', 403, 'FORBIDDEN');
  if (!studentStop(routeItem, studentId)) problem('해당 노선에 배정된 학생이 아닙니다', 409, 'STUDENT_NOT_ASSIGNED');
  const roster = await loadRoster(env);
  if (!studentsForMonth(roster, date).some(item => String(item.id) === studentId)) {
    problem('현재 원생 명단에서 학생을 찾을 수 없습니다', 409, 'STUDENT_INACTIVE');
  }
  const current = await env.DB.prepare(
    'SELECT * FROM transport_states WHERE app=? AND date=? AND route_id=? AND student_id=? LIMIT 1'
  ).bind('task', date, routeId, studentId).first();
  const revision = current ? Number(current.revision) : 0;
  if (revision !== expected) problem('상태가 바뀌었습니다. 새로고침 후 다시 처리해 주세요', 409, 'STALE_REVISION');
  const currentStatus = current ? String(current.status) : 'scheduled';
  if (!((currentStatus === 'scheduled' && (next === 'boarded' || next === 'absent')) ||
        (currentStatus === 'boarded' && next === 'dropped'))) {
    problem('허용되지 않은 상태 변경입니다: ' + currentStatus + ' → ' + next, 409, 'INVALID_TRANSITION');
  }
  const now = Date.now();
  const by = actor(auth);
  const event = { from: currentStatus, to: next, at: now, by };
  if (reason) event.reason = reason;
  let result;
  if (!current) {
    result = await env.DB.prepare(
      'INSERT OR IGNORE INTO transport_states ' +
      '(app,date,route_id,student_id,status,revision,boarded_at,boarded_by,dropped_at,dropped_by,absent_at,absent_by,history,updated_at) ' +
      'VALUES(?,?,?,?,?,1,?,?,NULL,NULL,?,?,?,?)'
    ).bind('task', date, routeId, studentId, next,
      next === 'boarded' ? now : null, next === 'boarded' ? by : null,
      next === 'absent' ? now : null, next === 'absent' ? by : null,
      appendHistory(null, event), now).run();
  } else {
    result = await env.DB.prepare(
      'UPDATE transport_states SET status=?,revision=revision+1,' +
      'boarded_at=?,boarded_by=?,dropped_at=?,dropped_by=?,absent_at=?,absent_by=?,history=?,updated_at=? ' +
      'WHERE app=? AND date=? AND route_id=? AND student_id=? AND revision=? AND status=?'
    ).bind(next,
      next === 'boarded' ? now : current.boarded_at, next === 'boarded' ? by : current.boarded_by,
      next === 'dropped' ? now : null, next === 'dropped' ? by : null,
      next === 'absent' ? now : null, next === 'absent' ? by : null,
      appendHistory(current, event), now, 'task', date, routeId, studentId, expected, currentStatus).run();
  }
  if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
    problem('상태가 바뀌었습니다. 새로고침 후 다시 처리해 주세요', 409, 'STALE_REVISION');
  }
  const saved = await env.DB.prepare(
    'SELECT * FROM transport_states WHERE app=? AND date=? AND route_id=? AND student_id=? LIMIT 1'
  ).bind('task', date, routeId, studentId).first();
  return { ok: true, idempotent: false, state: stateView(saved, auth.scope === 'all') };
}

export async function handleTransport(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '차량 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  try {
    const action = String(body.action || 'list');
    let result;
    if (action === 'list') result = await listTransport(env, body, auth);
    else if (action === 'replace') result = await replaceConfig(env, body, auth);
    else if (action === 'state') result = await changeState(env, body, auth);
    else if (action === 'plan') result = await planTransport(env, body, auth);
    else problem('action은 list, replace, state 또는 plan이어야 합니다');
    return json(result, 200, origin);
  } catch (error) {
    const boardingLock = isBoardingLockError(error);
    return json({
      ok: false,
      ...(boardingLock ? { code: 'BOARDING_LOCK' } : (error.code ? { code: error.code } : {})),
      error: boardingLock
        ? '승차 후 미하차 기록이 남아 있어 변경할 수 없습니다. 하차·인계 또는 사유 있는 상태 초기화를 먼저 완료해 주세요'
        : String(error.message || error)
    }, boardingLock ? 409 : (error.status || 400), origin);
  }
}
