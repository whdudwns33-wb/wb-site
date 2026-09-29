'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const html=fs.readFileSync(require('node:path').join(__dirname,'index.html'),'utf8');
const source=html.slice(html.indexOf('function bookOrderActionButtons('),html.indexOf('function bookOrderDateText('));
test('관리자 아카등록은 주문완료·수령·배부에서 표시하고 배송 버튼과 함께 유지한다',()=>{
 const actions=Function('session','esc',source+';return bookOrderActionButtons;')({isAdmin:true},String);
 for(const stage of ['ordered','teacher_received','student_handed']){
  const row={stage,taskId:'t',itemIndex:0,unitPrice:1000};const s=actions(row);
  assert.match(s,/아카등록완료/);
  if(stage==='ordered')assert.match(s,/수령완료/);
  if(stage==='teacher_received')assert.match(s,/배부완료/);
  assert.doesNotMatch(actions({...row,academyRegisteredAt:10}),/아카등록완료/);
 }
 for(const stage of ['order_waiting','order_failed','order_check','cancelled'])assert.doesNotMatch(actions({stage,unitPrice:1000}),/아카등록완료/);
 assert.match(actions({stage:'cancelled',academyRegisteredAt:10,academyCorrectionNeeded:true}),/아카수정완료/);
 const own=Function('session','esc',source+';return bookOrderActionButtons;')({isStaffLink:true,staffId:'a'},String);
 assert.doesNotMatch(own({stage:'ordered',owner:'a',unitPrice:1000}),/아카등록완료/);
});
test('조기 아카등록은 진행 목록에 남고 배부까지 완료된 교재만 기록으로 이동한다',()=>{
 const rows=[{stage:'ordered',academyRegisteredAt:1},{stage:'teacher_received',academyRegisteredAt:1},
 {stage:'student_handed',academyRegisteredAt:1,studentHandedAt:2},
 {stage:'student_handed',academyRegisteredAt:1,studentHandedAt:2,academyCorrectionNeeded:true}];
 const src=html.slice(html.indexOf('function bookOrderStageRows('),html.indexOf('function bookOrderMessageStatusLabel('));
 const list=Function('bookOrderRows',src+';return bookOrderStageRows;')(rows);
 assert.equal(list('order_result').length,1);assert.equal(list('teacher_received').length,1);
 assert.deepEqual(list('student_handed'),[rows[3]]);
});
