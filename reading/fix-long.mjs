'use strict';
/* 8어절 넘는 조각을 쪼갠다 (node reading/fix-long.mjs [--write])
 *
 * 규격서 2장: 「8어절이 넘으면 거의 항상 두 개로 쪼갤 자리가 있다」.
 * 넘는 조각은 학생이 한 호흡에 삼켜야 하는 덩어리라 끊어 읽기의 목적이 무너진다.
 *
 * ── 왜 chunk() 로 통째로 다시 끊지 않는가 ────────────────────
 * chunk() 는 학년대 목표 길이(L4 4.5)에 맞춰 다시 나눈다. 그런데 문제가 된 17편은
 * 원래 조각이 평균 6어절이라, 11어절 하나만 3조각으로 잘게 부수면 그 문단만
 * 호흡이 달라진다. 여기서는 «위반만 없앤다» — 8어절 이하가 되는 가장 적은
 * 수로만 쪼개고, 그 안에서 가장 좋은 자리를 고른다. 나머지 경계는 손대지 않는다.
 *
 * 자리는 chunk.mjs 의 breakScore 를 그대로 쓴다. 끊으면 안 되는 자리(관형어·부사·
 * 수와 단위·의존명사 앞)는 거기서 0 이 나오므로 후보에서 빠진다.
 * 후보가 하나도 없으면 쪼개지 않고 그대로 두고 보고한다 — 억지로 가르면
 * 「매우 ∕ 높은」 같은 것이 나온다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { breakScore, forbidden, words } from './chunk.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIMIT = 8;

/** 어절 배열을 k조각(각 LIMIT 이하)으로 가르는 가장 좋은 방법.
 *  점수 = 경계 품질의 합. 같으면 길이가 고른 쪽. */
function bestCuts(ws, k) {
  const n = ws.length;
  /* dp[i][j] = 앞 i어절을 j조각으로 나눈 최고 점수 */
  const NEG = -Infinity;
  const dp = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(NEG));
  const back = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(-1));
  const bal = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(0));
  dp[0][0] = 0;
  const ideal = n / k;
  for (let j = 1; j <= k; j++) {
    for (let i = 1; i <= n; i++) {
      for (let p = Math.max(0, i - LIMIT); p <= i - MIN_PIECE; p++) {
        if (dp[p][j - 1] === NEG) continue;
        /* p..i-1 을 한 조각으로. i<n 이면 i-1 뒤가 새 경계다 */
        let q = 0;
        if (i < n) {
          q = breakScore(ws, i - 1); if (q === 0) continue;
          if (STICKY.has(ws[i - 1].trim())) q = Math.min(q, 0.05);   /* 붙는 낱말이면 낮춰 본다 */
        }
        const d = (i - p) - ideal;
        const score = dp[p][j - 1] + q;
        const pen = bal[p][j - 1] + d * d;
        if (score > dp[i][j] + 1e-9 || (Math.abs(score - dp[i][j]) <= 1e-9 && pen < bal[i][j])) {
          dp[i][j] = score; back[i][j] = p; bal[i][j] = pen;
        }
      }
    }
  }
  if (dp[n][k] === NEG) return null;
  const cuts = [];
  let i = n;
  for (let j = k; j > 0; j--) { const p = back[i][j]; cuts.unshift([p, i]); i = p; }
  /* 고른 자리들의 점수 — 가장 낮은 것이 이 쪼갬의 자신감이다 */
  const qs = cuts.slice(1).map(([a]) => breakScore(ws, a - 1));
  return { parts: cuts.map(([a, b]) => ws.slice(a, b).join('')), worst: qs.length ? Math.min(...qs) : 1, qs };
}

const dbPath = path.join(HERE, 'articles.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

/* ── 잘 안 끊기는 낱말 ──
   어미 확률로는 관형형을 못 가른다 — 「맡기는」의 는과 「사회는」의 는이 같은 글자라
   통계가 섞인다(규격서 3장). 그래서 여기서는 «낱말 그 자체»의 끊김률을 센다.
   8번 이상 나오고 10% 이하로만 끊긴 낱말은 뒤에 뭔가 매달려 있다고 보고 피한다.
   내용어를 외울 위험이 있지만, 여기서는 «안 끊는다» 쪽으로만 작동하므로
   최악이라도 사람 손으로 넘어갈 뿐 잘못 자르지는 않는다. */
const seen = new Map(), broke = new Map();
for (const a of db.articles) for (const b of Object.values(a.levels || {}))
  for (const p of b.paragraphs || []) {
    if (!Array.isArray(p)) continue;
    const text = p.join(''); const cuts = new Set(); let c = 0;
    for (let i = 0; i < p.length - 1; i++) { c += p[i].length; cuts.add(c); }
    for (const m of text.matchAll(/\S+\s*/g)) {
      const w = m[0].trim(); if (!w) continue;
      seen.set(w, (seen.get(w) || 0) + 1);
      if (cuts.has(m.index + m[0].length)) broke.set(w, (broke.get(w) || 0) + 1);
    }
  }
const STICKY = new Set([...seen].filter(([w, n]) => n >= 8 && (broke.get(w) || 0) / n <= 0.10).map(([w]) => w));

const write = process.argv.includes('--write');

const MIN_Q = 0.30;
/* 1어절짜리 조각은 만들지 않는다. 「…말해 ∕ 준다.」·「…데버라 ∕ 스미스다.」 처럼
   꼬리만 떼는 꼴이 되는데, 그건 끊어 읽기가 아니라 잘못 자른 것이다. */
const MIN_PIECE = 2;
/* 사람이 정한 자리 — 133개를 하나씩 보고 적어 둔 표.
   도구 제안은 80%쯤 맞았다. 남은 20%가 관형어와 명사 사이(「맡기는 ∕ 구조인」),
   복합명사(「대뇌 ∕ 피질」), 인용 제목 안, 수의 범위(「아홉 시간에서 ∕ 열 시간」)라
   확률로는 못 가른다. 그래서 표를 정본으로 삼고, 도구는 표에 없는 것만 제안한다. */
const CUTS = JSON.parse(fs.readFileSync(path.join(HERE, 'long-cuts.json'), 'utf8'));
let over = 0, fixed = 0, stuck = 0, weak = 0, byHand = 0;
const report = [];
for (const a of db.articles) {
  for (const [lv, body] of Object.entries(a.levels || {})) {
    (body.paragraphs || []).forEach((p, pi) => {
      if (!Array.isArray(p)) return;
      const before = p.join('');
      const out = [];
      let changed = false;
      p.forEach((seg, si) => {
        const ws = words(seg);
        if (ws.length <= LIMIT) { out.push(seg); return; }
        over += 1;
        const key = `${a.id}/${lv}/p${pi}/s${si}`;
        if (CUTS[key]) {
          /* 값은 [어절번호…] 또는 {at:[…], why:"규칙을 어기는 사유"}.
             why 를 적으면 규칙 검사를 건너뛴다 — 규칙이 볼 수 없는 문맥이 있을 때만.
             사유 없이는 못 건너뛰게 해서, 귀찮다고 우회하는 일을 막는다. */
          const spec = CUTS[key];
          const at = Array.isArray(spec) ? spec : spec.at;
          const why = Array.isArray(spec) ? null : spec.why;
          const bad = at.filter(i => i < 1 || i >= ws.length);
          if (bad.length) throw new Error(`${key}: 어절 번호 ${bad.join(',')} 가 범위(1~${ws.length - 1}) 밖입니다`);
          const parts = [];
          let prev = 0;
          for (const i of at.concat([ws.length])) { parts.push(ws.slice(prev, i).join('')); prev = i; }
          const tooLong = parts.filter(x => words(x).length > LIMIT);
          if (tooLong.length) throw new Error(`${key}: 쪼갠 뒤에도 ${LIMIT}어절을 넘는 조각이 남습니다`);
          /* 손으로 고른 자리도 규칙은 지켜야 한다. 표를 쓰면 규칙을 건너뛰게 되는데,
             「환경 ∕ 전반의」·「이미 ∕ 누군가의」 처럼 사람도 실수한다. */
          for (const i of why ? [] : at) {
            const bad = forbidden(ws, i - 1);
            if (bad)
              throw new Error(`${key}: ${i}번째 어절 「${ws[i - 1].trim()}」 뒤에서 끊을 수 없습니다 — ${bad}`
                + ` — 규칙이 볼 수 없는 문맥이라면 {"at":[${at}],"why":"…"} 로 사유를 적으세요`);
          }
          if (parts.some(x => words(x).length < 2))
            throw new Error(`${key}: 1어절짜리 조각이 생깁니다`);
          byHand += 1; changed = true;
          report.push({ id: a.id, lv, pi, n: ws.length, seg, parts, hand: true });
          out.push(...parts);
          return;
        }
        const k = Math.ceil(ws.length / LIMIT);
        const r = bestCuts(ws, k);
        if (!r) {
          stuck += 1;
          report.push({ id: a.id, lv, pi, n: ws.length, seg, parts: null });
          out.push(seg);
          return;
        }
        /* 기저 끊김률(0.22)에 못 미치는 자리는 자동으로 가르지 않는다.
           그런 자리는 대개 관형어와 명사 사이여서(「맡기는 ∕ 구조인」) 손으로
           봐야 한다. 확률이 못 가르는 자리가 있다는 것은 규격서 3장에 적혀 있다. */
        if (r.worst < MIN_Q) {
          weak += 1;
          report.push({ id: a.id, lv, pi, n: ws.length, seg, parts: r.parts, qs: r.qs, weak: true });
          out.push(seg);
          return;
        }
        fixed += 1; changed = true;
        report.push({ id: a.id, lv, pi, n: ws.length, seg, parts: r.parts, qs: r.qs });
        out.push(...r.parts);
      });
      if (!changed) return;
      if (out.join('') !== before) throw new Error(`${a.id}/${lv} 문단 ${pi}: 글자가 샜다`);
      body.paragraphs[pi] = out;
    });
  }
}

const only = process.argv.includes('--weak') ? report.filter(r => r.weak || !r.parts) : report;
for (const r of only) {
  const mark = !r.parts ? '✗' : r.weak ? '⚠' : r.hand ? '✎' : '·';
  console.log(`\n${mark} ${r.id} / ${r.lv} 문단${r.pi}  ${r.n}어절${r.qs ? '  [' + r.qs.map(q => q.toFixed(2)).join(' ') + ']' : ''}`);
  console.log(`   전: ${r.seg.trim()}`);
  if (!r.parts) { console.log('   끊을 자리를 아예 못 찾았습니다 — 손으로 봐 주세요'); continue; }
  console.log(`   ${r.weak ? '안(보류)' : '후'}: ${r.parts.map(x => x.trim()).join('  ∕  ')}`);
}
console.log(`\n8어절 초과 ${over}개 · 표대로 ${byHand} · 도구가 쪼갬 ${fixed} · 보류 ${weak} · 자리 못 찾음 ${stuck}`);
if (write) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2) + '\n');
  console.log('articles.json 에 반영했습니다. node reading/build-split.mjs 를 잊지 마세요.');
} else {
  console.log('(미리 보기입니다. 반영하려면 --write)');
}
