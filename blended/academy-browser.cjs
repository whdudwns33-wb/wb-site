'use strict';
// 두 앱의 가상 자료로 연결 저장 → 로그인 → 정확한 학생 이동을 끝까지 확인한다.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
(async()=>{
 const academySource=process.env.ACADEMY_SOURCE;assert.ok(academySource&&fs.existsSync(path.join(academySource,'dev/serve.mjs')),'ACADEMY_SOURCE 작업본 지정 필요');
 fs.mkdirSync(path.join(academySource,'.dev-data'),{recursive:true});
 const {openDatabase,seedDemo}=await import('./local-db.mjs'),{createLocalServer}=await import('./server.mjs');
 const db=openDatabase();seedDemo(db);const key=require('node:crypto').randomBytes(32).toString('hex');
 const planner=createLocalServer(db,{academyBridgeKey:key});await new Promise(r=>planner.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${planner.address().port}`;
 const port=8904,academyOrigin=`http://localhost:${port}`,dir=fs.mkdtempSync(path.join(academySource,'.dev-data/handoff-e2e-'));
 fs.writeFileSync(path.join(dir,'key'),key);
 fs.writeFileSync(path.join(dir,'academy.json'),JSON.stringify({version:1,name:'WB 블렌디드학원',staffOrigin:`http://localhost:${port+10000}`,publicOrigin:academyOrigin,grades:['초3'],subjects:['견본 수학'],products:['견본 수업'],apps:[],care:{}}));
 const child=spawn(process.execPath,['dev/serve.mjs'],{cwd:academySource,env:{...process.env,NODE_ENV:'development',PORT:String(port),WB_OPS_DEV_DATA_DIR:dir,WB_OPS_ACADEMY_CONFIG:path.join(dir,'academy.json'),WB_OPS_PLANNER_KEY_FILE:path.join(dir,'key'),WB_OPS_PLANNER_ORIGIN:origin},windowsHide:true,stdio:['ignore','pipe','pipe']});
 let childLog='';child.stdout.on('data',d=>childLog+=d);child.stderr.on('data',d=>childLog+=d);
 let browser;
 try {
  let ready=false;for(let i=0;i<120;i++){try{ready=(await fetch(academyOrigin+'/ops/api/students')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,250));}assert.ok(ready,'가상 학원 준비 실패: '+childLog.slice(-700));
  const items=(await (await fetch(academyOrigin+'/ops/api/students')).json()).data.items,sid=items[1].id,name=items[1].name;
  for(const id of ['student-a','student-b']){db.prepare('UPDATE students SET name=? WHERE id=?').run(name,id);db.prepare('UPDATE users SET name=? WHERE id=?').run(name,id);}
  browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const errors=[],context=await browser.newContext({viewport:{width:1365,height:1000}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',r=>[origin,academyOrigin].some(o=>r.request().url().startsWith(o+'/'))?r.continue():r.abort());
  await page.goto(academyOrigin+'/ops/students/'+sid);await page.getByRole('heading',{name,exact:true}).waitFor();
  await page.getByRole('button',{name:name+' 학생의 플래너 열기',exact:true}).click();await page.locator('#planner-candidate').waitFor();
  await page.locator('#planner-candidate').selectOption('student-b');await page.getByRole('button',{name:'선택한 학생 연결',exact:true}).click();
  await page.getByText('학생 바로가기 연결',{exact:true}).first().waitFor();
  const evidence=path.join(__dirname,'evidence');fs.mkdirSync(evidence,{recursive:true});
  await page.screenshot({path:path.join(evidence,'academy-linked-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:path.join(evidence,'academy-linked-phone.png'),fullPage:true});
  await page.getByRole('button',{name:name+' 학생의 플래너 열기',exact:true}).click();
  await page.getByLabel('아이디',{exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.get('student'),'student-b');
  await page.getByLabel('아이디',{exact:true}).fill('owner');await page.getByLabel('비밀번호',{exact:true}).fill('Demo-owner-2026!');await page.getByRole('button',{name:'로그인',exact:true}).click();
  await page.locator('#studyPlanner').waitFor();assert.equal(await page.evaluate(()=>currentStaff().id),'student-b');
  await page.screenshot({path:path.join(evidence,'academy-target-planner.png')});
  await page.goto(origin+'/blended/planner/?student=unknown#/today');await page.getByRole('heading',{name:'요청한 학생을 열 수 없습니다.'}).waitFor();assert.equal(await page.locator('#studyPlanner').count(),0);
  const second=await browser.newContext(),teacher=await second.newPage();
  await teacher.goto(origin+'/blended/planner/?student=student-b#/today');await teacher.getByLabel('아이디',{exact:true}).fill('teacher-a');await teacher.getByLabel('비밀번호',{exact:true}).fill('Demo-teacher-a-2026!');await teacher.getByRole('button',{name:'로그인',exact:true}).click();
  await teacher.getByRole('heading',{name:'요청한 학생을 열 수 없습니다.'}).waitFor();assert.equal(await teacher.locator('#studyPlanner').count(),0);
  await page.goto(academyOrigin+'/ops/students/'+sid);db.prepare("UPDATE students SET active=0 WHERE id='student-b'").run();
  await page.getByRole('button',{name:name+' 학생의 플래너 열기',exact:true}).click();await page.getByText(/연결할 플래너 학생이 없거나 이용이 중단/).waitFor();assert.equal(new URL(page.url()).origin,academyOrigin);
  assert.deepEqual(errors,[]);
  console.log('PASS 두 앱 실제 HTTP: 동명이인 명시 연결→학생 상세 바로가기→로그인 뒤 대상 유지; 미존재·담당 외 학생 대체 표시 금지; 비활성 학생 거부; 390px·브라우저 오류0');
 } catch(error) {
  if(browser)for(const context of browser.contexts())for(const page of context.pages())console.error('가상 화면',page.url(),(await page.locator('body').innerText()).slice(0,5000));
  console.error('가상 서버',childLog.slice(-1200));throw error;
 } finally {
  if(browser)await browser.close();
  if(process.platform==='win32'){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});}catch{}}
  else child.kill('SIGTERM');
  await new Promise(r=>planner.close(r));db.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
