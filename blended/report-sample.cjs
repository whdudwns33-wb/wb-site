'use strict';
// 실제 공개 리포트 템플릿을 가상 자료로 발행해 공유 가능한 샘플로 저장한다.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const {openDatabase,seedDemo}=await import('./local-db.mjs'),{createApi}=await import('./api.mjs'),{createLocalServer}=await import('./server.mjs');
 const db=openDatabase();seedDemo(db);db.prepare("UPDATE students SET name='샘플 학생 · 가상 자료' WHERE id='student-a'").run();db.prepare("UPDATE learning SET due='2026-10-16' WHERE student_id='student-a'").run();
 const api=createApi(db),login=id=>api.handle({app:'blended',action:'login',payload:{login:id,password:`Demo-${id}-2026!`}}).sessionToken;
 const owner=login('owner'),teacher=login('teacher-a'),student=login('student-a');
 const call=(token,action,payload)=>api.handle({app:'blended',action,payload,requestId:crypto.randomUUID()},token);
 for(let i=0;i<4;i++)call(teacher,'learning_create',{studentId:'student-a',subject:'수학',title:['풀이 과정 한 문장으로 설명하기','분수 나눗셈 기본 5문제','오답 두 문제 다시 풀기','개념 노트 정리'][i],due:'2026-10-17'});
 const lessons=db.prepare("SELECT * FROM learning WHERE student_id='student-a' ORDER BY id").all();
 for(let i=0;i<4;i++){call(student,'perform',{id:lessons[i].id,revision:1,done:true,question:i===3?'약분을 언제 해야 하는지 궁금해요.':''});if(i<3)call(teacher,'check',{id:lessons[i].id,revision:2,feedback:'풀이 설명과 계산 과정을 함께 확인했어요.'});}
 const c=call(teacher,'consult_save',{studentId:'student-a',subject:'수학',heldAt:'2026-10-20T16:00:00+09:00',periodStart:'2026-10-12',periodEnd:'2026-10-18',internalNote:'SAMPLE_INTERNAL_NEVER_PUBLIC',public:{studentVoice:'“계산은 할 수 있는데, 왜 나누는지 설명하는 게 아직 어려워요.”',facts:'이번 기간 학습 5건 중 4건을 완료했다고 표시했고, 강사가 3건의 풀이와 설명을 확인했어요. 나머지는 다음 수업에서 함께 확인해요.',strengths:'풀이를 다시 설명할 때 스스로 계산 순서를 점검했어요. 틀린 문제를 피하지 않고 다시 풀어 보려는 태도가 좋았어요.',guidance:'분수의 나눗셈을 그림과 한 문장으로 연결해 설명하는 연습을 해요. 정답뿐 아니라 왜 그 순서로 계산했는지 함께 확인해요.',home:'집에서는 “왜 이렇게 풀었어?”라고 한 번만 물어봐 주세요. 정답을 먼저 알려주기보다 아이의 설명을 끝까지 들어 주세요.',nextGoal:'오답 두 문제를 다시 풀고, 각 풀이의 첫 단계를 한 문장으로 설명하기',due:'2026-10-23',nextCheck:'2026-10-27'}});
 call(teacher,'consult_complete',{id:c.id,revision:1});call(teacher,'review',{id:c.id,revision:2});call(owner,'publish',{id:c.id,revision:3,reason:'가상 자료 샘플 발행'});
 const server=createLocalServer(db);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 let browser;try{
  browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});const page=await browser.newPage({viewport:{width:1100,height:1000}});
  await page.goto(origin+'/blended/#/reports');await page.getByLabel('아이디',{exact:true}).fill('guardian-a');await page.getByLabel('비밀번호',{exact:true}).fill('Demo-guardian-a-2026!');await page.getByRole('button',{name:'로그인',exact:true}).click();await page.getByRole('button',{name:'공개본 보기',exact:true}).click();
  const report=await page.locator('.report-sheet').evaluate(el=>el.outerHTML);assert.ok(report.includes('샘플 학생'));assert.ok(!report.includes('SAMPLE_INTERNAL_NEVER_PUBLIC'));
  const css=['style.css','ui.css'].map(f=>fs.readFileSync(path.join(__dirname,f),'utf8')).join('\n');
  const html='<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>블렌디드 상담 리포트 · 가상 샘플</title><style>'+css+'\nbody{background:#f7f7fa}main{max-width:880px;padding:32px 24px}.sample-label{color:#6d28d9;font-size:14px;font-weight:700;letter-spacing:.02em}.sheet{padding:32px}.report-sheet h2{font-size:26px}.report-body dd{white-space:pre-wrap;line-height:1.8}.sample-foot{margin:20px 0 0;color:#53657c;font-size:14px}@media print{:root,body{background:white}main{padding:0;min-height:0;max-width:none}.sheet{border:0;box-shadow:none;padding:0}.report-sheet{padding:18px}.report-sheet h2{font-size:22px}.report-body dt{margin-top:12px;font-size:14px}.report-body dd{line-height:1.5;font-size:14px}.sample-foot,.hint{font-size:12px}.summary{padding:12px}}</style><main><section class="sheet"><p class="sample-label">BLENDED · 상담 공개 리포트 / 가상 자료 샘플</p>'+report+'<p class="sample-foot">보호자에게 공개되는 실제 템플릿의 예시입니다. 내부 상담 메모는 포함하지 않으며 실제 발송은 하지 않았습니다.</p></section></main></html>';
  const output=process.env.REPORT_SAMPLE_DIR || path.join(__dirname,'evidence/report-sample');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'report-sample.html'),html);
  const sample=await browser.newPage();await sample.setContent(html);assert.equal(await sample.evaluate(()=>getComputedStyle(document.body).fontSize),'16px');await sample.setViewportSize({width:940,height:1100});await sample.screenshot({path:path.join(output,'report-sample.png'),fullPage:true});await sample.pdf({path:path.join(output,'report-sample.pdf'),format:'A4',printBackground:true,margin:{top:'14mm',bottom:'14mm',left:'14mm',right:'14mm'}});
  await sample.setViewportSize({width:390,height:844});assert.ok(await sample.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await sample.screenshot({path:path.join(output,'report-sample-phone.png'),fullPage:true});console.log('PASS 실제 발행 공개본 → 가상 HTML/PNG/PDF 샘플; 내부 메모 제외·390px 넘침0');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
