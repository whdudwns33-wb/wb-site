import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('./app.html',import.meta.url),'utf8');
test('withdraw and return preserve counseling records and retain history',()=>{
 const student={id:'fixture',grade:'중3',records:[{text:'synthetic'}],grades:[{score:0}],notes:'keep'};
 const original=structuredClone(student);let saves=0,allowed=true;
 const ctx=vm.createContext({stu:()=>student,confirm:()=>allowed,today:()=> '2026-10-29',save:()=>saves++,render:()=>{}});
 vm.runInContext(html.slice(html.indexOf('function setEnrollment('),html.indexOf('function upStu(')),ctx);
 ctx.setEnrollment(true);assert.equal(student.enrollmentStatus,'withdrawn');assert.equal(saves,1);
 for(const key of Object.keys(original))assert.deepEqual(student[key],original[key]);
 ctx.setEnrollment(false);assert.equal(student.enrollmentStatus,'active');assert.equal(student.enrollmentHistory.length,2);
 allowed=false;ctx.setEnrollment(true);assert.equal(saves,2);assert.equal(student.enrollmentStatus,'active');
});
test('middle-school registration and withdrawn archive are reachable',()=>{
 assert.ok(html.includes('const grades=["고3","고2","고1","중3","퇴원"]'));
 assert.ok(html.includes('<select id=ns_grade><option>중3</option>'));
 assert.ok(html.includes('["중3","고1","고2","고3"].map'));
 assert.ok(html.includes('const students=db.students.filter(s=>s.enrollmentStatus!=="withdrawn")'));
});
