import {DOC_ID,json,fail,isPlainObject,readJson,loadDoc,changesOf,randomSlug,sha256Hex} from './crm-shared.mjs';
import {fetchSummary,portalId} from './portal-api.mjs';
import CORE from './crm-core.js';

export const CUSTOMER_APPS={
  manager:{name:'학원 총괄',url:'https://academy-manager.wbcowork.com/',resources:['attendance','charges','payments']},
  blended:{name:'블렌디드 학원',url:'https://blended-academy.wbcowork.com/ops/',resources:['attendance','checkins']},
  thinking:{name:'사고력 학원',url:'https://math.wbcowork.com/thinking/',resources:['lessons','checkins']},
  english:{name:'영어 학원',url:'https://aca.wbcowork.com/',resources:['attendance','charges','checkins']},
  reading:{name:'독해력 학원',url:'https://academy.wbcowork.com/ops/',resources:['attendance','checkins']},
  center:{name:'웩슬러브레인센터 · 포털',url:'https://portal.wbcowork.com/admin/',resources:[]}
};
const error=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
const keys=(b,allowed)=>isPlainObject(b)&&Object.keys(b).every(k=>allowed.includes(k));
const sourceId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(v);
const version=v=>Number.isSafeInteger(v)&&v>=0;
const clean=(v,max=100)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x1f<>]/.test(v);
const STATES=new Set(['출석','결석','지각','조퇴','공결','보강','예정','완료','재원','재학','휴원','퇴원','미등록','등록','대기','납부','미납','취소','수납','미수납','정상','active','inactive','enrolled','withdrawn','attended','present','absent','late','excused','paid','pending','cancelled','canceled','draft','unpaid','completed','scheduled','in','out']);
const viewMember=r=>({id:r.id,name:r.name,kind:r.kind,updatedAt:r.updated_at});
const viewLink=r=>({id:r.id,memberId:r.member_id,appId:r.app_id,sourceId:r.source_id,active:r.active===1,updatedAt:r.updated_at});
async function customerJson(env,url,key){
  if(typeof key!=='string'||key.length<32||key.length>512||/[\s]/.test(key))error('NOT_CONFIGURED',503);
  const response=await (typeof env.CUSTOMER_FETCH==='function'?env.CUSTOMER_FETCH:fetch)(url,{headers:{Authorization:'Bearer '+key,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(8000)});
  if(!response.ok){await response.body?.cancel();error(response.status===404?'SOURCE_NOT_FOUND':'SOURCE_UNAVAILABLE',502);}
  if(!response.headers.get('content-type')?.includes('application/json')){await response.body?.cancel();error('SOURCE_FORMAT',502);}
  const reader=response.body?.getReader();if(!reader)error('SOURCE_FORMAT',502);
  const chunks=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>262144)error('SOURCE_FORMAT',502);chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{error('SOURCE_FORMAT',502);}
}
async function academyRecords(env,appId,resource,args){
  const query=new URLSearchParams({resource,limit:'20',...args});
  const raw=await customerJson(env,'https://academy-api.wbcowork.com/v1/apps/'+appId+'/records?'+query,env.WB_ACADEMY_READ_KEY);
  if(raw.contractVersion!==1||raw.appId!==appId||raw.resource!==resource||raw.readOnly!==true||!Array.isArray(raw.items)||raw.items.length>20||!Number.isSafeInteger(raw.total)||raw.total<raw.items.length)error('SOURCE_FORMAT',502);
  for(const row of raw.items)if(row.appId!==appId||!sourceId(row.id)||args.id&&row.id!==args.id||args.studentId&&row.studentId!==args.studentId)error('SOURCE_SCOPE',502);
  return raw;
}
export async function readCustomerSource(env,appId,id){
  if(!Object.hasOwn(CUSTOMER_APPS,appId)||!sourceId(id)||appId==='center'&&!portalId(id))error('INVALID');
  const at=Date.now();
  if(appId==='center'){
    if(!env.WB_SALESDESK_READ_KEY)error('NOT_CONFIGURED',503);
    return {status:'connected',checkedAt:at,identityFingerprint:await sha256Hex('center:'+id),identityRequiresManualCheck:true,summary:await fetchSummary(env,id),url:'https://portal.wbcowork.com/admin/family/'+id};
  }
  const student=await academyRecords(env,appId,'students',{id});
  if(student.items.length!==1)error('SOURCE_NOT_FOUND',404);
  const row=student.items[0];if(!clean(row.name,80)||!row.name.trim()||!/^[\p{L}\p{M} .'-]+$/u.test(row.name)||row.synthetic===true)error('SOURCE_IDENTITY',422);
  const records={};
  // 원본별 최대20건만 읽는다. 총괄·하위의 금액과 인원은 합산하지 않는다.
  for(const resource of CUSTOMER_APPS[appId].resources){
    try{
      const result=await academyRecords(env,appId,resource,{studentId:id});
      const fields=['id','studentId','classId','date','status','direction','createdAt','updatedAt','checkedInAt','checkedOutAt','amount','total','dueDate','receivedDate','state'];
      records[resource]={status:'connected',total:result.total,more:result.total>result.items.length,items:result.items.map(r=>Object.fromEntries(fields.filter(k=>['string','number','boolean'].includes(typeof r[k])&&(typeof r[k]!=='string'||clean(r[k],160))&&(typeof r[k]!=='number'||Number.isFinite(r[k]))&&(!['status','state','direction'].includes(k)||STATES.has(r[k]))).map(k=>[k,r[k]])))};
    }catch{records[resource]={status:'unavailable'};}
  }
  return {status:'connected',checkedAt:at,identityFingerprint:await sha256Hex(JSON.stringify([appId,id,row.name,row.grade||''])),student:{id,name:row.name,grade:clean(row.grade,20)&&/^(?:유아|유치[0-9]?|예비초|초등|중등|고등|초[1-6]|중[1-3]|고[1-3]|성인|미정|[1-6]학년)?$/.test(row.grade)?row.grade:'',status:STATES.has(row.status)?row.status:''},records,url:CUSTOMER_APPS[appId].url};
}
async function readCs(env,contactId){
  if(typeof contactId!=='string'||!/^\d{1,19}$/.test(contactId))return {status:'unlinked'};
  try{
    const raw=await customerJson(env,'https://cs.wbcowork.com/api/customer-card?contactId='+contactId,env.WB_CS_READ_KEY);
    if(raw.contractVersion!==1||raw.contactId!==contactId||raw.readOnly!==true||!Array.isArray(raw.items)||raw.items.length>20||!Number.isSafeInteger(raw.total)||raw.total<0)error('SOURCE_FORMAT',502);
    const items=raw.items.map(r=>{
      if(!sourceId(r.id)||!clean(r.category,30)||!clean(r.stage,40)||!clean(r.organization,30)||!Number.isSafeInteger(r.createdAt)||r.createdAt<0||!Number.isFinite(new Date(r.createdAt).getTime()))error('SOURCE_FORMAT',502);
      return {id:r.id,category:r.category,stage:r.stage,organization:r.organization,createdAt:r.createdAt,priority:['urgent','high','normal','low'].includes(r.priority)?r.priority:'normal',dueDate:CORE.validYmd(r.dueDate)?r.dueDate:null,assigneeName:clean(r.assigneeName,40)&&/^[\p{L}\p{M} .'-]*$/u.test(r.assigneeName)?r.assigneeName:'',url:'https://cs.wbcowork.com/inbox/'+encodeURIComponent(r.id)};
    });
    return {status:'connected',items,total:raw.total,more:raw.total>items.length,scope:'guardian',checkedAt:Date.now()};
  }catch(e){return {status:e.code==='NOT_CONFIGURED'?'not_configured':'unavailable'};}
}
export async function handleCustomerCard(request,env,auth){
  if(auth.role!=='admin')return fail('FORBIDDEN','통합 고객 카드와 연결 관리는 원장 전용입니다',403);
  const url=new URL(request.url),path=url.pathname.replace(/\/+$/,''),method=request.method;
  if(!['/api/customer-card','/api/customer-card/member','/api/customer-card/link','/api/customer-card/source','/api/customer-card/resolve'].includes(path))return fail('NOT_FOUND','없는 고객 카드 주소입니다',404);
  if(method!=='GET'&&method!=='POST')return fail('METHOD','GET 또는 POST 요청이 필요합니다',405);
  if(method!==(['/api/customer-card/member','/api/customer-card/link'].includes(path)?'POST':'GET'))return fail('METHOD','허용되지 않는 요청 방식입니다',405);
  try{
    if(path==='/api/customer-card/resolve'){
      const appId=url.searchParams.get('appId'),source=url.searchParams.get('sourceId');
      if(method!=='GET'||url.searchParams.size!==2||!Object.hasOwn(CUSTOMER_APPS,appId)||!sourceId(source))error('INVALID');
      const row=await env.DB.prepare("SELECT s.lead_id,s.member_id FROM crm_customer_sources s JOIN crm_documents d ON d.collection='leads' AND d.id=s.lead_id AND d.deleted=0 WHERE s.app_id=? AND s.source_id=? AND s.active=1").bind(appId,source).first();
      if(!row)return fail('UNLINKED','아직 확인된 CRM 연결이 없습니다. 원장 계정에서 대상을 확인하고 연결해 주세요',404);
      return json({ok:true,leadId:row.lead_id,memberId:row.member_id});
    }
    const body=method==='POST'?await readJson(request):null,leadId=body?.leadId||url.searchParams.get('leadId');
    if(typeof leadId!=='string'||!DOC_ID.test(leadId))error('INVALID');
    const lead=await loadDoc(env,'leads',leadId);if(!lead)error('NOT_FOUND',404);
    if(path==='/api/customer-card/source'){
      if(method!=='GET'||[...url.searchParams.keys()].some(k=>!['leadId','appId','sourceId'].includes(k))||new Set(url.searchParams.keys()).size!==url.searchParams.size)error('INVALID');
      return json({ok:true,source:await readCustomerSource(env,url.searchParams.get('appId'),url.searchParams.get('sourceId'))});
    }
    if(path==='/api/customer-card/member'){
      if(method!=='POST'||!keys(body,['leadId','name','kind','requestId'])||!sourceId(body.requestId)||body.requestId.length>100||!clean(body.name,40)||!body.name.trim()||!/^[\p{L}\p{M} .'-]+$/u.test(body.name)||!['child','adult'].includes(body.kind))error('INVALID');
      const id='cm_'+body.requestId;
      const members=await env.DB.prepare('SELECT * FROM crm_customer_members WHERE lead_id=?').bind(leadId).all();
      const existing=members.results.find(r=>r.id===id);
      if(existing){if(existing.name!==body.name.trim()||existing.kind!==body.kind)error('STALE',409);return json({ok:true,member:viewMember(existing)});}
      if(members.results.length>=8)error('LIMIT',409);
      await env.DB.prepare("INSERT INTO crm_customer_members(id,lead_id,name,kind,updated_at,updated_by) SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM crm_customer_members WHERE lead_id=?)<8 AND EXISTS(SELECT 1 FROM crm_documents WHERE collection='leads' AND id=? AND deleted=0) ON CONFLICT(id) DO NOTHING").bind(id,leadId,body.name.trim(),body.kind,Date.now(),auth.staffId,leadId,leadId).run();
      const saved=await env.DB.prepare('SELECT * FROM crm_customer_members WHERE id=? AND lead_id=?').bind(id,leadId).first();
      if(!saved||saved.name!==body.name.trim()||saved.kind!==body.kind)error('STALE',409);
      return json({ok:true,member:viewMember(saved)});
    }
    if(path==='/api/customer-card/link'){
      if(method!=='POST'||!keys(body,['leadId','memberId','appId','sourceId','expectedUpdatedAt','identityConfirmed','active','identityFingerprint'])||!sourceId(body.memberId)||!Object.hasOwn(CUSTOMER_APPS,body.appId)||!sourceId(body.sourceId)||!version(body.expectedUpdatedAt)||typeof body.active!=='boolean'||body.identityConfirmed!==true||body.active&&!/^[a-f0-9]{64}$/.test(body.identityFingerprint||''))error('INVALID');
      const member=await env.DB.prepare('SELECT * FROM crm_customer_members WHERE id=? AND lead_id=?').bind(body.memberId,leadId).first();if(!member)error('NOT_FOUND',404);
      const old=await env.DB.prepare('SELECT * FROM crm_customer_sources WHERE app_id=? AND source_id=?').bind(body.appId,body.sourceId).first();
      if(old&&(old.lead_id!==leadId||old.member_id!==body.memberId&&old.active===1))error('ALREADY_LINKED',409);
      if(Number(old?.updated_at||0)!==body.expectedUpdatedAt)error('STALE',409);
      if(!old&&!body.active)error('INVALID');
      if(body.active&&(await readCustomerSource(env,body.appId,body.sourceId)).identityFingerprint!==body.identityFingerprint)error('STALE',409);
      const updatedAt=Math.max(Date.now(),body.expectedUpdatedAt+1);
      const guard="EXISTS(SELECT 1 FROM crm_documents WHERE collection='leads' AND id=? AND deleted=0)";
      const result=old?await env.DB.prepare('UPDATE crm_customer_sources SET active=?,member_id=?,updated_at=?,updated_by=? WHERE id=? AND updated_at=? AND (member_id=? OR active=0) AND '+guard).bind(body.active?1:0,body.memberId,updatedAt,auth.staffId,old.id,body.expectedUpdatedAt,body.memberId,leadId).run():await env.DB.prepare('INSERT INTO crm_customer_sources(id,lead_id,member_id,app_id,source_id,updated_at,updated_by) SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM crm_customer_sources WHERE lead_id=?)<48 AND '+guard+' ON CONFLICT(app_id,source_id) DO NOTHING').bind('cs_'+randomSlug(16),leadId,body.memberId,body.appId,body.sourceId,updatedAt,auth.staffId,leadId,leadId).run();
      if(!changesOf(result))error('STALE',409);
      return json({ok:true,link:viewLink(await env.DB.prepare('SELECT * FROM crm_customer_sources WHERE app_id=? AND source_id=?').bind(body.appId,body.sourceId).first())});
    }
    if(method!=='GET'||url.searchParams.size!==1||!url.searchParams.has('leadId'))error('INVALID');
    const members=(await env.DB.prepare('SELECT * FROM crm_customer_members WHERE lead_id=? ORDER BY updated_at,id').bind(leadId).all()).results.map(viewMember);
    const rows=(await env.DB.prepare('SELECT * FROM crm_customer_sources WHERE lead_id=? ORDER BY app_id,id').bind(leadId).all()).results;
    const sources=[];
    for(let i=0;i<rows.length;i+=3){const batch=await Promise.all(rows.slice(i,i+3).map(async row=>{
      const link=viewLink(row);if(!link.active)return {...link,status:'disconnected'};
      try{return {...link,...await readCustomerSource(env,row.app_id,row.source_id)};}catch(e){return {...link,status:e.code==='NOT_CONFIGURED'?'not_configured':'unavailable'};}
    }));sources.push(...batch);}
    return json({ok:true,readOnly:true,leadId,members,sources,apps:CUSTOMER_APPS,cs:await readCs(env,lead.data.hubspot?.contactId),checkedAt:Date.now()});
  }catch(e){const code=['INVALID','NOT_FOUND','STALE','ALREADY_LINKED','LIMIT','NOT_CONFIGURED','SOURCE_NOT_FOUND','SOURCE_IDENTITY','SOURCE_FORMAT','SOURCE_SCOPE','SOURCE_UNAVAILABLE'].includes(e.code)?e.code:'SOURCE_UNAVAILABLE';return fail(code,{INVALID:'입력과 원본 확인 체크를 다시 확인해 주세요',NOT_FOUND:'고객 또는 자녀를 찾지 못했습니다',STALE:'연결이 바뀌었거나 저장 결과를 확인해야 합니다. 다시 조회해 주세요',ALREADY_LINKED:'이미 다른 고객 또는 자녀에 연결된 원본입니다',NOT_CONFIGURED:'조회 연결 인증이 아직 준비되지 않았습니다'}[code]||'원본을 확인하지 못했습니다. 저장 여부를 재조회해 주세요',e.status||502);}
}
