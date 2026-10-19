import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
export function plannerAssets() {
  const source=readFileSync(new URL('../consult/index.html',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const styles=source.match(/<style>([\s\S]*?)<\/style>/g),scripts=[...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(styles.length,1,'원본 스타일 구조 변경: 조립 지점을 확인하세요.');
  assert.equal(scripts.length,1,'원본 스크립트 구조 변경: 조립 지점을 확인하세요.');
  let js=scripts[0][1];
  function replaceExact(before,after) {assert.equal(js.split(before).length,2,'원본 연결 지점 변경: '+before.slice(0,60));js=js.replace(before,after);}
  replaceExact("const LS_KEY = 'wb_consult_v1';","const LS_KEY = 'wb_blended_planner_unused';");
  replaceExact("const SYNC_URL = 'https://wb-sync.whdudwns33.workers.dev';","const SYNC_URL = '/blended/unlinked';");
  replaceExact("const SYNC_APP = 'consult';","const SYNC_APP = 'blended';");
  const start=js.indexOf('\nload();\nconst repairedCarryOrigins'),end=js.indexOf('setInterval(() => sync.run(), 45000);',start);
  assert.ok(start>0 && end>start,'원본 초기화 경계가 변경되었습니다.');
  js=js.slice(0,start)+js.slice(end+'setInterval(() => sync.run(), 45000);'.length);
  const version=js.indexOf('/* ── 새 버전 감지');assert.ok(version>0);js=js.slice(0,version);
  // 외부 비밀번호 저장 기능과 기존 연결 마법사는 새 진입 화면에 노출하지 않는다.
  replaceExact('function learningLoginMemoCard(me, sourceKey) {','function learningLoginMemoCard(me, sourceKey) { return \"\";');
  js=js.replaceAll('원장 피드백','공개 지도 의견').replaceAll('원장 답변','담당자 답변').replaceAll('원장이 보낸 목록','선생님이 배정한 목록');
  replaceExact('사진은 비공개로 저장되며 학생 본인과 원장만 볼 수 있습니다. 위치정보를 제거한 JPEG로 압축하고 90일 뒤 자동 삭제합니다.','텍스트 질문은 본인과 담당 과목 강사·관리자만 열람합니다. 사진 업로드는 연결 대기입니다.');
  js=js.replaceAll('문자를 복사해 발송한 뒤 아래에서 발송 완료를 확인해야 오늘 마감이 끝납니다.','학습 요약을 복사한 뒤 내용을 확인하면 오늘 마감이 끝납니다. 실제 알림은 발송되지 않습니다.')
    .replaceAll('문자를 복사해 발송한 뒤 발송 완료를 확인해야','학습 요약을 복사하고 확인을 마치면')
    .replaceAll('하루 보고를 발송한 뒤','하루 학습 요약을 확인한 뒤').replaceAll('보고 발송','요약 확인')
    .replaceAll('발송했어요','내용을 확인했어요').replaceAll('문자를 먼저 복사','요약을 먼저 복사').replaceAll('보고 문자','학습 요약')
    .replaceAll('원장이 학습 기록을 확인해 기프트 카드를 별도로 발송합니다. 실제 발송이 완료되면 5,000P가 차감되고 <code>기프트 카드 교환 완료</code>로 기록됩니다.','학습 포인트와 스탬프를 기록합니다. 기프트 카드 교환과 실제 알림 발송은 연결 대기입니다.');
  js+='\n'+readFileSync(new URL('./planner-adapter.js',import.meta.url),'utf8');
  assert.ok(!js.includes('https://wb-sync.whdudwns33.workers.dev'));
  const css=styles[0].slice(7,-8)+`\n.blended-save{position:sticky;top:0;z-index:100;background:#fff4d9;padding:10px 18px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px}.blended-save[hidden]{display:none}.blended-save.error{background:#fff0ed;color:#952e23}.blended-save button{padding:7px;background:white;border:1px solid #d8c9bd;border-radius:5px;color:inherit}.blended-sections{display:flex;gap:8px;margin:16px 0;flex-wrap:wrap}.blended-review{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #eee}.blended-review small{display:block;color:#727272}.tabs a.tab{display:inline-flex;text-decoration:none;align-items:center}.brand small{font-size:10px}@media(max-width:480px){.topbar .brand{font-size:16px}.topbar .brand small{display:none}.whoami{font-size:11px}.blended-review{flex-wrap:wrap}}`;
  let html=source.replace(styles[0],'<link rel="stylesheet" href="/blended/planner/planner.css">')
    .replace(/<link[^>]*href="https:\/\/fonts[^>]*>\n?/g,'')
    .replace(scripts[0][0],'<script src="/blended/planner/planner.js" defer></script>')
    .replace('../shared/qr.js?v=2026-09-20.2','/blended/planner/qr.js')
    .replace('컨설팅 플래너','블렌디드 플래너').replace('컨설팅 플래너','블렌디드 플래너').replace('Consulting Planner','Blended Planner')
    .replace('<main class="wrap" id="view"></main>','<div id="blended-save" class="blended-save" hidden></div><main class="wrap" id="view"><div class="card">내 플래너를 불러오고 있습니다…</div></main>');
  return {'index.html':html,'planner.css':css,'planner.js':js,'qr.js':readFileSync(new URL('../shared/qr.js',import.meta.url),'utf8')};
}
