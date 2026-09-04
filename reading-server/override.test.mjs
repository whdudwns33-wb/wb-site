#!/usr/bin/env node
/* 정적 파일 가로채기 정합 — node reading-server/override.test.mjs
 *
 * 워커는 /articles*.json·/hanja.json 등을 가로채 강사의 발행 상태(pubmap)를 입히고,
 * /textbook.json 은 404로 막는다. 그런데 Cloudflare 는 기본적으로 정적 자산을
 * 워커보다 먼저 내보내므로, wrangler.toml 의 run_worker_first 에 그 경로가 없으면
 * 워커 코드가 아예 실행되지 않는다. 오류도 안 나고 원본이 그냥 나간다.
 * textbook.json 의 경우 그 침묵이 곧 교재 20강 전체 유출이다.
 *
 * 로컬 서버(server.mjs)에도 같은 규칙이 있어야 한다. 한쪽에만 고치면
 * 로컬에서 잘 되는 것을 확인하고 배포했는데 운영에서만 다르게 도는 일이 생긴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const worker = fs.readFileSync(path.join(DIR, 'worker.mjs'), 'utf8');
const server = fs.readFileSync(path.join(DIR, 'server.mjs'), 'utf8');
const toml = fs.readFileSync(path.join(DIR, 'wrangler.toml'), 'utf8');
const errors = [];
const E = (m) => errors.push(m);

/* run_worker_first 목록 */
const m = toml.match(/run_worker_first\s*=\s*\[([^\]]*)\]/);
if (!m) E('wrangler.toml 에 run_worker_first 가 없습니다');
const first = new Set(m ? [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]) : []);

/* 워커가 /api/ 앞에서 가로채는 정적 경로를 코드에서 뽑는다 */
const head = worker.split("if (!p.startsWith('/api/'))")[0];
const paths = new Set();
for (const x of head.matchAll(/p === '(\/[^']+)'/g)) paths.add(x[1]);
/* 정규식으로 가로채는 것 — articles(-L1..L4).json */
if (/\/\^\\\/articles\(-L\[1-4\]\)\?\\\.json\$\//.test(head) || head.includes('^\\/articles(-L[1-4])?\\.json$')) {
  ['/articles.json', '/articles-L1.json', '/articles-L2.json', '/articles-L3.json', '/articles-L4.json']
    .forEach(p => paths.add(p));
}
if (!paths.size) E('워커에서 가로채는 정적 경로를 하나도 찾지 못했습니다 — 이 검사가 무의미해졌습니다');

for (const p of [...paths].sort()) {
  if (!first.has(p)) E(`${p} 을 워커가 가로채는데 wrangler.toml run_worker_first 에 없습니다 — 배포하면 워커를 건너뛰고 원본이 그대로 나갑니다`);
}
/* 반대 방향: 목록에만 있고 워커가 안 보는 경로는 헛설정 */
for (const p of first) {
  if (!paths.has(p)) E(`run_worker_first 의 ${p} 를 워커가 가로채지 않습니다 — 목록에서 빼거나 처리를 추가하세요`);
}

/* 발행 오버라이드는 워커와 로컬 서버 양쪽에 있어야 한다 */
[['/hanja.json', 'hanja.json'], ['/articles.json', 'articles.json']].forEach(([p, f]) => {
  if (!server.includes(f)) E(`server.mjs 에 ${p} 처리가 없습니다 (워커에만 있으면 로컬 확인이 운영과 달라집니다)`);
});
if (!/pubmap/.test(server.split("'/hanja.json'")[1] || '')) {
  if (!/hanja\.json'[\s\S]{0,600}pubmap|pubmap[\s\S]{0,600}hanja\.json/.test(server))
    E('server.mjs 의 /hanja.json 처리에 pubmap 반영이 없습니다');
}
if (!/textbook\.json/.test(server)) E('server.mjs 에 /textbook.json 차단이 없습니다');

/* ── 관리 웹이 배포본에 실려 나가는가 ──
   로컬 서버는 public/ 을 통째로 서빙하지만 배포본은 build-dist.mjs 가 한 장씩 복사한다.
   새 화면을 만들고 복사 줄을 빠뜨리면 로컬에서만 열리고 운영에서는 404가 난다. */
const build = fs.readFileSync(path.join(DIR, 'build-dist.mjs'), 'utf8');
const pages = fs.readdirSync(path.join(DIR, 'public')).filter((f) => f.endsWith('.html'));
for (const f of pages) {
  if (!build.includes("'" + f + "'")) E(`public/${f} 가 build-dist.mjs 에 없습니다 — 배포본에서 404가 납니다`);
}

/* ── 관리 화면이 부르는 스크립트가 배포본에 있는가 ──
   화면은 public/ 전체가 서빙되는 로컬에서 만들지만 배포본은 파일을 한 장씩 복사한다.
   <script src> 하나를 새로 걸고 복사 목록에 안 넣으면 운영에서만 404가 나고, 화면은
   조용히 반만 도는 상태가 된다(루브릭 저작 카드가 grade.js 를 새로 부르며 실제로 겪을 뻔했다). */
const distCopied = new Set([...build.matchAll(/'([^']+\.(?:js|json|html|webmanifest|svg))'/g)].map((m) => m[1]));
for (const f of pages) {
  const html = fs.readFileSync(path.join(DIR, 'public', f), 'utf8');
  for (const m of html.matchAll(/<script\s+src="\/([^"]+)"/g)) {
    const file = m[1].split('/').pop();
    if (!distCopied.has(file))
      E(`public/${f} 가 /${m[1]} 를 부르는데 build-dist.mjs 복사 목록에 ${file} 이 없습니다 — 운영에서 404가 납니다`);
  }
}

/* ── 라우트가 쓰는 저장 어댑터가 워커·로컬 양쪽에 다 있는가 ──
   naesin-ko-api.mjs 는 워커(KV)와 로컬 서버(파일)가 함께 쓴다. 한쪽 어댑터에만 메서드를
   더하면 로컬에서 다 확인하고 배포한 뒤 운영에서만 500이 난다 — 이 파일이 막으려는 바로 그 일이다. */
for (const api of ['naesin-ko-api.mjs', 'naesin-api.mjs', 'vocab-api.mjs']) {
  const src = fs.readFileSync(path.join(DIR, api), 'utf8');
  const used = new Set([...src.matchAll(/store\.([a-zA-Z]\w*)\s*\(/g)].map((m) => m[1]));
  for (const fn of [...used].sort()) {
    if (!worker.includes(fn + ':')) E(`${api} 가 store.${fn} 를 쓰는데 worker.mjs 어댑터에 없습니다 — 배포 후 운영에서만 실패합니다`);
    if (!server.includes(fn + ':')) E(`${api} 가 store.${fn} 를 쓰는데 server.mjs 어댑터에 없습니다 — 로컬 확인이 운영과 달라집니다`);
  }
}

/* ── 파일럿 지표 화면의 기준값이 코드와 같은가 ──
   화면에 적힌 70%·60%는 사람이 손으로 쓴 글이고, 판정은 vocab-api.mjs 의 PILOT 이 한다.
   한쪽만 고치면 화면이 "기준 70%"라고 써 놓고 75%로 판정하는 상태가 된다. */
const api = fs.readFileSync(path.join(DIR, 'vocab-api.mjs'), 'utf8');
const pilot = api.match(/export const PILOT = \{([^}]*)\}/);
if (!pilot) E('vocab-api.mjs 에서 PILOT 기준을 찾지 못했습니다');
else {
  const metrics = fs.readFileSync(path.join(DIR, 'public', 'metrics.html'), 'utf8');
  const num = (k) => (pilot[1].match(new RegExp(k + ':\\s*(\\d+)')) || [])[1];
  const [water, recall, weeks] = ['water', 'recall', 'weeks'].map(num);
  if (!metrics.includes('물 주기 완수율 ' + water + '%'))
    E(`metrics.html 의 물 주기 기준이 PILOT.water(${water}%)와 다릅니다`);
  if (!metrics.includes('30일 회상 통과율 ' + recall + '%'))
    E(`metrics.html 의 회상 기준이 PILOT.recall(${recall}%)과 다릅니다`);
  if (!metrics.includes(weeks + '주'))
    E(`metrics.html 에 파일럿 기간 ${weeks}주가 적혀 있지 않습니다`);
  /* 학생별 표의 색칠 기준도 같은 숫자여야 한다 */
  if (!metrics.includes('r.waterRate >= ' + water) || !metrics.includes('r.recallRate >= ' + recall))
    E('metrics.html 학생별 표의 합격선이 PILOT 과 다릅니다');
}

if (errors.length) {
  errors.forEach(e => console.error('ERROR:', e));
  console.error(`\nFAIL — ${errors.length}건`);
  process.exit(1);
}
console.log(`OK — 워커 가로채기 ${paths.size}개 · 관리 화면 ${pages.length}장 배포 배선(스크립트 포함) · 저장 어댑터 짝 맞음 · 파일럿 기준값 일치`);
