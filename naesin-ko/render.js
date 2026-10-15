'use strict';
/* WB 국어브레인 — 학생 화면·강사 지문 보드 공용 렌더러 (순수 로직) */
var WBKORENDER = (function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function markUp(line, marks) {
    var html = esc(line);
    (marks || []).forEach(function (mk) {
      if (mk.anchorText && line.indexOf(mk.anchorText) >= 0) {
        html = html.replace(esc(mk.anchorText), function () {
          return '<span class="sym">' + esc(mk.symbol) + '</span><mark>' + esc(mk.anchorText) + '</mark>';
        });
      }
    });
    return html;
  }

  /* 날개풀이 기본값은 꺼짐 — 구절 적용·주석 복원에서 정답이 보이면 인출이 성립하지 않는다. */
  function poemHtml(w, showNotes, overrideMarks) {
    w = w || {};
    var text = w.text || {}, marks = overrideMarks || w.marks || [], notes = showNotes ? (w.lineNotes || []) : [];
    function lineHtml(line) {
      var html = markUp(line, marks);
      notes.forEach(function (nt) {
        if (line.indexOf(nt.anchor) >= 0) html += '<span class="note">↳ ' + esc(nt.note) + '</span>';
      });
      return html;
    }
    if (text.paragraphs) return text.paragraphs.map(function (para) { return '<p>' + lineHtml(para) + '</p>'; }).join('');
    return (text.stanzas || []).map(function (stz) {
      return '<div class="st">' + (stz.lines || []).map(function (ln) {
        return '<div class="ln">' + lineHtml(ln) + '</div>';
      }).join('') + '</div>';
    }).join('');
  }

  function passageHtml(pack, question) {
    pack = pack || {}; question = question || {};
    function work(id) { return (pack.works || []).filter(function (w) { return w.workId === id; })[0] || {}; }
    var set = (pack.sets || []).filter(function (s) { return s.setId === question.setId; })[0];
    if (set) {
      return (set.works || []).map(function (ref) {
        var wk = work(ref.workId);
        /* ㉠ 기호는 세트마다 다른 구절을 가리킨다 — 세트에 없을 때만 정본 것을 쓴다. */
        var sm = (set.marks || []).filter(function (mk) { return !mk.workId || mk.workId === ref.workId; });
        var source = ref.text ? { text: ref.text, marks: wk.marks } : wk;
        var body = poemHtml(source, false, sm.length ? sm : null);
        return '<div class="poem" style="margin-bottom:10px">' +
          '<div class="small muted">' + esc(ref.label || '') + ' ' + esc(wk.title || '') + ' · ' + esc(wk.author || '') + '</div>' +
          (ref.prefaceSummary ? '<div class="small muted" style="margin:6px 0">' + esc(ref.prefaceSummary) + '</div>' : '') +
          body + '</div>';
      }).join('');
    }
    var w = work(question.workId);
    return w.text ? '<div class="poem">' + poemHtml(w) + '</div>' : '';
  }

  function structureHtml(structureMap) {
    return ((structureMap && structureMap.branches) || []).map(function (b) {
      return '<div style="margin-bottom:6px"><b>' + esc(b.category) + '</b> — ' + esc((b.children || []).join(', ')) + '</div>';
    }).join('');
  }

  return { markUp: markUp, poemHtml: poemHtml, passageHtml: passageHtml, structureHtml: structureHtml };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBKORENDER;
