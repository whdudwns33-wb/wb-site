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

  var SECTION_TYPES = ['read', 'words', 'brain', 'column', 'coach', 'notice', 'checklist'];
  var KICKER = { read: '이번 주 읽을거리', words: '한자 코너', brain: '두뇌 놀이터', column: '학부모 칼럼', coach: '한 줄 코칭', notice: '학원 게시판', checklist: '이번 주 미션' };
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
    var SH = shapesLib();
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
          if (it.figure != null) {
            /* 도형 놀이 — 그림은 생성기가 seed 로 만들고, 정답도 생성기가 정한다. JSON 의 answer 는 그 답과 같아야 한다
               (원장이 답을 손으로 고쳐 어긋난 채 발행되면 아이가 맞히고도 틀렸다는 소리를 듣는다) */
            if (!SH) { W(itag, '도형 생성기(shapes.js)가 없어 figure 를 검사하지 못했습니다'); }
            else if (!SH.isValidFigure(it.figure)) E(itag, 'figure 는 {kind: odd|rotate|mirror|blocks|complete, seed: 1~999999}');
            else {
              var g = SH.make(it.figure);
              if (g && str(it.answer).trim() && it.answer.trim() !== g.answerText) E(itag, '도형 정답이 생성기와 다릅니다 — 생성기 답: ' + g.answerText + ' (answer 를 비우면 자동)');
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
    return '<figure class="np-photo' + (cls ? ' ' + cls : '') + '"><img src="' + esc(src) + '" alt="' + esc(img.alt) + '" loading="lazy">' +
      '<figcaption>' + esc(img.caption || '') + (img.credit ? '<span class="np-credit">' + esc(img.credit) + '</span>' : '') + '</figcaption></figure>';
  }
  function gallery(list, o) {
    if (!Array.isArray(list) || !list.length) return '';
    return '<div class="np-gallery">' + list.map(function (im) { return photo(im, o); }).join('') + '</div>';
  }
  function paras(list, cls) {
    return (list || []).map(function (p, i) { return '<p class="' + cls + (i === 0 ? ' first' : '') + '">' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }
  function secOpen(s, extraCls, kickerExtra) {
    return '<section class="np-sec np-' + esc(s.type) + (extraCls ? ' ' + extraCls : '') + '" id="sec-' + esc(s.id) + '"><div class="np-kicker">' + KICKER[s.type] + (kickerExtra || '') + '</div>';
  }
  function renderRead(s, tier, o) {
    var st = o.state || {};
    var h = secOpen(s, '', (s.readAloud ? ' · 부모가 읽어 주세요' : '') + (s.minutes ? ' · ' + s.minutes + '분' : ''));
    h += '<h2>' + esc(s.title) + '</h2>';
    if (s.lead) h += '<p class="np-lede">' + esc(s.lead) + '</p>';
    h += photo(s.image, o);
    h += '<div class="np-body">' + paras(s.paragraphs, 'np-p') + '</div>';
    h += gallery(s.images, o);
    if (Array.isArray(s.vocab) && s.vocab.length) {
      h += '<div class="np-vocab"><div class="np-boxhead">낱말 노트</div><ul>' + s.vocab.map(function (v) {
        return '<li><b>' + esc(v.word) + '</b>' + (v.hanja ? ' <span class="np-hanja">' + esc(v.hanja) + '</span>' : '') + ' — ' + esc(v.easy) + '</li>';
      }).join('') + '</ul></div>';
    }
    if (Array.isArray(s.questions) && s.questions.length) {
      h += '<div class="np-qs"><div class="np-boxhead">읽고 답해요</div>';
      s.questions.forEach(function (q, qi) {
        var picked = st.quiz && st.quiz[s.id + ':' + qi];
        var done = typeof picked === 'number';
        h += '<div class="np-q"><p class="np-qq"><span class="np-qn">' + (qi + 1) + '</span>' + esc(q.q) + '</p><div class="np-choices">';
        (q.choices || []).forEach(function (c, ci) {
          var cls = 'np-choice' + (done ? (ci === q.answer ? ' ok' : (ci === picked ? ' no' : ' dim')) : '');
          if (o.mode === 'print') h += '<div class="np-choice static">' + CIRCLED[ci] + ' ' + esc(c) + '</div>';
          else h += '<button type="button" class="' + cls + '" data-q="' + esc(s.id) + ':' + qi + ':' + ci + '"' + (done ? ' disabled' : '') + '>' + CIRCLED[ci] + ' ' + esc(c) + '</button>';
        });
        h += '</div>';
        if (o.mode === 'print') h += '<div class="np-blank">답 ______</div>';
        else if (done) h += '<div class="np-why ' + (picked === q.answer ? 'ok' : 'no') + '">' + (picked === q.answer ? '맞았어요! ' : '정답은 ' + CIRCLED[q.answer] + '이에요. ') + esc(q.why || '') + '</div>';
        h += '</div>';
      });
      h += '</div>';
    }
    return h + '</section>';
  }
  function renderWords(s, tier, o) {
    var h = secOpen(s) + '<h2>' + esc(s.title) + '</h2>';
    if (s.family) h += '<div class="np-family"><span class="np-fh">' + esc(s.family.hanja) + '</span><span class="np-fm">' + esc(s.family.hun) + ' <b>' + esc(s.family.eum) + '</b></span></div>';
    h += photo(s.image, o);
    h += '<ul class="np-wl">' + (s.words || []).map(function (w) {
      return '<li><b>' + esc(w.word) + '</b>' + (w.hanja ? ' <span class="np-hanja">' + esc(w.hanja) + '</span>' : '') + ' — ' + esc(w.meaning) + (w.example ? '<br><span class="np-ex">' + esc(w.example) + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
    if (s.task) h += '<div class="np-task">✎ ' + esc(s.task) + (o.mode === 'print' ? '<div class="np-lines"></div>' : '') + '</div>';
    return h + '</section>';
  }
  function renderBrain(s, tier, o) {
    var st = o.state || {};
    var w = WISC[s.index] || { label: '', reading: '' };
    var SH = shapesLib();
    var h = secOpen(s, '', (s.minutes ? ' · ' + s.minutes + '분' : ''));
    h += '<h2>' + esc(s.title) + '</h2><div class="np-idx"><b>' + esc(w.label) + '</b> ' + esc(s.index) + ' — ' + esc(w.reading) + '</div>';
    h += photo(s.image, o);
    if (s.howTo) h += '<p class="np-howto">' + esc(s.howTo).replace(/\n/g, '<br>') + '</p>';
    (s.items || []).forEach(function (it, i) {
      var key = s.id + ':' + i;
      var open = st.reveal && st.reveal[key];
      var gen = it.figure && SH ? SH.make(Object.assign({}, it.figure, { tier: tier || it.figure.tier || '' })) : null;
      var prompt = str(it.prompt).trim() || (gen ? gen.prompt : '');
      var answer = gen ? gen.answerText : str(it.answer);
      var hint = str(it.hint) || (gen ? gen.hint : '');
      h += '<div class="np-bi"><p class="np-bp"><span class="np-qn">' + (i + 1) + '</span>' + esc(prompt).replace(/\n/g, '<br>') + '</p>';
      if (it.figure) h += (SH ? SH.html(Object.assign({}, it.figure, { tier: tier || it.figure.tier || '' })) : '<div class="np-fig np-fig-missing">도형은 앱 화면에서 볼 수 있어요.</div>');
      if (Array.isArray(it.grid) && it.grid.length) h += '<pre class="np-grid">' + it.grid.map(esc).join('\n') + '</pre>';
      if (o.mode === 'print') h += '<div class="np-blank">답 ______</div>';
      else {
        h += '<button type="button" class="np-reveal" data-ans="' + esc(key) + '">' + (open ? '정답 숨기기' : '정답 보기') + '</button>';
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
  function renderChecklist(s, tier, o) {
    var st = o.state || {};
    return secOpen(s) + '<h2>' + esc(s.title) + '</h2><ul class="np-cl">' + (s.items || []).map(function (t, i) {
      var key = s.id + ':' + i, on = !!(st.checks && st.checks[key]);
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
        rows += '<div class="np-krow"><b>' + esc(s.title) + '</b><ol>' + s.questions.map(function (q) { return '<li>' + CIRCLED[q.answer] + (q.why ? ' — ' + esc(q.why) : '') + '</li>'; }).join('') + '</ol></div>';
      }
      if (s.type === 'brain' && Array.isArray(s.items)) {
        rows += '<div class="np-krow"><b>' + esc(s.title) + '</b><ol>' + s.items.map(function (it) {
          var gen = it.figure && SH ? SH.make(Object.assign({}, it.figure, { tier: tier || '' })) : null;
          var ans = gen ? gen.answerText : str(it.answer), hint = str(it.hint) || (gen ? gen.hint : '');
          return '<li>' + esc(ans) + (hint ? ' <span class="np-ex">(' + esc(hint) + ')</span>' : '') + '</li>';
        }).join('') + '</ol></div>';
      }
    });
    if (!rows) return '';
    return '<section class="np-sec np-key"><div class="np-kicker">정답과 해설</div><h2>' + esc(issue.title) + ' — 답지</h2>' + rows + '</section>';
  }
  var RENDER = { read: renderRead, words: renderWords, brain: renderBrain, column: renderColumn, coach: renderCoach, notice: renderNotice, checklist: renderChecklist };

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
      else if (s.type === 'coach' || s.type === 'notice') narrow.push(s);
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
    '.np-photo{margin:0 0 12px}.np-photo img{width:100%;height:auto;display:block;border:1px solid var(--np-line);background:#fff}.np-photo figcaption{font-size:12.5px;color:var(--np-soft);padding:5px 0 6px;border-bottom:1px solid var(--np-line);display:flex;justify-content:space-between;gap:8px}.np-credit{font-size:11px;letter-spacing:.04em;white-space:nowrap}.np-cover{margin-top:10px}',
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
    /* 인쇄(PDF) — A4, 2단은 그대로(A4 본문 폭 ≈ 688px 로 640 기준을 넘는다), 섹션은 쪽 중간에서 잘리지 않게, 정답 별지는 새 쪽에서 */
    '@media print{@page{size:A4;margin:12mm 13mm 14mm}.np{background:#fff;padding:0;--np-line:#bbb}.np-sec{break-inside:avoid;page-break-inside:avoid}.np-side .np-sec{box-shadow:none}.np-title{font-size:40px}.np-h1{font-size:26pt}.np-p{font-size:11.5pt}.np[data-tier="K"] .np-read .np-p,.np[data-tier="E1"] .np-read .np-p{font-size:13.5pt}.np-choice.static{border:0;padding:0;min-height:0;font-size:11pt}.np-key{break-before:page;page-break-before:always}.np-reveal,.np-ans{display:none}.np-grid{font-size:15pt}.np-photo img{max-height:90mm;object-fit:cover}.np-side .np-fig-opts{grid-template-columns:repeat(2,minmax(0,1fr));max-width:230px}}',
  ].join('\n');

  return {
    TIERS: TIERS, TIER_IDS: TIER_IDS, WISC: WISC, WISC_ORDER: WISC_ORDER, SECTION_TYPES: SECTION_TYPES, KICKER: KICKER, READ_CHARS: READ_CHARS, ISSUE_MAX_BYTES: ISSUE_MAX_BYTES, BASE_WEEK: BASE_WEEK, CSS: CSS,
    esc: esc, kstDate: kstDate, isValidDate: isValidDate, weekId: weekId, weekStart: weekStart, weekLabel: weekLabel, issueNo: issueNo, fmtDateKo: fmtDateKo, weekIndex: weekIndex, nextWeek: nextWeek,
    rotationFor: rotationFor, calendarEntry: calendarEntry, checkCalendar: checkCalendar,
    tierFromGrade: tierFromGrade, tierOf: tierOf, tierLabel: tierLabel, editionLabel: editionLabel,
    checkIssue: checkIssue, checkImage: checkImage, forTier: forTier, isVisible: isVisible, tiersOf: tiersOf, brief: brief, blankIssue: blankIssue,
    renderIssue: renderIssue, renderKey: renderKey, imgSrc: imgSrc,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBLETTER;
