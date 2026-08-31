#!/usr/bin/env node
'use strict';
/* QR 인코더 테스트 — node shared/qr.test.cjs
 *
 * 외부 디코더 없이 도는 테스트다. 아래 골든 해시는 jsQR(실제 스캐너 구현)로
 * 7건 전부 원문 일치를 확인한 뒤 고정한 값이다. 인코더를 건드려 출력이 달라지면
 * 여기서 먼저 걸린다. 골든을 갱신할 때는 반드시 실제 디코더로 다시 확인할 것.
 */
const crypto = require('crypto');
const WBQR = require('./qr.js');

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };
const hash = (g) => crypto.createHash('sha256').update(g.map(r => r.map(v => v ? 1 : 0).join('')).join('')).digest('hex').slice(0, 16);

/* ── 골든 (jsQR 디코드 검증 완료) ───────────────────── */
const GOLDEN = [
  ['HELLO', 21, '32fbc389880456d5'],
  ['https://wb-reading.whdudwns33.workers.dev/?c=wb-pg4nuw', 33, '6bdcab684a8282f0'],
  ['https://wb-reading.whdudwns33.workers.dev/?c=wb-pg4nuw2x9k', 33, 'be14522d63016c27'],
  ['https://whdudwns33-wb.github.io/wb-reading/?c=wb-a2b3c4d5e6', 33, 'a89709a71dc0f96d'],
  ['한글도 되나요? 테스트 wb-abc', 29, '1f7f0a389f46606b'],
  ['https://example.com/' + 'x'.repeat(60), 37, '81f5789f99f7c0a3'],
  ['https://example.com/' + 'y'.repeat(150), 53, '2e9951a8dd054297'],
];
GOLDEN.forEach(([text, size, h]) => {
  const g = WBQR.matrix(text);
  ok(g.length === size, `크기 ${g.length} (기대 ${size}) — ${text.slice(0, 30)}`);
  ok(hash(g) === h, `골든 불일치 ${hash(g)} (기대 ${h}) — ${text.slice(0, 30)}`);
});

/* ── 구조 검증 ─────────────────────────────────────── */
const g = WBQR.matrix('https://wb-reading.whdudwns33.workers.dev/?c=wb-pg4nuw');
const n = g.length;

/* 파인더 3개 */
[[0, 0], [0, n - 7], [n - 7, 0]].forEach(([R, C]) => {
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    const want = (r === 0 || r === 6 || c === 0 || c === 6) || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
    ok(g[R + r][C + c] === want, `파인더 (${R + r},${C + c})`);
  }
});
/* 분리자: 파인더 둘레는 흰색 */
for (let i = 0; i < 8; i++) {
  ok(g[7][i] === false, `분리자 (7,${i})`);
  ok(g[i][7] === false, `분리자 (${i},7)`);
}
/* 타이밍 패턴 */
for (let i = 8; i < n - 8; i++) {
  ok(g[6][i] === (i % 2 === 0), `가로 타이밍 (6,${i})`);
  ok(g[i][6] === (i % 2 === 0), `세로 타이밍 (${i},6)`);
}
/* 다크 모듈 */
ok(g[n - 8][8] === true, '다크 모듈');

/* ── 포맷 정보가 공식 표(오류정정 M)와 일치하는지 ──── */
const TABLE_M = ['101010000010010','101000100100101','101111001111100','101101101001011',
                 '100010111111001','100000011001110','100111110010111','100101010100000'];
const A = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
const B = [[n-1,8],[n-2,8],[n-3,8],[n-4,8],[n-5,8],[n-6,8],[n-7,8],
           [8,n-8],[8,n-7],[8,n-6],[8,n-5],[8,n-4],[8,n-3],[8,n-2],[8,n-1]];
const s1 = A.map(([r, c]) => g[r][c] ? 1 : 0).join('');
const s2 = B.map(([r, c]) => g[r][c] ? 1 : 0).join('');
ok(TABLE_M.includes(s1), `포맷 사본1이 M 표에 없음: ${s1}`);
ok(s1 === s2, '포맷 두 사본 불일치');

/* ── 용량 경계 ─────────────────────────────────────── */
ok(WBQR.matrix('a'.repeat(213)).length === 57, '버전 10 경계(213바이트)');
let threw = false;
try { WBQR.matrix('a'.repeat(214)); } catch (e) { threw = true; }
ok(threw, '214바이트는 거부해야 함');

/* ── SVG 출력 ──────────────────────────────────────── */
const svg = WBQR.svg('https://wb-reading.whdudwns33.workers.dev/?c=wb-pg4nuw', { size: 200 });
ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), 'SVG 형식');
ok(svg.includes('width="200"'), 'SVG 크기 반영');
ok(!/<script|onload=/i.test(svg), 'SVG에 스크립트 없음');

if (fails.length) {
  fails.slice(0, 20).forEach(f => console.error('FAIL:', f));
  console.error(`\n실패 ${fails.length}건`);
  process.exit(1);
}
console.log(`OK — 골든 ${GOLDEN.length}건 + 구조·포맷·경계·SVG 검증 통과`);
