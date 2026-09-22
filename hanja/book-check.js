'use strict';
/* WB 어휘브레인 — 단어장(wordbook) 검사·정규화·텍스트 파서 (브라우저·Node 공용)
 *
 * 단어장 = 문제집 한 권(예: 어휘 교재 1권)의 낱말·한자를 단원 순서대로 담은 JSON.
 * 같은 규칙이 세 곳에서 필요하다 — 관리 웹 업로드 관문(서버), 미리보기(브라우저),
 * CLI 검증기(book-validate.mjs). 규칙을 복제하면 "미리보기는 통과인데 업로드가 막히는"
 * 판정 불일치가 생기므로 규칙은 이 파일 하나에만 둔다(naesin/pack-check.js 와 같은 이유).
 *
 * 단어장 모양(정규화 뒤):
 *   { id, title, publisher?, level?, note?, source:'own'|'textbook',   // 종류 — 자체(학원 자료)·교재(구매 자료, 기본). AI 연상은 own 만
 *     units: [{ id, title }],                       // 문제집의 단원·회차 순서 그대로
 *     words: [{ id, unit, word, type:'hanja'|'native', hanja?, parts?:[{ch,hun,eum}], literal?,
 *               meaning, example?, syn?:[], scene? }],       // id 는 '낱말|한자'(내용 기반) — 재업로드에도 안 밀린다
 *     chars: [{ ch, hun, eum, strokes?, unit, medians?:[[[x,y],…],…], radical?, similar?:[…], words:[…], derived? }] }
 *   chars 의 words 는 그 글자를 쓰는 낱말(급수 교재의 예시 낱말). 직접 적어도 되고, 낱말의 한자 분해에서 저절로 붙기도 한다.
 *
 * chars 는 두 갈래로 채워진다 — 한자 급수 교재처럼 글자를 직접 적은 것(explicit)과,
 * 낱말의 한자 분해(parts)에서 끌어낸 것(derived). 직접 적은 것이 이긴다. 직접 적은 글자는 그 단원의
 * 학습 항목(심기·진도)이고, 끌어낸 글자는 낱말에 딸린 참고(한자 탭 따라쓰기)다 — 한자어 교재의 낱말 12개가
 * 한자 25자에 묻히지 않게. 끌어낸 글자에 획수를 주려면 최상위 strokes 표({"觀":25})를 쓴다.
 * medians 는 획순 데이터(0~1 좌표, 획 순서대로)로, 있는 글자만 획순 모드가 열린다 —
 * 없으면 모양 따라쓰기만 한다. 없는 데이터로 획순을 채점하지 않는다.
 *
 * 영어 낱말은 받지 않는다 — 이 앱은 한자·한글 어휘만 다룬다(영어는 워드브레인).
 */
var WBBOOKCHECK = (function () {
  'use strict';

  var ID_RE = /^[A-Za-z0-9-]{3,60}$/;
  /* 한자 한 글자 — CJK 통합·확장A·호환(樂·不 같은 한국 호환 자형) */
  var HANJA_ONE = /^[㐀-䶿一-鿿豈-﫿]$/;
  var HANJA_ANY = /[㐀-䶿一-鿿豈-﫿]/;
  var ENGLISH_WORD = /^[A-Za-z][A-Za-z\s'-]*$/;
  var LEVELS = ['L1', 'L2', 'L3', 'L4'];
  /* 단어장 종류 — 교재(textbook)는 구매 자료라 뜻 문장을 외부 AI 로 보내지 않는다. 자체(own)는 학원이 만든 자료(체험 단어장·진로독서 어휘장). 기본은 교재 */
  var SOURCES = ['own', 'textbook'];

  var LIMITS = {
    words: 3000, chars: 2000, units: 200,
    title: 60, publisher: 40, note: 200,
    word: 40, meaning: 200, example: 200, unit: 40, unitTitle: 60, itemId: 100,
    charWords: 12,
    hun: 20, eum: 4, strokes: 64, medianStrokes: 64, medianPts: 64, syn: 8, synLen: 40, similar: 8, scene: 200,
  };

  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function str(v, max) { var s = v == null ? '' : String(v).trim(); return max ? s.slice(0, max) : s; }
  function isHanjaChar(c) { return typeof c === 'string' && HANJA_ONE.test(c); }
  function hanjaOf(s) {
    var out = [];
    String(s == null ? '' : s).split('').forEach(function (c) { if (HANJA_ONE.test(c)) out.push(c); });
    return out;
  }

  /* '觀(볼 관)+測(잴 측)' 또는 '觀測' 둘 다 받는다 — 워드브레인 배정과 같은 표기 */
  function parseHanjaSpec(spec) {
    if (!spec) return null;
    var withGloss = [], re = /([㐀-䶿一-鿿豈-﫿])\s*\(([^)]+)\)/g, m;
    while ((m = re.exec(String(spec)))) {
      var inner = m[2].trim(), sp = inner.lastIndexOf(' ');
      withGloss.push(sp < 0 ? { ch: m[1], hun: inner, eum: inner } : { ch: m[1], hun: inner.slice(0, sp), eum: inner.slice(sp + 1) });
    }
    if (withGloss.length) return withGloss;
    var bare = hanjaOf(spec);
    if (!bare.length) return null;
    return bare.map(function (ch) { return { ch: ch, hun: '', eum: '' }; });   // 훈음 미상
  }

  /* ── 낱말이 예문 어디에 있는가 → { start, end } | null ──
     빈칸 문제(quiz.js)와 검사 경고가 같은 판정을 써야 한다 — 검사는 "빈칸 문제에서 빠진다"고
     경고하는데 실제로는 문제가 나오면(또는 그 반대) 강사가 검사를 안 믿게 된다. 그래서 여기 하나에 둔다.
     활용형을 잡는다: 어간 그대로(다잡다→다잡고), 어간 끝 음절만 바뀐 꼴(엇갈리다→엇갈렸다,
     북돋우다→북돋웠다)은 앞부분으로 자리를 잡고 다음 음절의 첫소리가 같은지로 확인한다.
     르 불규칙(벼르다→별러)은 앞 음절에 ㄹ 받침을 붙여 본다. 어절 한가운데는 잡지 않는다 —
     남의 낱말 속(「가르침」의 '가')에 걸리면 엉뚱한 자리가 가려진다. */
  var CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'.split('');
  var JONG_N = 28;
  var HANGUL = /[가-힣]/;
  function cho(ch) { var c = String(ch || '').charCodeAt(0) - 0xAC00; return (c < 0 || c > 11171) ? '' : CHO[Math.floor(c / 588)]; }
  function withRieul(ch) {   /* 받침 없는 음절에 ㄹ 받침 — 벼 → 별 */
    var c = String(ch || '').charCodeAt(0) - 0xAC00;
    if (c < 0 || c > 11171 || c % JONG_N !== 0) return ch;
    return String.fromCharCode(0xAC00 + c + 8);
  }
  function atStart(ex, i) { return i === 0 || !HANGUL.test(ex[i - 1]); }
  function eojeolEnd(ex, from) { var i = from; while (i < ex.length && HANGUL.test(ex[i])) i += 1; return i; }
  function stems(word) {
    var out = [word], cut = word.replace(/다$/, '');
    if (cut && cut !== word) out.push(cut);
    var m = word.match(/^(.+?)(하다|되다|스럽다|롭다|답다)$/);
    if (m && m[1] && out.indexOf(m[1]) < 0) out.push(m[1]);
    return out.filter(Boolean).sort(function (a, b) { return b.length - a.length; });
  }
  function findConjugated(ex, stem) {
    if (stem.length < 2) return -1;
    var head = stem.slice(0, -1), want = cho(stem.slice(-1));
    if (!want) return -1;
    var heads = [head];
    if (stem.slice(-1) === '르') { var alt = head.slice(0, -1) + withRieul(head.slice(-1)); if (alt !== head) heads.unshift(alt); }
    for (var h = 0; h < heads.length; h++) {
      for (var i = ex.indexOf(heads[h]); i >= 0; i = ex.indexOf(heads[h], i + 1)) {
        var next = ex[i + heads[h].length];
        if (!next || !HANGUL.test(next) || cho(next) !== want || !atStart(ex, i)) continue;
        return i;
      }
    }
    return -1;
  }
  function findInExample(example, word) {
    var ex = String(example == null ? '' : example), ss = stems(String(word == null ? '' : word).trim());
    var k, stem, i;
    if (!ex || !ss.length) return null;
    for (k = 0; k < ss.length; k++) {           /* ① 글자 그대로 */
      stem = ss[k];
      if (stem.length >= 2) i = ex.indexOf(stem);
      else { i = -1; for (var n = 0; n < ex.length; n++) if (ex[n] === stem && atStart(ex, n)) { i = n; break; } }
      if (i >= 0) return { start: i, end: eojeolEnd(ex, i + stem.length) };
    }
    for (k = 0; k < ss.length; k++) {           /* ② 활용한 꼴 */
      i = findConjugated(ex, ss[k]);
      if (i >= 0) return { start: i, end: eojeolEnd(ex, i) };
    }
    return null;
  }
  function exampleHasWord(example, word) { return !!findInExample(example, word); }

  function collector() {
    var errors = [], warns = [];
    return {
      errors: errors, warns: warns,
      err: function (where, message) { errors.push({ where: where, message: message }); },
      warn: function (where, message) { warns.push({ where: where, message: message }); },
    };
  }

  function pad3(n) { return (n < 10 ? '00' : n < 100 ? '0' : '') + n; }
  function contentId(word, hanja) { return (word + (hanja ? '|' + hanja : '')).slice(0, LIMITS.itemId); }

  /* ── 정규화 + 검사 ── 한 번에 한다. 정규화하면서 알게 되는 것이 곧 검사 결과다. */
  function checkBook(raw, opts) {
    var C = collector();
    opts = opts || {};
    if (!isObj(raw)) {
      C.err('book', '단어장은 JSON 객체여야 해요.');
      return { ok: false, errors: C.errors, warns: C.warns, summary: [], book: null };
    }
    var book = {
      id: str(raw.id), title: str(raw.title, LIMITS.title), publisher: str(raw.publisher, LIMITS.publisher),
      level: str(raw.level), note: str(raw.note, LIMITS.note), source: str(raw.source), units: [], words: [], chars: [],
    };
    if (!ID_RE.test(book.id)) C.err('id', 'id 는 영문·숫자·하이픈 3~60자 — 드라이브 폴더 이름과 같게 둔다 (예: eohwi-dokhae-1)');
    if (!book.title) C.err('title', '제목이 없어요.');
    if (book.level && LEVELS.indexOf(book.level) < 0) { C.warn('level', '학년대는 L1~L4 — "' + book.level + '" 는 지운다'); book.level = ''; }
    if (book.source && SOURCES.indexOf(book.source) < 0) { C.warn('source', '종류는 own(자체)·textbook(교재) — "' + book.source + '" 는 교재로 둔다'); book.source = ''; }
    if (!book.source) book.source = 'textbook';

    /* 단원 — 적힌 순서가 곧 학습 순서다 */
    var unitIdx = {};
    function addUnit(id, title, where) {
      id = str(id, LIMITS.unit);
      if (!id) return '';
      if (unitIdx[id] == null) {
        if (book.units.length >= LIMITS.units) { C.err(where || 'units', '단원이 ' + LIMITS.units + '개를 넘어요.'); return id; }
        unitIdx[id] = book.units.length;
        book.units.push({ id: id, title: str(title, LIMITS.unitTitle) || id });
      } else if (title && book.units[unitIdx[id]].title === id) {
        book.units[unitIdx[id]].title = str(title, LIMITS.unitTitle);
      }
      return id;
    }
    if (raw.units != null) {
      if (!Array.isArray(raw.units)) C.err('units', 'units 는 배열이어야 해요.');
      else raw.units.forEach(function (u, i) {
        if (typeof u === 'string') addUnit(u, u, 'units[' + i + ']');
        else if (isObj(u)) { if (!str(u.id)) C.err('units[' + i + ']', '단원 id 가 없어요.'); else addUnit(u.id, u.title, 'units[' + i + ']'); }
        else C.err('units[' + i + ']', '단원은 문자열 또는 {id, title} 이어야 해요.');
      });
    }
    var declaredUnits = book.units.length;

    /* 낱말 */
    var words = Array.isArray(raw.words) ? raw.words : (raw.words == null ? [] : null);
    if (words === null) { C.err('words', 'words 는 배열이어야 해요.'); words = []; }
    if (words.length > LIMITS.words) C.err('words', '낱말이 ' + LIMITS.words + '개를 넘어요 (' + words.length + ') — 권을 나누세요.');
    var seenWord = {}, seenId = {};
    words.slice(0, LIMITS.words).forEach(function (w, i) {
      var where = 'words[' + (i + 1) + ']';
      if (!isObj(w)) { C.err(where, '낱말은 객체여야 해요.'); return; }
      var word = str(w.word), meaning = str(w.meaning);
      if (!word) { C.err(where, '낱말(word)이 없어요.'); return; }
      where = 'words[' + (i + 1) + '] ' + word;
      if (word.length > LIMITS.word) { C.err(where, '낱말이 ' + LIMITS.word + '자를 넘어요.'); return; }
      if (ENGLISH_WORD.test(word)) { C.err(where, '영어 낱말은 이 앱에 넣지 않아요 — 워드브레인(/vocab/)에 배정하세요.'); return; }
      if (!meaning) { C.err(where, '뜻(meaning)이 없어요.'); return; }
      if (meaning.length > LIMITS.meaning) { C.err(where, '뜻이 ' + LIMITS.meaning + '자를 넘어요.'); return; }

      var parts = null;
      if (Array.isArray(w.parts) && w.parts.length) {
        parts = [];
        var badPart = false;
        w.parts.forEach(function (p, k) {
          if (!isObj(p) || !isHanjaChar(str(p.ch))) { C.err(where, 'parts[' + k + '] 의 ch 는 한자 한 글자여야 해요.'); badPart = true; return; }
          parts.push({ ch: str(p.ch), hun: str(p.hun, LIMITS.hun), eum: str(p.eum, LIMITS.eum) });
        });
        if (badPart) return;
      } else if (w.hanja) {
        parts = parseHanjaSpec(w.hanja);
        if (!parts) { C.err(where, 'hanja 에 한자가 없어요: "' + str(w.hanja, 30) + '"'); return; }
      }
      var type = parts ? 'hanja' : 'native';
      if (w.type === 'hanja' && !parts) C.warn(where, 'type 이 hanja 인데 한자가 없어 고유어로 둔다.');
      if (w.type && w.type !== 'hanja' && w.type !== 'native') C.warn(where, 'type 은 hanja/native — "' + str(w.type, 12) + '" 는 무시');

      var hanja = parts ? parts.map(function (p) { return p.ch; }).join('') : '';
      var key = word + '|' + hanja;
      if (seenWord[key]) { C.warn(where, '같은 낱말이 다시 나와 앞의 것만 남긴다' + (hanja ? ' (' + hanja + ')' : '')); return; }
      seenWord[key] = true;

      /* id 는 내용(낱말|한자)에서 만든다. 순번(w001…)으로 매기면 낱말 하나를 중간에 끼워 다시 올렸을 때
         뒤의 id 가 전부 밀려, 학생의 기억 기록(w:<단어장>:<id>)이 다른 낱말을 가리키게 된다 — 조용히 틀어지는 종류다. */
      var id = str(w.id, LIMITS.itemId) || contentId(word, hanja);
      if (seenId[id]) { C.err(where, 'id "' + id + '" 가 겹쳐요.'); return; }
      seenId[id] = true;

      var unit = addUnit(w.unit, null, where);
      var out = { id: id, unit: unit, word: word, type: type, meaning: meaning };
      if (parts) {
        out.hanja = hanja; out.parts = parts;
        var missing = parts.filter(function (p) { return !p.hun || !p.eum; });
        if (missing.length) C.warn(where, '훈음이 빈 한자(' + missing.map(function (p) { return p.ch; }).join('') + ') — 한자 조립 문제에서 빠진다');
        else out.literal = str(w.literal, LIMITS.meaning) || parts.map(function (p) { return p.hun; }).join(' · ');
      }
      var example = str(w.example, LIMITS.example);
      if (example) {
        out.example = example;
        if (!exampleHasWord(example, word)) C.warn(where, '예문에 낱말이 안 보여 빈칸 문제에서 빠진다: "' + example.slice(0, 30) + '"');
      }
      if (Array.isArray(w.syn) && w.syn.length) {
        out.syn = w.syn.map(function (s) { return str(s, LIMITS.synLen); }).filter(Boolean).slice(0, LIMITS.syn);
      }
      if (w.scene) out.scene = str(w.scene, LIMITS.scene);   /* 연상 장면 — 고유어는 그림 한 장이 뜻을 붙든다 */
      book.words.push(out);
    });

    /* 한자 — 직접 적은 것 */
    var chars = Array.isArray(raw.chars) ? raw.chars : (raw.chars == null ? [] : null);
    if (chars === null) { C.err('chars', 'chars 는 배열이어야 해요.'); chars = []; }
    if (chars.length > LIMITS.chars) C.err('chars', '한자가 ' + LIMITS.chars + '자를 넘어요 (' + chars.length + ').');
    var charIdx = {};
    chars.slice(0, LIMITS.chars).forEach(function (c, i) {
      var where = 'chars[' + (i + 1) + ']';
      if (!isObj(c)) { C.err(where, '한자 항목은 객체여야 해요.'); return; }
      var ch = str(c.ch);
      if (!isHanjaChar(ch)) { C.err(where, 'ch 는 한자 한 글자여야 해요: "' + ch.slice(0, 6) + '"'); return; }
      where = 'chars[' + (i + 1) + '] ' + ch;
      if (charIdx[ch] != null) { C.warn(where, '같은 한자가 다시 나와 앞의 것만 남긴다'); return; }
      var hun = str(c.hun, LIMITS.hun), eum = str(c.eum, LIMITS.eum);
      if (!hun || !eum) { C.err(where, '훈(hun)·음(eum)이 있어야 해요 — 예: 볼 / 관'); return; }
      var out = { ch: ch, hun: hun, eum: eum, unit: addUnit(c.unit, null, where), words: [] };
      if (c.strokes != null && c.strokes !== '') {
        var n = Number(c.strokes);
        if (!(Number.isInteger(n) && n >= 1 && n <= LIMITS.strokes)) { C.err(where, '획수(strokes)는 1~' + LIMITS.strokes + ' 정수여야 해요.'); return; }
        out.strokes = n;
      }
      if (c.medians != null) {
        var med = checkMedians(c.medians, where, C);
        if (!med) return;
        if (out.strokes != null && med.length !== out.strokes) { C.err(where, '획순 데이터가 ' + med.length + '획인데 획수는 ' + out.strokes + '획이에요.'); return; }
        out.medians = med;
        if (out.strokes == null) out.strokes = med.length;
      }
      /* 낱말에서 끌어낸 글자 표시는 그대로 물고 간다 — 검사는 저장된 단어장에도 다시 도는데(앱이 열 때마다),
         여기서 지우면 참고 글자가 단원의 제 항목으로 올라선다: 단원 문항 수가 부풀고 서버 진도표와 어긋난다. */
      if (c.derived) out.derived = true;
      if (c.note) out.note = str(c.note, LIMITS.note);
      /* 이 글자를 쓰는 낱말 — 한자 급수 교재는 글자마다 낱말 몇 개를 예로 든다(一 → 일등·일주·일생·일주일).
         교재에 그 낱말의 뜻이 없으면 낱말 항목으로는 못 넣으니, 글자 카드의 참고 목록으로만 받는다.
         낱말에서 끌어낸 글자의 words 와 같은 칸을 쓴다 — 화면은 한 줄로 그린다. */
      if (c.words != null) {
        var cw = Array.isArray(c.words) ? c.words : String(c.words).split(/[,·]/);
        cw = cw.map(function (x) { return str(x, LIMITS.word); }).filter(function (x, k, arr) { return x && arr.indexOf(x) === k; });
        var badCw = cw.filter(function (x) { return ENGLISH_WORD.test(x); });
        if (badCw.length) { C.err(where, '낱말 목록(words)에 영어가 있어요: "' + badCw[0] + '"'); return; }
        out.words = cw.slice(0, LIMITS.charWords);
        if (cw.length > LIMITS.charWords) C.warn(where, '낱말 목록이 ' + LIMITS.charWords + '개를 넘어 뒤를 버린다 (' + cw.length + ')');
      }
      /* 부수·닮은 글자 — 오답 보기가 진짜 헷갈리는 짝(日/目, 土/士)을 겨냥하게 하는 실마리 */
      if (c.radical != null && c.radical !== '') {
        var rad = str(c.radical);
        if (!isHanjaChar(rad)) { C.err(where, '부수(radical)는 한자 한 글자여야 해요: "' + rad.slice(0, 6) + '"'); return; }
        out.radical = rad;
      }
      if (c.similar != null) {
        var sim = Array.isArray(c.similar) ? c.similar.map(function (x) { return str(x); }) : hanjaOf(c.similar);
        var badSim = sim.filter(function (x) { return !isHanjaChar(x); });
        if (badSim.length) { C.err(where, '닮은 글자(similar)는 한자 한 글자씩이어야 해요: "' + badSim[0].slice(0, 6) + '"'); return; }
        sim = sim.filter(function (x, k) { return x !== ch && sim.indexOf(x) === k; }).slice(0, LIMITS.similar);
        if (sim.length) out.similar = sim;
      }
      charIdx[ch] = book.chars.length;
      book.chars.push(out);
    });

    /* 한자 — 낱말의 분해에서 끌어낸 것. 직접 적은 글자는 훈음이 비어 있어도 채워 준다. */
    book.words.forEach(function (w) {
      (w.parts || []).forEach(function (p) {
        var k = charIdx[p.ch];
        if (k == null) {
          if (book.chars.length >= LIMITS.chars) return;
          charIdx[p.ch] = book.chars.length;
          book.chars.push({ ch: p.ch, hun: p.hun, eum: p.eum, unit: w.unit, words: [], derived: true });
          k = charIdx[p.ch];
        }
        var c = book.chars[k];
        if (c.derived) {
          if (!c.hun && p.hun) c.hun = p.hun;
          if (!c.eum && p.eum) c.eum = p.eum;
        } else if (!p.hun && !p.eum) {
          /* 낱말 쪽 훈음이 비었으면 글자 쪽 것을 물려준다 — 화면이 「觀( )」로 비지 않게 */
          p.hun = c.hun; p.eum = c.eum;
        }
        if (c.words.indexOf(w.word) < 0 && c.words.length < 12) c.words.push(w.word);
      });
    });
    book.words.forEach(function (w) {
      if (w.parts && !w.literal && w.parts.every(function (p) { return p.hun; })) w.literal = w.parts.map(function (p) { return p.hun; }).join(' · ');
    });
    /* 획수 표 — {"觀": 25, …}. 낱말에서 끌어낸 글자에도 획수를 붙일 수 있다(한자어 교재에는 글자 항목이 따로 없다).
       직접 적은 글자의 획수가 있으면 그것이 이긴다. */
    if (raw.strokes != null) {
      if (!isObj(raw.strokes)) C.err('strokes', 'strokes 는 {"한자": 획수} 표여야 해요.');
      else Object.keys(raw.strokes).forEach(function (ch) {
        var n = Number(raw.strokes[ch]);
        if (!isHanjaChar(ch)) { C.err('strokes', '"' + str(ch, 6) + '" 는 한자 한 글자가 아니에요.'); return; }
        if (!(Number.isInteger(n) && n >= 1 && n <= LIMITS.strokes)) { C.err('strokes', ch + ' 의 획수는 1~' + LIMITS.strokes + ' 정수여야 해요.'); return; }
        var k = charIdx[ch];
        if (k == null) { C.warn('strokes', ch + ' 은 이 단어장에 없는 글자라 획수를 버린다'); return; }
        if (book.chars[k].strokes == null) book.chars[k].strokes = n;
      });
    }
    var noGloss = book.chars.filter(function (c) { return c.derived && (!c.hun || !c.eum); });
    if (noGloss.length) C.warn('chars', '훈음 없는 한자 ' + noGloss.length + '자(' + noGloss.slice(0, 8).map(function (c) { return c.ch; }).join('') + (noGloss.length > 8 ? '…' : '') + ') — 훈음 문제에서 빠지고 따라쓰기만 된다');

    if (!book.words.length && !book.chars.length) C.err('book', '낱말도 한자도 없어요 — 최소 하나는 있어야 해요.');
    if (declaredUnits && book.units.length > declaredUnits)
      C.warn('units', 'units 에 없는 단원을 낱말이 가리켜 뒤에 붙였다: ' + book.units.slice(declaredUnits).map(function (u) { return u.id; }).join(', '));

    var counts = countsOf(book);
    var summary = [
      '낱말 ' + counts.words + '개 (한자어 ' + counts.hanja + ' · 고유어 ' + counts.native + ')',
      '한자 ' + counts.chars + '자 (직접 ' + (counts.chars - counts.derived) + ' · 낱말에서 ' + counts.derived + ' · 획수 있음 ' + counts.strokes + ' · 획순 데이터 ' + counts.medians + ')',
      '단원 ' + counts.units + '개' + (counts.unitless ? ' (단원 없는 항목 ' + counts.unitless + ')' : ''),
    ];
    var ok = !C.errors.length;
    return { ok: ok, errors: C.errors, warns: C.warns, summary: summary, book: ok ? book : null, counts: counts };
  }

  /* 획순 데이터 — [[ [x,y], [x,y], … ], …] 0~1 좌표. 한 획은 점 2개 이상. */
  function checkMedians(m, where, C) {
    if (!Array.isArray(m) || !m.length) { C.err(where, 'medians 는 획 배열이어야 해요.'); return null; }
    if (m.length > LIMITS.medianStrokes) { C.err(where, '획순 데이터가 ' + LIMITS.medianStrokes + '획을 넘어요.'); return null; }
    var out = [];
    for (var s = 0; s < m.length; s++) {
      var st = m[s];
      if (!Array.isArray(st) || st.length < 2) { C.err(where, (s + 1) + '번째 획은 점이 2개 이상이어야 해요.'); return null; }
      if (st.length > LIMITS.medianPts) { C.err(where, (s + 1) + '번째 획의 점이 ' + LIMITS.medianPts + '개를 넘어요.'); return null; }
      var pts = [];
      for (var i = 0; i < st.length; i++) {
        var p = st[i];
        var x = Array.isArray(p) ? Number(p[0]) : (isObj(p) ? Number(p.x) : NaN);
        var y = Array.isArray(p) ? Number(p[1]) : (isObj(p) ? Number(p.y) : NaN);
        if (!isFinite(x) || !isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) { C.err(where, (s + 1) + '번째 획의 점 ' + (i + 1) + '이 0~1 좌표가 아니에요.'); return null; }
        pts.push([Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
      }
      out.push(pts);
    }
    return out;
  }

  function countsOf(book) {
    var c = { words: book.words.length, hanja: 0, native: 0, chars: book.chars.length, derived: 0, strokes: 0, medians: 0, units: book.units.length, unitless: 0 };
    book.words.forEach(function (w) { if (w.type === 'hanja') c.hanja += 1; else c.native += 1; if (!w.unit) c.unitless += 1; });
    book.chars.forEach(function (ch) { if (ch.derived) c.derived += 1; if (ch.strokes) c.strokes += 1; if (ch.medians) c.medians += 1; if (!ch.unit) c.unitless += 1; });
    return c;
  }

  /* 목록용 메타 — 본문 없이. 학생 목록·관리 목록이 같은 모양을 쓴다. */
  function bookMeta(book) {
    var counts = countsOf(book);
    var per = {};
    book.units.forEach(function (u) { per[u.id] = { id: u.id, title: u.title, words: 0, chars: 0 }; });
    book.words.forEach(function (w) { if (per[w.unit]) per[w.unit].words += 1; });
    book.chars.forEach(function (c) { if (per[c.unit]) per[c.unit].chars += 1; });
    return {
      id: book.id, title: book.title, publisher: book.publisher || '', level: book.level || '', note: book.note || '', source: book.source || 'textbook',
      counts: counts, units: book.units.map(function (u) { return per[u.id]; }),
    };
  }

  /* ── 붙여넣기 텍스트 → 단어장 ──
     한 줄 = 낱말 | 뜻 | 한자(선택) | 예문(선택)      구분자는 | 또는 탭 (없으면 쉼표)
             觀 | 볼 관 | 25                       첫 칸이 한자 한 글자면 한자 항목(훈음 · 획수)
             # 1일차                               새 단원 — 아래 줄들이 그 단원에 든다
     워드브레인 배정과 같은 표기라 강사가 형식을 하나만 익히면 된다. */
  function parseBookText(text, meta) {
    meta = meta || {};
    var raw = { id: meta.id, title: meta.title, publisher: meta.publisher, level: meta.level, note: meta.note, source: meta.source, units: [], words: [], chars: [] };
    var lineErrors = [];
    var unit = '', unitN = 0, unitIds = {};
    String(text || '').split(/\r?\n/).forEach(function (line0, i) {
      var line = line0.trim();
      if (!line) return;
      if (line.charAt(0) === '#') {
        var title = line.replace(/^#+\s*/, '').trim();
        if (!title) return;
        unitN += 1;
        /* 단원 id 도 제목에서 — 순번(u01)이면 단원을 하나 끼워 다시 올릴 때 학생이 고른 단원·강사 지정이 밀린다 */
        var uid = title.slice(0, LIMITS.unit), base = uid, dup = 1;
        while (unitIds[uid]) { dup += 1; uid = (base.slice(0, LIMITS.unit - 4) + ' (' + dup + ')'); }
        unitIds[uid] = true;
        unit = uid;
        raw.units.push({ id: uid, title: title });
        return;
      }
      var sep = /[|\t]/.test(line) ? /\s*[|\t]\s*/ : /\s*,\s*/;
      var cols = line.split(sep).map(function (c) { return c.trim(); });
      var first = cols[0];
      if (!first) return;
      if (isHanjaChar(first)) {
        /* 한자 한 글자: 觀 | 볼 관 | 25 */
        var gloss = cols[1] || '', sp = gloss.lastIndexOf(' ');
        if (!gloss || sp < 0) { lineErrors.push((i + 1) + '행: 한자 「' + first + '」의 훈음은 "볼 관"처럼 훈과 음을 띄어 적어요'); return; }
        var c = { ch: first, hun: gloss.slice(0, sp), eum: gloss.slice(sp + 1), unit: unit };
        if (cols[2] && /^\d+$/.test(cols[2])) c.strokes = Number(cols[2]);
        else if (cols[2]) lineErrors.push((i + 1) + '행: 획수는 숫자로 적어요 — "' + cols[2].slice(0, 10) + '"');
        if (cols[3]) c.radical = cols[3];                 /* 4열 부수 */
        if (cols[4]) c.similar = hanjaOf(cols[4]);        /* 5열 닮은 글자들 (붙여 적는다: 日目) */
        raw.chars.push(c);
        return;
      }
      var word = first, meaning = cols[1] || '';
      if (!meaning) { lineErrors.push((i + 1) + '행: 뜻이 없어요 — "' + line.slice(0, 24) + '"'); return; }
      var rest = cols.slice(2).filter(Boolean);
      var hanjaCol = '', example = '', syn = null, scene = '';
      rest.forEach(function (col) {
        var m;
        if ((m = col.match(/^(?:유의어|비슷한\s*말)\s*[:：]\s*(.+)$/))) { syn = m[1].split(/[,、·]/).map(function (x) { return x.trim(); }).filter(Boolean); return; }
        if ((m = col.match(/^(?:연상|장면)\s*[:：]\s*(.+)$/))) { scene = m[1].trim(); return; }
        if (!hanjaCol && HANJA_ANY.test(col)) hanjaCol = col; else if (!example) example = col;
      });
      var w = { word: word, meaning: meaning, unit: unit };
      if (hanjaCol) w.hanja = hanjaCol;
      if (example) w.example = example;
      if (syn && syn.length) w.syn = syn;
      if (scene) w.scene = scene;
      raw.words.push(w);
    });
    var res = checkBook(raw);
    lineErrors.forEach(function (m) { res.errors.unshift({ where: 'text', message: m }); });
    if (lineErrors.length) { res.ok = false; res.book = null; }
    return res;
  }

  /* AI 연상을 만들어도 되는 단어장인가 — 자체 단어장만. 화면(버튼)과 호출 직전이 같은 판정을 쓴다 */
  function aiAllowed(book) { return !!(book && book.source === 'own'); }

  return {
    ID_RE: ID_RE, LIMITS: LIMITS, LEVELS: LEVELS, SOURCES: SOURCES, aiAllowed: aiAllowed,
    isHanjaChar: isHanjaChar, hanjaOf: hanjaOf, parseHanjaSpec: parseHanjaSpec, findInExample: findInExample, exampleHasWord: exampleHasWord,
    checkBook: checkBook, checkMedians: checkMedians, countsOf: countsOf, bookMeta: bookMeta, parseBookText: parseBookText,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBBOOKCHECK;
