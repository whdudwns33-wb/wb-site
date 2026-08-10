(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBQRCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 개인 링크를 태블릿에 옮기는 유일하게 안 번거로운 방법이 QR이다.
     이 앱은 외부 라이브러리를 쓰지 않으므로 인코더를 직접 넣는다.
     바이트 모드 · 버전 1~10 · 오류정정 L/M 만 다룬다. 링크 길이가 그 안에 든다. */

  const MODE_BYTE = 4;

  /* 버전별 전체 코드워드 수 (데이터 + 오류정정) */
  const TOTAL_CW = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

  /* [블록당 오류정정 코드워드, 1그룹 블록수, 1그룹 데이터CW, 2그룹 블록수, 2그룹 데이터CW] */
  const ECC = {
    L: [null,
      [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0], [26, 1, 108, 0, 0],
      [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0], [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]],
    M: [null,
      [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
      [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]]
  };

  /* 정렬 패턴 중심 좌표 */
  const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  const ECC_BITS = { L: 1, M: 0 };   // 형식 정보에 들어가는 오류정정 레벨 비트

  /* ── GF(256) 산술. 원시 다항식 0x11D ── */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* 오류정정 다항식. (x - 2^0)(x - 2^1)...(x - 2^(n-1)) */
  function rsGenerator(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    const gen = rsGenerator(ecLen);
    const rem = new Array(ecLen).fill(0);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ rem[0];
      rem.shift();
      rem.push(0);
      for (let j = 0; j < ecLen; j++) rem[j] ^= gfMul(gen[j + 1], factor);
    }
    return rem;
  }

  /* ── 형식·버전 정보 (BCH) ── */
  function formatBits(level, mask) {
    const data = (ECC_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function versionBits(version) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
    return (version << 12) | rem;
  }

  /* ── 용량 ── */
  function dataCapacity(version, level) {
    const e = ECC[level][version];
    return e[1] * e[2] + e[3] * e[4];
  }

  /** 글자 수 표시자 비트 수. 버전 1~9는 8비트, 10 이상은 16비트 */
  function countBits(version) { return version < 10 ? 8 : 16; }

  function pickVersion(byteLen, level) {
    for (let v = 1; v <= 10; v++) {
      const need = 4 + countBits(v) + byteLen * 8;
      if (need <= dataCapacity(v, level) * 8) return v;
    }
    return 0;
  }

  function utf8Bytes(text) {
    const s = String(text);
    if (typeof TextEncoder === 'function') return Array.from(new TextEncoder().encode(s));
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  /* ── 데이터 코드워드 ── */
  function buildCodewords(bytes, version, level) {
    const capacity = dataCapacity(version, level);
    const bits = [];
    const push = (value, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };

    push(MODE_BYTE, 4);
    push(bytes.length, countBits(version));
    bytes.forEach(b => push(b, 8));

    /* 종단자는 남은 자리만큼만 넣는다 */
    const capBits = capacity * 8;
    for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      cw.push(byte);
    }
    /* 남는 자리는 0xEC, 0x11 을 번갈아 채운다 */
    const PAD = [0xEC, 0x11];
    for (let i = 0; cw.length < capacity; i++) cw.push(PAD[i % 2]);
    return cw;
  }

  /* 블록으로 나눠 오류정정을 붙이고 규격 순서대로 섞는다 */
  function interleave(cw, version, level) {
    const [ecLen, g1, d1, g2, d2] = ECC[level][version];
    const blocks = [];
    let at = 0;
    for (let i = 0; i < g1; i++) { blocks.push(cw.slice(at, at + d1)); at += d1; }
    for (let i = 0; i < g2; i++) { blocks.push(cw.slice(at, at + d2)); at += d2; }
    const ecBlocks = blocks.map(b => rsEncode(b, ecLen));

    const out = [];
    const maxData = Math.max(d1, d2);
    for (let i = 0; i < maxData; i++) {
      blocks.forEach(b => { if (i < b.length) out.push(b[i]); });
    }
    for (let i = 0; i < ecLen; i++) ecBlocks.forEach(b => out.push(b[i]));
    return out;
  }

  /* ── 배치 ── */
  function newMatrix(size) {
    const m = [];
    for (let i = 0; i < size; i++) m.push(new Array(size).fill(0));
    return m;
  }

  function placeFunctions(mods, fixed, version) {
    const size = mods.length;
    const set = (y, x, v) => { mods[y][x] = v; fixed[y][x] = 1; };

    /* 위치 검출 패턴 + 분리자 */
    [[0, 0], [size - 7, 0], [0, size - 7]].forEach(([oy, ox]) => {
      for (let y = -1; y <= 7; y++) {
        for (let x = -1; x <= 7; x++) {
          const py = oy + y, px = ox + x;
          if (py < 0 || py >= size || px < 0 || px >= size) continue;
          const inner = y >= 0 && y <= 6 && x >= 0 && x <= 6;
          const on = inner && (y === 0 || y === 6 || x === 0 || x === 6 ||
            (y >= 2 && y <= 4 && x >= 2 && x <= 4));
          set(py, px, on ? 1 : 0);
        }
      }
    });

    /* 타이밍 패턴 */
    for (let i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0 ? 1 : 0);
      set(i, 6, i % 2 === 0 ? 1 : 0);
    }

    /* 정렬 패턴 — 위치 검출 패턴과 겹치는 자리는 뺀다 */
    const centers = ALIGN[version];
    centers.forEach(cy => centers.forEach(cx => {
      const corner = (cy <= 8 && cx <= 8) || (cy <= 8 && cx >= size - 9) || (cy >= size - 9 && cx <= 8);
      if (corner) return;
      for (let y = -2; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) {
          const on = Math.max(Math.abs(y), Math.abs(x)) !== 1;
          set(cy + y, cx + x, on ? 1 : 0);
        }
      }
    }));

    /* 형식 정보 자리와 고정 검은 모듈 */
    for (let i = 0; i < 9; i++) {
      if (!fixed[8][i]) set(8, i, 0);
      if (!fixed[i][8]) set(i, 8, 0);
    }
    for (let i = 0; i < 8; i++) {
      set(8, size - 1 - i, 0);
      set(size - 1 - i, 8, 0);
    }
    set(size - 8, 8, 1);

    /* 버전 정보 (7 이상) */
    if (version >= 7) {
      const bits = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = (bits >> i) & 1;
        set(Math.floor(i / 3), size - 11 + (i % 3), bit);
        set(size - 11 + (i % 3), Math.floor(i / 3), bit);
      }
    }
  }

  /** 오른쪽 아래에서 지그재그로 올라가며 데이터를 채운다. 세로 타이밍 열은 건너뛴다. */
  function placeData(mods, fixed, cw) {
    const size = mods.length;
    let bit = 0;
    const total = cw.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (fixed[y][x] || bit >= total) continue;
          mods[y][x] = (cw[bit >> 3] >> (7 - (bit & 7))) & 1;
          bit++;
        }
      }
    }
  }

  const MASKS = [
    (y, x) => (y + x) % 2 === 0,
    (y, x) => y % 2 === 0,
    (y, x) => x % 3 === 0,
    (y, x) => (y + x) % 3 === 0,
    (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
    (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
    (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0
  ];

  function applyMask(mods, fixed, mask) {
    const size = mods.length;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!fixed[y][x] && MASKS[mask](y, x)) mods[y][x] ^= 1;
      }
    }
  }

  function placeFormat(mods, level, mask) {
    const size = mods.length;
    const bits = formatBits(level, mask);
    for (let i = 0; i < 15; i++) {
      const bit = (bits >> i) & 1;
      /* 왼쪽 위 */
      if (i < 6) mods[8][i] = bit;
      else if (i === 6) mods[8][7] = bit;
      else if (i === 7) mods[8][8] = bit;
      else if (i === 8) mods[7][8] = bit;
      else mods[14 - i][8] = bit;
      /* 나머지 두 곳 */
      if (i < 8) mods[8][size - 1 - i] = bit;
      else mods[size - 15 + i][8] = bit;
    }
  }

  /* 읽기 어려운 배치에 벌점을 매겨 가장 낮은 마스크를 고른다 */
  function penalty(mods) {
    const size = mods.length;
    let score = 0;

    const runScore = line => {
      let s = 0, run = 1;
      for (let i = 1; i < line.length; i++) {
        if (line[i] === line[i - 1]) { run++; }
        else { if (run >= 5) s += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) s += 3 + (run - 5);
      return s;
    };
    for (let y = 0; y < size; y++) score += runScore(mods[y]);
    for (let x = 0; x < size; x++) score += runScore(mods.map(r => r[x]));

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const v = mods[y][x];
        if (v === mods[y][x + 1] && v === mods[y + 1][x] && v === mods[y + 1][x + 1]) score += 3;
      }
    }

    const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const hasAt = (line, i, pat) => pat.every((v, k) => line[i + k] === v);
    const findPatterns = line => {
      let s = 0;
      for (let i = 0; i + 11 <= line.length; i++) {
        if (hasAt(line, i, P1) || hasAt(line, i, P2)) s += 40;
      }
      return s;
    };
    for (let y = 0; y < size; y++) score += findPatterns(mods[y]);
    for (let x = 0; x < size; x++) score += findPatterns(mods.map(r => r[x]));

    let dark = 0;
    mods.forEach(row => row.forEach(v => { if (v) dark++; }));
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;

    return score;
  }

  /**
   * 문자열을 QR 모듈 격자로 만든다.
   * @returns {{size:number, modules:number[][], version:number, level:string, mask:number}}
   */
  function encode(text, options) {
    const opts = options || {};
    const bytes = utf8Bytes(text);
    if (!bytes.length) throw new Error('QR로 만들 내용이 없습니다');

    const level = ECC[opts.level] ? opts.level : 'M';
    let version = pickVersion(bytes.length, level);
    let use = level;
    if (!version) {
      version = pickVersion(bytes.length, 'L');
      use = 'L';
    }
    if (!version) throw new Error('내용이 너무 깁니다 — 링크를 줄여 주세요');

    const size = version * 4 + 17;
    const mods = newMatrix(size);
    const fixed = newMatrix(size);
    placeFunctions(mods, fixed, version);
    placeData(mods, fixed, interleave(buildCodewords(bytes, version, use), version, use));

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const trial = mods.map(r => r.slice());
      applyMask(trial, fixed, mask);
      placeFormat(trial, use, mask);
      const score = penalty(trial);
      if (!best || score < best.score) best = { score: score, mask: mask, modules: trial };
    }

    return { size: size, modules: best.modules, version: version, level: use, mask: best.mask };
  }

  /**
   * 격자를 SVG 문자열로 만든다. 외부 이미지 없이 화면에 그대로 붙는다.
   * quiet zone 4모듈은 규격상 필수 — 빼면 스캔이 안 되는 기기가 있다.
   */
  function toSvg(qr, options) {
    const opts = options || {};
    const quiet = opts.quiet == null ? 4 : opts.quiet;
    const px = opts.size || 264;
    const total = qr.size + quiet * 2;
    const dark = opts.dark || '#111111';
    const light = opts.light || '#FFFFFF';

    let path = '';
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) path += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z';
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px +
      '" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges" role="img">' +
      '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/>' +
      '<path d="' + path + '" fill="' + dark + '"/></svg>';
  }

  return {
    encode: encode,
    toSvg: toSvg,
    dataCapacity: dataCapacity,
    pickVersion: pickVersion,
    utf8Bytes: utf8Bytes,
    buildCodewords: buildCodewords,
    interleave: interleave,
    rsEncode: rsEncode,
    formatBits: formatBits,
    versionBits: versionBits,
    gfMul: gfMul
  };
});
