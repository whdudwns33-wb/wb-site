'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/request-sw.js','utf8');
const ui = fs.readFileSync(__dirname + '/task-push-client.js','utf8');
const html = fs.readFileSync(__dirname + '/index.html','utf8');
test('push always displays generic notification without payload or tokens and wakes foreground refresh',async()=>{
  const handlers={}, notifications=[], messages=[];
  const self={
    addEventListener:(type,f)=>handlers[type]=f,
    registration:{scope:'https://example.test/task/',showNotification:async(title,options)=>notifications.push({title,options})},
    clients:{matchAll:async()=>[
      {url:'https://example.test/task/',postMessage:m=>messages.push(m)},
      {url:'https://example.test/other/',postMessage:()=>assert.fail('outside scope')}
    ]}
  };
  vm.runInNewContext(source,{self,Promise});
  let work;
  handlers.push({data:{text:()=>assert.fail('no source message payload')},waitUntil:p=>work=p});
  await work;
  assert.equal(notifications.length,1);
  assert.equal(notifications[0].options.tag,'wb-live-request');
  assert.equal(messages.length,1);
  assert.doesNotMatch(source,/localStorage|caches\.|fetch\(|auth\.token/);
});
test('notification click focuses task window without acknowledging request or navigating foreign URL',async()=>{
  const handlers={};let focused=0,refreshed=0,closed=0;
  const self={
    addEventListener:(type,f)=>handlers[type]=f,
    registration:{scope:'https://example.test/task/'},
    clients:{matchAll:async()=>[{url:'https://example.test/task/?u=example',
      focus:async()=>focused++,postMessage:()=>refreshed++}],openWindow:()=>assert.fail('already open')}
  };
  vm.runInNewContext(source,{self,Promise});
  let work;
  handlers.notificationclick({notification:{data:{url:'https://evil.test/'},close:()=>closed++},waitUntil:p=>work=p});
  await work;
  assert.equal(focused,1);assert.equal(refreshed,1);assert.equal(closed,1);
});
test('settings stay separate from lesson rendering, require user permission and do not poll',()=>{
  assert.match(html,/id="taskPushPanel" hidden/);
  assert.match(html,/요청 알림 켜기/);
  assert.match(html,/shouldGateStaffWork\(\) \? null : sync.auth\(\)/);
  assert.match(ui,/Notification.requestPermission\(\)/);
  assert.match(ui,/userVisibleOnly:true/);
  assert.match(ui,/await post\('unsubscribe',sub.endpoint\); await sub.unsubscribe\(\)/);
  assert.doesNotMatch(ui,/setInterval|localStorage|innerHTML/);
});
test('client enable and disable controls save subscription without posting content',async()=>{
  const handlers={}, calls=[];
  const buttons=['on','off'].map(value=>({dataset:{taskPush:value},addEventListener:(_,f)=>handlers[value]=f}));
  const nodes={taskPushPanel:{hidden:true},taskPushStatus:{textContent:''}};
  let sub=null,permission='default';
  const reg={pushManager:{getSubscription:async()=>sub,subscribe:async()=>{
    sub={endpoint:'https://fcm.googleapis.com/wp/test',unsubscribe:async()=>{sub=null;}};
    return sub;
  }}};
  const window={isSecureContext:true,PushManager:function(){},Notification:{get permission(){return permission;},requestPermission:async()=>{permission='granted';return permission;}}};
  const navigator={serviceWorker:{register:async()=>reg,ready:Promise.resolve(reg),addEventListener(){}}};
  const context={window,navigator,Notification:window.Notification,document:{
    getElementById:id=>nodes[id],querySelectorAll:()=>buttons
  },Uint8Array,atob:s=>Buffer.from(s,'base64').toString('binary')};
  vm.runInNewContext(ui,context);
  window.WBTaskPush.init({auth:()=>({mode:'person',id:'synthetic',token:'test'}),
    post:async body=>{calls.push(body);return body.action==='key'?{available:true,publicKey:'AQ'}:{enabled:true};}});
  await new Promise(resolve=>setImmediate(resolve));
  handlers.on();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(x=>x.action),['key','subscribe']);
  assert.match(nodes.taskPushStatus.textContent,/켰습니다/);
  handlers.off();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.at(-1).action,'unsubscribe');
  assert.equal(sub,null);
  assert.match(nodes.taskPushStatus.textContent,/껐습니다/);
});
