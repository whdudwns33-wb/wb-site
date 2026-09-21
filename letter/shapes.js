'use strict';
/* WB 브레인레터 — 시공간(VSI) 두뇌 놀이 생성기 (브라우저/Node 공용, 의존성 없음)
   왜: 두뇌 놀이 다섯 지표 중 시공간만은 글로 낼 수 없다. 도형을 seed 로 결정적으로 만들어 SVG 로 그린다 —
   호 JSON 에는 {kind, seed} 만 들어가고 그림·정답은 렌더할 때 다시 만든다. 그래서 JSON 이 작고, 사람이나
   AI 가 쓴 SVG 문자열이 화면에 들어갈 일이 없다(숫자만으로 그린다).
   검사 문항 복제가 아니다 — 회전·거울·쌓기나무·조각 맞추기는 초등 교과·놀이책의 흔한 활동이다. */
var WBSHAPES = (function () {
  var KINDS = ['odd', 'rotate', 'mirror', 'blocks', 'complete'];
  var LABEL = { odd: '다른 하나 찾기', rotate: '돌리면 어느 것?', mirror: '거울에 비치면?', blocks: '쌓기나무 세기', complete: '빈 조각 찾기' };
  var CIRCLED = ['①', '②', '③', '④', '⑤'];
  /* 좌우가 다른(거울상이 회전으로 겹치지 않는) 폴리오미노만 — 거울 문제가 성립하려면 필수 */
  var SHAPES = [
    { id: 'L4', cells: [[0, 0], [1, 0], [2, 0], [2, 1]] },
    { id: 'S4', cells: [[0, 1], [0, 2], [1, 0], [1, 1]] },
    { id: 'P5', cells: [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]] },
    { id: 'F5', cells: [[0, 1], [0, 2], [1, 0], [1, 1], [2, 1]] },
    { id: 'N5', cells: [[0, 1], [1, 1], [2, 0], [2, 1], [3, 0]] },
    { id: 'Y5', cells: [[0, 1], [1, 0], [1, 1], [2, 1], [3, 1]] },
    { id: 'L5', cells: [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]] },
  ];
  var EASY = ['L4', 'S4', 'P5', 'L5'];           // 유치·초저용 — 칸이 적고 모양이 단순한 것
  var FILL = ['#2B4C3F', '#8FB9A5', '#E3B23C', '#B0483A'];

  function seeded(seed) { var s = (seed >>> 0) || 1; return function () { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
  function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length) % arr.length]; }
  function shuffle(rnd, arr) { var a = arr.slice(); for (var i = a.length - 1; i > 0; i--) { var k = Math.floor(rnd() * (i + 1)); var t = a[i]; a[i] = a[k]; a[k] = t; } return a; }

  /* ── 칸 집합 연산 ── */
  function normalize(cells) {
    var mr = Infinity, mc = Infinity;
    cells.forEach(function (c) { if (c[0] < mr) mr = c[0]; if (c[1] < mc) mc = c[1]; });
    return cells.map(function (c) { return [c[0] - mr, c[1] - mc]; }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
  }
  function rotate(cells) { return normalize(cells.map(function (c) { return [c[1], -c[0]]; })); }     // 시계 방향 90°
  function mirror(cells) { return normalize(cells.map(function (c) { return [c[0], -c[1]]; })); }     // 좌우 반전
  function turn(cells, k) { var out = normalize(cells); for (var i = 0; i < (k % 4); i++) out = rotate(out); return out; }
  function key(cells) { return normalize(cells).map(function (c) { return c[0] + ',' + c[1]; }).join(';'); }
  function size(cells) { var h = 0, w = 0; cells.forEach(function (c) { if (c[0] + 1 > h) h = c[0] + 1; if (c[1] + 1 > w) w = c[1] + 1; }); return { h: h, w: w }; }

  /* ── SVG — 숫자와 고정 팔레트만 쓴다 ── */
  function svgOpen(w, h, cls) { return '<svg class="' + (cls || 'sh') + '" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-hidden="true">'; }
  function cellsSvg(cells, opt) {
    var o = opt || {};
    var n = o.n || 5, u = o.unit || 18, pad = 4, W = n * u + pad * 2;
    var sz = size(cells), ox = Math.floor((n - sz.w) / 2), oy = Math.floor((n - sz.h) / 2);
    var h = svgOpen(W, W, 'sh') + '<rect x="0" y="0" width="' + W + '" height="' + W + '" rx="6" fill="#ffffff" stroke="#c9d2cc"/>';
    cells.forEach(function (c) {
      h += '<rect x="' + (pad + (c[1] + ox) * u) + '" y="' + (pad + (c[0] + oy) * u) + '" width="' + u + '" height="' + u + '" fill="' + (o.fill || FILL[0]) + '" stroke="#ffffff" stroke-width="1.5"/>';
    });
    return h + '</svg>';
  }
  /* 쌓기나무 — 등각 투영. (r,c) 칸에 z 층. r+c 가 큰 것이 앞이라 뒤에서 앞으로 그린다 */
  function blocksSvg(hm) {
    var n = hm.length, u = 20, hz = 20;
    var W = (2 * n) * u + 16, H = n * u + 3 * hz + 24, ox = W / 2, oy = 12 + 3 * hz;
    var h = svgOpen(W, H, 'sh sh-iso');
    var cubes = [];
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) for (var z = 0; z < hm[r][c]; z++) cubes.push([r, c, z]);
    cubes.sort(function (a, b) { return (a[0] + a[1]) - (b[0] + b[1]) || a[2] - b[2]; });
    cubes.forEach(function (q) {
      var x = ox + (q[1] - q[0]) * u, y = oy + (q[1] + q[0]) * (u / 2) - q[2] * hz;
      var top = [[x, y - u / 2], [x + u, y], [x, y + u / 2], [x - u, y]];
      var left = [[x - u, y], [x, y + u / 2], [x, y + u / 2 + hz], [x - u, y + hz]];
      var right = [[x, y + u / 2], [x + u, y], [x + u, y + hz], [x, y + u / 2 + hz]];
      var poly = function (pts, fill) { return '<polygon points="' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '" fill="' + fill + '" stroke="#1f2b26" stroke-width="1"/>'; };
      h += poly(left, '#8FB9A5') + poly(right, '#5F8F7B') + poly(top, '#DCEBE2');
    });
    return h + '</svg>';
  }
  /* 조각 맞추기 — 2×2 색 타일을 거울로 펼친 4분면 무늬. 빠진 조각(오른쪽 아래)을 고른다 */
  function tileSvg(tile, u, hole) {
    var W = 2 * u + 4, h = svgOpen(W, W, 'sh') + '<rect x="0" y="0" width="' + W + '" height="' + W + '" rx="4" fill="#ffffff" stroke="#c9d2cc"/>';
    for (var r = 0; r < 2; r++) for (var c = 0; c < 2; c++) h += '<rect x="' + (2 + c * u) + '" y="' + (2 + r * u) + '" width="' + u + '" height="' + u + '" fill="' + FILL[tile[r][c]] + '"/>';
    return h + '</svg>';
  }
  function patternSvg(tile, u) {
    var q = quadrants(tile), W = 4 * u + 6;
    var h = svgOpen(W, W, 'sh sh-pat') + '<rect x="0" y="0" width="' + W + '" height="' + W + '" rx="4" fill="#ffffff" stroke="#c9d2cc"/>';
    var draw = function (t, dx, dy) { for (var r = 0; r < 2; r++) for (var c = 0; c < 2; c++) h += '<rect x="' + (3 + dx + c * u) + '" y="' + (3 + dy + r * u) + '" width="' + u + '" height="' + u + '" fill="' + FILL[t[r][c]] + '"/>'; };
    draw(q.tl, 0, 0); draw(q.tr, 2 * u, 0); draw(q.bl, 0, 2 * u);
    h += '<rect x="' + (3 + 2 * u) + '" y="' + (3 + 2 * u) + '" width="' + (2 * u) + '" height="' + (2 * u) + '" fill="#f3f1ec" stroke="#8a8f8b" stroke-dasharray="4 3"/>';
    h += '<text x="' + (3 + 3 * u) + '" y="' + (3 + 3 * u + 6) + '" text-anchor="middle" font-size="18" fill="#6A7A72">?</text>';
    return h + '</svg>';
  }
  var flipH = function (t) { return [[t[0][1], t[0][0]], [t[1][1], t[1][0]]]; };
  var flipV = function (t) { return [[t[1][0], t[1][1]], [t[0][0], t[0][1]]]; };
  var rotT = function (t) { return [[t[1][0], t[0][0]], [t[1][1], t[0][1]]]; };
  var tkey = function (t) { return t[0].join('') + '/' + t[1].join(''); };
  function quadrants(tile) { return { tl: tile, tr: flipH(tile), bl: flipV(tile), br: flipH(flipV(tile)) }; }

  /* ── 문제 생성 ── */
  function withOptions(rnd, target, correct, distractors, prompt, extra) {
    var opts = shuffle(rnd, [{ cells: correct, ok: true }].concat(distractors.map(function (d) { return { cells: d, ok: false }; })));
    var ai = opts.findIndex(function (o) { return o.ok; });
    return Object.assign({ prompt: prompt, target: target ? cellsSvg(target, { fill: FILL[0] }) : '', options: opts.map(function (o) { return cellsSvg(o.cells, { fill: FILL[0] }); }), answerIndex: ai, answerText: CIRCLED[ai] }, extra || {});
  }
  function distinct(list, avoid) {                       // avoid 와 겹치지 않는 것만, 서로도 겹치지 않게
    var seen = {}; avoid.forEach(function (c) { seen[key(c)] = true; });
    return list.filter(function (c) { var k = key(c); if (seen[k]) return false; seen[k] = true; return true; });
  }
  function rotations(cells) { return [0, 1, 2, 3].map(function (k) { return turn(cells, k); }); }

  var GEN = {
    odd: function (rnd, tier) {
      var pool = tier === 'K' || tier === 'E1' ? EASY : SHAPES.map(function (s) { return s.id; });
      var sh = SHAPES.filter(function (s) { return pool.indexOf(s.id) >= 0; });
      var base = turn(pick(rnd, sh).cells, Math.floor(rnd() * 4));
      var odd = mirror(base);
      var items = [base, base, base], at = Math.floor(rnd() * 4);
      items.splice(at, 0, odd);
      return { prompt: '넷 중 하나만 달라요. 다른 하나는?', target: '', options: items.map(function (c) { return cellsSvg(c, { fill: FILL[0] }); }), answerIndex: at, answerText: CIRCLED[at], hint: '뒤집힌 모양 하나가 섞여 있어요.' };
    },
    rotate: function (rnd, tier) {
      var sh = pick(rnd, SHAPES), other = pick(rnd, SHAPES.filter(function (s) { return s.id !== sh.id; }));
      var target = turn(sh.cells, Math.floor(rnd() * 4));
      var correct = turn(target, 1 + Math.floor(rnd() * 3));
      /* 오답 후보: 거울상의 네 회전 + 다른 도형의 네 회전. 과녁의 회전(=정답이 될 수 있는 것)과 서로 겹치는 것을 빼고 셋을 뽑는다 —
         무작위로 두 개를 뽑으면 같은 회전이 두 번 나와 보기가 겹치는 seed 가 생긴다 */
      var pool = shuffle(rnd, rotations(mirror(target)).slice(0, 2).concat(rotations(other.cells).slice(0, 1), rotations(mirror(target)).slice(2), rotations(other.cells).slice(1)));
      var dis = distinct(pool, rotations(target)).slice(0, 3);
      return withOptions(rnd, target, correct, dis, '왼쪽 모양을 돌리면(뒤집지 않고) 어느 것이 될까요?', { hint: '뒤집힌 것은 돌려도 같아지지 않아요.' });
    },
    mirror: function (rnd, tier) {
      var sh = pick(rnd, SHAPES), other = pick(rnd, SHAPES.filter(function (s) { return s.id !== sh.id; }));
      var target = turn(sh.cells, Math.floor(rnd() * 4));
      var correct = mirror(target);
      var pool = shuffle(rnd, [turn(target, 1), turn(target, 2), turn(other.cells, Math.floor(rnd() * 4))].concat([turn(target, 3)], rotations(other.cells)));
      var dis = distinct(pool, rotations(correct).concat([target])).slice(0, 3);
      return withOptions(rnd, target, correct, dis, '왼쪽 모양이 거울에 비치면 어느 것이 될까요?', { hint: '거울은 좌우를 바꿔요. 돌린 것과는 달라요.' });
    },
    blocks: function (rnd, tier) {
      var n = tier === 'K' || tier === 'E1' ? 2 : 3, maxZ = tier === 'K' ? 2 : 3;
      var hm = [], total = 0;
      for (var r = 0; r < n; r++) { hm.push([]); for (var c = 0; c < n; c++) { var z = Math.floor(rnd() * (maxZ + 1)); if (r === n - 1 && c === n - 1 && z === 0) z = 1; hm[r].push(z); total += z; } }
      if (total === 0) { hm[0][0] = 1; total = 1; }
      return { prompt: '쌓기나무는 모두 몇 개일까요? (보이지 않는 곳도 세요)', target: blocksSvg(hm), options: null, answerIndex: -1, answerText: total + '개', hint: '줄마다 세어 더해요. 뒤에 가려진 나무도 아래가 받치고 있어요.' };
    },
    complete: function (rnd, tier) {
      var tile, correct, dis, tries = 0;
      do {
        tile = [[Math.floor(rnd() * 3), Math.floor(rnd() * 3)], [Math.floor(rnd() * 3), Math.floor(rnd() * 3)]];
        correct = quadrants(tile).br;
        var cands = [tile, flipH(tile), rotT(tile), flipV(tile)], seen = {}; seen[tkey(correct)] = true;
        dis = cands.filter(function (t) { var k = tkey(t); if (seen[k]) return false; seen[k] = true; return true; });
        tries += 1;
      } while (dis.length < 3 && tries < 40);
      while (dis.length < 3) { var alt = [[(tile[0][0] + dis.length + 1) % 3, tile[0][1]], [tile[1][0], (tile[1][1] + dis.length + 1) % 3]]; if (tkey(alt) !== tkey(correct)) dis.push(alt); else dis.push([[2, 2], [2, 2]]); }
      var opts = shuffle(rnd, [{ t: correct, ok: true }].concat(dis.slice(0, 3).map(function (t) { return { t: t, ok: false }; })));
      var ai = opts.findIndex(function (o) { return o.ok; });
      return { prompt: '무늬는 가운데 선을 기준으로 거울처럼 접혀요. 빈 조각에 들어갈 것은?', target: patternSvg(tile, 18), options: opts.map(function (o) { return tileSvg(o.t, 18); }), answerIndex: ai, answerText: CIRCLED[ai], hint: '왼쪽 위 조각을 좌우로 한 번, 위아래로 한 번 뒤집은 것이에요.' };
    },
  };

  /* figure = { kind, seed, tier? } → { kind, label, prompt, target(svg), options([svg]|null), answerIndex, answerText, hint } */
  function make(figure) {
    if (!figure || KINDS.indexOf(figure.kind) < 0) return null;
    var seed = Number(figure.seed); if (!Number.isFinite(seed) || seed < 1) return null;
    var rnd = seeded(Math.floor(seed));
    var out = GEN[figure.kind](rnd, figure.tier || '');
    out.kind = figure.kind; out.label = LABEL[figure.kind];
    return out;
  }
  function isValidFigure(f) { return !!f && typeof f === 'object' && KINDS.indexOf(f.kind) >= 0 && Number.isFinite(Number(f.seed)) && Number(f.seed) >= 1 && Number(f.seed) <= 999999; }
  /* 화면 조각 — 문제(과녁)와 보기를 한 덩어리로. 문자열은 전부 이 모듈이 만든 것이라 이스케이프할 것이 없다 */
  function html(figure) {
    var g = make(figure);
    if (!g) return '<div class="np-fig np-fig-missing">도형을 그릴 수 없어요.</div>';
    var h = '<div class="np-fig">';
    if (g.target) h += '<div class="np-fig-target">' + g.target + '</div>';
    if (g.options) h += '<div class="np-fig-opts">' + g.options.map(function (s, i) { return '<div class="np-fig-opt"><span>' + CIRCLED[i] + '</span>' + s + '</div>'; }).join('') + '</div>';
    return h + '</div>';
  }
  return { KINDS: KINDS, LABEL: LABEL, SHAPES: SHAPES, make: make, html: html, isValidFigure: isValidFigure, seeded: seeded, normalize: normalize, rotate: rotate, mirror: mirror, turn: turn, key: key };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBSHAPES;
