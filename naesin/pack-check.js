'use strict';
/* WB 내신 — 레슨 팩 검사 규칙 (브라우저·Node 공용).
 *
 * 팩 검증 규칙이 세 곳(CLI 검증기·관리 웹 업로드·제작 스튜디오 배포)에서 필요하다.
 * 규칙을 복제하면 세 곳의 판정이 갈라져 "CLI는 통과인데 업로드가 막히는" 일이 생긴다 —
 * 그래서 규칙은 이 파일 하나에만 둔다. CLI(pack-validate.mjs)는 파일을 읽어 합친 뒤
 * checkPack 을 부르고, 파일 수준 오류(파싱 실패·packId 불일치)만 자기가 붙인다.
 *
 * checkPack(pack, opts) → { errors:[{where,message}], warns:[{where,message}], summary:[string] }
 *   pack  = 병합된 팩 객체 (words·sentences·oddOneItems·checkItems·dialogues·patterns·items·counts)
 *   opts  = { where: {words:'words.json', …} }  // 오류 위치 라벨(생략하면 섹션 이름)
 *
 * 자동 대조(사람이 봐야 할 것만 골라내는 관문):
 *   - 청크를 이어 붙이면 정본 en 과 정확히 같아야 한다(해석 판정의 기준이라 오류)
 *   - 어색한 곳 문항은 바뀐 조각을 correction 으로 되돌리면 정본 en 이 되어야 한다(오류)
 *   - 어구 배열 토큰을 이어 붙이면 정본 문장이 되어야 한다(표기 차이는 경고)
 *   - 핵심어·동사형·영작 키워드가 문장에 실재하는지(경고 — 표기 확인용)
 */
var WBPACKCHECK = (function () {
  'use strict';

  var STAGE_DAYGROUP_MAX = 12;   /* 한 과의 단락이 이보다 많으면 추출이 어긋난 것으로 본다 */
  /* 학생 앱이 가드 없이 읽는 배열 — 없으면 앱이 뜨지 않으므로 배포를 막는다 */
  var REQUIRED_SECTIONS = [
    { key: 'words', why: '홈 진단 카드·단어 암기가 죽는다', need: '[03] WORD TEST' },
    { key: 'sentences', why: '본문 암기·성취도가 죽는다', need: '[02] 본문 워크북' },
  ];

  function nonEmpty(s) { return typeof s === 'string' && s.trim().length > 0; }
  function isArr(a) { return Array.isArray(a); }

  /* 표기 비교용 정규화 — 굽은 따옴표·공백·대소문자를 지운다.
     원본 워크북은 인쇄 그대로 대소문자·구두점이 섞여 있어(예: 'soobin', 'big,')
     이 차이로 오류를 내면 정상 팩이 통과하지 못한다. */
  function flat(t) {
    return String(t == null ? '' : t)
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, '')
      .toLowerCase();
  }
  /* 낱말 단위 비교용 — 구두점을 떼고 공백 하나로 */
  function words1(t) {
    return String(t == null ? '' : t)
      .replace(/[‘’]/g, "'")
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function collector(opts) {
    var errors = [], warns = [], summary = [];
    var labels = (opts && opts.where) || {};
    function label(section) { return labels[section] || section; }
    return {
      errors: errors, warns: warns, summary: summary,
      err: function (section, message) { errors.push({ where: label(section), message: message }); },
      warn: function (section, message) { warns.push({ where: label(section), message: message }); },
      note: function (line) { summary.push(line); },
    };
  }

  /* ── 단어 ── */
  function checkWords(pack, c) {
    var list = pack.words;
    if (!isArr(list)) return;
    var S = 'words';
    var counts = pack.counts || {};
    if (counts.words != null && list.length !== counts.words)
      c.err(S, '단어 수 불일치 — counts.words=' + counts.words + ', 실제 ' + list.length);
    var ids = {};
    list.forEach(function (w, i) {
      var at = 'words[' + i + '](' + (w && w.headword != null ? w.headword : '?') + ')';
      if (!w || typeof w !== 'object') { c.err(S, at + ' 객체가 아님'); return; }
      if (!nonEmpty(w.id)) c.err(S, at + ' id 없음');
      else if (ids[w.id]) c.err(S, at + ' id 중복: ' + w.id);
      else ids[w.id] = true;
      if (!nonEmpty(w.headword)) c.err(S, at + ' headword 없음');
      if (!isArr(w.meaningKo) || !w.meaningKo.some(nonEmpty)) c.err(S, at + ' meaningKo 비었음');
      if (!isArr(w.sections) || !w.sections.length) c.err(S, at + ' sections 비었음');
      else w.sections.forEach(function (s) {
        if (s !== 'conversation' && s !== 'reading') c.err(S, at + ' 잘못된 section: ' + s);
      });
      if (w.example && !(nonEmpty(w.example.en) && nonEmpty(w.example.ko))) c.err(S, at + ' example en/ko 불완전');
      if (w.definition && !(nonEmpty(w.definition.en) && nonEmpty(w.definition.ko))) c.err(S, at + ' definition en/ko 불완전');
      if (isArr(w.senses)) w.senses.forEach(function (s, j) {
        if (!nonEmpty(s && s.meaningKo)) c.err(S, at + ' senses[' + j + '] meaningKo 없음');
      });
      /* 예문에 표제어가 안 보이면 예문 빈칸 문항이 만들어지지 않는다 — 굴절형까지 보므로 경고만 */
      if (w.example && nonEmpty(w.example.en) && nonEmpty(w.headword)) {
        var head = words1(w.headword).split(' ')[0];
        if (head.length > 3 && words1(w.example.en).indexOf(head.slice(0, Math.max(4, head.length - 2))) < 0)
          c.warn(S, at + ' 예문에 표제어가 안 보임 — 예문 빈칸이 안 만들어질 수 있음');
      }
    });
    c.note('words: ' + list.length + '개 (예문 ' + list.filter(function (w) { return w && w.example; }).length +
      ' · 영영풀이 ' + list.filter(function (w) { return w && w.definition; }).length +
      ' · 다의어 ' + list.filter(function (w) { return w && isArr(w.senses) && w.senses.length; }).length + ')');
  }

  /* ── 본문 문장 ── */
  function checkSentences(pack, c) {
    var list = pack.sentences;
    if (!isArr(list)) return;
    var S = 'sentences';
    var groups = {};
    list.forEach(function (s, i) {
      var at = 'sentences[' + i + '](seq ' + (s && s.seq != null ? s.seq : '?') + ')';
      if (!s || typeof s !== 'object') { c.err(S, at + ' 객체가 아님'); return; }
      if (s.seq !== i + 1) c.err(S, at + ' seq가 순번(' + (i + 1) + ')과 다름');
      /* dayGroup 은 출판사마다 형식이 다르다(날짜·장 제목 등) — 값을 못 박지 않고 있는지만 본다 */
      if (!nonEmpty(s.dayGroup)) c.err(S, at + ' dayGroup 없음');
      else groups[s.dayGroup] = true;
      if (!nonEmpty(s.en)) c.err(S, at + ' en 없음');
      if (!nonEmpty(s.ko)) c.err(S, at + ' ko 없음');

      if (!isArr(s.keywords) || !s.keywords.length) c.warn(S, at + ' keywords 비었음');
      else s.keywords.forEach(function (k, j) {
        if (!(nonEmpty(k && k.en) && nonEmpty(k && k.ko))) { c.err(S, at + ' keywords[' + j + '] en/ko 불완전'); return; }
        var first = words1(k.en).split(' ')[0];
        if (first && words1(s.en).indexOf(first) < 0)
          c.warn(S, at + ' 핵심어 "' + k.en + '"가 en에 안 보임 — 표기 확인');
        if (nonEmpty(s.ko) && s.ko.indexOf(k.ko) < 0)
          c.warn(S, at + ' 핵심어 뜻 "' + k.ko + '"가 ko에 안 보임 — 한글 빈칸이 안 만들어짐');
      });

      if (!isArr(s.tokens) || s.tokens.length < 2) c.warn(S, at + ' tokens 부족(배열 훈련 불가)');
      else if (nonEmpty(s.en) && flat(s.tokens.join(' ')) !== flat(s.en))
        c.warn(S, at + ' tokens 재조립이 en과 다름 — 표기 확인');

      if (isArr(s.chunks) && s.chunks.length) {
        /* 청크는 해석 판정과 암기용 한글의 기준 — 이어 붙이면 정본 en 과 정확히 같아야 한다 */
        if (nonEmpty(s.en) && flat(s.chunks.map(function (x) { return x && x.en; }).join(' ')) !== flat(s.en))
          c.err(S, at + ' chunks 연결이 en과 불일치');
        s.chunks.forEach(function (ch, j) {
          if (!(nonEmpty(ch && ch.en) && nonEmpty(ch && ch.ko))) c.err(S, at + ' chunks[' + j + '] en/ko 불완전');
        });
      }

      if (isArr(s.verbForms)) s.verbForms.forEach(function (v, j) {
        if (!(nonEmpty(v && v.base) && nonEmpty(v && v.answer))) { c.err(S, at + ' verbForms[' + j + '] base/answer 불완전'); return; }
        if (nonEmpty(s.en) && words1(s.en).indexOf(words1(v.answer)) < 0)
          c.warn(S, at + ' 동사형 "' + v.answer + '"가 en에 안 보임 — 표기 확인');
      });

      if (isArr(s.grammarChoices)) s.grammarChoices.forEach(function (g, j) {
        var at2 = at + ' grammarChoices[' + j + ']';
        if (!isArr(g && g.options) || g.options.length < 2) { c.err(S, at2 + ' options 부족'); return; }
        if (!(typeof g.answerIdx === 'number' && g.answerIdx >= 0 && g.answerIdx < g.options.length))
          c.err(S, at2 + ' answerIdx 범위 밖: ' + g.answerIdx);
        else if (nonEmpty(s.en) && words1(s.en).indexOf(words1(g.options[g.answerIdx])) < 0)
          c.warn(S, at2 + ' 정답 "' + g.options[g.answerIdx] + '"가 en에 안 보임 — 표기 확인');
      });

      if (isArr(s.writingKeywords)) s.writingKeywords.forEach(function (k) {
        if (!nonEmpty(k)) return;
        var w = words1(k);
        if (nonEmpty(s.en) && w.length > 2 && words1(s.en).indexOf(w.slice(0, Math.max(3, w.length - 2))) < 0)
          c.warn(S, at + ' 영작 키워드 "' + k + '"가 en에 안 보임 — 표기 확인');
      });
    });

    var gn = Object.keys(groups).length;
    if (gn > STAGE_DAYGROUP_MAX)
      c.warn(S, 'dayGroup이 ' + gn + '개 — 단락 구분이 어긋났을 수 있음(단락 단위 학습이 잘게 쪼개짐)');
    var kw = list.reduce(function (n, s) { return n + ((s && isArr(s.keywords) && s.keywords.length) || 0); }, 0);
    c.note('sentences: ' + list.length + '문장 · 단락 ' + gn + ' (핵심어 ' + kw +
      ' · 청크 ' + list.reduce(function (n, s) { return n + ((s && isArr(s.chunks) && s.chunks.length) || 0); }, 0) + ')');
  }

  /* ── 어색한 곳 찾기 (단락 재인 관문) ── */
  function checkOddOne(pack, c) {
    var list = pack.oddOneItems;
    if (!isArr(list)) return;
    var S = 'oddOneItems';
    var byGroup = {}, bySeq = {};
    (isArr(pack.sentences) ? pack.sentences : []).forEach(function (s) {
      if (s && nonEmpty(s.dayGroup)) byGroup[s.dayGroup] = true;
      if (s && s.seq != null) bySeq[s.seq] = s;
    });
    var counts = pack.counts || {};
    if (counts.oddOneItems != null && list.length !== counts.oddOneItems)
      c.err(S, '개수 불일치 — counts.oddOneItems=' + counts.oddOneItems + ', 실제 ' + list.length);
    var ids = {};
    list.forEach(function (it, i) {
      var at = 'oddOneItems[' + i + '](' + ((it && it.id) || '?') + ')';
      if (!it || typeof it !== 'object') { c.err(S, at + ' 객체가 아님'); return; }
      if (!nonEmpty(it.id)) c.err(S, at + ' id 없음');
      else if (ids[it.id]) c.err(S, at + ' id 중복: ' + it.id);
      else ids[it.id] = true;
      if (!nonEmpty(it.dayGroup)) c.err(S, at + ' dayGroup 없음');
      else if (Object.keys(byGroup).length && !byGroup[it.dayGroup]) c.err(S, at + ' 없는 dayGroup: ' + it.dayGroup);
      if (it.kind !== 'lexical' && it.kind !== 'grammatical') c.err(S, at + ' kind 이상: ' + it.kind);
      if (!isArr(it.options) || it.options.length < 2) { c.err(S, at + ' options 부족'); return; }
      if (!(typeof it.answerIdx === 'number' && it.answerIdx >= 0 && it.answerIdx < it.options.length)) {
        c.err(S, at + ' answerIdx 범위 밖: ' + it.answerIdx); return;
      }
      if (!nonEmpty(it.correction)) { c.err(S, at + ' correction 없음'); return; }

      var altered = it.options[it.answerIdx];
      var lines = isArr(it.sentences) ? it.sentences : [];
      if (!lines.length) { c.err(S, at + ' sentences 비었음'); return; }
      var found = false, restoredOk = false;
      lines.forEach(function (ln, j) {
        if (!ln || ln.seq == null || !nonEmpty(ln.text)) { c.err(S, at + ' sentences[' + j + '] seq/text 불완전'); return; }
        var canon = bySeq[ln.seq];
        if (!canon) { c.err(S, at + ' 없는 문장 seq: ' + ln.seq); return; }
        if (ln.text.indexOf(altered) >= 0) {
          found = true;
          /* 바뀐 조각을 correction 으로 되돌리면 정본 en 이 되어야 한다 — 이게 이 문항의 정답 근거다 */
          var restored = ln.text.split(altered).join(it.correction);
          if (flat(restored) === flat(canon.en)) restoredOk = true;
          else c.err(S, at + ' correction 으로 되돌려도 정본 문장(seq ' + ln.seq + ')과 다름');
        } else if (flat(ln.text) !== flat(canon.en)) {
          c.warn(S, at + ' sentences[' + j + '](seq ' + ln.seq + ') 이 정본과 다른데 정답 조각도 아님');
        }
      });
      if (!found) c.err(S, at + ' 정답 조각 "' + altered + '"이 어느 문장에도 없음');
      else if (!restoredOk) c.err(S, at + ' 정답 조각을 되돌려 정본이 되는 문장이 없음');
    });
    c.note('oddOneItems: ' + list.length + '문항');
  }

  /* ── 종합 Check (과 최종 관문) ── */
  var CHECK_SLOTS = { choice: 1, blank: 1, write: 1, arrange: 1 };
  function checkCheckItems(pack, c) {
    var list = pack.checkItems;
    if (!isArr(list)) return;
    var S = 'checkItems';
    var bySeq = {};
    (isArr(pack.sentences) ? pack.sentences : []).forEach(function (s) { if (s && s.seq != null) bySeq[s.seq] = s; });
    var counts = pack.counts || {};
    if (counts.checkItems != null && list.length !== counts.checkItems)
      c.err(S, '개수 불일치 — counts.checkItems=' + counts.checkItems + ', 실제 ' + list.length);
    var ids = {}, bySlot = {};
    list.forEach(function (it, i) {
      var at = 'checkItems[' + i + '](' + ((it && it.id) || '?') + ')';
      if (!it || typeof it !== 'object') { c.err(S, at + ' 객체가 아님'); return; }
      if (!nonEmpty(it.id)) c.err(S, at + ' id 없음');
      else if (ids[it.id]) c.err(S, at + ' id 중복: ' + it.id);
      else ids[it.id] = true;
      if (!CHECK_SLOTS[it.slot]) { c.err(S, at + ' slot 이상: ' + it.slot); return; }
      bySlot[it.slot] = (bySlot[it.slot] || 0) + 1;
      if (it.seq != null && Object.keys(bySeq).length && !bySeq[it.seq]) c.err(S, at + ' 없는 문장 seq: ' + it.seq);
      if (!nonEmpty(it.promptKo)) c.warn(S, at + ' promptKo 없음 — 학생이 무엇을 하는지 모름');

      if (it.slot === 'choice') {
        if (!isArr(it.choices) || it.choices.length < 2) { c.err(S, at + ' choices 부족'); return; }
        var seen = {}, dup = false;
        it.choices.forEach(function (ch) { var k = flat(ch); if (seen[k]) dup = true; seen[k] = true; });
        if (dup) c.err(S, at + ' 보기 중복');
        if (!(typeof it.answerIdx === 'number' && it.answerIdx >= 0 && it.answerIdx < it.choices.length))
          c.err(S, at + ' answerIdx 범위 밖: ' + it.answerIdx);
      } else if (it.slot === 'blank') {
        if (!nonEmpty(it.textEn)) c.err(S, at + ' textEn 없음');
        /* 빈칸 정답은 빈칸마다 따로 있다(blanks[].answers) — 힌트도 빈칸별이라 이 형태여야 한다 */
        if (!isArr(it.blanks) || !it.blanks.length) { c.err(S, at + ' blanks 비었음'); return; }
        it.blanks.forEach(function (b, j) {
          var ba = isArr(b && b.answers) ? b.answers.filter(nonEmpty) : (nonEmpty(b && b.answers) ? [b.answers] : []);
          if (!ba.length) c.err(S, at + ' blanks[' + j + '] answers 비었음');
        });
        if (nonEmpty(it.textEn)) {
          var nb = (it.textEn.match(/_{2,}/g) || []).length;
          if (!nb) c.warn(S, at + ' textEn에 빈칸(___)이 없음');
          else if (nb !== it.blanks.length) c.err(S, at + ' 빈칸 ' + nb + '개 ≠ blanks ' + it.blanks.length + '개');
        }
      } else if (it.slot === 'write') {
        var wa = isArr(it.answers) ? it.answers.filter(nonEmpty) : (nonEmpty(it.answers) ? [it.answers] : []);
        if (!wa.length) c.err(S, at + ' answers 비었음');
        if (!nonEmpty(it.ko) && !nonEmpty(it.promptKo)) c.err(S, at + ' 한글 지시문(ko/promptKo) 없음');
      } else if (it.slot === 'arrange') {
        if (!isArr(it.tokens) || it.tokens.length < 2) { c.err(S, at + ' tokens 부족'); return; }
        /* 배열 문항의 정답은 answers 가 있으면 그것, 없으면 정본 문장이다(토막은 정답 어순으로 싣는 관례).
           주어진 토막으로 정답을 만들 수 없으면 학생이 풀 방법이 없다. */
        var aa = isArr(it.answers) ? it.answers.filter(nonEmpty) : (nonEmpty(it.answers) ? [it.answers] : []);
        var target = aa.length ? aa.join(' ') : (it.seq != null && bySeq[it.seq] ? bySeq[it.seq].en : '');
        if (!nonEmpty(target)) { c.err(S, at + ' 정답을 알 수 없음(answers 없고 seq로 정본 문장도 못 찾음)'); return; }
        if (flat(it.tokens.join(' ')) !== flat(target))
          c.err(S, at + ' tokens 재조립이 정답과 다름 — 풀 수 없는 문항');
        if (!nonEmpty(it.ko) && !nonEmpty(it.promptKo)) c.warn(S, at + ' 한글 지시문 없음 — 무엇을 배열할지 모름');
      }
    });
    var parts = Object.keys(bySlot).sort().map(function (k) { return k + ' ' + bySlot[k]; });
    c.note('checkItems: ' + list.length + '슬롯 (' + (parts.join(' · ') || '없음') + ')');
  }

  /* ── 대화문 ── */
  function checkDialogues(pack, c) {
    var list = pack.dialogues;
    if (!isArr(list)) return;
    var S = 'dialogues';
    if (!list.length) c.err(S, 'dialogues 비었음');
    var lines = 0;
    list.forEach(function (d, i) {
      (isArr(d && d.lines) ? d.lines : []).forEach(function (l, j) {
        lines += 1;
        if (!(nonEmpty(l && l.speaker) && nonEmpty(l && l.en) && nonEmpty(l && l.ko)))
          c.err(S, 'dialogues[' + i + '].lines[' + j + '] speaker/en/ko 불완전');
      });
    });
    c.note('dialogues: ' + list.length + '개 ' + lines + '줄 (핵심표현 ' + ((isArr(pack.keyExpressions) && pack.keyExpressions.length) || 0) +
      ' · 어휘 사이드바 ' + ((isArr(pack.vocabSidebar) && pack.vocabSidebar.length) || 0) +
      ' · QA ' + ((isArr(pack.readingQA) && pack.readingQA.length) || 0) + ')');
  }

  /* ── 문법 패턴 ── */
  function checkPatterns(pack, c) {
    var list = pack.patterns;
    if (!isArr(list)) return;
    var S = 'patterns';
    list.forEach(function (p, i) {
      if (!nonEmpty(p && p.title)) c.err(S, 'patterns[' + i + '] title 없음');
      if (!nonEmpty(p && p.conceptKo)) c.err(S, 'patterns[' + i + '] conceptKo 없음');
      if (!(isArr(p && p.textbookExamples) && p.textbookExamples.length)) c.warn(S, 'patterns[' + i + '] 교과서 예문 없음');
    });
    c.note('patterns: ' + list.length + '개');
  }

  /* ── 저장 문항 ── */
  function checkItems(pack, c, sectionName) {
    var list = pack.items;
    if (!isArr(list)) return;
    var S = sectionName || 'items';
    var heads = {};
    (isArr(pack.words) ? pack.words : []).forEach(function (w) { if (w && nonEmpty(w.headword)) heads[words1(w.headword)] = true; });
    list.forEach(function (it, i) {
      var at = 'items[' + i + '](no ' + (it && it.no != null ? it.no : '?') + ')';
      if (!it || typeof it !== 'object') { c.err(S, at + ' 객체가 아님'); return; }
      if (!nonEmpty(it.formatType)) c.err(S, at + ' formatType 없음');
      if (!isArr(it.answer) || !it.answer.length) { c.err(S, at + ' answer 비었음'); return; }
      if (isArr(it.choices) && it.choices.length) {
        var labels = {};
        it.choices.forEach(function (ch) { labels[String(ch && ch.label)] = true; });
        it.answer.forEach(function (a) {
          if (!labels[String(a)]) c.err(S, at + ' 정답 "' + a + '"가 보기 label에 없음');
        });
        if (it.answerCount != null && it.answer.length !== it.answerCount)
          c.err(S, at + ' answerCount(' + it.answerCount + ') ≠ 정답 수(' + it.answer.length + ')');
      } else if (Object.keys(heads).length) {
        /* 보기 없는 주관식 정답이 낱말 하나면 단어 마스터와 대조한다 — 정답지 오탈자를 여기서 잡는다 */
        it.answer.forEach(function (a) {
          var k = words1(a);
          if (k && k.indexOf(' ') < 0 && k.length > 2 && !heads[k])
            c.warn(S, at + ' 정답 "' + a + '"가 단어 마스터에 없음 — 표기 확인');
        });
      }
    });
    c.note(S + ': ' + list.length + '문항');
  }

  /* ── 전체 ── */
  function checkPack(pack, opts) {
    var c = collector(opts);
    if (!pack || typeof pack !== 'object') {
      c.err('(공통)', '팩이 객체가 아님');
      return { errors: c.errors, warns: c.warns, summary: c.summary };
    }
    checkWords(pack, c);
    checkSentences(pack, c);
    checkOddOne(pack, c);
    checkCheckItems(pack, c);
    checkDialogues(pack, c);
    checkPatterns(pack, c);
    checkItems(pack, c, opts && opts.itemsLabel);
    if (!c.summary.length) c.err('(공통)', '검사할 팩 내용이 하나도 없음');
    /* 학생 앱은 pack.words·pack.sentences 를 가드 없이 읽는다(홈 진단 카드·본문 매트릭스).
       둘 중 하나라도 배열이 아니면 첫 화면이 TypeError 로 죽는데, 오류 메시지도 없이
       '교재를 불러오는 중…' 에 멈춘다. 그런 팩이 배포 관문을 통과해서는 안 된다.
       (스튜디오 assemble 은 행이 0인 종류를 팩에서 아예 빼므로, 한 종류만 넣고 만들면
        정확히 이 상태가 나온다 — 실제로 오류 0·경고 0 으로 통과하던 구멍이다.) */
    REQUIRED_SECTIONS.forEach(function (r) {
      if (!isArr(pack[r.key]) || !pack[r.key].length)
        c.err('(공통)', r.key + ' 가 비었음 — ' + r.why + ' (' + r.need + ' 자료가 필요하다)');
    });
    return { errors: c.errors, warns: c.warns, summary: c.summary };
  }

  return {
    checkPack: checkPack,
    /* 섹션별 검사도 노출한다 — 스튜디오 검수 화면이 한 종류만 다시 검사할 때 쓴다 */
    checkWords: checkWords, checkSentences: checkSentences, checkOddOne: checkOddOne,
    checkCheckItems: checkCheckItems, checkDialogues: checkDialogues, checkPatterns: checkPatterns,
    checkItems: checkItems,
    collector: collector, flat: flat, words1: words1, nonEmpty: nonEmpty,
    CHECK_SLOTS: CHECK_SLOTS, STAGE_DAYGROUP_MAX: STAGE_DAYGROUP_MAX,
    REQUIRED_SECTIONS: REQUIRED_SECTIONS,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBPACKCHECK;
