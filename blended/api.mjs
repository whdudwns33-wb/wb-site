import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import links from '../shared/external-links.js';
import { createPlanner } from './planner-api.mjs';
import {defaultLayout,validateLayout} from './report-layout.mjs';

export const APP = 'blended';
const staffRoles = ['owner', 'admin', 'teacher'];
const publicFields = ['studentVoice', 'facts', 'strengths', 'guidance', 'home', 'nextGoal', 'due', 'nextCheck'];
export const now = () => new Date().toISOString();
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const hash = value => createHash('sha256').update(value).digest('hex');
const passwordOptions = {N:32768,r:8,p:3,maxmem:64*1024*1024};
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const requireThat = (condition, status, code, message) => { if (!condition) fail(status, code, message); };
function text(value, max = 2000, required = false) {
  requireThat(typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value), 400, 'INPUT', '입력 형식이나 길이를 확인해 주세요.');
  value = value.trim();
  requireThat(!required || value.length > 0, 400, 'REQUIRED', '필수 내용을 입력해 주세요.');
  return value;
}
function date(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value, 400, 'DATE', '올바른 날짜를 입력해 주세요.');
  return value;
}
function flag(value) { requireThat(typeof value === 'boolean', 400, 'INPUT', '상태 값이 올바르지 않습니다.'); return Number(value); }
export function passwordHash(password) {
  text(password, 128, true);
  requireThat(password.length >= 12, 400, 'PASSWORD', '비밀번호는 12자 이상 입력해 주세요.');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32,passwordOptions).toString('hex')}:v2`;
}
function passwordMatches(password, stored) {
  const [salt, expected, version] = stored.split(':');
  return timingSafeEqual(scryptSync(password, salt, 32,version === 'v2' ? passwordOptions : undefined), Buffer.from(expected, 'hex'));
}
export function createApi(db, options = {}) {
  const mode = options.mode || 'synthetic-local';
  const transaction = options.transaction || (fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const dummyPassword = passwordHash('local-dummy-password-only');
  const role = (user, roles) => requireThat(roles.includes(user.role), 403, 'FORBIDDEN', '이 작업을 할 권한이 없습니다.');
  const revision = (row, expected) => requireThat(Number.isSafeInteger(expected) && row.revision === expected, 409, 'CONFLICT', '다른 화면에서 변경되었습니다. 입력을 보존했습니다. 최신 내용을 확인해 주세요.');
  function userFor(token) {
    const row = one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>? AND u.active=1',hash(token || ''),Date.now());
    requireThat(row,401,'AUTH','다시 로그인해 주세요.');
    return row;
  }
  function canAccess(user, studentId, subject = '') {
    const student = one('SELECT * FROM students WHERE id=?',studentId);
    if (!student || !student.active) return false;
    if (['owner','admin'].includes(user.role)) return true;
    if (user.role === 'student') return user.id === studentId;
    if (user.role === 'guardian') return !!one('SELECT 1 FROM guardians WHERE user_id=? AND student_id=? AND consent=1',user.id,studentId);
    return user.role === 'teacher' && !!one('SELECT 1 FROM assignments WHERE teacher_id=? AND student_id=? AND active=1 AND starts<=? AND ends>=? AND (?=\'\' OR subject=?)',user.id,studentId,today(),today(),subject,subject);
  }
  const access = (user, studentId, subject = '') => requireThat(canAccess(user,studentId,subject),403,'SCOPE','현재 담당 또는 열람 범위에 포함되지 않습니다.');
  const planner = createPlanner({one,all,run,access,canAccess,requireThat,revision,today,reportLayout:()=>layout().template});
  const layout=()=>{const row=one("SELECT * FROM report_layout WHERE id='academy'");return {template:row?JSON.parse(row.template):defaultLayout(),revision:row?.revision || 0};};
  const reportSnapshot=(row,user,at=now())=>({app:APP,type:'consultation',consultationId:row.id,student:one('SELECT id,name FROM students WHERE id=?',row.student_id),subject:row.subject,heldAt:row.held_at,author:one('SELECT id,name FROM users WHERE id=?',row.author),public:publicData(JSON.parse(row.public_json)),summary:summary(user,row.student_id,row.subject,row.period_start,row.period_end),layout:layout().template,publishedAt:at});
  function object(table, id, user, roles) {
    role(user,roles);
    const row = one(`SELECT * FROM ${table} WHERE id=?`,text(id,100,true));
    requireThat(row,404,'NOT_FOUND','기록을 찾을 수 없습니다.');
    access(user,row.student_id,row.subject);
    return row;
  }
  const publicUser = u => ({ id:u.id, name:u.name, login:u.login, role:u.role, active:!!u.active, revision:u.revision, external_id:u.external_id });
  function reportRows(c, history = false) {
    const rows = all('SELECT * FROM report_versions WHERE consultation_id=? ORDER BY version DESC',c.id);
    const visible = history ? rows : rows[0]?.status === 'published' ? [rows[0]] : [];
    return visible.map(r => ({ ...r, snapshot:r.snapshot ? JSON.parse(r.snapshot) : null }));
  }
  function publicData(input) {
    requireThat(input && typeof input === 'object' && !Array.isArray(input),400,'INPUT','공개 내용을 입력해 주세요.');
    const out = {};
    for (const key of publicFields) out[key] = text(input[key] ?? '',key === 'nextGoal' ? 200 : 2000,['facts','guidance','nextGoal','due'].includes(key));
    out.due = date(out.due);
    if (out.nextCheck) out.nextCheck = date(out.nextCheck);
    return out;
  }
  function summary(user, studentId, subject, start, end) {
    access(user,studentId,subject);
    date(start); date(end);
    requireThat(start <= end,400,'PERIOD','집계 시작일과 종료일을 확인해 주세요.');
    const rows = all('SELECT id,title,due,subject,self_done,checked FROM learning WHERE student_id=? AND subject=? AND due BETWEEN ? AND ?',studentId,subject,start,end).concat(planner.summary(user,studentId,subject,start,end));
    return { source:'블렌디드 직접 기록', external:'미연동', periodStart:start, periodEnd:end, asOf:now(),
      total:rows.length, selfDone:rows.filter(r => r.self_done).length, checked:rows.filter(r => r.checked).length,
      hasRecords:rows.length > 0, rows };
  }
  function overview(user) {
    const isStaff = staffRoles.includes(user.role);
    const students = all('SELECT * FROM students').filter(s => canAccess(user,s.id));
    const learning = user.role === 'guardian' ? [] : all('SELECT * FROM learning ORDER BY due,id').filter(r => canAccess(user,r.student_id,r.subject));
    const consultations = all('SELECT * FROM consultations ORDER BY held_at DESC,id').filter(r => canAccess(user,r.student_id,r.subject));
    const reports = consultations.flatMap(c => reportRows(c,isStaff));
    return { app:APP, mode, me:publicUser(user), today:today(), students, learning, reports,periodReports:planner.publicReports(user),
      consultations:isStaff ? consultations.map(c => ({...c, public:JSON.parse(c.public_json), public_json:undefined})) : [],
      assignments:isStaff ? all('SELECT * FROM assignments').filter(a => ['owner','admin'].includes(user.role) || a.teacher_id === user.id) : [],
      teachers:['owner','admin'].includes(user.role) ? all("SELECT * FROM users WHERE role IN ('teacher','admin')").map(publicUser) : [],
      guardians:['owner','admin'].includes(user.role) ? all('SELECT * FROM guardians') : [],
      sessions:all('SELECT created_at,expires FROM sessions WHERE user_id=? AND expires>?',user.id,Date.now()),
      integration:{ academy:'연결 대기', externalLearning:'미연동', delivery:'비활성 · 실제 발송 없음' } };
  }
  function mutation(user, action, p) {
    if(action==='report_layout_save') {
      role(user,['owner']);const current=layout();requireThat(p.revision===current.revision,409,'CONFLICT','다른 화면에서 양식이 변경되었습니다. 입력을 보존했으니 다시 확인해 주세요.');
      const template=validateLayout(p.template),next=current.revision+1;
      run("INSERT INTO report_layout VALUES('academy',?,?,?,?) ON CONFLICT(id) DO UPDATE SET template=excluded.template,revision=excluded.revision,actor=excluded.actor,updated_at=excluded.updated_at",JSON.stringify(template),next,user.id,now());
      return {id:'academy-layout',revision:next};
    }
    switch (action) {
      case 'planner_save': return planner.save(user,p);
      case 'planner_question': return planner.questions(user,p);
      case 'password_change': {
        text(p.currentPassword,128,true);
        requireThat(passwordMatches(p.currentPassword,user.password),400,'PASSWORD','현재 비밀번호를 확인해 주세요.');
        run('UPDATE users SET password=?,revision=revision+1 WHERE id=?',passwordHash(p.password),user.id);
        run('DELETE FROM sessions WHERE user_id=?',user.id);
        return {id:user.id,loggedOut:true};
      }
      case 'student_create': {
        role(user,['owner','admin']);
        const login=text(p.login,60,true).toLowerCase(),name=text(p.name,80,true);
        requireThat(/^[a-z0-9][a-z0-9._-]{2,59}$/.test(login),400,'LOGIN','아이디 형식을 확인해 주세요.');
        requireThat(!one('SELECT 1 FROM users WHERE login=?',login),409,'EXISTS','이미 등록된 아이디입니다.');
        const id=randomUUID();
        run('INSERT INTO users(id,login,name,role,password,created_at) VALUES(?,?,?,?,?,?)',id,login,name,'student',passwordHash(p.password),now());
        run('INSERT INTO students(id,name) VALUES(?,?)',id,name);
        return {id};
      }
      case 'teacher_create': {
        role(user,['owner','admin']);
        const targetRole = p.role || 'teacher';
        requireThat(targetRole === 'teacher' || (user.role === 'owner' && targetRole === 'admin'),403,'ROLE','허용되지 않은 역할입니다.');
        const login = text(p.login,60,true).toLowerCase();
        requireThat(/^[a-z0-9][a-z0-9._-]{2,59}$/.test(login),400,'LOGIN','아이디는 영문·숫자 3~60자로 입력해 주세요.');
        requireThat(!one('SELECT 1 FROM users WHERE login=?',login),409,'EXISTS','이미 등록된 아이디입니다.');
        const id = randomUUID();
        run('INSERT INTO users(id,login,name,role,active,password,created_at) VALUES(?,?,?,?,?,?,?)',id,login,text(p.name,80,true),targetRole,p.active === undefined ? 1 : flag(p.active),passwordHash(p.password),now());
        return {id};
      }
      case 'teacher_status': {
        role(user,['owner','admin']);
        const target = one('SELECT * FROM users WHERE id=?',text(p.id,100,true));
        requireThat(target && (target.role === 'teacher' || user.role === 'owner' && target.role === 'admin'),403,'ROLE','이 계정의 권한은 변경할 수 없습니다.');
        revision(target,p.revision);
        run('UPDATE users SET active=?,revision=revision+1 WHERE id=?',flag(p.active),p.id);
        run('DELETE FROM sessions WHERE user_id=?',p.id);
        return {id:p.id};
      }
      case 'assign': {
        role(user,['owner','admin']); access(user,text(p.studentId,100,true));
        const teacher = one("SELECT * FROM users WHERE id=? AND role='teacher' AND active=1",text(p.teacherId,100,true));
        requireThat(teacher,400,'TEACHER','활성 강사를 선택해 주세요.');
        const start = date(p.starts), end = date(p.ends), subject = text(p.subject,40,true);
        requireThat(start <= end,400,'PERIOD','담당 기간을 확인해 주세요.');
        const existing = one('SELECT * FROM assignments WHERE teacher_id=? AND student_id=? AND subject=? AND starts=? AND ends=?',p.teacherId,p.studentId,subject,start,end);
        requireThat(!existing,409,'EXISTS','같은 담당 배정 이력이 이미 있습니다. 새 기간을 지정해 주세요.');
        const id = randomUUID();
        run('INSERT INTO assignments(id,teacher_id,student_id,subject,starts,ends,actor) VALUES(?,?,?,?,?,?,?)',id,p.teacherId,p.studentId,subject,start,end,user.id);
        return {id};
      }
      case 'unassign': {
        role(user,['owner','admin']);
        const row = object('assignments',p.id,user,['owner','admin']); revision(row,p.revision);
        run('UPDATE assignments SET active=0,revision=revision+1 WHERE id=?',p.id); return {id:p.id};
      }
      case 'student_status': {
        role(user,['owner','admin']);
        const row = one('SELECT * FROM students WHERE id=?',text(p.id,100,true));
        requireThat(row,404,'NOT_FOUND','학생을 찾을 수 없습니다.'); revision(row,p.revision);
        run('UPDATE students SET active=?,revision=revision+1 WHERE id=?',flag(p.active),p.id); return {id:p.id};
      }
      case 'guardian_consent': {
        role(user,['owner','admin']);
        const row = one('SELECT * FROM guardians WHERE user_id=? AND student_id=?',text(p.guardianId,100,true),text(p.studentId,100,true));
        requireThat(row,404,'NOT_FOUND','보호자 관계를 찾을 수 없습니다.'); revision(row,p.revision);
        run('UPDATE guardians SET consent=?,revision=revision+1 WHERE user_id=? AND student_id=?',flag(p.consent),p.guardianId,p.studentId);
        return {id:p.guardianId};
      }
      case 'learning_create': {
        const studentId=text(p.studentId,100,true),subject=text(p.subject,40,true);
        role(user,staffRoles); access(user,studentId,subject);
        const linkKey = text(p.linkKey || '',50);
        requireThat(!linkKey || ['metamath_student','leaders_eye','nelt_student','classcard_app_android','classcard_app_ios'].includes(linkKey) && links.linkFor(linkKey),400,'LINK','지원되는 학생 학습 링크를 선택해 주세요.');
        const id = randomUUID();
        run('INSERT INTO learning(id,student_id,subject,title,due,link_key,actor,updated_at) VALUES(?,?,?,?,?,?,?,?)',id,studentId,subject,text(p.title,200,true),date(p.due),linkKey,user.id,now()); return {id};
      }
      case 'perform': {
        const row = object('learning',p.id,user,['student']); revision(row,p.revision);
        run('UPDATE learning SET self_done=?,question=?,checked=0,checked_by=NULL,revision=revision+1,updated_at=? WHERE id=?',flag(p.done),text(p.question || ''),now(),p.id); return {id:p.id};
      }
      case 'check': {
        const row = object('learning',p.id,user,staffRoles); revision(row,p.revision);
        run('UPDATE learning SET checked=1,checked_by=?,feedback=?,revision=revision+1,updated_at=? WHERE id=?',user.id,text(p.feedback,2000,true),now(),p.id); return {id:p.id};
      }
      case 'consult_save': {
        role(user,staffRoles);
        const old = p.id ? object('consultations',p.id,user,staffRoles) : null;
        if (old) revision(old,p.revision);
        const studentId = old?.student_id || text(p.studentId,100,true), subject = old?.subject || text(p.subject,40,true);
        access(user,studentId,subject);
        const start = date(p.periodStart), end = date(p.periodEnd), held = text(p.heldAt,40,true);
        requireThat(start <= end && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(held) && Number.isFinite(Date.parse(held)),400,'PERIOD','상담 일시와 집계 기간을 확인해 주세요.');
        const data = publicData(p.public);
        if (old?.status === 'complete') {
          const before = JSON.parse(old.public_json);
          requireThat(data.nextGoal === before.nextGoal && data.due === before.due,409,'PROMISE_FIXED','완료된 상담의 약속은 보존합니다. 새 목표는 새 상담에서 등록해 주세요.');
        }
        const id = old?.id || randomUUID();
        if (old) run("UPDATE consultations SET held_at=?,period_start=?,period_end=?,public_json=?,report_status='draft',revision=revision+1,updated_at=? WHERE id=?",held,start,end,JSON.stringify(data),now(),id);
        else run('INSERT INTO consultations(id,student_id,subject,held_at,period_start,period_end,author,public_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',id,studentId,subject,held,start,end,user.id,JSON.stringify(data),now());
        run('INSERT INTO internal_notes VALUES(?,?) ON CONFLICT(consultation_id) DO UPDATE SET note=excluded.note',id,text(p.internalNote || '',4000));
        return {id};
      }
      case 'consult_complete': {
        const row = object('consultations',p.id,user,staffRoles);
        if (row.status === 'complete') return {id:row.id, learningId:one('SELECT id FROM learning WHERE source_consultation=?',row.id).id};
        revision(row,p.revision);
        const data = JSON.parse(row.public_json), id = randomUUID();
        run('INSERT INTO learning(id,student_id,subject,title,due,source_consultation,actor,updated_at) VALUES(?,?,?,?,?,?,?,?)',id,row.student_id,row.subject,data.nextGoal,data.due,row.id,user.id,now());
        run("UPDATE consultations SET status='complete',revision=revision+1,updated_at=? WHERE id=?",now(),row.id);
        return {id:row.id, learningId:id};
      }
      case 'review': {
        const row = object('consultations',p.id,user,staffRoles); revision(row,p.revision);
        requireThat(row.status === 'complete' && row.report_status === 'draft',409,'STATE','상담 완료 후 초안을 검토 요청해 주세요.');
        run("UPDATE consultations SET report_status='review',revision=revision+1,updated_at=? WHERE id=?",now(),row.id); return {id:row.id};
      }
      case 'publish':
      case 'withdraw': {
        const row = object('consultations',p.id,user,['owner']); revision(row,p.revision);
        const previous = one('SELECT * FROM report_versions WHERE consultation_id=? ORDER BY version DESC LIMIT 1',row.id);
        requireThat(action === 'publish' ? row.status === 'complete' && row.report_status === 'review' : previous?.status === 'published',409,'STATE','리포트 상태를 확인해 주세요. 발행은 검토 대기 초안에서 가능합니다.');
        const reason = text(p.reason || '',500,!!previous || action === 'withdraw');
        const id = randomUUID(), at = now();
        // 공개 필드만 선택하며 내부 메모 표는 발행 과정에서 읽지 않는다.
        const snapshot = action === 'withdraw' ? null : JSON.stringify(reportSnapshot(row,user,at));
        run('INSERT INTO report_versions VALUES(?,?,?,?,?,?,?,?)',id,row.id,(previous?.version || 0)+1,action === 'publish' ? 'published' : 'withdrawn',snapshot,reason,user.id,at);
        run('UPDATE consultations SET report_status=?,revision=revision+1,updated_at=? WHERE id=?',action === 'publish' ? 'published' : 'withdrawn',at,row.id);
        return {id, consultationId:row.id, version:(previous?.version || 0)+1};
      }
      case 'send': role(user,['owner']); object('consultations',p.id,user,['owner']); fail(409,'INTEGRATION_PENDING','학원 원본·수신 동의·발송 경로 연결 대기입니다. 실제 발송은 비활성입니다.'); break;
      default: fail(404,'ACTION','지원하지 않는 작업입니다.');
    }
  }
  function handle(body, token = '', client = 'local') {
    requireThat(body && typeof body === 'object' && !Array.isArray(body) && body.app === APP,400,'APP','블렌디드 전용 요청만 허용됩니다.');
    const action = text(body.action,40,true), p = body.payload || {};
    requireThat(p && typeof p === 'object' && !Array.isArray(p),400,'INPUT','요청 형식이 올바르지 않습니다.');
    if (action === 'runtime') return {mode,ready:!!one('SELECT 1 FROM users LIMIT 1')};
    if (action === 'setup') {
      requireThat(mode === 'production' && options.bootstrapToken && typeof p.token === 'string' && timingSafeEqual(Buffer.from(hash(p.token)),Buffer.from(hash(options.bootstrapToken))),403,'SETUP','원장 최초 설정 경로를 확인해 주세요.');
      return transaction(() => {
        requireThat(!one('SELECT 1 FROM users LIMIT 1'),409,'SETUP_DONE','이미 원장 계정이 설정되었습니다.');
        run('INSERT INTO users(id,login,name,role,password,created_at) VALUES(?,?,?,?,?,?)',randomUUID(),options.ownerLogin || 'whdudwns33','원장','owner',passwordHash(p.password),now());
        return {created:true};
      });
    }
    if (action === 'login') {
      const login = text(p.login,60,true).toLowerCase(), password = p.password;
      text(password,128,true);
      run('DELETE FROM login_limits WHERE until_ms<=?',Date.now());
      const keys=[hash('account:'+login),hash('client:'+client)];
      for (const [i,key] of keys.entries()) {
        const attempt=one('SELECT * FROM login_limits WHERE key=?',key);
        requireThat(!attempt || attempt.attempts < (i === 0 ? 5 : 30),429,'RATE','로그인 시도가 많습니다. 5분 후 다시 시도해 주세요.');
      }
      const user = one('SELECT * FROM users WHERE login=?',login);
      const matches = passwordMatches(password,user?.password || dummyPassword);
      if (!user?.active || !matches) {
        for (const key of keys) run('INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1',key,Date.now()+300000);
        fail(401,'LOGIN','아이디 또는 비밀번호를 확인해 주세요.');
      }
      run('DELETE FROM login_limits WHERE key=?',keys[0]);
      const raw = randomBytes(32).toString('hex');
      run('INSERT INTO sessions VALUES(?,?,?,?)',hash(raw),user.id,Date.now()+8*3600000,now());
      return {me:publicUser(user), sessionToken:raw};
    }
    const user = userFor(token);
    if(action==='report_layout')return {me:{id:user.id,name:user.name,role:user.role},...layout()};
    if(action==='report_preview') {const row=object('consultations',p.id,user,staffRoles);return {snapshot:reportSnapshot(row,user)};}
    if (action === 'logout') { run('DELETE FROM sessions WHERE hash=?',hash(token)); return {loggedOut:true}; }
    if (action === 'state') return overview(user);
    if (action === 'planner_state') return planner.state(user);
    if (action === 'planner_reports') return {reports:planner.publicReports(user)};
    if (action === 'planner_questions') return planner.questions(user,{...p,action:'list'});
    if (action === 'summary') { role(user,staffRoles); return {summary:summary(user,text(p.studentId,100,true),text(p.subject,40,true),p.start,p.end)}; }
    if (action === 'consult_get') {
      const row = object('consultations',p.id,user,staffRoles);
      return {consultation:{...row,public:JSON.parse(row.public_json),public_json:undefined},internalNote:one('SELECT note FROM internal_notes WHERE consultation_id=?',row.id)?.note || ''};
    }
    if (action === 'report_get') {
      const row = object('consultations',p.id,user,['owner','admin','teacher','student','guardian']);
      return {reports:reportRows(row,staffRoles.includes(user.role))};
    }
    // 권한을 다시 확인한 뒤 재시도 결과를 돌려주며 영수증에는 본문을 넣지 않는다.
    const key = text(body.requestId,100,true);
    requireThat(/^[\w-]{8,100}$/.test(key),400,'REQUEST_ID','재시도 식별자가 필요합니다.');
    const digest = hash(JSON.stringify({action,p}));
    return transaction(() => {
      const receipt = one('SELECT * FROM receipts WHERE user_id=? AND key=?',user.id,key);
      if (receipt) {
        requireThat(receipt.digest === digest,409,'KEY_REUSE','같은 재시도 식별자로 다른 내용을 저장할 수 없습니다.');
        if(action === 'planner_save') planner.accessReceipt(user,p);
        if(action === 'planner_question') {
          const q=one('SELECT * FROM planner_questions WHERE id=?',p.id || user.id+'-'+p.clientRequestId);
          if(q)access(user,q.student_id,({math:'수학',english:'영어',korean:'국어',social:'사회',science:'과학',other:'기타'})[q.subject]);
        }
        const result = JSON.parse(receipt.result);
        const c = one('SELECT * FROM consultations WHERE id=?',result.consultationId || result.id || '');
        const l = one('SELECT * FROM learning WHERE id=?',result.id || '');
        if (c || l) access(user,(c || l).student_id,(c || l).subject);
        return {...result,replayed:true};
      }
      const result = mutation(user,action,p);
      run('INSERT INTO receipts VALUES(?,?,?,?)',user.id,key,digest,JSON.stringify(result));
      run('INSERT INTO audit(actor,action,object_id,at) VALUES(?,?,?,?)',user.id,action,result.id || '',now());
      return result;
    });
  }
  // 학원 서버 전용 읽기 계약: 학생 식별자·이름만 제공하고 세션/권한을 발급하지 않는다.
  function academy(body, key) {
    requireThat(/^[a-f0-9]{64}$/.test(options.academyBridgeKey || '') && typeof key==='string' && key.length<=128 && timingSafeEqual(Buffer.from(hash(key)),Buffer.from(hash(options.academyBridgeKey))),403,'BRIDGE_AUTH','학원 연결을 인증하지 못했습니다.');
    requireThat(body && typeof body==='object' && !Array.isArray(body),400,'INPUT','요청 형식을 확인해 주세요.');
    const students=all('SELECT s.id,s.name FROM students s JOIN users u ON u.id=s.id WHERE s.active=1 AND u.active=1 ORDER BY s.name,s.id');
    if(body.action==='students')return {students};
    requireThat(body.action==='student',400,'ACTION','지원하지 않는 학원 연결 요청입니다.');
    const student=students.find(s=>s.id===text(body.studentId,100,true));
    requireThat(student,404,'STUDENT','현재 이용 중인 플래너 학생을 찾지 못했습니다.');
    return {student};
  }
  const authKey=key=>requireThat(/^[a-f0-9]{64}$/.test(options.academyAuthKey || '') && typeof key==='string' && key.length<=128 && timingSafeEqual(Buffer.from(hash(key)),Buffer.from(hash(options.academyAuthKey))),403,'BRIDGE_AUTH','학원 로그인 연결을 인증하지 못했습니다.');
  const sameRole=(academyRole,userRole)=>({'원장급':['owner'],'실장':['admin'],'강사':['teacher']}[academyRole] || []).includes(userRole);
  function academyAuth(body,key) {
    authKey(key);
    requireThat(body && typeof body==='object' && !Array.isArray(body),400,'INPUT','요청 형식을 확인해 주세요.');
    if(body.action==='accounts')return {accounts:all("SELECT id,name,login,role FROM users WHERE active=1 AND role IN ('owner','admin','teacher') ORDER BY name,id")};
    requireThat(['account','ticket'].includes(body.action),400,'ACTION','지원하지 않는 로그인 요청입니다.');
    const user=one('SELECT * FROM users WHERE id=? AND active=1',text(body.userId,100,true));
    requireThat(user && sameRole(body.role,user.role),403,'SSO_ROLE','두 앱의 직원 계정과 역할 연결을 원장님께 확인해 주세요.');
    if(body.action==='account')return {account:{id:user.id,name:user.name,role:user.role}};
    const studentId=text(body.studentId,100,true);access(user,studentId);
    requireThat(/^[a-f0-9]{64}$/.test(body.state || ''),400,'SSO_STATE','학원에서 플래너 열기를 다시 눌러 주세요.');
    const ticket=randomBytes(32).toString('hex'),at=(options.authNow || Date.now)();
    run('DELETE FROM academy_tickets WHERE expires<=?',at);
    run('INSERT INTO academy_tickets VALUES(?,?,?,?,?,?)',hash(ticket),hash(body.state),user.id,studentId,user.role,at+60000);
    return {ticket};
  }
  function exchange(ticket,nonce) {
    requireThat(/^[a-f0-9]{64}$/.test(ticket || '') && /^[a-f0-9]{64}$/.test(nonce || ''),403,'SSO_STATE','학원에서 플래너 열기를 다시 눌러 주세요.');
    return transaction(()=>{
      const at=(options.authNow || Date.now)(),entry=one('SELECT * FROM academy_tickets WHERE hash=?',hash(ticket));
      requireThat(entry && entry.expires>at && entry.nonce===hash(nonce),403,'SSO_TICKET','로그인 연결이 만료되었어요. 학원에서 플래너를 다시 열어 주세요.');
      const user=one('SELECT * FROM users WHERE id=? AND active=1',entry.user_id);
      requireThat(user && user.role===entry.role,403,'SSO_ROLE','직원 권한이 변경되었어요. 원장님께 확인해 주세요.');access(user,entry.student_id);
      run('DELETE FROM academy_tickets WHERE hash=?',hash(ticket));
      const raw=randomBytes(32).toString('hex');run('INSERT INTO sessions VALUES(?,?,?,?)',hash(raw),user.id,at+30*60000,now());
      run('INSERT INTO audit(actor,action,object_id,at) VALUES(?,?,?,?)',user.id,'academy_login',entry.student_id,now());
      return {sessionToken:raw,studentId:entry.student_id};
    });
  }
  return { handle, academy, academyAuth, exchange };
}
