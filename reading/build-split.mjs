#!/usr/bin/env node
/* 지문 데이터 분할 — node reading/build-split.mjs
 *
 * 학생 앱은 켤 때마다 articles.json 전체를 받았다. 지금은 1MB(전송 215KB)지만
 * 주 4~5편 × 4개 학년대로 쌓이면 1년 뒤 7MB가 된다. 학생에게 필요한 것은
 * 자기 학년대 하나뿐이므로 미리 쪼개 둔다.
 *
 *   articles-L1.json … articles-L4.json   학년대별 (앱이 하나만 받는다)
 *   hanja.json                            한자 카드 — 전 학년대 어휘를 훑어야 해서 미리 계산
 *   version.json                          캐시 무효화용 (작고 캐시 안 함)
 *
 * articles.json(전체)은 그대로 둔다 — 관리 웹·검수 웹·서버가 쓴다.
 * 생성물은 저장소에 커밋한다. 미러(GitHub Pages)에는 빌드 단계가 없기 때문이다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
/* 산출물을 다른 곳에 쓰고 싶으면 인자로 폴더를 준다.
 * split.test.cjs 가 이걸 써서 임시 폴더에 빌드한 뒤 커밋본과 비교한다 —
 * 검사가 작업 트리를 덮어쓰면 실패가 스스로 고쳐져 재실행 때 통과해 버리고,
 * 그러면 진짜 빠뜨린 재생성이 "그냥 한 번 튄 것"으로 보인다. */
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : DIR;
const LEVELS = ['L1', 'L2', 'L3', 'L4'];
const db = JSON.parse(fs.readFileSync(path.join(DIR, 'articles.json'), 'utf8'));
const write = (name, obj) => {
  const s = JSON.stringify(obj);
  fs.writeFileSync(path.join(OUT, name), s + '\n');
  return s.length;
};

/* ── 학년대별 ─────────────────────────────────────────── */
const sizes = {};
for (const lv of LEVELS) {
  const articles = db.articles
    .filter(a => a.levels && a.levels[lv])
    .map(a => ({ ...a, levels: { [lv]: a.levels[lv] } }));
  sizes[lv] = write(`articles-${lv}.json`, {
    version: db.version, level: lv, articles,
    diagnostics: db.diagnostics[lv] ? { [lv]: db.diagnostics[lv] } : {},
  });
}

/* ── 한자 카드 — 앱의 hanjaFamilies()와 같은 규칙 ─────── */
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
const families = Object.values(map)
  .map(f => ({ ch: f.ch, rd: f.rd, words: Object.values(f.words) }))
  .filter(f => f.words.length >= 2)
  .sort((x, y) => y.words.length - x.words.length);
const hjSize = write('hanja.json', { version: db.version, families });

/* ── 버전 — 앱이 이것만 캐시 없이 받고, 나머지는 ?v= 로 붙여 캐시한다 ── */
write('version.json', { v: db.version });

const kb = n => Math.round(n / 1024) + ' KB';
const full = fs.statSync(path.join(DIR, 'articles.json')).size;
console.log(`분할 완료 — 전체 ${kb(full)} · 지문 ${db.articles.length}편`);
LEVELS.forEach(lv => console.log(`  articles-${lv}.json  ${kb(sizes[lv]).padStart(7)}  (전체의 ${Math.round(sizes[lv] / full * 100)}%)`));
console.log(`  hanja.json         ${kb(hjSize).padStart(7)}  (한자 ${families.length}자)`);
