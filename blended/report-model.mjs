const labels={studentVoice:'학생 의견',facts:'함께 확인한 점',strengths:'잘한 점',guidance:'다음 지도 방향',home:'가정 협조 사항',nextGoal:'다음 실천 목표',due:'실천 기한',nextCheck:'다음 확인일'};
const subjects={math:'수학',english:'영어',korean:'국어',social:'사회',science:'과학',other:'기타'};
const count=v=>Number.isFinite(v)&&v>=0?v:0;
export function reportModel(snapshot,kind='consultation',version='') {
 const period=kind==='planner',s=snapshot.summary || {},start=period?snapshot.periodStart:s.periodStart,end=period?snapshot.periodEnd:s.periodEnd;
 const metrics=period?[{label:'학습 배정',value:count(s.total)},{label:'학생 완료',value:count(s.done)}]:[{label:'학습 배정',value:count(s.total)},{label:'학생 완료',value:count(s.selfDone)},{label:'강사 확인',value:count(s.checked)}];
 const sections=period?[['이번 기간 돌아보기',snapshot.reflection],['원장 지도 의견',snapshot.directorNote],['다음 실천 목표',snapshot.nextFocus]].filter(([,v])=>v).map(([title,body])=>({title,body:String(body)})):Object.entries(labels).filter(([key])=>snapshot.public?.[key]).map(([key,title])=>({title,body:String(snapshot.public[key])}));
 return {title:(snapshot.student?.name || '학생')+' '+(period?(snapshot.periodType==='month'?'월간':'주간'):'상담')+' 리포트',meta:[snapshot.subject,start&&end?start+' ~ '+end:'기간 미확인',version&&'공개본 v'+version].filter(Boolean).join(' · '),metrics,hasRecords:period?count(s.total)>0:!!s.hasRecords,sections,
  days:period?(snapshot.days || []).filter(d=>d.date&&Number.isFinite(d.done)&&Number.isFinite(d.total)).map(d=>({date:d.date,done:d.done,total:d.total})):[],
  subjects:period?Object.entries(snapshot.subjects || {}).filter(([,v])=>Number.isFinite(v.total)&&v.total>0).map(([key,v])=>({name:subjects[key] || '기타',total:v.total,done:count(v.done)})):[],
  note:period?'기간별 발행 기록 기준이에요. 강사 확인 건수는 별도로 집계하지 않아요.':'학생 완료 표시와 강사 확인은 서로 다른 기록이에요.',layout:snapshot.layout};
}
export const sampleSnapshot=()=>({student:{id:'sample',name:'샘플 학생 · 가상 자료'},subject:'수학',summary:{total:5,selfDone:4,checked:3,hasRecords:true,periodStart:'2026-10-12',periodEnd:'2026-10-18'},public:{studentVoice:'계산은 할 수 있지만, 풀이를 설명하는 연습을 더 하고 싶어요.',facts:'학습 5건 중 4건에 완료 표시를 남겼고, 강사가 3건의 풀이를 확인했어요.',strengths:'틀린 문제를 다시 풀며 계산 순서를 스스로 점검했어요.',guidance:'분수의 나눗셈을 그림과 한 문장으로 설명해 봐요.',home:'아이의 풀이 설명을 끝까지 듣고 스스로 확인할 시간을 주세요.',nextGoal:'오답 두 문제를 다시 풀고 첫 단계를 한 문장으로 설명하기',due:'2026-10-23',nextCheck:'2026-10-27'}});
export function pdfInputs(model,chart) {
 return {title:model.title,meta:model.meta,summary:model.hasRecords?model.metrics.map(m=>m.label+' '+m.value+'건').join(' · '):'기록 없음 · 미수행이나 0점으로 해석하지 않아요.',chart,details:model.sections.map(s=>s.title+'\n'+s.body).join('\n\n')+'\n\n'+model.note};
}
