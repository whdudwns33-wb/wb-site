'use strict';
/* WB 급수표 검증 (node vocab/hanja-grades.test.cjs) */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { WB_HANJA_LEVELS, WB_HANJA_GRADES, wbHanjaGrade, wbWordGrade } = require('./hanja-grades.js');

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ✓ ' + name); }

const OFFICIAL = { '8급': 50, '7급II': 50, '7급': 50, '6급II': 75, '6급': 75, '5급II': 100,
                   '5급': 100, '4급II': 250, '4급': 250, '3급II': 500, '3급': 317 };

t('급수 순서는 쉬운 급수부터 — 이 순서가 난이도 척도다', () => {
  assert.deepStrictEqual(WB_HANJA_LEVELS,
    ['8급','7급II','7급','6급II','6급','5급II','5급','4급II','4급','3급II','3급']);
});

t('급수별 글자 수가 한국어문회 공식 수치와 같다 (누적 1,817자)', () => {
  let total = 0;
  for (const lv of WB_HANJA_LEVELS) {
    const n = [...WB_HANJA_GRADES[lv]].length;
    assert.strictEqual(n, OFFICIAL[lv], `${lv}: ${n}자 (공식 ${OFFICIAL[lv]}자)`);
    total += n;
  }
  assert.strictEqual(total, 1817);
});

t('한 글자가 두 급수에 걸치지 않는다', () => {
  const seen = new Map();
  for (const lv of WB_HANJA_LEVELS) {
    for (const ch of WB_HANJA_GRADES[lv]) {
      assert.ok(!seen.has(ch), `${ch}: ${seen.get(ch)} / ${lv} 중복`);
      seen.set(ch, lv);
    }
  }
});

t('모두 표준 한자 코드포인트 — 호환 한자(U+F900~)가 섞이지 않았다', () => {
  for (const lv of WB_HANJA_LEVELS) {
    for (const ch of WB_HANJA_GRADES[lv]) {
      assert.ok(ch.codePointAt(0) < 0xF900, `${lv}의 ${ch}(${ch.codePointAt(0).toString(16)})가 호환 영역`);
    }
  }
});

t('음이 둘인 글자도 정상 조회된다 — 원본이 호환 영역에 넣어 둔 7자', () => {
  assert.strictEqual(wbHanjaGrade('金'), '8급');
  assert.strictEqual(wbHanjaGrade('車'), '7급II');
  assert.strictEqual(wbHanjaGrade('不'), '7급II');
  assert.strictEqual(wbHanjaGrade('樂'), '6급II');
  assert.strictEqual(wbHanjaGrade('宅'), '5급II');
  assert.strictEqual(wbHanjaGrade('率'), '3급II');
  assert.strictEqual(wbHanjaGrade('塞'), '3급II');
});

t('호환 코드포인트로 물어봐도 같은 답 — 조회 시 NFKC 정규화', () => {
  assert.strictEqual(wbHanjaGrade('金'), '8급');   // 金
  assert.strictEqual(wbHanjaGrade('率'), '3급II'); // 率
});

t('배정 밖 글자와 빈 값은 null', () => {
  assert.strictEqual(wbHanjaGrade('龘'), null);
  assert.strictEqual(wbHanjaGrade(''), null);
  assert.strictEqual(wbHanjaGrade(null), null);
});

t('낱말 급수 = 가장 어려운 글자의 급수', () => {
  assert.strictEqual(wbWordGrade('學校'), '8급');     // 學 8급 + 校 8급
  assert.strictEqual(wbWordGrade('觀測'), '4급II');   // 觀 5급II + 測 4급II
  assert.strictEqual(wbWordGrade('發射體'), '4급');   // 發 6급II + 射 4급 + 體 6급II
  assert.strictEqual(wbWordGrade('軌道'), '3급');     // 軌 3급 + 道 7급II
});

/* 급수는 한자 자격증 사다리지 독해 사다리가 아니다. 矛盾·葛藤처럼 비문학에서
   자주 터지는 낱말도 글자가 2급이면 라벨이 없다 — 그래서 급수는 라벨로만 쓰고
   학습 순서로는 쓰지 않는다. */
t('배정 밖 글자로 이뤄진 흔한 낱말은 라벨이 없다', () => {
  assert.strictEqual(wbHanjaGrade('矛'), null);
  assert.strictEqual(wbHanjaGrade('盾'), null);
  assert.strictEqual(wbWordGrade('矛盾'), null);
  assert.strictEqual(wbWordGrade('葛藤'), null);
});

t('한 글자라도 배정 밖이면 낱말 급수는 null — 반쯤 맞는 라벨을 내보내지 않는다', () => {
  assert.strictEqual(wbWordGrade('龘龘'), null);
  assert.strictEqual(wbWordGrade('가나다'), null);
  assert.strictEqual(wbWordGrade(''), null);
  assert.strictEqual(wbWordGrade(null), null);
});

t('훈음이 섞인 표기에서도 한자만 골라 읽는다', () => {
  assert.strictEqual(wbWordGrade('觀(볼 관)+測(잴 측)'), '4급II');
  assert.strictEqual(wbWordGrade('發(쏠 발)+射(쏠 사)+體(몸 체)'), '4급');
});

t('독해 앱용 JSON이 어휘 앱 표와 글자 하나까지 같다', () => {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reading', 'hanja-grades.json'), 'utf8'));
  assert.deepStrictEqual(j.levels, WB_HANJA_LEVELS);
  for (const lv of WB_HANJA_LEVELS) assert.strictEqual(j.grades[lv], WB_HANJA_GRADES[lv]);
});

console.log(`\nOK — 급수표 검증 ${passed}건 통과 (8급~3급 1,817자)`);
