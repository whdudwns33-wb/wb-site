'use strict';
/* 스튜디오 원본을 실행한다. 자료는 자체 작성 후보뿐이며 실제 PDF·검수 파일은 읽지 않는다. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../reading-server/public/naesin-studio.html'),'utf8');
const inline=html.split('<script>')[1].split('</script>')[0],ids=new Set(Array.from(html.matchAll(/\bid=["']([^"']+)["']/g),m=>m[1]));
const clone=v=>JSON.parse(JSON.stringify(v)),response=(body,status=200)=>({ok:status<400,status,json:async()=>body});
let passed=0;const t=async(name,fn)=>{await fn();passed++;console.log('  ✓ '+name);};
function draft(){return{kind:'naesin-pdf-review-draft',version:1,status:'needs-review',publishable:false,unmatchedWordRows:[],
  sources:{private:{file:'LOCAL_SOURCE_FILE',sha256:'LOCAL_SOURCE_HASH'}},
  wordCandidates:Array.from({length:74},(_,i)=>({candidateId:'wc-'+String(i+1).padStart(4,'0'),headCandidate:'ownword'+i,meanings:['자체 창작 뜻 '+i],posCandidates:i?['n.']:['n.','v.'],
    reviewFlags:['REVIEW_REQUIRED','SELF_WRITTEN_FLAG'],sourceRows:[{page:1,bbox:[40,100,215,120],headRaw:'RAW_ROW_SENTINEL',leftEvidence:[{text:'RAW_TOKEN_SENTINEL'}],sha256:'LOCAL_SOURCE_HASH'}]})),
  passageColumns:[{page:1,column:'EN',rawText:'LOCAL_COLUMN <script>sentinel</script>'},{page:1,column:'KO',rawText:'자체 창작 원천 열'},
    {page:2,column:'EN',rawText:'LOCAL_COLUMN second'},{page:2,column:'KO',rawText:'둘째 자체 창작 열'}]};}
const job=id=>({jobId:id||'job-self000001',packId:'own-review-L6',meta:{},draft:{},review:{},status:'review'});
function gate(j){const rows=j.draft.words||[],pending=rows.filter(r=>!j.review['words:'+r.id]).length;
  return{ok:false,pending,total:rows.length,errors:[],warns:rows.flatMap((r,i)=>r._pdfReview&&!j.review['words:'+r.id]?[{where:'words',message:'words['+i+'] PDF 원천 대조 필요'}]:[]),summary:[]};}
function screen(){
  const nodes=new Map(),requests=[],storage=new Map([['wbr.admin.token','own-test-admin-token']]);let stored=job();
  function node(s){if(!s.startsWith('#')||!ids.has(s.slice(1)))return null;
    if(!nodes.has(s))nodes.set(s,{innerHTML:'',textContent:'',value:'',files:[],disabled:false,hidden:false,querySelectorAll:()=>[],querySelector:()=>null});return nodes.get(s);}
  let fetchImpl=async(url,opt)=>{
    if(url==='/api/health')return response({localPdfReview:true});
    if(url==='/api/naesin/admin/job/draft'){stored.draft={...stored.draft,...JSON.parse(opt.body).draft};return response({job:stored,gate:gate(stored)});}
    if(url.startsWith('/api/naesin/admin/job?id='))return response({job:stored,gate:gate(stored),sources:{}});
    if(url==='/api/naesin/admin/jobs')return response({jobs:[]});
    if(url==='/api/naesin/admin/job/review')return response({job:stored,gate:gate(stored)});
    throw new Error('허용하지 않은 테스트 요청: '+url);
  };
  const ctx=vm.createContext({document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){}},
    localStorage:{getItem:k=>storage.get(k)||null,removeItem:k=>storage.delete(k),setItem:(k,v)=>storage.set(k,v)},
    WBAdminLogin:{mount(){}},confirm:()=>true,
    fetch:async(url,opt)=>{requests.push({url,...opt});return fetchImpl(url,opt);}});
  const stop=inline.indexOf("$('#bannerClose').onclick=hideBanner;");assert.ok(stop>1000);
  vm.runInContext(inline.slice(0,stop)+`
    this.ui={putPdfReviewFile,putDraftFiles,putDraft,pdfReviewDraft,regularDraft,pdfColumnsHtml,renderSrc,renderJob,review,bulkOk,openJob,openList,renderLogin,
      get:()=>({JOB,GATE,PDF_LOCAL,BUSY}),set:j=>{JOB=j;GATE={ok:false,pending:0,total:0,errors:[],warns:[],summary:[]};VIEW='job';JOB_READ++;},
      setGate:g=>{GATE=g;},setLocal:p=>{PDF_LOCAL=p;}};`,ctx);
  ctx.ui.set(stored);
  return{...ctx.ui,node,requests,setStored:j=>{stored=j;},setFetch:f=>{fetchImpl=f;}};
}

(async()=>{
  await t('학원 내 PC capability가 false·없음·네트워크 오류면 구매 검수 파일을 읽거나 올리지 않는다',async()=>{
    for(const h of [{localPdfReview:false},{runtime:'workers'},null]){
      const ui=screen();let reads=0;
      ui.node('#pdfReviewFile').files=[{text:async()=>{reads++;throw new Error('읽으면 안 됨');}}];
      ui.setFetch(()=>{if(h===null)throw new Error('연결 실패');return response(h);});
      await ui.putPdfReviewFile();
      assert.equal(reads,0);assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/health');
      assert.equal(ui.get().PDF_LOCAL,null);assert.equal(ui.get().BUSY,false);assert.equal(ui.node('#btnPdfReview').disabled,false);
    }
  });

  await t('capability 확인 또는 파일 읽기 중 작업이 바뀌면 이전 초안을 읽거나 새 작업에 쓰지 않는다',async()=>{
    for(const phase of ['health','file']){
      const ui=screen();let resolve,reads=0;
      ui.node('#pdfReviewFile').files=[{text:()=>{reads++;return phase==='file'?new Promise(r=>{resolve=r;}):Promise.resolve(JSON.stringify(draft()));}}];
      ui.setFetch(()=>phase==='health'?new Promise(r=>{resolve=r;}):response({localPdfReview:true}));
      const pending=ui.putPdfReviewFile();
      if(phase==='file')await new Promise(r=>setImmediate(r));
      ui.set(job('job-self000002'));resolve(phase==='health'?response({localPdfReview:true}):JSON.stringify(draft()));await pending;
      assert.equal(reads,phase==='health'?0:1);assert.equal(ui.requests.length,1);assert.equal(ui.get().PDF_LOCAL,null);
    }
  });

  await t('실제 형식의 자체 작성 후보 74개는 표준 단어+flags/locations DTO만 보내고 섹션은 추정하지 않는다',async()=>{
    const ui=screen(),own=draft();let reads=0;
    ui.node('#pdfReviewFile').files=[{text:async()=>{assert.equal(ui.requests[0].url,'/api/health');reads++;return JSON.stringify(own);}}];
    await ui.putPdfReviewFile();
    assert.equal(reads,1);assert.equal(ui.requests[0].url,'/api/health');
    const posted=JSON.parse(ui.requests.find(r=>r.url.endsWith('/job/draft')).body);
    assert.deepEqual(Object.keys(posted.draft),['words']);assert.equal(posted.draft.words.length,74);
    for(const row of posted.draft.words){assert.deepEqual(Object.keys(row),['id','headword','pos','meaningKo','sections','_pdfReview']);assert.deepEqual(row.sections,[]);
      assert.deepEqual(Object.keys(row._pdfReview),['flags','locations']);assert.deepEqual(Object.keys(row._pdfReview.locations[0]),['page','bbox']);}
    assert.equal(posted.draft.words[0].pos,'');assert.equal(posted.draft.words[1].pos,'n.');assert.equal(posted.draft.words[73].id,'w-0074');
    assert.deepEqual(posted.draft.words[0]._pdfReview.flags,['REVIEW_REQUIRED','SELF_WRITTEN_FLAG']);
    const body=JSON.stringify(posted);assert.ok(!/LOCAL_COLUMN|RAW_ROW_SENTINEL|RAW_TOKEN_SENTINEL|LOCAL_SOURCE_HASH|LOCAL_SOURCE_FILE|passageColumns|sourceRows/.test(body));
    assert.equal(ui.get().PDF_LOCAL.columns.length,4);assert.match(ui.node('#pdfReviewOut').textContent,/74개.*4열/);
    assert.match(ui.pdfColumnsHtml(),/&lt;script&gt;sentinel&lt;\/script&gt;/);assert.ok(!ui.pdfColumnsHtml().includes('<script>'));
  });

  await t('PDF 후보는 일괄 승인 대상에서 제외하고 개별 검수와 본문 수동 입력 안내를 유지한다',async()=>{
    const ui=screen();ui.node('#pdfReviewFile').files=[{text:async()=>JSON.stringify(draft())}];await ui.putPdfReviewFile();
    const before=ui.requests.length;await ui.bulkOk();assert.equal(ui.requests.length,before);
    const markup=ui.node('#app').innerHTML;
    assert.match(markup,/문제 없는 0행 일괄 승인/);assert.match(markup,/본문 문장 수동 입력 안내/);
    assert.match(markup,/PDF 후보는 원본을 대조해 한 행씩 검수/);assert.ok(!markup.includes('나머지는 일괄 승인하세요'));
    assert.match(markup,/모든 문장을 대조·검수/);assert.match(markup,/id="btnPub" disabled/);
  });

  await t('재조회 후 원문 열은 없고 저장된 위치·검토 표시는 원천 칸에 남는다',async()=>{
    const ui=screen();ui.node('#pdfReviewFile').files=[{text:async()=>JSON.stringify(draft())}];await ui.putPdfReviewFile();
    ui.setLocal(null);await ui.openJob(ui.get().JOB.jobId);
    assert.equal(ui.get().PDF_LOCAL,null);assert.equal(ui.pdfColumnsHtml(),'');
    const row=ui.get().JOB.draft.words[0];ui.renderSrc([{kind:'words',row,key:'words:'+row.id}]);
    assert.match(ui.node('#srcText').textContent,/1쪽 \[40, 100, 215, 120\]/);assert.match(ui.node('#srcText').textContent,/REVIEW_REQUIRED/);
    assert.ok(!ui.node('#srcText').textContent.includes('RAW_TOKEN_SENTINEL'));
    ui.renderSrc([{kind:'words',row,patch:{meaningKo:'잘못된 편집'},key:'words:'+row.id}]);
    assert.match(ui.node('#srcText').textContent,/형식 확인 필요/);
  });

  await t('일반 파일·붙여넣기의 검수 초안/unknown 배열은 원문 표시·업로드 없이 전용 경로 안내로 거절한다',async()=>{
    for(const obj of [draft(),{words:[{_pdfReview:{}}]},{unknownReview:[{raw:'RAW_TOKEN_SENTINEL'}]}]){
      const ui=screen();await ui.putDraft(JSON.stringify(obj),'자체 입력');
      assert.equal(ui.requests.length,0);assert.ok(!ui.node('#srcText').innerHTML.includes('RAW_TOKEN_SENTINEL'));
      assert.match(ui.node('#draftOut').innerHTML,/로컬 검수 초안|지원하지 않는/);
      ui.node('#draftFile').files=[{name:'self.json',text:async()=>JSON.stringify(obj)}];await ui.putDraftFiles();
      assert.equal(ui.requests.length,0);
    }
  });

  await t('기존 완성 JSON과 모든 지원 배열은 capability 조회 없이 기존 초안 경로로 이어진다',async()=>{
    const ui=screen(),sample=require('./pack-sample.json');
    await ui.putDraft(JSON.stringify({packId:sample.packId,words:sample.words,sentences:sample.sentences}),'자체 완성 JSON');
    assert.ok(!ui.requests.some(r=>r.url==='/api/health'));
    const posted=JSON.parse(ui.requests.find(r=>r.url.endsWith('/job/draft')).body);assert.deepEqual(Object.keys(posted.draft),['words','sentences']);
    const keys=['words','sentences','dialogues','patterns','items','oddOneItems','checkItems','keyExpressions','functions','vocabSidebar','readingQA'];
    assert.deepEqual(Object.keys(ui.regularDraft(Object.fromEntries(keys.map(k=>[k,[{}]])))),keys);
  });

  await t('이미 publishable인 파일·틀린 버전·중복 후보 ID·잘못된 위치·미대응 단어 행은 받아들이지 않는다',()=>{
    for(const mutate of [d=>d.publishable=true,d=>d.version=2,d=>d.status='ready',d=>d.wordCandidates[1].candidateId=d.wordCandidates[0].candidateId,
      d=>d.wordCandidates[0].sourceRows[0].bbox=[215,100,40,120],d=>d.wordCandidates[0].sourceRows[0].page=0,d=>d.unmatchedWordRows=[{headRaw:'자체 미대응'}]]){
      const own=draft();mutate(own);assert.throws(()=>screen().pdfReviewDraft(own));
    }
  });

  await t('작업 변경·목록·로그아웃은 로컬 원천 열을 회수하며 일반 파일 읽기 중 대상 변경도 막는다',async()=>{
    for(const leave of ['job','list','logout']){
      const ui=screen();ui.setLocal({jobId:ui.get().JOB.jobId,columns:draft().passageColumns});
      if(leave==='job'){ui.setStored(job('job-self000002'));await ui.openJob('job-self000002');}
      else if(leave==='list')await ui.openList();else ui.renderLogin();
      assert.equal(ui.get().PDF_LOCAL,null);assert.ok(!ui.node('#app').innerHTML.includes('LOCAL_COLUMN'));
    }
    const ui=screen();let resolve;
    ui.node('#draftFile').files=[{name:'self.json',text:()=>new Promise(r=>{resolve=r;})}];
    const pending=ui.putDraftFiles();ui.set(job('job-self000002'));resolve(JSON.stringify({words:[{id:'own-1'}]}));await pending;
    assert.equal(ui.requests.length,0);
  });

  await t('수정 뒤 승인·버림·되살리기·일괄 승인에서도 수정값과 메모를 유지하고 명시적 비우기만 지운다',async()=>{
    const ui=screen(),own=job(),key='words:own-1';
    own.draft.words=[{id:'own-1',headword:'original'}];own.review[key]={state:'fixed',patch:{headword:'corrected',sections:['reading']},note:'자체 검수 메모'};
    ui.setStored(own);ui.set(own);
    for(const state of ['ok','dropped','pending']){
      await ui.review(key,state);assert.equal(ui.get().JOB.review[key].patch.headword,'corrected');assert.equal(ui.get().JOB.review[key].note,'자체 검수 메모');
      const sent=JSON.parse(ui.requests.at(-1).body);assert.ok(!('patch' in sent));assert.ok(!('note' in sent));
    }
    await ui.bulkOk();assert.equal(ui.get().JOB.review[key].patch.headword,'corrected');assert.equal(ui.get().JOB.review[key].note,'자체 검수 메모');
    await ui.review(key,'ok',undefined,'');assert.equal(ui.get().JOB.review[key].note,undefined);assert.equal(ui.get().JOB.review[key].patch.headword,'corrected');
    await ui.review(key,'ok',null);assert.equal(ui.get().JOB.review[key].patch,undefined);
  });
  console.log('통과 '+passed);
})().catch(e=>{console.error(e);process.exitCode=1;});
