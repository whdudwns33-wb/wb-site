'use strict';
/* WB 한자브레인 — 진로독서 어휘장(wbr.v1) → 단어장 다리 (순수 로직, 브라우저/Node 공용)
   진로독서 앱은 지문에서 몰랐던 낱말을 어휘장(state.vocab)에 모은다:
     { word, easy(쉬운 풀이), hanja:"發(쏠 발)+射(쏠 사)+體(몸 체)"|null, lang:'en'|undefined, articleId, addedAt, … }
   그 낱말이 학생의 진짜 어휘다(워드브레인 기획서 원칙 4). 여기서는 그것을 한자브레인 단어장 모양으로 옮긴다 —
   영어(lang 'en')는 이 앱 몫이 아니라 뺀다. 단어장 id 는 고정('reading-vocab')이라 기억 기록(w:reading-vocab:<낱말>)이
   가져올 때마다 이어진다. wbr.v1 은 읽기만 한다 — 쓰기 주체는 진로독서 앱이다(워드브레인 bridge.js 와 같은 약속). */
var WBHBRIDGE = (function () {
  var BOOK_ID = 'reading-vocab';
  var TITLE = '진로독서 어휘장';

  function monthOf(v) {
    var d = String(v && v.addedAt || '');
    return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : '';
  }

  /* 어휘장 배열 → 단어장 원본(검사 전). 단원은 모은 달(YYYY-MM)로 나눈다 — 최근 것이 앞에 */
  function toBook(vocab, opts) {
    opts = opts || {};
    var words = [], seen = {}, months = [];
    (Array.isArray(vocab) ? vocab : []).forEach(function (v) {
      if (!v || typeof v.word !== 'string' || !v.word.trim()) return;
      if (v.lang === 'en' || /^[A-Za-z][A-Za-z\s'-]*$/.test(v.word.trim())) return;   /* 영어는 워드브레인 몫 */
      var word = v.word.trim(), meaning = String(v.easy || '').trim();
      if (!meaning) return;                                                        /* 뜻 없는 낱말은 문항이 안 된다 */
      var key = word + '|' + (v.hanja || '');
      if (seen[key]) return;
      seen[key] = true;
      var m = monthOf(v) || '기타';
      if (months.indexOf(m) < 0) months.push(m);
      var w = { word: word, meaning: meaning, unit: m };
      if (v.hanja) w.hanja = String(v.hanja);
      words.push(w);
    });
    months.sort().reverse();
    return {
      id: opts.id || BOOK_ID, title: opts.title || TITLE, publisher: 'WB 진로독서', source: 'own',   /* 진로독서 어휘장은 자체 기록 — AI 연상 가능 */
      note: '진로독서 앱 어휘장에서 가져온 낱말 — 이 기기의 wbr.v1 을 읽어 만든다(자체 기록, 라이선스 자료 아님).',
      units: months.map(function (m) { return { id: m, title: m === '기타' ? '기타' : m.replace('-', '년 ') + '월에 모음' }; }),
      words: words.map(function (w) { return w; }),
    };
  }

  /* localStorage 의 wbr.v1 문자열에서 어휘장만 뽑는다 — 파싱 실패·모양 다름은 빈 배열 */
  function readVocab(raw) {
    try { var s = JSON.parse(raw || 'null'); return (s && Array.isArray(s.vocab)) ? s.vocab : []; } catch (e) { return []; }
  }

  return { BOOK_ID: BOOK_ID, TITLE: TITLE, toBook: toBook, readVocab: readVocab };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBHBRIDGE;
