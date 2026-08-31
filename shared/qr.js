/* WB 공용 QR 인코더 — 바이트 모드, 오류정정 M, 버전 1~10
 *
 * CSP가 'self'만 허용해 CDN에서 라이브러리를 가져올 수 없어 직접 구현한다.
 * 쓰임새는 학생 연동 링크(60자 안팎) 하나뿐이라 버전 10(213바이트)이면 충분하다.
 *
 *   WBQR.matrix('https://…')  → boolean[][] (true = 검은 칸)
 *   WBQR.svg('https://…', {size, quiet}) → SVG 문자열
 */
(function (root) {
  'use strict';

  /* ── GF(256), 원시다항식 0x11D ───────────────────────── */
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  function rsGen(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  }
  function rsEncode(data, ecLen) {
    const g = rsGen(ecLen), res = new Array(ecLen).fill(0);
    for (const b of data) {
      const f = b ^ res[0];
      res.shift(); res.push(0);
      if (f !== 0) for (let i = 0; i < ecLen; i++) res[i] ^= mul(g[i + 1], f);
    }
    return res;
  }

  /* ── 버전별 규격 (오류정정 M 전용) ────────────────────
     [데이터 바이트 용량, EC 코드워드/블록, [블록수, 데이터cw], [블록수, 데이터cw]?] */
  const SPEC = {
    1:  [14,  10, [1, 16]],
    2:  [26,  16, [1, 28]],
    3:  [42,  26, [1, 44]],
    4:  [62,  18, [2, 32]],
    5:  [84,  24, [2, 43]],
    6:  [106, 16, [4, 27]],
    7:  [122, 18, [4, 31]],
    8:  [152, 22, [2, 38], [2, 39]],
    9:  [180, 22, [3, 36], [2, 37]],
    10: [213, 26, [4, 43], [1, 44]],
  };
  const ALIGN = { 1: [], 2: [6,18], 3: [6,22], 4: [6,26], 5: [6,30],
                  6: [6,34], 7: [6,22,38], 8: [6,24,42], 9: [6,26,46], 10: [6,28,50] };

  const utf8 = (s) => {
    const out = [];
    for (const ch of unescape(encodeURIComponent(s))) out.push(ch.charCodeAt(0));
    return out;
  };

  function build(text) {
    const bytes = utf8(text);
    let ver = 0;
    for (let v = 1; v <= 10; v++) if (bytes.length <= SPEC[v][0]) { ver = v; break; }
    if (!ver) throw new Error('QR: 내용이 너무 깁니다 (최대 213바이트)');
    const [, ecLen, g1, g2] = SPEC[ver];
    const blocks = [[...g1], ...(g2 ? [[...g2]] : [])];
    const totalData = blocks.reduce((s, [n, cw]) => s + n * cw, 0);

    /* 비트 스트림 */
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(0b0100, 4);                      // 바이트 모드
    push(bytes.length, ver <= 9 ? 8 : 16);
    bytes.forEach(b => push(b, 8));
    const cap = totalData * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);   // 종료자
    while (bits.length % 8) bits.push(0);
    const dataCw = [];
    for (let i = 0; i < bits.length; i += 8) dataCw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    const PAD = [0xec, 0x11];
    for (let i = 0; dataCw.length < totalData; i++) dataCw.push(PAD[i % 2]);

    /* 블록 분할 + RS */
    const dBlocks = [], eBlocks = [];
    let p = 0;
    blocks.forEach(([n, cw]) => {
      for (let i = 0; i < n; i++) { const d = dataCw.slice(p, p + cw); p += cw; dBlocks.push(d); eBlocks.push(rsEncode(d, ecLen)); }
    });
    /* 인터리브 */
    const out = [];
    const maxD = Math.max(...dBlocks.map(b => b.length));
    for (let i = 0; i < maxD; i++) dBlocks.forEach(b => { if (i < b.length) out.push(b[i]); });
    for (let i = 0; i < ecLen; i++) eBlocks.forEach(b => out.push(b[i]));
    return { ver, cw: out };
  }

  function place(ver, cw) {
    const n = ver * 4 + 17;
    const m = Array.from({ length: n }, () => new Array(n).fill(null));   // null = 비어 있음
    const fixed = Array.from({ length: n }, () => new Array(n).fill(false));
    const set = (r, c, v) => { m[r][c] = v; fixed[r][c] = true; };

    /* 파인더 + 분리자 */
    const finder = (R, C) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const rr = R + r, cc = C + c;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                   (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(rr, cc, on ? 1 : 0);
      }
    };
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);

    /* 타이밍 */
    for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }

    /* 정렬 패턴 */
    const ac = ALIGN[ver];
    ac.forEach(r => ac.forEach(c => {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) return;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
        set(r + dr, c + dc, (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0);
    }));

    /* 다크 모듈 + 포맷 영역 예약 */
    set(n - 8, 8, 1);
    for (let i = 0; i <= 8; i++) { if (!fixed[8][i]) set(8, i, 0); if (!fixed[i][8]) set(i, 8, 0); }
    for (let i = n - 8; i < n; i++) { if (!fixed[8][i]) set(8, i, 0); if (!fixed[i][8]) set(i, 8, 0); }

    /* 버전 정보 영역 예약 (v7+) */
    if (ver >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { set(i, n - 11 + j, 0); set(n - 11 + j, i, 0); }

    /* 데이터 배치 (지그재그) */
    const bits = [];
    cw.forEach(b => { for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); });
    let bi = 0, up = true;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--;                      // 타이밍 열 건너뜀
      for (let k = 0; k < n; k++) {
        const row = up ? n - 1 - k : k;
        for (let s = 0; s < 2; s++) {
          const c = col - s;
          if (fixed[row][c]) continue;
          m[row][c] = bi < bits.length ? bits[bi++] : 0;
        }
      }
      up = !up;
    }
    return { n, m, fixed };
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function penalty(g, n) {
    let p = 0;
    /* 규칙1: 같은 색 5칸 이상 연속 */
    for (let i = 0; i < n; i++) {
      for (const line of [g[i], g.map(row => row[i])]) {
        let run = 1;
        for (let j = 1; j < n; j++) {
          if (line[j] === line[j - 1]) run++;
          else { if (run >= 5) p += run - 2; run = 1; }
        }
        if (run >= 5) p += run - 2;
      }
    }
    /* 규칙2: 2x2 동색 블록 */
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++)
      if (g[r][c] === g[r][c+1] && g[r][c] === g[r+1][c] && g[r][c] === g[r+1][c+1]) p += 3;
    /* 규칙3: 1011101 패턴 + 공백 4칸 */
    const P1 = [1,0,1,1,1,0,1,0,0,0,0], P2 = [0,0,0,0,1,0,1,1,1,0,1];
    const hit = (line, i, pat) => pat.every((v, k) => line[i + k] === v);
    for (let i = 0; i < n; i++) {
      const rows = g[i], cols = g.map(row => row[i]);
      for (let j = 0; j + 11 <= n; j++) {
        if (hit(rows, j, P1) || hit(rows, j, P2)) p += 40;
        if (hit(cols, j, P1) || hit(cols, j, P2)) p += 40;
      }
    }
    /* 규칙4: 검은 칸 비율 편차 */
    let dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (g[r][c]) dark++;
    p += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
    return p;
  }

  function bch(val, poly, len) {
    let v = val << len;
    const bit = (x) => { let b = 0; while (x) { b++; x >>= 1; } return b; };
    const pl = bit(poly);
    while (bit(v) >= pl) v ^= poly << (bit(v) - pl);
    return v;
  }

  /* 포맷 정보 15비트는 왼쪽(최상위) 비트가 (8,0)에 온다 — LSB부터 넣으면 스캐너가 못 읽는다 */
  const FMT_A = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  function applyFormat(m, n, mask) {
    const data = (0b00 << 3) | mask;                 // 오류정정 M = 00
    const fmt = (((data << 10) | bch(data, 0b10100110111, 10)) ^ 0b101010000010010);
    const bit = (i) => (fmt >> (14 - i)) & 1;
    const B = [[n-1,8],[n-2,8],[n-3,8],[n-4,8],[n-5,8],[n-6,8],[n-7,8],
               [8,n-8],[8,n-7],[8,n-6],[8,n-5],[8,n-4],[8,n-3],[8,n-2],[8,n-1]];
    FMT_A.forEach(([r, c], i) => { m[r][c] = bit(i); });
    B.forEach(([r, c], i) => { m[r][c] = bit(i); });
    m[n - 8][8] = 1;                                  // 다크 모듈
  }
  function applyVersion(m, n, ver) {
    if (ver < 7) return;
    const v = (bch(ver, 0b1111100100101, 12) | (ver << 12));
    for (let i = 0; i < 18; i++) {
      const bit = (v >> i) & 1, r = Math.floor(i / 3), c = i % 3;
      m[r][n - 11 + c] = bit; m[n - 11 + c][r] = bit;
    }
  }

  function matrix(text) {
    const { ver, cw } = build(text);
    const { n, m, fixed } = place(ver, cw);
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const g = m.map((row, r) => row.map((v, c) => (fixed[r][c] ? v : (MASKS[mask](r, c) ? v ^ 1 : v))));
      applyFormat(g, n, mask); applyVersion(g, n, ver);
      const p = penalty(g, n);
      if (!best || p < best.p) best = { p, g };
    }
    return best.g.map(row => row.map(Boolean));
  }

  function svg(text, opt) {
    const o = opt || {}, quiet = o.quiet == null ? 4 : o.quiet, size = o.size || 240;
    const g = matrix(text), n = g.length, total = n + quiet * 2;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (g[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="연동 QR 코드">`
      + `<rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#173957"/></svg>`;
  }

  const api = { matrix, svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WBQR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
