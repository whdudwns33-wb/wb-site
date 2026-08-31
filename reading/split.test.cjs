#!/usr/bin/env node
'use strict';
/* 분할 파일 무결성 — node reading/split.test.cjs
 *
 * 분할본은 커밋되는 산출물이라, articles.json만 고치고 재생성을 잊으면
 * 학생 앱이 옛 지문을 계속 보게 된다. 이 테스트가 그걸 막는다.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const LEVELS = ['L1', 'L2', 'L3', 'L4'];
const read = (n) => JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'));
const errors = [];
const E = (m) => errors.push(m);

const db = read('articles.json');

/* ── 1. 재생성 결과와 커밋된 파일이 같은가 ─────────────── */
const before = {};
const names = [...LEVELS.map(l => `articles-${l}.json`), 'hanja.json', 'version.json'];
names.forEach(n => {
  const p = path.join(DIR, n);
  before[n] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (before[n] == null) E(`${n} 없음 — node reading/build-split.mjs 를 실행하세요`);
});
if (!errors.length) {
  execFileSync(process.execPath, [path.join(DIR, 'build-split.mjs')], { stdio: 'pipe' });
  names.forEach(n => {
    const now = fs.readFileSync(path.join(DIR, n), 'utf8');
    if (now !== before[n]) E(`${n} 이 articles.json 과 어긋납니다 — node reading/build-split.mjs 를 실행하고 커밋하세요`);
  });
}

/* ── 2. 학년대별 파일이 원본과 일치하는가 ───────────────── */
LEVELS.forEach(lv => {
  const f = `articles-${lv}.json`;
  if (!fs.existsSync(path.join(DIR, f))) return;
  const sub = read(f);
  if (sub.version !== db.version) E(`${f}: version 불일치 (${sub.version} vs ${db.version})`);
  if (sub.level !== lv) E(`${f}: level 필드 오류`);

  const want = db.articles.filter(a => a.levels && a.levels[lv]);
  if (sub.articles.length !== want.length) E(`${f}: 지문 수 ${sub.articles.length} (기대 ${want.length})`);
  want.forEach((a, i) => {
    const g = sub.articles[i];
    if (!g || g.id !== a.id) { E(`${f}: ${i}번째 지문 id 불일치`); return; }
    /* 본문·문항이 원본과 글자 하나까지 같은가 */
    if (JSON.stringify(g.levels[lv]) !== JSON.stringify(a.levels[lv])) E(`${f}: ${a.id} 본문이 원본과 다름`);
    /* 다른 학년대가 섞여 들어가지 않았는가 (분할의 목적) */
    const extra = Object.keys(g.levels).filter(k => k !== lv);
    if (extra.length) E(`${f}: ${a.id} 에 다른 학년대(${extra.join(',')})가 남아 있음`);
    /* 지문 바깥 메타(출처·진로·발행상태)는 그대로 따라와야 한다 */
    ['category', 'status', 'careers', 'sources'].forEach(k => {
      if (JSON.stringify(g[k]) !== JSON.stringify(a[k])) E(`${f}: ${a.id} 의 ${k} 불일치`);
    });
  });
  if (db.diagnostics[lv] && JSON.stringify(sub.diagnostics[lv]) !== JSON.stringify(db.diagnostics[lv]))
    E(`${f}: 진단 지문 불일치`);
});

/* ── 3. 한자 파일이 앱 로직과 같은 결과인가 ─────────────── */
if (fs.existsSync(path.join(DIR, 'hanja.json'))) {
  const hj = read('hanja.json');
  const map = {};
  for (const a of db.articles) {
    if (a.status !== 'published') continue;
    for (const lv of LEVELS) {
      const b = a.levels[lv];
      if (!b) continue;
      for (const v of b.vocab || []) {
        if (!v.hanja) continue;
        for (const part of v.hanja.split('+')) {
          const m = part.trim().match(/^(.)\((.+)\)$/);
          if (!m) continue;
          if (!map[m[1]]) map[m[1]] = { ch: m[1], rd: m[2], words: {} };
          const at = v.hanja.split('+').findIndex(x => x.trim().indexOf(m[1]) === 0);
          map[m[1]].words[v.word] = { word: v.word, easy: v.easy, hanja: v.hanja, at: at < 0 ? -1 : at };
        }
      }
    }
  }
  const want = Object.values(map).map(f => ({ ch: f.ch, rd: f.rd, words: Object.values(f.words) }))
    .filter(f => f.words.length >= 2).sort((x, y) => y.words.length - x.words.length);
  if (JSON.stringify(hj.families) !== JSON.stringify(want)) E('hanja.json 이 원본 어휘와 어긋납니다');
  /* 초안 지문의 한자가 새어 들어가지 않았는가 */
  const draftWords = new Set();
  db.articles.filter(a => a.status !== 'published').forEach(a =>
    LEVELS.forEach(lv => (a.levels[lv]?.vocab || []).forEach(v => v.hanja && draftWords.add(v.word))));
  const pubWords = new Set();
  db.articles.filter(a => a.status === 'published').forEach(a =>
    LEVELS.forEach(lv => (a.levels[lv]?.vocab || []).forEach(v => pubWords.add(v.word))));
  hj.families.forEach(f => f.words.forEach(w => {
    if (draftWords.has(w.word) && !pubWords.has(w.word)) E(`hanja.json 에 초안 지문의 낱말 "${w.word}" 노출`);
  }));
}

/* ── 4. 크기 — 분할이 실제로 이득인가 ───────────────────── */
const full = fs.statSync(path.join(DIR, 'articles.json')).size;
const biggest = Math.max(...LEVELS.map(l => {
  const p = path.join(DIR, `articles-${l}.json`);
  return fs.existsSync(p) ? fs.statSync(p).size : 0;
}));
if (biggest >= full) E(`분할 이득 없음 (가장 큰 학년대 ${biggest} ≥ 전체 ${full})`);

if (errors.length) {
  errors.forEach(e => console.error('ERROR:', e));
  console.error(`\nFAIL — ${errors.length}건`);
  process.exit(1);
}
console.log(`OK — 분할 4개 학년대 + 한자 + 버전, 원본과 일치 (가장 큰 학년대가 전체의 ${Math.round(biggest / full * 100)}%)`);
