const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
  const {openDatabase,seedDemo}=await import('./local-db.mjs');const {createLocalServer}=await import('./server.mjs');
  const db=openDatabase();seedDemo(db);const server=createLocalServer(db);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const errors=[],requests=[];const evidence=path.join(__dirname,'evidence');fs.mkdirSync(evidence,{recursive:true});
  async function login(id,size={width:1365,height:1000}) {
    const context=await browser.newContext({viewport:size});await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
    page.on('dialog',d=>d.accept());await page.goto(origin+'/blended/');
    await page.getByLabel('아이디',{exact:true}).fill(id);await page.getByLabel('비밀번호',{exact:true}).fill(`Demo-${id}-2026!`);await page.getByRole('button',{name:'로그인',exact:true}).click();
    await page.waitForURL('**/blended/planner/');await page.locator('#tabs button').first().waitFor();return page;
  }
  async function synced(page) {await page.waitForFunction(()=>blendedLoaded && !sync.busy && !sync.dirty && !sync.err,null,{timeout:15000});}
  const click=async(page,act)=>page.locator(`button[data-act="${act}"]`).first().click();
  try {
    const owner=await login('owner'),student=await login('student-a',{width:390,height:844}),teacher=await login('teacher-a',{width:820,height:1180});
    for(const page of [owner,student,teacher]) {assert.ok(await page.getByRole('button',{name:'일정·학사',exact:true}).count());assert.equal(await page.locator('#tabs [data-go="academic"]').count(),0);}
    await owner.getByRole('button',{name:'일정·학사',exact:true}).click();await owner.getByRole('button',{name:'시험·수행평가·자료 요청',exact:true}).click();
    await click(owner,'acadadd');await owner.locator('#academicTitle').fill('가상 중간시험');await owner.locator('#academicSubject').selectOption('math');
    for(const [id,value] of [['academicGrade','중2'],['academicUnit','일차함수'],['academicRange','교과서 10~30쪽']])await owner.locator('#'+id).fill(value);
    await owner.locator('#academicSemester').selectOption({index:1});
    await owner.locator('#academicDate').fill(new Date(Date.now()+7*86400000).toISOString().slice(0,10));
    await click(owner,'academicsave');await synced(owner);
    assert.ok(await owner.getByText('가상 중간시험',{exact:true}).count());
    await owner.reload();await owner.locator('#tabs button').first().waitFor();assert.ok(await owner.getByText('가상 중간시험',{exact:true}).count());
    // 원본 편집기에서 공부 추가, 학생 체크, 강사 확인까지 저장 경계를 왕복한다.
    await owner.getByRole('button',{name:'오늘',exact:true}).click();
    await owner.evaluate(()=>editTaskModal(null));await owner.locator('#eSubject').selectOption('math');await owner.locator('#eTitle').fill('원본 플래너에서 배정한 가상 공부');await click(owner,'esave');await synced(owner);
    await student.reload();await student.locator('#tabs button').first().waitFor();
    const newTask=await student.evaluate(()=>state.tasks.find(t=>t.title==='원본 플래너에서 배정한 가상 공부')?.id);assert.ok(newTask);
    await student.locator('[data-act="todayfold"][data-section="studyOffers"]').click();
    await student.locator(`[data-act="studyclaim"][data-id="${newTask}"]`).click();await synced(student);
    await student.locator(`[data-act="toggle"][data-id="${newTask}"]`).first().click();await synced(student);
    await teacher.reload();await teacher.locator('#tabs button').first().waitFor();
    await teacher.locator(`[data-blended="check"][data-id="${newTask}"]`).click();await teacher.locator('#blendedFeedback').fill('풀이와 설명 확인');await teacher.locator('[data-blended="checksave"]').click();await synced(teacher);
    await student.reload();await student.locator('#tabs button').first().waitFor();assert.equal(await student.evaluate(id=>getCheck(id,today()).checked,newTask),true);
    await owner.getByRole('button',{name:'로드맵',exact:true}).click();await click(owner,'roadmapopen');
    await owner.locator('#roadmapTargetSchool').fill('가상 목표 학교');await click(owner,'roadmaptargetsave');await synced(owner);
    await click(owner,'roadmapbookadd');await owner.locator('#roadmapSubject').selectOption('math');await owner.locator('#roadmapBook').fill('가상 교재');
    await owner.locator('#roadmapRangeStart').fill('1');await owner.locator('#roadmapRangeEnd').fill('20');await click(owner,'roadmapbooksave');await synced(owner);
    assert.ok(await owner.evaluate(()=>state.tasks.some(t=>t.auto==='study-roadmap-v1')));await click(owner,'closemodal');
    await teacher.getByRole('button',{name:'인강',exact:true}).click();await click(teacher,'ingadd');
    await teacher.locator('#ingSubject').selectOption('math');await teacher.locator('#ingName').fill('가상 개념 강좌');await teacher.locator('#ingText').fill('1. 개념 정리 30분\n2. 예제 연습 40분');
    await click(teacher,'ingsave');await synced(teacher);
    await teacher.reload();await teacher.locator('#tabs button').first().waitFor();assert.ok(await teacher.getByText('가상 개념 강좌',{exact:true}).count());
    await student.getByRole('button',{name:'주간',exact:true}).click();await click(student,'weekgoal');await student.locator('[data-weekgoal="math"]').fill('120');await click(student,'weekgoalsave');await synced(student);
    await student.getByRole('button',{name:'학습',exact:true}).click();await student.waitForFunction(()=>submissionCache.loaded && !submissionCache.loading);
    await student.locator('details').filter({has:student.locator('[data-act="submissionquestion"]')}).locator('summary').click();
    await click(student,'submissionquestion');await student.locator('#submissionSubject').selectOption('math');await student.locator('#submissionText').fill('가상 수학 질문입니다.');await click(student,'submissionsubmit');
    await student.getByText('가상 수학 질문입니다.',{exact:false}).first().waitFor();
    await owner.reload();await owner.locator('#tabs button').first().waitFor();await owner.getByRole('button',{name:'주간',exact:true}).click();await click(owner,'reportpublish');await synced(owner);
    const guardianContext=await browser.newContext();const guardian=await guardianContext.newPage();await guardian.goto(origin+'/blended/');
    await guardian.getByLabel('아이디',{exact:true}).fill('guardian-a');await guardian.getByLabel('비밀번호',{exact:true}).fill('Demo-guardian-a-2026!');await guardian.getByRole('button',{name:'로그인',exact:true}).click();
    await guardian.getByRole('button',{name:'공개 학습 리포트 보기'}).click();await guardian.getByRole('heading',{name:'공개 학습 리포트',exact:true}).waitFor();
    await teacher.getByRole('link',{name:'상담·리포트',exact:true}).click();await teacher.locator('#student-filter').waitFor();assert.equal(await teacher.locator('#student-filter').inputValue(),'student-a');
    await teacher.getByRole('link',{name:'전체 플래너',exact:true}).click();await teacher.locator('#tabs button').first().waitFor();
    // 저장 응답을 기다리는 동안 다른 기기가 바꾼 내용에 로컬 수정을 자동 덮어쓰지 않는다.
    let race=false;
    await student.route('**/blended/api',async route=>{
      const body=route.request().postDataJSON();
      if(race || body.action!=='planner_save'){await route.continue();return;}race=true;
      const response=await route.fetch();
      const rpc=async(action,payload={})=>(await student.context().request.post(origin+'/blended/api',{headers:{Origin:origin,'X-Blended-Request':'1'},data:{app:'blended',action,payload,requestId:crypto.randomUUID()}})).json();
      const remote=await rpc('planner_state'),r=remote.rows.find(r=>r.key===newTask+'|'+new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Seoul'}) && r.table==='checks');
      r.data.note='다른 기기의 수정';await rpc('planner_save',{changes:[r]});
      await student.evaluate(id=>setCheck(id,today(),{note:'전송 중 입력한 내 수정'}),newTask);
      await route.fulfill({response});
    });
    await student.evaluate(id=>setCheck(id,today(),{note:'첫 저장'}),newTask);
    await student.waitForFunction(()=>sync.err.includes('다른 화면에서 변경'),null,{timeout:15000});
    assert.equal(await student.evaluate(id=>getCheck(id,today()).note,newTask),'전송 중 입력한 내 수정');
    await student.unroute('**/blended/api');await student.locator('[data-blended="reload"]').click();await synced(student);
    assert.equal(await student.evaluate(id=>getCheck(id,today()).note,newTask),'다른 기기의 수정');
    await student.getByRole('button',{name:'오늘',exact:true}).click();await click(student,'dailycloseopen');
    for(const input of await student.locator('[data-daily-resolution]').all())await input.selectOption('carry');
    await click(student,'dailyclosesave');await synced(student);
    assert.ok(await student.evaluate(()=>state.tasks.some(t=>t.dailyCarryFrom?.startsWith('blend-learning-a|'))));
    await student.context().grantPermissions(['clipboard-read','clipboard-write']);await click(student,'report');await click(student,'dailyreportcopy');
    await student.locator('button[data-act="dailyreportfinish"]:enabled').waitFor();await click(student,'dailyreportfinish');await synced(student);
    assert.equal(await student.evaluate(()=>dailyCloseState(session.staffId,today()).complete),true);
    // 원본 주요 화면과 반응형 조판, 브라우저 저장소 분리.
    for(const page of [owner,student,teacher]) {
      for(const name of ['오늘','주간','로드맵','일정·학사','인강','학습']) {
        await page.getByRole('button',{name,exact:true}).click();assert.ok((await page.locator('#view').innerText()).length>20);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} overflow`);
      }
      assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage)),[]);
    }
    await owner.getByRole('button',{name:'일정·학사',exact:true}).click();await owner.screenshot({path:path.join(evidence,'restored-schedule-desktop.png'),fullPage:true});
    await student.getByRole('button',{name:'오늘',exact:true}).click();await student.screenshot({path:path.join(evidence,'restored-today-phone.png'),fullPage:true});
    assert.ok(!requests.some(url=>url.includes('wb-sync.')));assert.deepEqual(errors,[]);
    console.log('PASS 원본 6개 화면·일정/학사 통합·시험 등록·과제 배정/수행/확인·로드맵 자동 분배·인강 목차·주간 목표·텍스트 질문·주간 발행/보호자 열람·선택 학생 상담 연결·1365/820/390px·원본 서버 호출 없음');
  } catch(error) {
    console.error('PAGE_ERRORS',errors);
    for(const context of browser.contexts())for(const page of context.pages())console.error('UI',page.url(),(await page.locator('body').innerText()).slice(0,4000));
    throw error;
  } finally {await browser.close();await new Promise(r=>server.close(r));db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
