'use strict';
/* node crm/crm-core.test.cjs — 세일즈데스크 순수 로직. 외부 의존성 없음.
   실명·전화는 자리표시(보호자A, 010-0000-0000)만 쓴다. */
const assert = require('node:assert/strict');
const C = require('./crm-core.js');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const TODAY = '2026-10-06';

console.log('crm-core — 단계·채널·팔로업·KPI·검증');

t('파이프라인 2개의 단계 목록과 라벨이 전부 있다', () => {
  assert.deepEqual(C.PIPELINES, ['inspection', 'academy']);
  C.PIPELINES.forEach(p => C.stagesOf(p).forEach(s => assert.ok(C.STAGE_LABEL[s], p + '/' + s + ' 라벨 없음')));
  assert.equal(C.stagesOf('nope').length, 0);
  assert.ok(C.isClosed('won') && C.isClosed('lost') && C.isClosed('churned') && !C.isClosed('tested'));
});

t('상태는 단계에서 유도된다 — won/lost/churned 는 요청값을 무시, 그 외는 hold 만 허용', () => {
  assert.equal(C.statusOf('won', 'hold'), 'won');
  assert.equal(C.statusOf('lost', 'open'), 'lost');
  assert.equal(C.statusOf('churned', 'open'), 'lost');
  assert.equal(C.statusOf('tested', 'hold'), 'hold');
  assert.equal(C.statusOf('tested', 'anything'), 'open');
});

t('채널 감지 — 우선순위(지인추천>블로그>맘카페>인스타>당근>센터폰), 단서 없음은 기타', () => {
  assert.equal(C.detectChannel('판교맘카페에서 글 보고 연락드려요').channel, '맘카페');
  assert.equal(C.detectChannel('맘카페 후기 보고 왔어요').channel, '맘카페');
  assert.equal(C.detectChannel('친구 엄마 소개로 연락드려요').channel, '지인추천');
  assert.equal(C.detectChannel('당근 동네생활에서 봤어요').channel, '당근');
  assert.equal(C.detectChannel('인스타 릴스 보고요').channel, '인스타');
  assert.equal(C.detectChannel('네이버 검색하다가').channel, '블로그');
  assert.equal(C.detectChannel('맘카페 봤는데 지인 추천도 받았어요').channel, '지인추천');
  const none = C.detectChannel('검사 받고 싶어요');
  assert.deepEqual([none.channel, none.confidence], ['기타', 'low']);
  assert.equal(C.detectChannel('아이가 책을 잘 안 읽어서 독해력 검사를 한 번 받아보고 싶습니다').confidence, 'none');
  assert.ok(C.CHANNELS.includes(none.channel));
});

t('HOT 감지 — 두 묶음 이상이면 high(자동 핫), 하나면 medium, 없으면 none', () => {
  assert.equal(C.detectHot('내일 예약 가능한가요').confidence, 'high');
  assert.equal(C.detectHot('가격이 궁금해요').confidence, 'medium');
  assert.equal(C.detectHot('안녕하세요').confidence, 'none');
  assert.equal(C.detectHot('가격이 궁금해요').hot, false);
});

t('재검사 예정일 — 기본 730일, 시선추적 365일, 창은 D-30·D-7·D-day·지남', () => {
  assert.equal(C.retestDue('2024-10-06', '웩슬러'), '2026-10-06');
  assert.equal(C.retestDue('2025-10-06', '시선추적'), '2026-10-06');
  assert.equal(C.retestDue('', '웩슬러'), '');
  assert.deepEqual(C.retestWindow('2026-10-06', TODAY), { window: 0, days: 0 });
  assert.equal(C.retestWindow('2026-10-10', TODAY).window, 7);
  assert.equal(C.retestWindow('2026-11-01', TODAY).window, 30);
  assert.equal(C.retestWindow('2026-12-01', TODAY), null);
  assert.equal(C.retestWindow('2026-09-01', TODAY).window, 'overdue');
});

t('팔로업 일정 D+3·7·14 — 기준일에서 만들고, 오늘 할 것은 due≤오늘인 pending 만', () => {
  const fus = C.scheduleFollowups('2026-10-01');
  assert.deepEqual(fus.map(f => [f.day, f.due, f.status]), [[3, '2026-10-04', 'pending'], [7, '2026-10-08', 'pending'], [14, '2026-10-15', 'pending']]);
  const lead = { status: 'open', followups: fus };
  const due = C.dueFollowups(lead, TODAY);
  assert.deepEqual(due.map(f => [f.day, f.late]), [[3, 2]]);
  const marked = C.markFollowup(fus, 3, { status: 'done', doneAt: TODAY, result: 'reached' });
  assert.equal(C.dueFollowups({ followups: marked }, TODAY).length, 0);
  assert.equal(C.nextFollowup({ followups: marked }).day, 7);
  assert.deepEqual(C.scheduleFollowups('bad-date'), []);
});

t('문자 초안 — D+3 에는 등록·수강료가 없고, 호칭·아이 이름 받침 처리가 맞다', () => {
  const lead = { name: '보호자A', relation: '모', child: { name: '민준' }, inspection: { type: '웩슬러', date: '2026-10-02' }, strength: '처리속도' };
  const d3 = C.messageDraft(3, lead);
  assert.ok(d3.includes('어머니') && d3.includes('민준이') && d3.includes('처리속도') && d3.includes('금요일'));
  assert.ok(!/등록|수강료|결제/.test(d3), 'D+3 에 판매 어휘가 있다');
  assert.ok(C.messageDraft(7, Object.assign({}, lead, { relation: '부' })).includes('아버님'));
  assert.ok(C.messageDraft(14, { child: { name: '서아' } }).includes('서아 준비'));
  assert.ok(C.messageDraft(3, {}).includes('[검사에서 돋보인 강점 한 가지]'));
  assert.equal(C.childCall('Tom'), 'Tom');
  assert.equal(C.childCall(''), '아이');
  assert.ok(C.retestDraft(30, lead).includes('2년') && C.retestDraft(7, lead).includes('다음 주'));
});

t('validateLead — 정규화·필수값·날짜·상태 유도·outcome 보정', () => {
  assert.equal(C.validateLead({}).ok, false);
  const v = C.validateLead({ name: ' 보호자A ', phone: '01000000000', email: 'A@B.CO', channel: '맘카페', stage: 'tested', child: { name: '아이', birth: '2017-03-02' },
    inspection: { type: '웩슬러', date: '2026-10-01' }, consultedAt: '2026-10-02', followups: C.scheduleFollowups('2026-10-02'), status: 'hold', interests: ['학원', 'x'] }, { today: TODAY });
  assert.ok(v.ok, v.error);
  assert.equal(v.data.phone, '010-0000-0000');
  assert.equal(v.data.email, 'a@b.co');
  assert.equal(v.data.status, 'hold');
  assert.equal(v.data.outcome.status, 'hold');
  assert.equal(v.data.retestDue, '2028-09-30');   // 2028 은 윤년 — 730일은 날짜가 하루 당겨진다
  assert.deepEqual(v.data.interests, ['학원']);
  assert.equal(v.data.followups.length, 3);
  assert.equal(v.data.stageAt, TODAY);
  const lost = C.validateLead({ name: 'B', pipeline: 'inspection', stage: 'lost', outcome: { reason: 'P', at: '2026-10-05', note: '비쌈' } }, { today: TODAY });
  assert.deepEqual([lost.data.status, lost.data.outcome.reason, lost.data.outcome.at], ['lost', 'P', '2026-10-05']);
  const lostNoReason = C.validateLead({ name: 'B', stage: 'lost' }, { today: TODAY });
  assert.equal(lostNoReason.data.outcome.reason, 'U');
  assert.equal(C.validateLead({ name: 'B', pipeline: 'academy', stage: 'inquiry' }).data.stage, 'trial');
  assert.equal(C.validateLead({ name: 'B', phone: 'abc' }).ok, false);
  assert.equal(C.validateLead({ name: 'B', email: 'nope' }).ok, false);
  assert.equal(C.validateLead({ name: 'B', child: { birth: '2017-13-01' } }).ok, false);
  assert.equal(C.validateLead({ name: 'B', channel: '없는채널' }).data.channel, '기타');
  assert.equal(C.validateLead({ name: 'B', stage: 'tested' }).data.outcome, null);
});

t('validateActivity·validateCredit — 내용 없는 메모는 거절, 단계 변경은 내용 없이도 됨, 크레딧 부호 검사', () => {
  assert.equal(C.validateActivity({ leadId: 'l1', type: 'note', text: '' }).ok, false);
  assert.ok(C.validateActivity({ leadId: 'l1', type: 'stage', from: 'inquiry', to: 'booked' }).ok);
  assert.ok(C.validateActivity({ leadId: 'l1', type: 'msg', result: 'no_answer' }).ok);
  assert.equal(C.validateActivity({ type: 'note', text: 'x' }).ok, false);
  const a = C.validateActivity({ leadId: 'l1', type: 'consult', text: '상담 메모', at: '2026-10-05T10:00' }, { today: TODAY });
  assert.equal(a.data.at, '2026-10-05');
  assert.ok(C.validateCredit({ leadId: 'l1', type: 'accrue', amount: 15000 }).ok);
  assert.equal(C.validateCredit({ leadId: 'l1', type: 'accrue', amount: -15000 }).ok, false);
  assert.equal(C.validateCredit({ leadId: 'l1', type: 'use', amount: 15000 }).ok, false);
  assert.equal(C.validateCredit({ leadId: 'l1', type: 'bogus', amount: 1 }).ok, false);
});

t('소개 크레딧 v2.0 — 잔액 합산, 피소개자 중복 금지, 30일 쿨다운', () => {
  const credits = [
    { leadId: 'r', type: 'accrue', amount: 15000, at: '2026-09-20', referredLeadId: 'x1' },
    { leadId: 'r', type: 'use', amount: -5000, at: '2026-09-25' },
    { leadId: 'other', type: 'accrue', amount: 15000, at: '2026-01-01' }
  ];
  assert.equal(C.creditBalance(credits, 'r'), 10000);
  assert.equal(C.creditEligibility(credits, 'r', 'x1', TODAY).reason, 'duplicate');
  const cd = C.creditEligibility(credits, 'r', 'x2', TODAY);
  assert.deepEqual([cd.ok, cd.reason, cd.until], [false, 'cooldown', '2026-10-20']);
  assert.ok(C.creditEligibility(credits, 'r', 'x2', '2026-10-20').ok);
  assert.equal(C.creditEligibility(credits, 'new', 'x9', TODAY).amount, 15000);
});

t('HubSpot 파이프라인 자동 매핑 — 라벨·별칭 일치, 못 맞춘 단계는 unmapped, 역방향 조회', () => {
  const hs = [
    { id: 'default', label: '검사 여정', stages: [
      { id: 'appointmentscheduled', label: '신규문의' }, { id: 'qualifiedtobuy', label: '연락완료' }, { id: 'presentationscheduled', label: '예약확정' },
      { id: 'decisionmakerboughtin', label: '검사완료' }, { id: 'contractsent', label: '해석완료' }, { id: 'closedwon', label: '성사된 거래' },
      { id: '3551668965', label: '업셀제안' }, { id: 'closedlost', label: '성사되지 않은 거래' }] },
    { id: '22069', label: '학원 등록', stages: [
      { id: 'a1', label: '트라이얼' }, { id: 'a2', label: '트라이얼검토' }, { id: 'a3', label: '활성' }, { id: 'a4', label: '이탈위험' }, { id: 'a5', label: '이탈' },
      { id: 'a6', label: '성사된 거래' }, { id: 'a7', label: '성사되지 않은 거래' }] }
  ];
  const m1 = C.autoMapPipeline(hs, 'inspection');
  assert.equal(m1.pipelineId, 'default');
  assert.deepEqual(m1.unmapped, []);
  assert.equal(m1.stageMap.won, 'closedwon');
  assert.equal(m1.stageMap.upsell, '3551668965');
  const m2 = C.autoMapPipeline(hs, 'academy');
  assert.equal(m2.pipelineId, '22069');
  assert.deepEqual([m2.stageMap.trial, m2.stageMap.churned, m2.stageMap.lost], ['a1', 'a5', 'a7']);
  const partial = C.autoMapPipeline([{ id: 'p', label: 'Sales', stages: [{ id: 's1', label: 'New Lead' }, { id: 's2', label: 'Closed Won' }] }], 'inspection');
  assert.deepEqual([partial.pipelineId, partial.stageMap.inquiry, partial.stageMap.won], ['p', 's1', 's2']);
  assert.ok(partial.unmapped.includes('booked'));
  assert.equal(C.localStageFor({ inspection: m1 }, 'inspection', 'contractsent'), 'interpreted');
  assert.equal(C.localStageFor({ inspection: m1 }, 'inspection', 'zzz'), '');
  assert.deepEqual(C.autoMapPipeline([], 'inspection').unmapped, C.stagesOf('inspection'));
});

t('동기화 트랙 — 딜 단계 전이만 review, 그 외는 quick', () => {
  assert.equal(C.syncTrack('contact', {}), 'quick');
  assert.equal(C.syncTrack('note', {}), 'quick');
  assert.equal(C.syncTrack('deal', { transition: false }), 'quick');
  assert.equal(C.syncTrack('deal', { transition: true }), 'review');
});

t('오늘 보드 — 밀린 팔로업 먼저, D+14 지난 최종판정, 핫, 미연락 신규, 재검사 창', () => {
  const leads = [
    { id: 'a', name: 'A', status: 'open', stage: 'tested', pipeline: 'inspection', consultedAt: '2026-10-01', followups: C.scheduleFollowups('2026-10-01'), createdAt: '2026-09-20' },
    { id: 'b', name: 'B', status: 'open', stage: 'interpreted', pipeline: 'inspection', consultedAt: '2026-09-10', followups: [], createdAt: '2026-09-01' },
    { id: 'c', name: 'C', status: 'open', stage: 'inquiry', pipeline: 'inspection', hot: true, createdAt: '2026-10-04', followups: [] },
    { id: 'd', name: 'D', status: 'won', stage: 'won', pipeline: 'inspection', retestDue: '2026-10-20', followups: [] },
    { id: 'e', name: 'E', status: 'lost', stage: 'lost', pipeline: 'inspection', retestDue: '2026-10-06', followups: [] },
    { id: 'f', name: 'F', status: 'open', stage: 'inquiry', pipeline: 'inspection', createdAt: TODAY, followups: [] }
  ];
  const acts = [{ leadId: 'f', at: TODAY, type: 'call' }];
  const b = C.todayBoard(leads, acts, TODAY);
  assert.deepEqual(b.followups.map(x => [x.lead.id, x.followup.day, x.followup.late]), [['a', 3, 2]]);
  assert.deepEqual(b.decide.map(x => x.lead.id), ['b']);
  assert.deepEqual(b.hot.map(x => x.id), ['c']);
  assert.deepEqual(b.fresh.map(x => x.id), ['c']);   // f 는 오늘 만든 것, c 는 이틀 전인데 기록이 없다
  assert.deepEqual(b.retest[30].map(x => x.lead.id), ['d']);
  assert.deepEqual(b.retest[0], []);                 // 이탈한 e 는 재검사 안내 대상이 아니다
});

t('월 KPI — 상담 코호트 전환율·D+14 결정률·팔로업1 응답률·채널·이탈 사유', () => {
  const fuDone = r => C.markFollowup(C.scheduleFollowups('2026-09-05'), 3, { status: 'done', result: r, doneAt: '2026-09-08' });
  const leads = [
    { id: '1', createdAt: '2026-09-01', channel: '맘카페', hot: true, consultedAt: '2026-09-05', status: 'won', stage: 'won', pipeline: 'inspection', outcome: { status: 'won', at: '2026-09-12' }, followups: fuDone('reached') },
    { id: '2', createdAt: '2026-09-02', channel: '당근', consultedAt: '2026-09-05', status: 'lost', stage: 'lost', pipeline: 'inspection', outcome: { status: 'lost', at: '2026-09-25', reason: 'P' }, followups: fuDone('no_answer') },
    { id: '3', createdAt: '2026-09-03', channel: '맘카페', consultedAt: '2026-09-05', status: 'open', stage: 'interpreted', pipeline: 'inspection', followups: [] },
    { id: '4', createdAt: '2026-08-20', channel: '블로그', consultedAt: '2026-08-25', status: 'won', stage: 'won', pipeline: 'inspection', outcome: { status: 'won', at: '2026-09-02' }, followups: [] },
    { id: '5', createdAt: '2026-09-10', channel: '기타', status: 'hold', stage: 'tested', pipeline: 'inspection', consultedAt: '2026-09-11', outcome: { status: 'hold', at: '2026-09-30' }, followups: [] }
  ];
  const k = C.kpi(leads, [], '2026-09', TODAY);
  assert.equal(k.inquiries, 4);
  assert.equal(k.consulted, 4);
  assert.deepEqual([k.won, k.lost, k.hold, k.open], [1, 1, 1, 1]);
  assert.equal(k.conversion, 25);
  assert.equal(k.wonMonth, 2);
  assert.equal(k.decidedIn14, 25);        // 성숙 4건 중 14일 안에 결정된 것은 1건(won 9/12)
  assert.equal(k.followup1Response, 50);
  assert.deepEqual(k.channels, { 맘카페: 2, 당근: 1, 기타: 1 });
  assert.deepEqual(k.lostReasons, { P: 1 });
  assert.equal(k.hotRate, 25);
  assert.deepEqual(k.stages.inspection, { interpreted: 1, tested: 1 });
  assert.equal(C.kpi([], [], '2026-09', TODAY).conversion, null);
});

t('검색·라벨·전화 가림', () => {
  const lead = { name: '보호자A', child: { name: '아이', school: '가나초' }, phone: '010-0000-0000', email: 'a@b.co' };
  assert.ok(C.leadMatches(lead, '가나'));
  assert.ok(C.leadMatches(lead, '01000000000'));
  assert.ok(C.leadMatches(lead, '0000-0000'));
  assert.ok(!C.leadMatches(lead, '없음'));
  assert.ok(C.leadMatches(lead, ''));
  assert.equal(C.leadLabel(lead), '보호자A · 아이');
  assert.equal(C.maskPhone('01000000000'), '010-****-0000');
  assert.equal(C.normalizePhone('02-123-4567'), '02-123-4567');
});

t('문서 병합·되돌리기·변경 큐(desk 와 같은 계약)', () => {
  let st = C.emptyState();
  const r = C.mergeDocs(st, [
    { c: 'leads', id: 'l1', data: { name: 'A' }, updatedAt: 10 },
    { c: 'activities', id: 'a1', data: { leadId: 'l1' }, updatedAt: 11 },
    { c: 'settings', id: 'main', data: { orgName: 'WB' }, updatedAt: 12 },
    { c: 'staff', id: 's1', data: { name: '직원' }, updatedAt: 13 },
    { c: 'credits', id: 'c1', data: { leadId: 'l1', amount: 1 }, updatedAt: 14 },
    { c: 'unknown', id: 'x', data: {}, updatedAt: 15 }
  ], []);
  st = r.local;
  assert.equal(r.changed, 5);
  assert.equal(st.leads[0].id, 'l1');
  assert.equal(st.settings.orgName, 'WB');
  const older = C.mergeDocs(st, [{ c: 'leads', id: 'l1', data: { name: 'OLD' }, updatedAt: 5 }], []);
  assert.equal(older.local.leads[0].name, 'A');
  const pend = C.mergeDocs(st, [{ c: 'leads', id: 'l1', data: { name: 'SRV' }, updatedAt: 99 }], ['leads|l1']);
  assert.deepEqual([pend.skipped, pend.local.leads[0].name], [1, 'A']);
  const del = C.mergeDocs(st, [{ c: 'leads', id: 'l1', deleted: true, updatedAt: 20 }], []);
  assert.equal(del.local.leads.length, 0);
  assert.deepEqual(C.revertDoc(st, 'leads|l1').data, { name: 'A' });
  assert.equal(C.revertDoc(st, 'leads|nope').deleted, true);
  const ob = C.createOutbox();
  ob.put('leads', 'l1', { name: 'B' });
  ob.put('leads', 'l1', { name: 'C' });
  assert.equal(ob.size(), 1);
  const sent = ob.snapshot();
  const ack = ob.ack(sent, [{ c: 'leads', id: 'l1', updatedAt: 30 }]);
  assert.deepEqual([ack.ok.length, ob.size()], [1, 0]);
  ob.put('leads', 'l2', {});
  const s2 = ob.snapshot();
  ob.put('leads', 'l2', { name: 'later' });
  ob.ack(s2, [{ c: 'leads', id: 'l2', code: 'STALE', current: { data: {} } }]);
  assert.equal(ob.size(), 1, '보낸 뒤 다시 바뀐 문서는 큐에 남아야 한다');
});

t('라우트·초대 링크·HubSpot 레코드 링크', () => {
  assert.deepEqual(C.routeOf('#/lead/abc-1'), { route: 'lead', id: 'abc-1', code: '' });
  assert.deepEqual(C.routeOf('#/hubspot'), { route: 'hubspot', id: '', code: '' });
  assert.deepEqual(C.routeOf('#/lead/'), { route: 'today', id: '', code: '' });
  assert.equal(C.routeOf('#c=abcd1234').code, 'abcd1234');
  assert.equal(C.routeOf('#/nowhere').route, 'today');
  assert.equal(C.inviteLink('https://x.test', '/index.html', 'k1'), 'https://x.test/#c=k1');
  assert.equal(C.hubspotRecordUrl({ portalId: 123, uiDomain: 'app-na2.hubspot.com' }, 'contact', '77'), 'https://app-na2.hubspot.com/contacts/123/record/0-1/77');
  assert.equal(C.hubspotRecordUrl({ portalId: 123, uiDomain: 'evil.example' }, 'deal', '9'), 'https://app.hubspot.com/contacts/123/record/0-3/9');
  assert.equal(C.hubspotRecordUrl({}, 'contact', '1'), '');
});

t('파트너 연계 — 채널 감지(파트너가 소개보다 먼저), 파트너·소개 검증, 거친 단계, 월 집계·정산 문구', () => {
  assert.equal(C.detectChannel('옆 수학학원 원장님 소개로 왔어요').channel, '파트너');
  assert.equal(C.detectChannel('친구 소개로 왔어요').channel, '지인추천');
  assert.ok(C.CHANNELS.includes('파트너'));
  assert.equal(C.validatePartner({}).ok, false);
  const p = C.validatePartner({ name: ' 가나수학 ', kind: '수학', phone: '01000000000', link: 'https://example.org/x', terms: { inbound: '검사비 20% 할인', outbound: '첫 달 10% 할인' }, status: 'bogus' }, { today: TODAY });
  assert.ok(p.ok, p.error);
  assert.deepEqual([p.data.name, p.data.phone, p.data.status, p.data.terms.inbound, p.data.createdAt], ['가나수학', '010-0000-0000', 'active', '검사비 20% 할인', TODAY]);
  assert.equal(C.validatePartner({ name: 'x', link: 'http://insecure' }).ok, false);
  assert.equal(C.validateReferral({ leadId: 'l1' }).ok, false);
  const r = C.validateReferral({ leadId: 'l1', partnerId: 'p1', status: 'nope', note: '수학 보강 필요' }, { today: TODAY });
  assert.deepEqual([r.data.direction, r.data.status, r.data.at], ['out', 'sent', TODAY]);
  // 리드의 partnerId 는 채널이 파트너일 때만 남는다
  assert.equal(C.validateLead({ name: 'A', channel: '파트너', partnerId: 'p1' }).data.partnerId, 'p1');
  assert.equal(C.validateLead({ name: 'A', channel: '맘카페', partnerId: 'p1' }).data.partnerId, '');
  assert.deepEqual([C.coarseStage({ stage: 'upsell' }), C.coarseStage({ stage: 'trial' }), C.coarseStage({ stage: 'lost' }), C.coarseStage({})], ['검사 완료', '등록', '종료', '접수']);
  const leads = [
    { id: 'a', partnerId: 'p1', createdAt: '2026-10-01', consultedAt: '2026-10-03', status: 'won' },
    { id: 'b', partnerId: 'p1', createdAt: '2026-10-02', status: 'open' },
    { id: 'c', partnerId: 'p1', createdAt: '2026-09-02', status: 'lost' },
    { id: 'd', partnerId: 'p2', createdAt: '2026-10-02', inspection: { date: '2026-10-04' }, status: 'open' }
  ];
  const refs = [{ partnerId: 'p1', at: '2026-10-05', status: 'enrolled' }, { partnerId: 'p1', at: '2026-10-06', status: 'sent' }, { partnerId: 'p1', at: '2026-08-01', status: 'declined' }];
  const stats = C.partnerStats(leads, refs, [{ id: 'p1', name: '가나수학', status: 'active' }, { id: 'p2', name: '다라영어', status: 'paused' }], '2026-10');
  assert.deepEqual([stats[0].inbound, stats[0].inboundTested, stats[0].inboundWon, stats[0].outbound, stats[0].outboundEnrolled, stats[0].outboundOpen], [2, 1, 1, 2, 1, 1]);
  assert.deepEqual([stats[1].inbound, stats[1].inboundTested], [1, 1]);
  assert.equal(C.partnerStats(leads, refs, [{ id: 'p1', name: 'x' }], '').pop().inbound, 3);
  const text = C.partnerStatement(stats[0], '2026-10', { inbound: '검사비 20% 할인' });
  assert.ok(text.includes('2026년 10월') && text.includes('가나수학') && text.includes('2가정') && text.includes('검사비 20% 할인'));
  assert.ok(!/010-/.test(text), '정산 문구에 전화번호가 없다');
  // 문서 병합에 partners·referrals 가 들어간다
  const st = C.mergeDocs(C.emptyState(), [{ c: 'partners', id: 'p1', data: { name: 'x' }, updatedAt: 1 }, { c: 'referrals', id: 'r1', data: { leadId: 'a' }, updatedAt: 2 }], []).local;
  assert.deepEqual([st.partners.length, st.referrals.length], [1, 1]);
  assert.equal(C.routeOf('#/partners').route, 'partners');
});

console.log('crm-core: ' + passed + ' 통과');
