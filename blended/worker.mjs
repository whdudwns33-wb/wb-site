import { DurableObject } from 'cloudflare:workers';
import { createApi } from './api.mjs';
import schema from './schema.sql';
import {startHandoff,handoffCookie,handoffNonce} from './academy-handoff.mjs';

const security={
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow',
  'Referrer-Policy':'no-referrer','Strict-Transport-Security':'max-age=31536000',
  'Content-Security-Policy':"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
const sessionCookie=(token='')=>`__Host-wb_blended=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${token?28800:0}`;
const json=(status,body,extra={})=>new Response(JSON.stringify(body),{status,headers:{...security,'Content-Type':'application/json; charset=utf-8',...extra}});
export class BlendedPlanner extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    ctx.storage.sql.exec(schema);
    const db={prepare:sql=>({
      get:(...args)=>ctx.storage.sql.exec(sql,...args).toArray()[0],
      all:(...args)=>ctx.storage.sql.exec(sql,...args).toArray(),
      run:(...args)=>{const cursor=ctx.storage.sql.exec(sql,...args);return {changes:cursor.rowsWritten};}
    })};
    this.api=createApi(db,{mode:'production',ownerLogin:env.OWNER_LOGIN,bootstrapToken:env.BOOTSTRAP_TOKEN,academyBridgeKey:env.ACADEMY_BRIDGE_KEY,academyAuthKey:env.ACADEMY_AUTH_KEY,transaction:fn=>ctx.storage.transactionSync(fn)});
  }
  async fetch(request) {
    try {
      let size=0;const chunks=[],reader=request.body?.getReader();
      if(!reader)return json(400,{code:'INPUT',error:'요청 내용을 확인해 주세요.'});
      while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576){await reader.cancel();return json(413,{code:'SIZE',error:'입력 크기를 줄여 주세요.'});}chunks.push(value);}
      let body;
      try{body=JSON.parse(await new Blob(chunks).text());}catch{return json(400,{code:'JSON',error:'요청 형식을 확인해 주세요.'});}
      if(body.action==='report_layout_save' && size>262144)return json(413,{code:'SIZE'});
      if(size>32768 && !['planner_save','report_layout_save'].includes(body.action))return json(413,{code:'SIZE',error:'입력 크기를 줄여 주세요.'});
      if(new URL(request.url).pathname==='/blended/academy-api') {if(size>4096)return json(413,{code:'SIZE'});return json(200,{ok:true,...this.api.academy(body,request.headers.get('Authorization')?.replace(/^Bearer /,''))});}
      if(new URL(request.url).pathname==='/blended/academy-auth') {if(size>4096)return json(413,{code:'SIZE'});return json(200,this.api.academyAuth(body,request.headers.get('Authorization')?.replace(/^Bearer /,'')));}
      if(new URL(request.url).pathname==='/blended/academy-exchange') {
        if(size>4096)return json(413,{code:'SIZE'});
        const result=this.api.exchange(body.ticket,handoffNonce(request.headers.get('Cookie') || ''));
        const response=json(200,{studentId:result.studentId},{'Set-Cookie':sessionCookie(result.sessionToken)});response.headers.append('Set-Cookie',handoffCookie());return response;
      }
      const token=/(?:^|;\s*)__Host-wb_blended=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('Cookie')||'')?.[1]||'';
      const result=this.api.handle(body,token,request.headers.get('CF-Connecting-IP')||'unknown'),extra={};
      if(result.sessionToken){extra['Set-Cookie']=sessionCookie(result.sessionToken);delete result.sessionToken;}
      if(result.loggedOut)extra['Set-Cookie']=sessionCookie();
      return json(200,{ok:true,...result},extra);
    }catch(error){return json(error.status||503,{code:error.code||'SAVE_FAILED',error:error.status?error.message:'저장하지 못했습니다. 입력을 보존했습니다. 다시 시도해 주세요.'},error.status===401?{'Set-Cookie':sessionCookie()}:{});}
  }
}
export default {
  async fetch(request,env){
    const url=new URL(request.url),origin=env.PUBLIC_ORIGIN;
    if(url.origin!==origin)return json(403,{code:'HOST',error:'전용 서비스 주소로 접속해 주세요.'});
    if(url.pathname==='/'||url.pathname==='/blended')return new Response(null,{status:302,headers:{...security,Location:origin+'/blended/'}});
    if(url.pathname==='/blended/academy-start'&&request.method==='GET'){
      const start=startHandoff(url,'https://blended-academy.wbcowork.com');if(!start)return json(400,{code:'SSO_STATE'});
      return new Response(null,{status:302,headers:{...security,Location:start.location,'Set-Cookie':start.cookie}});
    }
    if(['/blended/academy-api','/blended/academy-auth'].includes(url.pathname)){
      if(request.method!=='POST'||request.headers.has('Origin')||!request.headers.get('Content-Type')?.startsWith('application/json'))return json(403,{code:'BRIDGE_ORIGIN'});
      return env.PLANNER.get(env.PLANNER.idFromName('blended-production-v1')).fetch(request);
    }
    if(['/blended/api','/blended/academy-exchange'].includes(url.pathname)){
      if(request.method!=='POST'||request.headers.get('Origin')!==origin||request.headers.get('X-Blended-Request')!=='1'||!request.headers.get('Content-Type')?.startsWith('application/json'))return json(403,{code:'ORIGIN',error:'허용되지 않은 요청입니다.'});
      return env.PLANNER.get(env.PLANNER.idFromName('blended-production-v1')).fetch(request);
    }
    if(url.pathname==='/blended/academy-entry/')url.pathname='/blended/';
    if(url.pathname==='/blended/reports/'||/^\/blended\/reports\/(?:[A-Za-z0-9_.-]+\.(?:js|css|ttf|txt)|vendor\/pdfium\.esm\.wasm)$/.test(url.pathname)) {
      if(!['GET','HEAD'].includes(request.method))return json(404,{code:'NOT_FOUND'});
      if(url.pathname==='/blended/reports/')url.pathname+='index.html';
      const asset=await env.ASSETS.fetch(new Request(url,{method:request.method})),headers=new Headers(asset.headers);for(const [key,value]of Object.entries(security))headers.set(key,value);
      headers.set('Content-Security-Policy',security['Content-Security-Policy'].replace("style-src 'self'","style-src 'self' 'unsafe-inline'; font-src 'self' data: blob:").replace("script-src 'self'","script-src 'self' 'wasm-unsafe-eval'"));
      if(url.pathname.endsWith('.ttf'))headers.set('Cache-Control','public, max-age=31536000, immutable');
      return new Response(asset.body,{status:asset.status,headers});
    }
    if(!['GET','HEAD'].includes(request.method)||!['/blended/','/blended/guardian/','/blended/app.js','/blended/style.css','/blended/ui.css','/blended/navigation.js','/blended/external-links.js','/blended/planner/','/blended/planner/planner.js','/blended/planner/planner.css','/blended/planner/qr.js'].includes(url.pathname))return json(404,{code:'NOT_FOUND'});
    const isPlanner=url.pathname.startsWith('/blended/planner/');
    if(url.pathname==='/blended/planner/')url.pathname='/blended/planner/index.html';
    if(url.pathname==='/blended/'||url.pathname==='/blended/guardian/')url.pathname='/blended/index.html';
    const asset=await env.ASSETS.fetch(new Request(url,{method:request.method}));
    const headers=new Headers(asset.headers);for(const [key,value]of Object.entries(security))headers.set(key,value);
    if(isPlanner)headers.set('Content-Security-Policy',security['Content-Security-Policy'].replace("style-src 'self'","style-src 'self' 'unsafe-inline'"));
    return new Response(asset.body,{status:asset.status,headers});
  }
};
