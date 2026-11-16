const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname + '/index.html','utf8');
function harness() {
  let y=500, absolute=700, focusCalls=0, frame, renderCount=0;
  const dataset={id:'lesson-a',date:'2026-11-16',step:'step-2'};
  const button={dataset,getBoundingClientRect:()=>({top:absolute-y}),focus:opts=>{assert.equal(opts.preventScroll,true);focusCalls++}};
  const root={style:{overflowAnchor:''},querySelectorAll:()=>[button]};
  const window={get scrollY(){return y},scrollBy:opts=>{assert.equal(opts.behavior,'instant');y+=opts.top}};
  const a=source.indexOf('let pendingStepScrollRestore = null;'),b=source.indexOf('function renderMarkupFingerprint',a);
  const api=new Function('$','window','document','render','requestAnimationFrame','cancelAnimationFrame','route',source.slice(a,b)+'\nreturn renderKeepingStepPosition;')(
    ()=>root,window,{activeElement:button},()=>{absolute+=160;renderCount++},f=>{frame=f;return 1},()=>{frame=null},'today');
  return {click:()=>api(button),tick:()=>{const f=frame;frame=null;f&&f()},scroll:delta=>y+=delta,layout:delta=>absolute+=delta,
    top:()=>absolute-y,root,focus:()=>focusCalls,renders:()=>renderCount};
}
test('successive step renders retain the tapped position and keyboard focus without smooth scrolling',()=>{
  const h=harness();for(let i=0;i<5;i++){h.click();assert.equal(h.top(),200);h.tick();assert.equal(h.root.style.overflowAnchor,'');}
  assert.equal(h.renders(),5);assert.equal(h.focus(),10);
});
test('late layout is corrected but manual scrolling is respected',()=>{
  const h=harness();h.click();h.layout(40);h.tick();assert.equal(h.top(),200);
  h.click();h.scroll(80);h.tick();assert.equal(h.top(),120);
});
test('rapid taps clean up the previous frame and restore original anchoring',()=>{
  const h=harness();h.click();h.click();h.tick();assert.equal(h.top(),200);assert.equal(h.root.style.overflowAnchor,'');
});
test('only step action opts in and details have stable lesson/date identity',()=>{
  const block=source.slice(source.indexOf("case 'step':"),source.indexOf("case 'cnt':"));
  assert.match(block,/renderKeepingStepPosition\(el\)/);
  assert.match(source,/data-persist-key="lesson-steps\|/);
});
