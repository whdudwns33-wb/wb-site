'use strict';

var WBSelfIdentity = (function () {
  function create(options) {
    var serial=0, identity='', opened=false, displayedUntil=0;
    var state={identity:null,busy:false,error:''};
    function changed(){ if(options.changed) options.changed(state); }
    function clear(){ serial++; opened=false; identity=''; displayedUntil=0; state.identity=null; state.busy=false; state.error=''; changed(); }
    async function read(){
      var auth=options.auth(), key=JSON.stringify(auth), ticket=++serial;
      identity=key; state.identity=null; state.error=''; state.busy=true; changed();
      function isCurrent(){return ticket===serial && key===JSON.stringify(options.auth()) && opened && options.allowed();}
      try {
        if(!auth || !options.allowed()) throw new Error('IDENTITY_LOGIN_REQUIRED');
        var result=await options.post('/self-identity',{app:'task',auth:auth},isCurrent);
        if(!isCurrent()) return;
        var info=result && result.identity;
        if(!result || result.ok!==true || !info || !['person','shared_admin','inspection'].includes(info.status)) throw new Error('IDENTITY_RESPONSE_INVALID');
        var keys=info.status==='person'?['status','name','id','loginMethod','loginConfigured']:['status','loginMethod'];
        if(Object.keys(info).length!==keys.length || Object.keys(info).some(function(key){return keys.indexOf(key)<0;}) ||
          (info.status==='person' && (typeof info.name!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(info.id) || typeof info.loginConfigured!=='boolean' || !['personal_device','personal_device_work_login'].includes(info.loginMethod)))) throw new Error('IDENTITY_RESPONSE_INVALID');
        if(info.status==='person' && (auth.mode!=='person' || info.id!==auth.id) || info.status==='shared_admin' && auth.mode!=='admin' || info.status==='inspection' && auth.mode!=='manager_inspection') throw new Error('IDENTITY_RESPONSE_INVALID');
        state.identity=info; displayedUntil=Date.now()+60000;
      } catch(error) {
        if(ticket!==serial || key!==JSON.stringify(options.auth()) || !opened) return;
        state.identity=null; state.error='계정 정보를 확인할 수 없습니다. 개인 로그인 상태를 확인한 뒤 다시 시도해 주세요.';
      } finally {
        if(ticket===serial && opened){state.busy=false;changed();}
      }
    }
    function tick(){
      if(opened && (identity!==JSON.stringify(options.auth()) || !options.allowed())) clear();
      else if(opened && state.identity && Date.now()>=displayedUntil){state.identity=null;state.error='확인 시간이 지났습니다. 다시 확인해 주세요.';changed();}
    }
    return {state:state,read:read,clear:clear,tick:tick,open:function(){opened=true;return read();}};
  }
  var active;
  function init(options){
    var dialog=null, returnFocus=null;
    function render(state){
      if(!dialog)return;
      var info=state.identity, text=dialog.querySelector('[data-identity-info]');
      text.replaceChildren();
      if(info && info.status==='person'){
        [['이름',info.name],['고유 직원번호',info.id],['로그인 방식',info.loginMethod==='personal_device_work_login'?'개인 기기 연결 · 출근 로그인':'개인 기기 연결'],['본인 로그인 구성',info.loginConfigured?'구성됨':'미구성 또는 비활성']].forEach(function(row){
          var label=document.createElement('dt'),value=document.createElement('dd');label.textContent=row[0];value.textContent=row[1];text.append(label,value);
        });
      }else if(info){var note=document.createElement('p');note.textContent=info.status==='inspection'?'점검 모드입니다. 개인 신원 확인에 사용할 수 없습니다.':'공용 관리자 인증입니다. 연결된 개인 계정이 없습니다.';text.append(note);}
      dialog.querySelector('[role="status"]').textContent=state.busy?'서버에서 확인 중…':state.error;
      dialog.querySelector('[data-identity-retry]').disabled=state.busy;
    }
    function close(){var old=dialog;dialog=null;active.clear();if(old){old.close();old.remove();}if(returnFocus && document.contains(returnFocus))returnFocus.focus();returnFocus=null;}
    active=create(Object.assign({},options,{changed:render}));
    options.entry.addEventListener('click',function(){
      if(options.entry.closest('[inert]'))return;
      if(dialog){close();return;}
      returnFocus=document.activeElement;dialog=document.createElement('dialog');dialog.className='self-identity-dialog';dialog.setAttribute('aria-labelledby','selfIdentityTitle');
      dialog.innerHTML='<h2 id="selfIdentityTitle">본인 계정 확인(읽기 전용)</h2><p>현재 기기에 연결된 계정 정보입니다. PIN 검증이나 기기 앞 사용자의 본인 확인을 완료하는 화면이 아닙니다.</p><dl data-identity-info></dl><p role="status" aria-live="polite"></p><div class="row"><button type="button" class="btn" data-identity-retry>다시 확인</button><button type="button" class="btn" data-identity-close>닫기</button></div>';
      dialog.querySelector('[data-identity-close]').addEventListener('click',close);
      dialog.querySelector('[data-identity-retry]').addEventListener('click',function(){active.read();});
      dialog.addEventListener('cancel',function(event){event.preventDefault();close();});
      dialog.addEventListener('keydown',function(event){
        if(event.key!=='Tab')return;
        var buttons=Array.from(dialog.querySelectorAll('button:not(:disabled)')),first=buttons[0],last=buttons[buttons.length-1];
        if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
      });
      document.body.append(dialog);dialog.showModal();dialog.querySelector('[data-identity-close]').focus();active.open();
    });
    setInterval(function(){active.tick();if(dialog && !active.state.identity && !active.state.busy && !active.state.error)close();},250);
    window.addEventListener('pagehide',close);
    document.addEventListener('visibilitychange',function(){if(document.visibilityState!=='visible')close();});
    return active;
  }
  return {create:create,init:init,clear:function(){if(active)active.clear();}};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=WBSelfIdentity;
