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

t('PII 패턴 — 전화·이메일·주민번호를 찾고, 허용 경로(phone·email)와 skip 아래는 건너뛴다', () => {
  assert.ok(C.hasPii('연락 010-1234-5678') && C.hasPii('a@b.co') && C.hasPii('900101-1234567') && !C.hasPii('초3 아이'));
  assert.equal(C.findPii({ name: 'A', phone: '010-1234-5678', email: 'a@b.co', memo: '없음' }), null);
  assert.equal(C.findPii({ name: 'A', memo: '엄마 010-1234-5678' }), 'memo');
  assert.equal(C.findPii({ child: { school: '02-123-4567' } }), 'child.school');
  assert.equal(C.findPii({ hubspot: { contactId: '1234561234567' } }, '', ['hubspot']), null, 'skip 아래는 보지 않는다');
  assert.equal(C.findPii({ hubspot: { contactId: '1234561234567' } }), 'hubspot.contactId');
  assert.equal(C.findPii(['x', '010-0000-0000'], 'list'), 'list[1]');
});

t('관계관리 회원 — 친구·서포터즈 구분과 필수값·실제 날짜를 검증한다', () => {
  const raw = { leadId: 'l1', program: 'friend', startDate: '2026-10-01', owner: 's1', status: 'active', benefitState: 'unchecked', nextContactDate: TODAY, nextAction: '다음 활동 안내', note: '상담 후 참여' };
  const friend = C.validateMembership(raw, { today: TODAY });
  const supporter = C.validateMembership({ ...raw, program: 'supporter', status: 'paused', benefitState: 'paused', pauseDate: TODAY }, { today: TODAY });
  assert.ok(friend.ok, friend.error);
  assert.ok(supporter.ok, supporter.error);
  assert.deepEqual([friend.data.program, supporter.data.program, supporter.data.status, supporter.data.benefitState], ['friend', 'supporter', 'paused', 'paused']);
  assert.equal(C.validateMembership({ ...raw, leadId: '' }).ok, false);
  assert.equal(C.validateMembership({ ...raw, program: '' }).ok, false);
  for (const program of ['__proto__', 'constructor', 'toString', ['friend'], { toString: null }]) {
    assert.equal(C.validateMembership({ ...raw, program }).ok, false, '프로그램은 목록에 있는 문자열만 허용한다');
  }
  assert.equal(C.validateMembership({ ...raw, startDate: '' }).ok, false);
  assert.equal(C.validateMembership({ ...raw, nextAction: '' }).ok, false, '다음 연락일에는 할 일이 필요하다');
  assert.equal(C.validateMembership({ ...raw, nextContactDate: '' }).ok, false, '다음 할 일에는 연락일이 필요하다');
  assert.ok(C.validateMembership({ ...raw, nextContactDate: '', nextAction: '' }).ok);
  for (const key of ['startDate', 'nextContactDate', 'pauseDate', 'resumeDate']) {
    assert.equal(C.validateMembership({ ...raw, [key]: '2026-02-29' }).ok, false, key + '는 존재하는 날짜여야 한다');
    for (const date of [['2026-10-01'], { toString: null }]) assert.equal(C.validateMembership({ ...raw, [key]: date }).ok, false, key + '는 문자열이어야 한다');
  }
  assert.ok(C.validateMembership({ ...raw, startDate: '2024-02-29' }).ok, '윤년의 2월 29일은 허용한다');
});

t('프로그램 활동 — 월·날짜 검증, 회원별 월 상태는 확인·보완·대기 순이다', () => {
  const raw = { membershipId: 'm-friend', month: '2026-10', kind: 'review', date: '2026-10-01', evidence: '후기 작성 확인', status: 'confirmed', note: '', by: 's1' };
  const valid = C.validateProgramActivity(raw, { today: TODAY });
  assert.ok(valid.ok, valid.error);
  assert.deepEqual([valid.data.membershipId, valid.data.month, valid.data.status], ['m-friend', '2026-10', 'confirmed']);
  for (const patch of [{ membershipId: '' }, { month: '' }, { month: '2026-13' }, { month: '2026-1' }, { month: ['2026-10'] }, { kind: '' }, { date: '' }, { date: '2026-04-31' }, { date: ['2026-10-01'] }, { date: { toString: null } }]) {
    assert.equal(C.validateProgramActivity({ ...raw, ...patch }).ok, false, JSON.stringify(patch));
  }
  const activities = [{ ...raw, membershipId: 'm-supporter' }, { ...raw, month: '2026-09' }];
  assert.equal(C.programMonthStatus('m-friend', '2026-10', activities), 'missing', '다른 프로그램 회원·다른 달 기록을 가져오지 않는다');
  activities.push({ ...raw, status: 'pending' });
  assert.equal(C.programMonthStatus('m-friend', '2026-10', activities), 'pending');
  activities.push({ ...raw, status: 'supplement' });
  assert.equal(C.programMonthStatus('m-friend', '2026-10', activities), 'supplement');
  activities.push(raw, { ...raw, status: 'pending' });
  assert.equal(C.programMonthStatus('m-friend', '2026-10', activities), 'confirmed');
  assert.equal(C.programMonthStatus('m-friend', '2026-10', [null, 1, 'noise', ...activities]), 'confirmed');
});

t('프로그램 검사 — 필수 주기·예정일과 예약·완료일의 실제 날짜를 검증한다', () => {
  const raw = { membershipId: 'm-supporter', cycleStart: '2026-10-01', cycleEnd: '2026-12-31', dueDate: '2026-12-31', bookedDate: '2026-12-20', completedDate: '2026-12-21', activitiesChecked: true, note: '활동 기록 확인' };
  const valid = C.validateProgramExam(raw, { today: TODAY });
  assert.ok(valid.ok, valid.error);
  assert.deepEqual([valid.data.membershipId, valid.data.completedDate, valid.data.activitiesChecked], ['m-supporter', '2026-12-21', true]);
  assert.equal(C.validateProgramExam({ ...raw, membershipId: '' }).ok, false);
  for (const key of ['cycleStart', 'cycleEnd', 'dueDate']) assert.equal(C.validateProgramExam({ ...raw, [key]: '' }).ok, false, key + '는 필수다');
  for (const key of ['cycleStart', 'cycleEnd', 'dueDate', 'bookedDate', 'completedDate']) {
    assert.equal(C.validateProgramExam({ ...raw, [key]: '2026-02-29' }).ok, false, key + '는 존재하는 날짜여야 한다');
    for (const date of [['2026-10-01'], { toString: null }]) assert.equal(C.validateProgramExam({ ...raw, [key]: date }).ok, false, key + '는 문자열이어야 한다');
  }
  assert.equal(C.validateProgramExam({ ...raw, cycleStart: '2027-01-01' }).ok, false, '주기 시작은 종료보다 늦을 수 없다');
});

t('모임 — 확정·참석만 정원에 포함하고 중복·미확인 참가자는 거절한다', () => {
  const participants = ['confirmed', 'confirmed', 'attended', 'invited', 'invited', 'absent', 'cancelled'].map((status, i) => ({ leadId: 'l' + i, status, inspectionConfirmed: true, nextContactDate: '', nextAction: '', note: '' }));
  const raw = { topic: '검사 후 독서 이야기', date: TODAY, time: '10:30', place: '상담실', capacity: 4, status: 'planned', owner: 's1', note: '', participantsChecked: true, participants };
  const valid = C.validateGathering(raw, { today: TODAY });
  assert.ok(valid.ok, valid.error);
  assert.equal(valid.data.participants.length, 7, '초대 후보·결석·취소 기록은 정원이 차도 보존한다');
  assert.equal(valid.data.participantsChecked, true);
  assert.equal(C.validateGathering({ ...raw, participantsChecked: false }).ok, false, '확정·참석자가 있으면 참가자 확인이 필요하다');
  assert.ok(C.validateGathering({ ...raw, participantsChecked: false, owner: '', place: '', participants: [{ ...participants[0], status: 'invited' }] }).ok, '초대 후보만 있으면 확인 전에도 저장한다');
  assert.ok(C.validateGathering({ ...raw, participants: [participants[0]] }).ok, '확정 인원이 정원보다 적어도 저장한다');
  const full = [...participants, { leadId: 'l7', status: 'confirmed', inspectionConfirmed: true }];
  assert.ok(C.validateGathering({ ...raw, participants: full }).ok);
  assert.equal(C.validateGathering({ ...raw, participants: [...full, { leadId: 'l8', status: 'attended', inspectionConfirmed: true }] }).ok, false);
  assert.equal(C.validateGathering({ ...raw, participantsChecked: false, participants: Array.from({ length: 5 }, (_, i) => ({ leadId: 'l' + i, status: ['confirmed'], inspectionConfirmed: true })) }).ok, false, '배열 상태값으로 정원·참가자 확인을 우회할 수 없다');
  assert.equal(C.validateGathering({ ...raw, participants: [...participants, { ...participants[0], status: 'cancelled' }] }).ok, false);
  for (const inspectionConfirmed of [false, 'true', undefined]) {
    assert.equal(C.validateGathering({ ...raw, participants: [{ ...participants[0], inspectionConfirmed }] }).ok, false);
  }
  for (const patch of [{ nextContactDate: TODAY, nextAction: '' }, { nextContactDate: '', nextAction: '참석 확인' }]) {
    assert.equal(C.validateGathering({ ...raw, participants: [{ ...participants[0], ...patch }] }).ok, false, '참가자 연락일과 할 일은 함께 입력한다');
  }
  for (const capacity of [3, 7, 4.5, [4]]) assert.equal(C.validateGathering({ ...raw, capacity }).ok, false);
  for (const capacity of [5, 6]) assert.ok(C.validateGathering({ ...raw, capacity }).ok);
  for (const patch of [{ topic: '' }, { date: '' }, { date: '2026-04-31' }, { date: ['2026-10-01'] }, { date: { toString: null } }, { time: '' }, { time: '24:00' }]) assert.equal(C.validateGathering({ ...raw, ...patch }).ok, false);
  for (const date of [['2026-10-01'], { toString: null }]) assert.equal(C.validateGathering({ ...raw, participants: [{ ...participants[0], nextContactDate: date, nextAction: '참석 확인' }] }).ok, false);
});

t('검사 완료 자격 — 실제 검사일 또는 검사 단계만 인정하고 상담일·성사만으로 추정하지 않는다', () => {
  for (const stage of ['tested', 'interpreted', 'upsell']) assert.equal(C.hasCompletedInspection({ pipeline: 'inspection', stage }, TODAY), true);
  assert.equal(C.hasCompletedInspection({ pipeline: 'academy', stage: 'active', inspection: { date: TODAY } }, TODAY), true);
  assert.equal(C.hasCompletedInspection({ inspection: { date: '2024-02-29' } }, TODAY), true);
  for (const lead of [null, {}, { consultedAt: '2026-10-01' }, { inspection: { date: '2026-10-07' } }, { inspection: { date: '2026-02-29' } }, { pipeline: 'inspection', stage: 'won' }, { pipeline: 'academy', stage: 'tested' }, { pipeline: 'academy', stage: 'active' }]) {
    assert.equal(C.hasCompletedInspection(lead, TODAY), false, JSON.stringify(lead));
  }
});

t('관계 연락 작업 — 오늘·연체만, 중지는 유지하고 종료·취소·빈 할 일은 제외한다', () => {
  const base = { leadId: 'l1', program: 'friend', status: 'active', nextContactDate: TODAY, nextAction: '활동 안내' };
  const memberships = [
    { ...base, id: 'm-today' }, { ...base, id: 'm-paused', program: 'supporter', status: 'paused', nextContactDate: '2026-10-01' },
    { ...base, id: 'm-ended', status: 'ended' }, { ...base, id: 'm-future', nextContactDate: '2026-10-07' },
    { ...base, id: 'm-empty', nextAction: '   ' }, { ...base, id: 'm-no-date', nextContactDate: '' }, { ...base, id: 'm-invalid', nextContactDate: '2026-02-29' }
  ];
  const participant = { leadId: 'l2', status: 'confirmed', nextContactDate: TODAY, nextAction: '참석 확인' };
  const gatherings = [
    { id: 'g-planned', status: 'planned', participants: [participant, { ...participant, leadId: 'l3', status: 'cancelled' }, { ...participant, leadId: 'l4', nextAction: '' }] },
    { id: 'g-completed', status: 'completed', participants: [{ ...participant, status: 'attended' }] },
    { id: 'g-cancelled', status: 'cancelled', participants: [participant] },
    { id: 'g-future', status: 'planned', participants: [{ ...participant, nextContactDate: '2026-10-07' }] }
  ];
  const before = JSON.stringify([memberships, gatherings]);
  assert.deepEqual(C.relationshipTasks([null, ...memberships], [null, ...gatherings, { id: 'g-noise', participants: [null, 1, 'noise'] }], TODAY).map(x => [x.source, x.id]).sort(), [
    ['gathering', 'g-completed'], ['gathering', 'g-planned'], ['membership', 'm-paused'], ['membership', 'm-today']
  ]);
  assert.equal(JSON.stringify([memberships, gatherings]), before, '할 일 조회가 원본 상태를 바꾸지 않는다');
});

t('관계관리 문서 — 네 컬렉션의 병합·충돌 보호·삭제와 라우트를 지원한다', () => {
  const collections = ['memberships', 'programActivities', 'programExams', 'gatherings'];
  const empty = C.emptyState();
  for (const c of collections) {
    assert.deepEqual(empty[c], []);
    assert.ok(C.COLLECTIONS.includes(c), c + ' 동기화 컬렉션이 있어야 한다');
  }
  const docs = collections.map((c, i) => ({ c, id: 'r' + i, data: { note: '원본' }, updatedAt: 10 }));
  const merged = C.mergeDocs(empty, docs, []);
  assert.equal(merged.changed, 4);
  for (const doc of docs) {
    assert.equal(merged.local[doc.c][0].id, doc.id);
    assert.deepEqual(C.revertDoc(merged.local, doc.c + '|' + doc.id).data, { note: '원본' });
  }
  const stale = C.mergeDocs(merged.local, docs.map(d => ({ ...d, data: { note: '이전' }, updatedAt: 5 })), []);
  assert.equal(stale.changed, 0);
  const pending = C.mergeDocs(merged.local, [{ ...docs[0], data: { note: '서버' }, updatedAt: 20 }], ['memberships|r0']);
  assert.deepEqual([pending.skipped, pending.local.memberships[0].note], [1, '원본']);
  const removed = C.mergeDocs(merged.local, docs.map(d => ({ ...d, deleted: true, updatedAt: 20 })), []);
  for (const c of collections) assert.deepEqual(removed.local[c], []);
  assert.equal(C.routeOf('#/relationships').route, 'relationships');
});

console.log('crm-core: ' + passed + ' 통과');
