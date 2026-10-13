'use strict';
/* 스튜디오 원본을 실행한다. 자료는 자체 작성 후보뿐이며 실제 PDF·검수 파일은 읽지 않는다. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../reading-server/public/naesin-studio.html'),'utf8');
const inline=html.split('<script>')[1].split('</script>')[0],ids=new Set(Array.from(html.matchAll(/\bid=["']([^"']+)["']/g),m=>m[1]));
for(const side of ['En','Ko'])for(const range of ['Column','Start','End'])ids.add('pdf'+side+range);
const clone=v=>JSON.parse(JSON.stringify(v)),response=(body,status=200)=>({ok:status<400,status,json:async()=>body});
const pdfResponse=()=>({ok:true,status:200,headers:{get:()=> 'application/pdf'},blob:async()=>({type:'application/pdf',own:'SELF_WRITTEN_PDF'})});
const ownPdfSha='a'.repeat(64);
let passed=0;const t=async(name,fn)=>{await fn();passed++;console.log('  ✓ '+name);};
function draft(){return{kind:'naesin-pdf-review-draft',version:1,status:'needs-review',publishable:false,unmatchedWordRows:[],
  sources:{private:{file:'LOCAL_SOURCE_FILE',sha256:'LOCAL_SOURCE_HASH'}},
  wordCandidates:Array.from({length:74},(_,i)=>({candidateId:'wc-'+String(i+1).padStart(4,'0'),headCandidate:'ownword'+i,meanings:['자체 창작 뜻 '+i],posCandidates:i?['n.']:['n.','v.'],
    reviewFlags:['REVIEW_REQUIRED','SELF_WRITTEN_FLAG'],sourceRows:[{page:1,bbox:[40,100,215,120],headRaw:'RAW_ROW_SENTINEL',leftEvidence:[{text:'RAW_TOKEN_SENTINEL'}],sha256:'LOCAL_SOURCE_HASH'}]})),
  passageColumns:[{page:1,column:'EN',rawText:'LOCAL_COLUMN <script>sentinel</script>'},{page:1,column:'KO',rawText:'자체 창작 원천 열'},
    {page:2,column:'EN',rawText:'LOCAL_COLUMN second'},{page:2,column:'KO',rawText:'둘째 자체 창작 열'}]};}
function passageDraft(){const d=draft();
  const lines=(texts,x)=>texts.map((text,i)=>({text,y:100+i*20,tokens:[{text:'PRIVATE_TOKEN_SENTINEL',x0:x,top:100+i*20,x1:x+140,bottom:116+i*20,fontname:'PRIVATE_FONT_SENTINEL',sha256:'LOCAL_SOURCE_HASH'}]}));
  d.passageColumns[0].lines=lines(['A toy','is blue.','UNSELECTED_EN_SENTINEL'],40);
  d.passageColumns[1].lines=lines(['장난감이 파랗다.','선택하지 않은 한글 원천'],330);
  d.passageColumns[2].lines=lines(['Go!'],40);d.passageColumns[3].lines=lines(['가자!','선택하지 않은 한글 둘째 원천'],330);
  return d;}
const job=id=>({jobId:id||'job-self000001',packId:'own-review-L6',meta:{},draft:{},review:{},status:'review',updatedAt:'2026-01-01T00:00:00.000Z'});
function gate(j){let pending=0,total=0;const warns=[];
  for(const [kind,rows] of Object.entries(j.draft))rows.forEach((r,i)=>{total++;const key=kind+':'+(r.id||'s'+r.seq);
    if(!j.review[key]){pending++;if(r._pdfReview)warns.push({where:kind,message:kind+'['+i+'] PDF 원천 대조 필요'});}});
  return{ok:false,pending,total,errors:[],warns,summary:[]};}
function screen(){
  const nodes=new Map(),rendered=new Map(),events=new Map(),requests=[],created=[],revoked=[],storage=new Map([['wbr.admin.token','own-test-admin-token']]);let stored=job(),rowRenders=0,appGeneration=0;
  const decode=s=>s.replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[key]));
  function node(s){if(!s.startsWith('#')||!ids.has(s.slice(1)))return null;
    if(!nodes.has(s)){
      const el={textContent:'',value:'',files:[],...(rendered.get(s)||{disabled:false}),hidden:false,focus(){},querySelectorAll:()=>[],querySelector:()=>null};let markup='';
      Object.defineProperty(el,'innerHTML',{get:()=>markup,set:value=>{markup=value;if(s==='#app'||s==='#rowList'){
        if(s==='#app'){rendered.clear();appGeneration++;}else rowRenders++;
        for(const m of value.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){
          const selector='#'+m[1],attrs={disabled:/\sdisabled(?:[\s=>])/.test(m[0]),checked:/\schecked(?:[\s=>])/.test(m[0])};
          const input=/\svalue="([^"]*)"/.exec(m[0]);if(input)attrs.value=decode(input[1]);
          const textarea=new RegExp('<textarea[^>]*id="'+m[1]+'"[^>]*>([\\s\\S]*?)<\\/textarea>').exec(value);if(textarea)attrs.value=decode(textarea[1]);
          rendered.set(selector,attrs);if(nodes.has(selector))Object.assign(nodes.get(selector),attrs);
        }
      }}});
      if(s==='#rowList')el.querySelectorAll=selector=>{
        const rows=selector==='.row'?/\bdata-key="([^"]+)"/g:/^\[data-[a-z]+\]$/.test(selector)?new RegExp('\\b'+selector.slice(1,-1)+'="([^"]+)"','g'):null;
        if(!rows)return[];return Array.from(markup.matchAll(rows),m=>{
          const attr=selector==='.row'?'key':selector.slice(6,-1),key=selector+decode(m[1]);
          if(!nodes.has(key))nodes.set(key,{dataset:{[attr]:decode(m[1])}});return nodes.get(key);
        });
      };nodes.set(s,el);
    }return nodes.get(s);}
  function chunks(selector){const m=/^\[data-pdf-(chunk|keyword)-(en|ko)\]$/.exec(selector);if(!m)return[];
    return Array.from(node('#app').innerHTML.matchAll(new RegExp('<textarea data-pdf-'+m[1]+'-'+m[2]+'="(\\d+)"[^>]*>([\\s\\S]*?)<\\/textarea>','g')),x=>{
      const key=selector+x[1],dataset='pdf'+(m[1]==='chunk'?'Chunk':'Keyword')+(m[2]==='en'?'En':'Ko');
      if(!nodes.has(key))nodes.set(key,{dataset:{[dataset]:x[1]}});const el=nodes.get(key);
      if(el.generation!==appGeneration){el.value=decode(x[2]);el.generation=appGeneration;}return el;});}
  let fetchImpl=async(url,opt)=>{
    if(url==='/api/health')return response({localPdfReview:true});
    if(url.startsWith('/api/naesin/admin/job/local-review?id='))return response({draft:passageDraft(),pdfs:[{source:'02',file:'02_own.pdf',pageCount:2,sha256:ownPdfSha},{source:'03',file:'03_own.pdf',pageCount:26,sha256:ownPdfSha}]});
    if(url.startsWith('/api/naesin/admin/job/local-pdf?id='))return pdfResponse();
    if(url==='/api/naesin/admin/job/draft'){stored={...stored,draft:{...stored.draft,...JSON.parse(opt.body).draft},updatedAt:new Date(Date.parse(stored.updatedAt)+1).toISOString()};return response({job:stored,gate:gate(stored)});}
    if(url.startsWith('/api/naesin/admin/job?id='))return response({job:stored,gate:gate(stored),sources:{}});
    if(url==='/api/naesin/admin/jobs')return response({jobs:[]});
    if(url==='/api/naesin/admin/job/review'){
      const body=JSON.parse(opt.body),review={...stored.review};
      if(body.baseUpdatedAt!==stored.updatedAt)return response({error:'최신 작업 조회 필요'},409);
      for(const row of body.rows||[body]){const rec={...review[row.key],state:row.state};
        if('patch'in row){if(row.patch===null)delete rec.patch;else rec.patch=row.patch;}
        if('note'in row){if(row.note)rec.note=row.note;else delete rec.note;}
        review[row.key]=rec;
      }
      stored={...stored,review,updatedAt:new Date(Date.parse(stored.updatedAt)+1).toISOString()};return response({job:{jobId:stored.jobId,updatedAt:stored.updatedAt},gate:gate(stored)});
    }
    throw new Error('허용하지 않은 테스트 요청: '+url);
  };
  const ctx=vm.createContext({document:{querySelector:node,querySelectorAll:chunks,addEventListener:(type,fn)=>events.set(type,fn)},
    localStorage:{getItem:k=>storage.get(k)||null,removeItem:k=>storage.delete(k),setItem:(k,v)=>storage.set(k,v)},
    WBAdminLogin:{mount(){}},WBPACKCHECK:require('./pack-check.js'),confirm:()=>true,
    URL:{createObjectURL:b=>{const url='blob:own-'+(created.length+1);created.push({url,blob:b});return url;},revokeObjectURL:url=>revoked.push(url)},
    fetch:async(url,opt)=>{requests.push({url,...opt});return fetchImpl(url,opt);}});
  const stop=inline.indexOf("$('#bannerClose').onclick=hideBanner;");assert.ok(stop>1000);
  vm.runInContext(inline.slice(0,stop)+`
    this.ui={putPdfReviewFile,putDraftFiles,putDraft,pdfReviewDraft,regularDraft,pdfColumnsHtml,pdfSentenceHtml,loadPdfSentence,savePdfSentence,savePdfWord,renderSrc,renderJob,review,bulkOk,openJob,openList,renderLogin,
      get:()=>({JOB,GATE,PDF_LOCAL,PDF_VIEW,PDF_WORD_EDIT,VIEW,SEL,EDIT,SRC,BUSY}),set:j=>{JOB=j;GATE={ok:false,pending:0,total:0,errors:[],warns:[],summary:[]};VIEW='job';JOB_READ++;},
      setGate:g=>{GATE=g;},setLocal:p=>{PDF_LOCAL=p;},setToken:t=>{TOKEN=t;},showAll:()=>{FONLY='all';renderJob();}};`,ctx);
  ctx.ui.set(stored);
  return{...ctx.ui,node,chunks,events,requests,created,revoked,rowRenders:()=>rowRenders,setStored:j=>{stored=j;},setFetch:f=>{fetchImpl=f;}};
}
async function loadPassage(ui){ui.node('#pdfReviewFile').files=[{text:async()=>JSON.stringify(passageDraft())}];await ui.putPdfReviewFile();}
function field(ui,id,value){const el=ui.node('#'+id);el.value=value;el.oninput();}
function pair(ui,enColumn='0',enStart='1',enEnd='2',koColumn='1',koStart='1',koEnd='1'){
  for(const [id,value] of [['pdfEnColumn',enColumn],['pdfEnStart',enStart],['pdfEnEnd',enEnd],['pdfKoColumn',koColumn],['pdfKoStart',koStart],['pdfKoEnd',koEnd]])field(ui,id,value);
  ui.loadPdfSentence();}
function chunk(ui,index,en,ko){for(const [side,value] of [['en',en],['ko',ko]]){const el=ui.chunks('[data-pdf-chunk-'+side+']')[index];el.value=value;el.oninput();}}
function keyword(ui,index,en,ko){for(const [side,value] of [['en',en],['ko',ko]]){const el=ui.chunks('[data-pdf-keyword-'+side+']')[index];el.value=value;el.oninput();}}
function editRow(ui,key){const button=ui.node('#rowList').querySelectorAll('[data-edit]').find(el=>el.dataset.edit===key);assert.ok(button);button.onclick();}
function wordInput(ui,head=' own fixed word ',pos=' adj. ',meanings=' 뜻 하나\n\n 뜻 둘 '){field(ui,'pdfWordHead',head);field(ui,'pdfWordPos',pos);field(ui,'pdfWordMean',meanings);}
function wordSection(ui,section,checked){const el=ui.node('#pdfWord'+section);el.checked=checked;el.onchange();}

(async()=>{
  await t('새 작업·기존 작업 상세에 권리 근거 입력과 구매 비허가 안내를 보인다',()=>{
    for(const id of ['nRightsBasis','nRightsHolder','nRightsEvidence','nRightsExpiry','nStudentAllowed','nDerivativeAllowed','nAiAllowed','rBasis','rHolder','rEvidence','rExpiry','rStudent','rDerivative','rAi','btnRights']) assert.ok(ids.has(id),'권리 입력 누락 '+id);
    assert.match(html,/구매했다는 사실만으로 변환·학생 제공 권리가 생기지 않습니다/);
    assert.match(html,/권리 미확인 상태에서는 PC PDF 불러오기·AI 추출·배포가 차단되며/);
    assert.match(html,/허가 확인된 자료에서 원천 붙이기/);
  });
  await t('기존 작업의 rights 값을 권리 입력 전체에 정확히 prefill하고 HTML 이스케이프한다',()=>{
    const ui=screen(),own=job();own.meta.rights={basis:'licensed',holder:'Synthetic rights holder',evidenceRef:'contract-fixture-2026',expiresAt:'2027-03-31',studentUseAllowed:true,derivativeUseAllowed:true,externalAiAllowed:false};
    ui.set(own);ui.renderJob();const markup=ui.node('#app').innerHTML;
    assert.match(markup,/<option value="licensed" selected>별도 계약<\/option>/);
    assert.match(markup,/<input id="rHolder" value="Synthetic rights holder">/);
    assert.match(markup,/<input id="rEvidence" value="contract-fixture-2026">/);
    assert.match(markup,/<input type="date" id="rExpiry" value="2027-03-31">/);
    assert.match(markup,/<input type="checkbox" id="rStudent" checked>/);
    assert.match(markup,/<input type="checkbox" id="rDerivative" checked>/);
    assert.match(markup,/<input type="checkbox" id="rAi"\s*>/);
    own.meta.rights.holder='<img src=x onerror=alert(1)>';ui.set(own);ui.renderJob();
    assert.ok(!ui.node('#app').innerHTML.includes('<input id="rHolder" value="<img'));
    assert.match(ui.node('#app').innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  await t('PDF 검수의 기본 진입은 PC 자료 불러오기 하나이고 파일·JSON·줄 대응은 고급 입력에서 유지한다',()=>{
    const ui=screen();ui.renderJob();const markup=ui.node('#app').innerHTML;
    assert.match(markup,/id="btnPcReview"[^>]*>PC 자료 불러오기/);
    assert.match(markup,/<details[^>]*id="advancedInput"[^>]*><summary[^>]*>고급 입력<\/summary>[\s\S]*id="pdfReviewFile"[\s\S]*id="draftFile"/);
    assert.ok(!/<details[^>]*id="advancedInput"[^>]*\bopen\b/.test(markup));ui.node('#advancedInput').open=true;ui.renderJob();assert.match(ui.node('#app').innerHTML,/<details[^>]*id="advancedInput"[^>]*\bopen\b/);
    assert.ok(markup.indexOf('id="btnPcReview"')<markup.indexOf('고급 입력'));
    assert.match(markup,/원본을 보고 오류를 수정한 뒤 승인/);
  });

  await t('PC 자료 연결은 기존 74행·교정·검수·메모·버전을 쓰지 않고 원본 PDF를 Bearer로만 연다',async()=>{
    const ui=screen(),own=job();own.draft.words=clone(ui.pdfReviewDraft(passageDraft()).words);
    own.review['words:w-0001']={state:'fixed',patch:{headword:'corrected own word',sections:['reading']},note:'대조한 자체 메모'};
    ui.setStored(own);ui.set(own);ui.showAll();const before=JSON.stringify(own);await ui.node('#btnPcReview').onclick();await new Promise(r=>setImmediate(r));
    assert.equal(JSON.stringify(ui.get().JOB),before);assert.equal(ui.get().JOB,own);assert.equal(ui.get().PDF_LOCAL.columns.length,4);
    assert.deepEqual(ui.requests.map(r=>r.url),['/api/health','/api/naesin/admin/job/local-review?id=job-self000001','/api/naesin/admin/job/local-pdf?id=job-self000001&source=03&sha256='+ownPdfSha]);
    assert.ok(ui.requests.every(r=>!r.method||r.method==='GET'));assert.equal(ui.requests.at(-1).headers.Authorization,'Bearer own-test-admin-token');
    assert.equal(ui.requests.at(-1).cache,'no-store');assert.ok(!ui.requests.some(r=>r.url.includes('token')));
    assert.equal(ui.created.length,1);assert.equal(ui.get().PDF_VIEW.source,'03');assert.match(ui.node('#pdfPreview').innerHTML,/iframe[^>]*title="검수할 원본 PDF"[^>]*src="blob:own-1#page=1"/);
    assert.match(ui.node('#pdfPreview').innerHTML,/PDF 크게 보기/);assert.ok(ui.node('#srcText').hidden);
    assert.match(ui.node('#pdfReviewOut').textContent,/기존 단어 74개와 검수를 유지/);
  });

  await t('PC 원천을 다시 연결해도 같은 단어·본문 입력을 보존하며 새 후보의 뜻·섹션은 추정하지 않는다',async()=>{
    const ui=screen();ui.renderJob();await ui.putPdfReviewFile(true);await new Promise(r=>setImmediate(r));
    assert.equal(ui.requests.filter(r=>r.method==='POST').length,1);assert.equal(ui.get().JOB.draft.words.length,74);assert.deepEqual(clone(ui.get().JOB.draft.words[0].sections),[]);
    assert.deepEqual(clone(ui.get().JOB.review),{});pair(ui);field(ui,'pdfSentenceDay','own-1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');keyword(ui,0,'blue','파랗다');
    editRow(ui,'words:w-0001');wordInput(ui);wordSection(ui,'Reading',true);const form=JSON.stringify(ui.get().PDF_LOCAL.sentence),word=JSON.stringify(ui.get().PDF_WORD_EDIT),before=JSON.stringify(ui.get().JOB);
    await ui.putPdfReviewFile(true);await new Promise(r=>setImmediate(r));assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);assert.equal(JSON.stringify(ui.get().PDF_WORD_EDIT),word);
    assert.equal(JSON.stringify(ui.get().JOB),before);assert.equal(ui.requests.filter(r=>r.method==='POST').length,1);assert.equal(ui.node('#pdfWordHead').value,' own fixed word ');
  });

  await t('다른 PC 후보·원본 정보 오류·서버 실패는 검수와 입력·연결한 PDF를 바꾸지 않는다',async()=>{
    for(const kind of ['mismatch','metadata','server']){
      const ui=screen();ui.renderJob();await ui.putPdfReviewFile(true);await new Promise(r=>setImmediate(r));pair(ui);field(ui,'pdfSentenceDay','own-1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
      editRow(ui,'words:w-0001');wordInput(ui);wordSection(ui,'Reading',true);
      const before=JSON.stringify(ui.get().JOB),local=JSON.stringify(ui.get().PDF_LOCAL),word=JSON.stringify(ui.get().PDF_WORD_EDIT),url=ui.get().PDF_VIEW.url,writes=ui.requests.filter(r=>r.method==='POST').length;
      ui.setFetch(url=>{if(url==='/api/health')return response({localPdfReview:true});const raw=passageDraft();if(kind==='mismatch')raw.wordCandidates[0].headCandidate='different own word';
        return kind==='server'?response({error:'자체 원천 없음'},404):response({draft:raw,pdfs:[{source:kind==='mismatch'?'03':'04',file:'own.pdf',pageCount:2,sha256:ownPdfSha}]});});
      await ui.putPdfReviewFile(true);assert.equal(JSON.stringify(ui.get().JOB),before);assert.equal(JSON.stringify(ui.get().PDF_LOCAL),local);assert.equal(JSON.stringify(ui.get().PDF_WORD_EDIT),word);
      assert.equal(ui.get().PDF_VIEW.url,url);assert.equal(ui.requests.filter(r=>r.method==='POST').length,writes);assert.ok(ui.node('#pdfReviewOut').textContent);assert.equal(ui.revoked.length,0);
    }
  });

  await t('직접 원본은 단어03·문장02와 위치의 쪽으로 이동하고 자료 선택·목록·로그아웃 시 이전 blob을 회수한다',async()=>{
    const ui=screen(),own=job();own.draft.words=clone(ui.pdfReviewDraft(passageDraft()).words);
    ui.setStored(own);ui.set(own);ui.showAll();await ui.putPdfReviewFile(true);await new Promise(r=>setImmediate(r));
    ui.get().JOB.draft.words[0]._pdfReview.locations[0].page=4;ui.renderJob();assert.match(ui.node('#pdfPreview').innerHTML,/#page=4/);assert.equal(ui.created.length,1);
    ui.get().JOB.draft.sentences=[{seq:1,en:'Go!',ko:'가자!',_pdfReview:{flags:['REVIEW_REQUIRED'],locations:[{page:2,bbox:[1,2,3,4]}]}}];ui.showAll();editRow(ui,'sentences:s1');await new Promise(r=>setImmediate(r));
    assert.equal(ui.get().PDF_VIEW.source,'02');assert.match(ui.node('#pdfPreview').innerHTML,/#page=2/);assert.deepEqual(ui.revoked,['blob:own-1']);
    ui.node('#pdfSource').value='03';ui.node('#pdfSource').onchange();await new Promise(r=>setImmediate(r));assert.equal(ui.get().PDF_VIEW.source,'03');assert.deepEqual(ui.revoked,['blob:own-1','blob:own-2']);
    await ui.openList();assert.equal(ui.get().PDF_VIEW,null);assert.deepEqual(ui.revoked,['blob:own-1','blob:own-2','blob:own-3']);
    own.draft.words[0]._pdfReview.locations[0].page=1;ui.setStored(own);await ui.openJob(own.jobId);await ui.putPdfReviewFile(true);await new Promise(r=>setImmediate(r));
    ui.renderLogin();assert.equal(ui.get().PDF_VIEW,null);assert.ok(ui.revoked.includes('blob:own-4'));
  });

  await t('PC 초안 응답 대기 중 작업·계정·로그아웃이 바뀌면 원천·PDF를 새 화면에 연결하지 않는다',async()=>{
    for(const change of ['job','token','logout']){
      const ui=screen();ui.renderJob();let resolve;ui.setFetch(url=>url==='/api/health'?response({localPdfReview:true}):new Promise(r=>{resolve=r;}));
      const pending=ui.putPdfReviewFile(true);await new Promise(r=>setImmediate(r));
      if(change==='job'){ui.set(job('job-self000002'));ui.renderJob();}else if(change==='token'){ui.setToken('new-own-token');ui.renderJob();}else ui.renderLogin();
      const markup=ui.node('#app').innerHTML;resolve(response({draft:passageDraft(),pdfs:[{source:'03',file:'03_own.pdf',pageCount:26,sha256:ownPdfSha}]}));await pending;
      assert.equal(ui.get().PDF_LOCAL,null);assert.equal(ui.get().PDF_VIEW,null);assert.equal(ui.created.length,0);assert.equal(ui.node('#app').innerHTML,markup);assert.equal(ui.requests.filter(r=>r.method==='POST').length,0);
    }
  });

  await t('늦은 PDF 응답·blob·401은 작업·계정·로그아웃 뒤 원본을 노출하거나 새 계정을 만료시키지 않는다',async()=>{
    for(const phase of ['response','blob','401'])for(const change of ['job','token','logout']){
      const ui=screen(),own=job();own.draft.words=clone(ui.pdfReviewDraft(passageDraft()).words);ui.setStored(own);ui.set(own);ui.showAll();let resolve;
      ui.setFetch(url=>url==='/api/health'?response({localPdfReview:true}):url.includes('/local-review?')?response({draft:passageDraft(),pdfs:[{source:'03',file:'03_own.pdf',pageCount:26,sha256:ownPdfSha}]}):
        phase==='blob'?{ok:true,status:200,headers:{get:()=> 'application/pdf'},blob:()=>new Promise(r=>{resolve=r;})}:new Promise(r=>{resolve=r;}));
      await ui.putPdfReviewFile(true);await new Promise(r=>setImmediate(r));assert.equal(typeof resolve,'function');
      if(change==='job'){ui.set(job('job-self000002'));ui.setLocal(null);ui.renderJob();}else if(change==='token'){ui.setToken('new-own-token');ui.setLocal(null);ui.renderJob();}else ui.renderLogin();
      const markup=ui.node('#app').innerHTML;resolve(phase==='blob'?{type:'application/pdf',own:'SELF_WRITTEN_PDF'}:phase==='401'?response({error:'자체 만료'},401):pdfResponse());await new Promise(r=>setImmediate(r));
      assert.equal(ui.created.length,0);assert.equal(ui.get().PDF_VIEW,null);assert.equal(ui.node('#app').innerHTML,markup);if(change==='token')assert.equal(ui.get().VIEW,'job');
    }
  });

  await t('PDF 오류와 잘못된 응답은 승인·입력을 건드리지 않고 재시도하며 현재401은 원천을 회수한다',async()=>{
    for(const failure of ['server','type','401','lineage']){
      const ui=screen(),own=job();own.draft.words=clone(ui.pdfReviewDraft(passageDraft()).words);own.review['words:w-0001']={state:'pending',note:'자체 메모'};ui.setStored(own);ui.set(own);ui.showAll();const before=JSON.stringify(own);
      ui.setFetch(url=>{if(url==='/api/health')return response({localPdfReview:true});if(url.includes('/local-review?'))return response({draft:passageDraft(),pdfs:[{source:'03',file:'03_own.pdf',pageCount:26,sha256:ownPdfSha}]});
        assert.ok(url.endsWith('&sha256='+ownPdfSha));return failure==='type'?{...pdfResponse(),headers:{get:()=> 'text/html'}}:response({error:failure==='lineage'?'원본이 바뀌었어요. PC 자료를 다시 불러오세요.':'자체 PDF 오류'},failure==='401'?401:failure==='lineage'?409:500);});
      await ui.putPdfReviewFile(true);await new Promise(r=>setImmediate(r));assert.equal(ui.created.length,0);
      if(failure==='401'){assert.equal(ui.get().VIEW,'login');assert.equal(ui.get().PDF_LOCAL,null);assert.equal(ui.get().PDF_VIEW,null);}else{
        assert.equal(JSON.stringify(ui.get().JOB),before);assert.match(ui.node('#pdfPreview').innerHTML,/PDF 다시 열기/);assert.ok(ui.get().PDF_VIEW.message);
        ui.setFetch(()=>pdfResponse());ui.node('#btnPdfRetry').onclick();await new Promise(r=>setImmediate(r));assert.equal(ui.created.length,1);assert.ok(ui.get().PDF_VIEW.url);
      }
    }
  });

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
    assert.equal(posted.baseUpdatedAt,'2026-01-01T00:00:00.000Z');
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
      const sent=JSON.parse(ui.requests.filter(r=>r.url.endsWith('/job/review')).at(-1).body);assert.ok(!('patch' in sent));assert.ok(!('note' in sent));
    }
    await ui.bulkOk();assert.equal(ui.get().JOB.review[key].patch.headword,'corrected');assert.equal(ui.get().JOB.review[key].note,'자체 검수 메모');
    await ui.review(key,'ok',undefined,'');assert.equal(ui.get().JOB.review[key].note,undefined);assert.equal(ui.get().JOB.review[key].patch.headword,'corrected');
    await ui.review(key,'ok',null);assert.equal(ui.get().JOB.review[key].patch,undefined);
  });

  await t('본문은 좌우 줄 수가 달라도 자동 대응하지 않고 위치 있는 줄의 text/bbox만 브라우저에 둔다',async()=>{
    const ui=screen();await loadPassage(ui);
    const local=clone(ui.get().PDF_LOCAL),f=local.sentence;
    assert.equal(local.columns[0].lines.length,3);assert.equal(local.columns[1].lines.length,2);
    assert.deepEqual(Object.keys(local.columns[0]),['page','column','rawText','lines']);
    assert.deepEqual(local.columns[0].lines[0],{text:'A toy',bbox:[40,100,180,116]});
    assert.ok(!/PRIVATE_TOKEN_SENTINEL|PRIVATE_FONT_SENTINEL|LOCAL_SOURCE_HASH|LOCAL_SOURCE_FILE/.test(JSON.stringify(local)));
    assert.equal(f.enColumn,'');assert.equal(f.koColumn,'');assert.equal(f.en,'');assert.equal(f.ko,'');assert.equal(f.loaded,null);
    assert.deepEqual(f.chunks,[{en:'',ko:''}]);assert.match(ui.pdfColumnsHtml(),/1\. A toy\n2\. is blue\./);
    assert.match(ui.node('#app').innerHTML,/id="btnPdfSentenceSave" disabled/);
    assert.ok(!ui.node('#pdfSentenceFields').disabled);
    const legacy=screen();legacy.node('#pdfReviewFile').files=[{text:async()=>JSON.stringify(draft())}];await legacy.putPdfReviewFile();
    assert.match(legacy.node('#app').innerHTML,/줄 위치 정보가 없는 초안/);assert.ok(!legacy.node('#app').innerHTML.includes('id="pdfSentenceFields"'));
  });

  await t('본문 줄의 누락·역방향·음수·무한 좌표와 잘못된 쪽을 거절하고 줄 없는 기존 v1은 단어 반입을 유지한다',()=>{
    for(const mutate of [d=>d.passageColumns[0].page=1000001,d=>d.passageColumns[0].lines={},d=>d.passageColumns[0].lines[0].tokens=[],
      d=>d.passageColumns[0].lines[0].text='',d=>delete d.passageColumns[0].lines[0].tokens[0].bottom,
      d=>d.passageColumns[0].lines[0].tokens[0].top=-1,d=>d.passageColumns[0].lines[0].tokens[0].x0=181,d=>d.passageColumns[0].lines[0].tokens[0].x1=Infinity]){
      const own=passageDraft();mutate(own);assert.throws(()=>screen().pdfReviewDraft(own));
    }
    assert.equal(screen().pdfReviewDraft(draft()).words.length,74);
  });

  await t('교사가 양쪽 열과 줄을 각각 지정해야 채우며 범위 변경 후 다시 대응해야 저장할 수 있다',async()=>{
    const ui=screen();await loadPassage(ui);ui.loadPdfSentence();assert.equal(ui.get().PDF_LOCAL.sentence.loaded,null);
    for(const args of [['0','0','2','1','1','1'],['0','2','1','1','1','1'],['0','1','4','1','1','1'],['0','1.5','2','1','1','1'],['0','1','2','0','1','1']]){
      pair(ui,...args);assert.equal(ui.get().PDF_LOCAL.sentence.loaded,null);assert.match(ui.node('#pdfSentenceOut').textContent,/원천 열과 시작·끝 줄/);
    }
    pair(ui);assert.equal(ui.get().PDF_LOCAL.sentence.en,'A toy is blue.');assert.equal(ui.get().PDF_LOCAL.sentence.ko,'장난감이 파랗다.');
    assert.deepEqual(clone(ui.get().PDF_LOCAL.sentence.chunks),[{en:'',ko:''}]);
    field(ui,'pdfEnEnd','3');assert.equal(ui.get().PDF_LOCAL.sentence.loaded,null);assert.ok(ui.node('#btnPdfSentenceSave').disabled);
    await ui.savePdfSentence();assert.equal(ui.requests.filter(r=>r.url.endsWith('/job/draft')).length,1);
  });

  await t('교사 교정 문장·단락·직독직해 청크 한 행만 미검토로 추가하고 기존 문장 원행·단어 검수를 보존한다',async()=>{
    const ui=screen();await loadPassage(ui);const current=ui.get().JOB;
    const old={seq:7,dayGroup:'earlier',en:'Own earlier sentence.',ko:'기존 자체 문장.',chunks:[{en:'Own earlier sentence.',ko:'기존 자체 문장.'}],keywords:[{en:'Own',ko:'자체'}]};
    current.draft.sentences=[old];current.review['sentences:s7']={state:'fixed',patch:{ko:'수정한 기존 해석'},note:'남겨 둘 검수 메모'};
    current.review['words:w-0001']={state:'ok',patch:{sections:['reading']},note:'원본 대조 완료'};ui.renderJob();
    pair(ui);field(ui,'pdfSentenceEn',' A toy is red. ');field(ui,'pdfSentenceKo',' 장난감이 빨갛다. ');field(ui,'pdfSentenceDay',' body-1 ');
    chunk(ui,0,' A toy ',' 장난감은 ');ui.node('#btnPdfChunkAdd').onclick();chunk(ui,1,'is red.','빨갛다.');ui.node('#btnPdfChunkAdd').onclick();
    const before=ui.requests.length;await ui.savePdfSentence();
    assert.equal(ui.requests[before].url,'/api/health');
    const sent=JSON.parse(ui.requests.slice(before).find(r=>r.url.endsWith('/job/draft')).body);
    assert.equal(sent.baseUpdatedAt,'2026-01-01T00:00:00.001Z');
    assert.deepEqual(Object.keys(sent.draft),['sentences']);assert.deepEqual(sent.draft.sentences[0],old);assert.equal(sent.draft.sentences.length,2);
    assert.deepEqual(sent.draft.sentences[1],{seq:8,dayGroup:'body-1',en:'A toy is red.',ko:'장난감이 빨갛다.',chunks:[{en:'A toy',ko:'장난감은'},{en:'is red.',ko:'빨갛다.'}],keywords:[],
      _pdfReview:{flags:['REVIEW_REQUIRED','TEACHER_PAIRED'],locations:[{page:1,bbox:[40,100,180,136]},{page:1,bbox:[330,100,470,116]}]}});
    assert.ok(!/UNSELECTED_EN_SENTINEL|PRIVATE_TOKEN_SENTINEL|PRIVATE_FONT_SENTINEL|LOCAL_SOURCE_HASH|LOCAL_SOURCE_FILE|passageColumns|rawText|sourceRows/.test(JSON.stringify(sent)));
    assert.equal(ui.get().JOB.draft.words.length,74);assert.equal(ui.get().JOB.review['words:w-0001'].note,'원본 대조 완료');
    assert.equal(ui.get().JOB.review['sentences:s7'].patch.ko,'수정한 기존 해석');assert.equal(ui.get().JOB.review['sentences:s8'],undefined);
    assert.equal(ui.get().JOB.updatedAt,'2026-01-01T00:00:00.002Z');
    assert.ok(!ui.node('#btnPdfReview').disabled);
    assert.match(ui.node('#pdfSentenceOut').textContent,/8번을 미검토로 저장/);assert.equal(ui.get().PDF_LOCAL.sentence.en,'');
    const added=ui.get().JOB.draft.sentences[1];ui.renderSrc([{kind:'sentences',row:added,key:'sentences:s8'}]);
    assert.match(ui.node('#srcText').textContent,/영어 문장: A toy is red\./);assert.match(ui.node('#srcText').textContent,/직독직해/);
    assert.ok(!ui.node('#srcText').textContent.includes('단어 후보:'));
  });

  await t('청크는 자동 생성하지 않으며 빈짝·불일치는 거절하고 교사가 직접 입력한 짧은 한 청크 문장은 허용한다',async()=>{
    const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');
    for(const c of [['',''],['A toy is blue.',''],['A toy','장난감은']]){
      chunk(ui,0,...c);await ui.savePdfSentence();assert.equal(ui.requests.filter(r=>r.url.endsWith('/job/draft')).length,1);
      assert.ok(ui.get().PDF_LOCAL.sentence.en);assert.ok(!ui.node('#pdfSentenceFields').disabled);
    }
    pair(ui,'2','1','1','3','1','1');field(ui,'pdfSentenceDay','2');chunk(ui,0,'Go!','가자!');await ui.savePdfSentence();
    assert.equal(ui.get().JOB.draft.sentences[0].chunks.length,1);assert.match(ui.node('#pdfSentenceOut').textContent,/미검토로 저장/);
  });

  await t('본문 저장 capability가 false·없음·연결 실패면 입력을 유지하고 문장 업로드를 하지 않는다',async()=>{
    for(const health of [{localPdfReview:false},{runtime:'workers'},null]){
      const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
      const before=ui.requests.length,form=JSON.stringify(ui.get().PDF_LOCAL.sentence);
      ui.setFetch(()=>{if(health===null)throw new Error('오프라인');return response(health);});await ui.savePdfSentence();
      assert.equal(ui.requests.length,before+1);assert.equal(ui.requests.at(-1).url,'/api/health');assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);
      assert.ok(!ui.node('#pdfSentenceFields').disabled);assert.ok(!ui.node('#pdfSentenceOut').textContent.includes('미검토로 저장했어요'));
    }
  });

  await t('본문 저장 실패·중복 클릭은 입력과 청크를 유지하고 성공으로 표시하지 않는다',async()=>{
    const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
    const before=ui.requests.length,form=JSON.stringify(ui.get().PDF_LOCAL.sentence);let resolve;
    ui.setFetch(url=>url.endsWith('/health')?response({localPdfReview:true}):new Promise(r=>{resolve=r;}));
    const pending=ui.savePdfSentence();await new Promise(r=>setImmediate(r));assert.ok(ui.get().BUSY);assert.ok(ui.node('#pdfSentenceFields').disabled);
    await ui.savePdfSentence();assert.equal(ui.requests.length,before+2);
    resolve(response({error:'자체 저장 실패'},500));await pending;
    assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);assert.match(ui.node('#pdfSentenceOut').textContent,/자체 저장 실패/);
    assert.equal(ui.get().BUSY,false);assert.ok(!ui.node('#pdfSentenceFields').disabled);
  });

  await t('본문 POST 뒤 재조회가 실패해도 현재 작업과 입력을 보존하고 성공으로 표시하지 않는다',async()=>{
    const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
    const current=ui.get().JOB,form=JSON.stringify(ui.get().PDF_LOCAL.sentence),before=ui.requests.length;
    ui.setFetch(url=>url.endsWith('/health')?response({localPdfReview:true}):url.endsWith('/job/draft')?response({ok:true}):response({error:'자체 재조회 실패'},500));
    await ui.savePdfSentence();assert.equal(ui.requests.length,before+3);assert.equal(ui.get().JOB,current);assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);
    assert.match(ui.node('#pdfSentenceOut').textContent,/저장은 끝났지만.*새로고침/);assert.ok(!ui.node('#pdfSentenceFields').disabled);
  });

  await t('작업 버전 없는 화면은 일반 초안과 PDF 후보를 쓰지 않고 최신 작업 조회를 안내한다',async()=>{
    const regular=screen();delete regular.get().JOB.updatedAt;await regular.putDraft(JSON.stringify({words:[{id:'own-1'}]}),'자체 입력');
    assert.equal(regular.requests.length,0);assert.match(regular.node('#draftOut').innerHTML,/작업 버전.*새로고침/);
    const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');delete ui.get().JOB.updatedAt;
    const before=ui.requests.length,form=JSON.stringify(ui.get().PDF_LOCAL.sentence);await ui.savePdfSentence();
    assert.equal(ui.requests.length,before+1);assert.equal(ui.requests.at(-1).url,'/api/health');assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);
    assert.match(ui.node('#pdfSentenceOut').textContent,/작업 버전.*새로고침/);
  });

  await t('다른 교사의 새 문장·교정·메모와 버전이 있으면 이전 화면은409로 멈추고 입력을 유지한다',async()=>{
    const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
    const server=clone(ui.get().JOB),baseUpdatedAt=ui.get().JOB.updatedAt,form=JSON.stringify(ui.get().PDF_LOCAL.sentence),before=ui.requests.length;
    server.updatedAt='2026-01-01T00:00:00.020Z';server.draft.sentences=[{seq:1,dayGroup:'new',en:'A new toy is green.',ko:'새 장난감은 초록색이다.',chunks:[{en:'A new toy is green.',ko:'새 장난감은 초록색이다.'}]}];
    server.review['sentences:s1']={state:'fixed',patch:{ko:'다른 교사가 교정한 해석'},note:'다른 교사의 새 검수 메모'};const original=JSON.stringify(server);let writes=0;
    ui.setFetch((url,opt)=>{
      if(url.endsWith('/health'))return response({localPdfReview:true});
      assert.ok(url.endsWith('/job/draft'));const body=JSON.parse(opt.body);assert.equal(body.baseUpdatedAt,baseUpdatedAt);
      if(body.baseUpdatedAt!==server.updatedAt)return response({error:'최신 작업을 먼저 읽으세요.'},409);
      writes++;server.draft={...server.draft,...body.draft};return response({ok:true});
    });
    await ui.savePdfSentence();assert.equal(ui.requests.length,before+2);assert.equal(writes,0);assert.equal(JSON.stringify(server),original);
    assert.equal(ui.get().JOB.updatedAt,baseUpdatedAt);assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);assert.match(ui.node('#pdfSentenceOut').textContent,/다른 곳.*새로고침.*최신 작업/);
    assert.ok(!ui.node('#pdfSentenceOut').textContent.includes('미검토로 저장했어요'));assert.ok(!ui.node('#pdfSentenceFields').disabled);
  });

  await t('POST 성공 뒤 재조회 실패는 버전만 올리지 않고 재저장409로 기존 서버 문장을 지킨다',async()=>{
    const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
    const server=clone(ui.get().JOB),baseUpdatedAt=server.updatedAt,form=JSON.stringify(ui.get().PDF_LOCAL.sentence);let writes=0;
    ui.setFetch((url,opt)=>{
      if(url.endsWith('/health'))return response({localPdfReview:true});
      if(url.includes('/job?id='))return response({error:'자체 재조회 실패'},500);
      const body=JSON.parse(opt.body);assert.equal(body.baseUpdatedAt,baseUpdatedAt);
      if(body.baseUpdatedAt!==server.updatedAt)return response({error:'최신 작업 조회 필요'},409);
      writes++;server.draft={...server.draft,...body.draft};server.updatedAt='2026-01-01T00:00:00.030Z';return response({ok:true,job:{updatedAt:server.updatedAt}});
    });
    await ui.savePdfSentence();assert.equal(writes,1);assert.equal(server.draft.sentences.length,1);assert.equal(ui.get().JOB.updatedAt,baseUpdatedAt);assert.equal(ui.get().JOB.draft.sentences,undefined);
    assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);assert.match(ui.node('#pdfSentenceOut').textContent,/저장은 끝났지만.*새로고침/);
    const saved=JSON.stringify(server);await ui.savePdfSentence();assert.equal(writes,1);assert.equal(JSON.stringify(server),saved);assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);
    assert.match(ui.node('#pdfSentenceOut').textContent,/다른 곳.*최신 작업/);
  });

  await t('본문 저장 capability·POST·재조회 대기 중 작업이나 계정 변경은 새 화면과 로컬 원천에 이전 응답을 반영하지 않는다',async()=>{
    for(const phase of ['health','post','get'])for(const change of ['job','token','logout']){
      const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
      const before=ui.requests.length,baseUpdatedAt=ui.get().JOB.updatedAt;let resolve;
      ui.setFetch(url=>{
        if((phase==='health'&&url.endsWith('/health'))||(phase==='post'&&url.endsWith('/job/draft'))||(phase==='get'&&url.includes('/job?id=')))return new Promise(r=>{resolve=r;});
        if(url.endsWith('/health'))return response({localPdfReview:true});return response({});
      });
      const pending=ui.savePdfSentence();await new Promise(r=>setImmediate(r));assert.equal(typeof resolve,'function');
      if(phase!=='health')assert.equal(JSON.parse(ui.requests.slice(before).find(r=>r.url.endsWith('/job/draft')).body).baseUpdatedAt,baseUpdatedAt);
      if(change==='job'){ui.set(job('job-self000002'));ui.setLocal(null);ui.renderJob();}
      else if(change==='token'){ui.setToken('different-self-token');ui.setLocal(null);ui.renderJob();}else ui.renderLogin();
      const markup=ui.node('#app').innerHTML,out=ui.node('#pdfSentenceOut').textContent;
      resolve(phase==='health'?response({localPdfReview:true}):phase==='get'?response({job:job(),gate:gate(job()),sources:{}}):response({}));await pending;
      assert.equal(ui.get().PDF_LOCAL,null);assert.equal(ui.node('#app').innerHTML,markup);assert.equal(ui.node('#pdfSentenceOut').textContent,out);
      if(phase==='health')assert.equal(ui.requests.length,before+1);
      if(phase==='post')assert.equal(ui.requests.length,before+2);
    }
  });

  await t('동일 PDF 초안의 본문 다시 열기는 단어·기존 검수를 재전송하지 않으며 다른 후보로 덮지 않는다',async()=>{
    const ui=screen();await loadPassage(ui);ui.get().JOB.review['words:w-0001']={state:'fixed',patch:{meaningKo:['검수 교정']},note:'보존할 메모'};
    const before=ui.requests.length;ui.setLocal(null);await loadPassage(ui);
    assert.equal(ui.requests.length,before+1);assert.equal(ui.requests.at(-1).url,'/api/health');assert.match(ui.node('#pdfReviewOut').textContent,/기존 단어 74개와 검수를 유지/);
    assert.equal(ui.get().JOB.review['words:w-0001'].patch.meaningKo[0],'검수 교정');assert.equal(ui.get().PDF_LOCAL.columns.length,4);
    const own=passageDraft();own.wordCandidates[0].headCandidate='different-own-word';ui.node('#pdfReviewFile').files=[{text:async()=>JSON.stringify(own)}];
    const second=ui.requests.length;await ui.putPdfReviewFile();assert.equal(ui.requests.length,second+1);assert.match(ui.node('#pdfReviewOut').textContent,/별도 작업/);
    assert.equal(ui.get().JOB.draft.words[0].headword,'ownword0');assert.equal(ui.get().JOB.review['words:w-0001'].note,'보존할 메모');
  });

  await t('이전 계정의 늦은 401 응답은 새 계정을 로그아웃시키거나 화면을 바꾸지 않는다',async()=>{
    const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');let resolve;
    ui.setFetch(url=>url.endsWith('/health')?response({localPdfReview:true}):new Promise(r=>{resolve=r;}));
    const pending=ui.savePdfSentence();await new Promise(r=>setImmediate(r));
    ui.setToken('new-self-admin-token');ui.setLocal(null);ui.set(job('job-self000002'));ui.renderJob();const markup=ui.node('#app').innerHTML;
    resolve(response({error:'자체 만료'},401));await pending;assert.equal(ui.node('#app').innerHTML,markup);assert.equal(ui.get().JOB.jobId,'job-self000002');assert.equal(ui.get().PDF_LOCAL,null);
  });

  await t('개별·일괄 검수 뒤 전체 작업을 함께 갱신하여 최신 버전과 다른 교사의 새 문장·메모를 다음 후보에 보존한다',async()=>{
    for(const mode of ['one','bulk']){
      const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
      if(mode==='bulk')ui.get().JOB.draft.words.push({id:'w-own',headword:'own',meaningKo:['자체 창작'],sections:['reading']});
      const form=JSON.stringify(ui.get().PDF_LOCAL.sentence),server=clone(ui.get().JOB),key=mode==='one'?'words:w-0001':'words:w-own';
      const other={seq:1,dayGroup:'other',en:'A bell is gold.',ko:'종은 금빛이다.',chunks:[{en:'A bell',ko:'종은'},{en:'is gold.',ko:'금빛이다.'}]};
      let otherAdded=false;
      ui.setFetch((url,opt)=>{
        if(url.endsWith('/health'))return response({localPdfReview:true});
        if(url.endsWith('/job/review')){assert.equal(JSON.parse(opt.body).baseUpdatedAt,server.updatedAt);server.review[key]={state:'ok'};server.updatedAt='2026-01-01T00:00:00.020Z';return response({job:{updatedAt:server.updatedAt},gate:gate(server)});}
        if(url.includes('/job?id=')){
          if(!otherAdded){otherAdded=true;server.draft.sentences=[other];server.review['sentences:s1']={state:'fixed',patch:{ko:'다른 교사가 고친 해석'},note:'다른 교사의 검수 메모'};server.updatedAt='2026-01-01T00:00:00.021Z';}
          return response({job:clone(server),gate:gate(server),sources:{}});
        }
        assert.ok(url.endsWith('/job/draft'));const body=JSON.parse(opt.body);assert.equal(body.baseUpdatedAt,'2026-01-01T00:00:00.021Z');
        assert.deepEqual(body.draft.sentences[0],other);assert.equal(body.draft.sentences.length,2);assert.equal(body.draft.sentences[1].seq,2);
        server.draft={...server.draft,...body.draft};server.updatedAt='2026-01-01T00:00:00.022Z';return response({ok:true});
      });
      if(mode==='one')await ui.review(key,'ok');else await ui.bulkOk();
      assert.equal(ui.get().JOB.updatedAt,'2026-01-01T00:00:00.021Z');assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);
      assert.deepEqual(clone(ui.get().JOB.draft.sentences[0]),other);assert.equal(ui.get().JOB.review['sentences:s1'].note,'다른 교사의 검수 메모');assert.equal(ui.get().JOB.review[key].state,'ok');
      await ui.savePdfSentence();assert.match(ui.node('#pdfSentenceOut').textContent,/2번을 미검토로 저장/);
      assert.equal(ui.get().JOB.review['sentences:s1'].patch.ko,'다른 교사가 고친 해석');assert.equal(ui.get().JOB.review['sentences:s1'].note,'다른 교사의 검수 메모');
    }
  });

  await t('개별·일괄 검수 POST 뒤 재조회 실패는 폼·현재 작업·구버전을 유지하고 저장 완료와 조회 필요를 구분한다',async()=>{
    for(const mode of ['one','bulk']){
      const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
      if(mode==='bulk')ui.get().JOB.draft.words.push({id:'w-own',headword:'own',meaningKo:['자체 창작'],sections:['reading']});
      const current=ui.get().JOB,version=current.updatedAt,form=JSON.stringify(ui.get().PDF_LOCAL.sentence),before=ui.requests.length;
      ui.setFetch(url=>url.endsWith('/job/review')?response({job:{updatedAt:'2026-01-01T00:00:00.050Z'},gate:{ok:true}}):response({error:'자체 재조회 실패'},503));
      if(mode==='one')await ui.review('words:w-0001','ok');else await ui.bulkOk();
      assert.equal(ui.requests.length,before+2);assert.equal(ui.get().JOB,current);assert.equal(ui.get().JOB.updatedAt,version);assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);
      assert.match(ui.node('#bannerMsg').textContent,/검수 저장은 끝났지만.*새로고침/);assert.ok(ui.get().PDF_LOCAL);assert.ok(!ui.requests.slice(before).some(r=>r.url.endsWith('/jobs')));
    }
  });

  await t('개별·일괄 검수는 시작 버전을 전송하고 버전 없이는 optimistic 상태·교정·메모를 바꾸거나 쓰지 않는다',async()=>{
    for(const mode of ['one','bulk']){
      const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
      const key=mode==='one'?'words:w-0001':'words:w-own';if(mode==='bulk')ui.get().JOB.draft.words.push({id:'w-own',headword:'own',meaningKo:['자체 창작'],sections:['reading']});
      ui.get().JOB.review[key]={state:'pending',patch:{headword:'기존 교정'},note:'기존 메모'};const baseUpdatedAt=ui.get().JOB.updatedAt;
      const before=ui.requests.length;if(mode==='one')await ui.review(key,'ok');else await ui.bulkOk();
      const body=JSON.parse(ui.requests.slice(before).find(r=>r.url.endsWith('/job/review')).body);assert.equal(body.baseUpdatedAt,baseUpdatedAt);assert.ok(body.baseUpdatedAt);
      delete ui.get().JOB.updatedAt;ui.get().JOB.review[key]={state:'pending',patch:{headword:'기존 교정'},note:'기존 메모'};ui.renderJob();
      const current=JSON.stringify(ui.get().JOB),form=JSON.stringify(ui.get().PDF_LOCAL.sentence),markup=ui.node('#app').innerHTML,count=ui.requests.length;
      if(mode==='one')await ui.review(key,'fixed',{headword:'지금 교정'},'지금 메모');else await ui.bulkOk();
      assert.equal(ui.requests.length,count);assert.equal(JSON.stringify(ui.get().JOB),current);assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);assert.equal(ui.node('#app').innerHTML,markup);
      assert.match(ui.node('#bannerMsg').textContent,/작업 버전.*새로고침/);
    }
  });

  await t('개별·일괄 검수409는 미승인·기존 교정·메모와 문장 폼을 보존하고 원문 재조회 뒤 검수하도록 안내한다',async()=>{
    for(const mode of ['one','bulk']){
      const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
      const key=mode==='one'?'words:w-0001':'words:w-own';if(mode==='bulk')ui.get().JOB.draft.words.push({id:'w-own',headword:'own',meaningKo:['자체 창작'],sections:['reading']});
      ui.get().JOB.review[key]={state:'pending',patch:{headword:'기존 교정'},note:'기존 메모'};ui.renderJob();
      const server=clone(ui.get().JOB);server.updatedAt='2026-01-01T00:00:00.100Z';server.draft.words[0].headword='다른 교사가 바꾼 원행';
      const original=JSON.stringify(server),current=JSON.stringify(ui.get().JOB),form=JSON.stringify(ui.get().PDF_LOCAL.sentence),before=ui.requests.length;let writes=0;
      ui.setFetch((url,opt)=>{assert.ok(url.endsWith('/job/review'));const body=JSON.parse(opt.body);assert.equal(body.baseUpdatedAt,ui.get().JOB.updatedAt);
        if(body.baseUpdatedAt!==server.updatedAt)return response({error:'원문을 다시 대조하세요.'},409);writes++;return response({ok:true});});
      if(mode==='one')await ui.review(key,'fixed',{headword:'지금 교정'},'지금 메모');else await ui.bulkOk();
      assert.equal(writes,0);assert.equal(ui.requests.length,before+1);assert.equal(JSON.stringify(server),original);assert.equal(JSON.stringify(ui.get().JOB),current);assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);
      assert.equal(ui.get().JOB.review[key].state,'pending');assert.match(ui.node('#bannerMsg').textContent,/다른 곳.*최신 작업.*다시 검수/);assert.ok(!ui.node('#bannerMsg').textContent.includes('저장은 끝났지만'));
    }
  });

  await t('실패한 개별 검수는 그 행만 되돌려 다른 동시 검수 입력을 지우지 않는다',async()=>{
    const ui=screen(),own=job();own.draft.words=[{id:'own-1',headword:'first'},{id:'own-2',headword:'second'}];
    own.review['words:own-1']={state:'fixed',patch:{headword:'corrected'},note:'첫 행 메모'};ui.setStored(own);ui.set(own);
    let firstResolve,secondResolve;ui.setFetch((url,opt)=>{
      if(url.endsWith('/job/review'))return new Promise(resolve=>{if(JSON.parse(opt.body).key==='words:own-1')firstResolve=resolve;else secondResolve=resolve;});
      const full=clone(own);full.review['words:own-2']={state:'ok'};full.updatedAt='2026-01-01T00:00:00.060Z';return response({job:full,gate:gate(full),sources:{}});
    });
    const first=ui.review('words:own-1','ok'),second=ui.review('words:own-2','ok');
    firstResolve(response({error:'자체 검수 저장 실패'},500));await first;
    assert.equal(ui.get().JOB.review['words:own-1'].state,'fixed');assert.equal(ui.get().JOB.review['words:own-1'].note,'첫 행 메모');assert.equal(ui.get().JOB.review['words:own-2'].state,'ok');
    secondResolve(response({ok:true}));await second;assert.equal(ui.get().JOB.updatedAt,'2026-01-01T00:00:00.060Z');assert.equal(ui.get().JOB.review['words:own-2'].state,'ok');
  });

  await t('개별·일괄 검수의 늦은 POST·GET·401·500 응답은 다른 작업이나 새 계정의 화면·검수·판정을 바꾸지 않는다',async()=>{
    for(const mode of ['one','bulk'])for(const phase of ['post','get'])for(const change of ['job','token','logout'])for(const status of [200,401,500]){
      const ui=screen(),own=job();own.draft.words=[{id:'own-1',headword:'first'}];ui.setStored(own);ui.set(own);let resolve;
      ui.setFetch(url=>((phase==='post'&&url.endsWith('/job/review'))||(phase==='get'&&url.includes('/job?id=')))?new Promise(r=>{resolve=r;}):response({ok:true}));
      const pending=mode==='one'?ui.review('words:own-1','ok'):ui.bulkOk();await new Promise(r=>setImmediate(r));assert.equal(typeof resolve,'function');
      if(change==='logout')ui.renderLogin();else{if(change==='token')ui.setToken('different-self-admin-token');ui.set(job('job-self000002'));ui.renderJob();}
      const current=ui.get().JOB,markup=ui.node('#app').innerHTML,review=JSON.stringify(current&&current.review),g=JSON.stringify(ui.get().GATE),banner=ui.node('#bannerMsg').textContent;
      resolve(status===200?(phase==='get'?response({job:own,gate:gate(own),sources:{}}):response({ok:true})):response({error:'이전 요청 실패'},status));await pending;
      assert.equal(ui.get().JOB,current);assert.equal(ui.node('#app').innerHTML,markup);assert.equal(JSON.stringify(ui.get().JOB&&ui.get().JOB.review),review);assert.equal(JSON.stringify(ui.get().GATE),g);assert.equal(ui.node('#bannerMsg').textContent,banner);
    }
  });

  await t('새 전체 작업을 읽은 뒤 늦게 도착한 이전 GET은 최신 문장·검수·메모·판정·버전을 덮지 않는다',async()=>{
    const ui=screen(),own=job();own.draft.words=[{id:'own-1',headword:'first'},{id:'own-2',headword:'second'}];ui.setStored(own);ui.set(own);
    let oldResolve,getCount=0;const newer=clone(own);newer.updatedAt='2026-01-01T00:00:00.090Z';newer.draft.sentences=[{seq:1,dayGroup:'new',en:'Go!',ko:'가자!',chunks:[{en:'Go!',ko:'가자!'}]}];
    newer.review['words:own-1']={state:'ok'};newer.review['words:own-2']={state:'fixed',patch:{headword:'new second'},note:'새 검수 메모'};
    ui.setFetch(url=>{
      if(url.endsWith('/job/review'))return response({ok:true});
      if(++getCount===1)return new Promise(r=>{oldResolve=r;});return response({job:clone(newer),gate:gate(newer),sources:{}});
    });
    const first=ui.review('words:own-1','ok');await new Promise(r=>setImmediate(r));await ui.review('words:own-2','ok');
    const fresh=ui.get().JOB,g=JSON.stringify(ui.get().GATE),older=clone(own);older.updatedAt='2026-01-01T00:00:00.080Z';older.review={'words:own-1':{state:'ok'}};
    oldResolve(response({job:older,gate:gate(older),sources:{}}));await first;
    assert.equal(ui.get().JOB,fresh);assert.equal(ui.get().JOB.updatedAt,newer.updatedAt);assert.equal(ui.get().JOB.draft.sentences.length,1);assert.equal(ui.get().JOB.review['words:own-2'].note,'새 검수 메모');assert.equal(JSON.stringify(ui.get().GATE),g);
  });

  await t('같은 작업의 수동 새로고침 실패도 현재 작업과 문장 입력을 회수하지 않는다',async()=>{
    const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
    const current=ui.get().JOB,form=JSON.stringify(ui.get().PDF_LOCAL.sentence);ui.setFetch(()=>response({error:'자체 조회 실패'},503));await ui.openJob(current.jobId);
    assert.equal(ui.get().JOB,current);assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);assert.match(ui.node('#bannerMsg').textContent,/자체 조회 실패/);
  });

  await t('PDF 단어 편집만 일반 입력으로 열고 섹션은 추정하지 않으며 다른 행의 JSON 편집은 유지한다',async()=>{
    const ui=screen();await loadPassage(ui);const before=ui.requests.length;editRow(ui,'words:w-0001');
    const markup=ui.node('#rowList').innerHTML;assert.match(markup,/표제어/);assert.match(markup,/품사/);assert.match(markup,/뜻 · 한 줄에 하나/);assert.match(markup,/id="pdfWordReading"/);assert.match(markup,/id="pdfWordConversation"/);
    assert.ok(!ui.get().PDF_WORD_EDIT.reading);assert.ok(!ui.get().PDF_WORD_EDIT.conversation);assert.equal(ui.requests.length,before);assert.equal(ui.get().JOB.review['words:w-0001'],undefined);
    assert.ok(!markup.includes('data-ed="words:w-0001"'));assert.ok(!markup.includes('PRIVATE_TOKEN_SENTINEL'));
    const own=job();own.draft.words=[{id:'own-1',headword:'own'}];own.draft.sentences=[{seq:1,en:'Go!',ko:'가자!'}];ui.setStored(own);ui.set(own);ui.showAll();
    for(const key of ['words:own-1','sentences:s1']){editRow(ui,key);assert.ok(ui.node('#rowList').innerHTML.includes('data-ed="'+key+'"'));assert.ok(!ui.node('#rowList').innerHTML.includes('id="pdfWordFields"'));}
  });

  await t('PDF 단어의 명시 교정 저장은 ID·원본 위치·기존 추가필드·교정·메모를 보존하고 네 입력만 고친다',async()=>{
    const ui=screen();await loadPassage(ui);const row=ui.get().JOB.draft.words[0],key='words:'+row.id;
    row.example={en:'An own example.',ko:'자체 예문.'};row.level=2;
    ui.get().JOB.review[key]={state:'pending',patch:{id:'own-corrected-id',definition:{en:'An own definition.',ko:'자체 정의.'},senses:[{meaningKo:'기존 다른 뜻'}],level:3},note:'보존할 교사 메모'};
    const source=JSON.stringify(row),baseUpdatedAt=ui.get().JOB.updatedAt;ui.renderJob();editRow(ui,key);wordInput(ui);wordSection(ui,'Reading',true);wordSection(ui,'Conversation',true);
    const before=ui.requests.length;await ui.savePdfWord();
    const body=JSON.parse(ui.requests.slice(before).find(r=>r.url.endsWith('/job/review')).body);
    assert.equal(body.baseUpdatedAt,baseUpdatedAt);assert.equal(body.key,key);assert.equal(body.state,'fixed');assert.equal(body.note,undefined);
    assert.deepEqual(body.patch,{id:'own-corrected-id',definition:{en:'An own definition.',ko:'자체 정의.'},senses:[{meaningKo:'기존 다른 뜻'}],level:3,headword:'own fixed word',pos:'adj.',meaningKo:['뜻 하나','뜻 둘'],sections:['reading','conversation']});
    assert.equal(body.patch.id,'own-corrected-id');assert.ok(!('_pdfReview'in body.patch));assert.equal(JSON.stringify(ui.get().JOB.draft.words[0]),source);
    assert.equal(ui.get().JOB.review[key].note,'보존할 교사 메모');assert.equal(ui.get().JOB.review[key].patch.level,3);assert.equal(ui.get().JOB.review[key].state,'fixed');
    assert.equal(ui.get().PDF_WORD_EDIT,null);assert.equal(ui.get().EDIT,null);assert.equal(ui.get().JOB.draft.words.length,74);
  });

  await t('PDF 단어 입력·선택·체크박스 레이블 클릭은 행 재렌더 없이 값을 유지한다',async()=>{
    const ui=screen();await loadPassage(ui);editRow(ui,'words:w-0001');wordInput(ui);
    const row=ui.node('#rowList').querySelectorAll('.row').find(el=>el.dataset.key==='words:w-0001');assert.ok(row.onclick);
    for(const tag of ['input','select','textarea','label','fieldset','button']){
      const before=ui.rowRenders();row.onclick({target:{closest:selector=>selector.split(',').includes(tag)?{}:null}});assert.equal(ui.rowRenders(),before);
    }
    const checkbox=ui.node('#pdfWordReading');checkbox.checked=true;row.onclick({target:{closest:selector=>selector.split(',').includes('label')?{}:null}});checkbox.onchange();
    assert.ok(ui.get().PDF_WORD_EDIT.reading);assert.equal(ui.node('#pdfWordHead').value,' own fixed word ');assert.equal(ui.node('#pdfWordMean').value,' 뜻 하나\n\n 뜻 둘 ');
  });

  await t('PDF 단어는 표제어·뜻·명시 섹션이 없으면 쓰지 않고 버전이 바뀌어도 입력을 유지하며 재대조를 안내한다',async()=>{
    const ui=screen();await loadPassage(ui);editRow(ui,'words:w-0001');const before=ui.requests.length;wordInput(ui,'','','');await ui.savePdfWord();
    assert.equal(ui.requests.length,before);assert.match(ui.node('#pdfWordOut').textContent,/직접 선택/);
    wordInput(ui);await ui.savePdfWord();assert.equal(ui.requests.length,before);assert.ok(!ui.get().PDF_WORD_EDIT.reading);assert.ok(!ui.get().PDF_WORD_EDIT.conversation);
    wordSection(ui,'Reading',true);ui.get().JOB.updatedAt='2026-01-01T00:00:00.120Z';await ui.savePdfWord();
    assert.equal(ui.requests.length,before);assert.match(ui.node('#pdfWordOut').textContent,/입력을 유지.*취소.*다시 편집/);assert.equal(ui.node('#pdfWordHead').value,' own fixed word ');
  });

  await t('PDF 단어 POST실패·409·저장후 조회실패는 native 입력·체크·편집을 남기며 중복 제출하지 않는다',async()=>{
    for(const phase of ['post-error','conflict','get-error']){
      const ui=screen();await loadPassage(ui);const key='words:w-0001';ui.get().JOB.review[key]={state:'pending',patch:{level:3},note:'기존 메모'};ui.renderJob();editRow(ui,key);wordInput(ui);wordSection(ui,'Conversation',true);
      const before=ui.requests.length,baseUpdatedAt=ui.get().JOB.updatedAt;let resolve;
      ui.setFetch(url=>url.endsWith('/job/review')?new Promise(r=>{resolve=r;}):response({error:'자체 재조회 실패'},500));
      const pending=ui.savePdfWord();assert.ok(ui.get().PDF_WORD_EDIT.busy);assert.ok(ui.node('#pdfWordFields').disabled);await ui.savePdfWord();assert.equal(ui.requests.length,before+1);
      resolve(phase==='get-error'?response({ok:true}):response({error:'자체 저장 실패'},phase==='conflict'?409:500));await pending;
      assert.equal(ui.get().EDIT,key);assert.equal(ui.node('#pdfWordHead').value,' own fixed word ');assert.equal(ui.node('#pdfWordPos').value,' adj. ');assert.equal(ui.node('#pdfWordMean').value,' 뜻 하나\n\n 뜻 둘 ');
      assert.ok(ui.node('#pdfWordConversation').checked);assert.ok(!ui.node('#pdfWordReading').checked);assert.ok(!ui.node('#pdfWordFields').disabled);assert.equal(ui.get().JOB.updatedAt,baseUpdatedAt);assert.equal(ui.get().JOB.review[key].note,'기존 메모');
      if(phase==='get-error')assert.match(ui.node('#bannerMsg').textContent,/저장은 끝났지만/);else{assert.equal(ui.get().JOB.review[key].state,'pending');assert.equal(ui.get().JOB.review[key].patch.level,3);}
    }
  });

  await t('로그아웃·인증 만료는 선택·원천·단어 버퍼까지 비우고 키보드로 이전 구매 후보를 되살리지 않는다',async()=>{
    for(const authFailure of [false,true]){
      const ui=screen();await loadPassage(ui);editRow(ui,'words:w-0001');wordInput(ui);wordSection(ui,'Reading',true);
      if(authFailure){ui.setFetch(()=>response({error:'자체 만료'},401));await ui.savePdfWord();}else{ui.setToken(null);ui.renderLogin();}
      const login=ui.node('#app').innerHTML,before=ui.requests.length;
      for(const key of ['j','e','a'])ui.events.get('keydown')({key,target:{tagName:'BODY'},preventDefault(){}});
      const state=ui.get();assert.equal(state.VIEW,'login');assert.equal(state.JOB,null);assert.equal(state.GATE,null);assert.equal(state.PDF_LOCAL,null);assert.equal(state.PDF_WORD_EDIT,null);assert.equal(state.SEL,null);assert.equal(state.EDIT,null);assert.deepEqual(clone(state.SRC),{});
      assert.equal(ui.node('#app').innerHTML,login);assert.equal(ui.requests.length,before);assert.ok(!login.includes('ownword'));
    }
  });

  await t('교사 핵심어는 빈 상태로 시작하고 직접 입력한 en/ko쌍만 후보에 넣으며 빈 추가행은 제외한다',async()=>{
    const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');
    assert.deepEqual(clone(ui.get().PDF_LOCAL.sentence.keywords),[{en:'',ko:''}]);assert.match(ui.node('#app').innerHTML,/영어 핵심어는 문장 안의 표현/);assert.match(ui.node('#app').innerHTML,/직독직해 청크 안의 표현/);
    keyword(ui,0,' blue ',' 파랗다 ');ui.node('#btnPdfKeywordAdd').onclick();const before=ui.requests.length;await ui.savePdfSentence();
    const body=JSON.parse(ui.requests.slice(before).find(r=>r.url.endsWith('/job/draft')).body),row=body.draft.sentences[0];
    assert.deepEqual(row.keywords,[{en:'blue',ko:'파랗다'}]);assert.deepEqual(row.chunks,[{en:'A toy is blue.',ko:'장난감은 파랗다.'}]);assert.equal(row.en,'A toy is blue.');
    assert.deepEqual(Object.keys(body.draft),['sentences']);assert.equal(ui.get().JOB.review['sentences:s1'],undefined);assert.ok(!/PRIVATE_TOKEN|LOCAL_SOURCE|UNSELECTED_EN/.test(JSON.stringify(body)));
  });

  await t('핵심어의 한쪽만 입력하면 문장과 입력을 유지하며 저장하지 않는다',async()=>{
    for(const values of [['blue',''],['','파랗다']]){
      const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');keyword(ui,0,...values);
      const before=ui.requests.length,form=JSON.stringify(ui.get().PDF_LOCAL.sentence);await ui.savePdfSentence();
      assert.equal(ui.requests.length,before+1);assert.equal(ui.requests.at(-1).url,'/api/health');assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);assert.match(ui.node('#pdfSentenceOut').textContent,/각 핵심어.*짝으로 입력/);
    }
  });

  await t('다른 줄 범위로 새 문장을 채우면 이전 청크·핵심어는 새 문장에 섞이지 않는다',async()=>{
    const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');keyword(ui,0,'blue','파랗다');ui.node('#btnPdfKeywordAdd').onclick();keyword(ui,1,'toy','장난감');
    pair(ui,'2','1','1','3','1','1');assert.equal(ui.get().PDF_LOCAL.sentence.en,'Go!');assert.equal(ui.get().PDF_LOCAL.sentence.ko,'가자!');
    assert.deepEqual(clone(ui.get().PDF_LOCAL.sentence.chunks),[{en:'',ko:''}]);assert.deepEqual(clone(ui.get().PDF_LOCAL.sentence.keywords),[{en:'',ko:''}]);
    assert.equal(ui.chunks('[data-pdf-keyword-en]')[0].value,'');assert.equal(ui.chunks('[data-pdf-keyword-ko]')[0].value,'');assert.equal(ui.chunks('[data-pdf-keyword-en]').length,1);
  });

  await t('본문 저장 충돌·실패·재조회 실패에도 교사가 입력한 핵심어쌍은 유지된다',async()=>{
    for(const phase of ['conflict','post-error','get-error']){
      const ui=screen();await loadPassage(ui);pair(ui);field(ui,'pdfSentenceDay','1');chunk(ui,0,'A toy is blue.','장난감은 파랗다.');keyword(ui,0,'blue','파랗다');
      const form=JSON.stringify(ui.get().PDF_LOCAL.sentence);ui.setFetch(url=>url.endsWith('/health')?response({localPdfReview:true}):url.endsWith('/job/draft')&&phase==='get-error'?response({ok:true}):response({error:'자체 저장·조회 오류'},phase==='conflict'?409:500));
      await ui.savePdfSentence();assert.equal(JSON.stringify(ui.get().PDF_LOCAL.sentence),form);assert.equal(ui.chunks('[data-pdf-keyword-en]')[0].value,'blue');assert.equal(ui.chunks('[data-pdf-keyword-ko]')[0].value,'파랗다');assert.ok(!ui.node('#pdfSentenceFields').disabled);
    }
  });

  await t('PDF 문장 메타는 일반 붙여넣기 경로와 경고 없는 일괄 승인을 통해 우회하지 않는다',async()=>{
    const ui=screen(),own=job();own.draft.sentences=[{seq:1,en:'Go!',ko:'가자!',dayGroup:'1',chunks:[{en:'Go!',ko:'가자!'}],_pdfReview:{flags:['REVIEW_REQUIRED'],locations:[{page:1,bbox:[1,2,3,4]}]}}];
    ui.setStored(own);ui.set(own);ui.renderJob();await ui.bulkOk();assert.equal(ui.requests.length,0);assert.match(ui.node('#app').innerHTML,/PDF 후보는 원본을 대조해 한 행씩 검수/);
    await ui.putDraft(JSON.stringify({sentences:own.draft.sentences}),'자체 문장');assert.equal(ui.requests.length,0);assert.match(ui.node('#draftOut').innerHTML,/로컬 검수 초안/);
  });
  console.log('통과 '+passed);
})().catch(e=>{console.error(e);process.exitCode=1;});
