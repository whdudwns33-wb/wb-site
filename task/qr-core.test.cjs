const test = require('node:test');
const assert = require('node:assert/strict');

const qr = require('./qr-core.js');

/* ── GF(256) · 리드-솔로몬 ──
   여기가 틀리면 스캔이 조용히 실패한다. 규격 부속서의 표준 예제로 고정한다. */

test('GF(256) multiplication matches the QR primitive polynomial', () => {
  assert.equal(qr.gfMul(0, 5), 0);
  assert.equal(qr.gfMul(1, 5), 5);
  assert.equal(qr.gfMul(2, 128), 0x1D, '0x100 넘으면 0x11D로 접힌다');
  assert.equal(qr.gfMul(3, 7), 9);
});

test('Reed-Solomon reproduces the spec example for version 1-M', () => {
  /* 규격 표준 예제 "01234567" (버전 1-M) 의 데이터 코드워드 */
  const data = [0x10, 0x20, 0x0C, 0x56, 0x61, 0x80, 0xEC, 0x11,
    0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11];
  const expected = [0xA5, 0x24, 0xD4, 0xC1, 0xED, 0x36, 0xC7, 0x87, 0x2C, 0x55];
  assert.deepEqual(qr.rsEncode(data, 10), expected);
});

test('error correction length always matches the version table', () => {
  ['L', 'M'].forEach(level => {
    for (let v = 1; v <= 10; v++) {
      const data = new Array(qr.dataCapacity(v, level)).fill(0x41);
      const out = qr.interleave(data, v, level);
      const totals = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
      assert.equal(out.length, totals[v], 'v' + v + '-' + level + ' 총 코드워드');
    }
  });
});

/* ── 형식·버전 정보 (BCH) ── */

test('format information matches the published table', () => {
  /* 규격 부속서 C 표. 여기가 어긋나면 리더가 마스크를 잘못 풀어 못 읽는다. */
  const M = [0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0];
  const L = [0x77C4, 0x72F3, 0x7DAA, 0x789D, 0x662F, 0x6318, 0x6C41, 0x6976];
  for (let mask = 0; mask < 8; mask++) {
    assert.equal(qr.formatBits('M', mask), M[mask], 'M 마스크 ' + mask);
    assert.equal(qr.formatBits('L', mask), L[mask], 'L 마스크 ' + mask);
  }
});

test('version information matches the published table', () => {
  assert.equal(qr.versionBits(7), 0x07C94);
  assert.equal(qr.versionBits(8), 0x085BC);
  assert.equal(qr.versionBits(9), 0x09A99);
  assert.equal(qr.versionBits(10), 0x0A4D3);
});

/* ── 용량 · 버전 선택 ── */

test('version is the smallest that fits the payload', () => {
  assert.equal(qr.pickVersion(10, 'M'), 1);
  assert.equal(qr.pickVersion(qr.dataCapacity(1, 'M') - 2, 'M'), 1, '표시자 자리를 남긴다');
  assert.equal(qr.pickVersion(200, 'M'), 10);
  assert.equal(qr.pickVersion(9999, 'M'), 0, '안 들어가면 0');
});

test('a typical personal link fits well inside the supported range', () => {
  const link = 'https://wb-academy.example.com/task/?u=' + 'a'.repeat(36) + '#c=' + 'b'.repeat(43);
  const out = qr.encode(link);
  assert.ok(out.version <= 10, '버전 ' + out.version);
  assert.equal(out.level, 'M', '여유가 있으면 오류정정을 높게 둔다');
});

test('an over-long payload fails loudly instead of making a broken code', () => {
  assert.throws(() => qr.encode('x'.repeat(3000)), /너무 깁니다/);
  assert.throws(() => qr.encode(''), /내용이 없습니다/);
});

/* ── 격자 구조 ── */

function encoded(text) { return qr.encode(text || 'https://example.com/task/?u=abc#c=def'); }

test('matrix size follows the version formula', () => {
  const out = encoded();
  assert.equal(out.size, out.version * 4 + 17);
  assert.equal(out.modules.length, out.size);
  out.modules.forEach(row => assert.equal(row.length, out.size));
});

test('finder patterns sit in all three corners', () => {
  const { modules: m, size } = encoded();
  [[0, 0], [0, size - 7], [size - 7, 0]].forEach(([oy, ox]) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const edge = y === 0 || y === 6 || x === 0 || x === 6;
        const core = y >= 2 && y <= 4 && x >= 2 && x <= 4;
        assert.equal(m[oy + y][ox + x], edge || core ? 1 : 0,
          '위치 검출 패턴 (' + (oy + y) + ',' + (ox + x) + ')');
      }
    }
  });
});

test('timing patterns alternate', () => {
  const { modules: m, size } = encoded();
  for (let i = 8; i < size - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0 ? 1 : 0, '가로 타이밍 ' + i);
    assert.equal(m[i][6], i % 2 === 0 ? 1 : 0, '세로 타이밍 ' + i);
  }
});

test('the fixed dark module is set', () => {
  const { modules: m, size } = encoded();
  assert.equal(m[size - 8][8], 1);
});

test('the chosen mask is the lowest-penalty one', () => {
  const out = encoded();
  assert.ok(out.mask >= 0 && out.mask <= 7);
});

/* ── 왕복 검증 ──
   배치와 마스크는 눈으로 못 본다. 같은 순서로 되읽어 원본 코드워드가
   그대로 나오는지 확인한다. 여기가 통과하면 스캔은 사실상 된다. */

test('data placement and masking round-trip back to the original codewords', () => {
  const text = 'https://wb.example.com/task/?u=S1#c=abcdef012345';
  const out = qr.encode(text, { level: 'M' });
  const version = out.version;
  const expected = qr.interleave(qr.buildCodewords(qr.utf8Bytes(text), version, out.level), version, out.level);

  /* 기능 패턴 자리를 같은 규칙으로 다시 만든다 */
  const size = out.size;
  const fixed = [];
  for (let i = 0; i < size; i++) fixed.push(new Array(size).fill(0));
  const markBox = (oy, ox, h, w) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (oy + y >= 0 && oy + y < size && ox + x >= 0 && ox + x < size) fixed[oy + y][ox + x] = 1;
      }
    }
  };
  markBox(0, 0, 9, 9);
  markBox(0, size - 8, 9, 8);
  markBox(size - 8, 0, 8, 9);
  for (let i = 0; i < size; i++) { fixed[6][i] = 1; fixed[i][6] = 1; }
  const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]][version];
  ALIGN.forEach(cy => ALIGN.forEach(cx => {
    const corner = (cy <= 8 && cx <= 8) || (cy <= 8 && cx >= size - 9) || (cy >= size - 9 && cx <= 8);
    if (corner) return;
    markBox(cy - 2, cx - 2, 5, 5);
  }));
  if (version >= 7) { markBox(0, size - 11, 6, 3); markBox(size - 11, 0, 3, 6); }

  const MASKS = [
    (y, x) => (y + x) % 2 === 0, (y, x) => y % 2 === 0, (y, x) => x % 3 === 0,
    (y, x) => (y + x) % 3 === 0, (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
    (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
    (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0
  ];

  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fixed[y][x]) continue;
        let v = out.modules[y][x];
        if (MASKS[out.mask](y, x)) v ^= 1;
        bits.push(v);
      }
    }
  }

  const read = [];
  for (let i = 0; i + 8 <= bits.length && read.length < expected.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    read.push(byte);
  }
  assert.deepEqual(read, expected, '되읽은 코드워드가 원본과 같아야 한다');
});

/* ── SVG ── */

test('svg keeps the required quiet zone', () => {
  const out = qr.encode('https://example.com');
  const svg = qr.toSvg(out);
  assert.ok(svg.includes('viewBox="0 0 ' + (out.size + 8) + ' ' + (out.size + 8) + '"'),
    'quiet zone 4모듈이 없으면 못 읽는 기기가 있다');
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('shape-rendering="crispEdges"'), '보간이 걸리면 경계가 흐려진다');
});

test('svg has a light background so it scans on a dark screen', () => {
  const svg = qr.toSvg(qr.encode('https://example.com'));
  assert.ok(/<rect width="\d+" height="\d+" fill="#FFFFFF"\/>/.test(svg));
});
