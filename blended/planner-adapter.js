// consult 원본 뒤에 조립한다. 원본 저장·인증 경로를 실행하기 전에 전용 경계로 교체한다.
let blendedMe=null, blendedSubjects={}, blendedBase=new Map(), blendedPending=null, blendedLoaded=false;
const blendedKey=r=>r.table+'\n'+r.key;
const blendedJson=v=>JSON.stringify(v);
async function blendedApi(action,payload={},requestId) {
  let response;
  try {response=await fetch('/blended/api',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Blended-Request':'1'},body:JSON.stringify({app:'blended',action,payload,requestId}),signal:AbortSignal.timeout(20000)});}
  catch {throw new Error('연결하지 못했습니다. 변경 내용은 이 화면에 남아 있습니다. 다시 저장해 주세요.');}
  const data=await response.json();
  if(!response.ok) {
    if(response.status===401) {blendedMe=null;$('#view').innerHTML='<div class="card">로그인 시간이 지났습니다. <a href="/blended/?student='+encodeURIComponent(viewStaff || new URLSearchParams(location.search).get('student') || '')+'">다시 로그인</a></div>';}
    throw Object.assign(new Error(data.error || '저장하지 못했습니다.'),{status:response.status,code:data.code});
  }
  return data;
}
const blendedRows=()=>[
  ...state.staff.map(data=>({table:'staff',key:data.id,data})),
  ...state.tasks.map(data=>({table:'tasks',key:data.id,data})),
  ...Object.entries(state.checks).map(([key,data])=>({table:'checks',key,data}))
];
function blendedChanges() {
  return blendedRows().filter(r=>blendedJson(r.data)!==blendedBase.get(blendedKey(r))?.json)
    .map(r=>({...r,data:JSON.parse(blendedJson(r.data)),revision:blendedBase.get(blendedKey(r))?.revision || 0}));
}
function blendedApply(remote,preserve=[]) {
  blendedMe=remote.me;blendedSubjects=remote.subjects;
  const previousBase=blendedBase;
  const rows=new Map(remote.rows.map(r=>[blendedKey(r),r]));
  blendedBase=new Map(remote.rows.map(r=>[blendedKey(r),{json:blendedJson(r.data),revision:r.revision}]));
  // 새 접근 범위에 속하는 학생의 화면 내 미저장 변경만 보존한다.
  const allowed=new Set(remote.rows.filter(r=>r.table==='staff').map(r=>r.key));
  for(const r of preserve) {
    const sid=r.table==='staff'?r.key:r.table==='tasks'?r.data.staffId:ownerOfCheck(r.key);if(!allowed.has(sid))continue;
    const key=blendedKey(r),before=previousBase.get(key),received=blendedBase.get(key);
    if((before?.revision || 0)!==(received?.revision || 0)) {
      // 전송 중 다른 기기가 수정했으면 새 revision에 내 내용을 자동으로 덮어씌우지 않는다.
      if(before)blendedBase.set(key,before);else blendedBase.delete(key);
      rows.set(key,r);
    } else {
      const base=before?JSON.parse(before.json):{},merged={...(rows.get(key)?.data || {})};
      for(const k of new Set([...Object.keys(base),...Object.keys(r.data)]))if(blendedJson(base[k])!==blendedJson(r.data[k])) {if(Object.hasOwn(r.data,k))merged[k]=r.data[k];else delete merged[k];}
      rows.set(key,{...r,data:merged});
    }
  }
  state.staff=[];state.tasks=[];state.checks={};
  for(const r of rows.values()) {if(r.table==='checks')state.checks[r.key]=r.data;else state[r.table].push(r.data);}
  state.settings.centerName='WB 블렌디드';
  sync.dirty=blendedChanges().length>0;
}
Object.defineProperties(session,{
  staffId:{get:()=>blendedMe?.role==='student'?blendedMe.id:''},
  isStaffLink:{get:()=>blendedMe?.role==='student'},
  isAdmin:{get:()=>['owner','admin','teacher'].includes(blendedMe?.role)}
});
session.unlock=()=>{};session.lock=()=>{};
sync.auth=()=>blendedMe?{mode:session.isStaffLink?'person':'admin_device',id:blendedMe.id}:null;
sync.url=()=>'/blended';
save=function(){sync.dirty=blendedChanges().length>0;paintStatus();return true;};
load=function(){};
studentPhoneReady=()=>true;
sync.post=async function(path,body) {
  if(path==='/consult-submission') {
    const payload={...body,subject:$('#submissionSubject')?.value || ''};delete payload.auth;delete payload.app;
    return blendedApi(body.action==='list'?'planner_questions':'planner_question',payload,crypto.randomUUID());
  }
  throw new Error('이 외부 연동은 아직 연결되지 않았습니다. 입력한 내용을 보존했습니다.');
};
sync.run=async function() {
  if(!blendedMe || this.busy)return;
  this.busy=true;paintStatus();
  try {
    const changes=blendedChanges();
    if(!blendedPending && changes.length) {
      let bytes=0;
      const batch=changes.slice(0,400).filter(r=>{bytes+=blendedJson(r).length;return bytes<650000;});
      if(!batch.length)throw new Error('한 기록의 크기가 너무 큽니다. 입력을 줄여 주세요.');
      blendedPending={changes:batch,requestId:crypto.randomUUID()};
    }
    this.confirmed=new Map();
    if(blendedPending) {
      const sent=blendedPending;
      const result=await blendedApi('planner_save',{changes:sent.changes},sent.requestId);
      for(const r of result.saved) {
        const original=sent.changes.find(c=>blendedKey(c)===blendedKey(r));
        blendedBase.set(blendedKey(r),{json:blendedJson(original.data),revision:r.revision});
        this.confirmed.set(blendedKey(r),Number(original.data.updatedAt || 0));
        state.settings.pushAt=Math.max(Number(state.settings.pushAt || 0),Number(original.data.updatedAt || 0));
      }
      blendedPending=null;
    }
    const preserve=blendedChanges();
    blendedApply(await blendedApi('planner_state'),preserve);
    this.last=now();this.err='';
    renderAfterSync();
    if(this.dirty) {clearTimeout(this.timer);this.timer=setTimeout(()=>this.run(),100);}
  } catch(error) {
    this.err=error.message;this.dirty=blendedChanges().length>0;
    const bar=$('#blended-save');if(bar)bar.hidden=false;
  } finally {this.busy=false;paintStatus();}
};
paintStatus=function() {
  if(!blendedMe)return;
  const roles={owner:'원장',admin:'관리자',teacher:'강사',student:'학생'};
  $('#whoami').textContent=blendedMe.name+' · '+roles[blendedMe.role];
  $('#whoami').className='whoami';$('#whoami').dataset.blended='account';
  const bar=$('#blended-save');if(!bar)return;
  bar.hidden=!(sync.busy || sync.dirty || sync.err);
  bar.className='blended-save'+(sync.err?' error':'');
  bar.innerHTML='<span role="status">'+esc(sync.err || (sync.busy?'저장 확인 중…':'저장 대기 · 화면을 닫지 말아 주세요.'))+'</span>'+
    (sync.err?'<button data-blended="retry">다시 저장</button><button data-blended="download">내 수정본 내려받기</button><button data-blended="reload">최신 내용 불러오기</button>':'');
};
const originalCanEditTask=canEditTask;
canEditTask=t=>!t?false:!t._blendedId && originalCanEditTask(t);
const originalSetCheck=setCheck;
setCheck=function(taskId,date,patch) {
  if(blendedMe?.role==='teacher' && /^__(weekplan|monthplan)__/.test(taskId) && patch.plan)patch={...patch,plan:{subjectGoals:patch.plan.subjectGoals || {}}};
  return originalSetCheck(taskId,date,patch);
};
const originalPointGauge=pointGaugeHtml;
pointGaugeHtml=sid=>blendedMe?.role==='teacher'?'':originalPointGauge(sid).replaceAll('기프트 카드 포인트','학습 포인트 · 교환 미연동').replace(/[^<>]+더 모으면 기프트 카드 교환/,'포인트 적립 현황 · 실제 교환 미연동').replace(/꾸준히 학습하고 주간·월간 마무리까지 하면[^<]+/,'학습 습관을 확인하는 참고 포인트입니다. 실제 기프트 카드 교환은 연결 대기입니다.');
createStudentLink=async()=>location.origin+'/blended/';
const originalSaveReportNotes=saveVisibleReportNotes;
saveVisibleReportNotes=(...args)=>blendedMe?.role==='teacher'?undefined:originalSaveReportNotes(...args);
const originalRoadmap=viewRoadmap;
viewRoadmap=()=>session.isStaffLink && !studyRoadmapAvailable(currentStaff())?'<div class="card">아직 배정된 교재 로드맵이 없습니다. 담당 선생님에게 목표와 교재 계획을 확인해 주세요.</div>':originalRoadmap();
renderTabs=function() {
  $('#tabs').innerHTML=blendedNavigation(blendedMe.role,currentStaff()?.id,route,true);
};
const originalMonth=viewMonth,originalAcademic=viewAcademic;
const scheduleSections=()=>'<div class="blended-sections" aria-label="일정·학사 보기"><button class="btn '+(route==='month'?'btn-primary':'btn-ghost')+'" data-go="month">월간 일정·계획</button><button class="btn '+(route==='academic'?'btn-primary':'btn-ghost')+'" data-go="academic">시험·수행평가·자료 요청</button></div>';
viewMonth=()=>scheduleSections()+originalMonth();
viewAcademic=()=>scheduleSections()+originalAcademic().replace('🎓 학사관리','🎓 시험·수행평가');
const originalEmpty=emptyStaffCard;
emptyStaffCard=()=>'<div class="card"><h2>등록된 담당 학생이 없습니다.</h2><p>'+(blendedMe?.role==='teacher'?'관리자에게 학생·과목 담당 배정을 요청해 주세요.':'학생 계정을 등록하고 강사에게 과목과 담당 기간을 배정해 주세요.')+'</p>'+(['owner','admin'].includes(blendedMe?.role)?'<a class="btn btn-primary" href="/blended/#/management">학생·강사 관리 열기</a>':'')+'</div>';
const originalRender=render;
render=function() {
  if(!blendedLoaded)return;
  if(['settings','staff','results'].includes(route)) {location.href='/blended/#/'+(route==='staff'?'management':route==='results'?'reports':'account');return;}
  const unassignedRoadmap=route==='roadmap' && session.isStaffLink && !studyRoadmapAvailable(currentStaff());
  if(viewStaff && !state.staff.some(s=>s.id===viewStaff)) {$('#view').innerHTML='<div class="card" role="alert"><h2>요청한 학생을 열 수 없습니다.</h2><p>학생 연결이나 담당 권한이 변경되었습니다. 학원에서 연결을 확인해 주세요.</p><a href="/blended/planner/">내 플래너 목록으로</a></div>';return;}
  originalRender();
  if(unassignedRoadmap){route='roadmap';renderTabs();$('#view').innerHTML=viewRoadmap();}
  if(session.isAdmin && currentStaff()) {
    const sid=currentStaff().id;
    if(route==='today' || route==='board') {
      const items=tasksFor(sid,cursor);
      const section=document.createElement('section');section.className='card blended-review-card';section.innerHTML='<div class="card-title">강사 학습 확인</div><p class="hint">학생 완료 표시와 강사 확인을 따로 기록합니다.</p>'+items.map(t=>{const c=getCheck(t.id,cursor)||{};return '<div class="blended-review"><span>'+esc(t.title)+'<small>'+(c.done?'학생 완료':'학생 수행 전')+' · '+(c.checked?'강사 확인 완료':'확인 대기')+'</small></span><button class="btn btn-sm" data-blended="check" data-id="'+esc(t.id)+'">확인·피드백</button></div>';}).join('');$('#view').prepend(section);
    }
  }
  if(blendedMe?.role==='teacher') {
    $('#view').insertAdjacentHTML('afterbegin','<p class="hint mt14">담당 과목의 자료만 표시합니다. 전체 마감·포인트·최종 발행은 학생·원장 화면에서 확인합니다.</p>');
    for(const el of document.querySelectorAll('[data-act="reportpublish"],[data-act="reportwithdraw"],[data-act="weekclosesave"],[data-act="monthclosesave"]')) {el.disabled=true;el.title='최종 발행·전체 마감은 원장이 확인합니다.';}
  }
  if(session.isAdmin) for(const el of document.querySelectorAll('[data-act="toggle"],[data-act="step"],[data-act="sttask"],[data-act="sttoggle"],[data-act="ingcheck"]')) {el.disabled=true;el.title='학생 계정에서 수행을 기록합니다. 강사는 위쪽 확인·피드백을 사용해 주세요.';}
  const view=$('#view'), next=$('#todayNextAction'), planner=$('#studyPlanner');
  if(next) {
    const rewards=[...next.querySelectorAll('.engagement-mini')];
    const gauge=next.querySelector('[class*="point-gauge"]');if(gauge)rewards.unshift(gauge);
    if(rewards.length) {const details=document.createElement('details');details.className='blended-rewards card';details.innerHTML='<summary>포인트·스탬프 보기</summary>';for(const node of rewards)details.append(node);view.append(details);}
    for(const button of next.querySelectorAll('[data-act="todayjump"]'))if(button.textContent.includes('공부 시작'))button.textContent='체크리스트 보기';
  }
  if(planner && next && !session.isAdmin) {
    next.after(planner);
    next.insertAdjacentHTML('beforebegin','<div class="blended-workflow" aria-label="오늘 학습 바로가기"><button class="btn" data-blended="jump" data-target="studyPlanner">체크리스트</button><button class="btn" data-blended="jump" data-target="blendedTimer">순공 타이머</button><button class="btn" data-blended="jump" data-target="dailyCloseCard">오늘 마무리</button></div>');
  }
  const timer=view.querySelector('.study-planner-pane[aria-label="과목별 순공시간"]');if(timer)timer.id='blendedTimer';
  if(currentStaff())view.insertAdjacentHTML('afterbegin','<p class="blended-student-context">'+(session.isAdmin?'선택한 학생: ':'내 플래너: ')+esc(currentStaff().name)+(session.isAdmin?' · 수행 기록은 학생이 작성하고, 강사는 확인·피드백을 남깁니다.':' · 기록 → 타이머 → 오늘 마무리')+'</p>');
  for(const button of view.querySelectorAll('[data-act="day"]'))button.setAttribute('aria-label',Number(button.dataset.n)<0?'이전 날짜':'다음 날짜');
  for(const [action,label] of Object.entries({stgoal:'하루 순공 목표 설정',stedit:'순공시간 수정'}))for(const button of view.querySelectorAll('[data-act="'+action+'"]'))button.setAttribute('aria-label',label);
  for(const button of view.querySelectorAll('.navbtn:not([aria-label])'))button.setAttribute('aria-label',button.textContent.trim()==='‹'?'이전 기간':'다음 기간');
  const quick=$('#qAdd');if(quick && !view.querySelector('label[for="qAdd"]'))quick.parentElement.insertAdjacentHTML('beforebegin','<label class="blended-quick-label" for="qAdd">오늘 할 공부 추가</label>');
  blendedScopeControls();
};
function blendedScopeControls() {
  if(blendedMe?.role!=='teacher')return;
  const allowed=blendedSubjects[currentStaff()?.id] || [];
  for(const option of document.querySelectorAll('select option'))if(STUDY_SUBJECTS[option.value] && !allowed.includes(option.value))option.disabled=true;
  for(const input of document.querySelectorAll('[data-weekgoal],[data-monthgoal]'))if(!allowed.includes(input.dataset.weekgoal || input.dataset.monthgoal))input.disabled=true;
  for(const button of document.querySelectorAll('[data-act]'))if(/^(weekclose|monthclose|dailyclose|monthevent|weekmove)|^st(goal|edit|save|subjadd)$/.test(button.dataset.act)) {button.disabled=true;button.title='학생 전체 일정·마감 설정은 학생 또는 원장이 관리합니다.';}
}
let blendedFeedbackBaseline='';
const blendedFeedbackDirty=()=>!!$('#blendedFeedback') && $('#blendedFeedback').value!==blendedFeedbackBaseline;
const originalCloseModal=closeModal;
closeModal=function() {
  if(blendedFeedbackDirty() && !confirm('아직 저장하지 않은 피드백을 버리고 닫을까요?'))return false;
  return originalCloseModal();
};
const originalModal=modal;
modal=function(...args) {
  originalModal(...args);blendedFeedbackBaseline=$('#blendedFeedback')?.value || '';blendedScopeControls();
  for(const id of ['ingImages']) {const input=document.getElementById(id);if(input) {input.disabled=true;input.title='자동 수집 연결 대기 · 아래 목차를 직접 입력해 주세요.';}}
  for(const button of document.querySelectorAll('[data-act="ingimage"],[data-act="ingfetchurl"]')) {button.disabled=true;button.textContent+=' · 연결 대기';}
};
// 금전 교환·실제 연락·원본 계정 설정은 이 앱의 승인된 기능 범위에 포함하지 않는다.
const blendedUnavailable={
  pointrequest:'기프트 카드 교환·실제 발송은 연결 대기입니다. 학습 포인트 내역은 확인할 수 있습니다.',
  pointclaim:'기프트 카드 처리는 연결 대기입니다.',pointfulfill:'기프트 카드 처리는 연결 대기입니다.',
  resultupload:'PDF 결과지 업로드는 전용 파일 저장소 연결 대기입니다. 주간·월간 리포트 인쇄는 사용할 수 있습니다.',
  ingimage:'목차 사진 자동 인식은 연결 대기입니다. 목차를 직접 붙여넣어 강좌를 등록할 수 있습니다.',
  ingfetchurl:'주소에서 목차 자동 수집은 연결 대기입니다. 목차를 직접 붙여넣어 강좌를 등록할 수 있습니다.',
  submissionproof:'인증사진 업로드는 전용 파일 저장소 연결 대기입니다. 텍스트 질문은 학습 메뉴에서 남길 수 있습니다.',
  learningloginsave:'외부 학습 사이트의 비밀번호는 이 플래너에 보관하지 않습니다.',
  export:'전체 자료 내보내기는 관리자 자료 관리 연결 대기입니다.'
};
const originalSubmissionModal=submissionModal;
submissionModal=function(...args) {
  originalSubmissionModal(...args);
  const file=$('#submissionFile');if(file){file.disabled=true;file.parentElement.innerHTML='<p class="hint">현재 글 질문을 지원합니다. 사진 업로드는 연결 대기입니다.</p>';}
  const preview=$('#submissionPreview');if(preview)preview.remove();
  const privacy=document.querySelector('.submission-privacy');if(privacy)privacy.textContent='질문은 본인과 담당 과목 강사·관리자만 열람합니다.';
};
document.addEventListener('click',async e=>{
  const button=e.target.closest('[data-blended]'),original=e.target.closest('[data-act]');
  if(original && blendedUnavailable[original.dataset.act]) {e.preventDefault();e.stopImmediatePropagation();toast(blendedUnavailable[original.dataset.act]);return;}
  if(original && ['reportpublish','reportwithdraw'].includes(original.dataset.act) && blendedMe?.role!=='owner') {e.preventDefault();e.stopImmediatePropagation();toast('최종 발행은 원장이 진행합니다.');return;}
  if(!button)return;e.preventDefault();e.stopImmediatePropagation();
  const action=button.dataset.blended;
  if(action==='jump'){const target=document.getElementById(button.dataset.target);if(target){target.scrollIntoView({block:'start'});target.tabIndex=-1;target.focus({preventScroll:true});}else toast('오늘 마무리는 해당 날짜의 학습 기록이 있을 때 열립니다.');return;}
  if(action==='account'){location.href='/blended/#/account';return;}
  if(action==='retry'){await sync.run();return;}
  if(action==='download') {
    const url=URL.createObjectURL(new Blob([JSON.stringify({app:'blended',changes:blendedChanges()},null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='블렌디드-미저장-수정본.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
  }
  if(action==='reload') {
    if(!confirm('이 화면의 미저장 수정은 사라집니다. 필요하면 먼저 수정본을 내려받아 주세요. 최신 서버 내용을 불러올까요?'))return;
    try {const remote=await blendedApi('planner_state');blendedPending=null;blendedApply(remote);sync.err='';render();}catch(error){toast(error.message);}return;
  }
  if(action==='check') {
    const t=state.tasks.find(t=>t.id===button.dataset.id),c=getCheck(t.id,cursor)||{};
    modal('강사 확인 · '+t.title,'<p>학생 수행: '+(c.done?'완료 표시':'수행 전')+'</p><label>확인한 내용과 피드백<textarea class="in" id="blendedFeedback" maxlength="2000">'+esc(c.feedback || '')+'</textarea></label>', '<button class="btn btn-primary" data-blended="checksave" data-id="'+esc(t.id)+'" data-date="'+cursor+'">확인 저장</button>');return;
  }
  if(action==='checksave') {
    const feedback=$('#blendedFeedback').value.trim();if(!feedback)return toast('확인 내용을 입력해 주세요.');
    setCheck(button.dataset.id,button.dataset.date,{checked:true,feedback});await sync.run();if(!sync.err){blendedFeedbackBaseline=$('#blendedFeedback').value;closeModal();render();toast('강사 확인을 저장했습니다.');}
  }
},true);
window.addEventListener('beforeunload',e=>{if(sync.dirty || blendedPending || blendedFeedbackDirty()){e.preventDefault();e.returnValue='';}});
async function startBlendedPlanner() {
  try {
    const remote=await blendedApi('planner_state');blendedApply(remote);blendedLoaded=true;
    const h=routeFromHash(location.hash);if(h)route=h;
    viewStaff=new URLSearchParams(location.search).get('student') || '';
    render();setInterval(()=>sync.run(),45000);
    if(session.isStaffLink){await ensureCloseoutActivation(false);renderAfterSync();}
  } catch(error) {
    if(error.status===401)location.replace('/blended/'+(new URLSearchParams(location.search).get('student')?'?student='+encodeURIComponent(new URLSearchParams(location.search).get('student')):''));
    else $('#view').innerHTML='<div class="card">'+esc(error.message)+'<br><a href="/blended/planner/">다시 열기</a></div>';
  }
}
startBlendedPlanner();
