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
/* 활동 제목도 콜론을 달고 나온다 — "구별 활동: 시계 그림에 시간 나누기". 낱말이 아니다. */
const NOT_WORD2 = /(활동|하기|그리기|놀이|게임|연습|퀴즈|낱말)$/;
const okWord = (w) => /^[가-힣]{2,6}(\s[가-힣]{1,4})?$/.test(w) && !NOT_WORD.test(w)
  && !/(세요|합니다|어요)$/.test(w)    // "질문해보세요" 같은 당부문은 낱말이 아니다
  && !NOT_WORD2.test(w);

/* 두 토막짜리 후보의 앞 토막이 앞 문장의 꼬리일 때가 있다 —
   "…설명해 주세요 환기: 실내 공기를…" 에서 「주세요 환기」를 낱말로 집어 온다.
   앞 토막이 용언 어미로 끝나면 그것만 떼어낸다. */
const VERB_TAIL = /(요|기|다|서|며|고|자|죠|음)$/;
function trimLead(w) {
  const parts = String(w).split(/\s+/);
  if (parts.length === 2 && VERB_TAIL.test(parts[0]) && okWord(parts[1])) return parts[1];
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

/* ── 2) 목표 문단의 나열 ── */
function targetWords(coaching) {
  const goal = (coaching.split(/\n{2,}/).find((p) => /🎯/.test(p)) || '');
  const out = [];
  for (const m of goal.matchAll(/['‘"“]([^'’"”\n]{4,80})['’"”]/g))
    for (const w of m[1].split(/\s*,\s*/)) if (okWord(strip(w))) out.push(strip(w));
  for (const m of goal.matchAll(/((?:[가-힣]{2,7}\s*,\s*){2,}[가-힣]{2,7})\s*(?:같은|등)/g))
    for (const w of m[1].split(/\s*,\s*/)) if (okWord(strip(w))) out.push(strip(w));
  return [...new Set(out)];
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

const keepWritten = (prev) => (prev && prev.src === 'ai' && prev.meaning) || '';

const tb = JSON.parse(fs.readFileSync('reading/textbook.json', 'utf8'));
let nW = 0, nM = 0, nE = 0;
const rows = [];
for (const b of tb.books) for (const l of b.lessons) {
  const prev = (l.words || []).map((w) => (typeof w === 'string' ? { word: w, meaning: '', example: '' } : w));
  const pairs = colonPairs(l.coaching);
  const target = targetWords(l.coaching);
  const paren = parenMeanings(l.coaching), prose = proseMeanings(l.coaching);

  /* 낱말 순서: 콜론 설명 → 목표 문단 → 원래 후보 */
  /* 이미 목록에 있고 뜻까지 붙은 낱말은 누군가 손을 댄 것이다 — 새 후보에 쓰는
     걸름망(okWord)을 다시 들이대면 안 된다. 한 글자 낱말 「샘」이 그렇게 사라졌다.
     뜻이 없는 채로 남은 옛 후보만 걸름망을 통과해야 살아남는다. */
  const kept = prev.filter((p) => p.meaning || okWord(p.word)).map((p) => p.word);
  const order = [...new Set([...pairs.map((p) => p.word), ...target, ...kept])];
  const byPair = {};
  for (const p of pairs) byPair[p.word] = p;
  const prevBy = {};
  for (const p of prev) prevBy[p.word] = p;
  const ex = examples(l.coaching, order);

  const words = order.map((w) => dropEmptySrc({
    word: w,
    /* 지난번에 "캔" 값은 보존하지 않는다 — 옛 추출의 흠(뜻이 다음 항목까지 삼킨 것
       따위)이 그대로 굳는다. 다만 코칭글에 설명이 없어 사람이 써 넣은 뜻(src:'ai')은
       다시 캘 수 없으니 남긴다. 강사가 고친 값은 파일이 아니라 DB 덧씌우기에 있다. */
    meaning: (byPair[w] && byPair[w].meaning) || paren[w] || prose[w] || keepWritten(prevBy[w]) || '',
    example: (byPair[w] && byPair[w].example) || ex[w] || (prevBy[w] && prevBy[w].example) || '',
    src: (byPair[w] && byPair[w].meaning) || paren[w] || prose[w] ? 'coaching'
      : (keepWritten(prevBy[w]) ? 'ai' : ''),
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
