import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createApi } from './api.mjs';
import { openDatabase, seedDemo } from './local-db.mjs';
import { plannerAssets } from './planner-build.mjs';
import {startHandoff,handoffCookie,handoffNonce} from './academy-handoff.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/blended/navigation.js', ['navigation.js','text/javascript']], ['/blended/ui.css', ['ui.css','text/css']],
  ['/blended/', ['index.html','text/html']], ['/blended/guardian/', ['index.html','text/html']],
  ['/blended/app.js', ['app.js','text/javascript']], ['/blended/style.css', ['style.css','text/css']],
  ['/blended/external-links.js', ['../shared/external-links.js','text/javascript']]
]);
const cookie = (token = '') => `wb_blended_local=${token}; Path=/blended/; HttpOnly; SameSite=Strict; Max-Age=${token ? 28800 : 0}`;
export function createLocalServer(db,options = {}) {
  const api = createApi(db,options);
  const planner=plannerAssets();
  const server = http.createServer(async (req,res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'X-Robots-Tag':'noindex, nofollow',
      'Referrer-Policy':'no-referrer', 'Content-Security-Policy':"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    };
    const send = (status,body,extra = {}) => { res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8',...extra}); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try {
      if (req.headers.host !== new URL(origin).host) return send(403,{code:'HOST',error:'로컬 전용 주소로 접속해 주세요.'});
      const url = new URL(req.url,origin);
      if(url.pathname==='/blended/academy-start'&&req.method==='GET') {
        const start=startHandoff(url,options.academyOrigin || 'http://localhost:8904',false);if(!start)return send(400,{code:'SSO_STATE'});
        return send(302,'',{Location:start.location,'Set-Cookie':start.cookie});
      }
      if(url.pathname==='/blended/academy-entry/')url.pathname='/blended/';
      if(url.pathname.startsWith('/blended/planner/')) {
        const name=url.pathname.slice('/blended/planner/'.length) || 'index.html';
        if(!Object.hasOwn(planner,name) || !['GET','HEAD'].includes(req.method))return send(404,{code:'NOT_FOUND'});
        const type=name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html';
        res.writeHead(200,{...headers,'Content-Type':type+'; charset=utf-8','Content-Security-Policy':headers['Content-Security-Policy'].replace("style-src 'self'","style-src 'self' 'unsafe-inline'")});return res.end(req.method==='HEAD'?undefined:planner[name]);
      }
      if (url.pathname === '/' || url.pathname === '/blended') return send(302,'',{Location:'/blended/'});
      if(['/blended/academy-api','/blended/academy-auth','/blended/academy-exchange'].includes(url.pathname)) {
        if(url.pathname==='/blended/academy-exchange') {
          if(req.method!=='POST'||req.headers.origin!==origin||req.headers['x-blended-request']!=='1'||!String(req.headers['content-type']).startsWith('application/json'))return send(403,{code:'ORIGIN'});
          let input='';for await(const chunk of req){input+=chunk;if(Buffer.byteLength(input)>4096)return send(413,{code:'SIZE'});}
          const result=api.exchange(JSON.parse(input).ticket,handoffNonce(req.headers.cookie || '',false));
          return send(200,{studentId:result.studentId},{'Set-Cookie':[cookie(result.sessionToken),handoffCookie('',false)]});
        }
        if(req.method!=='POST'||req.headers.origin||!String(req.headers['content-type']).startsWith('application/json'))return send(403,{code:'BRIDGE_ORIGIN'});
        let input='';for await(const chunk of req){input+=chunk;if(Buffer.byteLength(input)>4096)return send(413,{code:'SIZE'});}
        let data;try{data=JSON.parse(input);}catch{return send(400,{code:'JSON'});}
        return send(200,{ok:true,...api[url.pathname.endsWith('academy-auth')?'academyAuth':'academy'](data,req.headers.authorization?.replace(/^Bearer /,''))});
      }
      if (url.pathname !== '/blended/api') {
        const asset = files.get(url.pathname);
        if (!asset || !['GET','HEAD'].includes(req.method)) return send(404,{code:'NOT_FOUND'});
        const content = readFileSync(path.join(here,asset[0]));
        res.writeHead(200,{...headers,'Content-Type':asset[1]+'; charset=utf-8'}); return res.end(req.method === 'HEAD' ? undefined : content);
      }
      if (req.method !== 'POST' || req.headers.origin && req.headers.origin !== origin || req.headers['x-blended-request'] !== '1' || !String(req.headers['content-type']).startsWith('application/json')) return send(403,{code:'ORIGIN',error:'허용되지 않은 요청입니다.'});
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1048576) { send(413,{code:'SIZE',error:'입력 크기를 줄여 주세요.'}); req.resume(); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return send(400,{code:'JSON',error:'요청 형식을 확인해 주세요.'}); }
      if(size>32768 && body.action!=='planner_save')return send(413,{code:'SIZE',error:'입력 크기를 줄여 주세요.'});
      const token = /(?:^|;\s*)wb_blended_local=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1] || '';
      const result = api.handle(body,token), extra = {};
      if (result.sessionToken) { extra['Set-Cookie'] = cookie(result.sessionToken); delete result.sessionToken; }
      if (result.loggedOut) extra['Set-Cookie'] = cookie();
      send(200,{ok:true,...result},extra);
    } catch (error) {
      // DB 오류나 상담 원문을 응답·로그에 내보내지 않는다.
      send(error.status || 503,{code:error.code || 'SAVE_FAILED',error:error.status ? error.message : '저장하지 못했습니다. 입력을 보존했습니다. 잠시 후 다시 시도해 주세요.'},error.status === 401 ? {'Set-Cookie':cookie()} : {});
    }
  });
  server.requestTimeout = 15000;
  return server;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.BLENDED_PORT || 8896);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('BLENDED_PORT must be 1024..65535');
  mkdirSync(path.join(here,'.local'),{recursive:true});
  const db = openDatabase(path.join(here,'.local','blended-demo.sqlite'));
  seedDemo(db);
  const server = createLocalServer(db);
  server.listen(port,'127.0.0.1',() => console.log(`블렌디드 가상 자료 전용: http://127.0.0.1:${port}/blended/ (외부 연동·발송 비활성)`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => server.close(() => {db.close(); process.exit(0);}));
}
