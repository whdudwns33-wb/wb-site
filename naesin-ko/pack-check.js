'use strict';
/* WB 국어브레인 — 팩 검증 규칙 (순수 모듈, Node CLI·관리 웹 공용)
   기획서 §7[3] 검수 게이트의 '자동 검증' 단계이자, 팩 스키마의 실행 가능한 정의다.
   pack-schema.md는 요약이고 **이 파일이 정본**이다.

   영어 앱은 검증기(Node)와 관리 웹이 규칙을 두 벌로 갖고 있어 어긋날 위험이 있었다.
   국어는 규칙을 이 순수 모듈 하나에 두고 양쪽이 같은 파일을 부른다.

   판정 이원화: errors = 배포 차단 / warns = 검수 화면에서 사람이 확인. */
var WBKOCHECK = (function () {
  var PACK_ID_RE = /^[A-Za-z0-9-]{3,60}$/;
  var KINDS = ['poem', 'novel', 'nonfiction', 'grammar', 'speech', 'media', 'handout'];
  var COND_KINDS = ['include', 'sentences', 'chars', 'words', 'form', 'quote'];
  var ITEM_FORMATS = ['mc5', 'essay', 'ox', 'matching', 'cloze', 'choice_dialog'];

  function nonEmpty(s) { return typeof s === 'string' && s.trim().length > 0; }

  function checkPack(pack, opts) {
    opts = opts || {};
    var errors = [], warns = [], summary = [];
    var err = function (m) { errors.push(m); };
    var warn = function (m) { warns.push(m); };

    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
      return { ok: false, errors: ['팩이 객체가 아니에요.'], warns: [], summary: [] };
    }

    /* ── 팩 루트 ── */
    if (!PACK_ID_RE.test(String(pack.packId || ''))) err('packId는 영문/숫자/하이픈 3~60자여야 해요.');
    if (!nonEmpty(pack.revision)) warn('revision(개정 연도)이 비었어요 — 자료에 인쇄돼 있지 않으니 업로드 때 넣어야 해요(§2.2-7).');
    if (!nonEmpty(pack.publisher)) warn('publisher(출판사·저자)가 비었어요.');
    if (!nonEmpty(pack.grade)) warn('grade(학년)가 비었어요.');
    if (!nonEmpty(pack.unit)) warn('unit(대단원)이 비었어요.');
    if (!pack.source || !nonEmpty(pack.source.provider)) {
      warn('source.provider가 비었어요 — 화면 출처 고지(§10-8)가 이 값을 씁니다.');
    }

    var works = pack.works || [];
    var sets = pack.sets || [];
    var items = pack.items || [];
    if (!works.length && !items.length) err('works·items가 모두 비었어요.');

    /* ── counts 선언 대 실제 ── */
    var actual = {
      works: works.length, sets: sets.length, items: items.length,
      blanks: works.reduce(function (a, w) { return a + ((w.blanks || []).length); }, 0),
      vocab: works.reduce(function (a, w) { return a + ((w.vocab || []).length); }, 0)
    };
    if (pack.counts && typeof pack.counts === 'object') {
      Object.keys(pack.counts).forEach(function (k) {
        if (actual[k] != null && pack.counts[k] !== actual[k]) {
          err('counts.' + k + ' 불일치 — 선언 ' + pack.counts[k] + ', 실제 ' + actual[k]);
        }
      });
    } else {
      warn('counts가 없어요 — 추출 누락을 잡는 첫 방어선입니다.');
    }

    /* ── works ── */
    var workIds = {}, blankIds = {}, conceptRefs = {};
    var canonIds = {};
    works.forEach(function (w, i) {
      var at = 'works[' + i + '](' + (w.title || '?') + ')';
      if (!nonEmpty(w.workId)) err(at + ' workId 없음');
      else if (workIds[w.workId]) err(at + ' workId 중복: ' + w.workId);
      else workIds[w.workId] = w;
      if (!nonEmpty(w.title)) err(at + ' title 없음');
      if (!nonEmpty(w.author)) warn(at + ' author 없음 — 자료에 작가명이 없을 수 있어요(§2.2-7). 화면 원작자 표기에 필요합니다.');
      if (w.kind && KINDS.indexOf(w.kind) < 0) err(at + ' 알 수 없는 kind: ' + w.kind);
      if (w.hasCanon) canonIds[w.workId] = true;

      /* 정본 보유 작품은 개념 단위(빈칸)가 있어야 학습 루프가 돈다 */
      if (w.hasCanon && !(w.blanks || []).length) {
        err(at + ' hasCanon인데 blanks가 없어요 — 개념 단위가 없으면 2·4단계가 성립하지 않아요.');
      }
      if (!w.hasCanon && (w.blanks || []).length) {
        warn(at + ' hasCanon=false인데 blanks가 있어요 — 정본 보유로 표시해야 하지 않나요?');
      }

      /* 빈칸 = 개념 단위 = MasteryState 키(§8) */
      var seenAnswer = {};
      (w.blanks || []).forEach(function (b, k) {
        var bat = at + '.blanks[' + k + ']';
        if (!nonEmpty(b.id)) err(bat + ' id 없음');
        else if (blankIds[b.id]) err(bat + ' 빈칸 id 중복: ' + b.id);
        else blankIds[b.id] = true;
        var ans = b.answers || [];
        if (!ans.length || !ans.every(nonEmpty)) err(bat + '(' + (b.id || '?') + ') answers가 비었어요.');
        if (!nonEmpty(b.text)) warn(bat + ' text(문맥)가 없어요 — 학생이 무엇을 채우는지 알 수 없어요.');
        /* 이해완성·요약노트가 같은 핵심어를 두 번 뚫는다 — 하나로 병합해야 한다(§2.2-2) */
        var sig = (b.path || '') + '|' + ans.join('/');
        if (seenAnswer[sig]) warn(bat + ' 같은 핵심어 빈칸이 중복이에요(병합 대상): ' + ans.join('/'));
        seenAnswer[sig] = true;
      });

      var kwIds = {};
      (w.keywords || []).forEach(function (kw, k) {
        var kat = at + '.keywords[' + k + ']';
        if (!nonEmpty(kw.id)) err(kat + ' id 없음');
        else if (kwIds[kw.id]) err(kat + ' id 중복: ' + kw.id);
        else kwIds[kw.id] = true;
        if (!nonEmpty(kw.word)) err(kat + ' word 없음');
        if (!nonEmpty(kw.meaning)) warn(kat + '(' + (kw.word || '?') + ') meaning이 없어요 — 시어 의미 문항이 안 만들어져요.');
        if (kw.polarity && ['긍정', '부정', '중립'].indexOf(kw.polarity) < 0) {
          warn(kat + ' polarity는 긍정/부정/중립 중 하나여야 해요: ' + kw.polarity);
        }
      });

      var rhIds = {};
      (w.rhetoric || []).forEach(function (r, k) {
        var rat = at + '.rhetoric[' + k + ']';
        if (!nonEmpty(r.id)) err(rat + ' id 없음');
        else if (rhIds[r.id]) err(rat + ' id 중복: ' + r.id);
        else rhIds[r.id] = true;
        if (!nonEmpty(r.name)) err(rat + ' name(표현법) 없음');
        if (!nonEmpty(r.quote)) err(rat + '(' + (r.name || '?') + ') quote(근거 구절) 없음 — 구절 적용 문항의 원천이에요.');
        if (nonEmpty(r.conceptId)) conceptRefs[r.conceptId] = true;
        else warn(rat + ' conceptId가 없어요 — 혼동 쌍 오답 생성이 사전 순으로 내려가요(§4.3).');
      });

      var vIds = {};
      (w.vocab || []).forEach(function (v, k) {
        var vat = at + '.vocab[' + k + ']';
        if (!nonEmpty(v.id)) err(vat + ' id 없음');
        else if (vIds[v.id]) err(vat + ' id 중복: ' + v.id);
        else vIds[v.id] = true;
        if (!nonEmpty(v.term)) err(vat + ' term 없음');
        if (!nonEmpty(v.definition)) err(vat + '(' + (v.term || '?') + ') definition 없음');
        if (nonEmpty(v.conceptId)) conceptRefs[v.conceptId] = true;
      });

      /* 지문 기호 앵커는 본문 안에 실제로 있어야 한다 — 밑줄이 추출에서 소실되므로
         앵커 텍스트를 따로 저장했는데(§2.2-7), 본문과 어긋나면 하이라이트가 깨진다. */
      var flat = '';
      if (w.text && w.text.stanzas) {
        w.text.stanzas.forEach(function (st) { flat += (st.lines || []).join('\n') + '\n'; });
      } else if (w.text && w.text.paragraphs) {
        flat += (w.text.paragraphs || []).join('\n');
      }
      if (flat) {
        (w.marks || []).forEach(function (m, k) {
          if (!nonEmpty(m.anchorText)) { warn(at + '.marks[' + k + '] anchorText 없음'); return; }
          if (flat.indexOf(m.anchorText) < 0) {
            err(at + '.marks[' + k + '](' + m.symbol + ') anchorText가 본문에 없어요: ' + m.anchorText.slice(0, 20));
          }
        });
      } else if ((w.marks || []).length) {
        warn(at + ' 본문(text) 없이 marks만 있어요 — 원문 미표시 설계(§10-2 ③)라면 정상이에요.');
      }
    });

    /* ── 지문 세트 ── */
    var setIds = {};
    sets.forEach(function (s, i) {
      var at = 'sets[' + i + ']';
      if (!nonEmpty(s.setId)) err(at + ' setId 없음');
      else if (setIds[s.setId]) err(at + ' setId 중복: ' + s.setId);
      else setIds[s.setId] = true;
      var ws = s.works || [];
      if (!ws.length) err(at + ' works가 비었어요.');
      ws.forEach(function (ref, k) {
        var rat = at + '.works[' + k + ']';
        if (!workIds[ref.workId]) err(rat + ' 없는 workId 참조: ' + ref.workId);
        /* 발췌 세트는 자기 본문을 가져야 한다 — 소설은 전문이 자료에 없다(§2.2-5) */
        if (ref.kind === 'excerpt' && !(ref.text && (ref.text.paragraphs || ref.text.stanzas))) {
          err(rat + ' 발췌 세트인데 text가 없어요 (전문에서 슬라이스할 수 없어요).');
        }
      });
      (s.marks || []).forEach(function (m, k) {
        if (!workIds[m.workId]) err(at + '.marks[' + k + '] 없는 workId: ' + m.workId);
      });
    });

    /* ── 문항 ── */
    var itemIds = {};
    var essayNoRubric = 0;
    items.forEach(function (it, i) {
      var at = 'items[' + i + '](' + (it.id || '?') + ')';
      if (!nonEmpty(it.id)) err(at + ' id 없음');
      else if (itemIds[it.id]) err(at + ' id 중복: ' + it.id);
      else itemIds[it.id] = true;
      if (ITEM_FORMATS.indexOf(it.format) < 0) err(at + ' 알 수 없는 format: ' + it.format);
      if (it.setId && !setIds[it.setId]) err(at + ' 없는 setId 참조: ' + it.setId);
      if (it.workId && !workIds[it.workId]) err(at + ' 없는 workId 참조: ' + it.workId);
      if (!nonEmpty(it.stem)) err(at + ' stem(발문) 없음');

      if (it.format === 'mc5') {
        var ch = it.choices || [];
        if (ch.length !== 5) warn(at + ' 선지가 ' + ch.length + '개예요 (실전은 5지선다).');
        if (!ch.every(function (c) { return nonEmpty(c.text); })) err(at + ' 빈 선지가 있어요.');
        var ansNo = it.answer;
        if (!(Number.isInteger(ansNo) && ansNo >= 1 && ansNo <= ch.length)) {
          err(at + ' answer가 선지 범위를 벗어났어요: ' + ansNo);
        }
        if (it.explanation && it.explanation.perChoice) {
          var missing = [];
          for (var n = 1; n <= ch.length; n++) if (!it.explanation.perChoice[n]) missing.push(n);
          if (missing.length) warn(at + ' 선지별 해설 누락: ' + missing.join(','));
        } else {
          warn(at + ' 선지별 해설이 없어요 — 오답 피드백의 핵심 재료예요(§5.2).');
        }
      }

      if (it.format === 'essay') {
        var rubric = it.rubric || [];
        if (!rubric.length) {
          essayNoRubric += 1;
          err(at + ' 서술형인데 rubric이 없어요 — 자료에 핵심 단어가 없는 문항은 검수에서 저작해야 해요(§7[3]).');
        }
        rubric.forEach(function (r, k) {
          var rat = at + '.rubric[' + k + ']';
          if (!nonEmpty(r.element)) err(rat + ' element 없음');
          if (!(r.keywords || []).length) err(rat + ' keywords가 비었어요.');
          if (r.points != null && !(typeof r.points === 'number' && r.points > 0)) err(rat + ' points는 양수여야 해요.');
          if (r.source && ['material', 'authored'].indexOf(r.source) < 0) {
            warn(rat + " source는 'material'(자료 제공) 또는 'authored'(검수 저작)여야 해요.");
          }
        });
        if (it.totalPoints != null) {
          var sum = rubric.reduce(function (a, r) { return a + (r.points == null ? 1 : r.points); }, 0);
          if (sum !== it.totalPoints) err(at + ' totalPoints(' + it.totalPoints + ')와 요소 배점 합(' + sum + ')이 달라요.');
        }
        if (!(it.modelAnswers || []).length) warn(at + ' modelAnswers(모범 답안)가 없어요.');
        (it.conditions || []).forEach(function (c, k) {
          if (COND_KINDS.indexOf(c.kind) < 0) err(at + '.conditions[' + k + '] 알 수 없는 kind: ' + c.kind);
        });
      }

      if (it.format === 'ox' && typeof it.answer !== 'boolean') err(at + ' OX는 answer가 true/false여야 해요.');

      /* targetRefs가 비면 오답이 개념 단위로 회귀하지 않는다(§5.4) — 정본 없는 작품은 정상 */
      var refs = it.targetRefs || [];
      refs.forEach(function (ref) {
        if (ref.indexOf('b-') === 0 && !blankIds[ref.slice(2)]) {
          err(at + ' targetRefs에 없는 빈칸 id: ' + ref);
        }
      });
      if (!refs.length && it.workId && canonIds[it.workId]) {
        warn(at + ' targetRefs가 비었어요 — 정본 있는 작품이니 개념 단위를 연결하면 오답이 큐로 돌아가요.');
      }
    });

    /* ── 공용 개념어 사전 참조 ── */
    if (opts.concepts) {
      var have = {};
      (opts.concepts.concepts || opts.concepts || []).forEach(function (c) { have[c.id] = true; });
      Object.keys(conceptRefs).forEach(function (id) {
        if (!have[id]) err('사전에 없는 conceptId 참조: ' + id);
      });
    }

    summary.push('작품 ' + actual.works + ' (정본 ' + Object.keys(canonIds).length + ')');
    summary.push('개념 단위(빈칸) ' + actual.blanks);
    summary.push('어휘 ' + actual.vocab);
    summary.push('지문 세트 ' + actual.sets);
    summary.push('저장 문항 ' + actual.items +
      ' (서술형 ' + items.filter(function (i) { return i.format === 'essay'; }).length +
      ' · 객관식 ' + items.filter(function (i) { return i.format === 'mc5'; }).length + ')');
    if (essayNoRubric) summary.push('루브릭 미저작 서술형 ' + essayNoRubric + '개');

    return { ok: errors.length === 0, errors: errors, warns: warns, summary: summary, counts: actual };
  }

  /* 분리 파일 병합 — 관리 웹이 여러 JSON을 골라 올릴 때 하나로 합친다.
     files: [{name, json}] — meta.json / works/*.json / sets.json / items-*.json */
  function assemble(files) {
    var pack = { works: [], sets: [], items: [] };
    var notes = [];
    (files || []).forEach(function (f) {
      var j = f.json;
      if (!j || typeof j !== 'object') { notes.push(f.name + ': JSON이 아니에요.'); return; }
      if (Array.isArray(j.works)) pack.works = pack.works.concat(j.works);
      if (Array.isArray(j.sets)) pack.sets = pack.sets.concat(j.sets);
      if (Array.isArray(j.items)) pack.items = pack.items.concat(j.items);
      if (j.work && typeof j.work === 'object') pack.works.push(j.work);
      Object.keys(j).forEach(function (k) {
        if (['works', 'sets', 'items', 'work', 'counts'].indexOf(k) >= 0) return;
        if (pack[k] == null) pack[k] = j[k];
      });
    });
    pack.counts = {
      works: pack.works.length, sets: pack.sets.length, items: pack.items.length,
      blanks: pack.works.reduce(function (a, w) { return a + ((w.blanks || []).length); }, 0),
      vocab: pack.works.reduce(function (a, w) { return a + ((w.vocab || []).length); }, 0)
    };
    return { pack: pack, notes: notes };
  }

  return { PACK_ID_RE: PACK_ID_RE, KINDS: KINDS, COND_KINDS: COND_KINDS, ITEM_FORMATS: ITEM_FORMATS,
    checkPack: checkPack, assemble: assemble };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBKOCHECK;
