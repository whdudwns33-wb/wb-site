'use strict';
/* WB 워드브레인 — 한자 따라쓰기 판정 (브라우저/Node 공용, 순수 함수)
   기획서 §2.2 「멀티모달 입력: 눈 + 귀 + 입 + 손 중 최소 2채널」 — 지금까지 눈·귀·입은
   있었고 손이 없었다. 한자는 특히 손으로 한 번 써 봐야 획이 눈에 들어온다.

   세 번 쓰되 안내 글자가 회차마다 옅어진다.
   1회는 보고 그리고, 2회는 흐릿한 것을 더듬고, 3회는 안내 없이 기억에서 꺼내 쓴다.
   §2.3 「인출 난이도 사다리」를 손으로 옮긴 것이다 — 보고 베끼기만 세 번 하면
   손은 움직여도 기억은 남지 않는다.

   획순 데이터는 넣지 않았다. 획순을 채점하려면 글자마다 획 좌표가 필요한데,
   그 데이터가 없는 채로 "틀렸다"고 말하면 맞는 획순도 틀렸다고 하게 된다.
   틀린 채점은 채점을 안 하느니만 못하다. 지금은 미(米)자 격자와 안내 글자까지만 준다. */
var WBTrace = (function () {

  var REPS = 3;

  /* 회차별 안내 글자 진하기. 마지막은 0 — 빈 칸에 스스로 쓴다. */
  var GUIDE = [0.30, 0.13, 0];

  function guideAlpha(rep) {
    var i = Math.floor(Number(rep));
    if (!isFinite(i) || i < 0) return GUIDE[0];
    return i < GUIDE.length ? GUIDE[i] : 0;
  }

  /* 한자만 골라낸다. 낱말 표기에 섞인 한글·기호·괄호는 따라 쓸 대상이 아니다. */
  function chars(hanja) {
    var out = [];
    String(hanja == null ? '' : hanja).split('').forEach(function (c) {
      if (/[㐀-䶿一-鿿豈-﫿]/.test(c)) out.push(c);
    });
    return out;
  }

  /* 쓸 차례를 미리 펼쳐 둔다 — 글자 하나를 세 번 쓰고 다음 글자로 넘어간다.
     觀→測→觀→測 식으로 섞으면 획이 손에 붙기 전에 화면이 바뀐다. */
  function plan(hanja) {
    var out = [];
    chars(hanja).forEach(function (c) {
      for (var r = 0; r < REPS; r++) out.push({ ch: c, rep: r, last: r === REPS - 1 });
    });
    return out;
  }

  /* 그은 획의 총 길이. strokes = [[{x,y}, ...], ...] */
  function inkLen(strokes) {
    var sum = 0;
    var list = Array.isArray(strokes) ? strokes : [];
    for (var s = 0; s < list.length; s++) {
      var st = Array.isArray(list[s]) ? list[s] : [];
      for (var i = 1; i < st.length; i++) {
        var a = st[i - 1], b = st[i];
        if (!a || !b) continue;
        var dx = Number(b.x) - Number(a.x), dy = Number(b.y) - Number(a.y);
        var d = Math.sqrt(dx * dx + dy * dy);
        if (isFinite(d)) sum += d;
      }
    }
    return sum;
  }

  /* 통과에 필요한 최소 획 길이. 칸 한 변의 0.6배.
     一처럼 가로 한 획짜리 글자도 통과해야 하므로 한 변보다 짧게 잡는다.
     톡 찍거나 짧게 긋고 넘어가는 것은 막힌다. */
  function minInk(size) {
    var s = Number(size);
    return (isFinite(s) && s > 0 ? s : 240) * 0.6;
  }

  function enough(strokes, size) { return inkLen(strokes) >= minInk(size); }

  return {
    REPS: REPS, GUIDE: GUIDE,
    guideAlpha: guideAlpha, chars: chars, plan: plan,
    inkLen: inkLen, minInk: minInk, enough: enough,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBTrace;
