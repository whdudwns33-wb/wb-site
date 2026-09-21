'use strict';
/* WB 청크브레인 — 의미 단위 끊어 읽기 규칙 (순수 로직, 브라우저/Node 공용)
 *
 * 무엇을 하나
 *   · 글을 어절로 나누고, 모범 조각(paragraphs 배열)에서 경계를 뽑고, 학생이 찍은 경계를 채점한다.
 *   · 채점 결과에 «왜» 를 붙인다 — 놓친 경계는 「여기서 왜 쉬는가」, 군더더기 경계는 「왜 붙여 읽는가」.
 *     이 태그가 복습 탭의 「약한 규칙」과 배우기 카드의 연결 고리다.
 *
 * 규칙의 출처는 docs/의미단위-끊어읽기-규격.md 3장이다 — 조사는 끊는 근거가 아니고, 구·절 경계가 근거다.
 * 붙여 읽어야 하는 자리(관형어+명사, 부사+용언, 수+단위, 의존명사, 보조용언)는 reading/chunk.mjs 의
 * NO_BREAK 목록을 옮겨 왔다. 여기서는 «초안을 만드는» 데 쓰지 않고 «학생의 실수를 설명하는» 데만 쓴다 —
 * 그래서 목록이 조금 틀려도 점수는 안 바뀌고 설명 문구만 달라진다(점수는 모범 조각과의 일치로만 낸다).
 */
var WBCHUNK = (function () {

  /* ── 학년대(밴드) — 유치부터 고등까지 여섯 단계 ──
     target·max 는 한 조각의 어절 수. 규격서 2장의 L1~L4 눈금(3.3/3.7/4.1/4.5, 상한 8)을 여섯으로 펼쳤다.
     유치(K)는 한글을 막 뗀 아이라 1~2어절, 문장 하나가 3~4어절이다. */
  var BANDS = {
    K:  { key: 'K',  label: '유치',    who: '5~7세 · 한글을 막 뗀 아이', target: 2,   max: 4, sentLen: [2, 5],  chars: [30, 160],   rate: 0.85, sentenceMode: true },
    E1: { key: 'E1', label: '초1~2',   who: '초등 1~2학년',              target: 2.5, max: 5, sentLen: [3, 8],  chars: [50, 260],   rate: 0.9,  sentenceMode: true },
    E2: { key: 'E2', label: '초3~4',   who: '초등 3~4학년',              target: 3.3, max: 6, sentLen: [4, 14], chars: [120, 420],  rate: 0.95, sentenceMode: false },
    E3: { key: 'E3', label: '초5~6',   who: '초등 5~6학년',              target: 3.7, max: 7, sentLen: [4, 20], chars: [180, 560],  rate: 1,    sentenceMode: false },
    M:  { key: 'M',  label: '중등',    who: '중학교 1~3학년',            target: 4.1, max: 8, sentLen: [4, 24], chars: [220, 760],  rate: 1,    sentenceMode: false },
    H:  { key: 'H',  label: '고등',    who: '고등학교 1~3학년',          target: 4.5, max: 8, sentLen: [4, 30], chars: [280, 1000], rate: 1,    sentenceMode: false },
  };
  var BAND_ORDER = ['K', 'E1', 'E2', 'E3', 'M', 'H'];

  /* 학년 → 밴드. 0 = 유치(7세 이하), 1~6 초등, 7~9 중등, 10~12 고등 */
  function bandOfGrade(g) {
    var n = Number(g);
    if (!(n >= 1)) return 'K';
    if (n <= 2) return 'E1';
    if (n <= 4) return 'E2';
    if (n <= 6) return 'E3';
    if (n <= 9) return 'M';
    return 'H';
  }
  function nextBand(b) { var i = BAND_ORDER.indexOf(b); return i >= 0 && i < BAND_ORDER.length - 1 ? BAND_ORDER[i + 1] : null; }
  function prevBand(b) { var i = BAND_ORDER.indexOf(b); return i > 0 ? BAND_ORDER[i - 1] : null; }

  /* ── 어절 ──
     뒤따르는 공백을 어절 끝에 붙여 둔다 — 이어붙이면 원문이 그대로 나온다(규격서 5장 철칙). */
  function words(text) { return String(text || '').match(/\S+\s*/g) || []; }
  function wordCount(text) { return words(text).length; }

  /* 모범 조각 → 경계 어절 인덱스(그 어절 «뒤»에서 끊는다). 마지막 조각 뒤는 경계가 아니다. */
  function modelBoundaries(segs) {
    var out = [], cum = 0;
    for (var i = 0; i < segs.length; i++) {
      cum += words(segs[i]).length;
      if (i < segs.length - 1) out.push(cum - 1);
    }
    return out;
  }

  /* 경계 집합 + 원문 → 조각 배열 (학생이 찍은 대로 다시 조립할 때) */
  function segsFromBoundaries(text, marks) {
    var ws = words(text), set = toSet(marks), out = [], cur = '';
    for (var i = 0; i < ws.length; i++) {
      cur += ws[i];
      if (set[i] && i < ws.length - 1) { out.push(cur); cur = ''; }
    }
    if (cur) out.push(cur);
    return out;
  }

  function toSet(list) {
    var s = {};
    if (!list) return s;
    if (typeof list.forEach === 'function') list.forEach(function (i) { s[i] = true; });
    return s;
  }

  /* ── 채점 — 규격서 9장 그대로: (맞힌 경계 − 0.5 × 불필요한 경계) / 모범 경계 수 × 100 ──
     과하게 잘게 끊는 것에는 절반만 벌점을 준다. 안 끊는 것보다는 낫기 때문이다. */
  /* text 를 주면 «쉼표 뒤»에 찍은 군더더기는 벌점을 주지 않는다(neutral). 규격서 3장에서 쉼표는 「거의 항상 끊는 자리」라
     모범이 이어 읽었더라도 학생이 거기서 쉬는 것을 틀렸다고 할 수는 없다. 점수식 자체는 규격서 9장 그대로다. */
  function score(model, marks, text) {
    var M = toSet(model), S = toSet(marks), hit = 0, extra = 0, missed = [], extras = [], neutral = [], k;
    var ws = text != null ? words(text) : null;
    for (k in S) if (S[k]) {
      if (M[k]) hit++;
      else if (ws && ws[k] && RE_COMMA.test(String(ws[k]).trim())) neutral.push(+k);
      else { extra++; extras.push(+k); }
    }
    for (k in M) if (M[k] && !S[k]) missed.push(+k);
    var n = 0; for (k in M) if (M[k]) n++;
    var sc = n ? Math.max(0, Math.round((hit - 0.5 * extra) / n * 100)) : (extra ? 0 : 100);
    missed.sort(function (a, b) { return a - b; }); extras.sort(function (a, b) { return a - b; }); neutral.sort(function (a, b) { return a - b; });
    return { hit: hit, extra: extra, missed: missed, extras: extras, neutral: neutral, model: n, score: sc };
  }

  /* ── 여기서 «왜» 쉬는가 — 모범 경계의 종류 ──
     문장 끝 > 쉼표 > 절이 끝나는 연결어미 > 그 밖의 구·절 경계. 규격서 3장 「실제로 쓸 수 있는 순서」. */
  var CLOSE = '[」』’”"\')\\]]*';
  var RE_SENT = new RegExp('[.!?…]' + CLOSE + '$');
  var RE_COMMA = new RegExp('[,、]' + CLOSE + '$');
  var RE_CONN = /(?:[^가-힣]|^)?(?:고|며|면|지만|면서|도록|려면|는데|은데|아서|어서|해서|여서|니까|거나|더니|자마자|다가|라서|므로|든지|자|려고|지도|나마)$/;
  function classifyBoundary(ws, i) {
    var cur = String(ws[i] || '').trim();
    if (RE_SENT.test(cur)) return 'sent';
    if (RE_COMMA.test(cur)) return 'comma';
    if (cur.length >= 2 && RE_CONN.test(cur)) return 'conn';
    return 'phrase';
  }
  var BOUNDARY_WHY = {
    sent: '문장이 끝났어요. 마침표·물음표·느낌표 뒤에서는 꼭 쉬어요.',
    comma: '쉼표가 있어요. 쉼표 뒤에서 살짝 쉬어요.',
    conn: '「-고, -면, -지만」처럼 앞뒤를 이어 주는 말 뒤예요. 한 뜻이 끝났으니 여기서 쉬어요.',
    phrase: '여기서 뜻 덩어리가 바뀌어요. 「누가」 다음, 「어디서·언제」 다음처럼 한 뜻이 끝나는 자리예요.',
  };

  /* ── 여기서는 «왜» 붙여 읽는가 — 군더더기 경계의 이유 ──
     reading/chunk.mjs 의 NO_BREAK 목록을 옮겼다. 순서가 곧 우선순위다. */
  var NUM = /^(?:[0-9][0-9,.]*|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|백|천|만|몇|수십|수백)$/;
  var DET = /^(?:그|이|저|각|매|여러|모든|어떤|무슨|새|옛|온|온갖|약|총|단|제|첫|어느|아무|다른|같은|이런|저런|그런)$/;
  var ADV = /^(?:매우|아주|훨씬|더욱|가장|잘|못|안|크게|널리|특히|오래|함께|서로|다시|늘|자주|항상|이미|곧|점점|더|덜|거의|전혀|충분히|빠르게|천천히|제대로|직접|스스로|서서히|급격히|꾸준히|실제로|주로|흔히|대체로|보통|가끔|계속|결국|반드시|비로소|아직|여전히|오히려|이렇게|그렇게|무척|참|정말|너무|다|막|살짝|꼭|얼른|어서|빨리|가만히|조용히|열심히|많이|조금|약간|일찍|늦게|먼저|같이|바로|금방|그냥|자꾸|문득|마침내|드디어|함부로|괜히)$/;
  /* 용언의 관형형·관형사형 — 뒤 명사를 꾸민다. 어미 확률로는 못 가른다(「높은」의 은과 「값은」의 은).
     그래서 낱말 전체(어휘)로 적는다. -는 꼴은 조사 「는」과 헷갈리는 낱말(나는·사는·서는)을 빼고 동사만 넣었다. */
  var ADN = /^(?:.*(?:하는|되는|하던|되던|이던|있던|없던|스러운|스런|다운|로운)|.+(?:한|된|할|될|왔던|갔던)|(?:높|낮|많|적|좋|넓|깊|얕|짧|밝|굵|붉|늦|드문|드물|검|희|작|젊|늙|굳|맑|흐린|시원|따뜻|차가|뜨거|즐거|무서|반가|외로|괴로|그리|가벼|무거|부드러|어두|어려|쉬|아름다|가까)(?:은|운|는)|(?:작은|큰|긴|먼|아닌|않은|남은|알맞은|옳은|빠른|느린|강한|약한|나쁜|이른|늦은|넓은|좁은|어린|새로운|중요한|필요한|가능한|다양한|뚜렷한|분명한|간단한|주요한|커다란|조그만|자그마한|기다란|둥근|네모난|파란|빨간|노란|하얀|까만|푸른|이런|저런|그런|어떤|모든|여러)|.*(?:있는|없는|오는|먹는|읽는|쓰는|주는|만드는|부르는|자라는|듣는|웃는|뛰는|달리는|흐르는|내리는|모이는|열리는|닫히는|보이는|들리는|알려진|불리는|쓰이는|잡는|찾는|배우는|가르치는|사라지는|나타나는|생기는|일어나는|말하는|생각하는|바라는|앉는|눕는|입는|신는|씻는|짓는|걷는|넘는|밟는|묶는|심는|담는|꺾는|씹는|잇는|긋는|낫는))$/;
  var ADN_NOT = /(?:에서는|에게는|으로는|로는|까지는|부터는|보다는|처럼은|마다|나는|우리는|너는|저는|자는|기는|지는|도는|서는|사는|타는|노는|피는|부는|가는|보는|우는|이는|내는)$/;
  var DEP_HEAD = /^(?:할|될|갈|올|볼|들|낼|쓸|살|알|줄|먹을|읽을|만들|가르칠|배울|볼|앉을|설|탈|쉴|놀|잘)$/;
  var JOSA = '(?:이|가|은|는|을|를|도|만|의|에|에서|에게|으로|로|와|과|랑|까지|부터|보다|처럼|마다|이다|이며|이고|입니다|이라|라도|이야|야|이에요|예요|이지|지)?';
  var TAIL = '[,.…!?」』’”\'"\\)\\]]*$';
  var wordRe = function (list) { return new RegExp('^(?:' + list + ')' + JOSA + TAIL); };
  var DEP = wordRe('것|수|줄|바|데|때|채|뿐|만큼|따름|나름|터|점|편|즈음|무렵|때문|나위|셈|턱|적|지|리|법|양|척|체|만');
  var DEP2 = /^(?:같다|같은|같이|듯|만하)/;
  var UNIT = wordRe('개|명|일|년|월|시간|분|초|배|퍼센트|도|권|장|쪽|벌|곳|번|살|세|마리|송이|그루|켤레|잔|병|칸|층|미터|킬로미터|센티미터|밀리미터|리터|킬로그램|그램|원|가지|사람|살|주|주일|달|해|바퀴|걸음|시|번째|등|위|점|줌|모|국자|척|대|채|줄|가닥|봉지|상자|통|컵|숟가락|알|톨|방울|조각|편|곡|줄기');
  var UNIT2 = wordRe('이상|이하|미만|초과|정도|가량|남짓|안팎|쯤');
  var AUX = new RegExp(
    '^(?:(?:주|가|오|보|두|놓|버리|내|지|대|있|없|말|드리|싶|않|못하|하|되)' +
    '(?:는|고|며|면|서|어|아|여|기|지|도|야|니|을|은|다|었|았|자|던|으|게|요|습니다|어요|아요|네요|죠|ㄹ)' +
    '|(?:준|간|온|본|둔|낸|진|줄|갈|올|볼|둘|낼|질|줘|봐|둬|와|마는|만다|싶다|싶은|싶어|않다|않은|않아|않고|않으면|못한|못하|한다|합니다|해요|했다|된다|됩니다|돼요|됐다))');

  var CUT_WHY = {
    adn: function (c, n) { return '「' + c + '」은(는) 뒤의 「' + n + '」을(를) 꾸며 주는 말이에요. 꾸며 주는 말과 꾸밈 받는 말은 붙여 읽어요.'; },
    adv: function (c, n) { return '「' + c + '」은(는) 뒤의 말을 꾸며 주는 말(부사)이에요. 「' + c + ' ' + n + '」을(를) 한 덩어리로 읽어요.'; },
    num: function (c, n) { return '「' + c + ' ' + n + '」 — 수와 단위는 한 덩어리예요.'; },
    dep: function (c, n) { return '「' + n + '」은(는) 혼자 못 서는 말이라 앞말에 붙여요. 「' + c + ' ' + n + '」이 한 덩어리예요.'; },
    aux: function (c, n) { return '「' + c + ' ' + n + '」은(는) 하나의 움직임이에요. 붙여 읽어요.'; },
    det: function (c, n) { return '「' + c + '」은(는) 뒤의 「' + n + '」을(를) 가리키는 말이에요. 붙여 읽어요.'; },
    fine: function (c, n) { return '「' + c + ' ' + n + '」은(는) 한 뜻이에요. 너무 잘게 끊으면 뜻이 흩어져요. 앞뒤를 붙여 읽어 보세요.'; },
  };

  /* 어절 i 뒤에서 끊으면 왜 «틀린» 자리인가 — 문법이 막는 곳만 본다. 막는 이유가 없으면 null. */
  function whyNotCut(ws, i) {
    if (i >= ws.length - 1) return { tag: 'end', why: '마지막 어절 뒤는 끊는 자리가 아니에요.' };
    var cur = String(ws[i]).trim(), next = String(ws[i + 1]).trim();
    var bare = cur.replace(new RegExp(TAIL), '');
    if (/[,.!?…]$/.test(bare) || RE_SENT.test(cur) || RE_COMMA.test(cur)) return null;   /* 문장부호 뒤는 언제나 끊어도 된다 */
    if (NUM.test(bare) && (UNIT.test(next) || UNIT2.test(next))) return { tag: 'num', why: CUT_WHY.num(cur, next) };
    if (NUM.test(bare)) return { tag: 'num', why: CUT_WHY.num(cur, next) };
    if (DET.test(bare)) return { tag: 'det', why: CUT_WHY.det(cur, next) };
    if (ADV.test(bare)) return { tag: 'adv', why: CUT_WHY.adv(cur, next) };
    /* 보조용언 짝 — 의존명사보다 먼저 본다(「싶다」가 의존명사 목록과 겹친다).
       「-고 싶다·-고 있다·-고 나서」 「-지 않다·-지 못하다」 「-게 되다·-게 하다」 「-어야 하다」 는 두 어절이 한 서술어다.
       「-고」는 절을 잇는 연결어미이기도 해서(「밥을 먹고 ∕ 이를 닦는다」) 뒷말이 보조용언일 때만 막는다. */
    if (/고$/.test(bare) && /^(?:싶|있|없|말[았아겠]|나[서니면]|계시|계셨)/.test(next)) return { tag: 'aux', why: CUT_WHY.aux(cur, next) };
    if (/지$/.test(bare) && /^(?:않|못하|못했|말)/.test(next)) return { tag: 'aux', why: CUT_WHY.aux(cur, next) };
    if (/게$/.test(bare) && /^(?:되|됐|돼|하|했|해|만들)/.test(next)) return { tag: 'aux', why: CUT_WHY.aux(cur, next) };
    if (/야$/.test(bare) && /^(?:하|한다|합니다|해|했|된다|됩니다|돼)/.test(next)) return { tag: 'aux', why: CUT_WHY.aux(cur, next) };
    if (/[아어해여워와봐줘혀려켜쳐펴]$/.test(bare) && AUX.test(next)) return { tag: 'aux', why: CUT_WHY.aux(cur, next) };
    if (DEP_HEAD.test(bare) || (DEP.test(next) && !/^(?:바로|때로|데로|점점|편지|편의|만약|만일|양쪽|양파|법을|법이|법도|법대로|체로|척척|리듬|리본|채소|채널|터널|터전|점심|점수|점원|셈이|셈을|적어도|적당|적극|지금|지도|지구|지역|지난|지붕|지혜|줄넘기|줄기|수학|수업|수영|수많|수십|수백|수천|것들)/.test(next)) || (DEP2.test(next) && !/(?:면|고|서|며|자|니까|는데|은데|지만|도록|다가|려면|어|아|다\.|요\.)$/.test(bare))) return { tag: 'dep', why: CUT_WHY.dep(cur, next) };
    if (UNIT2.test(next)) return { tag: 'num', why: CUT_WHY.num(cur, next) };
    if (/^(?:것|수|줄|바|리|나위|턱|셈)(?:이|가|은|는|을|를|도|만)?$/.test(bare) && /^(?:있|없|아니|이다|이며)/.test(next)) return { tag: 'dep', why: CUT_WHY.dep(cur, next) };
    if (ADN.test(bare) && !ADN_NOT.test(bare)) return { tag: 'adn', why: CUT_WHY.adn(cur, next) };
    return null;
  }

  /* 채점 결과에 이유를 붙인다 — 화면과 복습 태그가 같은 목록을 쓴다.
     군더더기 경계에 문법상 이유가 없으면 'fine'(너무 잘게 끊음)으로 둔다. */
  function explain(text, model, marks) {
    var ws = words(text), r = score(model, marks, text), notes = [];
    r.neutral.forEach(function (i) {
      notes.push({ i: i, kind: 'neutral', tag: 'ok:comma', why: '쉼표 뒤에서 쉬어도 괜찮아요. 모범은 이어 읽었지만 틀린 건 아니에요.', at: ws[i].trim() });
    });
    r.missed.forEach(function (i) {
      var kind = classifyBoundary(ws, i);
      notes.push({ i: i, kind: 'miss', tag: 'miss:' + kind, why: BOUNDARY_WHY[kind], at: ws[i].trim() });
    });
    r.extras.forEach(function (i) {
      var w = whyNotCut(ws, i);
      var tag = w ? w.tag : 'fine';
      notes.push({ i: i, kind: 'extra', tag: 'extra:' + tag, why: w ? w.why : CUT_WHY.fine(ws[i].trim(), (ws[i + 1] || '').trim()), at: ws[i].trim() });
    });
    notes.sort(function (a, b) { return a.i - b.i; });
    r.notes = notes;
    r.tags = notes.filter(function (n) { return n.kind !== 'neutral'; }).map(function (n) { return n.tag; });
    return r;
  }

  /* 태그 → 사람이 읽는 이름 (복습 탭 「약한 규칙」) */
  var TAG_LABEL = {
    'miss:sent': '문장 끝에서 쉬기', 'miss:comma': '쉼표에서 쉬기', 'miss:conn': '이어 주는 말(-고·-면·-지만) 뒤에서 쉬기', 'miss:phrase': '뜻 덩어리가 바뀌는 곳 찾기',
    'extra:adn': '꾸며 주는 말은 붙여 읽기', 'extra:adv': '부사는 뒤의 말과 붙여 읽기', 'extra:num': '수와 단위 붙여 읽기', 'extra:dep': '혼자 못 서는 말 붙여 읽기',
    'extra:aux': '보조 동작 붙여 읽기', 'extra:det': '가리키는 말 붙여 읽기', 'extra:fine': '너무 잘게 끊지 않기',
  };

  /* ── 문장 단위 ── 유치·초1~2는 문단이 아니라 문장 하나씩 연습한다.
     조각 배열을 문장별 조각 배열로 묶는다. 문장 끝 조각 = 끝이 .!? 로 끝나는 조각. */
  function sentencesOf(segs) {
    var out = [], cur = [];
    segs.forEach(function (s) {
      cur.push(s);
      if (RE_SENT.test(String(s).trim())) { out.push(cur); cur = []; }
    });
    if (cur.length) out.push(cur);
    return out;
  }

  /* 조각 통계 — 콘텐츠 검사와 기록 화면이 쓴다 */
  function stats(segs) {
    var lens = segs.map(function (s) { return words(s).length; });
    var sum = lens.reduce(function (a, b) { return a + b; }, 0);
    return { n: lens.length, words: sum, avg: lens.length ? Math.round(sum / lens.length * 100) / 100 : 0, max: lens.length ? Math.max.apply(null, lens) : 0, over8: lens.filter(function (x) { return x > 8; }).length };
  }

  /* ── 표시 문자열 ↔ 조각 (출력·복사·교사가 붙여 넣는 글) ──
     「나는 ∕ 학교에 갔다.」 처럼 ∕ 나 / 로 표시한 글을 조각 배열로 돌린다. 슬래시 앞뒤 공백은 앞 조각의 끝 공백 하나로 정리한다. */
  function toMarked(segs, sym) {
    sym = sym || '∕';
    return segs.map(function (s) { return String(s).replace(/\s+$/, ''); }).join(' ' + sym + ' ');
  }
  function fromMarked(text, sym) {
    var t = String(text || '').replace(/\r/g, '');
    var paras = t.split(/\n\s*\n/).map(function (p) { return p.replace(/\n/g, ' ').trim(); }).filter(Boolean);
    return paras.map(function (p) {
      var parts = p.split(/\s*[∕\/]+\s*/).map(function (x) { return x.trim(); }).filter(Boolean);
      return parts.map(function (x, i) { return i < parts.length - 1 ? x + ' ' : x; });
    });
  }

  /* 밴드 밖의 조각은 규격에서 벗어난 것 — 콘텐츠 검사·교사 글 검사에 쓴다 */
  function check(segs, band) {
    var b = BANDS[band] || BANDS.M, out = [];
    var joined = segs.join('');
    segs.forEach(function (s, i) {
      if (!String(s).trim()) out.push('빈 조각(' + i + ')');
      if (i < segs.length - 1 && !/\s$/.test(s)) out.push('조각 ' + i + ' 이 공백으로 끝나지 않아요 — 이어붙이면 낱말이 붙어요: 「' + s + '」');
      var n = words(s).length;
      if (n > b.max) out.push('조각 ' + i + ' 이 ' + n + '어절 — ' + b.label + ' 상한 ' + b.max + '어절을 넘어요: 「' + s.trim() + '」');
    });
    var ws = words(joined), mb = modelBoundaries(segs);
    mb.forEach(function (i) { var w = whyNotCut(ws, i); if (w && w.tag !== 'end') out.push('경계 「' + ws[i].trim() + ' ∕ ' + (ws[i + 1] || '').trim() + '」 — ' + w.why + ' (' + w.tag + ')'); });
    return out;
  }

  return {
    BANDS: BANDS, BAND_ORDER: BAND_ORDER, bandOfGrade: bandOfGrade, nextBand: nextBand, prevBand: prevBand,
    words: words, wordCount: wordCount, modelBoundaries: modelBoundaries, segsFromBoundaries: segsFromBoundaries,
    score: score, classifyBoundary: classifyBoundary, whyNotCut: whyNotCut, explain: explain,
    BOUNDARY_WHY: BOUNDARY_WHY, TAG_LABEL: TAG_LABEL, sentencesOf: sentencesOf, stats: stats,
    toMarked: toMarked, fromMarked: fromMarked, check: check,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBCHUNK;
