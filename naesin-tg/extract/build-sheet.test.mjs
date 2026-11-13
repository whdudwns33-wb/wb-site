/* node naesin-tg/extract/build-sheet.test.mjs */
import assert from 'node:assert';
import { guessAnswerFrom } from './build-sheet.mjs';
assert.strictEqual(guessAnswerFrom(['표지: 정답과 해설 제공', '1. 문제', '2. 문제', '1) 정답 해설 …']), 4);
assert.strictEqual(guessAnswerFrom(['1. 문제', '2. 문제']), 0);
console.log('  ✓ 정답·해설 시작 쪽 짐작');

/* 문항 영역 — 자체 가짜 좌표(2단, A4 595×842). */
const { cropsFromWords } = await import('./build-sheet.mjs');
const W = 595, H = 842;
const w = (x0, y0, t) => ({ x0, y0, x1: x0 + 12, y1: y0 + 10, t });
const page1 = { w: W, h: H, words: [w(57, 60, '7.'), w(80, 60, '단원'), w(57, 200, '1.'), w(70, 300, '본문'), w(57, 430, '2.'), w(70, 700, '끝'),
  w(312, 110, '3.'), w(312, 400, '[4~5]'), w(330, 420, '자료'), w(312, 520, '4.'), w(312, 700, '5.'), w(560, 820, '1')] };
const page2 = { w: W, h: H, words: [w(57, 50, '이어짐'), w(57, 200, '6.'), w(312, 80, '7.')] };
const c = cropsFromWords([page1, page2]);
assert.deepStrictEqual(Object.keys(c).map(Number), [1, 2, 3, 4, 5, 6, 7], '단원 제목 「7.」 은 머리로 보지 않고 1..7 을 차례로 잡는다');
assert.strictEqual(c[1].length, 1); assert.ok(c[1][0].y < 200 / H && c[1][0].y + c[1][0].h < 430 / H, '1번은 2번 머리 전까지');
assert.ok(c[1][0].x < 0.15 && c[1][0].x + c[1][0].w < 0.5, '왼쪽 단 안');
assert.ok(c[3][0].x >= 0.5, '3번은 오른쪽 단');
assert.strictEqual(c[3].length, 1, '3번은 묶음 머리 [4~5] 전에서 끊긴다');
assert.ok(c[3][0].y + c[3][0].h < 400 / H);
assert.strictEqual(c[4].length, 2, '4번 = 공통 자료 + 문항');
assert.deepStrictEqual(c[4][0], c[5][0], '5번도 같은 공통 자료를 맨 위에 붙인다');
assert.deepStrictEqual(c[5].map((r) => r.p), [1, 1, 2], '5번 = 공통 자료 + 문항 + 다음 단(2쪽 왼단) 위쪽으로 넘어간 부분');
assert.ok(c[5][2].y + c[5][2].h < 200 / H, '넘어간 부분은 6번 머리 전까지');
assert.strictEqual(c[6].length, 1);
assert.strictEqual(c[7].length, 1, '마지막 문항은 이어 붙이지 않는다');
assert.ok(c[1][0].y + c[1][0].h <= 1 && Object.values(c).flat().every((r) => r.h > 0 && r.y >= 0 && r.x >= 0 && r.x + r.w <= 1.0001));
console.log('  ✓ 문항 영역(2단·묶음 자료·단원 제목 번호 무시)');
