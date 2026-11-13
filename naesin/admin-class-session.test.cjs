'use strict';
/* 관리 화면 원본을 실행해 반별 과제·타임박스·투사의 선택과 비동기 경계를 검사한다. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const COV=require('./coverage.js'),READY=require('./readiness.js'),GEN=require('./gen.js'),SAMPLE=require('./pack-sample.json');
let passed=0;
const t=async(name,fn)=>{await fn();passed++;console.log('  ✓ '+name);};
const response=body=>({ok:true,status:200,json:async()=>body});
const roster=[{code:'ST1',name:'학생 하나',cls:'가반'},{code:'ST2',name:'학생 둘',cls:'  가반 '},{code:'ST3',name:'학생 셋',cls:'<나반>'}];
const live=label=>({phase:{key:'words',label,startedAt:new Date().toISOString(),endsAt:new Date(Date.now()+600000).toISOString()},projector:{packId:SAMPLE.packId,index:0,revealed:false,items:[{ref:'w-e2k:w-001',prompt:'자체 창작 질문',choices:[{key:'1',text:'답'},{key:'2',text:'오답'}],answerKey:'1'}]}});

function screen(kind){
  const html=fs.readFileSync(path.join(__dirname,'../reading-server/public/naesin-'+kind+'.html'),'utf8');
  const inline=html.split('<script>')[1].split('</script>')[0];
  const ids=new Set(Array.from(html.matchAll(/\bid=["']([^"']+)["']/g),m=>m[1]));
  const nodes=new Map(),requests=[],actions=[];
  let fetchImpl=async()=>response({live:null,board:[],votes:[],weakest:[]});
  function node(selector){
    if(!selector.startsWith('#')||!ids.has(selector.slice(1)))return null;
    if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',value:'',disabled:false,dataset:{},querySelectorAll:()=>[]});
    return nodes.get(selector);
  }
  const ctx=vm.createContext({
    localStorage:{getItem:()=>null},WBNaesinCoverage:COV,WBNAESINREADY:READY,WBGEN:GEN,
    document:{querySelector:node,querySelectorAll:s=>s==='[data-live-action]'?actions:s==='input[name=tkType]:checked'?[{value:'w-e2k'}]:[],addEventListener(){}},
    window:{addEventListener(){},open:()=>null},confirm:()=>true,setInterval:()=>1,clearInterval(){},
    fetch:async(url,opt)=>{requests.push({url,...opt});return fetchImpl(url,opt);},
  });
  if(kind==='admin'){
    const stop=inline.indexOf("$('#btnRefresh').onclick=refresh;");assert.ok(stop>1000);
    vm.runInContext(inline.slice(0,stop)+`
      this.ui={renderTask,loadTask,saveTask,studentRow,
        set:(scope,roster)=>{TASK_SCOPE=scope;ROSTER=roster;TASK_LOADING=false;TASK_BUSY=false;OV={students:[]};},
        get:()=>({scope:TASK_SCOPE,loading:TASK_LOADING,busy:TASK_BUSY,task:TASK,overview:OV})};`,ctx);
  }else{
    const stop=inline.indexOf('if(TOKEN)start();else renderLogin();');assert.ok(stop>1000);
    vm.runInContext(inline.slice(0,stop)+`
      this.ui={renderShell,paintScopePick,poll,changeScope,setPhase,extend,startProj,moveProj,revealProj,stopProj,
        set:(scope,roster,live)=>{SCOPE=scope;ROSTER=roster;LIVE=live;BOARD=[];PACKS=['${SAMPLE.packId}'];LOADING=false;},
        get:()=>({scope:SCOPE,loading:LOADING,busy:BUSY,live:LIVE}),popup:p=>{PROJWIN=p;}};`,ctx);
    for(const id of ['btnExt','btnEnd','btnProj','pjPrev','pjNext','pjRev','pjStop'])actions.push(node('#'+id));
  }
  ctx.ui.set('default',roster,live('원래 수업'));
  return{...ctx.ui,node,requests,actions,html,setFetch:fn=>{fetchImpl=fn;}};
}

(async()=>{
  await t('과제와 라이브 대상은 명부 반 키를 정규화·중복 제거·이스케이프한다',()=>{
    const task=screen('admin');task.renderTask();
    assert.equal((task.node('#taskArea').innerHTML.match(/value="cls:가반"/g)||[]).length,1);
    assert.ok(task.node('#taskArea').innerHTML.includes('cls:&lt;나반&gt;'));
    const ui=screen('live');ui.renderShell();
    assert.equal((ui.node('#liveScope').innerHTML.match(/value="cls:가반"/g)||[]).length,1);
    assert.ok(ui.node('#liveScope').innerHTML.includes('cls:&lt;나반&gt;'));
    assert.match(ui.html,/<script src="\/admin\/coverage\.js"><\/script>/);
  });

  await t('과제 대상 A→B→A 변경에서 오래된 A 응답도 무시하고 새 조회 전 저장을 막는다',async()=>{
    const ui=screen('admin'),pending=[];
    ui.setFetch(()=>new Promise(resolve=>pending.push(resolve)));
    const first=ui.loadTask('cls:가반'),second=ui.loadTask('default'),third=ui.loadTask('cls:가반');
    assert.equal(ui.get().loading,true);assert.match(ui.node('#taskArea').innerHTML,/id="btnTask" disabled/);
    await ui.saveTask();assert.equal(ui.requests.length,3);
    pending[2](response({task:{date:'2099-01-01',title:'새 가반'}}));await third;
    pending[0](response({task:{date:'2099-01-01',title:'옛 가반'}}));await first;
    pending[1](response({task:{date:'2099-01-01',title:'공통'}}));await second;
    assert.equal(ui.get().task.title,'새 가반');assert.ok(!/id="btnTask" disabled/.test(ui.node('#taskArea').innerHTML));
    for(const request of ui.requests)assert.ok(new URL(request.url,'https://qa.invalid').searchParams.has('scope'));
  });

  await t('반 과제 저장은 query scope를 고정하고 완료 현황을 한 번 새로 받는다',async()=>{
    const ui=screen('admin');ui.set('cls:가반',roster);ui.renderTask();
    ui.node('#tkDate').value='2099-12-31';ui.node('#tkTitle').value='가반 과제';
    ui.setFetch((url,opt)=>response(url.endsWith('/overview')?{students:[{code:'ST1',assignedTask:null}]}:{task:{date:'2099-12-31',title:'가반 과제',typeKeys:['w-e2k'],updatedAt:'new-task'}}));
    await ui.saveTask();
    assert.equal(new URL(ui.requests[0].url,'https://qa.invalid').searchParams.get('scope'),'cls:가반');
    assert.equal(ui.requests[0].method,'POST');
    assert.equal(ui.requests.filter(r=>r.url==='/api/naesin/admin/overview').length,1);
    assert.equal(ui.get().overview.students[0].assignedTask,null);
    assert.equal(ui.get().busy,false);assert.equal(ui.node('#tkScope').disabled,false);
  });

  await t('과제 완료는 학생별 assignedTask와 비교하고 null·없는 필드·지난 배정 완료는 섞지 않는다',()=>{
    const ui=screen('admin');
    const student={code:'ST1',summary:{task:{date:'2026-10-12',taskAt:'A-task',correct:3,total:4}},assignedTask:{date:'2026-10-12',updatedAt:'A-task'}};
    assert.match(ui.studentRow(student),/tag ok">3\/4/);
    for(const assigned of [null,undefined,{date:'2026-10-12',updatedAt:'B-task'},{date:'2026-10-11',updatedAt:'A-task'}])
      assert.ok(!ui.studentRow({...student,assignedTask:assigned}).includes('tag ok">3/4'));
  });

  await t('저장 후 현황 조회 실패도 저장된 반 과제를 유지하고 성공·조회 실패를 구분한다',async()=>{
    const ui=screen('admin');ui.set('cls:가반',roster);ui.renderTask();
    ui.node('#tkDate').value='2099-12-31';ui.node('#tkTitle').value='저장된 과제';
    ui.setFetch((url)=>{if(url.endsWith('/overview'))throw new Error('연결 실패');return response({task:{date:'2099-12-31',title:'저장된 과제'}});});
    await ui.saveTask();
    assert.equal(ui.get().task.title,'저장된 과제');assert.equal(ui.get().busy,false);
    assert.match(ui.node('#taskOut').innerHTML,/과제는 배정됐어요/);
  });

  await t('반 변경은 TV·옛 상태·입력 폼을 닫고 이전 폴링 응답을 버린다',async()=>{
    const ui=screen('live'),pending=[];let closed=0;
    ui.popup({closed:false,close:()=>closed++});
    ui.setFetch(()=>new Promise(resolve=>pending.push(resolve)));
    const old=ui.poll(),changed=ui.changeScope('cls:가반');
    assert.equal(closed,1);assert.equal(ui.get().loading,true);assert.equal(ui.get().live,null);
    assert.ok(ui.actions.every(button=>button.disabled));
    assert.match(ui.node('#app').innerHTML,/id="phMin".*value="10"/);
    pending[1](response({live:live('새 가반 수업'),board:[],votes:[],weakest:[]}));await changed;
    pending[0](response({live:live('옛 전체 수업'),board:[],votes:[],weakest:[]}));await old;
    assert.equal(ui.get().live.phase.label,'새 가반 수업');
    assert.ok(!ui.node('#phaseNow').innerHTML.includes('옛 전체 수업'));
    assert.equal(ui.get().loading,false);
  });

  await t('라이브 쓰기 중에는 대상 변경·추가 폴링이 금지되어 다른 반에 쓰지 않는다',async()=>{
    const ui=screen('live');ui.set('cls:가반',roster,live('가반'));ui.renderShell();ui.node('#phMin').value='10';
    let resolve;ui.setFetch(()=>new Promise(r=>{resolve=r;}));
    const pending=ui.setPhase('words');
    assert.equal(ui.get().busy,true);assert.equal(ui.node('#liveScope').disabled,true);
    await ui.changeScope('default');await ui.poll();
    assert.equal(ui.get().scope,'cls:가반');assert.equal(ui.requests.length,1);
    resolve(response({live:live('저장한 가반')}));await pending;
    assert.equal(new URL(ui.requests[0].url,'https://qa.invalid').searchParams.get('scope'),'cls:가반');
    assert.equal(ui.get().busy,false);assert.equal(ui.node('#liveScope').disabled,false);
  });

  await t('느린 라이브 조회 중에는 같은 대상 재조회를 겹치지 않아 응답을 계속 버리지 않는다',async()=>{
    const ui=screen('live');let resolve;
    ui.setFetch(()=>new Promise(r=>{resolve=r;}));
    const pending=ui.poll();await ui.poll();await ui.poll();
    assert.equal(ui.requests.length,1);
    resolve(response({live:live('느려도 받은 수업'),board:[],votes:[],weakest:[]}));await pending;
    assert.equal(ui.get().live.phase.label,'느려도 받은 수업');
  });

  await t('공통·반 타임박스와 모든 투사 쓰기가 같은 query scope를 쓰고 신규 투사는 packId를 보낸다',async()=>{
    for(const scope of ['default','cls:가반']){
      const ui=screen('live');ui.set(scope,roster,live('수업'));ui.renderShell();
      ui.node('#phMin').value='10';ui.node('#pjPack').value=SAMPLE.packId;ui.node('#pjKind').value='w-e2k';ui.node('#pjN').value='2';
      ui.setFetch((url,opt)=>response(url.includes('/admin/pack?')?{pack:SAMPLE}:{live:live('현재 수업')}));
      await ui.setPhase('words');await ui.extend();await ui.startProj();await ui.moveProj(0);await ui.revealProj(true);await ui.stopProj();
      const writes=ui.requests.filter(r=>r.method==='POST');assert.equal(writes.length,6);
      writes.forEach(r=>assert.equal(new URL(r.url,'https://qa.invalid').searchParams.get('scope'),scope));
      const generated=writes.map(r=>JSON.parse(r.body)).find(b=>Array.isArray(b.items));
      assert.equal(generated.packId,SAMPLE.packId);assert.ok(generated.items.length>0);
    }
  });
  console.log('통과 '+passed);
})().catch(e=>{console.error(e);process.exitCode=1;});
