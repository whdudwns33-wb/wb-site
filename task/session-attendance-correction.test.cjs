const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/index.html','utf8');
const source=html.slice(html.indexOf('function sessionAttendanceCorrectionButton'),html.indexOf('const SESSION_PACK_ATTENDANCE_CUTOFF_MINUTE'));
test('correction is offered only to managers for closed student session billing; ordinary and legacy actions stay locked',()=>{
 const c={session:{isAdmin:true},sessionPackAttendanceState:()=>({locked:true,rosterSession4:true}),isScheduledMakeupTask:()=>false,isSubscriptionSessionTask:()=>false,esc:String};
 vm.createContext(c);vm.runInContext(source,c);
 assert.match(c.sessionAttendanceCorrectionButton({id:'lesson-a'},'2026-08-01'),/출결 정정/);
 c.session.isAdmin=false;assert.equal(c.sessionAttendanceCorrectionButton({id:'a'},'2026-08-01'),'');
 c.session.isAdmin=true;c.sessionPackAttendanceState=()=>({locked:false,rosterSession4:true});assert.equal(c.sessionAttendanceCorrectionButton({id:'a'},'2026-08-01'),'');
 c.sessionPackAttendanceState=()=>({locked:true,pack:{}});assert.equal(c.sessionAttendanceCorrectionButton({id:'a'},'2026-08-01'),'');
 assert.ok(html.includes("case 'sessionattcorrect': await openSessionAttendanceCorrection(task(), date)"));
 assert.ok(html.includes("case 'sessionattcorrectsave': await saveSessionAttendanceCorrection(el)"));
 assert.ok(!html.includes('회차 출결 마감 · 관리자 정정 필요'));
});
