'use strict';
/* haru/atoms.json 검증기 — 브라우저/Node 공용 순수 로직.
   원자 목록은 저장소에 커밋되는 유일한 콘텐츠 계층이라, 여기서 어긋나면 팩·플랜·리포트가 전부 잘못된 이름을 가리킨다.
   규칙은 설계안 v1 §5-1 을 따른다. */
var WBHARU_ATOMS = (function () {
  var SUBJECTS = ['kor', 'math', 'eng'];
  var WEIGHTS = [2, 1, 0.5];                 // 25문항 중 기대 문항 수 — 세 값만. 검증 불가한 추정이라 일부러 뭉갠다
  var TEACH = ['app', 'paper'];
  var KINDS = ['mcq', 'habit'];
  var BANDS = ['4-1', '4-2', '5-1', '5-2', '6-1', 'none'];
  var PHASES = ['p1', 'p2', 'p3', 'p4'];
  var CORE_SHAPE = { kor: 6, math: 6, eng: 4 };   // 원장 확정 2026-09-04 — 국면 ②~④ 코어 16
  var ID_RE = /^[a-z][a-z0-9-]{2,}$/;
  /* 출제지형도 트리 ID. 국어 K01~K38 · 영어 E01~E36 · 수학 N1~N6, A1~A15, B1~B10, C1~C22, D1~D6.
     수학 시험 운영 E1~E5 는 원자가 아니라(pace·mocks[].skills) 여기 없다 — 두 자리 E 만 영어다. */
  var SKILL_RE = /^(K(0[1-9]|[1-2]\d|3[0-8])|E(0[1-9]|[1-2]\d|3[0-6])|N[1-6]|A(1[0-5]|[1-9])|B(10|[1-9])|C(2[0-2]|1\d|[1-9])|D[1-6])$/;
  var NON_ATOM_SKILLS = { K36: true, E35: true };   // 시간 배분 — 지표이지 원자가 아니다
  var HABIT_ONLY_SKILLS = { K38: true };            // 1회독 — kind:'habit' 원자만 가리킬 수 있다

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function isStr(v) { return typeof v === 'string' && v.length > 0; }

  /* 'same-as-pX' 참조를 풀어 실제 배열을 돌려준다. 순환이면 null. */
  function coreFor(doc, phase) {
    var seen = {};
    var cur = phase;
    for (var i = 0; i < PHASES.length + 1; i++) {
      if (seen[cur]) return null;
      seen[cur] = true;
      var v = doc && doc.coreByPhase ? doc.coreByPhase[cur] : undefined;
      if (Array.isArray(v)) return v;
      if (typeof v === 'string' && /^same-as-p[1-4]$/.test(v)) { cur = v.slice(8); continue; }
      return null;
    }
    return null;
  }

  function bySkill(doc) {
    var m = {};
    (doc.atoms || []).forEach(function (a) {
      (a.skillIds || []).forEach(function (s) { (m[s] = m[s] || []).push(a.id); });
    });
    return m;
  }

  /* 선수 관계 순환 검사 — 순환이면 probe 의 A(k) 가 서로를 영원히 0.2 로 깎아 어느 쪽도 찔리지 않는다. */
  function findCycle(atoms) {
    var idx = {}; atoms.forEach(function (a) { idx[a.id] = a; });
    var state = {}; var found = null;
    function visit(id, path) {
      if (found) return;
      if (state[id] === 1) { found = path.concat(id); return; }
      if (state[id] === 2) return;
      state[id] = 1;
      var a = idx[id];
      ((a && a.prereq) || []).forEach(function (p) { if (idx[p]) visit(p, path.concat(id)); });
      state[id] = 2;
    }
    atoms.forEach(function (a) { visit(a.id, []); });
    return found;
  }

  function check(doc, opts) {
    opts = opts || {};
    var errors = [], warnings = [];
    function err(w, m) { errors.push({ where: w, msg: m }); }
    function warn(w, m) { warnings.push({ where: w, msg: m }); }

    if (!isObj(doc)) { err('doc', '객체가 아닙니다'); return { errors: errors, warnings: warnings, stats: null }; }
    ['treeId', 'source', 'notice'].forEach(function (k) { if (!isStr(doc[k])) err('doc', k + ' 문자열이 필요합니다'); });
    if (typeof doc.version !== 'number') err('doc', 'version 숫자가 필요합니다');
    if (!Array.isArray(doc.atoms) || doc.atoms.length === 0) { err('doc', 'atoms 배열이 비었습니다'); return { errors: errors, warnings: warnings, stats: null }; }
    if (!isObj(doc.coreByPhase)) err('doc', 'coreByPhase 가 필요합니다');

    var ids = {};
    doc.atoms.forEach(function (a, i) {
      var w = 'atoms[' + i + ']' + (a && a.id ? ' ' + a.id : '');
      if (!isObj(a)) { err(w, '객체가 아닙니다'); return; }
      if (!isStr(a.id) || !ID_RE.test(a.id)) err(w, 'id 형식 (소문자·숫자·하이픈, 3자 이상)');
      else if (ids[a.id]) err(w, '중복 id'); else ids[a.id] = a;
    });

    doc.atoms.forEach(function (a) {
      if (!isObj(a) || !isStr(a.id)) return;
      var w = a.id;
      if (SUBJECTS.indexOf(a.subject) < 0) err(w, 'subject 는 kor|math|eng');
      if (!isStr(a.label)) err(w, 'label 이 비었습니다');
      var kind = a.kind || 'mcq';
      if (KINDS.indexOf(kind) < 0) err(w, 'kind 는 mcq|habit');
      if (!Array.isArray(a.skillIds) || a.skillIds.length === 0) err(w, 'skillIds 가 비었습니다 — 트리와 연결되지 않은 원자는 커버리지를 잃는다');
      else a.skillIds.forEach(function (s) {
        if (!SKILL_RE.test(s)) err(w, 'skillIds 형식 아님: ' + s);
        else if (NON_ATOM_SKILLS[s]) err(w, s + ' 은 시험 운영 지표라 원자가 가리킬 수 없습니다');
        else if (HABIT_ONLY_SKILLS[s] && kind !== 'habit') err(w, s + ' 은 kind:habit 원자만 가리킬 수 있습니다');
      });
      if (BANDS.indexOf(a.band) < 0) warn(w, 'band 값이 표준 밖: ' + a.band);
      if (!isStr(a.unitRef)) err(w, 'unitRef 가 비었습니다');
      if (!Array.isArray(a.std)) err(w, 'std 는 배열(비어 있어도 됨)');
      ['prereq', 'confuse'].forEach(function (k) {
        var arr = a[k];
        if (arr == null) return;
        if (!Array.isArray(arr)) { err(w, k + ' 는 배열'); return; }
        arr.forEach(function (r) {
          if (r === a.id) err(w, k + ' 가 자기 자신을 가리킵니다');
          else if (!ids[r]) err(w, k + ' 가 없는 원자를 가리킵니다: ' + r);
          else if (ids[r].subject !== a.subject) warn(w, k + ' 가 다른 과목 원자를 가리킵니다: ' + r);
        });
      });
      if (WEIGHTS.indexOf(a.weight) < 0) err(w, 'weight 는 2|1|0.5');
      if (!(a.tier === 1 || a.tier === 2 || a.tier === 3)) err(w, 'tier 는 1|2|3');
      if (TEACH.indexOf(a.teach) < 0) err(w, 'teach 는 app|paper');
      if (a.teach === 'paper' && !isStr(a.paperSource))
        err(w, "teach:'paper' 인데 paperSource 가 없습니다 — 종이가 없으면 그 원자는 트리에 못 들어간다");
      if (a.teach === 'app' && kind === 'mcq' && (!Array.isArray(a.gen) || a.gen.length === 0))
        err(w, "teach:'app' 원자는 gen(생성기) 이 하나 이상 필요합니다 — 없으면 손 문항뿐이라 관측이 안 쌓인다");
      if (kind === 'habit' && Array.isArray(a.gen) && a.gen.length) warn(w, 'habit 원자에 gen 이 있습니다');
      if (typeof a.targetSec !== 'number' || a.targetSec < 0) err(w, 'targetSec 숫자(0 이상)');
      if (!isStr(a.carryTo)) err(w, 'carryTo 가 비었습니다 — 회고 화면의 획득 축이 빈다');
    });

    var cyc = findCycle(doc.atoms.filter(function (a) { return isObj(a) && ids[a.id] === a; }));
    if (cyc) err('prereq', '선수 관계 순환: ' + cyc.join(' → '));

    var stats = { total: doc.atoms.length, bySubject: {}, paper: 0, core: {} };
    doc.atoms.forEach(function (a) {
      if (!isObj(a)) return;
      stats.bySubject[a.subject] = (stats.bySubject[a.subject] || 0) + 1;
      if (a.teach === 'paper') stats.paper++;
    });

    if (isObj(doc.coreByPhase)) {
      PHASES.forEach(function (ph) {
        var core = coreFor(doc, ph);
        if (!core) { err('coreByPhase.' + ph, '배열이거나 same-as-pX 참조여야 합니다'); return; }
        stats.core[ph] = core.length;
        var shape = {};
        core.forEach(function (id) {
          if (!ids[id]) { err('coreByPhase.' + ph, '없는 원자: ' + id); return; }
          if (ids[id].teach !== 'app') err('coreByPhase.' + ph, id + ' 는 teach:paper 라 코어가 될 수 없습니다 (앱이 매일 잴 수 없다)');
          shape[ids[id].subject] = (shape[ids[id].subject] || 0) + 1;
        });
        var dup = core.filter(function (id, i) { return core.indexOf(id) !== i; });
        if (dup.length) err('coreByPhase.' + ph, '중복: ' + dup.join(','));
        if (ph !== 'p1') {
          if (core.length !== 16) err('coreByPhase.' + ph, '코어는 16칸 (현재 ' + core.length + ')');
          SUBJECTS.forEach(function (s) {
            if ((shape[s] || 0) !== CORE_SHAPE[s]) err('coreByPhase.' + ph, s + ' 코어 ' + CORE_SHAPE[s] + '칸이어야 합니다 (현재 ' + (shape[s] || 0) + ')');
          });
        }
      });
    }

    if (Array.isArray(opts.treeIds)) {
      var cov = bySkill(doc);
      var uncovered = opts.treeIds.filter(function (s) { return !cov[s] && !NON_ATOM_SKILLS[s] && !/^E[1-5]$/.test(s); });
      if (uncovered.length) warn('coverage', '어느 원자도 가리키지 않는 트리 스킬: ' + uncovered.join(', '));
      stats.uncovered = uncovered;
    }
    return { errors: errors, warnings: warnings, stats: stats };
  }

  return { check: check, coreFor: coreFor, bySkill: bySkill, findCycle: findCycle,
           SKILL_RE: SKILL_RE, WEIGHTS: WEIGHTS, CORE_SHAPE: CORE_SHAPE };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_ATOMS;
