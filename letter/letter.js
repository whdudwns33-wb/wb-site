'use strict';
/* WB 브레인레터 — 주간 뉴스레터 순수 로직 (브라우저/Node 공용, 의존성 없음)
   유치(5~7세)부터 중학생까지 다섯 학년대에 매주 한 호를 보낸다. 한 호(issue)는 여러 섹션(section)으로 되어 있고
   섹션마다 대상 학년대(tiers)가 붙어 있다. 학생 앱·가족 링크·관리 미리보기·인쇄(PDF)가 전부 이 모듈의
   renderIssue 하나로 그린다 — 화면마다 따로 그리면 학생이 보는 것과 원장이 검수한 것이 달라진다.

   화면은 신문 한 면의 짜임이다: 제호 → 발행선 → 1면 머리기사(이번 주 주제) → 본기사(읽을거리)와 옆단(낱말·두뇌 놀이·미션)
   → 학부모면(칼럼·코칭·게시판). 좁은 화면에서는 위에서 아래로 한 줄, 넓은 화면·A4 인쇄에서는 2단이다.

   왜 검증기가 여기 있는가: 관리 웹 업로드·AI 초안·서버 저장이 같은 규칙으로 걸러야 한다.
   문항 정답 번호가 보기 범위를 벗어난 호가 발행되면 학생 화면이 그 문항에서 죽는다. */
var WBLETTER = (function () {
  /* 학년대 — 진로독서의 L1~L4 와 다르다. 뉴스레터는 유치부가 있고 고등은 중등 것을 받는다. */
  var TIERS = [
    { id: 'K', label: '유치', range: '5~7세', edition: '유치판', note: '부모가 읽어 주는 글' },
    { id: 'E1', label: '초등 저학년', range: '초1~2', edition: '초등 저학년판', note: '' },
    { id: 'E2', label: '초등 중학년', range: '초3~4', edition: '초등 중학년판', note: '' },
    { id: 'E3', label: '초등 고학년', range: '초5~6', edition: '초등 고학년판', note: '' },
    { id: 'M', label: '중등', range: '중1~3', edition: '중등판', note: '' },
  ];
  var TIER_IDS = TIERS.map(function (t) { return t.id; });
  var TIER_BY_ID = {};
  TIERS.forEach(function (t) { TIER_BY_ID[t.id] = t; });

  /* 웩슬러 지능검사(K-WISC-V) 다섯 기본 지표 — 두뇌 놀이 섹션은 반드시 이 중 하나를 겨냥한다.
     "두뇌 놀이"가 검사 문항의 복제이면 안 된다(검사 타당도를 해친다). 같은 인지 기능을 쓰는 놀이일 뿐이다. */
  var WISC = {
    VCI: { label: '언어이해', en: 'Verbal Comprehension', reading: '낱말의 뜻을 알고 공통점·차이를 말로 설명하는 힘 — 어휘·주제 파악' },
    VSI: { label: '시공간', en: 'Visual Spatial', reading: '모양을 머릿속에서 돌리고 맞추는 힘 — 도표·그림 자료 읽기' },
    FRI: { label: '유동추론', en: 'Fluid Reasoning', reading: '규칙을 찾아 새 문제에 적용하는 힘 — 추론 문항' },
    WMI: { label: '작업기억', en: 'Working Memory', reading: '읽은 것을 잠깐 붙들고 조작하는 힘 — 긴 문장·지시문 이해' },
    PSI: { label: '처리속도', en: 'Processing Speed', reading: '빠르고 정확하게 훑어보는 힘 — 읽기 속도·시험 시간 관리' },
  };
  var WISC_IDS = Object.keys(WISC);
  /* 지표 순환 — 5주에 다섯 지표가 학년대마다 한 번씩 돌고, 같은 주에는 다섯 학년대가 서로 다른 지표를 쓴다(라틴 방진).
     기준 주(39호)에 K 처리속도·E1 시공간·E2 작업기억·E3 유동추론·M 언어이해. 주제 달력이 주마다 덮어쓸 수 있다. */
  var WISC_ORDER = ['VCI', 'VSI', 'FRI', 'WMI', 'PSI'];
  var TIER_OFFSET = { M: 0, E1: 1, E3: 2, E2: 3, K: 4 };
  var BASE_WEEK = '2026-W39';

  var SECTION_TYPES = ['read', 'words', 'brain', 'column', 'coach', 'notice', 'checklist', 'news', 'poem', 'talk', 'write', 'books', 'voices'];
  var KICKER = { read: '이번 주 읽을거리', words: '한자 코너', brain: '두뇌 놀이터', column: '학부모 칼럼', coach: '한 줄 코칭', notice: '학원 게시판', checklist: '이번 주 미션', news: '이번 주 교육·입시 이슈',
    /* 어린이 잡지가 매 호 같은 자리에 두는 고정 코너들 — 시 한 편(낭독·필사), 가족 대화 카드, 한 문장 쓰기(요약·질문 만들기·기자 되기), 책 한 권, 지난 호 독자의 답 */
    poem: '이번 주 시 한 편', talk: '가족 대화 카드', write: '한 문장 쓰기', books: '이번 주 책 한 권', voices: '지난 호 독자의 답', cloze: '낱말 복습', daily: '오늘의 5분 · 두뇌 놀이' };
  /* 하루 한 장 — 한 호를 7일에 나눠 읽는다. 신문 한 부를 한자리에서 다 읽지 않듯 하루에 한 장씩 여는 리듬이라야
     기억에 남고(간격을 둔 반복) 가족 대화도 매일 한 토막씩 생긴다. 발행일이 1일째, 요일은 실제 날짜에서 센다.
     잠그지는 않는다 — 주말에 몰아 보는 가정도 있고, 지난 장을 다시 여는 것이 곧 복습이다. */
  var DAY_PLAN = [
    { day: 1, name: '읽을거리', sub: '이번 주 글을 읽어요 — 시와 가족 대화는 여유 있을 때', parts: ['lead', 'read-text', 'poem', 'talk'] },
    { day: 2, name: '읽고 답해요', sub: '어제 읽은 글로 문제를 풀고 한 문장으로 요약해요', parts: ['read-quiz', 'write'] },
    { day: 3, name: '한자 코너', sub: '낱말 가족을 익히고 손으로 써 봐요', parts: ['words', 'cloze'] },
    { day: 4, name: '두뇌 놀이터', sub: '머리를 쓰는 놀이를 해요', parts: ['brain'] },
    { day: 5, name: '학부모의 밤', sub: '부모님이 읽는 장이에요 — 칼럼·교육 이슈·책 한 권', parts: ['column', 'news', 'books', 'coach'] },
    { day: 6, name: '미션 점검', sub: '이번 주 미션을 마무리하고 친구들의 답을 읽어요', parts: ['checklist', 'voices', 'notice'] },
    { day: 7, name: '되돌아보기', sub: '내 답과 정답을 맞춰 보고 한 주를 마쳐요', parts: ['review'] },
  ];
  var SKILLS = ['main', 'detail', 'infer', 'vocab', 'apply', 'critical'];
  /* 학년대별 읽을거리 글자 수(공백 포함, 진로독서 content.test 와 같은 셈법) — 넘어도 경고만. 권장치를 넘긴 글이
     틀린 글은 아니지만, 유치부 글이 400자면 부모가 읽어 주다 지친다 */
  var READ_CHARS = { K: [50, 300], E1: [160, 480], E2: [380, 820], E3: [560, 1150], M: [800, 1600] };
  var ID_RE = /^\d{4}-W\d{2}(-[a-z0-9]{1,12})?$/;
  var WEEK_RE = /^\d{4}-W\d{2}$/;
  var SEC_ID_RE = /^[a-z0-9-]{2,30}$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var IMG_ID_RE = /^[a-f0-9]{32}$/;
  var IMG_FILE_RE = /^[a-z0-9-]{1,40}\.(svg|png|jpg|jpeg|webp)$/;
  var CIRCLED = ['①', '②', '③', '④', '⑤'];
  var DOWS = ['일', '월', '화', '수', '목', '금', '토'];
  var ISSUE_MAX_BYTES = 400 * 1024;

  /* 저장된 답은 원본 보기 번호다. 화면·인쇄만 같은 순서로 섞어 기존 기록의 뜻을 바꾸지 않는다. */
  function choiceOrder(q, sid, qi) {
    var order = (q.choices || []).map(function (_, i) { return i; });
    var seed = 2166136261, key = sid + ':' + qi + ':' + q.q;
    for (var k = 0; k < key.length; k += 1) seed = Math.imul(seed ^ key.charCodeAt(k), 16777619) >>> 0;
    for (var i = order.length - 1; i > 0; i -= 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      var j = Math.floor(seed / 4294967296 * (i + 1)), tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    return order;
  }
  function choiceMark(q, sid, qi, original) { return CIRCLED[choiceOrder(q, sid, qi).indexOf(original)] || ''; }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function byteLen(v) {
    var s = JSON.stringify(v);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    return Buffer.byteLength(s, 'utf8');
  }
  /* 도형 생성기는 따로 실린다(shapes.js) — 렌더할 때 찾는다. 없으면 도형 자리에 안내만 */
  function shapesLib() {
    if (typeof WBSHAPES !== 'undefined') return WBSHAPES;
    if (typeof require === 'function') { try { return require('./shapes.js'); } catch (e) { return null; } }
    return null;
  }
  /* 5분 두뇌 놀이 생성기(drills.js) — 시공간 밖 네 지표. 도형과 같은 방식으로 seed 만 싣는다 */
  function drillsLib() {
    if (typeof WBDRILLS !== 'undefined') return WBDRILLS;
    if (typeof require === 'function') { try { return require('./drills.js'); } catch (e) { return null; } }
    return null;
  }

  /* ── 날짜: KST 고정 ── */
  function kstParts(t) {
    var d = new Date((t == null ? Date.now() : +t) + 9 * 3600 * 1000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() };
  }
  function kstDate(t) { var p = kstParts(t); return p.y + '-' + pad2(p.m) + '-' + pad2(p.d); }
  function isValidDate(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
    var a = s.split('-').map(Number);
    var d = new Date(Date.UTC(a[0], a[1] - 1, a[2]));
    return d.getUTCFullYear() === a[0] && d.getUTCMonth() === a[1] - 1 && d.getUTCDate() === a[2];
  }
  /* ISO 주 — 월요일 시작, 1월 4일이 든 주가 1주. 뉴스레터 호수는 이 주 번호다(연 53호까지). */
  function isoWeekOf(y, m, d) {
    var date = new Date(Date.UTC(y, m - 1, d));
    var dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    var yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
    return { year: date.getUTCFullYear(), week: Math.ceil(((date - yearStart) / 86400000 + 1) / 7) };
  }
  function weekId(t) {
    var p = kstParts(t);
    var w = isoWeekOf(p.y, p.m, p.d);
    return w.year + '-W' + pad2(w.week);
  }
  /* 'YYYY-Www' → 그 주 월요일 'YYYY-MM-DD'. 발행일 기본값(월요일 아침 발송)에 쓴다. */
  function weekStart(week) {
    if (!WEEK_RE.test(str(week))) return null;
    var y = +week.slice(0, 4), w = +week.slice(6);
    if (w < 1 || w > 53) return null;
    var jan4 = new Date(Date.UTC(y, 0, 4));
    var mon1 = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000);
    var d = new Date(mon1.getTime() + (w - 1) * 7 * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function weekLabel(week) {
    if (!WEEK_RE.test(str(week))) return '';
    return week.slice(0, 4) + '년 ' + (+week.slice(6)) + '호';
  }
  function issueNo(week) { return WEEK_RE.test(str(week)) ? '제' + (+week.slice(6)) + '호' : ''; }
  function fmtDateKo(s) {
    if (!isValidDate(s)) return '';
    var a = s.split('-').map(Number), d = new Date(Date.UTC(a[0], a[1] - 1, a[2]));
    return a[0] + '년 ' + a[1] + '월 ' + a[2] + '일 ' + DOWS[d.getUTCDay()] + '요일';
  }
  /* 기준 주로부터 몇 주 뒤인가 — 주제 달력·지표 순환의 축 */
  function weekIndex(week) {
    var a = weekStart(week), b = weekStart(BASE_WEEK);
    if (!a || !b) return null;
    return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / (7 * 86400000));
  }
  function nextWeek(week) {
    var s = weekStart(week); if (!s) return null;
    return weekId(Date.parse(s + 'T00:00:00Z') + 7 * 86400000 - 9 * 3600 * 1000 + 12 * 3600 * 1000);
  }
  function rotationFor(week) {
    var i = weekIndex(week); if (i == null) return null;
    var out = {};
    TIER_IDS.forEach(function (t) { out[t] = WISC_ORDER[(((i + TIER_OFFSET[t]) % 5) + 5) % 5]; });
    return out;
  }
  /* 주제 달력 항목 — { theme, notes, indices } . 달력의 지표 지정이 있으면 그것, 없으면 순환값 */
  function calendarEntry(cal, week) {
    var w = isObj(cal) && isObj(cal.weeks) && isObj(cal.weeks[week]) ? cal.weeks[week] : {};
    var rot = rotationFor(week) || {};
    var indices = {};
    TIER_IDS.forEach(function (t) { indices[t] = (isObj(w.indices) && WISC[w.indices[t]]) ? w.indices[t] : rot[t]; });
    return { week: week, monday: weekStart(week), theme: str(w.theme), notes: str(w.notes), indices: indices, hasTheme: !!str(w.theme).trim() };
  }
  function checkCalendar(cal) {
    var errors = [];
    if (!isObj(cal)) return [{ where: 'calendar', msg: '객체가 아닙니다' }];
    if (!isObj(cal.weeks)) return [{ where: 'weeks', msg: 'weeks 객체가 필요합니다' }];
    var n = 0;
    Object.keys(cal.weeks).forEach(function (k) {
      n += 1;
      if (!WEEK_RE.test(k)) { errors.push({ where: k, msg: '주차 형식(YYYY-Www)이 아닙니다' }); return; }
      var w = cal.weeks[k];
      if (!isObj(w)) { errors.push({ where: k, msg: '객체가 아닙니다' }); return; }
      if (w.theme != null && (typeof w.theme !== 'string' || w.theme.length > 120)) errors.push({ where: k, msg: 'theme 는 120자 이내 문자열' });
      if (w.notes != null && (typeof w.notes !== 'string' || w.notes.length > 500)) errors.push({ where: k, msg: 'notes 는 500자 이내 문자열' });
      if (w.indices != null) {
        if (!isObj(w.indices)) errors.push({ where: k, msg: 'indices 는 {K:..,E1:..} 객체' });
        else Object.keys(w.indices).forEach(function (t) { if (!TIER_BY_ID[t] || !WISC[w.indices[t]]) errors.push({ where: k, msg: 'indices.' + t + ' 가 이상합니다: ' + w.indices[t] }); });
      }
    });
    if (n > 200) errors.push({ where: 'weeks', msg: '주차는 200개 이내' });
    return errors;
  }

  /* ── 학년대 판정 ──
     명부의 grade 문자열('초3'·'중1'·'7세'·'유치'·'3학년')을 읽는다. 원장이 letterTier 를 직접 지정했으면 그것이 이긴다.
     못 읽으면 진로독서 과정(level)으로 어림한다 — L1(7세~초2)→E1, L2(초3~6)→E2, L3·L4→M. */
  function tierFromGrade(grade) {
    var g = str(grade).replace(/\s+/g, '');
    if (!g) return null;
    if (/유치|유아|어린이집|누리|^K$|^k$/i.test(g)) return 'K';
    var age = g.match(/^(\d)\s*(세|살)/);
    if (age) return +age[1] <= 7 ? 'K' : (+age[1] <= 9 ? 'E1' : null);
    var m = g.match(/^(초|초등|초등학교)?(\d)(학년)?$/) || g.match(/^초등?(\d)학년$/);
    if (m && !/중|고/.test(g)) {
      var n = +m[m.length === 4 ? 2 : 1];
      if (n >= 1 && n <= 2) return 'E1';
      if (n >= 3 && n <= 4) return 'E2';
      if (n >= 5 && n <= 6) return 'E3';
      return null;
    }
    if (/^(중|중등|중학교|중학)\d?(학년)?$/.test(g) || /^(고|고등|고등학교|고등학)\d?(학년)?$/.test(g)) return 'M';
    if (/^중\d/.test(g) || /^고\d/.test(g)) return 'M';
    return null;
  }
  function tierOf(stu) {
    if (!isObj(stu)) return null;
    if (TIER_BY_ID[stu.letterTier]) return stu.letterTier;
    var t = tierFromGrade(stu.grade);
    if (t) return t;
    var lv = { L1: 'E1', L2: 'E2', L3: 'M', L4: 'M' };
    return lv[stu.level] || null;
  }
  function tierLabel(tier) { var t = TIER_BY_ID[tier]; return t ? t.label + '(' + t.range + ')' : ''; }
  function editionLabel(tier) { var t = TIER_BY_ID[tier]; return t ? t.edition + ' (' + t.range + ')' : '전체 학년대'; }

  /* ── 검증 ── */
  function checkImage(img, tag, E) {
    if (img == null) return;
    if (!isObj(img)) { E(tag, '사진(image)은 객체'); return; }
    var hasId = IMG_ID_RE.test(str(img.id)), hasFile = IMG_FILE_RE.test(str(img.file));
    if (hasId === hasFile) E(tag, '사진은 id(올린 사진) 또는 file(배포본 삽화) 중 하나만');
    if (!str(img.alt).trim()) E(tag, '사진에는 alt(그림 설명)가 필요합니다');
    else if (img.alt.length > 120) E(tag, 'alt 는 120자 이내');
    if (img.caption != null && (typeof img.caption !== 'string' || img.caption.length > 200)) E(tag, 'caption 은 200자 이내 문자열');
    /* 출처 없는 사진은 저장되지 않는다 — 자체 촬영·자체 제작·공공누리·CC0 만 싣는다(CLAUDE.md 절대 규칙 1) */
    if (!str(img.credit).trim()) E(tag, '사진에는 credit(출처·저작 표시)이 필요합니다 — 자체 촬영·제작이나 공공누리·CC0 만');
    else if (img.credit.length > 80) E(tag, 'credit 은 80자 이내');
    /* 크기(w·h)는 선택 — 있으면 사진이 오기 전에 자리를 잡아 글이 튀지 않는다. 한쪽만 있으면 비율을 못 만드니 둘 다 또는 둘 다 없이 */
    if (img.w != null || img.h != null) {
      var okDim = Number.isInteger(img.w) && Number.isInteger(img.h) && img.w >= 1 && img.h >= 1 && img.w <= 10000 && img.h <= 10000;
      if (!okDim) E(tag, '사진 w·h 는 1~10000 정수 한 쌍(둘 다 적거나 둘 다 비움)');
    }
  }
  function checkIssue(issue) {
    var errors = [], warnings = [];
    var E = function (where, msg) { errors.push({ where: where, msg: msg }); };
    var W = function (where, msg) { warnings.push({ where: where, msg: msg }); };
    if (!isObj(issue)) { E('issue', '객체가 아닙니다'); return { errors: errors, warnings: warnings }; }
    if (!ID_RE.test(str(issue.id))) E('id', 'id 는 YYYY-Www 또는 YYYY-Www-접미(소문자·숫자 1~12) 형식이어야 합니다');
    if (!WEEK_RE.test(str(issue.week))) E('week', 'week 는 YYYY-Www 형식이어야 합니다');
    else if (ID_RE.test(str(issue.id)) && issue.id.slice(0, 8) !== issue.week) E('week', 'id 는 week 로 시작해야 합니다');
    if (!isValidDate(issue.publishAt)) E('publishAt', '발행일은 YYYY-MM-DD 여야 합니다');
    if (issue.status !== 'draft' && issue.status !== 'published') E('status', 'status 는 draft 또는 published');
    if (!str(issue.title).trim()) E('title', '제목이 비었습니다');
    else if (issue.title.length > 80) E('title', '제목은 80자 이내');
    if (str(issue.theme).length > 120) E('theme', '주제는 120자 이내');
    if (issue.intro != null && typeof issue.intro !== 'string') E('intro', 'intro 는 문자열');
    else if (str(issue.intro).length > 800) E('intro', '머리말은 800자 이내');
    /* 라이선스 게이트(CLAUDE.md 절대 규칙 1) — 어디서 온 글인지 적지 않은 호는 저장되지 않는다 */
    if (!str(issue.source).trim()) E('source', 'source(출처·창작 표시)가 필요합니다 — 뉴스레터 글은 WB 자체 창작이어야 합니다');
    checkImage(issue.cover, 'cover', E);
    if (!Array.isArray(issue.sections) || !issue.sections.length) { E('sections', '섹션이 하나도 없습니다'); return { errors: errors, warnings: warnings }; }
    var ids = {};
    var covered = {}; TIER_IDS.forEach(function (t) { covered[t] = { read: 0, brain: 0 }; });
    var SH = shapesLib(), DR = drillsLib();
    issue.sections.forEach(function (s, i) {
      var tag = 'sections[' + i + ']' + (isObj(s) && s.id ? ' ' + s.id : '');
      if (!isObj(s)) { E(tag, '섹션이 객체가 아닙니다'); return; }
      if (!SEC_ID_RE.test(str(s.id))) E(tag, 'id 는 소문자·숫자·하이픈 2~30자');
      else if (ids[s.id]) E(tag, '섹션 id 중복: ' + s.id); else ids[s.id] = true;
      if (SECTION_TYPES.indexOf(s.type) < 0) { E(tag, '모르는 type: ' + s.type); return; }
      var tiers = s.tiers === 'all' ? TIER_IDS.slice() : s.tiers;
      if (!Array.isArray(tiers) || !tiers.length) E(tag, 'tiers 는 "all" 또는 학년대 배열(K·E1·E2·E3·M)');
      else {
        var seen = {};
        tiers.forEach(function (t) { if (!TIER_BY_ID[t]) E(tag, '모르는 학년대: ' + t); else if (seen[t]) E(tag, '학년대 중복: ' + t); seen[t] = true; });
      }
      if (str(s.title).length > 80) E(tag, '섹션 제목은 80자 이내');
      var validTiers = Array.isArray(tiers) ? tiers.filter(function (t) { return TIER_BY_ID[t]; }) : [];
      var strList = function (arr, name, min, max, maxLen) {
        if (!Array.isArray(arr)) { E(tag, name + ' 배열이 필요합니다'); return false; }
        if (arr.length < min || arr.length > max) E(tag, name + ' 는 ' + min + '~' + max + '개');
        var ok = true;
        arr.forEach(function (x, k) { if (typeof x !== 'string' || !x.trim()) { E(tag, name + '[' + k + '] 이 비었습니다'); ok = false; } else if (maxLen && x.length > maxLen) E(tag, name + '[' + k + '] 이 너무 깁니다(' + maxLen + '자)'); });
        return ok;
      };
      if (s.day != null && !(Number.isInteger(s.day) && s.day >= 1 && s.day <= 7)) E(tag, 'day 는 1~7(하루 한 장에서 열리는 날)');
      if (s.type !== 'checklist') checkImage(s.image, tag + ' image', E);
      if (s.images != null) {
        if (s.type !== 'read' && s.type !== 'column' && s.type !== 'notice') E(tag, 'images(여러 장)는 읽을거리·칼럼·게시판에만');
        else if (!Array.isArray(s.images) || s.images.length > 3) E(tag, 'images 는 3장 이내 배열');
        else s.images.forEach(function (im, k) { checkImage(im, tag + ' images[' + k + ']', E); });
      }
      if (s.type === 'read') {
        if (!str(s.title).trim()) E(tag, '읽을거리 제목이 비었습니다');
        if (strList(s.paragraphs, 'paragraphs', 1, 30, 2000)) {
          var chars = s.paragraphs.join('').replace(/\n/g, '').length;
          validTiers.forEach(function (t) {
            var lim = READ_CHARS[t];
            if (chars < lim[0] || chars > lim[1]) W(tag, tierLabel(t) + ' 글자 수 ' + chars + '자 (권장 ' + lim[0] + '~' + lim[1] + ')');
          });
        }
        if (s.minutes != null && !(Number.isInteger(s.minutes) && s.minutes >= 1 && s.minutes <= 30)) E(tag, 'minutes 는 1~30 정수');
        if (s.vocab != null) {
          if (!Array.isArray(s.vocab)) E(tag, 'vocab 은 배열');
          else s.vocab.forEach(function (v, k) {
            if (!isObj(v) || !str(v.word).trim() || !str(v.easy).trim()) { E(tag, 'vocab[' + k + '] word·easy 필요'); return; }
            if (Array.isArray(s.paragraphs) && !s.paragraphs.some(function (p) { return String(p).indexOf(v.word) >= 0; })) W(tag, '낱말 "' + v.word + '" 이 본문에 없습니다');
            if (v.hanja != null && typeof v.hanja !== 'string') E(tag, 'vocab[' + k + '] hanja 는 문자열');
          });
        }
        if (!Array.isArray(s.questions) || !s.questions.length) E(tag, '문제(questions)가 없습니다');
        else if (s.questions.length > 6) E(tag, '문제는 6개 이내');
        else s.questions.forEach(function (q, k) {
          var qt = tag + ' q' + (k + 1);
          if (!isObj(q) || !str(q.q).trim()) { E(qt, '발문이 비었습니다'); return; }
          if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 5) { E(qt, '보기는 2~5개'); return; }
          if (q.choices.some(function (c) { return typeof c !== 'string' || !c.trim(); })) E(qt, '빈 보기가 있습니다');
          if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.choices.length) E(qt, 'answer 는 보기 번호(0부터, ' + (q.choices.length - 1) + ' 이하)');
          if (q.skill != null && SKILLS.indexOf(q.skill) < 0) E(qt, '모르는 skill: ' + q.skill);
          if (q.why != null && typeof q.why !== 'string') E(qt, 'why 는 문자열');
        });
        validTiers.forEach(function (t) { covered[t].read += 1; });
      } else if (s.type === 'words') {
        if (!Array.isArray(s.words) || !s.words.length || s.words.length > 10) E(tag, 'words 는 1~10개');
        else s.words.forEach(function (w, k) { if (!isObj(w) || !str(w.word).trim() || !str(w.meaning).trim()) E(tag, 'words[' + k + '] word·meaning 필요'); });
        if (s.family != null && (!isObj(s.family) || !str(s.family.hanja).trim() || !str(s.family.hun).trim() || !str(s.family.eum).trim())) E(tag, 'family 는 {hanja, hun, eum}');
      } else if (s.type === 'brain') {
        if (WISC_IDS.indexOf(s.index) < 0) E(tag, 'index 는 웩슬러 지표(VCI·VSI·FRI·WMI·PSI) 중 하나');
        if (!Array.isArray(s.items) || !s.items.length || s.items.length > 10) E(tag, 'items 는 1~10개');
        else s.items.forEach(function (it, k) {
          var itag = tag + ' items[' + k + ']';
          if (!isObj(it)) { E(itag, '항목이 객체가 아닙니다'); return; }
          if (it.drill != null) {
            /* 5분 놀이 — 도형과 같은 규칙: seed 만 싣고 정답은 생성기가 낸다 */
            if (!DR) W(itag, '놀이 생성기(drills.js)가 없어 drill 을 검사하지 못했습니다');
            else if (!DR.isValidDrill(it.drill)) E(itag, 'drill 은 {kind: span|symbols|sequence|common|odd-word, seed: 1~999999}');
            else {
              /* 놀이는 학년대에 따라 난이도(길이·격자)가 달라 답도 다르다 — 이 섹션의 학년대들 중 하나와 맞으면 통과. 비워 두는 편이 안전하다 */
              var dgs = (validTiers.length ? validTiers : ['']).map(function (tt) { return DR.make(Object.assign({}, it.drill, { tier: tt })); }).filter(Boolean);
              if (dgs.length && str(it.answer).trim() && !dgs.some(function (g) { return it.answer.trim() === g.answerText; })) E(itag, '놀이 정답이 생성기와 다릅니다 — 생성기 답: ' + dgs[0].answerText + ' (answer 를 비우면 자동)');
              if (dgs.length && dgs[0].index !== s.index) W(itag, '놀이 종류(' + dgs[0].index + ')가 섹션 지표(' + s.index + ')와 다릅니다');
            }
          } else if (it.figure != null) {
            /* 도형 놀이 — 그림은 생성기가 seed 로 만들고, 정답도 생성기가 정한다. JSON 의 answer 는 그 답과 같아야 한다
               (원장이 답을 손으로 고쳐 어긋난 채 발행되면 아이가 맞히고도 틀렸다는 소리를 듣는다) */
            if (!SH) { W(itag, '도형 생성기(shapes.js)가 없어 figure 를 검사하지 못했습니다'); }
            else if (!SH.isValidFigure(it.figure)) E(itag, 'figure 는 {kind: odd|rotate|mirror|blocks|complete, seed: 1~999999}');
            else {
              var fgs = (validTiers.length ? validTiers : ['']).map(function (tt) { return SH.make(Object.assign({}, it.figure, { tier: tt })); }).filter(Boolean);
              if (fgs.length && str(it.answer).trim() && !fgs.some(function (g) { return it.answer.trim() === g.answerText; })) E(itag, '도형 정답이 생성기와 다릅니다 — 생성기 답: ' + fgs[0].answerText + ' (answer 를 비우면 자동)');
            }
            if (it.prompt != null && typeof it.prompt !== 'string') E(itag, 'prompt 는 문자열');
          } else {
            if (!str(it.prompt).trim()) { E(itag, 'prompt 필요'); return; }
            if (!str(it.answer).trim()) E(itag, 'answer 필요(열린 놀이면 "예시: …")');
          }
          if (it.grid != null && (!Array.isArray(it.grid) || it.grid.some(function (gg) { return typeof gg !== 'string'; }))) E(itag, 'grid 는 문자열 배열');
        });
        if (s.minutes != null && !(Number.isInteger(s.minutes) && s.minutes >= 1 && s.minutes <= 30)) E(tag, 'minutes 는 1~30 정수');
        validTiers.forEach(function (t) { covered[t].brain += 1; });
      } else if (s.type === 'column') {
        strList(s.paragraphs, 'paragraphs', 1, 20, 2000);
        if (s.takeaway != null && typeof s.takeaway !== 'string') E(tag, 'takeaway 는 문자열');
        if (s.byline != null && (typeof s.byline !== 'string' || s.byline.length > 40)) E(tag, 'byline 은 40자 이내 문자열');
      } else if (s.type === 'coach') {
        strList(s.tips, 'tips', 1, 6, 400);
      } else if (s.type === 'notice') {
        strList(s.items, 'items', 1, 10, 400);
      } else if (s.type === 'checklist') {
        strList(s.items, 'items', 1, 8, 200);
        if (s.itemTiers != null) {
          if (!Array.isArray(s.itemTiers) || !Array.isArray(s.items) || s.itemTiers.length !== s.items.length) E(tag, 'itemTiers 는 items 와 길이가 같은 배열');
          else s.itemTiers.forEach(function (ts, n) {
            if (ts !== 'all' && (!Array.isArray(ts) || !ts.length || ts.some(function (t) { return typeof t !== 'string' || TIER_IDS.indexOf(t) < 0; }) || new Set(ts).size !== ts.length)) E(tag, 'itemTiers[' + n + '] 는 "all" 또는 중복 없는 학년대 배열');
          });
        }
      } else if (s.type === 'poem') {
        /* 시는 연 사이에 빈 줄이 있다 — 빈 문자열을 연 나누기로 허용하되 전부 비면 안 된다 */
        if (!Array.isArray(s.lines) || s.lines.length < 1 || s.lines.length > 24) E(tag, 'lines 는 1~24줄');
        else {
          s.lines.forEach(function (l, k) { if (typeof l !== 'string') E(tag, 'lines[' + k + '] 은 문자열'); else if (l.length > 120) E(tag, 'lines[' + k + '] 이 너무 깁니다(120자)'); });
          if (!s.lines.some(function (l) { return typeof l === 'string' && l.trim(); })) E(tag, '시가 비었습니다');
        }
        if (s.author != null && (typeof s.author !== 'string' || s.author.length > 40)) E(tag, 'author 는 40자 이내 문자열 — 자체 창작 시만 싣는다');
        if (s.task != null && (typeof s.task !== 'string' || s.task.length > 200)) E(tag, 'task 는 200자 이내 문자열');
      } else if (s.type === 'talk') {
        strList(s.items, 'items', 1, 5, 200);
      } else if (s.type === 'write') {
        if (!Array.isArray(s.prompts) || !s.prompts.length || s.prompts.length > 4) E(tag, 'prompts 는 1~4개');
        else s.prompts.forEach(function (pq, k) {
          if (!isObj(pq) || !str(pq.q).trim() || pq.q.length > 200) E(tag, 'prompts[' + k + '] q 는 1~200자');
          if (isObj(pq) && pq.hint != null && (typeof pq.hint !== 'string' || pq.hint.length > 200)) E(tag, 'prompts[' + k + '] hint 는 200자 이내');
        });
      } else if (s.type === 'books') {
        if (!Array.isArray(s.items) || !s.items.length || s.items.length > 4) E(tag, '책은 1~4권');
        else s.items.forEach(function (b, k) {
          var btag = tag + ' items[' + k + ']';
          if (!isObj(b)) { E(btag, '항목이 객체가 아닙니다'); return; }
          if (!str(b.title).trim() || b.title.length > 80) E(btag, 'title 은 1~80자');
          if (b.author != null && (typeof b.author !== 'string' || b.author.length > 60)) E(btag, 'author 는 60자 이내');
          if (!str(b.why).trim() || b.why.length > 300) E(btag, 'why(왜 이 책인가)는 1~300자');
          if (b.for != null && (typeof b.for !== 'string' || b.for.length > 40)) E(btag, 'for 는 40자 이내');
        });
      } else if (s.type === 'voices') {
        /* 지난 호 독자의 답 — 이름은 원장이 줄여 적는다(성·이니셜). 아이 이름 전체가 지면에 나가지 않게 20자 상한 */
        if (!Array.isArray(s.items) || !s.items.length || s.items.length > 8) E(tag, '독자의 답은 1~8개');
        else s.items.forEach(function (v, k) {
          if (!isObj(v) || !str(v.who).trim() || v.who.length > 20) E(tag, 'items[' + k + '] who 는 1~20자');
          if (!isObj(v) || !str(v.text).trim() || v.text.length > 300) E(tag, 'items[' + k + '] text 는 1~300자');
        });
      } else if (s.type === 'news') {
        /* 교육·입시 이슈 — 학원 소식 대신 그 주의 교육·입시 뉴스를 3~5건 간추린다. 출처(기관·언론명) 없는 항목은 싣지 않고,
           링크는 https 원문만 받는다(앱에서만 열리고 인쇄본에는 출처명만 찍힌다) */
        if (!Array.isArray(s.items) || !s.items.length || s.items.length > 6) E(tag, '이슈(items)는 1~6개');
        else s.items.forEach(function (it, k) {
          var ntag = tag + ' items[' + k + ']';
          if (!isObj(it)) { E(ntag, '항목이 객체가 아닙니다'); return; }
          if (!str(it.title).trim() || it.title.length > 80) E(ntag, 'title 은 1~80자');
          if (!str(it.summary).trim() || it.summary.length > 400) E(ntag, 'summary 는 1~400자');
          if (it.why != null && (typeof it.why !== 'string' || it.why.length > 200)) E(ntag, 'why(우리 아이에게 뜻하는 것)는 200자 이내 문자열');
          if (!str(it.source).trim() || it.source.length > 60) E(ntag, 'source(기관·언론명)는 1~60자');
          if (it.url != null && it.url !== '' && (typeof it.url !== 'string' || !/^https:\/\/[^\s"'<>]{1,300}$/.test(it.url))) E(ntag, 'url 은 https:// 로 시작하는 주소(300자 이내)');
          if (it.date != null && it.date !== '' && !isValidDate(it.date)) E(ntag, 'date 는 YYYY-MM-DD');
        });
      }
    });
    TIER_IDS.forEach(function (t) {
      if (!covered[t].read) W('coverage', tierLabel(t) + ' 읽을거리가 없습니다 — 이 학년대 학생은 문제 없는 호를 받습니다');
      if (!covered[t].brain) W('coverage', tierLabel(t) + ' 두뇌 놀이가 없습니다');
    });
    if (!errors.length && byteLen(issue) > ISSUE_MAX_BYTES) E('issue', '호가 너무 큽니다(400KB 이내)');
    return { errors: errors, warnings: warnings };
  }

  /* ── 선택·가시성 ── */
  function sectionFor(s, tier) { return s.tiers === 'all' || (Array.isArray(s.tiers) && s.tiers.indexOf(tier) >= 0); }
  function forTier(issue, tier) {
    if (!isObj(issue)) return null;
    var out = {};
    Object.keys(issue).forEach(function (k) { out[k] = issue[k]; });
    out.sections = (issue.sections || []).filter(function (s) { return isObj(s) && sectionFor(s, tier); });
    out.tier = tier;
    return out;
  }
  function isVisible(issue, today) {
    return isObj(issue) && issue.status === 'published' && isValidDate(issue.publishAt) && issue.publishAt <= (today || kstDate());
  }
  function tiersOf(issue) {
    var set = {};
    (isObj(issue) && Array.isArray(issue.sections) ? issue.sections : []).forEach(function (s) {
      if (!isObj(s)) return;
      (s.tiers === 'all' ? TIER_IDS : (Array.isArray(s.tiers) ? s.tiers : [])).forEach(function (t) { if (TIER_BY_ID[t]) set[t] = true; });
    });
    return TIER_IDS.filter(function (t) { return set[t]; });
  }
  /* 파일럿 호 고르기 — 배포본 호 목록(letter/issues.json)에서 오늘 열려야 하는 호와 [지난 호] 목록을 낸다.
     발행일이 지난 것 중 가장 최근 호가 오늘의 호다. 아직 아무 호도 발행일이 안 됐으면 가장 이른 호를 미리 보여 준다 —
     파일럿에서 빈 화면은 "고장" 으로 보이기 때문이다. 아직 오지 않은 호는 목록에 넣지 않는다(열리지 않는 줄이 생긴다). */
  function pickPilot(list, today) {
    var day = isValidDate(today) ? today : kstDate();
    var ok = (Array.isArray(list) ? list : []).filter(function (b) { return isObj(b) && str(b.file) && isValidDate(b.publishAt); })
      .sort(function (a, b) { return String(a.publishAt).localeCompare(String(b.publishAt)); });
    /* 초안은 어떤 경우에도 가정에 나가지 않는다 — 발행된 호가 하나도 없으면 아예 없다고 답한다(앱은 체험 호로 넘어간다) */
    var pub = ok.filter(function (b) { return b.status !== 'draft'; });
    if (!pub.length) return null;
    var out = pub.filter(function (b) { return b.publishAt <= day; });
    var cur = out.length ? out[out.length - 1] : pub[0];
    return { cur: cur, list: (out.length ? out : [cur]).slice().reverse() };
  }
  function brief(issue) {
    return { id: issue.id, week: issue.week, title: issue.title, theme: issue.theme || '', publishAt: issue.publishAt, status: issue.status, tiers: tiersOf(issue), sections: (issue.sections || []).length };
  }
  /* 관리 웹 [빈 템플릿]·AI 초안의 뼈대 — 섹션 종류마다 한 개씩. 사진 자리는 비워 둔다(image: null) */
  function blankIssue(week) {
    var w = WEEK_RE.test(str(week)) ? week : weekId();
    var rot = rotationFor(w) || {};
    var read = function (t, minutes, nChoices) { return { id: 'read-' + t.toLowerCase(), type: 'read', tiers: [t], title: '', minutes: minutes, image: null, paragraphs: [''], vocab: t === 'K' ? [] : [{ word: '', easy: '', hanja: '' }], questions: [{ q: '', choices: Array.apply(null, Array(nChoices)).map(function () { return ''; }), answer: 0, why: '', skill: 'main' }] }; };
    var brain = function (t) { return { id: 'brain-' + t.toLowerCase(), type: 'brain', tiers: [t], title: '', index: rot[t] || 'FRI', minutes: 5, howTo: '', items: rot[t] === 'VSI' ? [{ figure: { kind: 'rotate', seed: 1 + Math.floor(Math.random() * 999) } }] : [{ prompt: '', answer: '' }], parentTip: '' }; };
    var coach = function (t, label) { return { id: 'coach-' + t.toLowerCase(), type: 'coach', tiers: [t], title: label + ' 부모님께', tips: [''] }; };
    var rk = read('K', 3, 2); rk.readAloud = true; rk.lead = '';
    return {
      id: w, week: w, publishAt: weekStart(w), status: 'draft',
      title: '', theme: '', intro: '', source: 'WB 독해력학원 자체 창작', cover: null,
      sections: [
        rk, read('E1', 5, 3), read('E2', 6, 4), read('E3', 8, 4), read('M', 10, 5),
        { id: 'words', type: 'words', tiers: ['E2', 'E3', 'M'], title: '', family: { hanja: '', hun: '', eum: '' }, words: [{ word: '', meaning: '', example: '' }], task: '' },
        brain('K'), brain('E1'), brain('E2'), brain('E3'), brain('M'),
        { id: 'mission', type: 'checklist', tiers: 'all', title: '이번 주 미션', items: [''] },
        { id: 'column', type: 'column', tiers: 'all', title: '', byline: '편집실', image: null, paragraphs: [''], takeaway: '' },
        coach('K', '유치부'), coach('E1', '초1~2'), coach('E2', '초3~4'), coach('E3', '초5~6'), coach('M', '중등'),
        { id: 'poem', type: 'poem', tiers: ['K', 'E1', 'E2'], title: '', author: 'WB 편집실', lines: [''], task: '' },
        { id: 'talk', type: 'talk', tiers: 'all', title: '오늘 저녁, 이 세 가지를 물어봐 주세요', items: ['', '', ''] },
        { id: 'write-e1', type: 'write', tiers: ['E1'], title: '한 문장으로', prompts: [{ q: '', hint: '' }] },
        { id: 'write-e2', type: 'write', tiers: ['E2'], title: '한 문장으로', prompts: [{ q: '', hint: '' }] },
        { id: 'write-e3', type: 'write', tiers: ['E3'], title: '한 문장으로', prompts: [{ q: '', hint: '' }] },
        { id: 'write-m', type: 'write', tiers: ['M'], title: '한 문장으로', prompts: [{ q: '', hint: '' }] },
        { id: 'books', type: 'books', tiers: 'all', title: '이번 주 책 한 권', items: [{ title: '', author: '', why: '', for: '' }] },
        { id: 'news', type: 'news', tiers: 'all', title: '이번 주 교육·입시 이슈', items: [{ title: '', summary: '', why: '', source: '', url: '', date: '' }] },
        { id: 'voices', type: 'voices', tiers: 'all', title: '지난 호 독자의 답', items: [{ who: '', text: '' }] },
        { id: 'notice', type: 'notice', tiers: 'all', title: '학원 게시판', items: [''] },
      ],
    };
  }

  /* ── 렌더링 ──
     opts: { mode: 'app'|'print', state: {quiz:{'sid:qi':idx}, checks:{'sid:i':true}, reveal:{'sid:i':true}},
             key: true|false(인쇄 정답 별지), imgBase: 'img/'(배포본 삽화 경로), apiBase: '' }
     반환은 HTML 문자열. 모든 문자열은 esc 를 거친다 — 호 JSON 은 관리자가 쓰지만 AI 초안이 섞이므로 믿지 않는다. */
  function imgSrc(img, o) {
    if (IMG_ID_RE.test(str(img.id))) return (o.apiBase || '') + '/api/letter/img/' + img.id;
    if (IMG_FILE_RE.test(str(img.file))) return (o.imgBase == null ? 'img/' : o.imgBase) + img.file;
    return '';
  }
  function photo(img, o, cls) {
    if (!isObj(img)) return '';
    var src = imgSrc(img, o);
    if (!src) return '';
    var dim = Number.isInteger(img.w) && Number.isInteger(img.h) && img.w > 0 && img.h > 0;
    /* 크기를 알면 자리를 먼저 잡아 사진이 오는 동안 글이 튀지 않는다(패드에서 특히 눈에 띈다). 앱에서는 눌러 크게 본다(index.html 의 돋보기) */
    return '<figure class="np-photo' + (cls ? ' ' + cls : '') + '">' + (o.mode === 'print' ? '' : '<button type="button" class="np-zoom" data-zoom="1" aria-label="사진 크게 보기: ' + esc(img.alt) + '">') + '<img src="' + esc(src) + '" alt="' + esc(img.alt) + '" loading="' + (o.mode === 'print' ? 'eager' : 'lazy') + '" decoding="async"' +
      (dim ? ' width="' + img.w + '" height="' + img.h + '" style="aspect-ratio:' + img.w + '/' + img.h + '"' : '') + '>' +
      (o.mode === 'print' ? '' : '</button>') +
      '<figcaption>' + esc(img.caption || '') + (img.credit ? '<span class="np-credit">' + esc(img.credit) + '</span>' : '') + '</figcaption></figure>';
  }
  function gallery(list, o) {
    if (!Array.isArray(list) || !list.length) return '';
    return '<div class="np-gallery">' + list.map(function (im) { return photo(im, o); }).join('') + '</div>';
  }
  function paras(list, cls, sid) {
    return (list || []).map(function (p, i) { return '<p class="' + cls + (i === 0 ? ' first' : '') + '"' + (sid ? ' data-p="' + esc(sid) + ':' + i + '"' : '') + '>' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }
  function secOpen(s, extraCls, kickerExtra) {
    return '<section class="np-sec np-' + esc(s.type) + (extraCls ? ' ' + extraCls : '') + '" id="sec-' + esc(s.id) + '"><div class="np-kicker">' + KICKER[s.type] + (kickerExtra || '') + '</div>';
  }
  function renderRead(s, tier, o) {
    var st = o.state || {};
    var h = secOpen(s, '', (s.readAloud ? ' · 부모가 읽어 주세요' : '') + (s.minutes ? ' · ' + s.minutes + '분' : ''));
    h += '<h2>' + esc(s.title) + '</h2>';
    if (s.lead) h += '<p class="np-lede">' + esc(s.lead) + '</p>';
    var body = photo(s.image, o);
    /* 읽어 주기 — 앱에서만(index.html 이 shared/voice.js 로 문단을 차례로 읽고 읽는 문단을 밝힌다). 유치부는 부모가 읽어 주지만
       기기가 한 번 더 읽어 주면 아이가 글자와 소리를 맞춰 본다 */
    if (o.mode !== 'print' && !o.noTts) body += '<div class="np-tts"><button type="button" class="np-ttsbtn" data-tts="' + esc(s.id) + '">🔊 읽어 주기</button><span class="np-tts-msg"></span></div>';
    body += '<div class="np-body">' + paras(s.paragraphs, 'np-p', s.id) + '</div>';
    body += gallery(s.images, o);
    if (Array.isArray(s.vocab) && s.vocab.length) {
      body += '<div class="np-vocab"><div class="np-boxhead">낱말 노트</div><ul>' + s.vocab.map(function (v) {
        return '<li><b>' + esc(v.word) + '</b>' + (v.hanja ? ' <span class="np-hanja">' + esc(v.hanja) + '</span>' : '') + ' — ' + esc(v.easy) + '</li>';
      }).join('') + '</ul></div>';
    }
    /* 2일째(읽고 답해요)는 본문을 접어 둔다 — 안 보고 풀어 보고, 막히면 펴서 다시 읽는다 */
    if (o.foldText) h += '<details class="np-fold"><summary>어제 읽은 글 다시 보기</summary>' + body + '</details>'; else h += body;
    if (!o.noQuiz && Array.isArray(s.questions) && s.questions.length) {
      h += '<div class="np-qs"><div class="np-boxhead">읽고 답해요</div>';
      s.questions.forEach(function (q, qi) {
        var picked = st.quiz && st.quiz[s.id + ':' + qi];
        var done = typeof picked === 'number';
        h += '<div class="np-q"><p class="np-qq"><span class="np-qn">' + (qi + 1) + '</span>' + esc(q.q) + '</p><div class="np-choices">';
        choiceOrder(q, s.id, qi).forEach(function (ci, shown) {
          var c = q.choices[ci];
          var cls = 'np-choice' + (done ? (ci === q.answer ? ' ok' : (ci === picked ? ' no' : ' dim')) : '');
          if (o.mode === 'print') h += '<div class="np-choice static">' + CIRCLED[shown] + ' ' + esc(c) + '</div>';
          else h += '<button type="button" class="' + cls + '" data-q="' + esc(s.id) + ':' + qi + ':' + ci + '"' + (done ? ' disabled' : '') + '>' + CIRCLED[shown] + ' ' + esc(c) + '</button>';
        });
        h += '</div>';
        if (o.mode === 'print') h += '<div class="np-blank">답 ______</div>';
        else if (done) h += '<div class="np-why ' + (picked === q.answer ? 'ok' : 'no') + '" data-feedback="' + esc(s.id) + ':' + qi + '" tabindex="-1">' + (picked === q.answer ? '맞았어요! ' : '정답은 ' + choiceMark(q, s.id, qi, q.answer) + '이에요. ') + esc(q.why || '') + '</div>';
        h += '</div>';
      });
      h += '</div>';
    }
    return h + '</section>';
  }
  function renderWords(s, tier, o) {
    var h = secOpen(s) + '<h2>' + esc(s.title) + '</h2>';
    if (s.family) {
      h += '<div class="np-family"><span class="np-fh">' + esc(s.family.hanja) + '</span><span class="np-fm">' + esc(s.family.hun) + ' <b>' + esc(s.family.eum) + '</b></span></div>';
      /* 따라쓰기 — 패드에서 손가락으로 세 번 쓴다(워드브레인 trace.js 의 안내 글자 옅어지기·최소 획 길이 판정을 그대로 쓴다). 앱에서만 */
      if (o.mode !== 'print' && !o.noTrace) h += '<div class="np-trace" data-trace="' + esc(s.family.hanja) + '" data-sid="' + esc(s.id) + '"><canvas width="240" height="240" aria-label="따라쓰기 칸"></canvas><div class="np-trace-ui"><span class="np-trace-msg">손가락으로 따라 써 보세요</span><span class="np-trace-btns"><button type="button" class="np-tbtn" data-trace-clear="1">지우기</button><button type="button" class="np-tbtn primary" data-trace-ok="1">다 썼어요</button></span></div></div>';
    }
    h += photo(s.image, o);
    h += '<ul class="np-wl">' + (s.words || []).map(function (w) {
      return '<li><b>' + esc(w.word) + '</b>' + (w.hanja ? ' <span class="np-hanja">' + esc(w.hanja) + '</span>' : '') + ' — ' + esc(w.meaning) + (w.example ? '<br><span class="np-ex">' + esc(w.example) + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
    if (s.task) h += '<div class="np-task">✎ ' + esc(s.task) + (o.mode === 'print' ? '<div class="np-lines"></div>' : '') + '</div>';
    return h + '</section>';
  }
  /* 두뇌 놀이 항목의 답 — 손으로 적은 answer, 도형 생성기, 5분 놀이 생성기 중 하나 */
  function brainAnswer(it, tier) {
    var SH = shapesLib(), DR = drillsLib();
    var gen = it.figure && SH ? SH.make(Object.assign({}, it.figure, { tier: tier || it.figure.tier || '' })) : (it.drill && DR ? DR.make(Object.assign({}, it.drill, { tier: tier || it.drill.tier || '' })) : null);
    return { gen: gen, prompt: str(it.prompt).trim() || (gen ? gen.prompt : ''), answer: gen ? gen.answerText : str(it.answer), hint: str(it.hint) || (gen ? gen.hint : '') };
  }
  function renderBrain(s, tier, o) {
    var st = o.state || {};
    var w = WISC[s.index] || { label: '', reading: '' };
    var SH = shapesLib(), DR = drillsLib();
    var h = secOpen(s, '', (s.minutes ? ' · ' + s.minutes + '분' : ''));
    h += '<h2>' + esc(s.title) + '</h2><div class="np-idx"><b>' + esc(w.label) + '</b> ' + esc(s.index) + ' — ' + esc(w.reading) + '</div>';
    h += photo(s.image, o);
    if (s.howTo) h += '<p class="np-howto">' + esc(s.howTo).replace(/\n/g, '<br>') + '</p>';
    (s.items || []).forEach(function (it, i) {
      var key = s.id + ':' + i;
      var open = st.reveal && st.reveal[key];
      var ba = brainAnswer(it, tier), prompt = ba.prompt, answer = ba.answer, hint = ba.hint;
      h += '<div class="np-bi"><p class="np-bp"><span class="np-qn">' + (i + 1) + '</span>' + esc(prompt).replace(/\n/g, '<br>') + '</p>';
      if (it.figure) h += (SH ? SH.html(Object.assign({}, it.figure, { tier: tier || it.figure.tier || '' })) : '<div class="np-fig np-fig-missing">도형은 앱 화면에서 볼 수 있어요.</div>');
      else if (it.drill) h += (DR ? DR.html(Object.assign({}, it.drill, { tier: tier || it.drill.tier || '' })) : '<div class="np-dr np-dr-missing">놀이는 앱 화면에서 볼 수 있어요.</div>');
      if (Array.isArray(it.grid) && it.grid.length) h += '<pre class="np-grid">' + it.grid.map(esc).join('\n') + '</pre>';
      if (o.mode === 'print') h += '<div class="np-blank">답 ______</div>';
      else {
        h += '<button type="button" class="np-reveal" data-ans="' + esc(key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' + (open ? '정답 숨기기' : '정답 보기') + '</button>';
        if (open) h += '<div class="np-ans">' + esc(answer) + (hint ? '<br><span class="np-ex">' + esc(hint) + '</span>' : '') + '</div>';
      }
      h += '</div>';
    });
    if (s.parentTip) h += '<div class="np-tip"><b>부모님 팁</b> ' + esc(s.parentTip) + '</div>';
    return h + '</section>';
  }
  function renderColumn(s, tier, o) {
    var h = secOpen(s) + '<h2>' + esc(s.title) + '</h2>' + (s.byline ? '<div class="np-byline">' + esc(s.byline) + '</div>' : '');
    h += photo(s.image, o);
    h += '<div class="np-cols">' + paras(s.paragraphs, 'np-p') + '</div>' + gallery(s.images, o);
    if (s.takeaway) h += '<div class="np-take">한 줄 요약 — ' + esc(s.takeaway) + '</div>';
    return h + '</section>';
  }
  function renderCoach(s, tier, o) {
    return secOpen(s) + '<h2>' + esc(s.title) + '</h2>' + photo(s.image, o) + '<ul class="np-tips">' + (s.tips || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></section>';
  }
  function renderNotice(s, tier, o) {
    return secOpen(s) + '<h2>' + esc(s.title) + '</h2>' + photo(s.image, o) + '<ul class="np-notes">' + (s.items || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' + gallery(s.images, o) + '</section>';
  }
  function checklistItems(s, tier) {
    return (s.items || []).map(function (text, index) { return { text: text, index: index }; }).filter(function (it) {
      var ts = s.itemTiers && s.itemTiers[it.index];
      return !tier || !ts || ts === 'all' || (Array.isArray(ts) && ts.indexOf(tier) >= 0);
    });
  }
  function renderChecklist(s, tier, o) {
    var st = o.state || {};
    return secOpen(s) + '<h2>' + esc(s.title) + '</h2><ul class="np-cl">' + checklistItems(s, tier).map(function (it) {
      var t = it.text, key = s.id + ':' + it.index, on = !!(st.checks && st.checks[key]);
      if (o.mode === 'print') return '<li><span class="np-box"></span> ' + esc(t) + '</li>';
      return '<li><label><input type="checkbox" data-chk="' + esc(key) + '"' + (on ? ' checked' : '') + '> <span' + (on ? ' class="done"' : '') + '>' + esc(t) + '</span></label></li>';
    }).join('') + '</ul></section>';
  }
  /* 인쇄 정답 별지 — 문제·두뇌 놀이의 답과 해설을 마지막 쪽에 모은다(학습지로 쓸 수 있게) */
  function renderKey(issue, tier) {
    var rows = '';
    var SH = shapesLib();
    (issue.sections || []).forEach(function (s) {
      if (s.type === 'read' && Array.isArray(s.questions) && s.questions.length) {
        rows += '<div class="np-krow"><b>' + esc(s.title) + '</b><ol>' + s.questions.map(function (q, qi) { return '<li>' + choiceMark(q, s.id, qi, q.answer) + (q.why ? ' — ' + esc(q.why) : '') + '</li>'; }).join('') + '</ol></div>';
      }
      if (s.type === 'brain' && Array.isArray(s.items)) {
        rows += '<div class="np-krow"><b>' + esc(s.title) + '</b><ol>' + s.items.map(function (it) {
          var ba = brainAnswer(it, tier), ans = ba.answer, hint = ba.hint;
          return '<li>' + esc(ans) + (hint ? ' <span class="np-ex">(' + esc(hint) + ')</span>' : '') + '</li>';
        }).join('') + '</ol></div>';
      }
    });
    if (!rows) return '';
    return '<section class="np-sec np-key"><div class="np-kicker">정답과 해설</div><h2>' + esc(issue.title) + ' — 답지</h2>' + rows + '</section>';
  }
  function renderNews(s, tier, o) {
    var h = secOpen(s) + '<h2>' + esc(s.title) + '</h2>' + photo(s.image, o) + '<ol class="np-newsl">';
    (s.items || []).forEach(function (it) {
      var src = esc(it.source || '') + (it.date ? ' · ' + esc(it.date) : '');
      h += '<li><b>' + esc(it.title) + '</b><p>' + esc(it.summary) + '</p>' + (it.why ? '<p class="np-newswhy">우리 아이에게 — ' + esc(it.why) + '</p>' : '') +
        '<span class="np-src">' + (o.mode !== 'print' && /^https:\/\//.test(str(it.url)) ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' + src + ' ↗</a>' : src) + '</span></li>';
    });
    return h + '</ol></section>';
  }
  function renderPoem(s, tier, o) {
    var h = secOpen(s) + '<h2>' + esc(s.title) + '</h2>' + (s.author ? '<div class="np-byline">' + esc(s.author) + '</div>' : '');
    if (o.mode !== 'print' && !o.noTts) h += '<div class="np-tts"><button type="button" class="np-ttsbtn" data-tts="' + esc(s.id) + '">🔊 읽어 주기</button><span class="np-tts-msg"></span></div>';
    h += '<div class="np-poem">' + (s.lines || []).map(function (l, i) { return str(l).trim() ? '<p class="np-line" data-p="' + esc(s.id) + ':' + i + '">' + esc(l) + '</p>' : '<p class="np-line np-stanza"></p>'; }).join('') + '</div>';
    /* 필사 — 신문 활용 교육에서 효과가 검증된 활동. 화면에서는 안내만, 인쇄본에는 옮겨 쓸 줄을 준다 */
    h += '<div class="np-task">✎ ' + esc(s.task || '마음에 드는 두 줄을 골라 소리 내어 읽고, 공책에 또박또박 옮겨 써 보세요.') + (o.mode === 'print' ? '<div class="np-lines np-lines-tall"></div>' : '') + '</div>';
    return h + '</section>';
  }
  function renderTalk(s, tier, o) {
    return secOpen(s) + '<h2>' + esc(s.title) + '</h2><ul class="np-talk">' + (s.items || []).map(function (q) { return '<li><span class="np-bubble">' + esc(q) + '</span></li>'; }).join('') + '</ul>' +
      '<p class="np-ex">답이 아니라 이유를 물어봐 주세요 — "왜 그렇게 생각해?" 한 마디면 충분해요.</p></section>';
  }
  function renderWrite(s, tier, o) {
    var st = o.state || {};
    var h = secOpen(s) + '<h2>' + esc(s.title) + '</h2>';
    (s.prompts || []).forEach(function (pq, i) {
      var key = s.id + ':' + i, saved = st.write && typeof st.write[key] === 'string' ? st.write[key] : '';
      h += '<div class="np-wq"><p class="np-qq" id="write-label-' + esc(key) + '"><span class="np-qn">' + (i + 1) + '</span>' + esc(pq.q) + '</p>' + (pq.hint ? '<p class="np-ex">' + esc(pq.hint) + '</p>' : '');
      if (o.mode === 'print') h += '<div class="np-lines np-lines-tall"></div>';
      else h += '<textarea class="np-ta" data-write="' + esc(key) + '" aria-labelledby="write-label-' + esc(key) + '" maxlength="300" rows="3" placeholder="여기에 써 보세요 (300자까지)">' + esc(saved) + '</textarea><div class="np-ta-note">쓰면 저절로 저장돼요. 7일째 되돌아보기에서 다시 볼 수 있어요.</div>';
      h += '</div>';
    });
    return h + '</section>';
  }
  function renderBooks(s, tier, o) {
    return secOpen(s) + '<h2>' + esc(s.title) + '</h2>' + photo(s.image, o) + '<ul class="np-books">' + (s.items || []).map(function (b) {
      return '<li><b>' + esc(b.title) + '</b>' + (b.author ? ' <span class="np-hanja">' + esc(b.author) + '</span>' : '') + (b.for ? ' <span class="np-for">' + esc(b.for) + '</span>' : '') + '<p>' + esc(b.why) + '</p></li>';
    }).join('') + '</ul></section>';
  }
  function renderVoices(s, tier, o) {
    return secOpen(s) + '<h2>' + esc(s.title) + '</h2><ul class="np-voices">' + (s.items || []).map(function (v) { return '<li><span class="np-quote">' + esc(v.text) + '</span><span class="np-who">— ' + esc(v.who) + '</span></li>'; }).join('') + '</ul></section>';
  }
  /* 낱말 복습 — 읽을거리의 낱말 노트에서 저절로 만든다: 본문에서 그 낱말이 든 문장을 찾아 빈칸으로. 사람이 문제를 더 짓지 않아도
     3일째에 어제 읽은 글의 낱말을 한 번 더 만난다(간격 반복) */
  function clozeFor(read, seed) {
    if (!isObj(read) || !Array.isArray(read.vocab) || read.vocab.length < 2) return [];
    var rnd = shapesLib() ? shapesLib().seeded(seed || 1) : function () { return 0.5; };
    var sentences = [];
    (read.paragraphs || []).forEach(function (p) { String(p).split(/(?<=[.!?。])\s+/).forEach(function (x) { if (x.trim()) sentences.push(x.trim()); }); });
    var words = read.vocab.map(function (v) { return str(v.word).trim(); }).filter(Boolean);
    var items = [];
    words.forEach(function (w) {
      if (items.length >= 4) return;
      var sent = null;
      for (var i = 0; i < sentences.length; i++) if (sentences[i].indexOf(w) >= 0) { sent = sentences[i]; break; }
      if (!sent) return;
      var others = words.filter(function (x) { return x !== w; });
      var picked = [];
      var pool = others.slice();
      while (picked.length < 3 && pool.length) picked.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
      var choices = picked.concat([w]);
      for (var k = choices.length - 1; k > 0; k--) { var j = Math.floor(rnd() * (k + 1)); var t = choices[k]; choices[k] = choices[j]; choices[j] = t; }
      items.push({ q: sent.split(w).join('____'), choices: choices, answer: choices.indexOf(w), why: '본문: ' + sent });
    });
    return items;
  }
  function renderCloze(read, tier, o) {
    var items = clozeFor(read, weekIndex(str(read.id).slice(0, 8)) || 1), st = o.state || {};
    if (!items.length) return '';
    var sid = 'cloze-' + read.id;
    var h = '<section class="np-sec np-cloze" id="sec-' + esc(sid) + '"><div class="np-kicker">' + KICKER.cloze + '</div><h2>어제 읽은 글의 낱말, 빈칸에 무엇이 들어갈까요?</h2><div class="np-qs">';
    items.forEach(function (q, qi) {
      var picked = st.quiz && st.quiz[sid + ':' + qi], done = typeof picked === 'number';
      h += '<div class="np-q"><p class="np-qq"><span class="np-qn">' + (qi + 1) + '</span>' + esc(q.q) + '</p><div class="np-choices">';
      choiceOrder(q, sid, qi).forEach(function (ci, shown) {
        var c = q.choices[ci];
        var cls = 'np-choice' + (done ? (ci === q.answer ? ' ok' : (ci === picked ? ' no' : ' dim')) : '');
        if (o.mode === 'print') h += '<div class="np-choice static">' + CIRCLED[shown] + ' ' + esc(c) + '</div>';
        else h += '<button type="button" class="' + cls + '" data-q="' + esc(sid) + ':' + qi + ':' + ci + '"' + (done ? ' disabled' : '') + '>' + CIRCLED[shown] + ' ' + esc(c) + '</button>';
      });
      h += '</div>' + (o.mode !== 'print' && done ? '<div class="np-why ' + (picked === q.answer ? 'ok' : 'no') + '" data-feedback="' + esc(sid) + ':' + qi + '" tabindex="-1">' + (picked === q.answer ? '맞았어요! ' : '정답은 ' + choiceMark(q, sid, qi, q.answer) + '이에요. ') + esc(q.why) + '</div>' : '') + '</div>';
    });
    return h + '</div></section>';
  }
  /* 오늘의 5분 — 매일 같은 자리에 놓이는 고정 놀이(어린이 잡지의 숨은그림찾기처럼). 주차·학년대·요일이 문제를 정한다 */
  function renderDaily(issue, tier, day, o) {
    var DR = drillsLib(); if (!DR) return '';
    var d = DR.daily(issue.week, tier || '', day), g = DR.make(d);
    if (!g) return '';
    var st = o.state || {}, key = 'daily-' + day + ':0', open = st.reveal && st.reveal[key];
    var w = WISC[g.index] || { label: '', reading: '' };
    var h = '<section class="np-sec np-brain np-daily5" id="sec-daily-' + day + '"><div class="np-kicker">' + KICKER.daily + '</div><h2>' + esc(g.label) + '</h2>' +
      '<div class="np-idx"><b>' + esc(w.label) + '</b> ' + esc(g.index) + ' — ' + esc(w.reading) + '</div><p class="np-bp">' + esc(g.prompt) + '</p>' + DR.html(d);
    if (o.mode !== 'print') { h += '<button type="button" class="np-reveal" data-ans="' + esc(key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' + (open ? '정답 숨기기' : '정답 보기') + '</button>'; if (open) h += '<div class="np-ans">' + esc(g.answerText) + (g.hint ? '<br><span class="np-ex">' + esc(g.hint) + '</span>' : '') + '</div>'; }
    return h + '</section>';
  }
  var RENDER = { read: renderRead, words: renderWords, brain: renderBrain, column: renderColumn, coach: renderCoach, notice: renderNotice, checklist: renderChecklist, news: renderNews, poem: renderPoem, talk: renderTalk, write: renderWrite, books: renderBooks, voices: renderVoices };

  /* ── 하루 한 장 ── */
  function dayStart(issue) { return isObj(issue) ? (isValidDate(issue.publishAt) ? issue.publishAt : weekStart(issue.week)) : null; }
  function dayOf(issue, now) {
    var start = dayStart(issue); if (!start) return 1;
    var d = Math.floor((Date.parse(kstDate(now) + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1;
    return d < 1 ? 1 : (d > 7 ? 7 : d);
  }
  function dayDate(issue, day) {
    var start = dayStart(issue); if (!start) return '';
    var d = new Date(Date.parse(start + 'T00:00:00Z') + ((day | 0) - 1) * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function dayDow(issue, day) { var s = dayDate(issue, day); return s ? DOWS[new Date(s + 'T00:00:00Z').getUTCDay()] : ''; }
  /* 그날의 장 — 어떤 섹션을 어떤 모양으로 그리는지. 그 학년대에 그날 섹션이 없으면(유치부의 한자 코너처럼) 읽을거리를 다시 읽는다 —
     한 번 더 읽으면 더 잘 보이고, 빈 화면보다 낫다 */
  function dayPage(issue, tier, day) {
    var plan = DAY_PLAN[Math.min(7, Math.max(1, day | 0)) - 1];
    var view = TIER_BY_ID[tier] ? forTier(issue, tier) : issue;
    var secs = (view.sections || []).filter(isObj);
    /* 섹션의 day 지정이 있으면 그날에만 — 없으면 종류로 정한 날(쓰기는 2일째가 기본이고 day:6 으로 미션 날에 둘 수 있다) */
    var placed = function (x) { return Number.isInteger(x.day) && x.day >= 1 && x.day <= 7; };
    var of = function (type) { return secs.filter(function (x) { return x.type === type && (!placed(x) || x.day === plan.day); }); };
    var items = [];
    plan.parts.forEach(function (part) {
      if (part === 'lead') items.push({ part: 'lead' });
      else if (part === 'read-text') of('read').forEach(function (x) { items.push({ part: 'read', section: x, opts: { noQuiz: true } }); });
      else if (part === 'read-quiz') of('read').forEach(function (x) { if (Array.isArray(x.questions) && x.questions.length) items.push({ part: 'read', section: x, opts: { foldText: true, noTts: true } }); });
      else if (part === 'cloze') secs.filter(function (x) { return x.type === 'read'; }).forEach(function (x) { if (clozeFor(x, 1).length) items.push({ part: 'cloze', section: x }); });
      else if (part === 'review') items.push({ part: 'review' });
      else of(part).forEach(function (x) { items.push({ part: part, section: x, opts: {} }); });
    });
    secs.filter(function (x) { return placed(x) && x.day === plan.day; }).forEach(function (x) { if (!items.some(function (it) { return it.section === x; }) && RENDER[x.type]) items.push({ part: x.type, section: x, opts: {} }); });
    var again = !items.some(function (it) { return it.section || it.part === 'review'; });
    if (again) of('read').forEach(function (x) { items.push({ part: 'read', section: x, opts: { noQuiz: true } }); });
    if (plan.day < 7) items.push({ part: 'daily' });
    var noWords = plan.day === 3 && !items.some(function (it) { return it.part === 'words'; });
    return { day: plan.day, name: noWords ? (again ? '다시 읽기' : '낱말 복습') : plan.name, sub: noWords ? '읽었던 글의 낱말을 다시 만나 봐요' : plan.sub, date: dayDate(issue, plan.day), dow: dayDow(issue, plan.day), items: items, again: again };
  }
  /* 7일째 — 내가 고른 답과 정답을 나란히. 안 푼 문제는 정답을 바로 보이지 않고 풀 기회를 남긴다 */
  function renderReview(view, tier, o) {
    var st = o.state || {}, SH = shapesLib();
    var rows = '', total = 0, correct = 0, answered = 0, checks = 0, cTotal = 0;
    (view.sections || []).forEach(function (s) {
      if (s.type === 'read' && Array.isArray(s.questions) && s.questions.length) {
        rows += '<div class="np-krow"><b>' + esc(s.title) + '</b><ol>' + s.questions.map(function (q, qi) {
          total += 1;
          var picked = st.quiz && st.quiz[s.id + ':' + qi], done = typeof picked === 'number', ok = done && picked === q.answer;
          if (done) { answered += 1; if (ok) correct += 1; }
          if (!done) return '<li class="skip">아직 안 풀었어요 — 화요일 장에서 풀어 보세요</li>';
          return '<li class="' + (ok ? 'ok' : 'no') + '">' + (ok ? '○ 정답 ' : '✕ 내 답 ' + choiceMark(q, s.id, qi, picked) + ' → 정답 ') + choiceMark(q, s.id, qi, q.answer) + (q.why ? ' <span class="np-ex">' + esc(q.why) + '</span>' : '') + '</li>';
        }).join('') + '</ol></div>';
      }
      if (s.type === 'brain' && Array.isArray(s.items)) {
        rows += '<div class="np-krow"><b>' + esc(s.title) + '</b><ol>' + s.items.map(function (it) {
          var ba = brainAnswer(it, tier), ans = ba.answer, hint = ba.hint;
          return '<li>' + esc(ans) + (hint ? ' <span class="np-ex">(' + esc(hint) + ')</span>' : '') + '</li>';
        }).join('') + '</ol></div>';
      }
      if (s.type === 'checklist') checklistItems(s, tier).forEach(function (it) { cTotal += 1; if (st.checks && st.checks[s.id + ':' + it.index]) checks += 1; });
    });
    var czTotal = 0, czOk = 0, writes = [];
    (view.sections || []).forEach(function (s) {
      if (s.type === 'read') clozeFor(s, weekIndex(str(s.id).slice(0, 8)) || 1).forEach(function (q, qi) { var pk = st.quiz && st.quiz['cloze-' + s.id + ':' + qi]; if (typeof pk === 'number') { czTotal += 1; if (pk === q.answer) czOk += 1; } });
      if (s.type === 'write') (s.prompts || []).forEach(function (pq, i) { var v = st.write && st.write[s.id + ':' + i]; if (typeof v === 'string' && v.trim()) writes.push({ q: pq.q, a: v.trim() }); });
    });
    var h = '<section class="np-sec np-review"><div class="np-kicker">이번 주 돌아보기</div><h2>' + esc(view.title) + '</h2>';
    if (total || cTotal || czTotal) h += '<div class="np-score">' + (total ? '<div><b>' + correct + '</b>/' + total + '<span>맞힌 문제</span></div>' : '') + (czTotal ? '<div><b>' + czOk + '</b>/' + czTotal + '<span>낱말 복습</span></div>' : '') + (cTotal ? '<div><b>' + checks + '</b>/' + cTotal + '<span>마친 미션</span></div>' : '') + '</div>';
    if (writes.length) h += '<div class="np-mywrite"><div class="np-boxhead">이번 주 내가 쓴 문장</div>' + writes.map(function (w) { return '<p class="np-ex">' + esc(w.q) + '</p><p class="np-mine">' + esc(w.a) + '</p>'; }).join('') + '</div>';
    if (total && answered < total) h += '<p class="np-howto">아직 안 푼 문제가 ' + (total - answered) + '개 있어요. 화요일 장에서 풀고 다시 오면 여기서 맞춰 볼 수 있어요.</p>';
    h += rows;
    if (o.nextTheme) h += '<div class="np-next"><b>다음 주 예고</b>' + esc(o.nextTheme) + '</div>';
    return h + '</section>';
  }
  function renderDay(issue, tier, day, opts) {
    var o = opts || {};
    if (!isObj(issue)) return '';
    var t = TIER_BY_ID[tier] ? tier : null;
    var pg = dayPage(issue, t, day);
    var view = t ? forTier(issue, t) : issue;
    var h = '<article class="np np-daily" data-tier="' + esc(t || '') + '" data-day="' + pg.day + '">';
    h += '<div class="np-dhead"><div class="np-dmeta"><span>' + esc(issueNo(issue.week)) + '</span><span>' + pg.day + '일째</span>' + (pg.date ? '<span>' + esc(fmtDateKo(pg.date)) + '</span>' : '') + (issue.status === 'draft' ? '<span class="np-draft">초안</span>' : '') + '</div>' +
      '<h1 class="np-dtitle">' + esc(pg.name) + '</h1><p class="np-dsub">' + esc(pg.again ? '오늘은 다시 읽는 날 — 한 번 더 읽으면 더 잘 보여요' : pg.sub) + '</p></div>';
    if (pg.day === 1) {
      var extra = pg.items.filter(function (it) { return ['poem', 'talk', 'daily'].indexOf(it.part) >= 0; }).map(function (it) { return it.part === 'poem' ? '시 한 편' : it.part === 'talk' ? '가족 대화' : '오늘의 5분'; });
      h += '<p class="np-howto"><b>오늘의 기본</b> · 읽을거리 한 편을 읽어요.' + (extra.length ? '<br><b>여유가 있으면</b> · ' + extra.join(' · ') + '도 해 보세요.' : '') + '</p>';
    }
    pg.items.forEach(function (it) {
      if (it.part === 'lead') {
        h += '<div class="np-lead"><div class="np-kicker">이번 주 주제</div><h2 class="np-h1">' + esc(issue.title) + '</h2>' + (issue.theme ? '<p class="np-deck">' + esc(issue.theme) + '</p>' : '') +
          photo(issue.cover, o, 'np-cover') + (issue.intro ? '<p class="np-intro">' + esc(issue.intro).replace(/\n/g, '<br>') + '</p>' : '') + '</div>';
      } else if (it.part === 'review') {
        h += renderReview(view, t, o);
      } else if (it.part === 'cloze') {
        h += renderCloze(it.section, t, o);
      } else if (it.part === 'daily') {
        h += renderDaily(issue, t, pg.day, o);
      } else if (it.section && RENDER[it.section.type]) {
        var so = {}; Object.keys(o).forEach(function (k) { so[k] = o[k]; }); Object.keys(it.opts).forEach(function (k) { so[k] = it.opts[k]; });
        h += RENDER[it.section.type](it.section, t, so);
      }
    });
    return h + '</article>';
  }
  /* 7일 띠 — 오늘 장은 진하게, 마친 날은 ✓, 아직 오지 않은 날은 옅게(열 수는 있다) */
  function renderDayStrip(issue, cur, today, state, tier) {
    var st = state || {};
    return '<nav class="np-strip" aria-label="하루 한 장">' + DAY_PLAN.map(function (p) {
      var done = !!(st.days && st.days[p.day]);
      var cls = 'np-sday' + (p.day === cur ? ' cur' : '') + (done ? ' done' : '') + (p.day > today ? ' future' : '');
      return '<button type="button" class="' + cls + '" data-day="' + p.day + '"' + (p.day === cur ? ' aria-current="page"' : '') + '><span class="np-sdow">' + esc(dayDow(issue, p.day) || String(p.day)) + '</span><span class="np-sname">' + esc(tier && p.day === 3 ? dayPage(issue, tier, p.day).name : p.name) + '</span>' + (done ? '<span class="np-sok">✓</span>' : '') + '</button>';
    }).join('') + '</nav>';
  }

  function renderIssue(issue, tier, opts) {
    var o = opts || {};
    if (!isObj(issue)) return '';
    var t = TIER_BY_ID[tier] ? tier : null;
    var view = t ? forTier(issue, t) : issue;
    var sections = view.sections || [];
    var main = [], side = [], wide = [], narrow = [];
    sections.forEach(function (s) {
      if (!isObj(s) || !RENDER[s.type]) return;
      if (s.type === 'read') main.push(s);
      else if (s.type === 'column') wide.push(s);
      else if (s.type === 'coach' || s.type === 'notice' || s.type === 'news') narrow.push(s);
      else side.push(s);
    });
    var draw = function (list) { return list.map(function (s) { return RENDER[s.type](s, t, o); }).join(''); };
    var h = '<article class="np' + (o.mode === 'print' ? ' print' : '') + '" data-tier="' + esc(t || '') + '">';
    /* 제호 — 신문 첫 줄. header/footer 요소는 쓰지 않는다(관리 웹의 header{background:…} 요소 선택자와 부딪힌다) */
    h += '<div class="np-mast"><div class="np-mast-top"><span>WB 독해력학원 · 웩슬러브레인센터</span><span>원내 구독 가족 전용</span></div>' +
      '<div class="np-title">브레인레터<small>BRAIN LETTER · 매주 한 호, 독해력과 두뇌 놀이</small></div>' +
      '<div class="np-dateline"><span>' + esc(issueNo(issue.week)) + '</span><span>' + esc(fmtDateKo(issue.publishAt) || issue.publishAt || '') + '</span><span>' + esc(editionLabel(t)) + '</span>' + (issue.status === 'draft' ? '<span class="np-draft">초안</span>' : '') + '</div></div>';
    /* 1면 머리기사 */
    h += '<div class="np-lead"><div class="np-kicker">이번 주 주제</div><h1 class="np-h1">' + esc(issue.title) + '</h1>';
    if (issue.theme) h += '<p class="np-deck">' + esc(issue.theme) + '</p>';
    h += photo(issue.cover, o, 'np-cover');
    if (issue.intro) h += '<p class="np-intro">' + esc(issue.intro).replace(/\n/g, '<br>') + '</p>';
    h += '</div>';
    h += '<div class="np-top"><div class="np-main">' + draw(main) + '</div><aside class="np-side">' + draw(side) + '</aside></div>';
    if (wide.length || narrow.length) h += '<div class="np-bottom"><div class="np-wide">' + draw(wide) + '</div><div class="np-narrow">' + draw(narrow) + '</div></div>';
    if (o.mode === 'print' && o.key !== false) h += renderKey(view, t);
    h += '<div class="np-foot"><span>발행 WB 독해력학원 · 웩슬러브레인센터</span><span>' + esc(issue.source || '') + '</span><span>원내 구독 가족에게만 보내는 글입니다. 링크를 밖으로 공유하지 마세요.</span></div></article>';
    return h;
  }

  /* 두 화면(학생 앱·관리 미리보기)이 같은 CSS 를 쓴다 — 여기 두면 인쇄 규칙도 한 벌이다.
     신문지 팔레트: 종이 #F3F1EB · 먹 #17211C · 별색(초록) #2B4C3F · 놀이터(겨자) #C9A227 */
  var CSS = [
    '.np{--np-paper:#F3F1EB;--np-ink:#17211C;--np-soft:#5E6B65;--np-line:#D6D9D2;--np-rule:#17211C;--np-spot:#2B4C3F;--np-spot-soft:#E4EDE7;--np-gold:#C9A227;--np-gold-soft:#F7EDCB;--np-red:#A8402F;--np-red-soft:#F4E4DF;--np-ok:#2E8B57;--np-ok-soft:#E4F2E9;',
    ' color:var(--np-ink);background:var(--np-paper);font-family:"Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif;line-height:1.7;word-break:keep-all;padding:0 0 20px}',
    '.np-serif,.np-title,.np-h1,.np-sec h2,.np-key h2{font-family:"Noto Serif KR","Nanum Myeongjo","Apple Myungjo","AppleMyungjo","Batang","BatangChe",Georgia,"Times New Roman",serif}',
    '.np-mast{border-top:4px solid var(--np-rule);padding:6px 0 8px;position:relative}.np-mast::after{content:"";display:block;border-top:1px solid var(--np-rule);border-bottom:3px solid var(--np-rule);height:2px;margin-top:8px}',
    '.np-mast-top{display:flex;justify-content:space-between;gap:10px;font-size:11px;letter-spacing:.06em;color:var(--np-soft);font-weight:700}',
    '.np-title{font-size:46px;font-weight:900;letter-spacing:-.03em;line-height:1.05;text-align:center;margin:8px 0 2px;color:var(--np-ink)}.np-title small{display:block;font-family:"Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif;font-size:11px;letter-spacing:.22em;font-weight:800;color:var(--np-spot);margin-top:4px}',
    '.np-dateline{display:flex;justify-content:center;gap:0;flex-wrap:wrap;font-size:12.5px;font-weight:700;color:var(--np-soft);margin-top:6px}.np-dateline span{padding:0 10px;border-left:1px solid var(--np-line)}.np-dateline span:first-child{border-left:0}.np-draft{color:var(--np-red)}',
    '.np-kicker{display:inline-block;font-size:11.5px;font-weight:900;letter-spacing:.08em;color:var(--np-spot);border:1.5px solid var(--np-spot);padding:0 8px;line-height:1.7;border-radius:2px;margin-bottom:6px;background:#fff}',
    '.np-lead{padding:18px 0 14px;border-bottom:1px solid var(--np-rule)}.np-h1{font-size:32px;line-height:1.22;letter-spacing:-.025em;margin:4px 0 6px;font-weight:900;text-wrap:balance}.np-deck{font-size:17.5px;font-weight:700;color:var(--np-spot);margin:0 0 10px}.np-intro{font-size:15px;color:var(--np-soft);margin:0;border-left:3px solid var(--np-spot);padding-left:12px}',
    '.np-top,.np-bottom{display:grid;grid-template-columns:1fr;gap:0}.np-main,.np-wide{min-width:0}.np-side,.np-narrow{min-width:0}',
    '@media(min-width:640px){.np-top{grid-template-columns:7fr 5fr;gap:0 24px}.np-main{border-right:1px solid var(--np-line);padding-right:24px}.np-bottom{grid-template-columns:2fr 1fr;gap:0 24px;border-top:3px double var(--np-rule);margin-top:6px}.np-wide{border-right:1px solid var(--np-line);padding-right:24px}.np-cols{column-count:2;column-gap:22px}.np-cols .np-p{break-inside:avoid}}',
    '.np-sec{padding:16px 0 14px;border-bottom:1px solid var(--np-line)}.np-sec h2{font-size:23px;line-height:1.3;letter-spacing:-.02em;margin:4px 0 10px;font-weight:900}.np-side .np-sec h2,.np-narrow .np-sec h2{font-size:19px}',
    '.np-side .np-sec{background:#fff;border:1px solid var(--np-rule);padding:14px 14px 12px;margin:14px 0 0}.np-side .np-sec:first-child{margin-top:16px}.np-side .np-kicker{margin:-22px 0 8px 0;background:var(--np-ink);color:#fff;border-color:var(--np-ink)}',
    '.np-brain{border-top:6px solid var(--np-gold)!important}.np-brain .np-kicker{background:var(--np-gold);border-color:var(--np-gold);color:var(--np-ink)}',
    '.np-p{font-size:16.5px;margin:0 0 10px;text-align:justify;word-break:normal}.np-p.first::first-letter{font-size:1.15em;font-weight:900}.np[data-tier="K"] .np-read .np-p,.np[data-tier="E1"] .np-read .np-p{font-size:19px;line-height:1.9;text-align:left;word-break:keep-all}.np-lede{margin:0 0 10px;font-weight:700;color:var(--np-spot)}',
    '@media screen{.np:not(.print) .np-wide .np-cols{column-count:1}.np:not(.print) .np-p{text-align:left;word-break:keep-all;overflow-wrap:break-word}}',
    '.np-photo{margin:0 0 12px}.np-photo img{width:100%;height:auto;display:block;border:1px solid var(--np-line);background:#fff}.np-photo figcaption{font-size:12.5px;color:var(--np-soft);padding:5px 0 6px;border-bottom:1px solid var(--np-line);display:flex;justify-content:space-between;gap:8px}.np-credit{font-size:11px;letter-spacing:.04em;white-space:nowrap}.np-cover{margin-top:10px}',
    '.np-zoom{display:block;width:100%;border:0;padding:0;background:none;cursor:zoom-in}.np-cover figcaption{pointer-events:none}',
    '.np-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:0 0 12px}.np-gallery .np-photo{margin:0}',
    '.np-boxhead{display:inline-block;font-size:11.5px;font-weight:900;letter-spacing:.06em;background:var(--np-ink);color:#fff;padding:1px 8px;margin-bottom:6px}',
    '.np-vocab{margin:8px 0 12px;padding:10px 12px 8px;border:1px dashed var(--np-rule);background:#fff}.np-vocab ul,.np-wl{margin:0;padding-left:18px}.np-vocab li,.np-wl li{margin:4px 0}.np-hanja{color:var(--np-soft);font-size:.9em}.np-ex{color:var(--np-soft);font-size:.92em}',
    '.np-qs{margin-top:10px;padding:10px 12px 6px;border:1px solid var(--np-rule);background:#fff}.np-q{margin:8px 0 0;padding:8px 0 10px;border-top:1px dotted var(--np-line)}.np-q:first-of-type{border-top:0}.np-qq{margin:0 0 6px;font-weight:800;display:flex;gap:8px}.np-qn{flex:none;width:22px;height:22px;border-radius:50%;background:var(--np-ink);color:#fff;font-size:12.5px;display:inline-flex;align-items:center;justify-content:center;font-weight:900;margin-top:3px}',
    '.np-choices{display:grid;gap:6px}.np-choice{display:block;width:100%;text-align:left;min-height:42px;padding:7px 12px;border:1.5px solid var(--np-line);border-radius:3px;background:#fff;font:inherit;font-size:15.5px;color:inherit;cursor:pointer;line-height:1.5}',
    '.np-choice.ok{border-color:var(--np-ok);background:var(--np-ok-soft);font-weight:800}.np-choice.no{border-color:var(--np-red);background:var(--np-red-soft)}.np-choice.dim{opacity:.55}.np-choice.static{border:0;min-height:0;padding:1px 0;cursor:default}',
    '.np-why{margin-top:8px;padding:8px 12px;background:var(--np-spot-soft);border-left:3px solid var(--np-spot);font-size:14.5px}.np-why.no{background:var(--np-gold-soft);border-left-color:var(--np-gold)}.np-blank{color:var(--np-soft);font-size:13px;margin-top:4px}',
    '.np-family{display:flex;align-items:center;gap:12px;margin:0 0 10px}.np-fh{font-family:"Noto Serif KR","Nanum Myeongjo","Batang",serif;font-size:52px;font-weight:900;color:var(--np-ink);line-height:1;width:64px;height:64px;display:inline-flex;align-items:center;justify-content:center;border:2px solid var(--np-ink);background:#fff}.np-fm{font-size:15px;color:var(--np-soft)}.np-fm b{color:var(--np-ink);font-size:18px}',
    '.np-task{margin-top:10px;padding:8px 10px;border-top:1px solid var(--np-line);font-weight:700;font-size:14.5px}.np-lines{height:56px;background:repeating-linear-gradient(#0000 0 26px,#9aa 26px 27px)}',
    '.np-idx{font-size:13px;color:var(--np-soft);margin:-4px 0 8px}.np-idx b{color:var(--np-ink)}.np-howto{margin:0 0 10px;padding:8px 10px;background:var(--np-gold-soft);font-size:14.5px}',
    '.np-bi{margin:8px 0 0;padding:8px 0 4px;border-top:1px dotted var(--np-line)}.np-bp{margin:0 0 6px;font-weight:800;display:flex;gap:8px}.np-grid{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px;line-height:1.5;letter-spacing:.2em;margin:6px 0;white-space:pre;overflow:auto;background:var(--np-paper);border:1px solid var(--np-line);padding:8px 10px}',
    '.np-fig{margin:6px 0 8px}.np-fig svg{display:block;max-width:100%;height:auto}.np-fig-target{display:inline-block;border:2px solid var(--np-ink);padding:4px;background:#fff;margin:0 0 8px}.np-fig-opts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;max-width:440px}.np-fig-opt{display:flex;flex-direction:column;align-items:center;gap:2px;font-weight:900;font-size:15px;min-width:0}.np-fig-opt svg{width:auto;max-width:100%}.np-fig-missing{color:var(--np-soft);font-size:13px}',
    '.np-reveal{font:inherit;font-size:13.5px;font-weight:800;min-height:36px;padding:4px 14px;border:1.5px solid var(--np-ink);background:#fff;color:var(--np-ink);cursor:pointer;margin-top:4px}.np-ans{margin-top:8px;padding:8px 12px;background:var(--np-gold-soft);border-left:3px solid var(--np-gold)}',
    '.np-tip{margin-top:12px;padding:8px 10px;border-top:1px solid var(--np-line);font-size:14px;color:var(--np-soft)}.np-tip b{color:var(--np-ink);margin-right:6px}',
    '.np-byline{font-size:12.5px;color:var(--np-soft);margin:-6px 0 10px;letter-spacing:.04em}.np-take{margin-top:10px;padding:10px 12px;background:var(--np-spot-soft);border-left:3px solid var(--np-spot);font-weight:800}',
    '.np-tips,.np-notes{margin:0;padding-left:20px}.np-tips li,.np-notes li{margin:6px 0}.np-notes{list-style:square}',
    '.np-cl{list-style:none;margin:0;padding:0}.np-cl li{margin:6px 0}.np-cl label{display:flex;gap:10px;align-items:flex-start;min-height:40px;cursor:pointer}.np-cl input{width:22px;height:22px;min-height:0;padding:0;border:0;margin:4px 0 0;flex:none;accent-color:var(--np-spot)}.np-cl .done{text-decoration:line-through;color:var(--np-soft)}.np-box{display:inline-block;width:16px;height:16px;border:1.5px solid #555;vertical-align:-2px}',
    '.np-key{border:1px dashed var(--np-rule);padding:14px;margin-top:16px}.np-krow{margin:8px 0}.np-krow ol{margin:4px 0 0;padding-left:20px}',
    '.np-foot{border-top:3px solid var(--np-rule);margin-top:16px;padding-top:8px;font-size:11.5px;color:var(--np-soft);display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px 14px}',
    /* 사진(앱) — 종이에 인쇄된 듯 바탕과 섞이고(multiply), 표지는 16:10 으로 맞춰 사진 모양이 달라도 지면이 흔들리지 않는다. 폰에서는 표지가 가장자리까지 */
    '.np:not(.print) .np-photo img{border-radius:8px;mix-blend-mode:multiply;object-fit:cover}.np:not(.print) .np-photo[data-zoom]{cursor:zoom-in}.np:not(.print) .np-cover{position:relative}.np:not(.print) .np-cover img{aspect-ratio:16/10;border-radius:10px}',
    '.np:not(.print) .np-cover figcaption{position:absolute;left:0;right:0;bottom:0;padding:28px 14px 10px;background:linear-gradient(#0000,#000c);color:#fff;border:0;border-radius:0 0 10px 10px}.np:not(.print) .np-cover .np-credit{color:#fffc}',
    '@media(max-width:639px){.np:not(.print) .np-cover{margin-left:-16px;margin-right:-16px}.np:not(.print) .np-cover img{border-radius:0;border-left:0;border-right:0}.np:not(.print) .np-cover figcaption{border-radius:0}.np:not(.print) .np-gallery{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:10px;margin:0 -16px 12px;padding:0 16px;scrollbar-width:none}.np:not(.print) .np-gallery .np-photo{flex:0 0 82%;scroll-snap-align:start}}',
    '@media(min-width:640px){.np-gallery{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}}',
    /* 하루 한 장 */
    '.np-daily{padding-bottom:10px}.np-dhead{padding:12px 0 10px;border-bottom:3px double var(--np-rule);margin-bottom:4px}.np-dmeta{display:flex;flex-wrap:wrap;font-size:12.5px;font-weight:700;color:var(--np-soft)}.np-dmeta span{padding-right:10px;margin-right:10px;border-right:1px solid var(--np-line)}.np-dmeta span:last-child{border-right:0}.np-dtitle{font-size:30px;line-height:1.2;margin:6px 0 2px;font-weight:900;letter-spacing:-.02em}.np-dsub{margin:0;color:var(--np-spot);font-weight:700}',
    '.np-daily .np-sec{border-bottom:0}.np-daily .np-lead{border-bottom:1px solid var(--np-line)}.np-daily .np-brain{border-top:6px solid var(--np-gold);padding-top:12px}.np-daily .np-h1{font-size:28px}',
    '.np-strip{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;margin:10px 0 4px}.np-sday{display:flex;flex-direction:column;align-items:center;gap:1px;min-height:54px;padding:6px 2px;border:1.5px solid var(--np-line);border-radius:6px;background:#fff;font:inherit;color:var(--np-ink);cursor:pointer;position:relative}.np-sdow{font-weight:900;font-size:15px}.np-sname{font-size:10.5px;color:var(--np-soft);white-space:nowrap;overflow:hidden;max-width:100%;text-overflow:ellipsis}',
    '.np-sday.cur{border-color:var(--np-ink);background:var(--np-ink);color:#fff}.np-sday.cur .np-sname{color:#fffc}.np-sday.done{border-color:var(--np-spot)}.np-sok{position:absolute;top:-7px;right:-4px;width:18px;height:18px;border-radius:50%;background:var(--np-spot);color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;font-weight:900}.np-sday.future{opacity:.55}.np-sday.cur{opacity:1}',
    '.np-fold{margin:0 0 10px;border:1px dashed var(--np-rule);padding:6px 12px;background:#fff}.np-fold summary{cursor:pointer;font-weight:800;padding:6px 0}.np-fold[open] summary{border-bottom:1px solid var(--np-line);margin-bottom:8px}',
    /* 읽어 주기·따라쓰기·이슈·되돌아보기 */
    '.np-tts{display:flex;align-items:center;gap:10px;margin:0 0 10px}.np-ttsbtn{font:inherit;font-size:14px;font-weight:800;min-height:40px;padding:4px 14px;border:1.5px solid var(--np-ink);border-radius:20px;background:#fff;color:var(--np-ink);cursor:pointer}.np-ttsbtn.on{background:var(--np-ink);color:#fff}.np-tts-msg{font-size:13px;color:var(--np-soft)}.np-p.speaking{background:var(--np-gold-soft);box-shadow:0 0 0 4px var(--np-gold-soft)}',
    '.np-trace{margin:0 0 12px;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start}.np-trace canvas{width:240px;height:240px;max-width:100%;border:2px solid var(--np-ink);background:#fff;touch-action:none;border-radius:4px}.np-trace-ui{display:flex;flex-direction:column;gap:8px;min-width:150px;flex:1}.np-trace-msg{font-size:14px;font-weight:700}.np-trace-btns{display:flex;gap:8px;flex-wrap:wrap}.np-tbtn{font:inherit;font-size:14px;font-weight:800;min-height:40px;padding:4px 14px;border:1.5px solid var(--np-ink);background:#fff;color:var(--np-ink);cursor:pointer;border-radius:4px}.np-tbtn.primary{background:var(--np-ink);color:#fff}.np-trace.done canvas{border-color:var(--np-spot)}',
    '.np-newsl{margin:0;padding-left:20px}.np-newsl li{margin:0 0 12px}.np-newsl li>b{display:block;font-size:15.5px;line-height:1.4}.np-newsl p{margin:3px 0;font-size:14.5px}.np-newswhy{color:var(--np-spot);font-weight:700}.np-src{font-size:12px;color:var(--np-soft);letter-spacing:.02em}.np-src a{color:var(--np-spot)}',
    '.np-poem{margin:0 0 8px;padding:12px 16px;background:#fff;border-left:3px solid var(--np-gold);font-family:"Noto Serif KR","Nanum Myeongjo","Batang",serif;font-size:17px;line-height:1.9}.np-line{margin:0}.np-stanza{height:12px}.np-line.speaking{background:var(--np-gold-soft)}.np-lines-tall{height:120px}',
    '.np-talk{list-style:none;margin:0 0 6px;padding:0}.np-talk li{margin:8px 0}.np-bubble{display:inline-block;padding:8px 14px;background:var(--np-spot-soft);border-radius:16px 16px 16px 3px;font-weight:700}',
    '.np-wq{margin:10px 0 0;padding:8px 0 4px;border-top:1px dotted var(--np-line)}.np-ta{width:100%;min-height:78px;padding:8px 10px;border:1.5px solid var(--np-rule);border-radius:4px;font:inherit;font-size:15.5px;line-height:1.6;background:#fff;color:inherit;resize:vertical}.np-ta-note{font-size:12px;color:var(--np-soft);margin-top:4px}',
    '.np-books{margin:0;padding-left:20px}.np-books li{margin:0 0 10px}.np-books p{margin:2px 0 0;font-size:14.5px}.np-for{font-size:11.5px;font-weight:800;color:var(--np-spot);border:1px solid var(--np-spot);border-radius:2px;padding:0 5px;margin-left:4px}',
    '.np-voices{list-style:none;margin:0;padding:0}.np-voices li{margin:0 0 10px;padding:8px 12px;background:#fff;border:1px solid var(--np-line)}.np-quote{display:block;font-size:15px}.np-quote::before{content:"“"}.np-quote::after{content:"”"}.np-who{display:block;font-size:12.5px;color:var(--np-soft);text-align:right}',
    '.np-dr{margin:6px 0 8px}.np-dr-seq{font-size:26px;font-weight:900;letter-spacing:.06em;padding:10px 12px;background:#fff;border:1.5px solid var(--np-rule);display:inline-block}.np-dr-words{font-size:20px;font-weight:800;padding:8px 0}.np-dr-target{font-size:14px;margin-bottom:6px}.np-dr-target b{font-size:22px}.np-dr-grid{display:inline-block;background:#fff;border:1.5px solid var(--np-rule);padding:6px 8px;line-height:1.35}.np-dr-row{display:flex;gap:6px}.np-dr-row span{display:inline-block;width:26px;text-align:center;font-size:19px}.np-daily5{border-top:6px solid var(--np-gold)}.np-mywrite{margin:0 0 12px;padding:10px 12px;background:#fff;border:1px dashed var(--np-rule)}.np-mine{margin:0 0 8px;font-weight:700}',
    '.np-review .ok{color:var(--np-ok)}.np-review .no{color:var(--np-red)}.np-review .skip{color:var(--np-soft)}.np-score{display:flex;gap:12px;margin:0 0 12px}.np-score div{flex:1;background:#fff;border:1px solid var(--np-rule);padding:10px 12px;text-align:center;font-size:14px}.np-score b{display:block;font-size:30px;font-weight:900;line-height:1.1}.np-score span{display:block;color:var(--np-soft);font-size:12.5px}.np-next{margin-top:12px;padding:10px 12px;background:var(--np-spot-soft);border-left:3px solid var(--np-spot)}.np-next b{margin-right:8px}',
    /* 인쇄(PDF) — A4, 2단은 그대로(A4 본문 폭 ≈ 688px 로 640 기준을 넘는다), 섹션은 쪽 중간에서 잘리지 않게, 정답 별지는 새 쪽에서 */
    '@media print{@page{size:A4;margin:12mm 13mm 14mm}.np{background:#fff;padding:0;--np-line:#bbb}.np-sec{break-inside:avoid;page-break-inside:avoid}.np-side .np-sec{box-shadow:none}.np-title{font-size:40px}.np-h1{font-size:26pt}.np-p{font-size:11.5pt}.np[data-tier="K"] .np-read .np-p,.np[data-tier="E1"] .np-read .np-p{font-size:13.5pt}.np-choice.static{border:0;padding:0;min-height:0;font-size:11pt}.np-key{break-before:page;page-break-before:always}.np-reveal,.np-ans{display:none}.np-grid{font-size:15pt}.np-photo img{max-height:90mm;object-fit:cover}.np-side .np-fig-opts{grid-template-columns:repeat(2,minmax(0,1fr));max-width:230px}}',
  ].join('\n');

  return {
    TIERS: TIERS, TIER_IDS: TIER_IDS, WISC: WISC, WISC_ORDER: WISC_ORDER, SECTION_TYPES: SECTION_TYPES, KICKER: KICKER, READ_CHARS: READ_CHARS, ISSUE_MAX_BYTES: ISSUE_MAX_BYTES, BASE_WEEK: BASE_WEEK, CSS: CSS, DAY_PLAN: DAY_PLAN,
    esc: esc, kstDate: kstDate, isValidDate: isValidDate, weekId: weekId, weekStart: weekStart, weekLabel: weekLabel, issueNo: issueNo, fmtDateKo: fmtDateKo, weekIndex: weekIndex, nextWeek: nextWeek,
    rotationFor: rotationFor, calendarEntry: calendarEntry, checkCalendar: checkCalendar,
    tierFromGrade: tierFromGrade, tierOf: tierOf, tierLabel: tierLabel, editionLabel: editionLabel,
    checkIssue: checkIssue, checkImage: checkImage, forTier: forTier, isVisible: isVisible, tiersOf: tiersOf, brief: brief, pickPilot: pickPilot, blankIssue: blankIssue,
    renderIssue: renderIssue, renderKey: renderKey, imgSrc: imgSrc, choiceOrder: choiceOrder, checklistItems: checklistItems,
    dayOf: dayOf, dayDate: dayDate, dayDow: dayDow, dayPage: dayPage, renderDay: renderDay, renderDayStrip: renderDayStrip, renderReview: renderReview,
    clozeFor: clozeFor, renderCloze: renderCloze, renderDaily: renderDaily, brainAnswer: brainAnswer,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBLETTER;
