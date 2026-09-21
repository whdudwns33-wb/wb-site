'use strict';
/* WB 브레인레터 — 5분 두뇌 놀이 생성기 (브라우저/Node 공용, 의존성 없음)
   도형(shapes.js)이 시공간 하나를 맡듯, 나머지 네 지표(언어이해·유동추론·작업기억·처리속도)의 놀이를 seed 로 결정론
   생성한다. 왜 생성기인가: 어린이 잡지가 매 호 같은 자리에 같은 종류의 퍼즐(숨은그림찾기)을 두어 습관을 만들듯, 브레인레터도
   매일 한 문제씩 "오늘의 5분"을 두고 싶은데 사람이 매주 35문제를 지어 넣을 수는 없다. 호 JSON 에는 {kind, seed} 만 싣고
   그림·정답은 여기서 낸다 — 검사 문항을 흉내 내지 않는다(같은 인지 기능을 쓰는 다른 놀이일 뿐이다).

   kinds
     span     작업기억 WMI — 숫자를 듣고 거꾸로 말하기(길이는 학년대별)
     symbols  처리속도 PSI — 기호 격자에서 과녁 기호 세기(시간 재기)
     sequence 유동추론 FRI — 수열의 빈 칸(등차·등비·번갈아 더하기)
     common   언어이해 VCI — 세 낱말의 공통점 말하기(자체 낱말 은행)
     odd-word 언어이해 VCI — 넷 중 무리에 안 드는 낱말 */
var WBDRILLS = (function () {
  var KINDS = ['span', 'symbols', 'sequence', 'common', 'odd-word'];
  var INDEX_OF = { span: 'WMI', symbols: 'PSI', sequence: 'FRI', common: 'VCI', 'odd-word': 'VCI' };
  var LABEL = { span: '거꾸로 말하기', symbols: '기호 찾기', sequence: '수열의 빈 칸', common: '공통점 말하기', 'odd-word': '무리에 안 드는 낱말' };
  var CIRCLED = ['①', '②', '③', '④', '⑤'];

  /* 같은 seed 면 같은 문제 — 앱·인쇄·정답 별지가 같은 것을 본다(shapes.js 와 같은 LCG) */
  function seeded(seed) {
    var s = (Number(seed) >>> 0) || 1;
    return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }
  function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }
  function shuffle(rnd, arr) { var a = arr.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function lower(t) { return t === 'K' || t === 'E1'; }
  function upper(t) { return t === 'E3' || t === 'M'; }

  /* 낱말 은행 — 전부 자체 작성. 범주가 서로 겹치지 않게 골랐다(과일·채소가 같이 나오면 "먹는 것"으로 답해도 맞는다) */
  var BANK = [
    { cat: '과일', words: ['사과', '바나나', '포도', '수박', '딸기', '복숭아'] },
    { cat: '탈것', words: ['버스', '기차', '자전거', '비행기', '배', '트럭'] },
    { cat: '악기', words: ['피아노', '바이올린', '북', '기타', '플루트', '트럼펫'] },
    { cat: '가구', words: ['의자', '책상', '침대', '옷장', '소파', '서랍장'] },
    { cat: '날씨', words: ['비', '눈', '바람', '안개', '우박', '무지개'] },
    { cat: '곤충', words: ['나비', '개미', '벌', '잠자리', '무당벌레', '매미'] },
    { cat: '직업', words: ['의사', '소방관', '교사', '요리사', '농부', '기자'] },
    { cat: '감정', words: ['기쁨', '슬픔', '분노', '두려움', '설렘', '놀람'] },
    { cat: '학용품', words: ['연필', '지우개', '공책', '자', '가위', '풀'] },
    { cat: '바다 동물', words: ['고래', '상어', '문어', '오징어', '해파리', '거북'] },
    { cat: '나라', words: ['한국', '일본', '프랑스', '브라질', '이집트', '캐나다'] },
    { cat: '신체 부위', words: ['무릎', '팔꿈치', '발목', '어깨', '손목', '턱'] },
    { cat: '음료', words: ['우유', '주스', '물', '차', '코코아', '식혜'] },
    { cat: '운동', words: ['축구', '수영', '달리기', '줄넘기', '태권도', '농구'] },
    { cat: '천체', words: ['해', '달', '별', '지구', '화성', '혜성'] },
  ];

  var GEN = {
    span: function (rnd, tier) {
      var len = lower(tier) ? 3 : (tier === 'E2' ? 4 : 5);
      var digits = [];
      for (var i = 0; i < len; i++) { var d; do { d = 1 + Math.floor(rnd() * 9); } while (digits.indexOf(d) >= 0); digits.push(d); }
      return { prompt: '부모님이 숫자를 1초에 하나씩 읽어 주세요. 아이는 다 듣고 나서 거꾸로 말해요. (종이에 쓰지 않고 머릿속으로만!)',
        body: '<div class="np-dr-seq">' + digits.join(' – ') + '</div>', answerText: digits.slice().reverse().join(' – '), hint: '마지막 숫자부터 앞으로. 잘되면 다음엔 하나 더 길게.' };
    },
    symbols: function (rnd, tier) {
      var pool = ['★', '●', '▲', '◆', '♥', '♣', '■', '✿'];
      var target = pick(rnd, pool), cols = lower(tier) ? 6 : 8, rows = lower(tier) ? 5 : 7;
      var cells = [], count = 0;
      for (var i = 0; i < rows * cols; i++) { var s = rnd() < 0.22 ? target : pick(rnd, pool); if (s === target) count += 1; cells.push(s); }
      var grid = '';
      for (var r = 0; r < rows; r++) grid += '<div class="np-dr-row">' + cells.slice(r * cols, (r + 1) * cols).map(function (c) { return '<span>' + c + '</span>'; }).join('') + '</div>';
      return { prompt: '아래 격자에서 ' + target + ' 는 모두 몇 개일까요? 시계를 보며 되도록 빨리, 그러나 빠뜨리지 않고 세어 보세요.',
        body: '<div class="np-dr-target">찾을 기호 <b>' + target + '</b></div><div class="np-dr-grid">' + grid + '</div>', answerText: count + '개', hint: '줄마다 왼쪽에서 오른쪽으로, 손가락으로 짚으며 세면 안 빠뜨려요.' };
    },
    sequence: function (rnd, tier) {
      var type = lower(tier) ? 'add' : pick(rnd, ['add', 'add', 'alt', 'mul']);
      var start = 1 + Math.floor(rnd() * (lower(tier) ? 5 : 12)), step = 1 + Math.floor(rnd() * (lower(tier) ? 3 : 6)), n = lower(tier) ? 5 : 6, seq = [], v = start;
      for (var i = 0; i < n; i++) {
        seq.push(v);
        if (type === 'add') v += step;
        else if (type === 'mul') v *= 2;
        else v += (i % 2 === 0 ? step : step + 2);   // 번갈아 더하기 — 규칙이 둘이라 한 번 더 들여다봐야 한다
      }
      var blank = upper(tier) ? n - 1 : Math.max(2, n - 2);
      var shown = seq.map(function (x, i) { return i === blank ? '□' : String(x); });
      var rule = type === 'add' ? step + '씩 커져요' : type === 'mul' ? '2배씩 커져요' : step + '과 ' + (step + 2) + '을 번갈아 더해요';
      return { prompt: '수가 어떤 규칙으로 늘어나는지 찾고 □ 에 들어갈 수를 말해 보세요.', body: '<div class="np-dr-seq">' + shown.join(' , ') + '</div>', answerText: String(seq[blank]), hint: '이웃한 두 수의 차이를 먼저 적어 보세요. ' + rule + '.' };
    },
    common: function (rnd, tier) {
      var g = pick(rnd, BANK), words = shuffle(rnd, g.words).slice(0, 3);
      return { prompt: '세 낱말의 공통점은 무엇일까요? "모두 ~이다"로 말해 보세요.', body: '<div class="np-dr-words">' + words.map(esc).join(' · ') + '</div>', answerText: '모두 ' + g.cat + '(이)에요', hint: upper(tier) ? '더 큰 범주 이름 하나로 묶어 보세요. 그 범주에 드는 낱말을 하나 더 대면 보너스.' : '셋이 어디에서 같이 보일까요?' };
    },
    'odd-word': function (rnd, tier) {
      var g = pick(rnd, BANK), other;
      do { other = pick(rnd, BANK); } while (other === g);
      var words = shuffle(rnd, g.words).slice(0, 3), odd = pick(rnd, other.words);
      var at = Math.floor(rnd() * 4), all = words.slice(); all.splice(at, 0, odd);
      return { prompt: '넷 중 무리에 안 드는 낱말 하나는? 까닭도 말해 보세요.', body: '<div class="np-dr-words">' + all.map(function (w, i) { return CIRCLED[i] + ' ' + esc(w); }).join('  ') + '</div>', answerText: CIRCLED[at] + ' ' + odd + ' — 나머지는 ' + g.cat, hint: '셋을 묶는 이름을 먼저 찾으면 하나가 남아요.' };
    },
  };

  /* drill = { kind, seed, tier? } → { kind, index, label, prompt, body(html — 이 모듈이 만든 문자열만), answerText, hint } */
  function make(drill) {
    if (!drill || KINDS.indexOf(drill.kind) < 0) return null;
    var seed = Number(drill.seed); if (!Number.isFinite(seed) || seed < 1) return null;
    var out = GEN[drill.kind](seeded(Math.floor(seed)), drill.tier || '');
    out.kind = drill.kind; out.index = INDEX_OF[drill.kind]; out.label = LABEL[drill.kind];
    return out;
  }
  function isValidDrill(d) { return !!d && typeof d === 'object' && KINDS.indexOf(d.kind) >= 0 && Number.isFinite(Number(d.seed)) && Number(d.seed) >= 1 && Number(d.seed) <= 999999; }
  /* 지표 → 그 지표의 놀이 종류(시공간은 shapes.js 몫) */
  function kindsFor(index) { return KINDS.filter(function (k) { return INDEX_OF[k] === index; }); }
  /* 오늘의 5분 — 주차·학년대·요일로 종류와 seed 를 정한다. 같은 주 같은 요일이면 누구나 같은 문제(가족끼리 비교할 수 있게),
     요일마다 지표가 돌아 한 주에 다섯 지표를 다 만난다 */
  function daily(week, tier, day) {
    var s = 0, str = String(week) + '|' + String(tier) + '|' + String(day);
    for (var i = 0; i < str.length; i++) s = (Math.imul(s, 31) + str.charCodeAt(i)) >>> 0;
    var order = ['span', 'symbols', 'sequence', 'common', 'odd-word', 'span'];
    var kind = order[((Number(day) || 1) - 1) % order.length];
    return { kind: kind, seed: (s % 999999) + 1, tier: tier };
  }
  function html(drill) {
    var g = make(drill);
    if (!g) return '<div class="np-dr np-dr-missing">놀이를 만들 수 없어요.</div>';
    return '<div class="np-dr" data-kind="' + esc(g.kind) + '">' + g.body + '</div>';
  }
  return { KINDS: KINDS, INDEX_OF: INDEX_OF, LABEL: LABEL, BANK: BANK, make: make, html: html, isValidDrill: isValidDrill, kindsFor: kindsFor, daily: daily, seeded: seeded };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBDRILLS;
