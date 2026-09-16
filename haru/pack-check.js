'use strict';
/* 팩·paperkey 검사의 단일 소스 — CLI(pack-validate)·관리 웹 업로드·배포가 같은 함수를 부른다. 규칙을 복제하면 세 곳의 판정이 갈라진다.
   naesin/pack-check.js 의 규율만 복제하고 파일은 새로 만든다(그쪽 REQUIRED_SECTIONS 는 수학 팩을 100% 차단한다).
   라이선스 게이트는 여기 있다 — 기획서 부록 A-5, 설계안 v1 §5-2·§5-3. */
var WBHARU_PC = (function () {
  var PACK_ID_RE = /^[A-Za-z0-9-]{3,60}$/;
  var SUBJECTS = ['kor', 'math', 'eng'];
  var KINDS = ['drill', 'passage', 'worked', 'screen-mock'];
  var TIERS = ['T0', 'T1', 'T2'];
  var ORIGINS = ['own', 'pd', 'kogl1'];
  var METHODS = ['human', 'ai-concept-first', 'ai-extract'];
  var ERR_KINDS = [null, 'calc', 'concept'];
  var KEY_ORIGINS = ['own', 'commercial'];
  var HOLDERS = ['student', 'academy'];
  var STRIP = ['answerKey', 'explanationKo', 'cueSteps'];          // 정답 제거본에서 빠지는 문항 필드
  var STRIP_CHOICE = ['atomId', 'errKind'];                        // 오답의 좌표를 기기에 두면 학생이 '어느 칸이 찍히는지'를 본다
  /* 오답 선택지에 atomId 또는 errKind 가 필수인 원자 — 수학·어휘. 독해에서는 '어느 원자의 정답인가'에 답이 없는 경우가 대부분이라 선택. */
  var DISTRACTOR_REQUIRED = /^(m-|n-|e-vocab|e-word|e-poly|k-word|k-hanja|k-idiom|k-spell)/;

  function Ctx() { this.errors = []; this.warnings = []; }
  Ctx.prototype.err = function (w, m) { this.errors.push({ where: w, msg: m }); };
  Ctx.prototype.warn = function (w, m) { this.warnings.push({ where: w, msg: m }); };
  function isStr(v) { return typeof v === 'string' && v.length > 0; }
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  /* opts: { atoms: atoms.json 문서(있으면 atomId 존재 검사), now: ms(라이선스 만료 검사) } */
  function checkPack(pack, opts) {
    opts = opts || {};
    var c = new Ctx();
    if (!isObj(pack)) { c.err('pack', '객체가 아닙니다'); return c; }
    var w = 'pack';
    if (!PACK_ID_RE.test(pack.packId || '')) c.err(w, 'packId 형식 (영숫자·하이픈 3~60자)');
    if (!isStr(pack.treeId)) c.err(w, 'treeId 가 필요합니다');
    if (SUBJECTS.indexOf(pack.subject) < 0) c.err(w, 'subject 는 kor|math|eng');
    if (KINDS.indexOf(pack.kind) < 0) c.err(w, 'kind 는 drill|passage|worked|screen-mock');
    if (pack.mode !== 'screen') c.err(w, "mode 는 'screen' 뿐입니다 — 종이 회차는 팩이 아니라 paperkey");
    if (TIERS.indexOf(pack.tier) < 0) c.err(w, 'tier 는 T0|T1|T2');
    if (ORIGINS.indexOf(pack.origin) < 0) c.err(w, 'origin 은 own|pd|kogl1 — 시판·문제은행 원문은 팩이 될 수 없다(T2 재창작 또는 T3 paperkey)');
    if (!isStr(pack.source)) c.err(w, 'source 문장이 필요합니다');
    if (!Array.isArray(pack.cohort) || !pack.cohort.length) c.warn(w, 'cohort 가 비어 있습니다 — 배정 없는 팩은 아무에게도 내려가지 않는다');

    /* 라이선스 */
    var lic = pack.license;
    if (!isObj(lic)) c.err(w, 'license 가 필요합니다');
    else {
      if (!Array.isArray(lic.allowedUse) || lic.allowedUse.indexOf('serve') < 0) c.err(w, "license.allowedUse 에 'serve' 가 없으면 앱에 내려보낼 수 없습니다");
      if (isObj(lic.scope) && lic.scope.onlineTransmission === false) c.err(w, 'license.scope.onlineTransmission 이 false — 온라인 전송 불가 자료');
      if (isStr(lic.expiresAt) && opts.now != null && Date.parse(lic.expiresAt) < opts.now) c.err(w, '라이선스 만료(' + lic.expiresAt + ') — 배포 거부, retention.purgeOnExpiry');
    }
    /* 공공누리 1유형 — 출처 표기 필수, 화면이 렌더한다 */
    if (pack.origin === 'kogl1') {
      var at = pack.attribution;
      if (!isObj(at) || !isStr(at.org) || !isStr(at.title) || at.year == null || !isStr(at.url)) c.err(w, "origin:'kogl1' 은 attribution{org,title,year,url} 이 전부 필요합니다 (학생 화면 지문 하단에 렌더)");
    }
    /* 고전(만료) — 원문만 외부, 현대어역·주석은 자체 집필 */
    if (pack.origin === 'pd') (pack.passages || []).forEach(function (p, i) {
      if (p.translation !== 'own') c.err('passages[' + i + ']', "origin:'pd' 지문은 translation:'own' 이어야 합니다 — 남의 현대어역은 저작물이다");
    });
    /* 변형 등급 */
    var prov = pack.provenance;
    if (!isObj(prov) || METHODS.indexOf(prov.method) < 0) c.err(w, 'provenance.method 는 human|ai-concept-first|ai-extract');
    else {
      if (pack.tier === 'T2' && (prov.method !== 'ai-concept-first' && prov.method !== 'human')) c.err(w, 'T2 는 concept-first(또는 사람 창작)여야 합니다');
      if (pack.tier === 'T2' && prov.sourceText !== false) c.err(w, 'T2 인데 provenance.sourceText 가 false 가 아닙니다 — 원문이 KV 에 남으면 안 된다');
      if (pack.tier === 'T1' && !isStr(prov.sourceRef)) c.err(w, 'T1(매개 변주)은 provenance.sourceRef 가 필요합니다');
      if (prov.method === 'ai-extract') c.warn(w, 'ai-extract 는 T0 허용 공급원에서만 — 라이선스 서면 확인 전이면 배포하지 않는다');
    }
    if (pack.kind === 'screen-mock' && !(typeof pack.timeLimitSec === 'number' && pack.timeLimitSec > 0)) c.err(w, 'screen-mock 은 timeLimitSec 이 필요합니다 (요강 40분 = 2400)');

    /* 지문 */
    var pids = {};
    (pack.passages || []).forEach(function (p, i) {
      var pw = 'passages[' + i + ']';
      if (!isStr(p.id)) c.err(pw, 'id'); else if (pids[p.id]) c.err(pw, '중복 id'); else pids[p.id] = p;
      if (!isStr(p.textKo)) c.err(pw, 'textKo 가 비었습니다');
      if (!Array.isArray(p.itemNos) || !p.itemNos.length) c.err(pw, 'itemNos 가 비었습니다');
    });

    /* 문항 */
    var atomIdx = null;
    if (opts.atoms && Array.isArray(opts.atoms.atoms)) { atomIdx = {}; opts.atoms.atoms.forEach(function (a) { atomIdx[a.id] = a; }); }
    var nos = {};
    (pack.items || []).forEach(function (it, i) {
      var iw = 'items[' + i + ']' + (it && it.no != null ? ' #' + it.no : '');
      if (!isObj(it)) { c.err(iw, '객체가 아닙니다'); return; }
      if (!(Number.isInteger(it.no) && it.no >= 1)) c.err(iw, 'no 는 1 이상 정수'); else if (nos[it.no]) c.err(iw, '중복 no'); else nos[it.no] = it;
      if (!isStr(it.atomId)) c.err(iw, 'atomId 가 필요합니다');
      else if (atomIdx && !atomIdx[it.atomId]) c.err(iw, '없는 원자: ' + it.atomId);
      else if (atomIdx && atomIdx[it.atomId].teach === 'paper') c.warn(iw, it.atomId + " 는 teach:'paper' 원자 — 앱 문항은 관측만 되고 처방에 쓰이지 않는다");
      if (!isStr(it.instructionKo)) c.err(iw, 'instructionKo');
      if (!(it.tier === 1 || it.tier === 2 || it.tier === 3)) c.err(iw, 'tier 는 1|2|3');
      if (it.setId != null && !pids[it.setId]) c.err(iw, 'setId 가 없는 지문을 가리킵니다: ' + it.setId);
      if (it.setId == null && pack.kind === 'passage') c.warn(iw, 'passage 팩의 문항인데 setId 가 없습니다 — pace 세트 귀속 불가');
      var ch = it.choices;
      if (!Array.isArray(ch) || ch.length < 2) { c.err(iw, 'choices 2개 이상'); return; }
      var keys = {}, hasKey = false, tagged = 0;
      ch.forEach(function (o, j) {
        var cw = iw + ' choices[' + j + ']';
        if (!isStr(o.key)) c.err(cw, 'key'); else if (keys[o.key]) c.err(cw, '중복 key'); else keys[o.key] = true;
        if (!isStr(o.text)) c.err(cw, 'text 가 비었습니다');
        if (o.key === it.answerKey) hasKey = true;
        if (o.key !== it.answerKey) {
          if (o.atomId != null && atomIdx && !atomIdx[o.atomId]) c.err(cw, '없는 원자: ' + o.atomId);
          if (o.atomId != null && o.atomId === it.atomId) c.err(cw, '오답이 정답 원자 자신을 가리킵니다');
          if (ERR_KINDS.indexOf(o.errKind === undefined ? null : o.errKind) < 0) c.err(cw, 'errKind 는 calc|concept|null');
          if (o.atomId || o.errKind) tagged++;
        } else {
          if (o.atomId || o.errKind) c.err(cw, '정답 선택지에는 atomId·errKind 를 두지 않는다 (정답을 기기에서 식별할 수 있다)');
        }
      });
      if (!isStr(it.answerKey) || !hasKey) c.err(iw, 'answerKey 가 choices 의 key 가 아닙니다');
      if (!(Number.isInteger(it.answerCount) && it.answerCount >= 1)) c.err(iw, 'answerCount');
      if (isStr(it.atomId) && DISTRACTOR_REQUIRED.test(it.atomId) && tagged === 0)
        c.err(iw, '수학·어휘 원자 문항은 오답 선택지 중 하나 이상에 atomId 또는 errKind 가 필요합니다 (③유형 혼동·②실행 오류의 유일한 관측 근거)');
      if (!isStr(it.explanationKo)) c.warn(iw, 'explanationKo 가 없습니다 — 응답 후 해설이 비게 된다');
      if (Array.isArray(it.cueSteps) && it.cueSteps.length && atomIdx && atomIdx[it.atomId] && atomIdx[it.atomId].teach !== 'app') c.warn(iw, "cueSteps 는 teach:'app' 원자에만 뜻이 있다");
    });
    /* 지문 ↔ 문항 양방향 */
    Object.keys(pids).forEach(function (pid) {
      (pids[pid].itemNos || []).forEach(function (no) {
        if (!nos[no]) c.err('passages ' + pid, 'itemNos 가 없는 문항을 가리킵니다: ' + no);
        else if (nos[no].setId !== pid) c.err('passages ' + pid, '문항 ' + no + ' 의 setId 가 ' + pid + ' 가 아닙니다');
      });
    });
    if (isObj(pack.counts) && pack.counts.items != null && pack.counts.items !== (pack.items || []).length) c.err(w, 'counts.items 가 실제 문항 수와 다릅니다');
    if (!(pack.items || []).length) c.err(w, 'items 가 비었습니다');
    return c;
  }

  /* 정답 제거본 — GET /pack 이 내려보내는 형태. 이 함수가 곧 '정답이 기기에 없다'는 성립 조건이다. */
  function stripForStudent(pack) {
    var out = JSON.parse(JSON.stringify(pack));
    (out.items || []).forEach(function (it) {
      STRIP.forEach(function (k) { delete it[k]; });
      (it.choices || []).forEach(function (o) { STRIP_CHOICE.forEach(function (k) { delete o[k]; }); });
    });
    delete out.provenance;
    return out;
  }

  /* paperkey — 저작권 게이트와 세트 경계 */
  function checkPaperKey(key, opts) {
    var c = new Ctx();
    if (!isObj(key)) { c.err('paperkey', '객체가 아닙니다'); return c; }
    var w = 'paperkey ' + (key.id || '?');
    if (!PACK_ID_RE.test(key.id || '')) c.err(w, 'id 형식');
    if (SUBJECTS.indexOf(key.subject) < 0) c.err(w, 'subject 는 kor|math|eng');
    if (!(Number.isInteger(key.n) && key.n >= 1)) c.err(w, 'n');
    if (KEY_ORIGINS.indexOf(key.origin) < 0) c.err(w, "origin 은 own|commercial — 타 학원 모의고사(academy-mock 등)는 등록할 수 없습니다");
    if (/타\s*학원|학원\s*모의고사|연합\s*모의/.test(key.label || '') && key.origin !== 'own') c.err(w, '타 학원·연합 모의고사는 등록할 수 없습니다');
    if (HOLDERS.indexOf(key.holder) < 0) c.err(w, 'holder 는 student|academy');
    /* 시판 교재·타 학원 모의의 정답 표는 본문이 없어도 그 자료의 상업적 가치를 대체한다. 정답 표를 막아도 학원이 복사해 배부하면 복제다 — holder 로 막는다. */
    if (key.origin === 'commercial' && key.answer) c.err(w, '시판 자료에는 정답 표를 담을 수 없습니다 (번호↔원자 대응만)');
    if (key.origin === 'commercial' && key.holder !== 'student') c.err(w, "시판 자료는 학생 본인 소지 교재만 (holder:'student') — 학원 복사 배부는 복제");
    if (key.origin === 'own' && !key.answer) c.warn(w, '자작 자료인데 정답 표가 없습니다 — 서버 채점이 안 됩니다');
    if (!isObj(key.map) || !Object.keys(key.map).length) c.err(w, 'map(번호↔원자)이 비었습니다');
    else {
      var atomIdx = null;
      if (opts && opts.atoms && Array.isArray(opts.atoms.atoms)) { atomIdx = {}; opts.atoms.atoms.forEach(function (a) { atomIdx[a.id] = a; }); }
      Object.keys(key.map).forEach(function (no) {
        if (!(+no >= 1 && +no <= key.n)) c.err(w, 'map 번호가 범위 밖: ' + no);
        if (atomIdx && !atomIdx[key.map[no]]) c.err(w, 'map 이 없는 원자를 가리킵니다: ' + key.map[no]);
      });
    }
    if (key.answer) Object.keys(key.answer).forEach(function (no) { if (!(+no >= 1 && +no <= key.n)) c.err(w, 'answer 번호가 범위 밖: ' + no); });
    /* 세트 경계 — 국어·영어는 지문 종속이라 필수. 번호 중복·범위 밖·누락은 오류. */
    if ((key.subject === 'kor' || key.subject === 'eng') && !isObj(key.sets)) c.err(w, '국어·영어 종이는 sets(지문 세트 경계)가 필수입니다 — 없으면 pace 가 세트 첫 문항에 지문 시간을 뒤집어씌운다');
    if (isObj(key.sets)) {
      var seen = {};
      Object.keys(key.sets).forEach(function (sid) {
        (key.sets[sid] || []).forEach(function (no) {
          if (!(no >= 1 && no <= key.n)) c.err(w, 'sets 번호가 범위 밖: ' + no);
          if (seen[no]) c.err(w, 'sets 에 번호 중복: ' + no); seen[no] = true;
        });
      });
      for (var i = 1; i <= key.n; i++) if (!seen[i]) c.err(w, 'sets 에 빠진 번호: ' + i);
    }
    if (key.frozen && !(typeof key.timeLimitSec === 'number' && key.timeLimitSec > 0)) c.err(w, '동결(회차) 대응표에는 timeLimitSec 이 필요합니다');
    if (key.frozen && key.origin !== 'own') c.err(w, '동결 세트는 자작(own)이어야 합니다 — 재응시·서버 채점 전제');
    return c;
  }

  /* teach:'paper' 원자의 paperSource 가 실제 paperkey 로 존재하는가 — 종이가 없으면 그 원자는 트리에 못 들어간다 */
  function checkPaperSources(atomsDoc, paperkeyIds) {
    var c = new Ctx(); var have = {};
    (paperkeyIds || []).forEach(function (id) { have[id] = true; });
    ((atomsDoc && atomsDoc.atoms) || []).forEach(function (a) {
      if (a.teach === 'paper' && !have[a.paperSource]) c.warn(a.id, "paperSource '" + a.paperSource + "' 가 KV 에 없습니다 — 배포 전 등록");
    });
    return c;
  }

  return { PACK_ID_RE: PACK_ID_RE, STRIP: STRIP, STRIP_CHOICE: STRIP_CHOICE, checkPack: checkPack, stripForStudent: stripForStudent, checkPaperKey: checkPaperKey, checkPaperSources: checkPaperSources };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_PC;
