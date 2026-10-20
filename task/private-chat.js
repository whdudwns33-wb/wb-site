'use strict';

var WBPrivateChat = (function () {
  function create(options) {
    var epoch=0, viewEpoch=0, messageEpoch=0, token='', identity='', probed='', sessionAuth=null;
    var lastActivity=0, lastTouch=0, lastPoll=0, polling=false;
    var state={available:false,opened:false,locked:true,busy:false,error:'',actor:null,expiresAt:0,idleMs:600000,
      directory:[],rooms:[],unreadCount:0,room:null,messages:[],before:null,draft:'',pending:null};
    function key() { return JSON.stringify(options.auth()); }
    function changed() { if(options.changed) options.changed(state); }
    function lock(reason, keepOpen) {
      var oldToken=token, oldAuth=sessionAuth;
      epoch++; viewEpoch++; messageEpoch++; token=''; sessionAuth=null;
      Object.assign(state,{opened:!!keepOpen,locked:true,busy:false,error:reason||'',actor:null,expiresAt:0,
        directory:[],rooms:[],unreadCount:0,room:null,messages:[],before:null,draft:'',pending:null});
      changed();
      if(oldToken && oldAuth) Promise.resolve(options.post('/private-chat',{
        app:'task',auth:oldAuth,action:'logout',privateSession:oldToken
      })).catch(function(){ /* 로컬 잠금은 서버 응답과 관계없이 즉시 끝낸다. */ });
    }
    function current() {
      var next=key(), auth=options.auth();
      if(identity!==next) { identity=next; probed=''; state.available=false; lock('',false); }
      if(!auth || auth.mode!=='person' || !options.allowed()) {
        if(!state.locked || state.opened) lock('',false);
        probed=''; state.available=false; return false;
      }
      return true;
    }
    async function call(action, extra, view) {
      if(!current()) return null;
      var ticket=epoch, identityKey=identity;
      try {
        var result=await options.post('/private-chat',Object.assign({app:'task',auth:options.auth(),action:action,privateSession:token},extra||{}));
        if(ticket!==epoch || identityKey!==key()) return null;
        if(view!==undefined && view!==viewEpoch) return null;
        if(!result || result.ok!==true) throw new Error('PRIVATE_CHAT_RESPONSE_INVALID');
        return result;
      } catch(error) {
        if(ticket!==epoch || identityKey!==key()) return null;
        // 방 한정 실패는 새 방에 적용하지 않되, 현재 개인 세션의 만료는 계속 잠근다.
        if(view!==undefined && view!==viewEpoch && error.status!==401 &&
          !['STAFF_WORK_LOGIN_REQUIRED','PRIVATE_CHAT_DISABLED','PRIVATE_CHAT_NOT_CONFIGURED'].includes(error.code)) return null;
        if(token && (error.status===401 || ['STAFF_WORK_LOGIN_REQUIRED','PRIVATE_CHAT_DISABLED','PRIVATE_CHAT_NOT_CONFIGURED','PRIVATE_CHAT_NOT_FOUND'].includes(error.code))) lock('본인 확인 시간이 끝났습니다. 다시 확인해 주세요.',true);
        else { state.error='개인대화 요청을 처리하지 못했습니다. 다시 확인해 주세요.'; changed(); }
        return null;
      }
    }
    async function refreshAccess() {
      if(!current() || polling || state.available || probed===identity) return;
      probed=identity; polling=true;
      try { var result=await call('status'); if(result) state.available=result.enabled===true; }
      finally { polling=false; changed(); }
    }
    async function refreshRooms() {
      var result=await call('rooms');
      if(result) { state.rooms=result.rooms; state.unreadCount=result.unreadCount; changed(); }
    }
    async function messages(before) {
      if(!state.room || state.locked) return;
      var roomId=state.room.id, view=viewEpoch, request=++messageEpoch;
      var result=await call('messages',{roomId:roomId,before:before},view);
      if(!result || view!==viewEpoch || request!==messageEpoch || !state.room || state.room.id!==roomId) return;
      var combined=new Map(state.messages.map(function(row){return [row.sequence,row];}));
      result.messages.forEach(function(row){combined.set(row.sequence,row);});
      state.messages=Array.from(combined.values()).sort(function(a,b){return a.sequence-b.sequence;});
      if(before || state.before===null && state.messages.length<=50) state.before=result.before;
      state.room=result.room; changed();
    }
    async function confirm(pin) {
      if(state.busy || !current()) return;
      var ticket=epoch;
      state.busy=true; state.error=''; changed();
      var result=await call('confirm',{pin:pin}); pin='';
      if(ticket!==epoch) return;
      state.busy=false;
      if(!result) {changed(); return;}
      if(!result.privateSession || Number(result.expiresAt)<=Date.now()) {lock('본인 확인 결과를 다시 확인해 주세요.',true); return;}
      token=result.privateSession; sessionAuth=options.auth(); state.locked=false;
      state.actor=result.actor; state.expiresAt=result.expiresAt; state.idleMs=result.idleMs;
      lastActivity=Date.now(); lastTouch=lastActivity;
      var directory=await call('directory'); if(!directory) return;
      state.directory=directory.directory; await refreshRooms();
    }
    async function open(recipientId) {
      if(state.locked || !current()) return;
      var view=++viewEpoch;
      state.room=null; state.messages=[]; state.before=null; state.draft=''; state.pending=null; state.busy=false; state.error=''; changed();
      var result=await call('open',{recipientId:recipientId},view);
      if(!result || view!==viewEpoch) return;
      state.room=result.room; changed(); await messages(); await refreshRooms();
    }
    async function send() {
      if(state.locked || state.busy || !state.room || !state.draft.trim()) return;
      var roomId=state.room.id, view=viewEpoch, text=state.draft;
      if(!state.pending || state.pending.roomId!==roomId || state.pending.body!==text)
        state.pending={roomId:roomId,body:text,requestId:'pcm_'+options.requestId()};
      state.busy=true; state.error=''; changed();
      var result=await call('send',state.pending,view);
      if(view!==viewEpoch) return;
      state.busy=false;
      if(result) {if(state.draft===text) state.draft=''; state.pending=null;}
      changed(); if(result) {await messages(); await refreshRooms();}
    }
    async function read(sequences) {
      if(state.locked || !state.opened || !state.room || !options.visible() ||
        !Array.isArray(sequences) || !sequences.length || !sequences.every(function(seq){return state.messages.some(function(row){return row.sequence===seq;});})) return false;
      var view=viewEpoch, result=await call('read',{roomId:state.room.id,sequences:sequences},view);
      if(result && view===viewEpoch) {await refreshRooms(); return true;}
      return false;
    }
    async function activity(event) {
      if(!event || event.isTrusted!==true || !['pointerdown','keydown','wheel','touchstart','touchmove'].includes(event.type) ||
        !current() || !options.visible() || state.locked || !state.opened) return;
      if(Date.now()-lastActivity>=state.idleMs || Date.now()>=state.expiresAt) {lock('본인 확인 시간이 끝났습니다.',true); return;}
      lastActivity=Date.now();
      if(lastActivity-lastTouch>=30000) {lastTouch=lastActivity; await call('touch');}
    }
    async function tick() {
      if(!current() || state.locked) return;
      if(!options.visible()) {lock('화면을 벗어나 개인대화를 잠갔습니다.',false); return;}
      if(Date.now()-lastActivity>=state.idleMs || Date.now()>=state.expiresAt) {lock('본인 확인 시간이 끝났습니다.',true); return;}
      if(!polling && state.opened && options.visible() && Date.now()-lastPoll>=5000) {
        polling=true; lastPoll=Date.now();
        try {await refreshRooms(); await messages();} finally {polling=false;}
      }
    }
    return {state:state,refreshAccess:refreshAccess,confirm:confirm,open:open,send:send,messages:messages,read:read,
      activity:activity,tick:tick,lock:lock,show:function(){if(state.available && current()){state.opened=true; state.error=''; changed();}},
      close:function(){lock('',false);}};
  }
  var active=null;
  function init(options) {
    var root=document.createElement('div'), previousFocus=null, marked=new Set(), marking=false, lastRoom='', signature='', inertBefore=new Map();
    root.className='private-chat-shell'; root.hidden=true; document.body.appendChild(root);
    function background(open) {
      if(open && !inertBefore.size) Array.from(document.body.children).forEach(function(node){
        if(node!==root && !['SCRIPT','STYLE'].includes(node.tagName)){inertBefore.set(node,node.inert); node.inert=true;}
      });
      if(!open) {inertBefore.forEach(function(value,node){node.inert=value;}); inertBefore.clear();}
    }
    function render(state) {
      options.entry.hidden=!state.available;
      options.entry.style.display=state.available?'':'none';
      options.entry.textContent='개인대화'+(!state.locked && state.unreadCount?' ('+state.unreadCount+')':'');
      // 변화 없는 폴링으로 입력 포커스와 현재 화면의 버튼을 교체하지 않는다.
      var nextSignature=JSON.stringify(state);
      if(signature===nextSignature)return;
      signature=nextSignature;
      var prior=root.querySelector('.private-chat-log');
      var bottom=!prior || prior.scrollHeight-prior.scrollTop-prior.clientHeight<50, scroll=prior?prior.scrollTop:0;
      var focused=root.contains(document.activeElement)?document.activeElement:null;
      var focusedId=focused&&focused.id, start=focused&&focused.selectionStart, wasHidden=root.hidden;
      root.hidden=!state.opened; background(state.opened);
      if(!state.opened){root.innerHTML='';marked.clear();lastRoom='';if(!wasHidden && previousFocus && document.contains(previousFocus)) previousFocus.focus();return;}
      var esc=options.esc;
      var controls=state.locked
        ? '<form data-private-confirm><label for="privateChatPin">내 개인 비밀번호 4자리</label><input class="in" id="privateChatPin" type="password" inputmode="numeric" autocomplete="off" maxlength="4" pattern="[0-9]{4}" required><button class="btn btn-primary"'+(state.busy?' disabled':'')+'>본인 확인</button><p class="muted">출퇴근 기록은 변경하지 않습니다.</p></form>'
        : '<p>'+esc(state.actor.name)+' · 개인 본인 확인됨</p><label for="privateChatPeer">대화 상대</label><select class="in" id="privateChatPeer"><option value="">직원 선택</option>'+state.directory.map(function(person){return '<option value="'+esc(person.id)+'"'+(state.room&&state.room.peer.id===person.id?' selected':'')+'>'+esc(person.name)+'</option>';}).join('')+'</select><nav class="private-chat-rooms" aria-label="개인대화 목록">'+state.rooms.map(function(room){return '<button class="btn btn-sm" type="button" data-private-peer="'+esc(room.peer.id)+'">'+esc(room.peer.name)+(room.unreadCount?' · 미확인 '+room.unreadCount:'')+'</button>';}).join('')+'</nav>';
      var log=state.room?'<h3>'+esc(state.room.peer.name)+'님과의 개인대화</h3>'+(state.before?'<button class="btn btn-sm" type="button" data-private-more>이전 대화</button>':'')+
        '<div class="private-chat-log" role="log" tabindex="0" aria-label="개인대화 메시지">'+state.messages.map(function(item){var mine=item.senderId===state.actor.id;return '<article data-private-sequence="'+item.sequence+'"'+(mine?'':' data-private-incoming')+' class="private-chat-message'+(mine?' is-mine':'')+'"><b>'+esc(mine?state.actor.name:state.room.peer.name)+'</b><div>'+options.bodyHtml(item.body)+'</div><small>'+(mine?(item.readByPeer?'읽음':'서버 저장됨'):'받은 메시지')+'</small></article>';}).join('')+'</div><form data-private-send><label for="privateChatDraft" class="sr-only">개인 메시지</label><textarea class="in" id="privateChatDraft" maxlength="1000" rows="3" placeholder="개인 메시지">'+esc(state.draft)+'</textarea><button class="btn btn-primary"'+(state.busy?' disabled':'')+'>개인 메시지 보내기</button></form>':'';
      root.innerHTML='<section class="private-chat-panel" role="dialog" aria-modal="true" aria-labelledby="privateChatTitle" tabindex="-1"><header class="between"><h2 id="privateChatTitle">개인대화</h2><button type="button" class="btn" data-private-close>잠그고 닫기</button></header><div class="private-chat-controls">'+controls+'</div><p role="status">'+esc(state.error)+'</p>'+log+'</section>';
      var list=root.querySelector('.private-chat-log'), roomChanged=lastRoom!==(state.room&&state.room.id);
      if(list) list.scrollTop=bottom||roomChanged?list.scrollHeight:scroll;
      if(roomChanged) marked.clear();
      lastRoom=state.room&&state.room.id;
      var replacement=focusedId&&root.querySelector('#'+focusedId);
      if(replacement){replacement.focus({preventScroll:true});if(typeof start==='number'&&replacement.setSelectionRange)replacement.setSelectionRange(start,start);}
      else if(wasHidden||focused||state.locked&&!focused)(root.querySelector('#privateChatPin')||root.querySelector('#privateChatPeer')||root.querySelector('[role="dialog"]')).focus();
      if(list) markVisible();
    }
    active=create(Object.assign({},options,{visible:function(){return document.visibilityState==='visible';},changed:render,requestId:function(){return crypto.randomUUID();}}));
    function markVisible() {
      var state=active.state, list=root.querySelector('.private-chat-log');
      if(marking || !state.opened || state.locked || !list || document.visibilityState!=='visible') return;
      var bounds=list.getBoundingClientRect(), roomId=state.room&&state.room.id;
      var sequences=Array.from(list.querySelectorAll('[data-private-incoming]')).filter(function(node){
        var rect=node.getBoundingClientRect();
        return rect.bottom>bounds.top && rect.top<bounds.bottom;
      }).map(function(node){return Number(node.dataset.privateSequence);}).filter(function(seq){return !marked.has(seq);}).slice(0,50);
      if(!sequences.length) return;
      marking=true;
      active.read(sequences).then(function(ok){if(ok && active.state.room && active.state.room.id===roomId) sequences.forEach(function(seq){marked.add(seq);});})
        .finally(function(){marking=false;if(active.state.room&&active.state.room.id!==roomId)markVisible();});
    }
    options.entry.addEventListener('click',function(){previousFocus=options.returnFocus||options.entry;if(options.beforeOpen)options.beforeOpen();active.show();});
    root.addEventListener('submit',function(event){event.preventDefault();if(event.target.matches('[data-private-confirm]')){var input=root.querySelector('#privateChatPin'),value=input.value;input.value='';active.confirm(value);value='';}else if(event.target.matches('[data-private-send]'))active.send();});
    root.addEventListener('input',function(event){if(event.target.id==='privateChatDraft')active.state.draft=event.target.value;});
    root.addEventListener('change',function(event){if(event.target.id==='privateChatPeer'&&event.target.value)active.open(event.target.value);});
    root.addEventListener('click',function(event){var button=event.target.closest('button');if(!button)return;if(button.hasAttribute('data-private-close'))active.close();if(button.dataset.privatePeer)active.open(button.dataset.privatePeer);if(button.hasAttribute('data-private-more'))active.messages(active.state.before);});
    root.addEventListener('scroll',markVisible,true);
    ['pointerdown','keydown','wheel','touchstart','touchmove'].forEach(function(name){root.addEventListener(name,function(event){active.activity(event);},{passive:true});});
    root.addEventListener('keydown',function(event){
      if(event.key==='Escape'){event.preventDefault();active.close();return;}
      if(event.key!=='Tab')return;
      var nodes=Array.from(root.querySelectorAll('a[href],button:not(:disabled),input,select,textarea,[tabindex="0"]')).filter(function(node){return node.offsetParent!==null;});
      var first=nodes[0],last=nodes[nodes.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    });
    setInterval(function(){active.tick();},1000);
    document.addEventListener('visibilitychange',function(){active.tick();});
    window.addEventListener('pagehide',function(){active.lock('',false);});
    active.refreshAccess(); return active;
  }
  return {create:create,init:init,lock:function(){if(active)active.lock('',false);},refreshAccess:function(){if(active)active.refreshAccess();}};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=WBPrivateChat;
