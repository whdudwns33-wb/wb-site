/* node naesin-tg/extract/build-sheet.test.mjs */
import assert from 'node:assert';
import { guessAnswerFrom } from './build-sheet.mjs';
assert.strictEqual(guessAnswerFrom(['표지: 정답과 해설 제공', '1. 문제', '2. 문제', '1) 정답 해설 …']), 4);
assert.strictEqual(guessAnswerFrom(['1. 문제', '2. 문제']), 0);
console.log('  ✓ 정답·해설 시작 쪽 짐작');
