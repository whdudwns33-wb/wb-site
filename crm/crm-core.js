/* WB 세일즈데스크 — 순수 로직 (브라우저 app.js 와 서버 crm-api.mjs 가 같은 파일을 읽는다)
 *
 * 왜 한 파일인가: 단계 이름·채널 목록·팔로업 일정·검증 규칙을 화면과 서버가 따로 들고 있으면 한쪽만 고쳐져
 * "화면은 받는데 서버는 거절"하는 상태가 생긴다. 여기 한 곳이 정본이고, 외부 의존성 없이 Node 와 브라우저에서 돈다.
 *
 * 도메인(원장 CRM 운영 규칙, 2026-04 agent-crm 정리본을 코드로 옮김):
 *   · 파이프라인 2개 — 검사 여정(신규문의→연락완료→예약확정→검사완료→해석완료→업셀제안→성사/미성사),
 *     학원 등록(트라이얼→트라이얼검토→활성→이탈위험→이탈→성사/미성사). 이름은 원장의 HubSpot 딜 파이프라인과 같게 둬서
 *     단계 자동 매핑(라벨 일치)이 바로 걸린다.
 *   · 상담·CS 가 끝난 날이 기준점 — D+3 팔로업1 · D+7 팔로업2 · D+14 최종판정(등록/보류/이탈+사유 P·T·C·W·N·U).
 *   · 유입 채널은 HubSpot 의 wb_source_channel 값 그대로(맘카페·블로그·인스타·당근·지인추천·센터폰·기타). 문의 원문의 낱말로 추정하되
 *     2개 이상 걸리면 지인추천 > 블로그 > 맘카페 > 인스타 > 당근 > 센터폰 순.
 *   · 재검사 예정일 = 검사일 + 730일(시선추적은 365일). D-30 첫 안내 · D-7 독려 · D-day 원장 직접 통화.
 *   · 소개 크레딧 v2.0(2026-05-01~): 건당 15,000원, 같은 소개자 30일 쿨다운, 24개월 뒤 소멸. 원장은 append-only.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBCrmCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ── 상수 ─────────────────────────────────────────── */

  const PIPELINES = ['inspection', 'academy'];
  const PIPELINE_LABEL = { inspection: '검사 여정', academy: '학원 등록' };
  const STAGES = {
    inspection: ['inquiry', 'contacted', 'booked', 'tested', 'interpreted', 'upsell', 'won', 'lost'],
    academy: ['trial', 'trial_review', 'active', 'at_risk', 'churned', 'won', 'lost']
  };
  const STAGE_LABEL = {
    inquiry: '신규문의', contacted: '연락완료', booked: '예약확정', tested: '검사완료', interpreted: '해석완료', upsell: '업셀제안',
    won: '성사(등록)', lost: '미성사',
    trial: '트라이얼', trial_review: '트라이얼검토', active: '활성', at_risk: '이탈위험', churned: '이탈'
  };
  /* HubSpot 쪽 라벨이 우리 라벨과 다를 수 있는 단계 — 자동 매핑에서 같은 뜻으로 본다. */
  const STAGE_ALIASES = {
    won: ['성사(등록)', '성사된 거래', '성사', '등록', 'closed won', 'closedwon'],
    lost: ['미성사', '성사되지 않은 거래', 'closed lost', 'closedlost'],
    inquiry: ['신규문의', '신규 문의', 'new lead'], contacted: ['연락완료', '연락 완료', 'contacted'],
    booked: ['예약확정', '예약 확정', 'booked'], tested: ['검사완료', '검사 완료', 'inspection done'],
    interpreted: ['해석완료', '해석 완료', 'interpretation done'], upsell: ['업셀제안', '업셀 제안', 'upsell proposed'],
    trial: ['트라이얼', 'trial'], trial_review: ['트라이얼검토', '트라이얼 검토', 'trial reviewed'], active: ['활성', 'active'],
    at_risk: ['이탈위험', '이탈 위험', 'at risk'], churned: ['이탈', 'churned']
  };
  const CLOSED_STAGES = ['won', 'lost', 'churned'];
  const STATUSES = ['open', 'hold', 'won', 'lost'];
  const STATUS_LABEL = { open: '진행', hold: '장기보류', won: '등록', lost: '이탈' };

  const CHANNELS = ['맘카페', '블로그', '인스타', '당근', '지인추천', '파트너', '센터폰', '기타'];
  /* 파트너(연계 학원)가 보낸 가정은 소개보다 먼저 가린다 — 정산·통계가 파트너 몫으로 잡혀야 한다. */
  const CHANNEL_PRIORITY = ['파트너', '지인추천', '블로그', '맘카페', '인스타', '당근', '센터폰'];
  const CHANNEL_KEYWORDS = {
    맘카페: ['맘카페', '맘스홀릭', '맘스', '카페에서', '카페 보고', '카페보고', '판교맘', '광주맘', '분당맘', '맘카'],
    블로그: ['블로그', '네이버', '검색', '플레이스', '지도', '포스팅'],
    인스타: ['인스타', 'instagram', '릴스', '인스타그램', 'dm'],
    당근: ['당근', '동네생활', '당근마켓'],
    지인추천: ['소개', '추천', '지인', '엄마가 알려', '친구 엄마', '소개받'],
    파트너: ['파트너', '원장님 소개', '학원 소개', '학원에서 소개', '학원 선생님이', '연계 학원'],
    센터폰: ['센터폰', '전화로', '대표번호', '전화 문의', '전화문의']
  };
  const HOT_KEYWORDS = {
    urgency: ['오늘', '내일', '이번주', '이번 주', '지금 바로', '빨리', '가능한가요', '당장', '급해'],
    concrete: ['예약', '방문', '결제', '가격', '비용', '얼마', '시간 있', '언제 가능'],
    intent: ['받아보고 싶', '하고 싶', '신청', '진행', '부탁드립니다', '등록하고', '시작하고'],
    premium: ['웩슬러', 'lcsi', '풀세트', '종합검사', '컨설팅까지', '풀 세트', '종합 검사']
  };

  const INSPECTION_TYPES = ['웩슬러', 'LCSI', '성향기질', '시선추적', '복합'];
  const RETEST_DAYS = { 시선추적: 365 };
  const RETEST_DEFAULT_DAYS = 730;
  const RETEST_WINDOWS = [30, 7, 0];

  const FOLLOWUP_OFFSETS = [3, 7, 14];
  const FOLLOWUP_LABEL = { 3: '팔로업1', 7: '팔로업2', 14: '최종판정' };
  const FOLLOWUP_STATUS = ['pending', 'done', 'skipped'];
  const FOLLOWUP_RESULTS = ['reached', 'replied', 'no_answer', 'none'];
  const RESULT_LABEL = { reached: '연락됨', replied: '답장 옴', no_answer: '부재중', none: '—' };

  const LOST_REASONS = ['P', 'T', 'C', 'W', 'N', 'U'];
  const LOST_REASON_LABEL = { P: '가격', T: '시간·거리', C: '경쟁사', W: '관망', N: '필요성 못 느낌', U: '미확인' };

  const INTERESTS = ['검사', '학원', '컨설팅'];
  const RELATIONS = ['모', '부', '기타'];
  const RELATION_HONORIFIC = { 모: '어머니', 부: '아버님', 기타: '보호자님' };

  const ACTIVITY_TYPES = ['consult', 'cs', 'call', 'msg', 'visit', 'note', 'stage', 'followup', 'hubspot'];
  const ACTIVITY_LABEL = { consult: '상담', cs: 'CS', call: '통화', msg: '문자·카톡', visit: '방문', note: '메모', stage: '단계 변경', followup: '팔로업', hubspot: 'HubSpot' };
  /* 상담·CS 가 끝나면 팔로업 일정이 시작된다 — 이 두 종류만 기준점이 될 수 있다. */
  const ANCHOR_TYPES = ['consult', 'cs'];

  const CREDIT_AMOUNT = 15000;
  const CREDIT_COOLDOWN_DAYS = 30;
  const CREDIT_EXPIRE_MONTHS = 24;
  const CREDIT_TYPES = ['accrue', 'use', 'expire', 'adjust'];
  const CREDIT_LABEL = { accrue: '적립', use: '사용', expire: '소멸', adjust: '조정' };

  const ROUTES = ['login', 'today', 'pipeline', 'leads', 'lead', 'relationships', 'stats', 'hubspot', 'partners', 'admin'];
  const OWNER_ROUTES = ['hubspot', 'partners', 'admin'];

  const PROGRAM_LABEL = { friend: '친구맺기', supporter: '서포터즈' };
  const MEMBERSHIP_STATUS_LABEL = { active: '참여 중', paused: '일시 중지', ended: '종료' };
  const PROGRAM_ACTIVITY_LABEL = { review: '리뷰', referral: '소개', brunch: '브런치' };
  const PROGRAM_ACTIVITY_STATUS_LABEL = { pending: '확인 대기', confirmed: '확인 완료', supplement: '보완 필요' };
  const BENEFIT_STATE_LABEL = { unchecked: '미확인', confirmed: '확인 완료', paused: '보류' };
  const GATHERING_STATUS_LABEL = { planned: '예정', completed: '완료', cancelled: '취소' };
  const ATTENDANCE_LABEL = { invited: '초대', confirmed: '참석 확정', attended: '참석', absent: '불참', cancelled: '취소' };

  /* 파트너 학원 연계 — 들어오는 소개(파트너→센터)는 리드의 partnerId, 나가는 소개(센터→파트너)는 referrals 문서. */
  const PARTNER_STATUS = ['active', 'paused'];
  const PARTNER_STATUS_LABEL = { active: '연계 중', paused: '일시 중지' };
  const REFERRAL_STATUS = ['sent', 'contacted', 'enrolled', 'declined'];
  const REFERRAL_STATUS_LABEL = { sent: '보냄', contacted: '연락됨', enrolled: '등록', declined: '미등록' };
  /* 파트너 포털에는 우리 단계를 거친 묶음으로만 보여 준다 — 내부 운영 단계(업셀 제안 등)는 밖으로 나가지 않는다. */
  const COARSE_STAGE_LABEL = { inquiry: '접수', contacted: '접수', booked: '예약', tested: '검사 완료', interpreted: '검사 완료', upsell: '검사 완료', won: '등록', lost: '종료',
    trial: '등록', trial_review: '등록', active: '등록', at_risk: '등록', churned: '종료' };

  /* 동기화 트랙 — 빠른 입력(연락처·메모)은 quick, 상태 전이(딜 단계)는 review. 원장 승인 뒤에만 HubSpot 으로 간다(기본값). */
  const SYNC_KINDS = ['contact', 'deal', 'note'];
  const SYNC_KIND_LABEL = { contact: '연락처', deal: '딜 단계', note: '기록(노트)' };
  const SYNC_TRACKS = ['quick', 'review'];
  const SYNC_TRACK_LABEL = { quick: '빠른 입력', review: '검토 필요' };
  const SYNC_STATUS = ['pending', 'approved', 'done', 'failed', 'rejected'];
  const SYNC_STATUS_LABEL = { pending: '승인 대기', approved: '반영 대기', done: '반영됨', failed: '실패', rejected: '반려' };

  const MAX_TEXT = 1000;
  const MAX_NAME = 40;

  /* 개인정보 패턴 — 전화·이메일·주민번호. 실명은 정규식으로 가를 수 없어 "패턴"만 본다. 서버가 거부하는 규칙과 같은 것이라
   * 화면도 저장 전에 같은 검사로 막는다(저장이 거절되면 리드가 사라진 것처럼 보이기 때문). 전화는 phone, 이메일은 email 칸에만. */
  const PII_PATTERNS = [
    /01[0-9]-?\d{3,4}-?\d{4}/,
    /0\d{1,2}-\d{3,4}-\d{4}/,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/,
    /\d{6}-?[1-4]\d{6}/
  ];
  const PII_ALLOWED_PATHS = ['phone', 'email'];
  function hasPii(text) { return PII_PATTERNS.some(p => p.test(str(text))); }
  /** 문자열 값을 전부 훑어 PII 패턴이 있는 첫 경로를 돌려준다. skip 에 든 경로(점 표기)는 그 아래 전부 건너뛴다. */
  function findPii(value, path, skip) {
    const skipSet = skip instanceof Set ? skip : new Set(Array.isArray(skip) ? skip : PII_ALLOWED_PATHS);
    if (typeof value === 'string') return hasPii(value) ? (path || '(값)') : null;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) { const f = findPii(value[i], path + '[' + i + ']', skipSet); if (f) return f; }
      return null;
    }
    if (isObj(value)) {
      for (const key of Object.keys(value)) {
        const next = path ? path + '.' + key : key;
        if (skipSet.has(next)) continue;
        const f = findPii(value[key], next, skipSet);
        if (f) return f;
      }
    }
    return null;
  }

  /* ── 도우미 ───────────────────────────────────────── */

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return v == null ? '' : String(v); }
  function clean(v, max) { return str(v).normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max || MAX_TEXT); }
  function cleanMulti(v, max) { return str(v).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, max || MAX_TEXT); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymdOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseYmd(s) {
    const m = str(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return ymdOf(d) === s ? d : null;
  }
  function validYmd(s) { return !!parseYmd(s); }
  function addDays(s, n) {
    const d = parseYmd(s);
    if (!d) return '';
    d.setDate(d.getDate() + Number(n || 0));
    return ymdOf(d);
  }
  function addMonths(s, n) {
    const d = parseYmd(s);
    if (!d) return '';
    d.setMonth(d.getMonth() + Number(n || 0));
    return ymdOf(d);
  }
  /** b − a (일). 날짜가 깨졌으면 null. */
  function daysBetween(a, b) {
    const da = parseYmd(a), db = parseYmd(b);
    if (!da || !db) return null;
    return Math.round((db - da) / 86400000);
  }
  function ymOf(s) { return validYmd(s) ? str(s).slice(0, 7) : ''; }
  function weekdayKo(s) {
    const d = parseYmd(s);
    return d ? ['일', '월', '화', '수', '목', '금', '토'][d.getDay()] + '요일' : '';
  }
  /** 받침이 있으면 '이'를 붙인다(민준→민준이, 서아→서아). 한글이 아니면 그대로. */
  function childCall(name) {
    const n = clean(name, MAX_NAME);
    if (!n) return '아이';
    const code = n.charCodeAt(n.length - 1);
    if (code < 0xAC00 || code > 0xD7A3) return n;
    return (code - 0xAC00) % 28 === 0 ? n : n + '이';
  }

  function normalizePhone(raw) {
    const digits = str(raw).replace(/\D/g, '');
    if (!digits) return '';
    const n = digits.length;
    if (n === 11) return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
    if (n === 10) return digits.startsWith('02')
      ? digits.slice(0, 2) + '-' + digits.slice(2, 6) + '-' + digits.slice(6)
      : digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
    if (n === 9 && digits.startsWith('02')) return digits.slice(0, 2) + '-' + digits.slice(2, 5) + '-' + digits.slice(5);
    return digits;
  }
  function maskPhone(raw) {
    const f = normalizePhone(raw);
    if (!f) return '';
    const parts = f.split('-');
    if (parts.length === 3) return parts[0] + '-' + '*'.repeat(parts[1].length) + '-' + parts[2];
    return '*'.repeat(Math.max(0, f.length - 4)) + f.slice(-4);
  }
  function validEmail(v) { return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(str(v)); }

  /* ── 채널·HOT 감지 ───────────────────────────────── */

  /** 문의 원문 → { channel, hits, confidence }. 단서가 없으면 '기타'·low. */
  function detectChannel(text) {
    const t = str(text).toLowerCase();
    const found = [];
    CHANNEL_PRIORITY.forEach(ch => {
      const hit = (CHANNEL_KEYWORDS[ch] || []).find(k => t.includes(k.toLowerCase()));
      if (hit) found.push({ channel: ch, keyword: hit });
    });
    if (!found.length) return { channel: '기타', hits: [], confidence: t.replace(/\s/g, '').length < 15 ? 'low' : 'none' };
    return { channel: found[0].channel, hits: found, confidence: found.length > 1 ? 'medium' : 'high' };
  }
  /** HOT 리드 — 2개 이상 걸리면 high, 1개면 medium. high 만 자동으로 핫 표시한다. */
  function detectHot(text) {
    const t = str(text).toLowerCase();
    const hits = [];
    Object.keys(HOT_KEYWORDS).forEach(group => {
      HOT_KEYWORDS[group].forEach(k => { if (t.includes(k.toLowerCase())) hits.push({ group: group, keyword: k }); });
    });
    const groups = new Set(hits.map(h => h.group));
    const confidence = groups.size >= 2 ? 'high' : (hits.length ? 'medium' : 'none');
    return { hot: confidence === 'high', confidence: confidence, hits: hits };
  }

  /* ── 재검사·팔로업 ───────────────────────────────── */

  function retestDays(type) { return RETEST_DAYS[str(type)] || RETEST_DEFAULT_DAYS; }
  function retestDue(inspectionDate, type) { return validYmd(inspectionDate) ? addDays(inspectionDate, retestDays(type)) : ''; }
  /** 재검사 창 — { window: 30|7|0|'overdue', days } 또는 null(아직 멀다). */
  function retestWindow(due, today) {
    const d = daysBetween(today, due);
    if (d === null) return null;
    if (d < 0) return { window: 'overdue', days: d };
    if (d === 0) return { window: 0, days: 0 };
    if (d <= 7) return { window: 7, days: d };
    if (d <= 30) return { window: 30, days: d };
    return null;
  }

  function scheduleFollowups(anchor, offsets) {
    if (!validYmd(anchor)) return [];
    return (Array.isArray(offsets) && offsets.length ? offsets : FOLLOWUP_OFFSETS).map(n => ({
      day: Number(n), due: addDays(anchor, n), status: 'pending', doneAt: '', result: '', note: ''
    }));
  }
  /** 리드의 팔로업 중 오늘 해야 할 것 — due ≤ today 이고 pending. overdue 는 며칠 밀렸는지. */
  function dueFollowups(lead, today) {
    const fus = isObj(lead) && Array.isArray(lead.followups) ? lead.followups : [];
    return fus.filter(f => isObj(f) && f.status === 'pending' && validYmd(f.due) && daysBetween(f.due, today) >= 0)
      .map(f => Object.assign({}, f, { late: daysBetween(f.due, today) }));
  }
  function nextFollowup(lead) {
    const fus = isObj(lead) && Array.isArray(lead.followups) ? lead.followups : [];
    return fus.filter(f => isObj(f) && f.status === 'pending').sort((a, b) => str(a.due).localeCompare(str(b.due)))[0] || null;
  }
  function markFollowup(followups, day, patch) {
    return (Array.isArray(followups) ? followups : []).map(f => (isObj(f) && Number(f.day) === Number(day) ? Object.assign({}, f, patch) : f));
  }

  /** 팔로업 문자 초안 — agent-sales 템플릿. D+3 에는 등록·수강료를 쓰지 않는다. */
  function messageDraft(day, lead) {
    const L = isObj(lead) ? lead : {};
    const who = RELATION_HONORIFIC[str(L.relation)] || RELATION_HONORIFIC['기타'];
    const child = childCall(isObj(L.child) ? L.child.name : '');
    const ins = isObj(L.inspection) ? L.inspection : {};
    const strength = clean(L.strength, 120) || '[검사에서 돋보인 강점 한 가지]';
    const when = validYmd(ins.date) ? '지난 ' + weekdayKo(ins.date) : '지난번';
    const type = clean(ins.type, 20) || '웩슬러';
    const n = Number(day);
    if (n === 3) {
      return '안녕하세요, ' + who + ' 😊\n\n' + when + '에 ' + child + ' ' + type + ' 검사 잘 받아줬어요.\n결과를 보니 ' + strength + '가 정말 돋보이더라고요.\n\n' +
        '혹시 앞으로의 학습 방향에 대해 궁금하신 점 있으시면 편하게 말씀해 주세요.\n\nWB에서 이런 강점을 가진 아이들이 특히 빠르게 성장하는 걸 많이 보거든요 😊';
    }
    if (n === 7) {
      return '안녕하세요 ' + who + ' 😊\n지난번에 연락드렸는데 바쁘신가 싶어서요.\n\n' + child + ' 검사 때 보여준 모습이 계속 생각이 나서요.\n' +
        '혹시 마음에 걸리시는 부분이 있으시면 말씀해 주시면 더 정확히 안내드릴 수 있어요.';
    }
    return '안녕하세요 ' + who + ' 😊\n\n여러 번 연락드려서 번거로우셨죠.\n저희는 언제든 준비가 되어 있으니까요,\n' + child + ' 준비됐다고 느껴지실 때 편하게 연락 주세요 😊';
  }
  /** 재검사 안내 초안(D-30 부드러운 안내 / D-7 일정 제안). D-day 는 초안 없이 원장 직접 통화. */
  function retestDraft(window, lead) {
    const L = isObj(lead) ? lead : {};
    const who = RELATION_HONORIFIC[str(L.relation)] || RELATION_HONORIFIC['기타'];
    const child = childCall(isObj(L.child) ? L.child.name : '');
    const ins = isObj(L.inspection) ? L.inspection : {};
    if (Number(window) === 30) {
      return '안녕하세요 ' + who + ', WB 웩슬러브레인센터입니다.\n' + child + ' ' + (validYmd(ins.date) ? ins.date + '에 ' : '') + (clean(ins.type, 20) || '') +
        ' 검사를 받은 지 곧 2년이 됩니다.\n아이의 성장·변화를 확인하는 시점에 재검사를 한 번 권해드립니다.\n무리한 일정 아니시라면 다음 달 안에 방문을 고려해 보세요.';
    }
    return who + ', 앞서 안내드린 재검사 시점이 다음 주입니다.\n요즘 ' + child + ' 학업·정서 중 신경 쓰이는 부분 있으시면 그 부분을 중심으로 검사 구성도 가능합니다.\n편한 시간대 알려주시면 예약 도와드릴게요.';
  }

  /* ── 상태·단계 ───────────────────────────────────── */

  function stagesOf(pipeline) { return STAGES[str(pipeline)] || []; }
  function isClosed(stage) { return CLOSED_STAGES.includes(str(stage)); }
  /** 단계에서 상태를 유도한다 — 화면과 서버가 같은 답을 내야 한다. */
  function statusOf(stage, requested) {
    const s = str(stage);
    if (s === 'won') return 'won';
    if (s === 'lost' || s === 'churned') return 'lost';
    return requested === 'hold' ? 'hold' : 'open';
  }
  function daysInStage(lead, today) {
    const at = isObj(lead) ? str(lead.stageAt).slice(0, 10) : '';
    const d = daysBetween(at, today);
    return d === null ? null : Math.max(0, d);
  }

  /* ── 검증(화면·서버 공용) ─────────────────────────── */

  function invalid(error) { return { ok: false, error: error }; }

  /** 리드 문서를 정규화한다. 서버는 여기서 통과한 data 만 저장하고, hubspot 필드는 서버가 따로 보존한다. */
  function validateLead(raw, ctx) {
    const o = isObj(raw) ? raw : {};
    const c = isObj(ctx) ? ctx : {};
    const name = clean(o.name, MAX_NAME);
    if (!name) return invalid('보호자 이름을 입력해 주세요');
    const pipeline = PIPELINES.includes(o.pipeline) ? o.pipeline : 'inspection';
    const stage = stagesOf(pipeline).includes(o.stage) ? o.stage : stagesOf(pipeline)[0];
    const phone = normalizePhone(o.phone);
    if (o.phone && !phone) return invalid('전화번호 형식이 올바르지 않습니다');
    const email = clean(o.email, 120).toLowerCase();
    if (email && !validEmail(email)) return invalid('이메일 형식이 올바르지 않습니다');
    const channel = CHANNELS.includes(o.channel) ? o.channel : '기타';
    const child = isObj(o.child) ? o.child : {};
    if (child.birth && !validYmd(child.birth)) return invalid('아이 생년월일은 YYYY-MM-DD 로 적어 주세요');
    const ins = isObj(o.inspection) ? o.inspection : {};
    if (ins.date && !validYmd(ins.date)) return invalid('검사일은 YYYY-MM-DD 로 적어 주세요');
    if (ins.type && !INSPECTION_TYPES.includes(ins.type)) return invalid('검사 종류가 목록에 없습니다');
    if (o.consultedAt && !validYmd(o.consultedAt)) return invalid('상담 완료일은 YYYY-MM-DD 로 적어 주세요');
    const relation = RELATIONS.includes(o.relation) ? o.relation : '기타';
    const interests = (Array.isArray(o.interests) ? o.interests : []).filter(x => INTERESTS.includes(x));
    const followups = (Array.isArray(o.followups) ? o.followups : []).filter(isObj).map(f => ({
      day: Number(f.day) || 0, due: validYmd(f.due) ? f.due : '', status: FOLLOWUP_STATUS.includes(f.status) ? f.status : 'pending',
      doneAt: validYmd(f.doneAt) ? f.doneAt : '', result: FOLLOWUP_RESULTS.includes(f.result) ? f.result : '', note: clean(f.note, 300)
    })).filter(f => f.day > 0 && f.due);
    const outcomeIn = isObj(o.outcome) ? o.outcome : null;
    const status = statusOf(stage, o.status);
    let outcome = null;
    if (status === 'won' || status === 'lost' || status === 'hold') {
      const reason = status === 'lost' ? (LOST_REASONS.includes(outcomeIn && outcomeIn.reason) ? outcomeIn.reason : 'U') : '';
      outcome = { status: status, at: outcomeIn && validYmd(outcomeIn.at) ? outcomeIn.at : (c.today || ymdOf(new Date())), reason: reason, note: clean(outcomeIn && outcomeIn.note, 300) };
    }
    const retest = validYmd(o.retestDue) ? o.retestDue : retestDue(ins.date, ins.type);
    const data = {
      name: name, relation: relation, phone: phone, email: email,
      child: { name: clean(child.name, MAX_NAME), birth: validYmd(child.birth) ? child.birth : '', grade: clean(child.grade, 20), school: clean(child.school, 40) },
      channel: channel, channelNote: clean(o.channelNote, 120), hot: !!o.hot,
      interests: interests, source: cleanMulti(o.source, MAX_TEXT), memo: cleanMulti(o.memo, MAX_TEXT), strength: clean(o.strength, 120),
      pipeline: pipeline, stage: stage, stageAt: validYmd(str(o.stageAt).slice(0, 10)) ? str(o.stageAt).slice(0, 10) : (c.today || ymdOf(new Date())),
      status: status, outcome: outcome,
      owner: clean(o.owner, 64), referrerLeadId: clean(o.referrerLeadId, 160), partnerId: channel === '파트너' ? clean(o.partnerId, 160) : '',
      inspection: { type: INSPECTION_TYPES.includes(ins.type) ? ins.type : '', date: validYmd(ins.date) ? ins.date : '' },
      retestDue: retest, consultedAt: validYmd(o.consultedAt) ? o.consultedAt : '',
      followups: followups,
      academyStatus: clean(o.academyStatus, 20),
      createdAt: validYmd(str(o.createdAt).slice(0, 10)) ? str(o.createdAt).slice(0, 10) : (c.today || ymdOf(new Date())),
      hubspot: isObj(o.hubspot) ? o.hubspot : {}
    };
    return { ok: true, data: data };
  }

  function validateActivity(raw, ctx) {
    const o = isObj(raw) ? raw : {};
    const c = isObj(ctx) ? ctx : {};
    const leadId = clean(o.leadId, 160);
    if (!leadId) return invalid('어느 리드의 기록인지 없습니다');
    const type = ACTIVITY_TYPES.includes(o.type) ? o.type : 'note';
    const text = cleanMulti(o.text, MAX_TEXT);
    const result = FOLLOWUP_RESULTS.includes(o.result) ? o.result : '';
    if (!text && !['stage', 'followup', 'hubspot'].includes(type) && !result) return invalid('기록 내용을 적어 주세요');
    const at = validYmd(str(o.at).slice(0, 10)) ? str(o.at).slice(0, 10) : (c.today || ymdOf(new Date()));
    return { ok: true, data: {
      leadId: leadId, type: type, text: text, result: result, at: at, ts: Number(o.ts) || Date.now(),
      followupDay: Number(o.followupDay) || 0, from: clean(o.from, 40), to: clean(o.to, 40), by: clean(o.by, 64),
      hubspot: isObj(o.hubspot) ? o.hubspot : {}
    } };
  }

  function validateCredit(raw, ctx) {
    const o = isObj(raw) ? raw : {};
    const c = isObj(ctx) ? ctx : {};
    const leadId = clean(o.leadId, 160);
    if (!leadId) return invalid('누구의 크레딧인지 없습니다');
    if (!CREDIT_TYPES.includes(o.type)) return invalid('크레딧 종류가 올바르지 않습니다');
    const amount = Math.round(Number(o.amount));
    if (!Number.isFinite(amount) || amount === 0) return invalid('금액을 입력해 주세요');
    if ((o.type === 'accrue' && amount < 0) || ((o.type === 'use' || o.type === 'expire') && amount > 0)) return invalid('적립은 +, 사용·소멸은 − 금액이어야 합니다');
    return { ok: true, data: {
      leadId: leadId, type: o.type, amount: amount, note: clean(o.note, 200), at: validYmd(o.at) ? o.at : (c.today || ymdOf(new Date())),
      referredLeadId: clean(o.referredLeadId, 160), by: clean(o.by, 64), ts: Number(o.ts) || Date.now()
    } };
  }

  function validatePartner(raw, ctx) {
    const o = isObj(raw) ? raw : {};
    const c = isObj(ctx) ? ctx : {};
    const name = clean(o.name, MAX_NAME);
    if (!name) return invalid('파트너 학원 이름을 입력해 주세요');
    const phone = normalizePhone(o.phone);
    if (o.phone && !phone) return invalid('전화번호 형식이 올바르지 않습니다');
    const link = clean(o.link, 300);
    if (link && !/^https:\/\/[^\s"'<>]{1,280}$/.test(link)) return invalid('자료 링크는 https 주소만 적을 수 있습니다');
    const terms = isObj(o.terms) ? o.terms : {};
    return { ok: true, data: {
      name: name, kind: clean(o.kind, 20), area: clean(o.area, 40), contactName: clean(o.contactName, MAX_NAME), phone: phone,
      status: PARTNER_STATUS.includes(o.status) ? o.status : 'active',
      terms: { inbound: clean(terms.inbound, 200), outbound: clean(terms.outbound, 200), note: clean(terms.note, 300) },
      link: link, memo: cleanMulti(o.memo, MAX_TEXT), createdAt: validYmd(o.createdAt) ? o.createdAt : (c.today || ymdOf(new Date()))
    } };
  }

  /** 나가는 소개(센터 → 파트너) 한 건. 상태는 파트너 포털이나 직원이 고친다. */
  function validateReferral(raw, ctx) {
    const o = isObj(raw) ? raw : {};
    const c = isObj(ctx) ? ctx : {};
    const leadId = clean(o.leadId, 160), partnerId = clean(o.partnerId, 160);
    if (!leadId || !partnerId) return invalid('어느 리드를 어느 파트너에게 보내는지 없습니다');
    return { ok: true, data: {
      leadId: leadId, partnerId: partnerId, direction: 'out',
      status: REFERRAL_STATUS.includes(o.status) ? o.status : 'sent', note: clean(o.note, 300), partnerNote: clean(o.partnerNote, 300),
      at: validYmd(o.at) ? o.at : (c.today || ymdOf(new Date())), statusAt: validYmd(o.statusAt) ? o.statusAt : '', by: clean(o.by, 64), consent: !!o.consent
    } };
  }

  function coarseStage(lead) { return COARSE_STAGE_LABEL[str(isObj(lead) ? lead.stage : '')] || '접수'; }

  /** 파트너별 월 집계 — 들어온 소개(리드)·나간 소개(referrals). ym 이 없으면 전체 기간. */
  function partnerStats(leads, referrals, partners, ym) {
    const L = (Array.isArray(leads) ? leads : []).filter(isObj);
    const R = (Array.isArray(referrals) ? referrals : []).filter(isObj);
    const inM = s => !ym || ymOf(s) === ym;
    return (Array.isArray(partners) ? partners : []).filter(isObj).map(p => {
      const inbound = L.filter(l => l.partnerId === p.id && inM(l.createdAt));
      const outbound = R.filter(r => r.partnerId === p.id && inM(r.at));
      return {
        partnerId: p.id, name: p.name, status: p.status,
        inbound: inbound.length, inboundTested: inbound.filter(l => validYmd(l.consultedAt) || (isObj(l.inspection) && validYmd(l.inspection.date))).length,
        inboundWon: inbound.filter(l => l.status === 'won').length, inboundLost: inbound.filter(l => l.status === 'lost').length,
        outbound: outbound.length, outboundEnrolled: outbound.filter(r => r.status === 'enrolled').length, outboundDeclined: outbound.filter(r => r.status === 'declined').length,
        outboundOpen: outbound.filter(r => r.status === 'sent' || r.status === 'contacted').length
      };
    });
  }

  /** 월 정산 문구 — 파트너에게 보내는 요약(이름·숫자만, 가정 정보 없음). */
  function partnerStatement(stat, ym, terms) {
    const s = isObj(stat) ? stat : {};
    const t = isObj(terms) ? terms : {};
    return '[' + str(ym).replace('-', '년 ') + '월 연계 정산] ' + str(s.name) + '\n' +
      '· 보내 주신 가정: ' + (s.inbound || 0) + '가정 (검사 완료 ' + (s.inboundTested || 0) + ' · 등록 ' + (s.inboundWon || 0) + ')' + (t.inbound ? ' — ' + t.inbound : '') + '\n' +
      '· 저희가 소개한 가정: ' + (s.outbound || 0) + '가정 (등록 ' + (s.outboundEnrolled || 0) + ' · 진행 중 ' + (s.outboundOpen || 0) + ')' + (t.outbound ? ' — ' + t.outbound : '') + '\n' +
      '확인 부탁드립니다. — WB 웩슬러브레인센터';
  }

  function creditBalance(credits, leadId) {
    return (Array.isArray(credits) ? credits : []).filter(x => isObj(x) && x.leadId === leadId).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  }
  /** v2.0 — 같은 소개자가 30일 안에 이미 적립받았으면 쿨다운. 피소개자 중복 적립도 막는다. */
  function creditEligibility(credits, referrerId, referredId, today) {
    const mine = (Array.isArray(credits) ? credits : []).filter(x => isObj(x) && x.leadId === referrerId && x.type === 'accrue');
    if (referredId && mine.some(x => x.referredLeadId === referredId)) return { ok: false, reason: 'duplicate', error: '이 피소개자로는 이미 적립했습니다' };
    const last = mine.map(x => str(x.at)).filter(validYmd).sort().pop();
    if (last) {
      const until = addDays(last, CREDIT_COOLDOWN_DAYS);
      if (daysBetween(today, until) > 0) return { ok: false, reason: 'cooldown', until: until, error: '소개자 쿨다운 중 (' + until + ' 까지)' };
    }
    return { ok: true, amount: CREDIT_AMOUNT };
  }

  /* ── HubSpot 단계 자동 매핑 ───────────────────────── */

  function normLabel(s) { return str(s).toLowerCase().replace(/[\s()·_-]/g, ''); }
  /**
   * HubSpot 딜 파이프라인 목록(GET /crm/v3/pipelines/deals 의 results)에서 우리 파이프라인 하나에 맞는 매핑을 고른다.
   * 파이프라인은 라벨 일치(검사 여정/학원 등록) → 없으면 단계 라벨이 가장 많이 겹치는 것. 단계는 라벨·별칭 일치.
   * 돌려주는 값 { pipelineId, pipelineLabel, stageMap: {우리단계: hs단계id}, unmapped: [우리단계] }.
   */
  function autoMapPipeline(hsPipelines, pipeline) {
    const list = (Array.isArray(hsPipelines) ? hsPipelines : []).filter(isObj);
    const ours = stagesOf(pipeline);
    if (!list.length || !ours.length) return { pipelineId: '', pipelineLabel: '', stageMap: {}, unmapped: ours.slice() };
    const score = p => {
      const labels = (Array.isArray(p.stages) ? p.stages : []).map(s => normLabel(s.label));
      return ours.filter(k => (STAGE_ALIASES[k] || [STAGE_LABEL[k]]).some(a => labels.includes(normLabel(a)))).length;
    };
    const byName = list.find(p => normLabel(p.label) === normLabel(PIPELINE_LABEL[pipeline]));
    const pick = byName || list.slice().sort((a, b) => score(b) - score(a))[0];
    const stageMap = {}, unmapped = [];
    ours.forEach(k => {
      const aliases = (STAGE_ALIASES[k] || [STAGE_LABEL[k]]).map(normLabel);
      const hit = (Array.isArray(pick.stages) ? pick.stages : []).find(s => aliases.includes(normLabel(s.label)) || aliases.includes(normLabel(s.id)));
      if (hit) stageMap[k] = str(hit.id); else unmapped.push(k);
    });
    return { pipelineId: str(pick.id), pipelineLabel: str(pick.label), stageMap: stageMap, unmapped: unmapped };
  }
  /** 역방향 — hs 단계 id → 우리 단계 키. */
  function localStageFor(map, pipeline, hsStageId) {
    const m = isObj(map) && isObj(map[pipeline]) && isObj(map[pipeline].stageMap) ? map[pipeline].stageMap : {};
    return Object.keys(m).find(k => str(m[k]) === str(hsStageId)) || '';
  }
  function syncTrack(kind, payload) {
    if (kind === 'deal' && isObj(payload) && payload.transition) return 'review';
    return 'quick';
  }

  /* ── 오늘 보드·KPI ───────────────────────────────── */

  function lastActivityAt(activities, leadId) {
    let last = '';
    (Array.isArray(activities) ? activities : []).forEach(a => { if (isObj(a) && a.leadId === leadId && str(a.at) > last) last = str(a.at); });
    return last;
  }

  /** 오늘 화면의 묶음 — 팔로업·최종판정·핫·미연락 신규·재검사. 전부 열린(open) 리드만 본다. */
  function todayBoard(leads, activities, today) {
    const L = (Array.isArray(leads) ? leads : []).filter(isObj);
    const open = L.filter(l => l.status === 'open');
    const followups = [];
    open.forEach(l => dueFollowups(l, today).forEach(f => followups.push({ lead: l, followup: f })));
    followups.sort((a, b) => b.followup.late - a.followup.late || str(a.lead.name).localeCompare(str(b.lead.name)));
    const decide = open.filter(l => validYmd(l.consultedAt) && daysBetween(l.consultedAt, today) >= 14 && !dueFollowups(l, today).length)
      .map(l => ({ lead: l, days: daysBetween(l.consultedAt, today) })).sort((a, b) => b.days - a.days);
    const hot = open.filter(l => l.hot && !isClosed(l.stage) && ['inquiry', 'contacted'].includes(l.stage));
    const fresh = open.filter(l => l.stage === 'inquiry' && daysBetween(l.createdAt, today) >= 1 && !lastActivityAt(activities, l.id));
    const retest = { 30: [], 7: [], 0: [], overdue: [] };
    L.filter(l => l.status !== 'lost' && validYmd(l.retestDue)).forEach(l => {
      const w = retestWindow(l.retestDue, today);
      if (w) retest[w.window].push({ lead: l, days: w.days });
    });
    return { followups: followups, decide: decide, hot: hot, fresh: fresh, retest: retest };
  }

  function countBy(list, keyFn) {
    const out = {};
    list.forEach(x => { const k = str(keyFn(x)) || '기타'; out[k] = (out[k] || 0) + 1; });
    return out;
  }
  function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }

  /** 월 KPI(ym = 'YYYY-MM'). 전환율 = 등록 ÷ 그 달 상담 완료 코호트. */
  function kpi(leads, activities, ym, today) {
    const L = (Array.isArray(leads) ? leads : []).filter(isObj);
    const inMonth = s => ymOf(s) === ym;
    const inquiries = L.filter(l => inMonth(l.createdAt));
    const cohort = L.filter(l => inMonth(l.consultedAt));
    const won = cohort.filter(l => l.status === 'won');
    const lost = cohort.filter(l => l.status === 'lost');
    const hold = cohort.filter(l => l.status === 'hold');
    const openC = cohort.filter(l => l.status === 'open');
    const matured = cohort.filter(l => daysBetween(l.consultedAt, today) >= 14);
    const decidedIn14 = matured.filter(l => isObj(l.outcome) && validYmd(l.outcome.at) && ['won', 'lost'].includes(l.status) && daysBetween(l.consultedAt, l.outcome.at) <= 14);
    const fu1 = cohort.map(l => (Array.isArray(l.followups) ? l.followups : []).find(f => isObj(f) && Number(f.day) === 3)).filter(f => f && f.status === 'done');
    const fu1Hit = fu1.filter(f => f.result === 'reached' || f.result === 'replied');
    const wonMonth = L.filter(l => l.status === 'won' && isObj(l.outcome) && inMonth(l.outcome.at));
    const lostMonth = L.filter(l => l.status === 'lost' && isObj(l.outcome) && inMonth(l.outcome.at));
    const openAll = L.filter(l => l.status === 'open' || l.status === 'hold');
    return {
      ym: ym,
      inquiries: inquiries.length, consulted: cohort.length,
      won: won.length, lost: lost.length, hold: hold.length, open: openC.length,
      wonMonth: wonMonth.length, lostMonth: lostMonth.length,
      conversion: pct(won.length, cohort.length),
      decidedIn14: pct(decidedIn14.length, matured.length), matured: matured.length,
      followup1Response: pct(fu1Hit.length, fu1.length), followup1Done: fu1.length,
      channels: countBy(inquiries, l => l.channel),
      hotRate: pct(inquiries.filter(l => l.hot).length, inquiries.length),
      lostReasons: countBy(lostMonth, l => (isObj(l.outcome) ? l.outcome.reason : 'U')),
      stages: PIPELINES.reduce((o, p) => { o[p] = countBy(openAll.filter(l => l.pipeline === p), l => l.stage); return o; }, {})
    };
  }

  /* ── 관계 프로그램 — 센터의 확인·후속 연락 기록만, 혜택·포털 권한은 바꾸지 않는다 ── */

  function relationshipId(value) { return typeof value === 'string' && /^[A-Za-z0-9_|.:@-]{1,160}$/.test(value); }
  function relationshipStrings(raw, keys) { return keys.every(k => raw[k] == null || typeof raw[k] === 'string'); }
  function optionalDates(data, keys) { return keys.every(k => !data[k] || validYmd(data[k])); }
  function hasLabel(labels, value) { return typeof value === 'string' && Object.prototype.hasOwnProperty.call(labels, value); }

  function validateMembership(raw) {
    if (!isObj(raw) || !relationshipId(raw.leadId)) return invalid('고객을 선택해 주세요');
    if (!relationshipStrings(raw, ['startDate', 'owner', 'nextContactDate', 'nextAction', 'pauseDate', 'resumeDate', 'note'])) return invalid('참여 기록의 날짜·본문은 문자열이어야 합니다');
    if (!hasLabel(PROGRAM_LABEL, raw.program)) return invalid('참여 프로그램을 선택해 주세요');
    const data = { leadId: raw.leadId, program: raw.program, startDate: str(raw.startDate), owner: clean(raw.owner, 160),
      status: raw.status === undefined ? 'active' : raw.status, nextContactDate: str(raw.nextContactDate), nextAction: clean(raw.nextAction),
      benefitState: raw.benefitState === undefined ? 'unchecked' : raw.benefitState,
      pauseDate: str(raw.pauseDate), resumeDate: str(raw.resumeDate), note: cleanMulti(raw.note) };
    if (!validYmd(data.startDate) || !optionalDates(data, ['nextContactDate', 'pauseDate', 'resumeDate'])) return invalid('참여·연락 날짜를 확인해 주세요');
    if (!!data.nextContactDate !== !!data.nextAction) return invalid('다음 연락일과 할 일을 함께 입력하거나 함께 비워 주세요');
    if (!hasLabel(MEMBERSHIP_STATUS_LABEL, data.status) || !hasLabel(BENEFIT_STATE_LABEL, data.benefitState)) return invalid('참여·혜택 확인 상태가 올바르지 않습니다');
    return { ok: true, data: data };
  }

  function validateProgramActivity(raw) {
    if (!isObj(raw) || !relationshipId(raw.membershipId)) return invalid('참여 기록을 선택해 주세요');
    if (!relationshipStrings(raw, ['month', 'date', 'evidence', 'note', 'by'])) return invalid('활동 기록의 날짜·본문은 문자열이어야 합니다');
    const data = { membershipId: raw.membershipId, month: str(raw.month), kind: raw.kind, date: str(raw.date),
      evidence: cleanMulti(raw.evidence), status: raw.status === undefined ? 'pending' : raw.status, note: cleanMulti(raw.note), by: clean(raw.by, 160) };
    if (!validYmd(data.month + '-01') || !validYmd(data.date) || ymOf(data.date) !== data.month) return invalid('활동일은 선택한 월의 실제 날짜여야 합니다');
    if (!hasLabel(PROGRAM_ACTIVITY_LABEL, data.kind) || !hasLabel(PROGRAM_ACTIVITY_STATUS_LABEL, data.status)) return invalid('활동 종류·확인 상태가 올바르지 않습니다');
    return { ok: true, data: data };
  }

  function validateProgramExam(raw) {
    if (!isObj(raw) || !relationshipId(raw.membershipId)) return invalid('참여 기록을 선택해 주세요');
    if (!relationshipStrings(raw, ['cycleStart', 'cycleEnd', 'dueDate', 'bookedDate', 'completedDate', 'note'])) return invalid('검사 기록의 날짜·본문은 문자열이어야 합니다');
    const data = { membershipId: raw.membershipId, cycleStart: str(raw.cycleStart), cycleEnd: str(raw.cycleEnd), dueDate: str(raw.dueDate),
      bookedDate: str(raw.bookedDate), completedDate: str(raw.completedDate), activitiesChecked: raw.activitiesChecked === true, note: cleanMulti(raw.note) };
    if (![data.cycleStart, data.cycleEnd, data.dueDate].every(validYmd) || !optionalDates(data, ['bookedDate', 'completedDate'])) return invalid('검사 회차·예약·완료 날짜를 확인해 주세요');
    if (data.cycleEnd < data.cycleStart) return invalid('회차 종료일은 시작일보다 빠를 수 없습니다');
    if (raw.activitiesChecked !== undefined && typeof raw.activitiesChecked !== 'boolean') return invalid('활동 확인은 체크로 표시해 주세요');
    return { ok: true, data: data };
  }

  function validateGathering(raw) {
    if (!isObj(raw)) return invalid('맘스쿨 정보를 입력해 주세요');
    if (!relationshipStrings(raw, ['topic', 'date', 'time', 'place', 'owner', 'note']) || !['number', 'string'].includes(typeof raw.capacity)) return invalid('모임 날짜·본문·정원 형식이 올바르지 않습니다');
    const data = { topic: clean(raw.topic, 120), date: str(raw.date), time: str(raw.time), place: clean(raw.place, 160), capacity: Number(raw.capacity),
      status: raw.status === undefined ? 'planned' : raw.status, owner: clean(raw.owner, 160), note: cleanMulti(raw.note),
      participantsChecked: raw.participantsChecked === true, participants: [] };
    if (!data.topic || !validYmd(data.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time)) return invalid('주제·날짜·시간을 확인해 주세요');
    if (![4, 5, 6].includes(data.capacity) || !hasLabel(GATHERING_STATUS_LABEL, data.status)) return invalid('정원은 4~6명이며 올바른 모임 상태가 필요합니다');
    if (raw.participantsChecked !== undefined && typeof raw.participantsChecked !== 'boolean') return invalid('보호자 인원 확인은 체크로 표시해 주세요');
    if (raw.participants !== undefined && !Array.isArray(raw.participants)) return invalid('참가자 목록 형식이 올바르지 않습니다');
    const seen = new Set();
    for (const row of raw.participants || []) {
      if (!isObj(row) || !relationshipId(row.leadId) || seen.has(row.leadId)) return invalid('참가 고객이 없거나 중복되었습니다');
      if (!relationshipStrings(row, ['nextContactDate', 'nextAction', 'note'])) return invalid('참가자의 날짜·본문은 문자열이어야 합니다');
      if (!hasLabel(ATTENDANCE_LABEL, row.status) || row.inspectionConfirmed !== true) return invalid('참석 상태와 검사 실시 확인이 필요합니다');
      const p = { leadId: row.leadId, status: row.status, inspectionConfirmed: true, nextContactDate: str(row.nextContactDate), nextAction: clean(row.nextAction), note: cleanMulti(row.note) };
      if (!optionalDates(p, ['nextContactDate'])) return invalid('참가자 다음 연락일을 확인해 주세요');
      if (!!p.nextContactDate !== !!p.nextAction) return invalid('참가자 다음 연락일과 할 일을 함께 입력하거나 함께 비워 주세요');
      seen.add(row.leadId); data.participants.push(p);
    }
    const occupied = data.participants.filter(p => ['confirmed', 'attended'].includes(p.status)).length;
    if (occupied > data.capacity) return invalid('확정·참석 인원이 정원을 넘습니다');
    if (occupied && !data.participantsChecked) return invalid('각 행이 서로 다른 보호자 1명인지 확인해 주세요 — 형제 중복은 제외합니다');
    return { ok: true, data: data };
  }

  function hasCompletedInspection(lead, today) {
    if (!isObj(lead)) return false;
    const date = lead.inspection && lead.inspection.date;
    return !!(validYmd(date) && validYmd(today) && date <= today) ||
      (lead.pipeline === 'inspection' && ['tested', 'interpreted', 'upsell'].includes(lead.stage));
  }
  function programMonthStatus(membershipId, month, activities) {
    const statuses = (Array.isArray(activities) ? activities : []).filter(a => isObj(a) && a.membershipId === membershipId && a.month === month).map(a => a.status);
    return ['confirmed', 'supplement', 'pending'].find(s => statuses.includes(s)) || 'missing';
  }
  function relationshipTasks(memberships, gatherings, today) {
    if (!validYmd(today)) return [];
    const tasks = [];
    const add = (row, source, id) => {
      if (row.leadId && validYmd(row.nextContactDate) && row.nextContactDate <= today && clean(row.nextAction)) {
        tasks.push({ leadId: row.leadId, date: row.nextContactDate, action: clean(row.nextAction), source: source, id: id });
      }
    };
    (Array.isArray(memberships) ? memberships : []).forEach(m => { if (isObj(m) && m.status !== 'ended') add(m, 'membership', m.id); });
    (Array.isArray(gatherings) ? gatherings : []).forEach(g => {
      if (isObj(g) && g.status !== 'cancelled') (Array.isArray(g.participants) ? g.participants : []).forEach(p => { if (isObj(p) && p.status !== 'cancelled') add(p, 'gathering', g.id); });
    });
    return tasks.sort((a, b) => a.date.localeCompare(b.date));
  }

  /* ── 검색·정렬 ───────────────────────────────────── */

  function leadMatches(lead, q) {
    const t = clean(q, 60).toLowerCase();
    if (!t) return true;
    const l = isObj(lead) ? lead : {};
    const hay = [l.name, l.child && l.child.name, l.child && l.child.school, l.phone, normalizePhone(l.phone).replace(/-/g, ''), l.email, l.memo, l.channelNote]
      .map(x => str(x).toLowerCase()).join(' ');
    return hay.includes(t) || hay.includes(t.replace(/-/g, ''));
  }
  function leadLabel(lead) {
    const l = isObj(lead) ? lead : {};
    const child = isObj(l.child) ? clean(l.child.name, MAX_NAME) : '';
    return clean(l.name, MAX_NAME) + (child ? ' · ' + child : '');
  }

  /* ── 문서 병합·변경 큐(desk-core 와 같은 계약) ───── */

  const COLLECTIONS = ['leads', 'activities', 'credits', 'partners', 'referrals', 'memberships', 'programActivities', 'programExams', 'gatherings', 'settings', 'staff'];
  function docKey(c, id) { return str(c) + '|' + str(id); }
  function upsert(list, id, data, del) {
    const i = list.findIndex(x => isObj(x) && str(x.id) === str(id));
    if (del) { if (i >= 0) list.splice(i, 1); return; }
    const item = Object.assign({}, data, { id: str(id) });
    if (i >= 0) list[i] = item; else list.push(item);
  }
  function emptyState() { return { leads: [], activities: [], credits: [], partners: [], referrals: [], memberships: [], programActivities: [], programExams: [], gatherings: [], staff: [], settings: {}, meta: {}, base: {} }; }
  function mergeDocs(local, docs, pendingKeys) {
    const Lc = isObj(local) ? local : {};
    const out = emptyState();
    COLLECTIONS.filter(k => k !== 'settings').forEach(k => { out[k] = (Array.isArray(Lc[k]) ? Lc[k] : []).slice(); });
    out.settings = Object.assign({}, isObj(Lc.settings) ? Lc.settings : {});
    out.meta = Object.assign({}, isObj(Lc.meta) ? Lc.meta : {});
    out.base = Object.assign({}, isObj(Lc.base) ? Lc.base : {});
    const pend = new Set((Array.isArray(pendingKeys) ? pendingKeys : []).map(String));
    let changed = 0, skipped = 0;
    (Array.isArray(docs) ? docs : []).forEach(d => {
      if (!isObj(d) || !str(d.c) || !str(d.id)) return;
      const key = docKey(d.c, d.id);
      if (pend.has(key)) { skipped++; return; }
      const at = Number(d.updatedAt) || 0;
      const prev = Number(out.meta[key]) || 0;
      if (at && prev && at < prev) return;
      const data = isObj(d.data) ? d.data : {};
      const del = !!d.deleted;
      switch (str(d.c)) {
        case 'leads': upsert(out.leads, d.id, data, del); break;
        case 'activities': upsert(out.activities, d.id, data, del); break;
        case 'credits': upsert(out.credits, d.id, data, del); break;
        case 'partners': upsert(out.partners, d.id, data, del); break;
        case 'referrals': upsert(out.referrals, d.id, data, del); break;
        case 'memberships': case 'programActivities': case 'programExams': case 'gatherings': upsert(out[d.c], d.id, data, del); break;
        case 'staff': upsert(out.staff, d.id, data, del); break;
        case 'settings': out.settings = del ? {} : Object.assign({}, data); break;
        default: return;
      }
      out.meta[key] = at || prev || 0;
      out.base[key] = del ? null : Object.assign({}, data);
      changed++;
    });
    return { local: out, changed: changed, skipped: skipped };
  }
  function revertDoc(local, key) {
    const k = str(key);
    const i = k.indexOf('|');
    if (i < 0) return null;
    const c = k.slice(0, i), id = k.slice(i + 1);
    const base = isObj(local) && isObj(local.base) ? local.base[k] : undefined;
    const at = isObj(local) && isObj(local.meta) ? Number(local.meta[k]) || 0 : 0;
    if (base) return { c: c, id: id, data: base, updatedAt: at, deleted: false };
    return { c: c, id: id, data: {}, updatedAt: at, deleted: true };
  }
  function createOutbox() {
    const map = new Map();
    let seq = 0;
    return {
      put: function (c, id, data, deleted) { map.set(docKey(c, id), { c: str(c), id: str(id), data: data, deleted: !!deleted, seq: ++seq }); },
      keys: function () { return Array.from(map.keys()); },
      size: function () { return map.size; },
      has: function (key) { return map.has(str(key)); },
      snapshot: function (limit) { return Array.from(map.values()).slice(0, limit > 0 ? limit : 200).map(e => Object.assign({}, e)); },
      ack: function (sent, results) {
        const ok = [], stale = [], failed = [];
        const sentBy = {};
        (Array.isArray(sent) ? sent : []).forEach(e => { sentBy[docKey(e.c, e.id)] = e; });
        (Array.isArray(results) ? results : []).forEach(r => {
          if (!isObj(r)) return;
          const key = docKey(r.c, r.id);
          const s = sentBy[key];
          const cur = map.get(key);
          const settled = !!(cur && s && cur.seq === s.seq);
          if (!r.error && !r.code) { ok.push({ key: key, c: str(r.c), id: str(r.id), updatedAt: Number(r.updatedAt) || 0 }); if (settled) map.delete(key); }
          else if (r.code === 'STALE') { stale.push({ key: key, c: str(r.c), id: str(r.id), current: r.current || null }); if (settled) map.delete(key); }
          else { failed.push({ key: key, c: str(r.c), id: str(r.id), error: str(r.error || r.code), code: str(r.code) }); if (settled) map.delete(key); }
        });
        return { ok: ok, stale: stale, failed: failed };
      },
      clear: function () { map.clear(); }
    };
  }

  /* ── 라우트·링크 ─────────────────────────────────── */

  function routeOf(hash) {
    const h = str(hash).replace(/^#/, '');
    const m = h.match(/^c=([A-Za-z0-9_-]{4,200})$/);
    if (m) return { route: 'today', id: '', code: m[1] };
    const parts = h.replace(/^\/+/, '').split(/[/?]/);
    if (parts[0] === 'lead' && /^[A-Za-z0-9_.:@-]{1,160}$/.test(str(parts[1]))) return { route: 'lead', id: parts[1], code: '' };
    return { route: ROUTES.includes(parts[0]) && parts[0] !== 'lead' ? parts[0] : 'today', id: '', code: '' };
  }
  function inviteLink(origin, pathname, code) {
    const dir = str(pathname || '/').replace(/index\.html$/, '');
    return str(origin) + (dir.startsWith('/') ? dir : '/' + dir) + '#c=' + str(code);
  }
  /** HubSpot 화면 링크 — 포털 id·도메인은 /api/hubspot/status 가 알려 준다(저장소에 적지 않는다). */
  function hubspotRecordUrl(portal, objectType, id) {
    const p = isObj(portal) ? portal : {};
    if (!p.portalId || !id) return '';
    const domain = /^app(-[a-z0-9]+)?\.hubspot\.com$/.test(str(p.uiDomain)) ? p.uiDomain : 'app.hubspot.com';
    const code = objectType === 'deal' ? '0-3' : '0-1';
    return 'https://' + domain + '/contacts/' + encodeURIComponent(str(p.portalId)) + '/record/' + code + '/' + encodeURIComponent(str(id));
  }

  return {
    PIPELINES: PIPELINES, PIPELINE_LABEL: PIPELINE_LABEL, STAGES: STAGES, STAGE_LABEL: STAGE_LABEL, STAGE_ALIASES: STAGE_ALIASES,
    CLOSED_STAGES: CLOSED_STAGES, STATUSES: STATUSES, STATUS_LABEL: STATUS_LABEL,
    CHANNELS: CHANNELS, CHANNEL_KEYWORDS: CHANNEL_KEYWORDS, HOT_KEYWORDS: HOT_KEYWORDS,
    INSPECTION_TYPES: INSPECTION_TYPES, RETEST_WINDOWS: RETEST_WINDOWS,
    FOLLOWUP_OFFSETS: FOLLOWUP_OFFSETS, FOLLOWUP_LABEL: FOLLOWUP_LABEL, FOLLOWUP_RESULTS: FOLLOWUP_RESULTS, RESULT_LABEL: RESULT_LABEL,
    LOST_REASONS: LOST_REASONS, LOST_REASON_LABEL: LOST_REASON_LABEL, INTERESTS: INTERESTS, RELATIONS: RELATIONS, RELATION_HONORIFIC: RELATION_HONORIFIC,
    ACTIVITY_TYPES: ACTIVITY_TYPES, ACTIVITY_LABEL: ACTIVITY_LABEL, ANCHOR_TYPES: ANCHOR_TYPES,
    CREDIT_AMOUNT: CREDIT_AMOUNT, CREDIT_COOLDOWN_DAYS: CREDIT_COOLDOWN_DAYS, CREDIT_EXPIRE_MONTHS: CREDIT_EXPIRE_MONTHS, CREDIT_TYPES: CREDIT_TYPES, CREDIT_LABEL: CREDIT_LABEL,
    ROUTES: ROUTES, OWNER_ROUTES: OWNER_ROUTES, COLLECTIONS: COLLECTIONS,
    PROGRAM_LABEL: PROGRAM_LABEL, MEMBERSHIP_STATUS_LABEL: MEMBERSHIP_STATUS_LABEL, PROGRAM_ACTIVITY_LABEL: PROGRAM_ACTIVITY_LABEL,
    PROGRAM_ACTIVITY_STATUS_LABEL: PROGRAM_ACTIVITY_STATUS_LABEL, BENEFIT_STATE_LABEL: BENEFIT_STATE_LABEL, GATHERING_STATUS_LABEL: GATHERING_STATUS_LABEL, ATTENDANCE_LABEL: ATTENDANCE_LABEL,
    validateMembership: validateMembership, validateProgramActivity: validateProgramActivity, validateProgramExam: validateProgramExam, validateGathering: validateGathering,
    hasCompletedInspection: hasCompletedInspection, programMonthStatus: programMonthStatus, relationshipTasks: relationshipTasks,
    PARTNER_STATUS: PARTNER_STATUS, PARTNER_STATUS_LABEL: PARTNER_STATUS_LABEL, REFERRAL_STATUS: REFERRAL_STATUS, REFERRAL_STATUS_LABEL: REFERRAL_STATUS_LABEL, COARSE_STAGE_LABEL: COARSE_STAGE_LABEL,
    validatePartner: validatePartner, validateReferral: validateReferral, coarseStage: coarseStage, partnerStats: partnerStats, partnerStatement: partnerStatement,
    SYNC_KINDS: SYNC_KINDS, SYNC_KIND_LABEL: SYNC_KIND_LABEL, SYNC_TRACKS: SYNC_TRACKS, SYNC_TRACK_LABEL: SYNC_TRACK_LABEL, SYNC_STATUS: SYNC_STATUS, SYNC_STATUS_LABEL: SYNC_STATUS_LABEL,
    PII_PATTERNS: PII_PATTERNS, PII_ALLOWED_PATHS: PII_ALLOWED_PATHS, hasPii: hasPii, findPii: findPii,
    ymdOf: ymdOf, parseYmd: parseYmd, validYmd: validYmd, addDays: addDays, addMonths: addMonths, daysBetween: daysBetween, ymOf: ymOf, weekdayKo: weekdayKo, childCall: childCall,
    normalizePhone: normalizePhone, maskPhone: maskPhone, validEmail: validEmail, clean: clean,
    detectChannel: detectChannel, detectHot: detectHot,
    retestDays: retestDays, retestDue: retestDue, retestWindow: retestWindow,
    scheduleFollowups: scheduleFollowups, dueFollowups: dueFollowups, nextFollowup: nextFollowup, markFollowup: markFollowup, messageDraft: messageDraft, retestDraft: retestDraft,
    stagesOf: stagesOf, isClosed: isClosed, statusOf: statusOf, daysInStage: daysInStage,
    validateLead: validateLead, validateActivity: validateActivity, validateCredit: validateCredit, creditBalance: creditBalance, creditEligibility: creditEligibility,
    autoMapPipeline: autoMapPipeline, localStageFor: localStageFor, syncTrack: syncTrack,
    todayBoard: todayBoard, kpi: kpi, lastActivityAt: lastActivityAt, leadMatches: leadMatches, leadLabel: leadLabel,
    docKey: docKey, emptyState: emptyState, mergeDocs: mergeDocs, revertDoc: revertDoc, createOutbox: createOutbox,
    routeOf: routeOf, inviteLink: inviteLink, hubspotRecordUrl: hubspotRecordUrl
  };
});
