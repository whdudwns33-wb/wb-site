const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/index.html','utf8');
const method=html.match(/async post\(path, body, isCurrent\) \{[\s\S]*?\n  \},/)[0].replace(/,$/,'');
test('원생 조회 403은 로그인·기기 연결을 유지하고 실제 인증 거절만 정리한다',async()=>{
 for(const [status,code,rejected] of [[403,'STUDENT_ATTENDANCE_FORBIDDEN',false],[403,'',false],[401,'',true],[403,'PERSON_AUTH_REJECTED',true],[403,'TOKEN_REVOKED',true],[500,'',false]]){
  let resets=0;const context={shouldGateStaffWork:()=>false,SYNC_URL:'https://example.test',fetch:async()=>({status,json:async()=>({ok:false,code,error:'조회 실패'})}),session:{isStaffLink:true},staffWorkCore:{isLoginRequired:()=>false},handlePersonAuthRejection:()=>resets++,clearTimeout,Error};
  const post=vm.runInNewContext('({'+method+'}).post',context);
  await assert.rejects(post.call({},'/student-attendance',{auth:{mode:'person'}}));assert.equal(resets,rejected?1:0,status+':'+code);
 }
});
