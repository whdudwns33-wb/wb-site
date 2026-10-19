'use strict';
// 두 저장소의 가상 화면을 실제 계산된 글꼴·역할 크기로 비교한다.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
  const {openDatabase,seedDemo}=await import('./local-db.mjs');
  const {createLocalServer}=await import('./server.mjs');
  const db=openDatabase();seedDemo(db);const server=createLocalServer(db);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`,academyOrigin=process.env.ACADEMY_SAMPLE_ORIGIN || 'http://localhost:8894';
  assert.ok(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(academyOrigin),'학원 견본은 로컬 주소만 허용');
  const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const errors=[],report=[],evidence=path.join(__dirname,'evidence');fs.mkdirSync(evidence,{recursive:true});
  try {
    const context=await browser.newContext({colorScheme:'dark'});
    await context.route('**/*',r=>[origin,academyOrigin].some(o=>r.request().url().startsWith(o+'/'))?r.continue():r.abort());
    await context.addCookies([{name:'dev_as',value:'boss',url:academyOrigin}]);
    context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
    const academy=await context.newPage(),planner=await context.newPage(),core=await context.newPage();
    await academy.goto(academyOrigin+'/ops/pads');await academy.getByRole('heading',{name:'패드 관리',exact:true}).waitFor();
    assert.equal(await academy.locator('html').getAttribute('data-brand'),'blended');
    await planner.goto(origin+'/blended/');await planner.getByLabel('아이디',{exact:true}).fill('student-a');
    await planner.getByLabel('비밀번호',{exact:true}).fill('Demo-student-a-2026!');await planner.getByRole('button',{name:'로그인',exact:true}).click();
    await planner.waitForURL('**/blended/planner/');await planner.locator('#todayNextAction').waitFor();
    await core.goto(origin+'/blended/#/learning');await core.locator('#student-filter').waitFor();
    const roles={academy:{body:'body',heading:'h2',control:'.btn',field:'input[type=date]',meta:'.who'},planner:{body:'body',heading:'.card-title',control:'.btn',field:'#qAdd',meta:'.blended-student-context'},core:{body:'body',heading:'.sheet h2',control:'button.small',field:'#student-filter',meta:'#identity'}};
    for(const width of [1365,820,390,320]) {
      const profiles={};
      for(const [name,page] of Object.entries({academy,planner,core})) {
        await page.setViewportSize({width,height:900});
        profiles[name]=await page.evaluate(selectors=>Object.fromEntries(Object.entries(selectors).map(([role,selector])=>{
          const el=document.querySelector(selector);if(!el)throw Error('글자 역할 없음: '+selector);
          const s=getComputedStyle(el);return [role,{family:s.fontFamily,size:s.fontSize,weight:s.fontWeight,line:s.lineHeight}];
        })),roles[name]);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} ${width}px 넘침`);
        if([1365,390].includes(width))await page.screenshot({path:path.join(evidence,`type-${name}-${width}.png`)});
      }
      for(const role of ['body','heading','control','field','meta']) {
        const expected={body:'16px',heading:'18px',control:'15px',field:'16px',meta:'14px'}[role];
        for(const name of Object.keys(profiles)) {
          assert.equal(profiles[name][role].size,expected,`${name} ${role} ${width}px`);
          assert.equal(profiles[name][role].family,profiles.academy.body.family,`${name} ${role} 글꼴`);
        }
      }
      assert.equal(await academy.locator('body').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(247, 247, 250)');
      report.push({width,profiles});
    }
    for(const route of ['/ops/students','/ops/students/new','/ops/attendance','/ops/classes']) {
      await academy.goto(academyOrigin+route);await academy.locator('main h1').waitFor();
      assert.ok(await academy.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),route+' 320px 넘침');
    }
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(evidence,'typography-result.json'),JSON.stringify({report,errors},null,2));
    console.log('PASS 공통 글꼴·본문16/제목18/조작15/입력16/설명14px: 학원·플래너·상담, 1365/820/390/320px, 어두운 OS에서도 공통 밝은 테마, 학원 주요 경로·오류·넘침 0');
  } finally {await browser.close();await new Promise(r=>server.close(r));db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
