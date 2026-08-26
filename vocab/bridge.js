'use strict';
/* WB 워드브레인 — 진로독서(wbr.v1) 어휘장 → 씨앗 변환 브리지 (순수 로직, 브라우저/Node 공용)
   진로독서 항목: {word, easy(쉬운 풀이), hanja:"發(쏠 발)+射(쏠 사)+體(몸 체)"|null, lang:'en'(영어)}
   워드브레인은 wbr.v1을 읽기만 한다 — 쓰기 주체는 진로독서 앱. */
var WBBRIDGE = (function () {
  /* '發(쏠 발)+射(쏠 사)+體(몸 체)' → [{ch:'發',hun:'쏠',eum:'발'}, …] */
  function parseHanja(str) {
    if (!str) return null;
    var out = [], re = /([^+()\s])\(([^)]+)\)/g, m;
    while ((m = re.exec(str))) {
      var inner = m[2].trim(), sp = inner.lastIndexOf(' ');
      if (sp < 0) out.push({ ch: m[1], hun: inner, eum: inner });
      else out.push({ ch: m[1], hun: inner.slice(0, sp), eum: inner.slice(sp + 1) });
    }
    return out.length ? out : null;
  }

  function slug(w) { return String(w).toLowerCase().replace(/[^a-z0-9가-힣]/g, ''); }

  /* 진로독서 어휘장 항목 1개 → 워드브레인 단어 객체 */
  function fromReadingEntry(v) {
    var parts = v.lang === 'en' ? null : parseHanja(v.hanja);
    var type = v.lang === 'en' ? 'english' : (parts ? 'hanja' : 'native');
    var w = { id: 'rd-' + slug(v.word), type: type, word: v.word, meaning: v.easy || '', source: 'reading' };
    if (parts) {
      w.parts = parts;
      w.hanja = parts.map(function (p) { return p.ch; }).join('');
      w.literal = parts.map(function (p) { return p.hun; }).join(' · ');
    }
    if (type === 'english' && v.base) w.base = v.base;
    return w;
  }

  /* 어휘장 배열 → 아직 안 심은 씨앗 목록 (최신 우선, 중복 제거)
     opts.plantedIds: 이미 심은 id 맵 / opts.seedByWord: 시드 단어(word→객체) — 있으면 시드 데이터 우선 */
  function collectInbox(readingVocab, opts) {
    opts = opts || {};
    var planted = opts.plantedIds || {}, seed = opts.seedByWord || {};
    var out = [], seen = {};
    (readingVocab || []).slice().reverse().forEach(function (v) {
      if (!v || !v.word || !v.easy) return;
      var w = seed[v.word] || fromReadingEntry(v);
      if (planted[w.id] || seen[w.id]) return;
      seen[w.id] = true;
      out.push(w);
    });
    return out;
  }

  return { parseHanja: parseHanja, fromReadingEntry: fromReadingEntry, collectInbox: collectInbox };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBBRIDGE;
