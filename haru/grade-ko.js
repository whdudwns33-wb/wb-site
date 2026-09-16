'use strict';
/* 한국어 핵심어 누락 표시 — naesin/grade.js 의 한국어 토크나이저 6개(JOSA·FUNC_STEMS·stripJosa·isFunctionToken·coreCands·gradeTranslationChunks)를 포크했다.
   용도 전환: "영어 청크의 모범 해석" → "국어 지문 한 줄 요약의 핵심어 누락 표시". 점수가 아니라 "빠뜨린 자리"만 표시한다.
   similarity·normalizeEn 은 여기 없다 — 그쪽은 한글 두 문장을 항상 1 로 본다(설계안 §0 실측). 이 파일이 그 함수를 절대 부르지 않는 것이 회귀 방지의 실체다. */
var WBHARU_GK = (function () {
  var JOSA = ['에서는', '에게서', '에서', '에게', '으로', '부터', '까지', '처럼', '보다', '한테', '께서', '에는',
    '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만'];
  /* 어느 문장에나 나오는 기능 어간 — 핵심 토큰이 아니다. 내신 목록 + 국어 지문 요약에서 흔한 것(글쓴이·글·내용·설명·이야기 …)을 보탰다. */
  var FUNC_STEMS = {};
  ('것 것이 수 하 한 했 해 하고 하는 있 있는 있었 없 없는 없었 되 된 됐 되는 되었 이 이었 인 않 않는 않았 '
    + '그 저 그것 이것 저것 때 때문 위해 위한 대해 대한 통해 같 같은 같이 및 등 또 또한 그리고 그래서 하지만 '
    + '글 글쓴이 내용 설명 이야기 말하 말한 뜻 의미 부분 문장 문단 지문 관 관한 따르 따라 대하 무엇 어떤 이런 그런')
    .split(' ').forEach(function (w) { FUNC_STEMS[w] = true; });

  function stripJosa(w) {
    for (var k = 0; k < JOSA.length; k++) { var j = JOSA[k]; if (w.length > j.length && w.slice(-j.length) === j) return w.slice(0, -j.length); }
    return w;
  }
  function isFunctionToken(word, base) { var stem = base.replace(/[다요]$/, ''); return !!(FUNC_STEMS[word] || FUNC_STEMS[base] || FUNC_STEMS[stem]); }
  function coreCands(word) {
    var cands = [], base = stripJosa(word);
    function add(c) { if (c.length >= 2 && cands.indexOf(c) < 0) cands.push(c); }
    add(base); add(base.replace(/[다요]$/, ''));
    if (base.length >= 3) add(base.slice(0, 2));
    if (!cands.length) add(word.slice(0, 2));
    return cands;
  }
  /* chunks: [{ko}] — 같은 자리를 두 토큰이 나눠 쓰지 못하고, 한 청크 안에서는 앞 토큰 뒤에서만 다음 토큰을 찾는다.
     토큰 절반 이상이 보이면 present — 정밀 채점이 아니라 "이 청크를 통째로 빠뜨렸다"의 표시다. */
  function gradeTranslationChunks(inputKo, chunks) {
    var input = String(inputKo == null ? '' : inputKo), used = [];
    function free(p, len) { for (var k = 0; k < used.length; k++) if (p < used[k][1] && used[k][0] < p + len) return false; return true; }
    function findFrom(cand, from) { for (var p = input.indexOf(cand, from); p >= 0; p = input.indexOf(cand, p + 1)) if (free(p, cand.length)) return p; return -1; }
    var presentCount = 0;
    var perChunk = (chunks || []).map(function (c) {
      var words = String((c && c.ko) || '').replace(/[^가-힣]/g, ' ').split(/\s+/);
      var total = 0, found = 0, cursor = 0;
      words.forEach(function (w) {
        if (w.length < 2) return;
        var base = stripJosa(w); if (isFunctionToken(w, base)) return;
        total += 1;
        var cands = coreCands(w);
        for (var k = 0; k < cands.length; k++) { var p = findFrom(cands[k], cursor); if (p < 0) continue; used.push([p, p + cands[k].length]); cursor = p + cands[k].length; found += 1; return; }
      });
      var present = total === 0 || found * 2 >= total;
      if (present) presentCount += 1;
      return { present: present, ko: c && c.ko };
    });
    return { perChunk: perChunk, coverage: perChunk.length ? presentCount / perChunk.length : 1 };
  }
  /* 지문 세션용 — 팩 passages[].keyPhrases 를 청크로 보고 학생의 한 줄 요약에서 빠뜨린 핵심어를 돌려준다. 점수 없음. */
  function summaryGaps(inputKo, keyPhrases) {
    var r = gradeTranslationChunks(inputKo, (keyPhrases || []).map(function (k) { return { ko: k }; }));
    return { missing: r.perChunk.filter(function (c) { return !c.present; }).map(function (c) { return c.ko; }), coverage: r.coverage };
  }
  return { JOSA: JOSA, FUNC_STEMS: FUNC_STEMS, stripJosa: stripJosa, isFunctionToken: isFunctionToken, coreCands: coreCands, gradeTranslationChunks: gradeTranslationChunks, summaryGaps: summaryGaps };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_GK;
