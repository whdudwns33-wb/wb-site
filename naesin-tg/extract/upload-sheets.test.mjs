'use strict';
/* node naesin-tg/extract/upload-sheets.test.mjs — 순서·닫힘·정보→쪽 순서·잘못된 파일 거절 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectFiles, uploadOne } from './upload-sheets.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-up-'));
for (const id of ['b-1', 'a-1', 'z-9']) fs.writeFileSync(path.join(dir, id + '.sheet.json'), '{}');
fs.writeFileSync(path.join(dir, '_manifest.json'), '[]');
assert.deepStrictEqual(collectFiles([dir], ['z-9']).map((f) => path.basename(f)), ['z-9.sheet.json', 'a-1.sheet.json', 'b-1.sheet.json'], '첫 판 범위가 맨 앞, _manifest 는 뺀다');
fs.rmSync(dir, { recursive: true });

const calls = [];
const api = async (p, b) => { calls.push([p, b]); };
const n = await uploadOne(api, { id: 'sc-m2-7-1-top-1', sheet: { title: 't', open: true }, pages: ['p1', 'p2'] });
assert.strictEqual(n, 2);
assert.strictEqual(calls[0][0], '/api/naesin-tg/admin/sheet');
assert.strictEqual(calls[0][1].sheet.open, false, '열린 채로 올라가면 안 된다');
assert.deepStrictEqual(calls.slice(1).map((c) => c[1].n), [1, 2], '정보를 먼저, 쪽 그림은 그 뒤에');
await assert.rejects(uploadOne(api, { id: 'x', sheet: {}, pages: [] }), /문제지 파일이 아니/);
console.log('upload-sheets: 3개 통과');
