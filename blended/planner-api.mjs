// 원본의 학습 자료 형식을 유지하되 인증·범위·충돌 검사는 블렌디드 저장 경계에서 수행한다.
const subjects = {math:'수학',english:'영어',korean:'국어',social:'사회',science:'과학',other:'기타'};
export const subjectKey = value => Object.keys(subjects).find(k => k === value || subjects[k] === value) || (value === '탐구' || value === 'explore' ? 'social' : 'other');
const copy = value => JSON.parse(JSON.stringify(value));
const equal = (a,b) => {
  if(a===b)return true;
  if(!a || !b || typeof a!=='object' || typeof b!=='object' || Array.isArray(a)!==Array.isArray(b))return false;
  return Object.keys(a).length===Object.keys(b).length && Object.keys(a).every(k=>Object.hasOwn(b,k) && equal(a[k],b[k]));
};
const specialTypes = new Set(['st','stgoal','stsubj','ing','ingp','ingavail','ingnote','ingset','tb','rd','wn','weekplan','monthplan','weekmove','dailyclose','weekclose','monthclose','closeactive','studentsetup']);
const writableStudentKinds = new Set(['','mgoal','material_request','lecture_request','metamath_request','learning_daily_log']);
const metadata = ['taskId','date','done','note','steps','count','blocked','updatedAt'];
const pick=(obj,keys)=>Object.fromEntries(keys.filter(k=>obj && k in obj).map(k=>[k,obj[k]]));
function publicSnapshot(s) {
  return {...pick(s,['schemaVersion','periodType','periodKey','periodStart','periodEnd','asOf','isPartial','elapsedDays','dailyGoalMin','reflection','directorNote','nextFocus','layout']),
    student:pick(s.student,['id','name']),summary:pick(s.summary,['done','total','pct','blocked','studySecs','goalDays']),
    subjects:Object.fromEntries(Object.keys(subjects).filter(k=>s.subjects?.[k]).map(k=>[k,pick(s.subjects[k],['done','total','studySecs'])])),
    rows:(s.rows || []).map(r=>pick(r,['taskId','date','title','subject','origin','status'])),days:(s.days || []).map(r=>pick(r,['date','done','total','studySecs']))};
}
const stamp = () => Date.now();
const validDate=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
export function createPlanner({one,all,run,access,canAccess,requireThat,revision,today,reportLayout=()=>null}) {
  const guard = (condition,code='INPUT',message='플래너 자료의 형식이나 권한을 확인해 주세요.',status=400) => requireThat(condition,status,code,message);
  const records = () => all('SELECT * FROM planner_records').map(r => ({...r,data:JSON.parse(r.data)}));
  const row = (kind,key) => {const r=one('SELECT * FROM planner_records WHERE kind=? AND key=?',kind,key);return r?{...r,data:JSON.parse(r.data)}:null;};
  const scope = (u,sid,key) => u.role !== 'teacher' || all('SELECT subject FROM assignments WHERE teacher_id=? AND student_id=? AND active=1 AND starts<=? AND ends>=?',u.id,sid,today(),today()).some(a => a.subject===key || a.subject===subjects[key] || key==='social' && ['탐구','explore'].includes(a.subject));
  const scoped = (u,sid,key) => {access(u,sid);guard(scope(u,sid,key),'SCOPE','담당 과목의 자료만 변경할 수 있습니다.',403);};
  function clean(value,depth=0) {
    guard(depth <= 20);
    if (typeof value === 'string') guard(value.length <= 50000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value));
    else if (typeof value === 'number') guard(Number.isFinite(value));
    else if (value && typeof value === 'object') {
      guard(Object.keys(value).length <= 3000);
      for (const [k,v] of Object.entries(value)) {guard(!['__proto__','prototype','constructor','password','syncSecret','adminToken','myToken'].includes(k));clean(v,depth+1);}
    } else guard(value === null || typeof value === 'boolean');
  }
  // 수행 수정으로 과제 순서가 바뀌면 원본의 마감 서명이 무효화되므로 과제 시각은 예정일에 고정한다.
  const linkedTask = l => ({id:'blend-'+l.id,staffId:l.student_id,title:l.title,studySubject:subjectKey(l.subject),detail:l.source_consultation?'상담에서 정한 실천 약속':'담당 강사가 배정한 학습',guide:l.feedback,steps:[],repeat:'once',start:l.due,end:'',days:[],carry:true,origin:'admin',createdAt:Date.parse(l.due+'T00:00:00+09:00'),updatedAt:Date.parse(l.due+'T00:00:00+09:00'),deleted:false,_blendedId:l.id});
  function task(key) {
    if(key.startsWith('blend-')) {const l=one('SELECT * FROM learning WHERE id=?',key.slice(6));return l?linkedTask(l):null;}
    return row('tasks',key)?.data;
  }
  const course = (sid,cid) => row('checks','__ing__'+sid+'|all')?.data.courses?.find(c => c.id === cid);
  function subjectOf(t) {return subjectKey(t.studySubject || t.subject || 'other');}
  function describe(kind,key,data) {
    if(kind==='staff') return {sid:key,type:'profile'};
    if(kind==='tasks') return {sid:data.staffId,type:'task',subject:subjectOf(data)};
    const [tid,date,...extra]=key.split('|');
    guard(!extra.length && tid && date && data.taskId===tid && data.date===date);
    const special=/^__([a-z]+)__(.+)$/.exec(tid);
    if(special) {guard(specialTypes.has(special[1]),'TYPE','이 기록은 전용 관리 화면을 이용해 주세요.');return {sid:special[2],type:special[1],date};}
    const t=task(tid);guard(t,'TASK','연결된 공부를 찾을 수 없습니다.');
    return {sid:t.staffId,type:'check',subject:subjectOf(t),task:t,date};
  }
  function teacherProjection(u,info,data) {
    const ok = s => scope(u,info.sid,subjectKey(s));
    const out=Object.fromEntries(metadata.filter(k=>k in data).map(k=>[k,data[k]]));
    // 혼합 과목 자료는 필요한 부분만 보내고, 저장 때 보이지 않는 부분을 서버에서 보존한다.
    switch(info.type) {
      case 'profile': return {...data,studyRoadmap:{targetSchool:data.studyRoadmap?.targetSchool || '',items:(data.studyRoadmap?.items || []).filter(i=>ok(i.subject))}};
      case 'ing': out.courses=(data.courses || []).filter(c=>ok(c.studySubject));break;
      case 'ingp': out.items=(data.items || []).filter(i=>ok(course(info.sid,i.cid)?.studySubject));break;
      case 'ingnote': return ok(course(info.sid,info.date.split(':')[0])?.studySubject)?data:null;
      case 'rd': out.items=(data.items || []).filter(i=>ok(i.subject));break;
      case 'wn': out.items=(data.items || []).filter(i=>ok(i.subj));break;
      case 'tb': out.blocks=(data.blocks || []).filter(i=>ok(i.subj));break;
      case 'st':
        out.secs=Object.fromEntries(Object.entries(data.secs || {}).filter(([k])=>ok(k)));
        out.segments=(data.segments || []).filter(i=>ok(i.subj));out.run=data.run && ok(data.run.subj)?data.run:null;break;
      case 'weekplan': case 'monthplan': out.plan={subjectGoals:Object.fromEntries(Object.entries(data.plan?.subjectGoals || {}).filter(([k])=>ok(k)))};break;
      case 'stgoal': case 'closeactive': case 'ingavail': case 'ingset': return data;
      case 'task': case 'check': return scope(u,info.sid,info.subject)?data:null;
      default: return null;
    }
    return out;
  }
  function visible(u,r) {
    if(!canAccess(u,r.student_id)) return null;
    const info=describe(r.kind,r.key,r.data);
    if(r.data.kind === 'report_snapshot' && u.role==='teacher') return null;
    const data=u.role==='teacher'?teacherProjection(u,info,r.data):r.data;
    return data?{table:r.kind,key:r.key,data,revision:r.revision}:null;
  }
  function state(u) {
    guard(u.role!=='guardian','ROLE','보호자는 발행된 공개 리포트에서 확인해 주세요.',403);
    let rows=records().map(r=>visible(u,r)).filter(Boolean);
    const students=all('SELECT id,name FROM students WHERE active=1').filter(s=>canAccess(u,s.id));
    for(const s of students) {
      const i=rows.findIndex(r=>r.table==='staff' && r.key===s.id);
      const defaults={id:s.id,name:s.name,owner:false,manager:false,deleted:false,createdAt:1,updatedAt:1};
      if(i<0) rows.push({table:'staff',key:s.id,revision:0,data:defaults});
      else rows[i].data={...rows[i].data,...defaults,updatedAt:rows[i].data.updatedAt};
    }
    for(const l of all('SELECT * FROM learning')) {
      if(!canAccess(u,l.student_id) || !scope(u,l.student_id,subjectKey(l.subject)))continue;
      const t=linkedTask(l),key=t.id+'|'+l.due,existing=rows.find(r=>r.table==='checks' && r.key===key);
      const check={...(existing?.data || {}),taskId:t.id,date:l.due,done:!!l.self_done,note:l.question,checked:!!l.checked,feedback:l.feedback,updatedAt:Date.parse(l.updated_at)};
      rows=rows.filter(r=>!(r.table==='checks' && r.key===key));
      rows.push({table:'tasks',key:t.id,data:t,revision:l.revision},{table:'checks',key,data:check,revision:l.revision});
    }
    if(u.role==='student') {
      const latest=new Map();
      for(const r of rows.filter(r=>r.data.kind==='report_snapshot')) {const k=r.data.seriesKey;if(!latest.has(k)||latest.get(k).data.reportRevision<r.data.reportRevision)latest.set(k,r);}
      rows=rows.filter(r=>r.data.kind!=='report_snapshot'||latest.get(r.data.seriesKey)===r);
    }
    return {rows,me:{id:u.id,name:u.name,role:u.role},subjects:Object.fromEntries(students.map(s=>[s.id,Object.keys(subjects).filter(k=>scope(u,s.id,k))]))};
  }
  function mergeTeacher(u,info,old,data) {
    const projected=teacherProjection(u,info,data);
    guard(projected && equal(projected,data),'SCOPE','담당 과목 외 자료나 전체 학생 설정은 수정할 수 없습니다.',403);
    if(info.type==='profile') {
      const before={...old,studyRoadmap:undefined,updatedAt:undefined},after={...data,studyRoadmap:undefined,updatedAt:undefined};
      guard(equal(before,after),'ROLE','기본 학생 정보는 관리자 화면에서 변경해 주세요.',403);
      return {...old,updatedAt:data.updatedAt,studyRoadmap:{targetSchool:data.studyRoadmap.targetSchool,items:[...(old.studyRoadmap?.items || []).filter(i=>!scope(u,info.sid,subjectKey(i.subject))),...data.studyRoadmap.items]}};
    }
    if(['ing','ingp','rd','wn','tb'].includes(info.type)) {
      const field={ing:'courses',ingp:'items',rd:'items',wn:'items',tb:'blocks'}[info.type];
      const shown=new Set((teacherProjection(u,info,old)?.[field] || []).map(i=>JSON.stringify(i)));
      const hidden=(old[field] || []).filter(i=>!shown.has(JSON.stringify(i)));
      guard(!(data[field] || []).some(i=>i.id && hidden.some(h=>h.id===i.id)),'SCOPE','다른 과목 자료의 식별자는 사용할 수 없습니다.',403);
      return {...old,...data,[field]:[...hidden,...(data[field] || [])]};
    }
    if(['weekplan','monthplan'].includes(info.type)) return {...old,...data,plan:{...old.plan,subjectGoals:{...Object.fromEntries(Object.entries(old.plan?.subjectGoals || {}).filter(([k])=>!scope(u,info.sid,subjectKey(k)))),...data.plan.subjectGoals}}};
    guard(!['st','stgoal','closeactive'].includes(info.type),'ROLE','학습 시간과 마감 기록은 학생이 직접 입력합니다.',403);
    return data;
  }
  function validateTask(u,data,old) {
    guard(typeof data.id==='string' && typeof data.staffId==='string' && typeof data.title==='string' && data.title.length>0 && data.title.length<=500);
    guard(['none','once','daily','weekday','days'].includes(data.repeat || 'none'));
    let validCarry=false;
    if(data.dailyCarryFrom && u.role==='student') {
      const [sourceId,from]=String(data.dailyCarryFrom).split('|'),source=task(sourceId);
      guard(source?.staffId===data.staffId && validDate(from),'REFERENCE','본인 원본 공부만 이어서 할 수 있습니다.');
      const root=source.dailyCarryRootId || source.id;
      guard(data.id==='daily-carry-'+root+'-'+from && data.dailyCarryRootId===root && data.dailyCarrySourceDate===from && !data.deleted,'REFERENCE');
      const scheduleFields=['id','groupId','repeat','days','start','end','carry','requiresClaim','dailyCarryFrom','dailyCarryRootId','dailyCarrySourceDate','dailyCarryOriginDate','dailyCarryDepth','carrySourceOrigin','origin','lastEditBy','createdAt','updatedAt','deleted','_blendedId'];
      for(const key of new Set([...Object.keys(source),...Object.keys(data)]))if(!scheduleFields.includes(key))guard(equal(source[key],data[key]),'REFERENCE','이어서 할 공부의 원본 내용을 바꿀 수 없습니다.');
      guard(data.carrySourceOrigin===(source.carrySourceOrigin || source.origin) && data.start>=from,'REFERENCE');
      if(data._blendedId)guard(data._blendedId===source._blendedId,'REFERENCE');
      delete data._blendedId;validCarry=true;
    }
    guard(!('_blendedId' in data),'REFERENCE','연결된 상담 약속은 전용 경로에서 관리합니다.');
    guard(!data.steps || Array.isArray(data.steps));guard(!data.days || Array.isArray(data.days));
    guard(!data.start || validDate(data.start));guard(!data.end || validDate(data.end) && data.end>=data.start);
    if(data.resourceUrl) {let url;try{url=new URL(data.resourceUrl);}catch{}guard(url && ['https:','http:'].includes(url.protocol));}
    for(const field of ['academicEventId','materialRequestId','metamathRequestId','lectureRequestId','examPlanId']) {
      if(data[field]) {const linked=task(data[field]);guard(linked && linked.staffId===data.staffId,'REFERENCE','다른 학생의 자료와 연결할 수 없습니다.',403);scoped(u,data.staffId,subjectOf(linked));}
    }
    if(u.role==='student') {
      guard(data.origin==='staff' && (!old || old.origin==='staff') && (validCarry || writableStudentKinds.has(data.kind || '') && !data.auto),'ROLE','강사가 배정한 내용은 수정할 수 없습니다.',403);
    } else guard(data.origin===old?.origin || ['admin','manager'].includes(data.origin),'ORIGIN');
    if(old?.kind==='report_snapshot') guard(false,'IMMUTABLE','발행본은 변경할 수 없습니다. 새 버전을 발행해 주세요.',409);
    if(data.kind==='report_snapshot') {
      guard(u.role==='owner','ROLE','리포트 최종 발행은 원장만 할 수 있습니다.',403);
      const history=records().filter(r=>r.kind==='tasks' && r.student_id===data.staffId && r.data.kind==='report_snapshot' && r.data.seriesKey===data.seriesKey).sort((a,b)=>b.data.reportRevision-a.data.reportRevision);
      guard(data.reportRevision===(history[0]?.data.reportRevision || 0)+1,'CONFLICT','다른 화면에서 리포트가 발행되었습니다. 최신 내용을 확인해 주세요.',409);
      guard(['week','month'].includes(data.reportType) && ['published','withdrawn'].includes(data.reportStatus));
      guard(data.seriesKey===data.reportType+':'+data.staffId+':'+data.periodKey);
      guard(data.reportStatus==='published'?data.snapshot?.student?.id===data.staffId:data.snapshot===null);
      if(data.snapshot) {guard((!data.snapshot.rows || Array.isArray(data.snapshot.rows)) && (!data.snapshot.days || Array.isArray(data.snapshot.days)));data.snapshot=publicSnapshot(data.snapshot);data.snapshot.layout=reportLayout();}
    }
  }
  function save(u,p) {
    guard(u.role!=='guardian','ROLE','열람 전용 계정입니다.',403);
    guard(Array.isArray(p.changes) && p.changes.length>0 && p.changes.length<=400);
    const keys=new Set();
    // 전체 변경을 한 트랜잭션에서 검증·저장하며 충돌이 하나라도 있으면 모두 되돌린다.
    for(const ch of p.changes.slice().sort((a,b)=>({staff:0,tasks:1,checks:2}[a.table]-{staff:0,tasks:1,checks:2}[b.table]))) {
      guard(['staff','tasks','checks'].includes(ch.table) && typeof ch.key==='string' && /^[a-zA-Z0-9_.:|\-]+$/.test(ch.key) && ch.key.length<=250);
      guard(!keys.has(ch.table+'\n'+ch.key));keys.add(ch.table+'\n'+ch.key);
      guard(ch.data && !Array.isArray(ch.data) && typeof ch.data==='object');clean(ch.data);
      guard(JSON.stringify(ch.data).length<=150000);
      let data=copy(ch.data),old=row(ch.table,ch.key);const info=describe(ch.table,ch.key,data);
      access(u,info.sid);if(info.subject)scoped(u,info.sid,info.subject);
      if(old) {guard(old.student_id===info.sid,'SCOPE','기록의 학생을 바꿀 수 없습니다.',403);const prior=describe(ch.table,ch.key,old.data);if(prior.subject)scoped(u,info.sid,prior.subject);}
      const linked=info.type==='check' && info.task._blendedId?one('SELECT * FROM learning WHERE id=?',info.task._blendedId):null;
      revision({revision:linked?.revision || old?.revision || 0},ch.revision);
      if(ch.table==='tasks') {guard(!ch.key.startsWith('blend-') && data.id===ch.key);validateTask(u,data,old?.data);}
      if(ch.table==='staff') {
        guard(data.id===ch.key && !data.owner && !data.manager && !data.deleted && data.name===one('SELECT name FROM students WHERE id=?',info.sid)?.name,'IDENTITY','계정·학생 관리는 전용 관리 화면에서 진행해 주세요.');
        guard(u.role!=='student','ROLE','학생 기본 정보와 교재 로드맵은 담당자가 관리합니다.',403);
        guard(Object.keys(data).every(k=>['id','name','owner','manager','deleted','createdAt','updatedAt','studyRoadmap'].includes(k)));
        guard(!data.studyRoadmap || (typeof data.studyRoadmap.targetSchool==='string' && Array.isArray(data.studyRoadmap.items)));
      }
      for(const field of ['courses','items','blocks','segments','list','moves']) if(field in data)guard(Array.isArray(data[field]));
      if(['weekplan','monthplan'].includes(info.type))guard(data.plan && typeof data.plan==='object' && !Array.isArray(data.plan));
      if(info.type==='ingp')for(const item of data.items || [])guard(course(info.sid,item.cid),'REFERENCE','존재하는 본인 강좌만 배정할 수 있습니다.');
      if(info.type==='ingnote') {
        guard(course(info.sid,info.date.split(':')[0]),'REFERENCE','본인 강좌의 회차를 선택해 주세요.');
        const protectedFields=u.role==='student'?['answer','answeredQuestion','answeredAt']:['question','memo','page'];
        for(const field of protectedFields)guard((data[field] ?? '')===(old?.data[field] ?? ''),'ROLE','다른 사람이 작성한 질문·답변은 변경할 수 없습니다.',403);
      }
      if(info.type==='ing')guard(u.role!=='student','ROLE','강좌 등록과 목차 수정은 담당자가 진행합니다.',403);
      if(u.role==='student' && ['weekplan','monthplan'].includes(info.type)) {
        for(const field of ['directorNote','nextFocus'])guard((data.plan?.[field] || '')===(old?.data.plan?.[field] || ''),'ROLE','강사 안내는 학생이 변경할 수 없습니다.',403);
      }
      if(info.type==='check') {
        guard(!info.task.deleted && validDate(info.date));
        const prior=linked?{checked:!!linked.checked,feedback:linked.feedback}:old?.data || {};
        if(u.role==='student') {
          guard((data.checked ?? false)===(prior.checked ?? false) && (data.feedback || '')===(prior.feedback || ''),'ROLE','강사 확인은 학생이 변경할 수 없습니다.',403);
          if(data.done!==old?.data.done || data.note!==old?.data.note) {data.checked=false;data.feedback=prior.feedback || '';}
        } else {
          guard((data.done ?? false)===(linked?!!linked.self_done:old?.data.done ?? false),'ROLE','학생 수행 표시는 학생이 직접 입력합니다.',403);
        }
        if(linked) run('UPDATE learning SET self_done=?,question=?,checked=?,feedback=?,checked_by=?,revision=revision+1,updated_at=? WHERE id=?',Number(!!data.done),String(data.note || ''),Number(!!data.checked),String(data.feedback || ''),data.checked?u.id:null,new Date().toISOString(),linked.id);
      }
      if(u.role==='teacher') data=mergeTeacher(u,info,old?.data || (ch.table==='staff'?{...data,studyRoadmap:{targetSchool:'',items:[]}}:{}),data);
      run('INSERT INTO planner_records(kind,key,student_id,data,actor) VALUES(?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET data=excluded.data,revision=revision+1,actor=excluded.actor',ch.table,ch.key,info.sid,JSON.stringify(data),u.id);
    }
    return {saved:p.changes.map(ch=>{const l=ch.table==='checks' && ch.key.startsWith('blend-')?one('SELECT revision FROM learning WHERE id=?',ch.key.slice(6).split('|')[0]):null;return {table:ch.table,key:ch.key,revision:l?.revision || row(ch.table,ch.key).revision};})};
  }
  function summary(u,sid,subject,start,end) {
    const rows=[],key=subjectKey(subject),checks=Object.fromEntries(records().filter(r=>r.kind==='checks' && r.student_id===sid).map(r=>[r.key,r.data]));
    const tasks=records().filter(r=>r.kind==='tasks' && r.student_id===sid && subjectOf(r.data)===key && !r.data.deleted && !['report_snapshot','mgoal','academic_event','material_request','metamath_request','lecture_request','lecture_response'].includes(r.data.kind) && (r.data.kind!=='material_response' || r.data.status==='provided') && (r.data.kind!=='metamath_response' || r.data.status==='assigned')).map(r=>r.data);
    guard((Date.parse(end)-Date.parse(start))/86400000<=730,'PERIOD','조회 기간은 2년 이내로 선택해 주세요.');
    for(let ms=Date.parse(start);ms<=Date.parse(end);ms+=86400000) {
      const day=new Date(ms).toISOString().slice(0,10),dow=new Date(ms).getUTCDay();
      for(const t of tasks) {
        const moves=checks['__weekmove__'+sid+'|all']?.moves || [];
        const occurs=moves.some(m=>m.taskId===t.id && m.to===day) || !moves.some(m=>m.taskId===t.id && m.from===day) && day>=(t.start || '') && (!t.end || day<=t.end) && (t.repeat==='once'?day===t.start:t.repeat==='daily'?true:t.repeat==='weekday'?dow>0 && dow<6:t.repeat==='days'?(t.days || []).includes(dow):false);
        if(!occurs)continue;const c=checks[t.id+'|'+day] || {};
        rows.push({id:t.id,title:t.title,due:day,subject,self_done:Number(!!c.done),checked:Number(!!c.checked)});
      }
      for(const item of checks['__ingp__'+sid+'|'+day]?.items || []) {
        const c=course(sid,item.cid);if(!c || subjectOf(c)!==key)continue;
        rows.push({id:'ing:'+item.cid+':'+item.seq,title:c.name+' '+item.seq+'강',due:day,subject,self_done:Number(!!item.done),checked:0});
      }
    }
    return rows;
  }
  function questions(u,p) {
    guard(u.role!=='guardian','ROLE','열람 범위가 아닙니다.',403);
    const visibleQuestion=r=>canAccess(u,r.student_id) && scope(u,r.student_id,subjectKey(r.subject));
    if(p.action==='list') return {submissions:all('SELECT * FROM planner_questions').filter(r=>visibleQuestion(r) && (!p.owner || r.student_id===p.owner)).map(r=>({...JSON.parse(r.data),revision:r.revision})).filter(r=>!p.status || r.status===p.status)};
    if(p.action==='submit_question') {
      guard(u.role==='student','ROLE','질문은 학생 계정에서 등록해 주세요.',403);
      guard(typeof p.clientRequestId==='string' && /^[\w-]{8,100}$/.test(p.clientRequestId));
      guard(typeof p.bodyText==='string' && p.bodyText.trim().length>0 && p.bodyText.length<=4000);clean(p.bodyText);
      let subject=subjectKey(p.subject);
      if(p.taskId) {const t=task(p.taskId);guard(t?.staffId===u.id,'SCOPE','본인 공부에만 질문을 연결할 수 있습니다.',403);subject=subjectOf(t);}
      const id=u.id+'-'+p.clientRequestId,prior=one('SELECT * FROM planner_questions WHERE id=?',id);
      if(prior){guard(JSON.parse(prior.data).bodyText===p.bodyText,'CONFLICT','중복 요청 내용을 확인해 주세요.',409);return {id};}
      const data={id,owner:u.id,subject,kind:'question',taskId:p.taskId || '',taskDate:p.taskDate || '',bodyText:p.bodyText,answerText:'',reviewNote:'',status:'pending',hasImage:false,createdAt:stamp(),updatedAt:stamp()};
      run('INSERT INTO planner_questions(id,student_id,subject,data) VALUES(?,?,?,?)',id,u.id,subject,JSON.stringify(data));return {id};
    }
    const r=one('SELECT * FROM planner_questions WHERE id=?',p.id);guard(r && visibleQuestion(r),'SCOPE','현재 열람 범위의 질문이 아닙니다.',403);revision(r,p.revision);
    const data=JSON.parse(r.data);
    if(p.action==='cancel') {guard(u.role==='student' && u.id===r.student_id && data.status==='pending','ROLE','취소할 수 없는 질문입니다.',403);data.status='cancelled';}
    else {guard(['owner','admin','teacher'].includes(u.role) && p.action==='answer' && data.status==='pending','ROLE','답변 권한이나 상태를 확인해 주세요.',403);guard(typeof p.answerText==='string' && p.answerText.trim() && p.answerText.length<=4000);clean(p.answerText);data.answerText=p.answerText;data.status='answered';}
    data.updatedAt=stamp();run('UPDATE planner_questions SET data=?,revision=revision+1 WHERE id=?',JSON.stringify(data),r.id);return {id:r.id};
  }
  function publicReports(u) {
    if(u.role==='teacher')return [];
    const latest=new Map();
    for(const r of records().filter(r=>r.kind==='tasks' && r.data.kind==='report_snapshot' && canAccess(u,r.student_id))) {
      const d=r.data,prev=latest.get(d.seriesKey);if(!prev || prev.reportRevision<d.reportRevision)latest.set(d.seriesKey,d);
    }
    return [...latest.values()].filter(d=>d.reportStatus==='published' && d.snapshot).map(d=>({...pick(d,['id','title','reportRevision','reportType','periodKey','publishedAt']),snapshot:publicSnapshot(d.snapshot)}));
  }
  return {state,save,summary,questions,publicReports,accessReceipt:(u,p)=>{for(const ch of p.changes || []){const info=describe(ch.table,ch.key,ch.data);access(u,info.sid);if(info.subject)scoped(u,info.sid,info.subject);}}};
}
