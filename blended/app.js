'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const roles = {owner:'원장',admin:'관리자',teacher:'강사',student:'학생',guardian:'보호자'};
  if(location.pathname==='/blended/academy-entry/') {
    const ticket=new URLSearchParams(location.hash.slice(1)).get('ticket');history.replaceState(null,'',location.pathname);
    $('#main').innerHTML='<section class="sheet"><h1>학원 로그인으로 연결하고 있어요.</h1></section>';
    fetch('/blended/academy-exchange',{method:'POST',headers:{'Content-Type':'application/json','X-Blended-Request':'1'},body:JSON.stringify({ticket})}).then(async response=>{const result=await response.json();if(!response.ok)throw Error(result.error || '학원에서 플래너를 다시 열어 주세요.');location.replace('/blended/planner/?student='+encodeURIComponent(result.studentId)+'#/today');}).catch(error=>{$('#main').innerHTML='<section class="sheet" role="alert"><h1>로그인을 연결하지 못했어요.</h1><p>'+esc(error.message)+'</p><a href="https://blended-academy.wbcowork.com/ops/">학원 앱으로</a></section>';});return;
  }
  const statuses = {draft:'초안',review:'검토 대기',published:'발행',withdrawn:'철회'};
  const labels = {studentVoice:'학생 의견',facts:'함께 확인한 점',strengths:'잘한 점',guidance:'다음 지도 방향',home:'가정 협조 사항',nextGoal:'다음 실천 목표',due:'실천 기한',nextCheck:'다음 확인일'};
  let runtime = {mode:'production',ready:false};
  let state = null, tab = location.hash.slice(2) || 'learning', selected = new URLSearchParams(location.search).get('student') || '', day = '', editing = null, busy = false;
  let editorBaseline = '';
  const discardDialog = $('#discard-editor');
  const dialog = $('#editor'), retries = new WeakMap();
  const isStaff = () => ['owner','admin','teacher'].includes(state?.me.role);
  const isAdmin = () => ['owner','admin'].includes(state?.me.role);
  const name = id => state.students.find(s => s.id === id)?.name || id;
  const button = (action,label,id = '',style = 'quiet small') => `<button type="button" class="${style}" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
  const pill = (label,color = '') => `<span class="pill ${color}">${esc(label)}</span>`;
  const empty = message => `<div class="empty">${esc(message)}</div>`;
  const options = (rows,value) => rows.map(([id,label]) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
  const input = (name,label,value = '',type = 'text',extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const area = (name,label,value = '',required = false) => `<label>${label}<textarea name="${name}" maxlength="2000" ${required ? 'required' : ''}>${esc(value)}</textarea></label>`;
  function notice(message = '',error = false) { $('#notice').textContent = message; $('#notice').className = error ? 'error' : ''; }
  async function api(action,payload = {},requestId) {
    let response;
    try { response = await fetch('/blended/api',{method:'POST',headers:{'Content-Type':'application/json','X-Blended-Request':'1'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({app:'blended',action,payload,requestId}),signal:AbortSignal.timeout(12000)}); }
    catch { throw new Error('연결하지 못했습니다. 입력은 이 화면에 남아 있습니다. 화면을 닫지 말고 다시 시도해 주세요.'); }
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 && action !== 'login') { state = null; closeEditor(true); loginView(); }
      throw Object.assign(new Error(result.error || '요청을 처리하지 못했습니다.'),{code:result.code});
    }
    return result;
  }
  function loginView() {
    $('#identity').innerHTML = '';
    $('#main').innerHTML = `<div class="login"><section><h1>오늘의 학습이<br>다음 약속으로.</h1><p class="lead">해야 할 일을 정하고, 배움을 확인하고,<br>함께 다음 한 걸음을 만듭니다.</p><div class="login-preview"><p>학습 배정과 학생의 질문</p><p>강사의 확인과 상담</p><p>날짜가 있는 약속과 공개 리포트</p></div></section><section class="sheet"><h2>내 계정으로 시작하기</h2><p class="hint">각 계정은 본인에게 허용된 자료만 볼 수 있습니다.</p><form data-form="login">${input('login','아이디','','text','required autocomplete="username" maxlength="60"')}${input('password','비밀번호','','password','required autocomplete="current-password" maxlength="128"')}<div class="error-box" role="alert"></div><button type="submit">로그인</button></form>${runtime.mode === 'synthetic-local' ? `<details class="demo-details"><summary>가상 체험 계정 보기</summary><p>원장 owner / 관리자 admin<br>강사 teacher-a, teacher-b<br>학생 student-a, student-b<br>보호자 guardian-a, guardian-b</p><p>비밀번호: <code>Demo-아이디-2026!</code><br>예: <code>Demo-teacher-a-2026!</code></p><p>모두 로컬 가상 계정입니다. 운영 계정이 아닙니다.</p></details>` : (!runtime.ready ? '<p class="hint">원장 계정 최초 설정을 기다리고 있습니다.</p>' : '')}</section></div>`;
  }
  async function refresh() {
    state = await api('state');
    if(!location.hash && state.me.role !== 'guardian') {location.replace('/blended/planner/'+(selected?'?student='+encodeURIComponent(selected):''));return;}
    day ||= state.today;
    if(selected && !state.students.some(s=>s.id===selected) && (state.me.role!=='guardian' || new URLSearchParams(location.search).get('student'))) {$('#main').innerHTML='<section class="sheet" role="alert"><h1>요청한 학생을 열 수 없습니다.</h1><p>현재 계정의 담당 권한이나 학원 연결을 확인해 주세요.</p><a href="/blended/">내 플래너로</a></section>';return;}
    if(!state.students.some(s=>s.id===selected))selected = state.students[0]?.id || '';
    if (editing?.student_id && !state.students.some(s => s.id === editing.student_id)) { closeEditor(true); notice('담당 또는 열람 권한이 변경되어 편집을 닫았습니다.',true); }
    render();
  }
  function nav() {
    const items = state.me.role === 'guardian' ? [['reports','자녀 리포트'],['account','내 계정']] : isStaff()
      ? [['learning','담당 학습'],['consultations','상담·약속'],['reports','리포트'],...(isAdmin() ? [['management','강사·담당 관리']] : []),['account','내 계정']]
      : [['learning','오늘 학습'],['week','이번 주'],['reports','상담·리포트'],['account','내 계정']];
    if (!items.some(i => i[0] === tab)) tab = items[0][0];
    return `<nav class="tabs" aria-label="주 메뉴">${items.map(([key,label]) => `<button type="button" data-tab="${key}" ${tab === key ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav>`;
  }
  function filters(withDate = false) {
    return `<div class="filters"><label>${state.me.role === 'student' ? '내 플래너' : '학생 선택'}<select id="student-filter">${options(state.students.map(s => [s.id,s.name]),selected)}</select></label>${withDate ? `<label>학습 날짜<input id="day-filter" type="date" value="${esc(day)}"></label>` : ''}${button('refresh','최신 내용 확인')}</div>`;
  }
  function sidebar() { return `<aside><section class="flow"><h2>함께 이어가는 학습</h2><ol><li>학습 배정</li><li>학생 수행·질문</li><li>강사 확인</li><li>학습 상담</li><li>다음 실천 목표</li><li>리포트 검토·발행</li></ol><small>상담 완료와 리포트 발행은 따로 진행합니다.</small></section><p class="aside-note">학원 연결 대기<br>외부 학습 성적 미연동<br>보호자 알림 발송 비활성</p></aside>`; }
  function render() {
    $('#identity').innerHTML = `<span>${esc(state.me.name)} · ${roles[state.me.role]}</span>${button('logout','로그아웃')}`;
    const navigation = nav();
    const titles = {learning:isStaff() ? '학습의 다음 단계를 살펴보세요.' : '오늘, 한 가지씩 해봐요.',week:'이번 주의 학습과 약속',consultations:'배운 것을 돌아보고, 다음을 정해요.',reports:'함께 확인하는 성장 기록',management:'강사와 담당 학생 연결',account:'내 계정과 연결 상태'};
    const descriptions = {learning:'학생의 완료 표시와 강사의 학습 확인을 구분합니다.',week:'기한이 지난 학습은 날짜를 바꾸지 않고 남겨둡니다.',consultations:'지난 약속과 학습 기록을 바탕으로 상담을 준비합니다.',reports:'공개 내용만 검토해 발행합니다. 실제 알림은 발송되지 않습니다.',management:'개별 계정에 과목과 기간을 정해 담당 권한을 부여합니다.',account:'현재 로그인과 서비스 연결 상태를 확인합니다.'};
    $('#main').innerHTML = `${blendedNavigation(state.me.role,selected,tab)}<div class="intro"><div><h1>${titles[tab]}</h1><p>${descriptions[tab]}</p></div><div class="date-label">${esc(state.today)}</div></div>${navigation}<div id="view"></div>`;
    const views = {learning:learningView,week:learningView,consultations:consultationsView,reports:reportsView,management:managementView,account:accountView};
    $('#view').innerHTML = views[tab]();
    if(tab==='reports') {
      const periods=(state.periodReports || []).filter(r=>r.snapshot.student.id===selected);
      if(periods.length)$('#view').innerHTML+=`<section class="sheet"><h2>주간·월간 학습 리포트</h2>${periods.map(r=>`<article class="report"><h3>${esc(r.title)}</h3><p>${pill('v'+r.reportRevision)} ${button('period-report','공개 학습 리포트 보기',r.id)}</p></article>`).join('')}</section>`;
    }
  }
  function learningView() {
    const rows = state.learning.filter(l => l.student_id === selected);
    let visible = rows.filter(l => l.due === day);
    if (tab === 'week') {
      const start = new Date(day+'T00:00:00Z'); start.setUTCDate(start.getUTCDate() - (start.getUTCDay()+6)%7);
      const end = new Date(start); end.setUTCDate(end.getUTCDate()+6);
      visible = rows.filter(l => l.due >= start.toISOString().slice(0,10) && l.due <= end.toISOString().slice(0,10));
    }
    const overdue = rows.filter(l => l.due < day && !l.checked && !visible.includes(l));
    return `<div class="workspace"><div>${filters(true)}<section class="sheet"><div class="sheet-head"><h2>${tab === 'week' ? '주간 학습' : '선택한 날짜의 학습'}</h2>${isStaff() && selected ? button('new-learning','학습 배정','','small') : ''}</div><div class="summary"><span><strong>${visible.length}</strong>배정</span><span><strong>${visible.filter(l => l.self_done).length}</strong>학생 완료</span><span><strong>${visible.filter(l => l.checked).length}</strong>강사 확인</span></div><div class="rows">${visible.map(learningRow).join('') || empty('배정된 학습이 없습니다. 학습 기록 없음은 미수행이나 0점을 뜻하지 않습니다.')}</div></section>${overdue.length ? `<section class="sheet"><h2>이전 날짜에서 이어서 확인</h2>${overdue.map(learningRow).join('')}</section>` : ''}</div>${sidebar()}</div>`;
  }
  function learningRow(l) {
    const link = WBExternalLinks.linkFor(l.link_key);
    return `<article class="learning"><div class="row-top"><div><div class="pills">${pill(l.subject)}${pill(l.due)}${l.source_consultation ? pill('상담에서 정한 약속','green') : ''}</div><h3>${esc(l.title)}</h3></div><div class="pills">${pill(l.self_done ? '학생 완료 표시' : '수행 전',l.self_done ? 'green' : '')}${pill(l.checked ? '강사 확인 완료' : '강사 확인 전',l.checked ? 'green' : 'amber')}</div></div>${l.question ? `<p><b>학생 질문</b> ${esc(l.question)}</p>` : ''}${l.feedback ? `<p><b>강사 피드백</b> ${esc(l.feedback)}</p>` : ''}${link ? `<p><a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.label)} 열기</a> <small>진도·성적 미연동</small></p>` : ''}<div class="actions">${state.me.role === 'student' ? button('perform','완료·질문 남기기',l.id) : button('check','학습 확인',l.id)}</div></article>`;
  }
  function consultationsView() {
    const rows = state.consultations.filter(c => c.student_id === selected);
    return `<div class="workspace"><div>${filters()}<section class="sheet"><div class="sheet-head"><h2>상담 기록</h2>${selected ? button('new-consult','상담 준비','','small') : ''}</div>${rows.map(c => `<article class="learning"><div class="pills">${pill(c.subject)}${pill(c.status === 'complete' ? '상담 완료' : '작성 중')}${pill(statuses[c.report_status],c.report_status === 'published' ? 'green' : 'amber')}</div><h3>${esc(c.held_at.slice(0,10))} 상담</h3><p>다음 약속: ${esc(c.public.nextGoal)}<br><small>기한 ${esc(c.public.due)}</small></p><div class="actions">${button('edit-consult','상담 열기',c.id)}${c.status === 'draft' ? button('complete','상담 완료·약속 연결',c.id) : ''}${c.status === 'complete' && c.report_status === 'draft' ? button('review','리포트 검토 요청',c.id) : ''}</div></article>`).join('') || empty('아직 상담 기록이 없습니다. 학습을 확인한 뒤 첫 상담을 준비해 주세요.')}</section></div>${sidebar()}</div>`;
  }
  function reportsView() {
    const selectedConsults = state.consultations.filter(c => c.student_id === selected);
    const reports = state.reports.filter(r => r.snapshot?.student.id === selected || selectedConsults.some(c => c.id === r.consultation_id));
    const pending = selectedConsults.filter(c => c.report_status === 'review');
    return `${filters()}<section class="sheet"><div class="sheet-head"><h2>${isStaff() ? '검토와 발행 이력' : '공개된 상담 리포트'}</h2>${pill('알림 미발송','amber')}</div>${pending.map(c => `<article class="report"><div class="pills">${pill('검토 대기','amber')}${pill(c.subject)}</div><h3>${esc(c.held_at.slice(0,10))} 상담 공개본</h3><p class="hint">내부 메모는 미리보기와 리포트에 포함되지 않습니다.</p><div class="actions">${button('preview','공개 내용 미리보기',c.id)}${state.me.role === 'owner' ? button('publish','발행 검토',c.id,'small') : pill('원장 최종 발행 대기')}</div></article>`).join('')}${reports.map(r => `<article class="report"><div class="row-top"><div><div class="pills">${pill(`v${r.version}`)}${pill(statuses[r.status],r.status === 'published' ? 'green' : 'red')}</div><h3>${r.snapshot ? esc(r.snapshot.heldAt.slice(0,10))+' 상담 리포트' : '리포트 철회 이력'}</h3><p class="hint">${esc(r.created_at.slice(0,16).replace('T',' '))} UTC${r.reason ? ' / '+esc(r.reason) : ''}</p></div><div class="actions">${r.snapshot ? button('report','공개본 보기',r.id) : ''}${state.me.role === 'owner' && isLatest(r) && r.status === 'published' ? button('withdraw','철회',r.consultation_id,'danger small') : ''}</div></div></article>`).join('')}${!pending.length && !reports.length && !(state.periodReports || []).some(r=>r.snapshot.student.id===selected) ? empty('현재 열람할 수 있는 발행 리포트가 없습니다.') : ''}<p class="hint spacer">발행본은 당시 내용을 보존합니다. 수정본은 새 버전으로 발행하며, 학생·보호자는 최신 유효본만 봅니다.</p></section>`;
  }
  function isLatest(r) { return !state.reports.some(other => other.consultation_id === r.consultation_id && other.version > r.version); }
  function managementView() {
    return `<div class="wide-grid"><section class="sheet"><div class="sheet-head"><h2>강사·관리자 계정</h2>${button('new-teacher','강사 추가','','small')}${state.me.role==='owner'?button('new-admin','관리자 추가','','small'):''}</div>${state.teachers.map(t => `<div class="person-row"><div class="row-top"><div><h3>${esc(t.name)}</h3><small>${esc(t.login)} / ${roles[t.role]}</small></div>${pill(t.active ? '활성' : '비활성',t.active ? 'green' : '')}</div><div class="actions">${t.role === 'teacher' || state.me.role === 'owner' ? button('teacher-status',t.active ? '계정 비활성화' : '계정 활성화',t.id) : ''}</div></div>`).join('')}</section><section class="sheet"><div class="sheet-head"><h2>담당 배정 이력</h2>${button('new-assignment','담당 배정','','small')}</div>${state.assignments.map(a => `<div class="person-row"><h3>${esc(name(a.student_id))} / ${esc(a.subject)}</h3><p>${esc(state.teachers.find(t => t.id === a.teacher_id)?.name || a.teacher_id)}<br><small>${esc(a.starts)} ~ ${esc(a.ends)}</small></p><div class="actions">${pill(a.active ? '배정됨' : '해제됨',a.active ? 'green' : '')}${a.active ? button('unassign','담당 해제',a.id) : ''}</div></div>`).join('') || empty('담당 배정이 없습니다.')}</section></div><section class="sheet spacer"><div class="sheet-head"><h2>학생 계정</h2>${button('new-student','학생 추가','','small')}</div>${state.students.map(s=>`<p>${esc(s.name)} ${pill('서비스 이용 중','green')}</p>`).join('') || empty('학생 계정을 등록한 뒤 담당 강사를 배정해 주세요.')}<h2 class="spacer">보호자 동의 확인</h2><p class="hint">로컬 권한 검증용 동의입니다. 학원 원본의 실제 동의·번호와 연결되지 않았습니다.</p>${state.guardians.map(g => `<div class="person-row"><b>${esc(name(g.student_id))}</b> / ${esc(g.user_id)} ${pill(g.consent ? '가상 동의 있음' : '동의 철회',g.consent ? 'green' : 'red')} ${button('consent',g.consent ? '가상 동의 철회' : '가상 동의 복구',g.user_id+'|'+g.student_id)}</div>`).join('')}</section>`;
  }
  function accountView() {
    return `<section class="sheet"><h2>${esc(state.me.name)}</h2><p>${roles[state.me.role]} / ${esc(state.me.login)} / 활성 계정</p><div class="actions">${button('password','비밀번호 변경')}</div><h3 class="spacer">로그인 연결</h3>${state.sessions.map(s => `<p class="hint">로그인 ${esc(s.created_at)}<br>만료 ${esc(new Date(s.expires).toISOString())}</p>`).join('')}<p class="hint">각 브라우저의 로그인은 따로 발급됩니다. 비활성화하면 연결이 해제됩니다.</p></section><section class="sheet"><h2>연결 상태</h2><p>학원 원본: 연결 대기<br>외부 학습 서비스: 성적·진도 미연동<br>보호자 알림: 비활성</p><p class="hint">${state.mode === 'synthetic-local' ? '현재 화면의 모든 학생·강사·보호자는 가상 자료입니다.' : '블렌디드 전용 계정과 저장소를 사용합니다. 학원 원본 연동은 대기 중입니다.'}</p></section>`;
  }
  function editorValue() { const form=$('#editor form'); return form ? JSON.stringify([...new FormData(form)]) : ''; }
  function editorDirty() { return dialog.open && editorValue() !== editorBaseline; }
  function openEditor(title,content,form = '',record = null) {
    editing = record;
    const close = button('close','닫기');
    $('#dialog-content').innerHTML = `<h2 id="dialog-title">${title}</h2>${form ? `<form data-form="${form}"><div class="editor-fields">${content}</div><div class="editor-actions"><div class="error-box" role="alert"></div><button type="submit">${form === 'publish' ? '공개본 발행' : form === 'withdraw' ? '리포트 철회' : '저장'}</button>${close}</div></form>` : `<div class="editor-fields">${content}</div><div class="editor-actions">${close}</div>`}`;
    editorBaseline = editorValue();
    dialog.showModal();
  }
  function closeEditor(force = false) {
    if(!force && editorDirty()) { if(!discardDialog.open) discardDialog.showModal(); return; }
    discardDialog.close(); dialog.close(); $('#dialog-content').innerHTML = ''; editing = null; editorBaseline = '';
  }
  function studentSubjectFields(record) {
    const subjects = state.me.role === 'teacher' ? [...new Set(state.assignments.filter(a => a.student_id === selected && a.active && a.starts <= state.today && a.ends >= state.today).map(a => a.subject))] : ['수학','영어','국어','사회','과학','기타'];
    return `<div class="form-grid">${input('studentLabel','학생',name(record?.student_id || selected),'text','disabled')}<label>과목<select name="subject" ${record ? 'disabled' : ''}>${options(subjects.map(s => [s,s]),record?.subject || subjects[0])}</select></label></div>`;
  }
  function summaryHTML(s) { return `<div class="summary"><span><strong>${s.total}</strong>배정</span><span><strong>${s.selfDone}</strong>학생 완료</span><span><strong>${s.checked}</strong>강사 확인</span></div><p class="hint">${esc(s.source)} / ${esc(s.periodStart)} ~ ${esc(s.periodEnd)}<br>갱신 ${esc(s.asOf)} / 외부 성적 ${esc(s.external)}${!s.hasRecords ? '<br>기록 없음 · 미수행이나 0점으로 해석하지 않습니다.' : ''}</p>`; }
  function publicHTML(data) { return `<dl class="report-body">${Object.entries(labels).filter(([key]) => data[key]).map(([key,label]) => `<dt>${label}</dt><dd>${esc(data[key])}</dd>`).join('')}</dl>`; }
  async function consultEditor(c) {
    const data = c?.public || {}, internal = c ? (await api('consult_get',{id:c.id})).internalNote : '';
    openEditor(c ? '상담 기록' : '상담 준비',`<fieldset><legend>상담 기본 정보</legend>${studentSubjectFields(c)}<div class="form-grid">${input('heldAt','상담 일시',c ? c.held_at.slice(0,16) : day+'T16:00','datetime-local','required')}${input('nextCheck','다음 확인일',data.nextCheck || '','date')}${input('periodStart','집계 시작일',c?.period_start || day,'date','required')}${input('periodEnd','집계 종료일',c?.period_end || day,'date','required')}</div>${button('summary','학습 사실 불러오기')}<div id="summary-preview"></div></fieldset><fieldset class="private"><legend>내부 기록 · 담당자 전용</legend>${area('internalNote','내부 메모 · 강사와 운영 담당만 열람',internal)}<p class="hint">아래 공개 내용과 분리 저장됩니다. 공개본에 자동 복사되지 않습니다.</p></fieldset><fieldset class="public"><legend>학생·보호자 공개 내용</legend>${area('studentVoice',labels.studentVoice,data.studentVoice)}${area('facts',labels.facts,data.facts,true)}${area('strengths',labels.strengths,data.strengths)}${area('guidance',labels.guidance,data.guidance,true)}${area('home',labels.home,data.home)}${input('nextGoal',labels.nextGoal,data.nextGoal || '','text','required maxlength="200" '+(c?.status === 'complete' ? 'readonly' : ''))}${input('due',labels.due,data.due || day,'date','required '+(c?.status === 'complete' ? 'readonly' : ''))}</fieldset><p class="hint">저장은 초안만 갱신합니다. 완료·검토 요청·발행은 각각 진행해 주세요.</p>`,'consult',c);
    $('textarea[name=internalNote]').maxLength = 4000;
  }
  async function act(action,id) {
    if(action==='period-report') {
      const r=(await api('planner_reports')).reports.find(r=>r.id===id);if(!r)throw new Error('현재 열람할 수 있는 발행본이 아닙니다.');
      const s=r.snapshot;
      return openEditor('공개 학습 리포트',`<h2>${esc(s.student.name)} · ${esc(r.title)}</h2><p>${esc(s.periodStart)} ~ ${esc(s.periodEnd)}</p><p>배정 ${esc(s.summary.total)} · 학생 완료 ${esc(s.summary.done)} · 순공시간 ${Math.round((s.summary.studySecs || 0)/60)}분</p><dl class="report-body"><dt>학생 회고</dt><dd>${esc(s.reflection)}</dd><dt>공개 지도 의견</dt><dd>${esc(s.directorNote)}</dd><dt>다음 집중 목표</dt><dd>${esc(s.nextFocus)}</dd></dl>`);
    }
    if (action === 'close') return closeEditor();
    if (action === 'keep-editing') return discardDialog.close();
    if (action === 'discard-editing') return closeEditor(true);
    if (action === 'refresh') { await refresh(); notice('최신 내용을 확인했습니다.'); return; }
    if (action === 'logout') { await api('logout'); state=null; selected=''; closeEditor(true); notice(); loginView(); return; }
    if (action === 'password') return openEditor('비밀번호 변경',`${input('currentPassword','현재 비밀번호','','password','required autocomplete="current-password"')}${input('password','새 비밀번호','','password','required minlength="12" maxlength="128" autocomplete="new-password"')}`,'password');
    if (action === 'new-student') return openEditor('학생 계정 추가',`${input('name','학생 표시 이름','','text','required maxlength="80"')}${input('login','학생 아이디','','text','required pattern="[a-z0-9][a-z0-9._-]{2,59}"')}${input('password','학생 비밀번호','','password','required minlength="12" maxlength="128" autocomplete="new-password"')}<p class="hint">학원 원본에서 가져오지 않고 새 플래너 계정을 만듭니다.</p>`,'student');
    if (action === 'new-learning') return openEditor('학습 배정',`${studentSubjectFields()}${input('title','교재·범위·해야 할 일','','text','required maxlength="200"')}${input('due','학습 날짜',day,'date','required')}<label>온라인 학습 바로가기<select name="linkKey">${options([['','오프라인 / 링크 없음'],['metamath_student','메타수학 학생홈'],['leaders_eye','리더스아이'],['nelt_student','넬트 학생 응시']],'')}</select></label><p class="hint">바로가기 클릭은 외부 서비스의 성적·진도 확인이 아닙니다.</p>`,'learning');
    if (['perform','check'].includes(action)) {
      const l = state.learning.find(r => r.id === id);
      return openEditor(action === 'perform' ? '완료·질문 남기기' : '학습 확인',`<p>${esc(l.title)}</p>${action === 'perform' ? `<label class="check-label"><input name="done" type="checkbox" ${l.self_done ? 'checked' : ''}>학습을 마쳤어요</label>${area('question','질문·도움 요청',l.question)}<p class="hint">학생의 완료 표시입니다. 강사 확인 상태는 별도로 기록합니다.</p>` : area('feedback','확인한 내용과 피드백',l.feedback,true)}`,action,l);
    }
    if (action === 'new-consult') return consultEditor();
    if (action === 'edit-consult') return consultEditor(state.consultations.find(c => c.id === id));
    if (action === 'summary') {
      const f = new FormData($('#editor form'));
      const result = await api('summary',{studentId:editing?.student_id || selected,subject:editing?.subject || f.get('subject'),start:f.get('periodStart'),end:f.get('periodEnd')});
      $('#summary-preview').innerHTML = summaryHTML(result.summary); return;
    }
    if (action === 'new-teacher' || action === 'new-admin') return openEditor(action==='new-admin'?'관리자 추가':'강사 추가',`${input('name','표시 이름','','text','required maxlength="80"')}${input('login','개별 로그인 아이디','','text','required pattern="[a-z0-9][a-z0-9._-]{2,59}" autocomplete="off"')}${input('password','개별 로그인 비밀번호','','password','required minlength="12" maxlength="128" autocomplete="new-password"')}<label>역할<select name="role">${options([['teacher','강사'],...(state.me.role === 'owner' ? [['admin','관리자']] : [])],action==='new-admin'?'admin':'teacher')}</select></label><p class="hint">등록 후 각자 개별 계정으로 로그인합니다. 사용자 초대 메시지는 발송하지 않습니다.</p>`,'teacher');
    if (action === 'new-assignment') return openEditor('담당 학생 배정',`<label>강사<select name="teacherId">${options(state.teachers.filter(t=>t.active && t.role === 'teacher').map(t=>[t.id,t.name]))}</select></label><label>학생<select name="studentId">${options(state.students.map(s=>[s.id,s.name]),selected)}</select></label>${input('subject','담당 과목','수학','text','required maxlength="40"')}<div class="form-grid">${input('starts','적용 시작일',state.today,'date','required')}${input('ends','적용 종료일',state.today.slice(0,4)+'-12-31','date','required')}</div><p class="hint">대체 강사도 해당 과목과 실제 담당 기간을 지정합니다.</p>`,'assignment');
    if (action === 'preview' || action === 'publish') {
      const c = state.consultations.find(c => c.id === id);
      const s = await api('summary',{studentId:c.student_id,subject:c.subject,start:c.period_start,end:c.period_end});
      const preview = `<div class="report-sheet"><h2>${esc(name(c.student_id))} 상담 리포트</h2><p>${esc(c.subject)} / ${esc(c.held_at.slice(0,10))}</p>${summaryHTML(s.summary)}${publicHTML(c.public)}</div>`;
      return openEditor(action === 'publish' ? '발행 전 공개본 확인' : '공개 내용 미리보기',preview+(action === 'publish' ? `${input('reason','발행·수정 사유','','text','maxlength="500" '+(state.reports.some(r => r.consultation_id === id) ? 'required' : ''))}<p class="hint">발행은 알림 발송과 다릅니다. 현재 내용이 보존됩니다.</p>` : ''),action === 'publish' ? 'publish' : '',c);
    }
    if (action === 'report') {
      const r = state.reports.find(r=>r.id===id);
      const fresh = await api('report_get',{id:r.consultation_id});
      const report = fresh.reports.find(x=>x.id===id);
      if (!report?.snapshot) throw new Error('현재 열람할 수 없는 리포트입니다. 최신 내용을 확인해 주세요.');
      const s = report.snapshot;
      return openEditor('발행된 공개본',`<div class="report-sheet"><p>${pill('v'+report.version,'green')}</p><h2>${esc(s.student.name)} 상담 리포트</h2><p>${esc(s.subject)} / ${esc(s.heldAt.slice(0,10))}</p>${summaryHTML(s.summary)}${publicHTML(s.public)}</div>`);
    }
    if (action === 'withdraw') return openEditor('리포트 철회',`<p>학생·보호자의 열람을 막고 기존 발행 이력은 보존합니다.</p>${input('reason','철회 사유','','text','required maxlength="500"')}`,'withdraw',state.consultations.find(c=>c.id===id));
    if (['complete','review','teacher-status','unassign','consent'].includes(action)) {
      let mutation, payload;
      if (action === 'teacher-status') { const t=state.teachers.find(t=>t.id===id); mutation='teacher_status'; payload={id,revision:t.revision,active:!t.active}; }
      else if (action === 'unassign') { const a=state.assignments.find(a=>a.id===id); mutation='unassign'; payload={id,revision:a.revision}; }
      else if (action === 'consent') { const [guardianId,studentId]=id.split('|'),g=state.guardians.find(g=>g.user_id===guardianId && g.student_id===studentId); mutation='guardian_consent'; payload={guardianId,studentId,revision:g.revision,consent:!g.consent}; }
      else { const c=state.consultations.find(c=>c.id===id); mutation=action==='complete'?'consult_complete':'review'; payload={id,revision:c.revision}; }
      await api(mutation,payload,crypto.randomUUID()); await refresh(); notice(action==='complete'?'상담을 완료하고 날짜가 있는 약속을 연결했습니다.':'변경 내용을 저장했습니다.');
    }
  }
  document.addEventListener('click',async e => {
    const navButton=e.target.closest('[data-tab]');
    if (navButton) {tab=navButton.dataset.tab;history.replaceState(null,'','#/'+tab); render(); return;}
    const b=e.target.closest('[data-action]'); if (!b || busy) return;
    busy=true; b.disabled=true;
    try { await act(b.dataset.action,b.dataset.id); }
    catch(error) { const box=$('#editor .error-box'); if(box) box.textContent=error.message; else notice(error.message,true); }
    finally {busy=false;b.disabled=false;}
  });
  document.addEventListener('change',e => {
    if (e.target.id==='student-filter') {selected=e.target.value; render();}
    if (e.target.id==='day-filter') {day=e.target.value || state.today;render();}
  });
  document.addEventListener('submit',async e => {
    const form=e.target.closest('[data-form]'); if(!form) return; e.preventDefault(); if(busy) return;
    const f=Object.fromEntries(new FormData(form)),kind=form.dataset.form;
    let action,payload;
    if(kind==='login') {action='login';payload=f;}
    if(kind==='learning') {action='learning_create';payload={...f,studentId:selected};}
    if(kind==='perform') {action='perform';payload={id:editing.id,revision:editing.revision,done:!!f.done,question:f.question};}
    if(kind==='check') {action='check';payload={id:editing.id,revision:editing.revision,feedback:f.feedback};}
    if(kind==='teacher') {action='teacher_create';payload=f;}
    if(kind==='student') {action='student_create';payload=f;}
    if(kind==='password') {action='password_change';payload=f;}
    if(kind==='assignment') {action='assign';payload=f;}
    if(kind==='consult') {action='consult_save';payload={id:editing?.id,revision:editing?.revision,studentId:selected,subject:editing?.subject || f.subject,heldAt:f.heldAt+':00+09:00',periodStart:f.periodStart,periodEnd:f.periodEnd,internalNote:f.internalNote,public:Object.fromEntries(Object.keys(labels).map(key=>[key,f[key] || '']))};}
    if(kind==='publish' || kind==='withdraw') {action=kind;payload={id:editing.id,revision:editing.revision,reason:f.reason};}
    const signature=JSON.stringify({action,payload}),previous=retries.get(form);
    const requestId=previous?.signature===signature?previous.requestId:crypto.randomUUID(); retries.set(form,{signature,requestId});
    busy=true;const submit=form.querySelector('[type=submit]');submit.disabled=true;form.querySelector('.error-box').textContent='';
    try {await api(action,payload,requestId);if(kind==='password'){closeEditor(true);state=null;loginView();notice('비밀번호가 변경되었습니다. 다시 로그인해 주세요.');return;}await refresh();closeEditor(true);notice(kind==='login'?'로그인했습니다.':kind==='publish'?'공개본을 발행했습니다. 알림은 발송하지 않았습니다.':'저장했습니다.');}
    catch(error) {
      const box=form.querySelector('.error-box'); if(box) {box.textContent=error.message; if(error.code==='CONFLICT') box.innerHTML+=`<div class="actions">${button('refresh','입력 유지하고 최신 목록 확인')}</div>`;}
      if(error.code==='SCOPE') {closeEditor(true);await refresh().catch(()=>{});notice(error.message,true);}
    } finally {busy=false;submit.disabled=false;}
  });
  dialog.addEventListener('cancel',e=>{e.preventDefault();closeEditor();});
  // shortcut: 초안은 열린 화면의 메모리에만 유지, 오프라인 편집 요구가 생기면 계정별 암호화 보관을 검토한다.
  window.addEventListener('beforeunload',e=>{if(editorDirty()){e.preventDefault();e.returnValue='';}});
  setInterval(()=>{if(state && !busy && !dialog.open) refresh().catch(error=>notice(error.message,true));},30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden && state && !busy && !dialog.open) refresh().catch(error=>notice(error.message,true));});
  api('runtime').then(result=>{runtime=result;$('#environment').innerHTML=runtime.mode==='synthetic-local'?'로컬 체험 <span>가상 자료만 사용합니다. 학원 연결 대기 · 실제 발송 비활성</span>':'블렌디드 플래너 <span>학원 연결 대기 · 실제 메시지 발송 비활성</span>';return refresh();}).catch(error=>{loginView();if(error.code!=='AUTH')notice(error.message,true);});
})();
