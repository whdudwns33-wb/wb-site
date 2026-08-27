'use strict';
/* 급수(한국어문회 배정한자) 표 생성기 — vocab/hanja-grades.js + reading/hanja-grades.json
 *
 * 출처: 사단법인 한국어문회(https://www.hanja.re.kr/) 공식 학습자료의 급수별 배정한자 XLS를
 *       CSV로 변환한 공개 데이터셋 rycont/hanja-grade-dataset 의 by-level/*.csv.
 *       저작권은 한국어문회에 있다.
 *
 * 다시 만들려면:
 *   git clone --depth 1 https://github.com/rycont/hanja-grade-dataset /tmp/hgd
 *   node tools/build-hanja-grades.mjs /tmp/hgd/by-level
 *
 * 8급~3급(누적 1,817자)만 담는다. 2급 이상은 초·중등 독해 범위 밖이라 라벨을 붙이지 않는다.
 *
 * 주의 두 가지 — 둘 다 조용히 틀리는 종류라 여기서 막는다:
 *  1) 음이 둘인 글자(金 금/김, 車 차/거, 不 불/부, 樂 락/악, 宅 택/댁, 率 률/솔, 塞 색/새)는
 *     원본이 CJK 호환 한자 영역(U+F900~)으로 적어 놓았다. NFKC로 정규화하지 않으면
 *     8급 金이 라벨을 잃는다.
 *  2) 급수별 글자 수가 공식 수치와 다르면 즉시 중단한다.
 */
import fs from 'node:fs';
import path from 'node:path';

/* 쉬운 급수 → 어려운 급수. 배열 순서 자체가 난이도 척도다. */
const LEVELS = ['8급','7급II','7급','6급II','6급','5급II','5급','4급II','4급','3급II','3급'];
const OFFICIAL = {'8급':50,'7급II':50,'7급':50,'6급II':75,'6급':75,'5급II':100,'5급':100,
                  '4급II':250,'4급':250,'3급II':500,'3급':317};

const SRC = process.argv[2];
if (!SRC) { console.error('사용법: node tools/build-hanja-grades.mjs <by-level 디렉터리>'); process.exit(1); }

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const table = {};
const seen = new Map();

for (const lv of LEVELS) {
  const file = path.join(SRC, lv.replace('II', 'Ⅱ') + '.csv');
  const lines = fs.readFileSync(file, 'utf8').split('\n').slice(1).filter(Boolean);
  const chars = [];
  for (const line of lines) {
    const col = line.split(',')[2];                      // main_sound,level,hanja,...
    if (!col) continue;
    const ch = col.trim().normalize('NFKC');             // (1) 호환 한자 → 표준 한자
    if (!ch) continue;
    if (seen.has(ch)) { console.error(`중복: ${ch} (${seen.get(ch)} / ${lv})`); process.exit(1); }
    seen.set(ch, lv);
    chars.push(ch);
  }
  if (chars.length !== OFFICIAL[lv])                     // (2) 공식 수치와 대조
    { console.error(`${lv}: ${chars.length}자 — 공식은 ${OFFICIAL[lv]}자. 원본을 확인하세요.`); process.exit(1); }
  table[lv] = chars.join('');
}

const total = Object.values(table).reduce((n, s) => n + [...s].length, 0);
if (total !== 1817) { console.error(`합계 ${total}자 — 3급 누적은 1,817자여야 합니다.`); process.exit(1); }

const NOTE = '한국어문회(hanja.re.kr) 급수별 배정한자 8급~3급 1,817자. 저작권: 한국어문회.';
const rows = LEVELS.map((lv) => `  '${lv}': '${table[lv]}'`).join(',\n');

fs.writeFileSync(path.join(ROOT, 'vocab', 'hanja-grades.js'),
`'use strict';
/* ${NOTE}
   tools/build-hanja-grades.mjs 로 생성 — 손으로 고치지 말 것. */
var WB_HANJA_LEVELS = ${JSON.stringify(LEVELS)};
var WB_HANJA_GRADES = {
${rows}
};
/* 글자 → 급수. 없으면 null (2급 이상이거나 배정 밖) */
var WB_HANJA_INDEX = (function () {
  var m = Object.create(null);
  WB_HANJA_LEVELS.forEach(function (lv) {
    for (var i = 0; i < WB_HANJA_GRADES[lv].length; i++) m[WB_HANJA_GRADES[lv][i]] = lv;
  });
  return m;
})();
function wbHanjaGrade(ch) {
  if (!ch) return null;
  return WB_HANJA_INDEX[String(ch).normalize('NFKC')] || null;
}
/* 낱말의 급수 = 그 안에서 가장 어려운 글자의 급수. 한 글자라도 배정 밖이면 null */
function wbWordGrade(hanja) {
  if (!hanja) return null;
  var best = -1;
  var chars = String(hanja).normalize('NFKC').match(/[\\u4e00-\\u9fff]/g) || [];
  if (!chars.length) return null;
  for (var i = 0; i < chars.length; i++) {
    var g = WB_HANJA_INDEX[chars[i]];
    if (!g) return null;
    var idx = WB_HANJA_LEVELS.indexOf(g);
    if (idx > best) best = idx;
  }
  return best < 0 ? null : WB_HANJA_LEVELS[best];
}

if (typeof module !== 'undefined' && module.exports)
  module.exports = { WB_HANJA_LEVELS: WB_HANJA_LEVELS, WB_HANJA_GRADES: WB_HANJA_GRADES,
                     wbHanjaGrade: wbHanjaGrade, wbWordGrade: wbWordGrade };
`, 'utf8');

fs.writeFileSync(path.join(ROOT, 'reading', 'hanja-grades.json'),
  JSON.stringify({ note: NOTE, levels: LEVELS, grades: table }, null, 0) + '\n', 'utf8');

console.log(`급수표 생성 완료 — ${total}자`);
LEVELS.forEach((lv) => console.log(`  ${lv.padStart(6)}: ${[...table[lv]].length}자`));
