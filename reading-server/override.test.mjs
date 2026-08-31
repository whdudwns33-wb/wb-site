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

if (errors.length) {
  errors.forEach(e => console.error('ERROR:', e));
  console.error(`\nFAIL — ${errors.length}건`);
  process.exit(1);
}
console.log(`OK — 워커가 가로채는 정적 경로 ${paths.size}개 전부 run_worker_first 에 있고, 로컬 서버에도 같은 규칙이 있습니다`);
