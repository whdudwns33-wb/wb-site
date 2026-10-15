'use strict';
(function (root) {
  var api, owner = '', generation = 0, registration, busy = false;
  function supported() {
    return root.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in root && 'Notification' in root;
  }
  function message(text) { document.getElementById('taskPushStatus').textContent = text; }
  function identity() {
    var auth = api && api.auth();
    return auth && ['person','admin'].includes(auth.mode) ? JSON.stringify(auth) : '';
  }
  async function reg() {
    if (!registration) registration = await navigator.serviceWorker.register('./request-sw.js',{scope:'./',updateViaCache:'none'});
    return navigator.serviceWorker.ready;
  }
  function keyBytes(value) {
    var padded = value.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4-value.length%4)%4);
    return Uint8Array.from(atob(padded), function(c) { return c.charCodeAt(0); });
  }
  async function post(action, endpoint) {
    var auth=api.auth();
    if (!auth || identity() !== owner) throw new Error('로그인 상태가 바뀌었습니다. 다시 시도해 주세요.');
    return api.post({auth:auth,action:action,endpoint:endpoint});
  }
  async function refresh() {
    if (!api) return;
    var id = identity(), host = document.getElementById('taskPushPanel');
    host.hidden = !id;
    if (id === owner) return;
    owner = id;
    var ticket = ++generation;
    if (!id) return;
    if (!supported()) { message('이 브라우저는 기기 알림을 지원하지 않습니다. Chrome·Edge를 이용하거나 iPad는 홈 화면 앱에서 열어 주세요.'); return; }
    message('기기 알림 상태 확인 중…');
    try {
      var r = await reg(), sub = await r.pushManager.getSubscription();
      var state = sub ? await post('status',sub.endpoint) : null;
      if (ticket !== generation) return;
      message(Notification.permission === 'denied' ? '브라우저에서 알림이 차단되어 있습니다. 사이트 알림 설정에서 허용해 주세요.' :
        state && state.enabled ? '기기 알림 켜짐 · 화면 점등·소리는 기기 설정에 따릅니다.' : '요청 알림 켜기를 눌러 이 기기에 알림을 허용해 주세요.');
    } catch (e) { if (ticket === generation) message(e.message || '알림 상태를 확인하지 못했습니다.'); }
  }
  async function toggle(enable) {
    if (busy || !owner) return;
    if (!supported()) { message('이 브라우저는 기기 알림을 지원하지 않습니다.'); return; }
    busy = true;
    var buttons = document.querySelectorAll('[data-task-push]');
    buttons.forEach(function(b){ b.disabled=true; });
    var expected=owner;
    try {
      // 권한 요청은 사용자의 직접 클릭에서 시작한다.
      var permission = enable ? await Notification.requestPermission() : Notification.permission;
      if (enable && permission !== 'granted') throw new Error('알림 허용이 필요합니다. 브라우저 사이트 설정을 확인해 주세요.');
      var r=await reg(), sub=await r.pushManager.getSubscription();
      if (identity() !== expected) throw new Error('로그인 상태가 바뀌었습니다. 다시 시도해 주세요.');
      if (!enable) {
        if (sub) { await post('unsubscribe',sub.endpoint); await sub.unsubscribe(); }
        message('이 기기의 요청 알림을 껐습니다. 화면 안 팝업은 유지됩니다.');
      } else {
        var result=await post('key');
        if (!result.available) throw new Error('서버 알림 설정이 아직 완료되지 않았습니다.');
        if (!sub) sub=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(result.publicKey)});
        await post('subscribe',sub.endpoint);
        message('기기 알림을 켰습니다. 잠금화면 알림·소리는 기기 설정도 허용해 주세요.');
      }
    } catch(e) { message(e.message || '기기 알림 설정에 실패했습니다.'); }
    finally { busy=false; buttons.forEach(function(b){ b.disabled=false; }); }
  }
  root.WBTaskPush = {refresh:refresh, init:function(options) {
    api=options;
    document.querySelectorAll('[data-task-push]').forEach(function(b) {
      b.addEventListener('click',function(){ toggle(b.dataset.taskPush === 'on'); });
    });
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'WB_LIVE_REQUEST' && api.auth()) api.refreshRequests();
    });
    refresh();
  }};
})(window);
