'use strict';
/* WB 한자브레인 — 손가락 따라쓰기 판정 (순수 로직, 브라우저/Node 공용)
 *
 * 손이 획을 한 번 겪어야 한자가 눈에 들어온다. 화면은 캔버스에 안내 글자(폰트)를 옅게 깔고
 * 학생이 손가락으로 그 위를 긋는다. 여기서는 그 결과를 판정한다 — 캔버스는 만지지 않는다.
 * 획 좌표는 칸 한 변을 1로 둔 0~1 좌표다(화면 크기·회전에 무관).
 *
 * 두 가지 모드가 있고, 어느 쪽이 열리는지는 데이터가 정한다:
 *  · 모양 모드 — 글자 아무거나. 안내 글자의 알파 마스크(글리프)와 학생 획의 겹침을 잰다.
 *      hit  = 글리프 중 학생 잉크가 덮은 비율(굵기 여유 tol 만큼 부풀려 잰다)
 *      stray= 학생 잉크 중 글리프 밖으로 새어 나간 비율
 *    획수(strokes)가 있으면 그은 획 수를 대조한다.
 *  · 획순 모드 — 획순 데이터(medians: 획 순서대로의 중심선)가 있는 글자만.
 *    학생의 한 획을 남은 중심선들과 대어 어느 획인지·방향이 맞는지·순서가 맞는지를 판정한다.
 *
 * 획순 데이터가 없는 글자의 획순은 채점하지 않는다. 데이터 없이 "틀렸다"고 말하면 맞는 획순도
 * 틀렸다고 하게 되고, 틀린 채점은 채점을 안 하느니만 못하다(워드브레인 trace.js 의 결론 그대로).
 *
 * 세 번 쓰되 안내가 회차마다 옅어진다 — 보고 그리고, 흐릿한 것을 더듬고, 기억에서 꺼내 쓴다.
 * 베끼기 세 번은 손만 움직이고 기억은 안 남는다(인출 난이도 사다리). */
var WBHTRACE = (function () {

  var REPS = 3;
  var GUIDE = [0.32, 0.14, 0];       /* 회차별 안내 글자 진하기 — 마지막은 0, 빈 칸에 스스로 쓴다 */
  var HANJA_ONE = /[㐀-䶿一-鿿豈-﫿]/;

  function guideAlpha(rep) {
    var i = Math.floor(Number(rep));
    if (!isFinite(i) || i < 0) return GUIDE[0];
    return i < GUIDE.length ? GUIDE[i] : 0;
  }

  function chars(str) {
    var out = [];
    String(str == null ? '' : str).split('').forEach(function (c) { if (HANJA_ONE.test(c)) out.push(c); });
    return out;
  }

  /* 글자 하나를 세 번 쓰고 다음 글자로 — 觀→測→觀→測로 섞으면 획이 손에 붙기 전에 화면이 바뀐다 */
  function plan(str, reps) {
    var n = reps || REPS, out = [];
    chars(str).forEach(function (c) { for (var r = 0; r < n; r++) out.push({ ch: c, rep: r, last: r === n - 1 }); });
    return out;
  }

  /* ── 획 길이·개수 ── */
  function segLen(a, b) {
    var dx = Number(b.x) - Number(a.x), dy = Number(b.y) - Number(a.y), d = Math.sqrt(dx * dx + dy * dy);
    return isFinite(d) ? d : 0;
  }
  function strokeLen(st) {
    var sum = 0, list = Array.isArray(st) ? st : [];
    for (var i = 1; i < list.length; i++) if (list[i - 1] && list[i]) sum += segLen(list[i - 1], list[i]);
    return sum;
  }
  function inkLen(strokes) {
    var sum = 0, list = Array.isArray(strokes) ? strokes : [];
    for (var s = 0; s < list.length; s++) sum += strokeLen(list[s]);
    return sum;
  }
  /* 통과에 필요한 최소 잉크 — 칸 한 변의 0.45배. 一 처럼 한 획짜리도 통과해야 하고, 톡 찍고 넘기기는 막힌다 */
  function minInk(size) { var s = Number(size); return (isFinite(s) && s > 0 ? s : 1) * 0.45; }
  function enough(strokes, size) { return inkLen(strokes) >= minInk(size); }
  /* 그은 획 수 — 아주 짧은 것(실수로 톡 닿은 것)은 세지 않되, 점(丶)은 획이라 0.02 부터 센다 */
  function strokeCount(strokes, minLen) {
    var m = minLen == null ? 0.02 : minLen, n = 0, list = Array.isArray(strokes) ? strokes : [];
    for (var s = 0; s < list.length; s++) if (strokeLen(list[s]) >= m || (list[s] && list[s].length >= 4)) n += 1;
    return n;
  }

  /* ── 래스터 — n×n 격자에 잉크를 찍는다 (radius 는 칸 단위 반지름) ── */
  function rasterize(strokes, n, radius) {
    var mask = new Uint8Array(n * n), r = radius == null ? Math.max(1, n * 0.035) : radius, r2 = r * r;
    var list = Array.isArray(strokes) ? strokes : [];
    function stamp(ax, ay, bx, by) {
      var x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(n - 1, Math.ceil(Math.max(ax, bx) + r));
      var y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(n - 1, Math.ceil(Math.max(ay, by) + r));
      var vx = bx - ax, vy = by - ay, vv = vx * vx + vy * vy;
      for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
        var px = x + 0.5, py = y + 0.5, t = vv > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / vv)) : 0;
        var cx = ax + t * vx, cy = ay + t * vy, dx = px - cx, dy = py - cy;
        if (dx * dx + dy * dy <= r2) mask[y * n + x] = 1;
      }
    }
    for (var s = 0; s < list.length; s++) {
      var st = list[s];
      if (!Array.isArray(st) || !st.length) continue;
      if (st.length === 1) stamp(st[0].x * n, st[0].y * n, st[0].x * n, st[0].y * n);
      for (var i = 1; i < st.length; i++) stamp(st[i - 1].x * n, st[i - 1].y * n, st[i].x * n, st[i].y * n);
    }
    return mask;
  }
  function dilate(mask, n, r) {
    var out = new Uint8Array(mask), rr = Math.max(0, Math.round(r)), r2 = rr * rr;
    if (!rr) return out;
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      if (!mask[y * n + x]) continue;
      for (var dy = -rr; dy <= rr; dy++) for (var dx = -rr; dx <= rr; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        var yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < n && xx >= 0 && xx < n) out[yy * n + xx] = 1;
      }
    }
    return out;
  }
  function count(mask) { var c = 0; for (var i = 0; i < mask.length; i++) if (mask[i]) c += 1; return c; }

  /* 글리프(안내 글자 마스크)와 잉크(학생 획 마스크)의 겹침. tol 은 굵기 여유(칸) — 손가락은 펜보다 굵다 */
  function coverage(glyph, ink, n, opts) {
    var tol = (opts && opts.tol != null) ? opts.tol : Math.max(1, Math.round(n * 0.07));
    var gd = dilate(glyph, n, tol), id = dilate(ink, n, tol);
    var g = 0, hitN = 0, k = 0, strayN = 0;
    for (var i = 0; i < n * n; i++) {
      if (glyph[i]) { g += 1; if (id[i]) hitN += 1; }
      if (ink[i]) { k += 1; if (!gd[i]) strayN += 1; }
    }
    return { hit: g ? hitN / g : 0, stray: k ? strayN / k : 0, glyphPx: g, inkPx: k };
  }

  /* 판정 — good(잘 썼어요) · ok(비슷해요) · retry(다시). 획수가 있으면 대조해 한 단계 낮춘다 */
  function verdict(cov, drawn, expected) {
    var hit = cov ? cov.hit : 0, stray = cov ? cov.stray : 1;
    /* 잉크 과다 — 칸을 통째로 칠하면 글리프를 다 덮어 hit 이 높고, 빽빽한 글자는 stray 도 낮다.
       글리프 넓이의 몇 배를 칠했는지로 잡는다(손가락 획은 굵어서 제대로 써도 1.5~2배쯤 된다). */
    var over = cov && cov.glyphPx ? cov.inkPx / cov.glyphPx : 0;
    var level = (hit >= 0.78 && stray <= 0.3 && over <= 2.6) ? 'good' : ((hit >= 0.55 && stray <= 0.55 && over <= 4.5) ? 'ok' : 'retry');
    var msg = level === 'good' ? '글자 모양이 잘 맞아요 ✍️'
      : level === 'ok' ? (over > 2.6 ? '칸을 너무 많이 칠했어요 — 글자의 획만 따라 그어요.' : stray > 0.3 ? '모양은 비슷한데 칸 밖으로 새어 나간 획이 있어요.' : '모양이 비슷해요 — 빠진 획이 없는지 보세요.')
      : (over > 4.5 ? '칸을 통째로 칠하면 글자를 익힌 게 아니에요 — 획을 하나씩 따라 그어요.' : hit < 0.55 ? '안내 글자를 다 덮지 못했어요 — 획을 끝까지 그어 보세요.' : '글자와 다른 자리에 그은 획이 많아요.');
    var strokeMsg = null;
    if (expected && drawn != null && drawn > 0 && drawn !== expected) {
      strokeMsg = '이 글자는 ' + expected + '획인데 ' + drawn + '획으로 썼어요' + (drawn < expected ? ' — 한 번에 이어 쓴 획이 있나요?' : ' — 끊어 쓴 획이 있나요?');
      if (level === 'good') { level = 'ok'; msg = '모양은 잘 맞아요.'; }
    }
    var score = Math.max(0, Math.min(1, hit - 0.5 * stray));
    return { level: level, score: Math.round(score * 100) / 100, msg: msg, strokeMsg: strokeMsg };
  }

  /* ── 획순 모드: 학생의 한 획 ↔ 중심선(medians) 대조 ── */
  function toPts(poly) {
    return (Array.isArray(poly) ? poly : []).map(function (p) {
      return Array.isArray(p) ? { x: Number(p[0]), y: Number(p[1]) } : { x: Number(p.x), y: Number(p.y) };
    }).filter(function (p) { return isFinite(p.x) && isFinite(p.y); });
  }
  /* 호 길이 기준 k 점으로 다시 찍는다 — 빨리 그은 획(점 몇 개)과 천천히 그은 획(점 수백 개)을 같은 눈금으로 */
  function resample(poly, k) {
    var pts = toPts(poly), out = [];
    if (!pts.length) return out;
    if (pts.length === 1) { for (var z = 0; z < k; z++) out.push({ x: pts[0].x, y: pts[0].y }); return out; }
    var total = 0, i;
    for (i = 1; i < pts.length; i++) total += segLen(pts[i - 1], pts[i]);
    if (total === 0) { for (var z2 = 0; z2 < k; z2++) out.push({ x: pts[0].x, y: pts[0].y }); return out; }
    var step = total / (k - 1), acc = 0, seg = 1, pos = 0;
    out.push({ x: pts[0].x, y: pts[0].y });
    while (out.length < k - 1 && seg < pts.length) {
      var a = pts[seg - 1], b = pts[seg], L = segLen(a, b);
      if (acc + (L - pos) >= step) {
        var need = step - acc, t = L ? (pos + need) / L : 0;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        pos += need; acc = 0;
      } else { acc += L - pos; pos = 0; seg += 1; }
    }
    while (out.length < k) out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
    return out;
  }
  function polyDist(a, b) {
    var n = Math.min(a.length, b.length), sum = 0;
    if (!n) return Infinity;
    for (var i = 0; i < n; i++) sum += segLen(a[i], b[i]);
    return sum / n;
  }

  /* user: 학생의 한 획 [{x,y}…] · medians: 글자의 중심선들 · done: 이미 맞힌 획 번호들
     → { idx, dist, reversed, ok, outOfOrder, expected } */
  function matchStroke(user, medians, done, opts) {
    var K = (opts && opts.samples) || 12, tol = (opts && opts.tol) || 0.13;
    var doneSet = {};
    (done || []).forEach(function (i) { doneSet[i] = true; });
    var expected = -1;
    for (var e = 0; e < (medians || []).length; e++) if (!doneSet[e]) { expected = e; break; }
    var u = resample(user, K), best = null;
    for (var i = 0; i < (medians || []).length; i++) {
      if (doneSet[i]) continue;
      var m = resample(medians[i], K);
      var d = polyDist(u, m), dr = polyDist(u, m.slice().reverse());
      var cand = { idx: i, dist: Math.min(d, dr), reversed: dr < d, fwd: d };
      if (!best || cand.dist < best.dist) best = cand;
    }
    if (!best) return { idx: -1, dist: Infinity, reversed: false, ok: false, outOfOrder: false, expected: expected };
    /* 방향이 맞는 쪽 거리로 통과를 정한다 — 거꾸로 그은 획은 자리가 맞아도 통과가 아니다 */
    var ok = best.fwd <= tol;
    return { idx: best.idx, dist: Math.round(best.dist * 1000) / 1000, reversed: !ok && best.reversed && best.dist <= tol, ok: ok, outOfOrder: ok && best.idx !== expected, expected: expected };
  }

  /* 판정 → 학생에게 할 말. 통과여도 순서가 어긋났으면 알려 준다(획은 인정).
     medians 를 주면 거꾸로 그은 획의 바른 방향을 말로 알려 준다. */
  function strokeHint(res, medians) {
    if (!res) return '';
    var n = (medians || []).length;
    var ord = function (i) { return (i + 1) + '번째 획'; };
    if (res.ok && res.outOfOrder) return '획은 맞는데 순서가 달라요 — ' + ord(res.expected) + '부터 쓰는 순서예요.';
    if (res.ok) return res.idx === n - 1 ? '마지막 획까지 다 썼어요 ✍️' : '좋아요, 다음 획!';
    if (res.reversed) {
      var dir = medians && medians[res.idx] ? directionOf(medians[res.idx]) : '';
      return '방향이 반대예요 — 이 획은 ' + (dir ? dir + ' ' : '') + '그어요.';
    }
    return ord(res.expected) + '을 안내선을 따라 그어 보세요.';
  }
  /* 중심선의 방향 낱말 — 시작점과 끝점의 큰 축으로 말한다 */
  function directionOf(median) {
    var p = toPts(median);
    if (p.length < 2) return '';
    var dx = p[p.length - 1].x - p[0].x, dy = p[p.length - 1].y - p[0].y;
    if (Math.abs(dx) >= Math.abs(dy) * 1.6) return dx > 0 ? '왼쪽에서 오른쪽으로' : '오른쪽에서 왼쪽으로';
    if (Math.abs(dy) >= Math.abs(dx) * 1.6) return dy > 0 ? '위에서 아래로' : '아래에서 위로';
    if (dy > 0) return dx > 0 ? '왼쪽 위에서 오른쪽 아래로' : '오른쪽 위에서 왼쪽 아래로';
    return dx > 0 ? '왼쪽 아래에서 오른쪽 위로' : '오른쪽 아래에서 왼쪽 위로';
  }

  return {
    REPS: REPS, GUIDE: GUIDE, guideAlpha: guideAlpha, chars: chars, plan: plan,
    inkLen: inkLen, strokeLen: strokeLen, minInk: minInk, enough: enough, strokeCount: strokeCount,
    rasterize: rasterize, dilate: dilate, count: count, coverage: coverage, verdict: verdict,
    resample: resample, polyDist: polyDist, matchStroke: matchStroke, strokeHint: strokeHint, directionOf: directionOf,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBHTRACE;
