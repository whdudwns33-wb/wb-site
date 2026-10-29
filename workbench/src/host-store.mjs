import {DatabaseSync} from 'node:sqlite';
import {randomBytes, randomUUID, createHash, createHmac, scrypt, timingSafeEqual, createCipheriv, createDecipheriv, hkdfSync} from 'node:crypto';
import {promisify} from 'node:util';

const derive = promisify(scrypt), hash = value => createHash('sha256').update(value).digest('hex');
const KDF = {N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024};
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const token = () => randomBytes(32).toString('base64url');
const equal = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); };
const identity = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
const safeUser = user => ({id: user.id, username: user.username, name: user.name, role: user.role, mustChangePassword: !!user.must_change});
export function validateWorkspace(data) {
  if (!data || Array.isArray(data) || !Array.isArray(data.students) || data.students.length > 5000) fail(400, '학생 목록 형식을 확인하세요.');
  const seen = new Set();
  for (const student of data.students) {
    if (!student || !['string', 'number'].includes(typeof student.id) || !String(student.id) || seen.has(String(student.id)) || typeof student.name !== 'string' || !student.name.trim()) fail(400, '학생 식별자와 이름을 확인하세요.');
    seen.add(String(student.id));
    for (const key of ['apply', 'grades', 'exams', 'saenggibu', 'tasks', 'records', 'planners']) if (student[key] != null && !Array.isArray(student[key])) fail(400, '학생 기록 목록 형식을 확인하세요.');
    if (student.consult != null && (Array.isArray(student.consult) || typeof student.consult !== 'object')) fail(400, '상담 기록 형식을 확인하세요.');
    for (const key of ['reports']) if (student.consult?.[key] != null && !Array.isArray(student.consult[key])) fail(400, '보고서 목록 형식을 확인하세요.');
    for (const key of ['exams', 'plans', 'history']) if (student.consult?.jeongsi?.[key] != null && !Array.isArray(student.consult.jeongsi[key])) fail(400, '정시 기록 목록 형식을 확인하세요.');
  }
  for (const key of ['adiga', 'ipdb', 'hsdb', 'partners', 'trends', 'lessons']) if (data[key] != null && !Array.isArray(data[key])) fail(400, '분석 자료 목록 형식을 확인하세요.');
  JSON.stringify(data, (key, value) => { if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(400, '허용하지 않는 자료 필드입니다.'); return value; });
  return data;
}

export function createHostStore(file, appKey, {clock = Date.now} = {}) {
  if (!Buffer.isBuffer(appKey) || appKey.length !== 32) throw Error('A valid application key is required.');
  const key = Buffer.from(hkdfSync('sha256', appKey, Buffer.alloc(0), 'wb-workbench-records-v1', 32));
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role='admin'),salt TEXT NOT NULL,password_hash TEXT NOT NULL,must_change INTEGER NOT NULL DEFAULT 1,failures INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES accounts(id),csrf_hash TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS api_tokens(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL REFERENCES accounts(id),name TEXT NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots(revision INTEGER PRIMARY KEY AUTOINCREMENT,iv BLOB NOT NULL,cipher BLOB NOT NULL,tag BLOB NOT NULL,sha256 TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,created INTEGER NOT NULL);`);
  let activeHashes = 0;
  async function passwordHash(password, salt) {
    if (activeHashes >= 2) fail(429, '로그인 요청이 많습니다. 잠시 후 다시 시도하세요.');
    activeHashes++;
    try { return (await derive(password, salt, 64, KDF)).toString('hex'); } finally { activeHashes--; }
  }
  const audit = (actor, action) => db.prepare('INSERT INTO audit(actor,action,created) VALUES(?,?,?)').run(actor, action, clock());
  const userById = id => db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  async function bootstrap(accounts, data) {
    if (db.prepare('SELECT count(*) AS n FROM accounts').get().n) fail(409, '계정이 이미 초기화되어 있습니다.');
    validateWorkspace(data);
    const prepared = [];
    for (const account of accounts) {
      const username = identity(account.username);
      if (!/^[\p{L}\p{N}_.-]{2,40}$/u.test(username) || !account.name || typeof account.password !== 'string' || !account.password || account.password.length > 128) fail(400, '초기 계정 정보를 확인하세요.');
      const salt = randomBytes(16).toString('hex');
      prepared.push({...account, username, salt, passwordHash: await passwordHash(account.password, salt)});
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT count(*) AS n FROM accounts').get().n) fail(409, '계정이 이미 초기화되어 있습니다.');
      for (const account of prepared) db.prepare('INSERT INTO accounts(id,username,name,role,salt,password_hash) VALUES(?,?,?,?,?,?)').run(randomUUID(), account.username, account.name, 'admin', account.salt, account.passwordHash);
      appendSnapshot(data, 'bootstrap');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function newSession(user) {
    const raw = token(), csrf = createHmac('sha256', key).update(raw).digest('base64url');
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(clock());
    db.prepare('INSERT INTO sessions(hash,user_id,csrf_hash,expires) VALUES(?,?,?,?)').run(hash(raw), user.id, hash(csrf), clock() + 8 * 3600000);
    return {token: raw, csrf, user: safeUser(user)};
  }
  async function login(username, password) {
    if (typeof password !== 'string' || password.length > 128 || !password) fail(401, '아이디 또는 비밀번호를 확인하세요.');
    const user = db.prepare('SELECT * FROM accounts WHERE username=?').get(identity(username));
    if (user?.locked_until > clock()) fail(429, '로그인 시도가 잠겨 있습니다. 15분 후 다시 시도하세요.');
    const candidate = await passwordHash(password, user?.salt || 'wb-unregistered-account');
    const current = user && userById(user.id);
    if (!current || current.password_hash !== user.password_hash || !equal(candidate, current.password_hash)) {
      if (current) db.prepare('UPDATE accounts SET failures=failures+1,locked_until=CASE WHEN failures>=4 THEN ? ELSE locked_until END WHERE id=?').run(clock() + 900000, current.id);
      fail(401, '아이디 또는 비밀번호를 확인하세요.');
    }
    if (current.locked_until > clock()) fail(429, '로그인 시도가 잠겨 있습니다. 15분 후 다시 시도하세요.');
    db.prepare('UPDATE accounts SET failures=0,locked_until=0 WHERE id=?').run(user.id);
    audit(user.id, 'login');
    return newSession(current);
  }
  function authenticate(raw, bearer = false) {
    if (typeof raw !== 'string' || raw.length > 100 || !raw) return null;
    const row = bearer ? db.prepare('SELECT user_id FROM api_tokens WHERE hash=? AND expires>?').get(hash(raw), clock()) : db.prepare('SELECT user_id,csrf_hash FROM sessions WHERE hash=? AND expires>?').get(hash(raw), clock());
    if (!row) return null;
    const user = userById(row.user_id);
    if (!user || (bearer && user.must_change)) return null;
    return {user: safeUser(user), csrfHash: row.csrf_hash, csrf: bearer ? null : createHmac('sha256', key).update(raw).digest('base64url'), hash: hash(raw), bearer};
  }
  async function changePassword(principal, currentPassword, nextPassword) {
    if (typeof currentPassword !== 'string' || currentPassword.length > 128 || typeof nextPassword !== 'string' || nextPassword.length < 12 || nextPassword.length > 128 || nextPassword === currentPassword) fail(400, '기존 비밀번호와 다른 12~128자 새 비밀번호를 입력하세요.');
    const user = userById(principal.user.id);
    if (!equal(await passwordHash(currentPassword, user.salt), user.password_hash)) fail(401, '현재 비밀번호를 확인하세요.');
    const salt = randomBytes(16).toString('hex'), nextHash = await passwordHash(nextPassword, salt);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (userById(user.id).password_hash !== user.password_hash) fail(409, '비밀번호가 변경되었습니다. 다시 로그인하세요.');
      db.prepare('UPDATE accounts SET password_hash=?,salt=?,must_change=0,failures=0,locked_until=0 WHERE id=?').run(nextHash, salt, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      db.prepare('DELETE FROM api_tokens WHERE user_id=?').run(user.id);
      audit(user.id, 'password_changed');
      const session = newSession(userById(user.id));
      db.exec('COMMIT');
      return session;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async function confirmAdministrator(principal, currentPassword) {
    const actor = userById(principal.user.id);
    const activeSession = () => db.prepare('SELECT 1 FROM sessions WHERE hash=? AND user_id=? AND expires>?').get(principal.hash, actor?.id || '', clock());
    if (principal.bearer || !actor || actor.role !== 'admin' || actor.must_change || !activeSession()) fail(403, '비밀번호를 변경한 관리자 계정으로 다시 로그인하세요.');
    if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 128) fail(400, '본인의 현재 비밀번호를 입력하세요.');
    const check = () => {
      const current = userById(actor.id);
      if (!activeSession() || current?.password_hash !== actor.password_hash || current.role !== 'admin' || current.must_change) fail(409, '계정 상태가 바뀌었습니다. 다시 로그인하세요.');
      if (current.locked_until > clock()) fail(429, '비밀번호 확인이 잠겨 있습니다. 15분 후 다시 시도하세요.');
    };
    check();
    const candidate = await passwordHash(currentPassword, actor.salt), current = userById(actor.id);
    check();
    if (!equal(candidate, current.password_hash)) {
      db.prepare('UPDATE accounts SET failures=failures+1,locked_until=CASE WHEN failures>=4 THEN ? ELSE locked_until END WHERE id=?').run(clock() + 900000, actor.id);
      fail(401, '본인의 현재 비밀번호를 확인하세요.');
    }
    return {actor, check};
  }
  async function registerUser(principal, {username: value, name, currentPassword, temporaryPassword}) {
    const username = identity(value);
    if (!/^[\p{L}\p{N}_.-]{2,40}$/u.test(username) || typeof name !== 'string' || !name.trim() || name.length > 60 || /[\p{C}<>]/u.test(name)) fail(400, '이름은 1~60자, 아이디는 문자·숫자·밑줄·점·하이픈 2~40자로 입력하세요.');
    if (typeof temporaryPassword !== 'string' || temporaryPassword.length < 4 || temporaryPassword.length > 128 || !temporaryPassword.trim()) fail(400, '4~128자 임시비밀번호를 입력하세요.');
    const {actor, check} = await confirmAdministrator(principal, currentPassword);
    const duplicate = () => { if (db.prepare('SELECT 1 FROM accounts WHERE username=?').get(username)) fail(409, '이미 사용 중인 아이디입니다. 다른 아이디를 입력하세요.'); };
    duplicate();
    const id = randomUUID(), salt = randomBytes(16).toString('hex'), nextHash = await passwordHash(temporaryPassword, salt);
    db.exec('BEGIN IMMEDIATE');
    try {
      check(); duplicate();
      db.prepare('INSERT INTO accounts(id,username,name,role,salt,password_hash) VALUES(?,?,?,?,?,?)').run(id, username, name.trim(), 'admin', salt, nextHash);
      db.prepare('UPDATE accounts SET failures=0,locked_until=0 WHERE id=?').run(actor.id);
      audit(actor.id, 'account_created:' + id);
      db.exec('COMMIT');
      return {user: safeUser(userById(id))};
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async function resetPassword(principal, targetId, currentPassword, temporaryPassword) {
    const target = typeof targetId === 'string' && userById(targetId);
    if (!target) fail(404, '초기화할 관리자 계정을 찾을 수 없습니다.');
    if (target.id === principal.user.id) fail(400, '본인 계정은 비밀번호 변경을 사용하세요. 분실 시 다른 관리자에게 초기화를 요청하세요.');
    if (typeof temporaryPassword !== 'string' || temporaryPassword.length < 4 || temporaryPassword.length > 128 || !temporaryPassword.trim()) fail(400, '4~128자 임시비밀번호를 입력하세요.');
    const {actor, check} = await confirmAdministrator(principal, currentPassword);
    const salt = randomBytes(16).toString('hex'), nextHash = await passwordHash(temporaryPassword, salt);
    db.exec('BEGIN IMMEDIATE');
    try {
      check();
      if (userById(target.id)?.password_hash !== target.password_hash) fail(409, '계정 상태가 바뀌었습니다. 대상을 다시 확인하세요.');
      db.prepare('UPDATE accounts SET password_hash=?,salt=?,must_change=1,failures=0,locked_until=0 WHERE id=?').run(nextHash, salt, target.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
      db.prepare('DELETE FROM api_tokens WHERE user_id=?').run(target.id);
      db.prepare('UPDATE accounts SET failures=0,locked_until=0 WHERE id=?').run(actor.id);
      audit(actor.id, 'password_reset:' + target.id);
      db.exec('COMMIT');
      return {reset: true, user: safeUser(userById(target.id))};
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function appendSnapshot(data, actor) {
    const text = JSON.stringify(data), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const result = db.prepare('INSERT INTO snapshots(iv,cipher,tag,sha256,actor,created) VALUES(?,?,?,?,?,?)').run(iv, encrypted, cipher.getAuthTag(), hash(text), actor, clock());
    return {revision: Number(result.lastInsertRowid), sha256: hash(text)};
  }
  function snapshot() {
    const row = db.prepare('SELECT * FROM snapshots ORDER BY revision DESC LIMIT 1').get();
    if (!row) fail(503, '상담 자료 초기화가 필요합니다.');
    const cipher = createDecipheriv('aes-256-gcm', key, row.iv); cipher.setAuthTag(row.tag);
    const data = JSON.parse(Buffer.concat([cipher.update(row.cipher), cipher.final()]).toString('utf8'));
    return {revision: row.revision, sha256: row.sha256, data};
  }
  function saveSnapshot(data, revision, actor) {
    if (!Number.isSafeInteger(revision) || revision < 1) fail(400, '자료 버전을 확인하세요.');
    validateWorkspace(data);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT max(revision) AS revision FROM snapshots').get().revision !== revision) fail(409, '다른 관리자가 자료를 수정했습니다. 내 기록을 백업하고 최신 자료를 다시 불러오세요.');
      const result = appendSnapshot(data, actor); audit(actor, 'workspace_saved'); db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function listStudents({query = '', offset = 0, limit = 20} = {}) {
    if (typeof query !== 'string' || query.length > 100 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, '검색·페이지 조건을 확인하세요.');
    const state = snapshot(), rows = state.data.students.filter(s => [s.name, s.school, s.grade].some(v => String(v || '').includes(query)));
    return {revision: state.revision, total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null, items: rows.slice(offset, offset + limit).map(({id, name, school, grade}) => ({id, name, school, grade}))};
  }
  function student(id, section = 'all') {
    const state = snapshot(), value = state.data.students.find(s => String(s.id) === String(id));
    if (!value) fail(404, '학생을 찾을 수 없습니다.');
    let data;
    if (section === 'all') data = value;
    else if (section === 'profile') data = Object.fromEntries(['id', 'name', 'school', 'grade', 'career', 'targetUniv'].map(key => [key, value[key] ?? '']));
    else if (section === 'scores') data = {grades: value.grades || [], exams: value.exams || [], regularExams: value.consult?.jeongsi?.exams || []};
    else if (section === 'plans') data = {susi: value.apply || [], decisions: value.consult?.susiDecisions || {}, regular: value.consult?.jeongsi?.plans || [], history: value.consult?.jeongsi?.history || []};
    else if (section === 'reports') data = value.consult?.reports || [];
    else fail(400, '조회 항목을 확인하세요.');
    return {revision: state.revision, data};
  }
  function saveStudent(id, data, revision, actor) {
    if (!data || String(data.id) !== String(id)) fail(400, '학생 식별자가 다릅니다.');
    const state = snapshot(), index = state.data.students.findIndex(s => String(s.id) === String(id));
    if (index < 0) fail(404, '학생을 찾을 수 없습니다.');
    if (Object.keys(state.data.students[index]).some(key => !Object.hasOwn(data, key))) fail(400, '학생 전체 자료를 조회한 뒤 기존 필드를 유지하여 저장하세요.');
    state.data.students[index] = data; return saveSnapshot(state.data, revision, actor);
  }
  return {
    bootstrap, login, authenticate, changePassword, resetPassword, registerUser, snapshot, saveSnapshot, listStudents, student, saveStudent,
    summary: () => { const s = snapshot(); return {revision: s.revision, students: s.data.students.length, reports: s.data.students.reduce((n, x) => n + (x.consult?.reports?.length || 0), 0), regularPlans: s.data.students.reduce((n, x) => n + (x.consult?.jeongsi?.plans?.length || 0), 0)}; },
    checkCsrf: (principal, value) => typeof value === 'string' && equal(hash(value), principal.csrfHash),
    logout: principal => db.prepare('DELETE FROM sessions WHERE hash=?').run(principal.hash),
    listUsers: () => db.prepare('SELECT * FROM accounts ORDER BY username').all().map(safeUser),
    listTokens: principal => db.prepare('SELECT id,name,expires,created FROM api_tokens WHERE user_id=? ORDER BY created DESC').all(principal.user.id),
    issueToken: (principal, name) => {
      if (typeof name !== 'string' || !name.trim() || name.length > 60) fail(400, '연결 키 이름은 1~60자로 입력하세요.');
      const raw = 'wb_' + token(), id = randomUUID(), expires = clock() + 30 * 86400000;
      db.prepare('INSERT INTO api_tokens(id,hash,user_id,name,expires,created) VALUES(?,?,?,?,?,?)').run(id, hash(raw), principal.user.id, name.trim(), expires, clock());
      audit(principal.user.id, 'api_token_created'); return {id, token: raw, expires};
    },
    revokeToken: (principal, id) => { db.prepare('DELETE FROM api_tokens WHERE id=? AND user_id=?').run(id, principal.user.id); audit(principal.user.id, 'api_token_revoked'); return {revoked: true}; },
    close: () => db.close(),
  };
}
