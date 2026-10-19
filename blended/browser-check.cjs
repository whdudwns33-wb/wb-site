'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

(async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const {openDatabase,seedDemo}=await import('./local-db.mjs');
  const {createLocalServer}=await import('./server.mjs');
  const db=openDatabase();seedDemo(db);const server=createLocalServer(db);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try {browser=await chromium.launch({headless:true,channel:'chromium',chromiumSandbox:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});}
  catch(error){await new Promise(resolve=>server.close(resolve));db.close();throw error;}
  const evidence=path.join(__dirname,'evidence');fs.mkdirSync(evidence,{recursive:true});
  const errors=[];
  async function login(id,size={width:1365,height:1000}){
    const context=await browser.newContext({viewport:size});
    await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/blended/#/learning');
    await page.getByLabel('아이디',{exact:true}).fill(id);await page.getByLabel('비밀번호',{exact:true}).fill(`Demo-${id}-2026!`);
    await page.getByRole('button',{name:'로그인',exact:true}).click();
    await page.waitForSelector('#identity button');return page;
  }
  const save=async page=>{await page.locator('dialog button[type=submit]').click();await page.waitForSelector('dialog[open]',{state:'hidden'});};
  const rpc=async(page,action,payload={},requestId=crypto.randomUUID())=>{
    const r=await page.request.post(origin+'/blended/api',{headers:{'X-Blended-Request':'1'},data:{app:'blended',action,payload,requestId}});return r.json();
  };
  try{
    const teacher=await login('teacher-a');
    assert.equal(await teacher.getByText('가상 학생 B',{exact:true}).count(),0);
    await teacher.getByRole('button',{name:'학습 배정',exact:true}).click();
    await teacher.getByLabel('교재·범위·해야 할 일').fill('개념을 읽고 풀이 두 개 설명하기');await save(teacher);
    const student=await login('student-a',{width:820,height:1180});
    await student.getByRole('button',{name:'완료·질문 남기기'}).first().click();
    await student.getByLabel('학습을 마쳤어요').check();await student.getByLabel('질문·도움 요청').fill('계산 순서를 다시 확인하고 싶어요.');await save(student);
    await teacher.getByRole('button',{name:'최신 내용 확인'}).click();
    await teacher.getByRole('button',{name:'학습 확인',exact:true}).first().click();
    await teacher.getByLabel('확인한 내용과 피드백').fill('설명한 풀이 순서를 함께 확인했어요.');await save(teacher);
    await teacher.screenshot({path:path.join(evidence,'desktop-teacher.png'),fullPage:true});
    await student.getByRole('button',{name:'이번 주',exact:true}).click();
    await student.screenshot({path:path.join(evidence,'tablet-student.png'),fullPage:true});
    await teacher.getByRole('button',{name:'상담·약속',exact:true}).click();
    await teacher.getByRole('button',{name:'상담 준비',exact:true}).click();
    await teacher.getByRole('button',{name:'학습 사실 불러오기'}).click();
    await teacher.locator('#summary-preview .summary').waitFor();
    await teacher.getByLabel('내부 메모 · 강사와 운영 담당만 열람').fill('SYNTHETIC_PRIVATE_NEVER_PUBLIC');
    await teacher.getByLabel('함께 확인한 점').fill('분수 개념을 자신의 말로 설명했습니다.');
    await teacher.getByLabel('다음 지도 방향').fill('풀이 순서를 짧은 문장으로 적어 봅니다.');
    await teacher.getByLabel('다음 실천 목표',{exact:true}).fill('풀이 두 개를 설명하며 다시 풀기');await save(teacher);
    await teacher.getByRole('button',{name:'상담 완료·약속 연결'}).click();
    await teacher.getByRole('button',{name:'리포트 검토 요청'}).click();
    await teacher.getByText('검토 대기',{exact:true}).waitFor();
    const owner=await login('owner');
    await owner.getByRole('button',{name:'리포트',exact:true}).click();
    await owner.getByRole('button',{name:'발행 검토'}).click();
    assert.equal(await owner.locator('dialog').getByText('SYNTHETIC_PRIVATE_NEVER_PUBLIC').count(),0);
    await owner.getByRole('button',{name:'공개본 발행',exact:true}).click();
    await owner.waitForSelector('dialog[open]',{state:'hidden'});
    const guardian=await login('guardian-a',{width:390,height:844});
    await guardian.getByRole('button',{name:'공개본 보기'}).click();
    await guardian.screenshot({path:path.join(evidence,'phone-guardian.png'),fullPage:true});
    assert.equal(await guardian.locator('body').getByText('SYNTHETIC_PRIVATE_NEVER_PUBLIC').count(),0);
    for(const page of [teacher,student,guardian]) assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
    await guardian.getByRole('button',{name:'닫기',exact:true}).click();
    await owner.getByRole('button',{name:'강사·담당 관리'}).click();
    await owner.getByRole('button',{name:'강사 추가',exact:true}).click();
    await owner.getByLabel('표시 이름',{exact:true}).fill('가상 새 강사');await owner.getByLabel('개별 로그인 아이디').fill('teacher-new');
    await owner.getByLabel('개별 로그인 비밀번호').fill('Synthetic-new-password!');await save(owner);
    await owner.getByRole('button',{name:'담당 배정',exact:true}).click();
    await owner.locator('dialog select[name=teacherId]').selectOption({label:'가상 새 강사'});await save(owner);
    await owner.getByText('가상 새 강사',{exact:true}).first().waitFor();
    // 네트워크 실패와 충돌에서도 실제 입력을 보존하는지 확인한다.
    await student.getByRole('button',{name:'오늘 학습',exact:true}).click();
    await student.getByRole('button',{name:'완료·질문 남기기'}).first().click();
    await student.getByLabel('질문·도움 요청').fill('네트워크 오류에서도 남을 질문');
    await student.route('**/blended/api',route=>route.abort());
    await student.locator('dialog button[type=submit]').click();
    await student.locator('dialog .error-box').getByText(/연결하지 못했습니다/).waitFor();
    assert.equal(await student.getByLabel('질문·도움 요청').inputValue(),'네트워크 오류에서도 남을 질문');
    await student.unroute('**/blended/api');
    const state=await rpc(student,'state'),l=state.learning[0];
    await rpc(student,'perform',{id:l.id,revision:l.revision,done:true,question:'다른 창의 최신 기록'});
    await student.locator('dialog button[type=submit]').click();
    await student.locator('dialog .error-box').getByText(/다른 화면에서 변경/).waitFor();
    assert.equal(await student.getByLabel('질문·도움 요청').inputValue(),'네트워크 오류에서도 남을 질문');
    await student.keyboard.press('Escape');
    await owner.getByRole('button',{name:'가상 동의 철회'}).first().click();
    await guardian.getByRole('button',{name:'최신 내용 확인'}).click();
    await guardian.getByText('현재 열람할 수 있는 발행 리포트가 없습니다.').waitFor();
    await teacher.getByRole('button',{name:'담당 학습',exact:true}).click();
    await teacher.getByRole('button',{name:'학습 배정',exact:true}).click();
    await teacher.getByLabel('교재·범위·해야 할 일').fill('긴 제목 '.repeat(30));
    await save(teacher);
    await teacher.setViewportSize({width:390,height:844});
    assert.ok(await teacher.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await teacher.screenshot({path:path.join(evidence,'phone-learning.png'),fullPage:true});
    await teacher.getByRole('button',{name:'학습 배정',exact:true}).click();
    await teacher.keyboard.press('Tab');
    assert.equal(await teacher.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),true);
    await teacher.keyboard.press('Escape');
    for(const page of [teacher,student,owner,guardian]) assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage)),[]);
    assert.deepEqual(errors,[]);
    console.log('PASS browser: assignment → performance → check → counseling → promise → publication → guardian; registration/assignment; consent revocation; failed save/conflict; keyboard; 1365/820/390px; zero page errors');
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
