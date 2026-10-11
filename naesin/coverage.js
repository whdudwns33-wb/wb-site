'use strict';
/* 내신브레인 — 팩 커버리지(교과서·학년 단위). 관리 웹의 커버리지 카드가 쓰는 순수 로직.
 *
 * 왜 있는가: 지금 커버리지는 "시험에 등록된 packIds" 만 본다(naesin-admin.html 의 needOf).
 * 그래서 원장이 자료를 어느 순서로 모아야 하는지 화면이 답하지 못한다 — 재원생이 실제로 쓰는
 * 교과서와 보유한 팩을 맞춰 본 적이 없기 때문이다.
 *
 * 무엇을 하지 않는가 — 이것이 설계의 핵심이다:
 *  · **'과'를 단정하지 않는다.** 어느 과를 시험 범위로 낼지는 학교가 정한다. 과 단위 판정은
 *    기존 두 경고(시험 packIds ↔ 보유 팩)가 계속 담당하고, 여기는 교과서·학년 조합만 본다.
 *  · **학교를 기록하지 않는다.** 학교명은 개인정보 성격이 있고(절대 규칙 1), desk 자료원장이
 *    이미 학교↔교과서↔학년↔과를 '구매 범위'로 들고 있다. 같은 이름의 다른 사실을 두 곳에
 *    두면 갈라진다. 그래서 학교를 거치지 않고 **학생 → 교과서 코드** 한 칸만 둔다.
 *    전학·학교별 교과서 변경도 학생 단위로 흡수된다.
 *  · **교과서 코드 목록과 대조하지 않는다.** 목록을 복제하면 desk 와 갈라진다(visang/bisang
 *    드리프트가 그 사고였다). 대신 오타는 "학생 N명인데 팩 0개" 로 화면에 드러나게 한다.
 *
 * 모르는 것은 경고하지 않고 '보류'로 센다 — 거짓 경고가 한 번 나오면 원장이 이 카드를 안 믿는다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBNaesinCoverage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /* 학년 라벨 → packId 의 학년 토큰. 명부는 '중2'·'중 2'·'2' 처럼 들어온다. */
  var GRADE_TOKEN = { '중1': 'm1', '중2': 'm2', '중3': 'm3', '고1': 'h1', '고2': 'h2', '고3': 'h3' };
  function gradeToken(label) {
    var s = String(label == null ? '' : label).replace(/\s+/g, '');
    if (/^[mh][123]$/.test(s)) return s;
    if (GRADE_TOKEN[s]) return GRADE_TOKEN[s];
    var m = s.match(/^(중|고)?([123])$/);
    if (m) return (m[1] === '고' ? 'h' : 'm') + m[2];
    return '';
  }

  /* packId 를 조각으로. desk 의 parsePackId 와 같은 문법이지만 **코드표를 쓰지 않는다** —
     아는 교과서인지 묻지 않고 모양만 읽는다. 그래야 교과서가 새로 생겨도 이 파일을 안 고친다.
     문법: <개정4자리>-<출판사저자>-<학년>-<과토큰>  (과토큰은 L숫자 | SL·SR[숫자]) */
  var PACK_RE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)-(m[123]|h[123])-(L\d{1,2}|S[LR]\d?)$/;
  function splitPackId(id) {
    var m = String(id == null ? '' : id).trim().match(PACK_RE);
    if (!m) return null;
    return { packId: m[0], revision: m[1], book: m[2], grade: m[3], unit: m[4] };
  }

  function str(v) { return v == null ? '' : String(v).trim(); }
  function arr(v) { return Array.isArray(v) ? v : []; }

  /* 학생에게 실제로 걸린 배정 — 서버 규약과 같은 순서다(개별 scope 가 살아 있으면 그것, 아니면 반 공통).
     exams 는 관리 화면이 이미 들고 있는 배열이고 각 항목에 scope·packIds·expired 가 있다. */
  function examFor(exams, code) {
    var mine = null, def = null;
    arr(exams).forEach(function (ex) {
      if (!ex) return;
      if (str(ex.scope) === str(code)) mine = ex;
      else if (str(ex.scope) === 'default') def = ex;
    });
    if (mine && !mine.expired) return mine;
    if (def && !def.expired) return def;
    return null;
  }

  /* (교과서, 학년) 조합별 집계. books 는 { 학생코드: 교과서코드 } 한 칸짜리 지정표다. */
  function combos(roster, books, packs) {
    var have = {};
    arr(packs).forEach(function (id) {
      var p = splitPackId(id);
      if (!p) return;
      var k = p.book + '|' + p.grade;
      (have[k] = have[k] || []).push(p.packId);
    });
    var rows = {}, unset = [];
    arr(roster).forEach(function (s) {
      if (!s) return;
      var code = str(s.code);
      var book = str((books || {})[code]);
      var g = gradeToken(s.grade);
      if (!book || !g) { unset.push({ code: code, name: str(s.name), why: !book ? 'no-book' : 'no-grade' }); return; }
      var k = book + '|' + g;
      var r = rows[k] || (rows[k] = { book: book, grade: g, students: [], packIds: have[k] || [] });
      r.students.push({ code: code, name: str(s.name), cls: str(s.cls) });
    });
    return {
      rows: Object.keys(rows).map(function (k) { return rows[k]; })
        /* 학생이 많은 조합부터 — 그게 먼저 만들 팩이다. 같으면 학년·교과서 순으로 안정 정렬. */
        .sort(function (a, b) {
          return (b.students.length - a.students.length)
            || a.grade.localeCompare(b.grade) || a.book.localeCompare(b.book);
        }),
      unset: unset,
    };
  }

  /* 배정된 팩이 그 학생의 교과서·학년과 어긋나는가. 교과서 지정이 없으면 판정하지 않는다. */
  function mismatches(roster, books, exams) {
    var out = [];
    arr(roster).forEach(function (s) {
      if (!s) return;
      var code = str(s.code);
      var book = str((books || {})[code]);
      var g = gradeToken(s.grade);
      if (!book) return;                      /* 모르면 경고하지 않는다 */
      var ex = examFor(exams, code);
      if (!ex) return;
      var bad = [];
      arr(ex.packIds).forEach(function (id) {
        var p = splitPackId(id);
        if (!p) return;                        /* 문법이 아니면 여기서 판정할 일이 아니다 */
        if (p.book !== book) bad.push({ packId: p.packId, kind: 'book', got: p.book, want: book });
        else if (g && p.grade !== g) bad.push({ packId: p.packId, kind: 'grade', got: p.grade, want: g });
      });
      if (bad.length) out.push({ code: code, name: str(s.name), cls: str(s.cls), scope: str(ex.scope), bad: bad });
    });
    return out;
  }

  /* 먼저 만들 드라이브 폴더 이름 — docs/자료-폴더-표준.md 의 팩 id 가 곧 폴더 이름이다.
     과는 모르므로 접두사까지만 준다(원장이 과 번호만 붙이면 된다). 개정은 학년에서 유도한다. */
  var REVISION = { m1: '2022', m2: '2022', m3: '2015', h1: '', h2: '', h3: '' };
  function folderPrefix(book, grade) {
    var rev = REVISION[grade];
    return rev ? rev + '-' + book + '-' + grade + '-' : '';
  }

  function report(input) {
    var o = input || {};
    var c = combos(o.roster, o.books, o.packs);
    return {
      combos: c.rows.map(function (r) {
        return {
          book: r.book, grade: r.grade,
          students: r.students.length, names: r.students,
          packIds: r.packIds, packs: r.packIds.length,
          folderPrefix: folderPrefix(r.book, r.grade),
          /* 학생이 있는데 팩이 하나도 없는 조합 — 이것이 '먼저 만들 것'이다 */
          empty: r.packIds.length === 0,
        };
      }),
      unset: c.unset,
      mismatches: mismatches(o.roster, o.books, o.exams),
    };
  }

  return {
    GRADE_TOKEN: GRADE_TOKEN, PACK_RE: PACK_RE, REVISION: REVISION,
    gradeToken: gradeToken, splitPackId: splitPackId, examFor: examFor,
    combos: combos, mismatches: mismatches, folderPrefix: folderPrefix, report: report,
  };
});
