import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,seedDemo} from './local-db.mjs';
import {createApi} from './api.mjs';
import {createLocalServer} from './server.mjs';

test('학원 전용 읽기 인증·활성 학생·최소 응답·브라우저/크기 경계',async t=>{
 const db=openDatabase();seedDemo(db);t.after(()=>db.close());
 const key='a'.repeat(64),api=createApi(db,{academyBridgeKey:key});
 for(const invalid of ['',undefined,'b'.repeat(64)])assert.throws(()=>api.academy({action:'students'},invalid),e=>e.status===403);
 assert.throws(()=>createApi(db).academy({action:'students'},''),e=>e.status===403);
 const students=api.academy({action:'students'},key).students;
 assert.deepEqual(students.map(s=>Object.keys(s)),[['id','name'],['id','name']]);
 assert.deepEqual(api.academy({action:'student',studentId:'student-b'},key),{student:students.find(s=>s.id==='student-b')});
 assert.throws(()=>api.academy({action:'student',studentId:'unknown'},key),e=>e.status===404);
 assert.throws(()=>api.academy({action:'perform',studentId:'student-a'},key),e=>e.status===400);
 db.prepare("UPDATE users SET active=0 WHERE id='student-b'").run();
 assert.throws(()=>api.academy({action:'student',studentId:'student-b'},key),e=>e.status===404);
 const server=createLocalServer(db,{academyBridgeKey:key});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`,call=(body,headers={})=>fetch(base+'/blended/academy-api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key,...headers},body:JSON.stringify(body)});
 assert.equal((await call({action:'students'})).status,200);
 assert.equal((await call({action:'students'},{Origin:'https://blended-academy.wbcowork.com'})).status,403);
 assert.equal((await call({action:'students'},{Authorization:'Bearer wrong'})).status,403);
 assert.equal((await call({action:'students',large:'x'.repeat(5000)})).status,413);
 assert.equal((await fetch(base+'/blended/academy-api')).status,403);
});
