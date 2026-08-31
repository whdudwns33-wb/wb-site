'use strict';
/* 어휘 나이 진단이 쓸 낱말판을 만든다 (node reading-server/build-agewords.mjs)
   → vocab-age/words.json
   교재 파일을 고친 뒤 다시 돌린다. 검사(vocab-age/age.test.cjs)가 결과를 지킨다.

   두 가지를 지킨다.
   ① 코칭 원문은 절대 나가지 않는다 — 이 페이지는 로그인 없이 열린다.
      낱말(w)과 뜻(m) 두 칸만 싣는다.
   ② 뜻은 우리가 쓴 것(src:'ai')만 쓴다. 교재에서 캔 뜻(coaching·fixed)은
      출판사 글에서 나온 것이라 공개 페이지에 싣지 않는다. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'vocab-age', 'words.json');

/* 책 → 사다리 칸. age.js의 BANDS와 순서·id가 같아야 한다. */
const BAND_OF = {
  'eoduk-cho1': 'cho1', 'eoduk-cho2': 'cho2', 'eoduk-cho3': 'cho3',
  'eoduk-cho4': 'cho4', 'eoduk-silryeok': 'cho56', 'eoduk-jungdeung': 'jung',
};

const tb = JSON.parse(fs.readFileSync(path.join(ROOT, 'reading', 'textbook.json'), 'utf8'));
const bands = {};
const seen = new Set();          // 같은 낱말이 두 칸에 걸치지 않게 — 낮은 칸이 이긴다
let dropped = 0;

for (const id of Object.keys(BAND_OF)) {
  const book = tb.books.find((b) => b.id === id);
  if (!book) throw new Error('교재를 찾지 못했습니다: ' + id);
  const list = [];
  for (const l of book.lessons) {
    for (const w of l.words) {
      if (w.src !== 'ai' || !w.meaning) continue;
      if (seen.has(w.word)) { dropped += 1; continue; }
      /* 뜻이 길면 문제 보기로 못 쓴다 — 네 줄이 화면을 넘긴다 */
      if (w.meaning.length > 60) { dropped += 1; continue; }
      seen.add(w.word);
      list.push({ w: w.word, m: w.meaning });
    }
  }
  bands[BAND_OF[id]] = list;
}

const total = Object.values(bands).reduce((n, l) => n + l.length, 0);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ builtFrom: 'reading/textbook.json', bands }, null, 1) + '\n');

for (const [k, l] of Object.entries(bands)) console.log('  ' + k.padEnd(6) + String(l.length).padStart(4) + '개');
console.log('낱말판 ' + total + '개 · 겹치거나 긴 것 ' + dropped + '개 제외 → vocab-age/words.json');
