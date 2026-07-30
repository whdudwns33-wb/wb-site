// End-to-end 스모크 테스트 — 서버를 띄우고 전체 플로우를 HTTP로 검증.
// 네트워크/DB/Claude 키 없이 실행 가능(mock AI). 실패 시 프로세스 종료코드 1.

import { server } from '../src/server.mjs';

const PORT = 8799;
const base = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };
const api = async (method, path, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { code: r.status, body: await r.json().catch(() => ({})) };
};

await new Promise((r) => server.listen(PORT, r));

try {
  console.log('\n[정상 HTP 플로우]');
  let r = await api('POST', '/api/submissions', { test_type: 'HTP', child: { alias: '○○', birth_year: new Date().getFullYear() - 8, sex: '남아', context_note: '동생 출생 후' } });
  ok(r.code === 201 && r.body.status === 'consent_pending', `제출 생성 → ${r.body.status}`);
  const id = r.body.submission_id;

  r = await api('POST', `/api/submissions/${id}/consent`, { analysis: true, store: true, guardian_verified: true });
  ok(r.code === 200 && r.body.status === 'uploaded', `동의(만8세 보호자 인증) → ${r.body.status}`);

  // 업로드 → 파이프라인
  r = await api('POST', `/api/submissions/${id}/image`, { image_ref: 'sample-htp' });
  ok(r.code === 200 && r.body.status === 'reviewing', `업로드→파이프라인 → ${r.body.status} (가설 ${r.body.hypotheses})`);

  r = await api('GET', `/api/submissions/${id}/preview`);
  ok(r.code === 200 && /진단이 아닙니다/.test(r.body.parent_preview || ''), '학부모 미리보기(진단 아님 문구 포함)');

  // 전문가 콘솔
  r = await api('GET', '/api/console/queue', null, { 'x-role': 'expert' });
  ok(r.code === 200 && r.body.queue.some((q) => q.id === id), '콘솔 대기열에 노출');

  r = await api('GET', `/api/console/submissions/${id}`, null, { 'x-role': 'expert' });
  const hyps = r.body.hypotheses;
  ok(hyps.length === 5, `가설 ${hyps.length}건 로드`);
  ok(hyps.every((h) => ['high', 'mid', 'low'].includes(h.confidence)), '전 가설 근거수준 존재');
  ok(!hyps.some((h) => h.confidence === 'high'), "'강' 신뢰도 없음(투사검사 특성)");
  const hand = hyps.find((h) => h.element === 'person.hand');
  ok(hand && hand.confidence === 'low' && hand.age_adjustment, '손 생략: 연령보정으로 강등(mid→low)+문구');

  // 권한 없이 콘솔 접근 차단
  r = await api('GET', '/api/console/queue');
  ok(r.code === 403, '비전문가 콘솔 접근 차단(403)');

  // 리포트는 확정 전 잠김
  // (토큰 없으니 확정 먼저) — 확정 전 preview는 되지만 report는 확정 후에만 토큰 발급
  // 가설 하나 삭제 후 확정
  const roof = hyps.find((h) => h.element === 'house.roof');
  r = await api('PATCH', `/api/console/hypotheses/${roof.id}`, { action: 'reject' }, { 'x-role': 'expert' });
  ok(r.code === 200, '가설 삭제(reject)');

  r = await api('POST', `/api/console/submissions/${id}/confirm`, {}, { 'x-role': 'expert' });
  ok(r.code === 200 && r.body.status === 'published' && r.body.kept === 4, `확정→발행(published), 반영 ${r.body.kept}건(삭제 1 제외)`);
  const token = r.body.share_token;

  // 학부모 리포트: 생년 확인
  r = await api('GET', `/api/reports/${token}?birth_year=${new Date().getFullYear() - 8}`);
  ok(r.code === 200 && /강점/.test(r.body.report || ''), '학부모 정식 리포트 열람(생년 일치)');
  r = await api('GET', `/api/reports/${token}?birth_year=1900`);
  ok(r.code === 403, '생년 불일치 차단(403)');

  console.log('\n[위기 신호 플로우]');
  r = await api('POST', '/api/submissions', { test_type: 'HTP', child: { alias: 'X', age: 10 } });
  const cid = r.body.submission_id;
  await api('POST', `/api/submissions/${cid}/consent`, { analysis: true, store: true, guardian_verified: true });
  r = await api('POST', `/api/submissions/${cid}/image`, { image_ref: 'sample-crisis' });
  ok(r.code === 200 && r.body.status === 'escalated', `위기 신호→자동해석 중단·escalated (flags: ${r.body.crisis_flags})`);
  r = await api('GET', `/api/submissions/${cid}/preview`);
  ok(r.code === 409, '위기 케이스는 학부모 미리보기 차단');

  console.log('\n[동의 게이트]');
  r = await api('POST', '/api/submissions', { test_type: 'HTP', child: { age: 8 } });
  const nid = r.body.submission_id;
  r = await api('POST', `/api/submissions/${nid}/consent`, { analysis: true, store: true });  // 보호자 인증 없음
  ok(r.code === 400, '만14세 미만 보호자 미인증 → 동의 거부(400)');
} catch (e) {
  fail++; console.log('  ❌ 예외:', e.message, e.stack);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
server.close();
process.exit(fail ? 1 : 0);
