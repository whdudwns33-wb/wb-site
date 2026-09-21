'use strict';
/* WB 브레인레터 — 주간 뉴스레터 순수 로직 (브라우저/Node 공용, 의존성 없음)
   유치(5~7세)부터 중학생까지 다섯 학년대에 매주 한 호를 보낸다. 한 호(issue)는 여러 섹션(section)으로 되어 있고
   섹션마다 대상 학년대(tiers)가 붙어 있다. 학생 앱·가족 링크·관리 미리보기·인쇄(PDF)가 전부 이 모듈의
   renderIssue 하나로 그린다 — 화면마다 따로 그리면 학생이 보는 것과 원장이 검수한 것이 달라진다.

   왜 검증기가 여기 있는가: 관리 웹 업로드·AI 초안·서버 저장이 같은 규칙으로 걸러야 한다.
   문항 정답 번호가 보기 범위를 벗어난 호가 발행되면 학생 화면이 그 문항에서 죽는다. */
var WBLETTER = (function () {
  /* 학년대 — 진로독서의 L1~L4 와 다르다. 뉴스레터는 유치부가 있고 고등은 중등 것을 받는다. */
  var TIERS = [
    { id: 'K', label: '유치', range: '5~7세', note: '부모가 읽어 주는 글' },
    { id: 'E1', label: '초등 저학년', range: '초1~2', note: '' },
    { id: 'E2', label: '초등 중학년', range: '초3~4', note: '' },
    { id: 'E3', label: '초등 고학년', range: '초5~6', note: '' },
    { id: 'M', label: '중등', range: '중1~3', note: '' },
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

  var SECTION_TYPES = ['read', 'words', 'brain', 'column', 'coach', 'notice', 'checklist'];
  var KICKER = { read: '이번 주 읽을거리', words: '낱말 가족', brain: '웩슬러 두뇌 놀이', column: '입시 문해력 칼럼', coach: '부모 코칭 한 줄', notice: '학원 소식', checklist: '이번 주 미션' };
  var SKILLS = ['main', 'detail', 'infer', 'vocab', 'apply', 'critical'];
  /* 학년대별 읽을거리 글자 수(공백 포함, 진로독서 content.test 와 같은 셈법) — 넘어도 경고만. 권장치를 넘긴 글이
     틀린 글은 아니지만, 유치부 글이 400자면 부모가 읽어 주다 지친다 */
  var READ_CHARS = { K: [50, 300], E1: [160, 480], E2: [380, 820], E3: [560, 1150], M: [800, 1600] };
  var ID_RE = /^\d{4}-W\d{2}(-[a-z0-9]{1,12})?$/;
  var WEEK_RE = /^\d{4}-W\d{2}$/;
  var SEC_ID_RE = /^[a-z0-9-]{2,30}$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var CIRCLED = ['①', '②', '③', '④', '⑤'];
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

  /* ── 검증 ── */
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
    if (!Array.isArray(issue.sections) || !issue.sections.length) { E('sections', '섹션이 하나도 없습니다'); return { errors: errors, warnings: warnings }; }
    var ids = {};
    var covered = {}; TIER_IDS.forEach(function (t) { covered[t] = { read: 0, brain: 0 }; });
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
          if (!isObj(it) || !str(it.prompt).trim()) { E(tag, 'items[' + k + '] prompt 필요'); return; }
          if (!str(it.answer).trim()) E(tag, 'items[' + k + '] answer 필요(열린 놀이면 "예시: …")');
          if (it.grid != null && (!Array.isArray(it.grid) || it.grid.some(function (g) { return typeof g !== 'string'; }))) E(tag, 'items[' + k + '] grid 는 문자열 배열');
        });
        if (s.minutes != null && !(Number.isInteger(s.minutes) && s.minutes >= 1 && s.minutes <= 30)) E(tag, 'minutes 는 1~30 정수');
        validTiers.forEach(function (t) { covered[t].brain += 1; });
      } else if (s.type === 'column') {
        strList(s.paragraphs, 'paragraphs', 1, 20, 2000);
        if (s.takeaway != null && typeof s.takeaway !== 'string') E(tag, 'takeaway 는 문자열');
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
  /* 관리 웹 [빈 템플릿]·AI 초안의 뼈대 — 섹션 종류마다 한 개씩 */
  function blankIssue(week) {
    var w = WEEK_RE.test(str(week)) ? week : weekId();
    return {
      id: w, week: w, publishAt: weekStart(w), status: 'draft',
      title: '', theme: '', intro: '', source: 'WB 독해력학원 자체 창작',
      sections: [
        { id: 'read-k', type: 'read', tiers: ['K'], title: '', readAloud: true, minutes: 3, paragraphs: [''], vocab: [], questions: [{ q: '', choices: ['', ''], answer: 0, why: '', skill: 'main' }] },
        { id: 'read-e1', type: 'read', tiers: ['E1'], title: '', minutes: 5, paragraphs: [''], vocab: [{ word: '', easy: '' }], questions: [{ q: '', choices: ['', '', ''], answer: 0, why: '', skill: 'main' }] },
        { id: 'read-e2', type: 'read', tiers: ['E2'], title: '', minutes: 6, paragraphs: [''], vocab: [{ word: '', easy: '', hanja: '' }], questions: [{ q: '', choices: ['', '', '', ''], answer: 0, why: '', skill: 'main' }] },
        { id: 'read-e3', type: 'read', tiers: ['E3'], title: '', minutes: 8, paragraphs: [''], vocab: [{ word: '', easy: '', hanja: '' }], questions: [{ q: '', choices: ['', '', '', ''], answer: 0, why: '', skill: 'main' }] },
        { id: 'read-m', type: 'read', tiers: ['M'], title: '', minutes: 10, paragraphs: [''], vocab: [{ word: '', easy: '', hanja: '' }], questions: [{ q: '', choices: ['', '', '', '', ''], answer: 0, why: '', skill: 'main' }] },
        { id: 'words', type: 'words', tiers: ['E2', 'E3', 'M'], title: '', family: { hanja: '', hun: '', eum: '' }, words: [{ word: '', meaning: '', example: '' }], task: '' },
        { id: 'brain', type: 'brain', tiers: 'all', title: '', index: 'WMI', minutes: 5, howTo: '', items: [{ prompt: '', answer: '' }], parentTip: '' },
        { id: 'column', type: 'column', tiers: 'all', title: '', paragraphs: [''], takeaway: '' },
        { id: 'coach', type: 'coach', tiers: 'all', title: '', tips: [''] },
        { id: 'notice', type: 'notice', tiers: 'all', title: '학원 소식', items: [''] },
        { id: 'mission', type: 'checklist', tiers: 'all', title: '이번 주 미션', items: [''] },
      ],
    };
  }

  /* ── 렌더링 ──
     opts: { mode: 'app'|'print', state: {quiz:{'sid:qi':idx}, checks:{'sid:i':true}, reveal:{'sid:i':true}}, key: true|false(인쇄 정답 별지), origin }
     반환은 HTML 문자열. 모든 문자열은 esc 를 거친다 — 호 JSON 은 관리자가 쓰지만 AI 초안이 섞이므로 믿지 않는다. */
  function paras(list, cls) {
    return (list || []).map(function (p) { return '<p class="' + cls + '">' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }
  function renderRead(s, tier, o) {
    var st = o.state || {};
    var h = '<section class="nl-sec nl-read" id="sec-' + esc(s.id) + '"><div class="nl-kicker">' + KICKER.read + (s.readAloud ? ' · 부모가 읽어 주세요' : '') + (s.minutes ? ' · ' + s.minutes + '분' : '') + '</div>';
    h += '<h2>' + esc(s.title) + '</h2>';
    if (s.lead) h += '<p class="nl-lead">' + esc(s.lead) + '</p>';
    h += '<div class="nl-body">' + paras(s.paragraphs, 'nl-p') + '</div>';
    if (Array.isArray(s.vocab) && s.vocab.length) {
      h += '<div class="nl-vocab"><b>낱말</b><ul>' + s.vocab.map(function (v) {
        return '<li><b>' + esc(v.word) + '</b>' + (v.hanja ? ' <span class="nl-hanja">' + esc(v.hanja) + '</span>' : '') + ' — ' + esc(v.easy) + '</li>';
      }).join('') + '</ul></div>';
    }
    if (Array.isArray(s.questions) && s.questions.length) {
      h += '<div class="nl-qs"><b>읽고 답해요</b>';
      s.questions.forEach(function (q, qi) {
        var picked = st.quiz && st.quiz[s.id + ':' + qi];
        var done = typeof picked === 'number';
        h += '<div class="nl-q"><p class="nl-qq">' + (qi + 1) + '. ' + esc(q.q) + '</p><div class="nl-choices">';
        (q.choices || []).forEach(function (c, ci) {
          var cls = 'nl-choice' + (done ? (ci === q.answer ? ' ok' : (ci === picked ? ' no' : ' dim')) : '');
          if (o.mode === 'print') h += '<div class="nl-choice static">' + CIRCLED[ci] + ' ' + esc(c) + '</div>';
          else h += '<button type="button" class="' + cls + '" data-q="' + esc(s.id) + ':' + qi + ':' + ci + '"' + (done ? ' disabled' : '') + '>' + CIRCLED[ci] + ' ' + esc(c) + '</button>';
        });
        h += '</div>';
        if (o.mode === 'print') h += '<div class="nl-blank">답: ______</div>';
        else if (done) h += '<div class="nl-why ' + (picked === q.answer ? 'ok' : 'no') + '">' + (picked === q.answer ? '맞았어요! ' : '정답은 ' + CIRCLED[q.answer] + '이에요. ') + esc(q.why || '') + '</div>';
        h += '</div>';
      });
      h += '</div>';
    }
    return h + '</section>';
  }
  function renderWords(s, tier, o) {
    var h = '<section class="nl-sec nl-words" id="sec-' + esc(s.id) + '"><div class="nl-kicker">' + KICKER.words + '</div><h2>' + esc(s.title) + '</h2>';
    if (s.family) h += '<div class="nl-family"><span class="nl-fh">' + esc(s.family.hanja) + '</span><span>' + esc(s.family.hun) + ' ' + esc(s.family.eum) + '</span></div>';
    h += '<ul class="nl-wl">' + (s.words || []).map(function (w) {
      return '<li><b>' + esc(w.word) + '</b>' + (w.hanja ? ' <span class="nl-hanja">' + esc(w.hanja) + '</span>' : '') + ' — ' + esc(w.meaning) + (w.example ? '<br><span class="nl-ex">' + esc(w.example) + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
    if (s.task) h += '<div class="nl-task">✎ ' + esc(s.task) + (o.mode === 'print' ? '<div class="nl-lines"></div>' : '') + '</div>';
    return h + '</section>';
  }
  function renderBrain(s, tier, o) {
    var st = o.state || {};
    var w = WISC[s.index] || { label: '', reading: '' };
    var h = '<section class="nl-sec nl-brain" id="sec-' + esc(s.id) + '"><div class="nl-kicker">' + KICKER.brain + (s.minutes ? ' · ' + s.minutes + '분' : '') + '</div>';
    h += '<h2>' + esc(s.title) + ' <span class="nl-idx">' + esc(w.label) + ' ' + esc(s.index) + '</span></h2>';
    if (w.reading) h += '<p class="nl-idxnote">이 놀이가 쓰는 힘: ' + esc(w.reading) + '</p>';
    if (s.howTo) h += '<p class="nl-howto">' + esc(s.howTo).replace(/\n/g, '<br>') + '</p>';
    (s.items || []).forEach(function (it, i) {
      var key = s.id + ':' + i;
      var open = st.reveal && st.reveal[key];
      h += '<div class="nl-bi"><p class="nl-bp">' + (i + 1) + '. ' + esc(it.prompt).replace(/\n/g, '<br>') + '</p>';
      if (Array.isArray(it.grid) && it.grid.length) h += '<pre class="nl-grid">' + it.grid.map(esc).join('\n') + '</pre>';
      if (o.mode === 'print') h += '<div class="nl-blank">답: ______</div>';
      else {
        h += '<button type="button" class="nl-reveal" data-ans="' + esc(key) + '">' + (open ? '정답 숨기기' : '정답 보기') + '</button>';
        if (open) h += '<div class="nl-ans">' + esc(it.answer) + (it.hint ? '<br><span class="nl-ex">' + esc(it.hint) + '</span>' : '') + '</div>';
      }
      h += '</div>';
    });
    if (s.parentTip) h += '<div class="nl-tip">👨‍👩‍👧 ' + esc(s.parentTip) + '</div>';
    return h + '</section>';
  }
  function renderColumn(s) {
    var h = '<section class="nl-sec nl-column" id="sec-' + esc(s.id) + '"><div class="nl-kicker">' + KICKER.column + '</div><h2>' + esc(s.title) + '</h2>' + paras(s.paragraphs, 'nl-p');
    if (s.takeaway) h += '<div class="nl-take">한 줄 요약 — ' + esc(s.takeaway) + '</div>';
    return h + '</section>';
  }
  function renderCoach(s) {
    return '<section class="nl-sec nl-coach" id="sec-' + esc(s.id) + '"><div class="nl-kicker">' + KICKER.coach + '</div><h2>' + esc(s.title) + '</h2><ul>' + (s.tips || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></section>';
  }
  function renderNotice(s) {
    return '<section class="nl-sec nl-notice" id="sec-' + esc(s.id) + '"><div class="nl-kicker">' + KICKER.notice + '</div><h2>' + esc(s.title) + '</h2><ul>' + (s.items || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></section>';
  }
  function renderChecklist(s, tier, o) {
    var st = o.state || {};
    return '<section class="nl-sec nl-check" id="sec-' + esc(s.id) + '"><div class="nl-kicker">' + KICKER.checklist + '</div><h2>' + esc(s.title) + '</h2><ul class="nl-cl">' + (s.items || []).map(function (t, i) {
      var key = s.id + ':' + i, on = !!(st.checks && st.checks[key]);
      if (o.mode === 'print') return '<li><span class="nl-box"></span> ' + esc(t) + '</li>';
      return '<li><label><input type="checkbox" data-chk="' + esc(key) + '"' + (on ? ' checked' : '') + '> <span' + (on ? ' class="done"' : '') + '>' + esc(t) + '</span></label></li>';
    }).join('') + '</ul></section>';
  }
  /* 인쇄 정답 별지 — 문제·두뇌 놀이의 답과 해설을 마지막 쪽에 모은다(학습지로 쓸 수 있게) */
  function renderKey(issue) {
    var rows = '';
    (issue.sections || []).forEach(function (s) {
      if (s.type === 'read' && Array.isArray(s.questions) && s.questions.length) {
        rows += '<div class="nl-krow"><b>' + esc(s.title) + '</b><ol>' + s.questions.map(function (q) { return '<li>' + CIRCLED[q.answer] + (q.why ? ' — ' + esc(q.why) : '') + '</li>'; }).join('') + '</ol></div>';
      }
      if (s.type === 'brain' && Array.isArray(s.items)) {
        rows += '<div class="nl-krow"><b>' + esc(s.title) + '</b><ol>' + s.items.map(function (it) { return '<li>' + esc(it.answer) + (it.hint ? ' <span class="nl-ex">(' + esc(it.hint) + ')</span>' : '') + '</li>'; }).join('') + '</ol></div>';
      }
    });
    if (!rows) return '';
    return '<section class="nl-sec nl-key"><div class="nl-kicker">정답과 해설</div><h2>' + esc(issue.title) + ' — 답지</h2>' + rows + '</section>';
  }
  var RENDER = { read: renderRead, words: renderWords, brain: renderBrain, column: renderColumn, coach: renderCoach, notice: renderNotice, checklist: renderChecklist };

  function renderIssue(issue, tier, opts) {
    var o = opts || {};
    if (!isObj(issue)) return '';
    var t = TIER_BY_ID[tier] ? tier : null;
    var view = t ? forTier(issue, t) : issue;
    var h = '<article class="nl' + (o.mode === 'print' ? ' print' : '') + '" data-tier="' + esc(t || '') + '">';
    /* header·footer 요소를 쓰지 않는다 — 관리 웹처럼 header{background:…} 요소 선택자가 있는 화면에 끼우면 머리글이 뒤집힌다 */
    h += '<div class="nl-head"><div class="nl-brand">WB 브레인레터<small>WB 독해력학원 · 웩슬러브레인센터</small></div>';
    h += '<div class="nl-meta">' + esc(weekLabel(issue.week)) + ' · ' + esc(issue.publishAt || '') + (t ? ' · ' + esc(tierLabel(t)) : '') + (issue.status === 'draft' ? ' · <span class="nl-draft">초안</span>' : '') + '</div>';
    h += '<h1 class="nl-title">' + esc(issue.title) + '</h1>';
    if (issue.theme) h += '<p class="nl-theme">이번 주 주제 — ' + esc(issue.theme) + '</p>';
    if (issue.intro) h += '<p class="nl-intro">' + esc(issue.intro).replace(/\n/g, '<br>') + '</p>';
    h += '</div>';
    (view.sections || []).forEach(function (s) { var f = RENDER[s.type]; if (f) h += f(s, t, o); });
    if (o.mode === 'print' && o.key !== false) h += renderKey(view);
    h += '<div class="nl-foot">' + esc(issue.source || '') + ' · 원내 구독 가족에게만 보내는 글입니다. 링크를 밖으로 공유하지 마세요.</div></article>';
    return h;
  }

  /* 두 화면(학생 앱·관리 미리보기)이 같은 CSS 를 쓴다 — 여기 두면 인쇄 규칙도 한 벌이다 */
  var CSS = [
    '.nl{--nl-ink:#22302A;--nl-soft:#6A7A72;--nl-line:#E1E6E2;--nl-green:#2B4C3F;--nl-green-soft:#E6EFEA;--nl-amber:#B27B16;--nl-amber-soft:#F8F1DF;--nl-blue:#2F5F8F;--nl-blue-soft:#E7EEF6;--nl-red:#B0483A;--nl-red-soft:#F9E9E6;--nl-mint:#8FB9A5;color:var(--nl-ink);line-height:1.7;word-break:keep-all}',
    '.nl-head{padding:18px 0 12px;border-bottom:3px solid var(--nl-green);margin-bottom:14px}',
    '.nl-brand{font-weight:900;color:var(--nl-green);font-size:15px;letter-spacing:.02em}.nl-brand small{display:block;font-weight:700;font-size:11px;color:var(--nl-soft);letter-spacing:.06em}',
    '.nl-meta{font-size:12.5px;color:var(--nl-soft);margin-top:8px}.nl-draft{color:var(--nl-amber);font-weight:800}',
    '.nl-title{font-size:26px;line-height:1.3;margin:6px 0 4px;color:var(--nl-green)}.nl-theme{margin:0;font-weight:800;color:var(--nl-blue)}.nl-intro{margin:10px 0 0;color:var(--nl-ink)}',
    '.nl-sec{background:#fff;border:1px solid var(--nl-line);border-radius:16px;padding:16px 18px;margin:0 0 14px}',
    '.nl-kicker{font-size:12px;font-weight:900;color:var(--nl-soft);letter-spacing:.04em;text-transform:uppercase}.nl-sec h2{margin:2px 0 10px;font-size:19px;color:var(--nl-green)}',
    '.nl-lead{margin:0 0 10px;font-weight:700;color:var(--nl-blue)}.nl-p{margin:0 0 10px;font-size:17px}',
    '.nl[data-tier="K"] .nl-p,.nl[data-tier="E1"] .nl-p{font-size:19px;line-height:1.9}',
    '.nl-vocab{background:var(--nl-amber-soft);border-radius:12px;padding:10px 14px;margin:10px 0}.nl-vocab ul,.nl-wl{margin:4px 0 0;padding-left:18px}.nl-hanja{color:var(--nl-soft);font-size:.9em}.nl-ex{color:var(--nl-soft);font-size:.92em}',
    '.nl-qs{margin-top:12px}.nl-q{margin:10px 0 0;padding-top:10px;border-top:1px dashed var(--nl-line)}.nl-qq{margin:0 0 6px;font-weight:800}',
    '.nl-choices{display:grid;gap:6px}.nl-choice{display:block;width:100%;text-align:left;min-height:44px;padding:8px 12px;border:2px solid var(--nl-line);border-radius:12px;background:#fff;font:inherit;font-size:15.5px;color:inherit;cursor:pointer}',
    '.nl-choice.ok{border-color:#2E8B57;background:#EAF5EE}.nl-choice.no{border-color:var(--nl-red);background:var(--nl-red-soft)}.nl-choice.dim{opacity:.55}.nl-choice.static{border-style:dotted;min-height:0;cursor:default}',
    '.nl-why{margin-top:8px;padding:9px 12px;border-radius:10px;background:var(--nl-green-soft);font-size:14.5px}.nl-why.no{background:var(--nl-amber-soft)}.nl-blank{color:var(--nl-soft);font-size:13px;margin-top:6px}',
    '.nl-family{display:flex;align-items:center;gap:12px;margin:0 0 10px}.nl-fh{font-size:38px;font-weight:900;color:var(--nl-green);line-height:1}.nl-wl li{margin:6px 0}',
    '.nl-task{margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--nl-blue-soft);font-weight:700}.nl-lines{height:56px;background:repeating-linear-gradient(#0000 0 26px,#9aa 26px 27px)}',
    '.nl-idx{display:inline-block;font-size:12px;padding:2px 9px;border-radius:999px;background:var(--nl-blue-soft);color:var(--nl-blue);vertical-align:middle;margin-left:6px}.nl-idxnote{margin:0 0 8px;font-size:13.5px;color:var(--nl-soft)}.nl-howto{margin:0 0 10px;padding:9px 12px;border-radius:10px;background:var(--nl-amber-soft)}',
    '.nl-bi{margin:10px 0 0;padding-top:10px;border-top:1px dashed var(--nl-line)}.nl-bp{margin:0 0 6px;font-weight:800}.nl-grid{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px;line-height:1.5;letter-spacing:.2em;margin:6px 0;white-space:pre;overflow:auto;background:#F8FAF8;border-radius:10px;padding:10px 12px}',
    '.nl-reveal{font:inherit;font-size:14px;font-weight:800;min-height:38px;padding:4px 14px;border-radius:999px;border:1.5px solid var(--nl-mint);background:#fff;color:var(--nl-green);cursor:pointer}.nl-ans{margin-top:8px;padding:9px 12px;border-radius:10px;background:var(--nl-green-soft)}',
    '.nl-tip{margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--nl-blue-soft);font-size:14.5px}.nl-take{margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--nl-green-soft);font-weight:800}',
    '.nl-coach ul,.nl-notice ul{margin:0;padding-left:20px}.nl-coach li,.nl-notice li{margin:6px 0}',
    '.nl-cl{list-style:none;margin:0;padding:0}.nl-cl li{margin:6px 0}.nl-cl label{display:flex;gap:10px;align-items:flex-start;min-height:40px;cursor:pointer}.nl-cl input{width:22px;height:22px;min-height:0;padding:0;border:0;margin:4px 0 0;flex:none}.nl-cl .done{text-decoration:line-through;color:var(--nl-soft)}.nl-box{display:inline-block;width:16px;height:16px;border:1.5px solid #666;border-radius:3px;vertical-align:-2px}',
    '.nl-key{border-style:dashed}.nl-krow{margin:8px 0}.nl-krow ol{margin:4px 0 0;padding-left:20px}',
    '.nl-foot{font-size:12px;color:var(--nl-soft);margin:6px 0 20px;line-height:1.5}',
    /* 인쇄(PDF) — A4, 섹션은 쪽 중간에서 잘리지 않게, 정답 별지는 새 쪽에서 */
    '@media print{@page{size:A4;margin:14mm 14mm 16mm}.nl{--nl-line:#bbb}.nl-sec{break-inside:avoid;page-break-inside:avoid;border-radius:6px;padding:10px 12px;margin-bottom:9px}.nl-head{padding-top:0}.nl-title{font-size:22pt}.nl-p{font-size:11.5pt}.nl[data-tier="K"] .nl-p,.nl[data-tier="E1"] .nl-p{font-size:13.5pt}.nl-choice.static{border:0;padding:1px 0;min-height:0}.nl-key{break-before:page;page-break-before:always}.nl-reveal,.nl-ans{display:none}.nl-grid{font-size:15pt}}',
  ].join('\n');

  return {
    TIERS: TIERS, TIER_IDS: TIER_IDS, WISC: WISC, SECTION_TYPES: SECTION_TYPES, KICKER: KICKER, READ_CHARS: READ_CHARS, ISSUE_MAX_BYTES: ISSUE_MAX_BYTES, CSS: CSS,
    esc: esc, kstDate: kstDate, isValidDate: isValidDate, weekId: weekId, weekStart: weekStart, weekLabel: weekLabel,
    tierFromGrade: tierFromGrade, tierOf: tierOf, tierLabel: tierLabel,
    checkIssue: checkIssue, forTier: forTier, isVisible: isVisible, tiersOf: tiersOf, brief: brief, blankIssue: blankIssue,
    renderIssue: renderIssue, renderKey: renderKey,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBLETTER;
