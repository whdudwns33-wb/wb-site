'use strict';
/* 의미 단위 끊어 읽기 — 초안 생성기 (집필 보조 도구, 앱 코드 아님)
 *
 *   node reading/chunk.mjs --band L3 "바닷물의 온도가 평년 값보다 …"
 *   echo "문단 …" | node reading/chunk.mjs --band L4
 *   node reading/chunk.mjs --eval          사람이 끊은 6,025조각과 대조
 *   node reading/chunk.mjs --selftest      규칙만 확인 (망·데이터 불필요)
 *
 * ── 이 도구의 위치 ────────────────────────────────────────
 * 이건 **초안**이다. 사람 손질이 전제다.
 * 실측(--eval)으로 사람 판단과 약 3/4쯤 일치한다. 나머지 1/4은 글의 뜻을
 * 알아야 갈리는 자리라 규칙으로는 못 잡는다. 예를 들어
 *   「그 결과 바다에서도 ∕ 육지의 폭염에 해당하는 ∕ 극한 현상이 나타나는데,」
 * 를 두 조각으로 할지 세 조각으로 할지는 앞 문단과의 호흡이 정한다.
 *
 * 그래서 쓰는 법은 하나다 — **돌려서 초안을 얻고, 사람이 고친다.**
 * 고친 결과가 최종이고, content.test.cjs 가 무결성을 본다.
 * 규칙 자체는 docs/의미단위-끊어읽기-규격.md 에 적어 두었다.
 *
 * ── 지키는 것 ─────────────────────────────────────────────
 *  · join('') === 원문  (글자 하나도 잃지 않는다)
 *  · 조각 경계는 항상 어절 경계 — 낱말 중간을 자르지 않는다
 *  · 학년대별 어절 예산: L1 3~5 · L2 3~5 · L3 4~6 · L4 4~7
 */

/* ── 학년대별 목표 어절 수 ───────────────────────────────
   사람이 끊은 것의 평균이다. max 는 90분위에서 왔다. */
/* 학년대별 눈금 — target·max 는 규격서 2장, 나머지 넷은 거기에 맞춰 보정한 값이다.
 *
 *   target  목표 어절 수 (규격서 표)
 *   max     한 조각 최대 어절 수. 규격서가 「8어절 넘으면 거의 항상 쪼갤 자리가 있다」
 *           고 못박았으므로 8을 넘기지 않는다.
 *   W       경계 품질을 길이보다 얼마나 무겁게 볼 것인가
 *   CUT     끊을 때마다 무는 삯. 이게 0 이면 조금이라도 그럴듯한 자리마다 끊어
 *           조각이 잘게 부서진다 — 예전에 정밀도가 57%밖에 안 됐던 이유다.
 *   exp     확률을 몇 제곱해서 쓸 것인가. 2 는 애매한 자리를 너무 눌렀다.
 *   longW   긴 조각 쪽 벌점 배율. 사람은 짧은 조각보다 긴 조각을 더 봐준다.
 *
 * 고르는 방법 — F1 을 직접 좇지 않았다. 우리 코퍼스는 끊기 스타일이 두 갈래로
 * 갈려 있어(아래 주석) F1 이 어느 쪽을 재는지에 따라 달라진다. 대신 «출력 길이
 * 분포를 규격에 맞추고, 8어절 초과를 0으로» 를 조건으로 걸고 그 안에서 F1 이
 * 높은 값을 골랐다. 결과적으로 두 갈래 모두에서 F1 이 올랐다. */
export const BANDS = {
  L1: { target: 3.3, max: 6, W: 20, CUT: 2, exp: 1.5, longW: 0.55 },
  L2: { target: 3.7, max: 7, W: 28, CUT: 4, exp: 1.5, longW: 0.7 },
  L3: { target: 4.1, max: 8, W: 28, CUT: 4, exp: 1.5, longW: 0.85 },
  L4: { target: 4.5, max: 8, W: 34, CUT: 6, exp: 1.5, longW: 1 },
};

/* ── 끊을 자리 점수 — 우리가 끊은 것에서 배웠다 ────────────
   손으로 규칙을 쓰다가 「높은」을 주격 조사로 오인해 관형어를 갈랐다.
   그래서 사람이 실제로 끊은 6,025조각을 세어, 어절 끝 1~3글자마다
   「여기서 끊긴 비율」을 구했다. 값이 곧 점수다.

   표에 넣는 기준 — 15회 이상 나오고, 서로 다른 낱말 5개 이상에 걸칠 것.
   두 번째 조건이 없으면 「네스코」「26년」 같은 내용어를 외워 버린다.
   문법 어미만 남기려는 장치다.

   articles.json 이 늘면 `node reading/chunk.mjs --retrain` 으로 다시 배운다. */
const BASE_RATE = 0.22;                    /* 아무 정보 없을 때의 끊김률 */
const SUFFIX = {
  "간다.":0.78,"긴다.":0.82,"난다.":0.71,"는다.":0.94,"된다.":0.65,"든다.":0.92,"른다.":0.8,"아요.":0.84,
  "았다.":0.76,"어요.":0.77,"었다.":0.77,"에서는":0.3,"에요.":0.76,"였다.":0.72,"으로,":1,"이다.":0.69,
  "이라는":0.2,"인다.":0.83,"적으로":0.07,"져요.":0.6,"졌다.":0.86,"진다.":0.76,"하다.":0.71,"한다.":0.83,
  "한다는":0.25,"해요.":0.57,"했다.":0.8,"힌다.":0.8,"」,":0,"3년":0.11,"가,":0.39,"거나":0.26,"고,":0.99,
  "기는":0.34,"기도":0,"까지":0.18,"나는":0.13,"내는":0.4,"는지":0.35,"다고":0.15,"다는":0.11,"다면":0.84,
  "단은":0.11,"대로":0.02,"대를":0.29,"대한":0.16,"도,":0.67,"도는":0.08,"되지":0,"들은":0.32,"들이":0.32,
  "라고":0.03,"려는":0.13,"려면":0.74,"로,":0.91,"료를":0.3,"리고":0.09,"마다":0.27,"만,":0.97,"며,":0.98,
  "면서":0.8,"물은":0.11,"물을":0.25,"보는":0.1,"부가":0,"부는":0.11,"사가":0,"사는":0.41,"사를":0.3,"상이":0.2,
  "서도":0.53,"수가":0.31,"식이":0.33,"어,":1,"어서":0.69,"어진":0.19,"에게":0.14,"에는":0.41,"원이":0.24,
  "이고":0.53,"이에":0,"인이":0,"장을":0.05,"장이":0.33,"적인":0,"정을":0.26,"정한":0,"제는":0.05,"지를":0.2,
  "지만":0.58,"지면":0.67,"하고":0.34,"하지":0,"해서":0.47,"해야":0,"화를":0.22,",":0.78,".":0.77,"가":0.14,
  "간":0.09,"개":0.06,"게":0.05,"계":0,"고":0.24,"과":0.13,"구":0,"국":0,"권":0,"금":0,"기":0.01,
  "긴":0.08,"길":0,"나":0.18,"난":0,"날":0,"내":0.11,"낸":0.05,"낼":0,"년":0.03,"는":0.22,"다":0.17,
  "단":0,"대":0.03,"던":0.08,"데":0.24,"도":0.22,"된":0.1,"든":0.07,"라":0.32,"래":0.04,"럼":0.32,
  "려":0.16,"로":0.11,"록":0.37,"료":0.06,"른":0,"를":0.12,"리":0.01,"린":0.05,"만":0.16,"며":0.48,
  "면":0.56,"무":0,"물":0,"백":0,"사":0,"산":0,"상":0,"서":0.24,"선":0,"섯":0,"성":0,"소":0,"속":0,
  "스":0.07,"시":0.06,"식":0,"신":0.35,"아":0.1,"안":0.24,"야":0.08,"어":0.22,"업":0,"에":0.13,"여":0.14,
  "온":0.03,"와":0.14,"용":0,"운":0.03,"울":0.04,"원":0,"월":0.12,"은":0.22,"을":0.13,"음":0,"의":0.07,
  "이":0.11,"인":0.1,"일":0.04,"자":0.06,"장":0,"재":0,"적":0,"전":0.02,"점":0,"정":0,"제":0,"져":0.14,
  "주":0,"지":0.09,"진":0.05,"질":0,"차":0,"체":0.04,"쳐":0.42,"터":0.14,"한":0.08,"할":0.02,"해":0.44,
  "혀":0.14,"형":0,"화":0,"히":0.01
};

/* ── 끊으면 안 되는 자리 ─────────────────────────────────
   확률이 알려 주지 못하는, 두 어절이 한 덩어리인 경우.
   규격서 3장 「절대 하지 않는 것」을 그대로 옮겼다. */
const NO_BREAK_AFTER = [
  /^[0-9][0-9,.]*$/,                       /* 「5」 + 「일」 — 수와 단위 */
  /^(그|이|저|각|매|한|두|세|네|여러|모든|다른|같은|어떤|무슨|새|옛|온|온갖|약|총|단|제)$/,
  /(할|될|갈|올|볼|들|낼|쓸)$/,             /* 뒤에 의존명사가 온다 */
  /* 부사는 뒤의 용언에 붙는다. 코퍼스에서 부사 뒤 끊김률 1.7% — 기저 22.3% 의 1/13.
     이걸 안 막으면 「평년 값보다 매우 ∕ 높은」 처럼 갈라 놓는다. */
  /^(매우|아주|훨씬|더욱|가장|잘|못|안|크게|널리|특히|오래|함께|서로|다시|늘|자주|항상|이미|곧|점점|더|덜|거의|전혀|충분히|빠르게|천천히|제대로|직접|스스로|서서히|급격히|꾸준히|실제로|주로|흔히|대체로|약|보통|가끔|계속|결국|반드시|비로소|아직|여전히|오히려|이렇게|그렇게|무척)$/,
  /* 용언의 관형형 — 뒤 명사를 꾸민다. 코퍼스에서 높은(0/15)·작은(0/15)·많은(1/23)처럼
     거의 끊기지 않는다. 어미 확률로는 못 가른다 — 「높은」의 은과 「값은」의 은이 같은
     글자라 통계가 섞인다. 그래서 이건 어휘 지식으로 따로 적는다. */
  /^(높|낮|많|적|좋|넓|깊|얕|짧|밝|굵|붉|늦|드문|드물)은$/,
  /^(같|다른|새로운|어려운|쉬운|아닌|않은|남은|알맞은|옳은|빠른|느린|강한|약한)은?$/,
  /^(작은|큰|긴|어두운|아름다운|가까운|먼|중요한|필요한|가능한|다양한|뚜렷한|분명한|간단한|주요한)$/,
  /* 의존명사 단독 어절 뒤에는 서술어가 따라붙는다 — 「쓸 수 ∕ 있는」 을 막는다.
     NO_BREAK_BEFORE 는 이 낱말 «앞» 을 막을 뿐 «뒤» 는 못 막았다. */
  /^(수|것|줄|바|리|나위|턱|터|셈|따름|나름|무렵|즈음)$/,
];
/* ── 앞뒤가 짝을 이뤄야만 알 수 있는 자리 ──
   보조용언이 대표다. 「말해 + 준다」·「다해 + 가는」·「밟아 + 본」 은 두 어절이지만
   하나의 서술어라 가르면 안 된다. 앞말만 보거나 뒷말만 봐서는 못 가른다 —
   「말해」 뒤가 늘 붙는 것도 아니고(「말해, 그러면」), 「준다」 앞이 늘 붙는 것도
   아니다(「선물을 준다」). 그래서 짝으로 적는다. */
/* 보조용언의 «낱말 전체» — 앞머리만 보면 「내성」이 「내다」로, 「지구」가 「지다」로,
   「가동을」이 「가다」로 걸린다(코퍼스에서 실제로 그랬다). 어간과 어미를 함께 본다.
   두 번째 줄은 줄임꼴(준·온·본·둔…)이라 어미가 붙지 않는다. */
const AUX = new RegExp(
  '^(?:(?:주|가|오|보|두|놓|버리|내|지|대|있|없|말|드리)' +
  '(?:는|고|며|면|서|어|아|여|기|지|도|야|니|을|은|다|었|았|자|던|으)' +
  '|(?:준|간|온|본|둔|낸|진|줄|갈|올|볼|둘|낼|질|줘|봐|둬|와|마는|만다))');
const NO_BREAK_PAIR = [
  [/[아어해여워]$/, AUX],
  /* 「할 수 ∕ 있는」·「그런 것이 ∕ 아니다」 — 의존명사 뒤의 서술어.
     앞말을 안 보고 「있」으로 시작하는 것을 다 막으면 「줄이는 일과 ∕ 있는 열을」
     처럼 멀쩡한 관형형까지 못 끊는다. 그래서 짝으로만 막는다. */
  [/^(것|수|줄|바|리|나위|턱|셈)(이|가|은|는|을|를|도|만)?$/, /^(있|없|아니|이다|이며)/],
];
/* 조사만 붙을 수 있게 묶는다. 예전에는 앞머리만 봐서 「수십」이 의존명사 「수」로,
   「개방이」가 단위 「개」로, 「분야」가 「분」으로 잘못 걸렸다. 그러면 멀쩡한 자리를
   끊지 못한다 — 실제로 「이 세 가지를 오가며 ∕ 수십 명이」 를 막고 있었다. */
const JOSA = '(?:이|가|은|는|을|를|도|만|의|에|에서|에게|으로|로|와|과|랑|까지|부터|보다|처럼|마다|이다|이며|이고|입니다|이라|라도)?';
const TAIL = '[,.…」』’”\'"\\)\\]]*$';
const word = (list) => new RegExp('^(?:' + list + ')' + JOSA + TAIL);
const NO_BREAK_BEFORE = [
  /* 의존명사 — 앞말 없이는 뜻이 서지 않는다 */
  word('것|수|줄|바|리|데|때|채|뿐|만큼|따름|나름|터|점|편|즈음|무렵|때문|나위|셈|턱'),
  /* 앞말에 매달리는 말 — 「부정맥 ∕ 같은」·「하는 ∕ 듯」·「할 ∕ 만하다」.
     있/없/아니 는 NO_BREAK_PAIR 로 옮겼다 — 앞말을 봐야 갈린다. */
  /^(같다|같은|듯|만하)/,
  /* 단위 — 「5 ∕ 일」 로 갈리면 안 된다 */
  word('개|명|일|년|월|시간|분|초|배|퍼센트|도|℃|%|kg|km|m|권|장|쪽|벌|곳|번|살|세'),
  word('이상|이하|미만|초과|정도|가량|남짓|안팎'),
];

/** 지문 묶음에서 어미별 끊김 확률을 배운다 — --retrain 과 --holdout 이 쓴다.
 *  표에 넣는 기준: 15회 이상 · 서로 다른 낱말 5개 이상 (내용어 암기 방지). */
export function learnSuffix(articles) {
  const brk = new Map(), non = new Map(), forms = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const a of articles) {
    for (const b of Object.values(a.levels)) {
      for (const p of b.paragraphs) {
        const text = p.join('');
        const cuts = new Set(); let c = 0;
        for (let i = 0; i < p.length - 1; i++) { c += p[i].length; cuts.add(c); }
        for (const m of text.matchAll(/\S+\s*/g)) {
          const w = m[0].trim(); if (!w) continue;
          const tgt = cuts.has(m.index + m[0].length) ? brk : non;
          for (const k of [1, 2, 3]) {
            if (w.length < k) continue;
            const suf = w.slice(-k);
            bump(tgt, suf);
            if (!forms.has(suf)) forms.set(suf, new Set());
            forms.get(suf).add(w);
          }
        }
      }
    }
  }
  const raw = {};
  for (const suf of new Set([...brk.keys(), ...non.keys()])) {
    const b = brk.get(suf) || 0, n = non.get(suf) || 0;
    if (b + n < 15) continue;
    if ((forms.get(suf) || new Set()).size < 5) continue;
    raw[suf] = Math.round((b / (b + n)) * 100) / 100;
  }
  const out = {};
  for (const suf of Object.keys(raw).sort((x, y) => x.length - y.length)) {
    const par = suf.length > 1 ? suf.slice(1) : null;
    if (par && out[par] !== undefined && Math.abs(raw[suf] - out[par]) < 0.08) continue;
    out[suf] = raw[suf];
  }
  return out;
}

const SENT = '\u0000';   /* 소수점을 잠시 가려 두는 표식 */

/** 문장으로 나눈다. 소수점을 문장 끝으로 오인하지 않는다 —
 *  예전에 「87.3 percent」에서 글자가 샜다. */
export function sentences(text) {
  const guarded = String(text).replace(/(?<=\d)\.(?=\d)/g, SENT);
  const out = guarded.match(/[^.!?]*[.!?]+(?:\s+|$)/g) || [];
  const rest = guarded.slice(out.join('').length);
  if (rest) out.push(rest);
  const restored = out.map(s => s.replace(new RegExp(SENT, 'g'), '.'));
  if (restored.join('') !== String(text)) throw new Error('문장 분리에서 글자가 샜다');
  return restored;
}

/** 어절 단위로 자른다. 뒤따르는 공백을 어절 끝에 붙여 둔다.
 *  이미 끊어 둔 조각을 손볼 때도 같은 잣대를 쓰라고 내보낸다. */
export function words(s) {
  return s.match(/\S+\s*/g) || (s ? [s] : []);
}

/* --holdout 이 표를 갈아끼울 때 쓴다 */
let ACTIVE = SUFFIX;
export function useSuffixTable(t) { ACTIVE = t || SUFFIX; }

/** i번째 어절 뒤에서 끊을 만한가 — 0(불가) ~ 1(거의 항상 끊는 자리) */
/** 어절 i 뒤에서 끊길 만한 정도 (0 = 끊으면 안 되는 자리).
 *  이미 끊어 둔 조각을 손볼 때도 같은 잣대를 쓰라고 내보낸다. */
/** 여기서 끊으면 «틀린» 자리인가 — 문법이 막는 곳만 본다.
 *
 *  확률이 0 인 것과는 다르다. 예를 들어 「이상」은 끝 글자 「상」의 학습된 끊김률이
 *  0이라 breakScore 가 0을 주지만, 「세 그루 이상 ∕ 볼 수 있는가」는 멀쩡한 자리다.
 *  «드물다» 와 «틀렸다» 를 섞으면 사람이 고른 자리를 잘못 물리게 된다. */
export function forbidden(ws, i) {
  if (i >= ws.length - 1) return '마지막 어절 뒤';
  const cur = ws[i].trim(), next = ws[i + 1].trim();
  if (!/\s$/.test(ws[i])) return '원문에 띄어쓰기가 없다';
  /* 「한」은 두 가지다. 관형사(「한 개」)면 뒤에 붙고, 의존명사(「남아 있는 한」)면
     거기서 끊긴다. 앞 어절이 관형형(-는/-은/-을)이면 뒤엣것이다. */
  const dependentHan = cur === '한' && i > 0 && /[는은을ㄹ]$/.test(ws[i - 1].trim());
  if (!dependentHan && NO_BREAK_AFTER.some(re => re.test(cur))) return `「${cur}」 뒤에는 붙는 말이 온다`;
  if (NO_BREAK_BEFORE.some(re => re.test(next))) return `「${next}」 는 앞말에 매달린다`;
  if (NO_BREAK_PAIR.some(([a, b]) => a.test(cur) && b.test(next))) return `「${cur} ${next}」 는 한 덩어리다`;
  return null;
}

export function breakScore(ws, i) {
  if (forbidden(ws, i)) return 0;
  const cur = ws[i].trim();
  /* 긴 어미부터 — 구체적인 쪽이 정확하다 */
  for (const k of [3, 2, 1]) {
    if (cur.length < k) continue;
    const v = ACTIVE[cur.slice(-k)];
    if (v !== undefined) return v;
  }
  return BASE_RATE;
}

/** 어절 배열을 조각으로 나눈다 — 동적 계획법.
 *
 *  탐욕적으로 「가장 좋은 자리에서 반씩」 가르면 길이가 들쭉날쭉해진다.
 *  문단 전체를 놓고 「목표 길이에서 벗어난 정도 − 경계 품질」의 합이
 *  가장 작아지는 조합을 고른다.
 *
 *   비용(i..j 한 조각) = (어절수 − target)²
 *   경계 보상          = BOUNDARY_WEIGHT × 그 자리의 끊김 확률
 */
function splitWords(ws, band) {
  const n = ws.length;
  if (n <= 1) return [ws];
  const { target, max, W, CUT, exp, longW } = band;

  const best = new Array(n + 1).fill(Infinity);
  const from = new Array(n + 1).fill(-1);
  best[0] = 0;

  for (let j = 1; j <= n; j++) {
    for (let i = Math.max(0, j - max); i < j; i++) {
      if (best[i] === Infinity) continue;
      /* i..j-1 을 한 조각으로 삼는다 */
      const d = j - i - target;
      /* 목표보다 긴 쪽은 덜 벌한다 — 사람도 긴 조각을 더 봐준다 */
      let cost = d >= 0 ? longW * d * d : d * d;
      /* 이 조각이 끝나는 자리(j-1 뒤)의 품질. 문단 끝은 공짜. */
      if (j < n) {
        const q = breakScore(ws, j - 1);
        if (q === 0) continue;                  /* 끊으면 안 되는 자리 */
        cost += CUT - W * Math.pow(q, exp);     /* 끊는 삯을 내고, 자리값만큼 돌려받는다 */
      }
      if (best[i] + cost < best[j]) { best[j] = best[i] + cost; from[j] = i; }
    }
  }
  if (best[n] === Infinity) return [ws];        /* 어디서도 못 끊는다 */

  const cuts = [];
  for (let j = n; j > 0; j = from[j]) cuts.unshift([from[j], j]);
  return cuts.map(([i, j]) => ws.slice(i, j));
}

/**
 * 문단 하나를 의미 단위 조각으로 끊는다.
 * @param {string} text  문단 원문
 * @param {string} bandName  'L1' | 'L2' | 'L3' | 'L4'
 * @returns {string[]}  join('') === text 를 반드시 만족한다
 */
export function chunk(text, bandName = 'L3') {
  const band = BANDS[bandName];
  if (!band) throw new Error(`모르는 학년대: ${bandName}`);
  const out = [];
  for (const sent of sentences(text)) {
    /* 문장 끝에서는 반드시 끊는다 — 규격서 3장 1번 */
    for (const part of splitWords(words(sent), band)) out.push(part.join(''));
  }
  const joined = out.join('');
  if (joined !== String(text)) throw new Error('이어붙이기가 원문과 다르다 — 버그');
  return out.filter(Boolean);
}

/* ─────────────────────── CLI ─────────────────────── */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const argv = process.argv.slice(2);
  const bandOf = () => { const i = argv.indexOf('--band'); return i >= 0 ? argv[i + 1] : 'L3'; };

  if (argv.includes('--selftest')) {
    /* 망도 데이터도 없이 도는 검사. 규칙을 손대면 여기부터 돌린다. */
    let fail = 0;
    const ok = (cond, what) => { if (!cond) { fail++; console.log('✗ ' + what); } else console.log('  ' + what); };

    /* ① 어떤 글이든 이어붙이면 원문이어야 한다 — 이게 깨지면 글자가 새는 것이다 */
    const TEXTS = [
      '바닷물의 온도가 그 지역과 계절의 평년 값보다 매우 높은 상태로 5일 이상 지속되는 현상을 해양열파라고 한다.',
      '여름에는 날씨가 아주 더워요. 그런데 바다도 더워질 때가 있어요.',
      '최근 10년 동안 연평균 83.3일 발생해 평년의 3.7배로 늘었다. 같은 기간 수온은 18.1도였다.',
      '한 어절',
      '문장부호가 없는 긴 문장 하나를 넣어도 어절 경계에서만 갈라야 하고 글자를 잃지 않아야 한다',
    ];
    for (const t of TEXTS) {
      for (const lv of Object.keys(BANDS)) {
        const segs = chunk(t, lv);
        if (segs.join('') !== t) { fail++; console.log(`✗ ${lv} 이어붙이기가 원문과 다르다: ${t.slice(0, 20)}…`); }
        if (segs.some(x => !x.trim())) { fail++; console.log(`✗ ${lv} 빈 조각이 나왔다`); }
      }
    }
    ok(true, `이어붙이기·빈 조각 — 글 ${TEXTS.length}개 × 학년대 4개`);

    /* ② 소수점을 문장 끝으로 오인하지 않는다 (예전에 여기서 글자가 샜다) */
    ok(sentences('평년의 3.7배다. 다음 문장.').length === 2, '소수점 3.7 을 문장 끝으로 보지 않는다');
    ok(sentences('87.3 percent.').join('') === '87.3 percent.', '소수점이 있어도 글자를 잃지 않는다');

    /* ③ 관형어와 피수식어를 가르지 않는다 — 손으로 규칙 쓰다 실패했던 자리 */
    const adn = chunk('평년 값보다 매우 높은 상태로 5일 이상 지속되는 현상을 말한다.', 'L3');
    ok(!adn.some(x => x.trim().endsWith('높은')), '「높은」 뒤에서 끊지 않는다 (관형어)');
    ok(!adn.some(x => x.trim().endsWith('지속되는')), '「지속되는」 뒤에서 끊지 않는다 (관형어)');

    /* ④ 수와 단위를 가르지 않는다 */
    const num = chunk('최근 10 년 동안 약 3 배 늘었다.', 'L3');
    ok(!num.some(x => /\s10\s*$/.test(x)), '수 「10」 과 단위 「년」 을 가르지 않는다');

    /* ⑤ 조각 경계는 항상 어절 경계 */
    for (const lv of Object.keys(BANDS)) {
      const segs = chunk(TEXTS[0], lv);
      for (const x of segs.slice(0, -1)) {
        if (!/\s$/.test(x)) { fail++; console.log(`✗ ${lv} 조각이 공백으로 끝나지 않는다: "${x}"`); }
      }
    }
    ok(true, '조각 경계가 모두 어절 경계');

    /* ⑥ 확률표가 문법 어미만 담고 있나 — 내용어를 외우면 안 된다 */
    const contentish = Object.keys(SUFFIX).filter(k => k.length === 3 && !/[.,?!」]/.test(k));
    ok(contentish.length <= 6, `3글자 어미 중 문장부호 없는 것 ${contentish.length}개 — 내용어 암기 아님 (${contentish.join('·')})`);

    console.log(`\n${fail ? '✗ ' + fail + '건 실패' : '전부 통과'}`);
    process.exit(fail ? 1 : 0);
  }

  if (argv.includes('--retrain')) {
    /* articles.json 이 늘면 확률표를 다시 배워 이 파일에 써 넣는다 */
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const ME = path.join(HERE, 'chunk.mjs');
    const DB = JSON.parse(fs.readFileSync(path.join(HERE, 'articles.json'), 'utf8'));
    const tab = learnSuffix(DB.articles);
    const items = Object.entries(tab).sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));
    const lines = []; let cur = '  ';
    for (const [k, v] of items) {
      const piece = `"${k}":${v},`;
      if (cur.length + piece.length > 94) { lines.push(cur.replace(/\s+$/, '')); cur = '  '; }
      cur += piece;
    }
    if (cur.trim()) lines.push(cur.replace(/,$/, ''));
    const src = fs.readFileSync(ME, 'utf8');
    const a = src.indexOf('const SUFFIX = {'), b = src.indexOf('};', a);
    fs.writeFileSync(ME, src.slice(0, a) + 'const SUFFIX = {\n' + lines.join('\n') + '\n' + src.slice(b));
    console.log(`확률표를 다시 배웠습니다 — 어미 ${items.length}개 (지문 ${DB.articles.length}편)`);
    console.log('바뀐 실력을 보려면: node reading/chunk.mjs --eval --holdout');
    process.exit(0);
  }

  if (argv.includes('--style')) {
    /* 코퍼스가 한 가지 스타일로 끊겨 있는가.
       2026-09-02 에 이걸 세어 보고서야 알았다 — 8-31 에 한꺼번에 쓴 17편이
       나머지보다 1.5~2어절 길게 끊겨 있었다. 두 갈래가 섞인 데이터로 F1 을
       좇으면 어느 쪽도 아닌 값이 나온다. 새 지문을 쓸 때마다 확인할 것. */
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const DB = JSON.parse(fs.readFileSync(path.join(HERE, 'articles.json'), 'utf8'));
    const wc = (x) => (x.match(/\S+\s*/g) || []).length;
    console.log('지문마다 사람이 끊은 조각 길이 — 규격서 2장의 눈금과 견준다\n');
    console.log('   지문                     L1    L2    L3    L4   8어절초과');
    const all = {};
    for (const a of DB.articles) {
      const row = [], over = [];
      for (const lv of ['L1', 'L2', 'L3', 'L4']) {
        const b = (a.levels || {})[lv];
        const L = [];
        if (b) (b.paragraphs || []).forEach(p => { if (Array.isArray(p)) p.forEach(x => L.push(wc(x))); });
        if (!L.length) { row.push('   —'); continue; }
        (all[lv] = all[lv] || []).push(...L);
        over.push(...L.filter(x => x > 8));
        row.push((L.reduce((x, y) => x + y, 0) / L.length).toFixed(2).padStart(5));
      }
      console.log(`   ${a.id.padEnd(24)}${row.join(' ')}   ${over.length || ''}`);
    }
    console.log('\n   규격 눈금                 3.30  3.70  4.10  4.50');
    const avg = ['L1','L2','L3','L4'].map(lv => all[lv]
      ? (all[lv].reduce((x,y)=>x+y,0)/all[lv].length).toFixed(2).padStart(5) : '   —').join(' ');
    console.log(`   전체 평균                ${avg}`);
    const tooLong = ['L1','L2','L3','L4'].reduce((n, lv) => n + (all[lv] || []).filter(x => x > 8).length, 0);
    console.log(`\n   8어절 넘는 조각 ${tooLong}개 — 규격서는 「거의 항상 쪼갤 자리가 있다」고 한다.`);
    console.log('   지문마다 평균이 1어절 넘게 벌어지면 스타일이 갈린 것이다. 먼저 맞춘 뒤 --eval 을 믿을 것.');
    process.exit(0);
  }

  if (argv.includes('--eval')) {
    /* 사람이 끊은 실제 데이터와 대조한다 — 이 도구의 한계를 숫자로 본다 */
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const DB = JSON.parse(fs.readFileSync(path.join(HERE, 'articles.json'), 'utf8'));

    /* --holdout : 확률표를 앞 2/3 지문에서만 배우고 나머지로 채점한다.
       그냥 --eval 은 배운 데이터로 다시 채점하는 것이라 숫자가 부풀려진다.
       새 글에 썼을 때의 실력은 홀드아웃 쪽이 정직하다. */
    const hold = argv.includes('--holdout');
    let arts = DB.articles;
    if (hold) {
      const cut = Math.floor(DB.articles.length * 2 / 3);
      useSuffixTable(learnSuffix(DB.articles.slice(0, cut)));
      arts = DB.articles.slice(cut);
      console.log(`홀드아웃 — 앞 ${cut}편에서 배우고 뒤 ${arts.length}편으로 채점\n`);
    }

    const tot = {};
    for (const a of arts) {
      for (const [lv, b] of Object.entries(a.levels)) {
        const t = tot[lv] || (tot[lv] = { hit: 0, mine: 0, human: 0, same: 0, paras: 0 });
        for (const p of b.paragraphs) {
          const text = p.join('');
          const mine = chunk(text, lv);
          /* 경계를 '앞에서부터 센 글자 수'로 견준다 */
          const cut = (segs) => { const s = new Set(); let c = 0;
            for (let i = 0; i < segs.length - 1; i++) { c += segs[i].length; s.add(c); } return s; };
          const H = cut(p), M = cut(mine);
          t.human += H.size; t.mine += M.size; t.paras++;
          for (const x of M) if (H.has(x)) t.hit++;
          if (M.size === H.size && [...M].every(x => H.has(x))) t.same++;
        }
      }
    }
    console.log(`사람이 끊은 것과 대조 — 지문 ${arts.length}편${hold ? ' (처음 보는 글)' : ' · 배운 데이터로 재채점이라 부풀려진 값'}\n`);
    console.log('       정밀도   재현율     F1   완전일치 문단');
    let A = { hit: 0, mine: 0, human: 0, same: 0, paras: 0 };
    for (const lv of ['L1', 'L2', 'L3', 'L4']) {
      const t = tot[lv]; if (!t) continue;
      for (const k of Object.keys(A)) A[k] += t[k];
      const p = t.hit / t.mine, r = t.hit / t.human;
      console.log(`${lv.padEnd(5)}${(100 * p).toFixed(1).padStart(6)}% ${(100 * r).toFixed(1).padStart(7)}% `
        + `${(200 * p * r / (p + r)).toFixed(1).padStart(6)}  ${String(t.same).padStart(8)}/${t.paras}`);
    }
    const p = A.hit / A.mine, r = A.hit / A.human;
    console.log(`\n전체  정밀도 ${(100 * p).toFixed(1)}% · 재현율 ${(100 * r).toFixed(1)}% · `
      + `F1 ${(200 * p * r / (p + r)).toFixed(1)} · 완전일치 문단 ${A.same}/${A.paras}`);
    console.log('\n정밀도 = 내가 찍은 경계 중 사람도 찍은 비율 (헛짚지 않았나)');
    console.log('재현율 = 사람이 찍은 경계 중 내가 찾은 비율 (놓치지 않았나)');
    process.exit(0);
  }

  const text = argv.filter(x => !x.startsWith('--') && x !== bandOf()).join(' ')
    || await new Promise(res => { let s = ''; process.stdin.on('data', d => s += d).on('end', () => res(s.trim())); });
  if (!text) { console.error('끊을 글을 넘겨 주세요.  예: node reading/chunk.mjs --band L3 "…"'); process.exit(1); }
  const segs = chunk(text, bandOf());
  console.log(segs.map(s => s.trimEnd()).join(' ∕ '));
  console.log(`\n조각 ${segs.length}개 · 평균 ${(segs.reduce((a, s) => a + s.trim().split(/\s+/).length, 0) / segs.length).toFixed(1)}어절`);
  console.log(JSON.stringify(segs, null, 2));
}
