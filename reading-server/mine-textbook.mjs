/* 코칭글에서 그 강의 낱말·뜻·예문을 캐낸다.
   실행: node reading-server/mine-textbook.mjs reading/textbook.json
   (읽기는 항상 reading/textbook.json, 쓰기는 인자로 준 경로 — 먼저 딴 곳에 써서 눈으로 보고 적용한다)
   초2·초3 교재를 넣을 때 다시 돌리면 된다.

   원장님이 코칭글에 이미 써 두신 것을 옮길 뿐이다. 못 캔 자리는 비워 둔다 —
   그럴듯하게 지어 넣으면 강사 검수가 무의미해진다. */
import fs from 'node:fs';

const strip = (s) => String(s || '').replace(/^[\s'‘’"“”\-–—→]+|[\s'‘’"“”\-–—→]+$/g, '').trim();
const stem = (w) => w.replace(/(하다|되다|이다|다)$/, '');

/* 낱말이 아닌 것 — 어간 부스러기와 수업 용어 */
const NOT_WORD = /^(익히|표현하|만들어주|도와주|마주치|던져보|헷갈리|찾아보|사용되|흐르|좋아하|해내|연습|발음|어휘|낱말|활동|이야기|표현|의미|문장|단어|상황|감정|아이|엄마|친구|부모|예시|기억|주의|참고|목표|정리|방법|가지|하나|보기)$/;
/* 활동·설명 제목도 콜론을 달고 나온다 — "구별 활동: …", "예시 정리: …". 낱말이 아니다. */
const NOT_WORD2 = /(활동|하기|만들기|그리기|놀이|게임|연습|퀴즈|낱말|정리|단계|방법|예시|예문|같습니다)$/;

/* 두 토막인데 앞 토막이 조사로 끝나면 낱말이 아니라 예문 구절이다 —
   "종이를 찢다", "고무줄을 늘인다". 진짜 낱말(찢다·늘이다)은 따로 잡힌다.
   "흉내 내다", "체험 학습"처럼 조사가 없는 두 토막은 그대로 둔다. */
const PHRASE = /(를|을|이|가|은|는|에|로|와|과|의)$/;
/* 앞 토막이 꾸미는 말이어도 낱말이 아니라 구절이다 —
   "나달나달한 깃발", "새로운 경험", "느리게 걷는다". 꾸밈을 받는 쪽이 낱말인 것도 아니다:
   그 강이 가르치는 것은 꾸미는 말(나달나달·새롭다) 쪽이고, 그건 따로 잡힌다. */
const ADNOM = /(한|운|는|던|게|인)$/;
const isPhrase = (w) => {
  const p = String(w).split(/\s+/);
  return p.length === 2 && (PHRASE.test(p[0]) || ADNOM.test(p[0]));
};
const okWord = (w) => /^[가-힣]{2,6}(\s[가-힣]{1,4})?$/.test(w) && !NOT_WORD.test(w)
  && !/(세요|합니다|어요)$/.test(w)    // "질문해보세요" 같은 당부문은 낱말이 아니다
  && !NOT_WORD2.test(w);

/* 두 토막짜리 후보의 앞 토막이 앞 문장의 꼬리일 때가 있다 —
   "…설명해 주세요 환기: 실내 공기를…" 에서 「주세요 환기」를 낱말로 집어 온다.
   앞 토막이 용언 어미로 끝나면 그것만 떼어낸다. */
/* 앞 토막이 수업 용어일 때도 마찬가지다 — "…활용 방법 분류하다: 비슷한 것끼리…" */
const VERB_TAIL = /(요|기|다|서|며|고|자|죠|음)$/;
function trimLead(w) {
  const parts = String(w).split(/\s+/);
  if (parts.length !== 2 || !okWord(parts[1])) return w;
  if (VERB_TAIL.test(parts[0]) || NOT_WORD.test(parts[0])) return parts[1];
  return w;
}

/* 뜻이 아니라 학부모에게 하는 당부인 것 — 뜻 칸에 들어가면 검수자가 훑다가 그대로 통과시킨다 */
const NOT_MEANING = /(보세요|주세요|좋아요|좋습니다|효과적|연결해|해보면|지도하|추천|해보기|익히기|키우기)/;
const TAIL = /\s*(?:이라는 뜻이에요|라는 뜻이에요|는 뜻이에요|뜻이에요|이라는 뜻|라는 뜻|말이에요|표현이에요|행동이에요|느낌이에요|상황이에요|거예요|이에요|예요|에요|말해요|해요|이야)$/;

function cleanMeaning(v) {
  let s = strip(v);
  /* 뜻 안에 다음 항목("낱말: ")이 남아 있으면 거기서 자른다.
     그대로 두면 그럴듯해 보이는 틀린 뜻이 되어 검수를 그냥 통과한다. */
  s = s.split(/\s[가-힣]{2,6}(?:\s[가-힣]{1,4})?\s*:/)[0];
  s = s.replace(/[.,]+$/, '');
  s = s.replace(TAIL, '').trim();
  /* 「…뜻해요」를 떼어 내면 그 말이 거느리던 목적어 조사가 꼬리로 남는다 —
     "새로운 일에 도전하는 것을", "매우 급하고 위험한 상황을". 뜻이 아니라 문장 토막으로 읽힌다.
     구어체 「걸」(것을)도 마찬가지라 「것」으로 되돌린다. */
  s = s.replace(/\s*걸$/, ' 것').replace(/(것)[을를]$/, '$1').replace(/([가-힣])[을를]$/, '$1');
  s = strip(s);
  if (!s || s.length < 3 || s.length > 55 || NOT_MEANING.test(s)) return '';
  return s;
}

/* ── 1) 콜론 설명 블록 ──
   "환기: 실내 공기를 바깥 공기와 바꾸는 것 “수업 전 창문을…”"
   "실감나다: 진짜처럼 느껴질 때 → “공연이 너무 실감났어요!”"
   "띠다: 감정이나 색, 성질을 지니거나 예: “얼굴에 미소를 띠다”"
   뜻은 마침표로 끝나지 않는다 — 따옴표·화살표·「예:」·다음 낱말 콜론에서 끊긴다. */
const ANCHOR = /(?:^|[\s\n])([가-힣]{2,6}(?:\s[가-힣]{1,4})?)\s*:\s*/g;
function colonPairs(text) {
  const out = [];
  const anchors = [];
  for (const m of text.matchAll(ANCHOR)) {
    const w = trimLead(m[1]);
    if (!okWord(w)) continue;
    /* start = 이 항목이 시작하는 자리, from = 뜻이 시작하는 자리.
       앞 항목의 뜻은 다음 항목의 start 에서 끊어야 한다 — from 으로 끊으면
       "소원을 빌다 → …말하는 것 별처럼 많다:" 처럼 다음 낱말까지 삼킨다. */
    anchors.push({ word: w, start: m.index, from: m.index + m[0].length });
  }
  anchors.forEach((a, i) => {
    const end = i + 1 < anchors.length ? anchors[i + 1].start : text.length;
    let seg = text.slice(a.from, Math.min(end, a.from + 200));
    /* 뜻이 끝나는 자리 — 예문(따옴표)·화살표·「예:」·줄바꿈·마침표 중 가장 먼저 오는 것 */
    const cut = seg.search(/[“"”]|→|\s예\s*:|\n|[.]/);
    const meaning = cleanMeaning(cut > 0 ? seg.slice(0, cut) : seg);
    /* 뒤따르는 큰따옴표가 그 낱말의 예문이다 */
    const q = seg.match(/[“"]([^“”"\n]{4,60})[”"]/);
    if (meaning) out.push({ word: a.word, meaning, example: q ? strip(q[1]) : '' });
  });
  return out;
}

/* ── 2) 그 강이 가르치는 낱말 나열 ──
   교재마다 적는 자리가 다르다. 초1은 🎯 목표 문단에, 초2는 도입부와 지도안에 적어 두었다.
   그래서 자리로 찾지 않고 모양으로 찾는다:
     · 따옴표로 하나씩 감싼 쉼표 나열 — "'사고', '신중하다', '짐작'" — 은 글 어디에 있어도 낱말이다.
     · 따옴표 없는 맨 나열은 🎯 문단에서만 인정한다. 아무 데서나 잡으면 잡문이 딸려 온다. */
function targetWords(coaching) {
  const out = [];
  /* 따옴표로 각각 감싼 나열 — 셋 이상 이어질 때만. 둘은 헷갈리는 말 짝일 때가 많다 */
  const quoted = /(?:['‘"“][^'’"”\n]{1,12}['’"”]\s*,\s*){2,}['‘"“][^'’"”\n]{1,12}['’"”]/g;
  for (const m of coaching.matchAll(quoted))
    for (const w of m[0].split(/\s*,\s*/)) if (okWord(strip(w)) && !isPhrase(strip(w))) out.push(strip(w));
  /* 한 따옴표 안에 쉼표로 몰아넣은 것 — "'거들다, 맞대다, 연결하다'" */
  for (const m of coaching.matchAll(/['‘"“]([^'’"”\n]{8,80})['’"”]\s*(?:같은|등)/g))
    for (const w of m[1].split(/\s*,\s*/)) if (okWord(strip(w)) && !isPhrase(strip(w))) out.push(strip(w));

  const goal = (coaching.split(/\n{2,}/).find((p) => /🎯/.test(p)) || '');
  for (const m of goal.matchAll(/['‘"“]([^'’"”\n]{4,80})['’"”]/g))
    for (const w of m[1].split(/\s*,\s*/)) if (okWord(strip(w))) out.push(strip(w));
  for (const m of goal.matchAll(/((?:[가-힣]{2,7}\s*,\s*){2,}[가-힣]{2,7})\s*(?:같은|등)/g))
    for (const w of m[1].split(/\s*,\s*/)) if (okWord(strip(w))) out.push(strip(w));
  return [...new Set(out)];
}

/* ── 2-2) 예문 뒤 화살표에 붙은 뜻 ──
   초2는 뜻을 이렇게 적는다: 예: "기발한 생각이 떠올랐어!" → 신선하고 독특한 느낌
   따옴표 안 예문에서 낱말을 찾고, 화살표 뒤를 그 낱말의 뜻으로 삼는다. */
function arrowMeanings(text, words) {
  const out = {};
  /* 뜻은 다음 예문 앞에서 끊는다. 따옴표까지 삼키면 뜻이 아니라 두 항목이 붙은 덩어리가 된다. */
  for (const m of text.matchAll(/[“"']([^“”"'\n]{6,70})[”"']\s*→\s*([^\n→“”"']{3,55})/g)) {
    const ex = strip(m[1]), raw = strip(m[2]);
    /* →는 뜻풀이에도 쓰이고 활동 지시에도 쓰인다. 뜻이 아닌 것을 걸러 낸다:
       물음·감탄으로 끝나거나("들으면 좋은 말은?"), 또 따옴표가 열리거나,
       맞고 틀림을 보이는 줄("시험을 마치다(O) / 문제를 마치다(X)")은 뜻이 아니다. */
    if (/[?!]/.test(raw) || /["'“”‘’]/.test(raw) || /\((?:O|X)\)/.test(raw)) continue;
    const v = cleanMeaning(raw);
    if (!v) continue;
    const hit = words.find((w) => ex.includes(stem(w)));
    if (hit && !out[hit]) out[hit] = { meaning: v, example: ex };
  }
  return out;
}

/* ── 2-3) 대시로 이은 뜻 ──
   초2가 소리·모양 말을 이렇게 적는다: 오독오독 – 작고 단단한 것을 씹는 소리 → "오이를…"
   뜻은 다음 화살표나 따옴표 앞에서 끊는다. */
function dashMeanings(text) {
  const out = {};
  for (const m of text.matchAll(/(?:^|[\s\n])([가-힣]{2,7})\s+[–—-]\s+([^\n→“”"']{4,55})/g)) {
    const w = strip(m[1]), v = cleanMeaning(m[2]);
    if (okWord(w) && v && !out[w]) out[w] = v;
  }
  return out;
}

/* ── 2-4) 풀어 쓴 뜻 ──
   강마다 뜻을 다는 자리가 다르다. 19·20강은 콜론도 화살표도 쓰지 않고 문장으로 풀어 쓴다:
     ‘모험’이라는 말은 새로운 일에 도전하는 것을 뜻해요.
     ▪ 분실하다는 ‘물건을 잃어버리는 것’을 말해요.
   이 자리에서만 나오는 낱말이 있다 — 20강의 화창하다·변덕스럽다·찢다·찧다가 그랬다.
   그래서 이 규칙은 뜻만이 아니라 낱말도 내놓는다.

   뜻은 한 문장을 넘지 않는다. 마침표나 따옴표를 넘어가면 옆 항목을 삼킨다 —
   「‘세다’는 힘이나 숫자와 관련된 말 ‘새다’는 물이 빠지거나…」가 그렇게 한 덩어리가 됐다. */
const BODY = "[^\\n.!?“”\"'‘’]";
const DEFINED = [
  /* 낱말이 따옴표 안에 있고 뒤에서 풀이한다 */
  new RegExp("['‘\"“]([가-힣]{2,7})['’\"”](?:이라는|라는)?\\s*(?:말)?(?:은|는)\\s+(" + BODY + "{6,70})(?:뜻해요|말해요|나타내요|이에요|예요|에요)", 'g'),
  /* 글머리 기호 뒤에 낱말이 있고 뜻이 따옴표 안에 있다 */
  /[▪▶●•]\s*([가-힣]{2,7})(?:은|는)\s+['‘"“]([^\n'’"”]{4,60})['’"”]/g,
];
/* ── 2-5) 헷갈리는 말 짝 ──
   강마다 「🔍 헷갈리기 쉬운 낱말 – 찢다 / 찧다」 같은 머리글로 짝을 세워 둔다.
   짝의 한쪽만 잡히는 일이 잦았다 — 다른 쪽 풀이가 따옴표 안에 있어 걸러졌기 때문이다.
   머리글에서 둘을 한꺼번에 집으면 짝이 끊기지 않는다. 문맥 빈칸 문제가 이 짝을 오답으로 쓴다. */
const PAIR = /헷갈[^\n]{0,12}낱말[^가-힣\n]{0,6}([가-힣]{2,7})\s*[/／·,]\s*([가-힣]{2,7})/g;
function pairWords(text) {
  const out = [];
  for (const m of text.matchAll(PAIR))
    for (const w of [m[1], m[2]]) if (okWord(w)) out.push(w);
  return [...new Set(out)];
}

function definedWords(text) {
  const out = {};
  for (const re of DEFINED)
    for (const m of text.matchAll(re)) {
      const w = strip(m[1]), v = cleanMeaning(m[2]);
      if (okWord(w) && !isPhrase(w) && v && v !== w && !out[w]) out[w] = v;
    }
  return out;
}

/* ── 3) 괄호 뜻: '사흘(3일)' ── */
function parenMeanings(text) {
  const out = {};
  for (const m of text.matchAll(/([가-힣]{2,6})\s*\(([^)\n]{1,30})\)/g)) {
    const w = strip(m[1]), v = cleanMeaning(m[2]);
    if (okWord(w) && v && !out[w]) out[w] = v;
  }
  return out;
}

/* ── 4) 서술형 뜻: "거들다는 ‘돕는 것’이에요." ── */
function proseMeanings(text) {
  const out = {};
  for (const m of text.matchAll(/(?:^|[\s\n])([가-힣]{2,7})(?:은|는)\s+['‘"“]?([^\n"“”]{3,70}?)['’"”]?\s*(?:[.]|\n|$)/g)) {
    const w = strip(m[1]), v = cleanMeaning(m[2]);
    if (okWord(w) && v && !out[w]) out[w] = v;
  }
  return out;
}

function examples(coaching, words) {
  const quotes = [...coaching.matchAll(/[“"]([^“”"\n]{6,60})[”"]/g)].map((m) => strip(m[1]));
  const out = {};
  for (const w of words) {
    const hit = quotes.find((q) => q.includes(stem(w)));
    if (hit) out[w] = hit;
  }
  return out;
}

/* 코칭글에 설명이 없어 사람이 써 넣은 뜻 — 다시 캘 수 없으니 살려 둔다 */
/* 뜻이 없으면 출처도 없다 — 빈 값을 넣어 두면 다시 돌릴 때마다 파일이 달라진다 */
const dropEmptySrc = (o) => { if (!o.src) delete o.src; return o; };

/* 사람이 손댄 뜻은 무엇으로도 덮지 않는다.
     ai    — 코칭글에 설명이 없어 대신 쓴 것. 다시 캘 수 없다.
     fixed — 코칭글에서 캤지만 끝이 잘려("…말하는") 손으로 마무리한 것.
             표시를 안 해 두면 다시 돌릴 때마다 잘린 채로 되돌아간다.
   raw로 캔 값(src: coaching)만 새로 캔 것으로 갈아 끼운다. */
const HUMAN = ['ai', 'fixed'];
const keepHuman = (prev) => ((prev && HUMAN.indexOf(prev.src) >= 0 && prev.meaning) ? prev : null);

const tb = JSON.parse(fs.readFileSync('reading/textbook.json', 'utf8'));
let nW = 0, nM = 0, nE = 0;
const rows = [];
for (const b of tb.books) for (const l of b.lessons) {
  const prev = (l.words || []).map((w) => (typeof w === 'string' ? { word: w, meaning: '', example: '' } : w));
  const pairs = colonPairs(l.coaching);
  const target = targetWords(l.coaching);
  const paren = parenMeanings(l.coaching), prose = proseMeanings(l.coaching), dash = dashMeanings(l.coaching);
  const defined = definedWords(l.coaching), pairw = pairWords(l.coaching);

  /* 낱말 순서: 콜론 설명 → 목표 문단 → 풀어 쓴 뜻 → 헷갈리는 짝 → 원래 후보 */
  /* 이미 목록에 있고 뜻까지 붙은 낱말은 누군가 손을 댄 것이다 — 새 후보에 쓰는
     걸름망(okWord)을 다시 들이대면 안 된다. 한 글자 낱말 「샘」이 그렇게 사라졌다.
     뜻이 없는 채로 남은 옛 후보만 걸름망을 통과해야 살아남는다. */
  /* 뜻이 붙어 있으면 누군가 손댄 것이라 걸름망을 다시 들이대지 않는다.
     뜻 없이 남은 옛 후보만 걸름망과 구절 검사를 통과해야 살아남는다. */
  const kept = prev.filter((p) => p.meaning || (okWord(p.word) && !isPhrase(p.word))).map((p) => p.word);
  /* 사람이 "낱말이 아니다"라고 판단해 뺀 것은 다시 집어 오지 않는다.
     걸름망으로는 못 거른다 — 코칭글이 "거름을 뿌린다"를 예문으로 또박또박 적어 두었기 때문이다.
     판단을 파일에 적어 두는 편이 정규식을 더 조이는 것보다 정확하고 되돌리기도 쉽다. */
  const dropped = new Set(l.dropped || []);
  const order = [...new Set([...pairs.map((p) => p.word), ...target, ...Object.keys(defined), ...pairw, ...kept])]
    .filter((w) => !dropped.has(w));
  const byPair = {};
  for (const p of pairs) byPair[p.word] = p;
  const prevBy = {};
  for (const p of prev) prevBy[p.word] = p;
  const arrow = arrowMeanings(l.coaching, order);
  const ex = examples(l.coaching, order);

  /* "담그다 → 담그다"처럼 낱말이 곧 뜻으로 나오면 뜻이 아니다.
     후보를 하나씩 걸러 첫 성한 것을 고른다 — 결과에만 걸면 나쁜 후보가 먼저 잡혔을 때
     뒤 후보로 넘어가지 못하고 통째로 빈칸이 된다. */
  const firstGood = (w, list) => {
    for (const v of list) { const t = v && strip(v); if (t && t !== w) return t; }
    return '';
  };
  const words = order.map((w) => dropEmptySrc({
    word: w,
    /* 지난번에 "캔" 값은 보존하지 않는다 — 옛 추출의 흠(뜻이 다음 항목까지 삼킨 것
       따위)이 그대로 굳는다. 다만 코칭글에 설명이 없어 사람이 써 넣은 뜻(src:'ai')은
       다시 캘 수 없으니 남긴다. 강사가 고친 값은 파일이 아니라 DB 덧씌우기에 있다. */
    meaning: (keepHuman(prevBy[w]) || {}).meaning
      || firstGood(w, [byPair[w] && byPair[w].meaning, defined[w], arrow[w] && arrow[w].meaning, dash[w], paren[w], prose[w]]),
    example: (prevBy[w] && prevBy[w].example)
      || (byPair[w] && byPair[w].example) || (arrow[w] && arrow[w].example) || ex[w] || '',
    src: keepHuman(prevBy[w]) ? prevBy[w].src
      : (firstGood(w, [byPair[w] && byPair[w].meaning, defined[w], arrow[w] && arrow[w].meaning, dash[w], paren[w], prose[w]]) ? 'coaching' : ''),
  }));
  l.words = words;
  nW += words.length; nM += words.filter((w) => w.meaning).length; nE += words.filter((w) => w.example).length;
  rows.push({ n: l.lesson, w: words.length, m: words.filter((x) => x.meaning).length,
    added: order.filter((w) => !prev.some((p) => p.word === w)) });
}
console.log('낱말 ' + nW + ' · 뜻 ' + nM + ' · 예문 ' + nE);
console.log();
for (const r of rows) console.log('  ' + String(r.n).padStart(2) + '강  낱말 ' + String(r.w).padStart(2) + ' · 뜻 ' + String(r.m).padStart(2) + (r.added.length ? '   새로: ' + r.added.join(', ') : ''));
fs.writeFileSync(process.argv[2] || '/dev/null', JSON.stringify(tb, null, 2) + '\n');
