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
/* 접두어로 가로채는 것(p.startsWith('/letter/fonts/')) — run_worker_first 에는 글꼴(/letter/fonts/*)로 적는다 */
for (const x of head.matchAll(/p\.startsWith\('(\/[^']+)'\)/g)) paths.add(x[1] + '*');
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

/* ── 워커 번들에 Node 전용 모듈이 섞이지 않는가 ──
   2026-09-03, 팩 제작 스튜디오를 올렸는데 배포가 두 번 실패했다. 원인은 한 줄이었다:
     import { createRequire } from 'node:module';
   Cloudflare Workers 에는 node:module 이 없다(nodejs_compat 도 안 켜져 있고, 켜도
   런타임 require 는 번들러가 못 푼다). 저장소 테스트는 전부 통과했다 — Node 에서는
   그 줄이 잘 돌기 때문이다. 그래서 '테스트 초록 + 배포 실패 + 학생 화면은 옛 코드'라는
   가장 나쁜 조합이 됐다. 여기서 worker.mjs 의 import 그래프를 훑어 그 조합을 막는다.
   (server.mjs 는 Node 전용이라 이 검사 밖이다 — 워커에서 임포트되지 않는다.) */
const WORKER_ENTRY = 'worker.mjs';
function importGraph(entry) {
  const seen = new Set(), out = [];
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const fp = path.join(DIR, rel);
    if (!fs.existsSync(fp)) return;
    const txt = fs.readFileSync(fp, 'utf8');
    /* 주석은 떼고 본다 — "createRequire 를 쓰지 마라"고 적은 주석이 스스로 걸린다 */
    out.push({ rel, txt, code: txt.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1') });
    /* 정적 import/export-from 만 따라간다 — 워커 번들에 실제로 들어가는 것이 그것뿐이다 */
    for (const m of txt.matchAll(/(?:^|\n)\s*(?:import|export)[^;'"\n]*from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      walk(path.normalize(path.join(path.dirname(rel), spec)));
    }
    for (const m of txt.matchAll(/(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g)) {
      walk(path.normalize(path.join(path.dirname(rel), m[1])));
    }
  };
  walk(entry);
  return out;
}
const graph = importGraph(WORKER_ENTRY);
if (graph.length < 5) E(`워커 import 그래프를 ${graph.length}개만 찾았습니다 — 이 검사가 헛돌고 있습니다`);
for (const { rel, code } of graph) {
  const nodeImp = [...code.matchAll(/from\s*['"](node:[a-z_/]+)['"]/g)].map((m) => m[1]);
  if (nodeImp.length)
    E(`${rel} 이 ${nodeImp.join(', ')} 를 임포트합니다 — 워커 번들에 들어가면 배포가 실패합니다 (Cloudflare 에 Node 내장 모듈이 없습니다)`);
  if (/createRequire/.test(code))
    E(`${rel} 이 createRequire 를 씁니다 — 워커에서 못 씁니다. 정적 import 로 바꾸세요 (브라우저 공용 모듈도 기본 import 로 module.exports 를 받습니다)`);
  if (/\brequire\s*\(/.test(code) && !/typeof module/.test(code))
    E(`${rel} 이 런타임 require 를 씁니다 — 번들러가 풀지 못합니다`);
}
/* 비용 장부 어댑터가 양쪽 호스트에 다 있는가 — 한쪽만 있으면 그 호스트에서는 한도가 없는 셈이다 */
for (const [name, rel] of [['worker.mjs', 'worker.mjs'], ['server.mjs', 'server.mjs']]) {
  const txt = fs.readFileSync(path.join(DIR, rel), 'utf8');
  for (const fn of ['getAiUse', 'putAiUse'])
    if (!txt.includes(fn + ':')) E(`${name} 의 내신 저장소 어댑터에 ${fn} 이 없습니다 — 그 호스트에서는 AI 비용 한도가 걸리지 않습니다`);
}

/* 공용 검사 모듈이 실제로 그래프에 들어와 있는가 — 배포 관문이 CLI 검증기와 같은 규칙을 쓰는 근거다 */
if (!graph.some((g) => g.rel.endsWith('pack-check.js')))
  E('worker.mjs 그래프에 naesin/pack-check.js 가 없습니다 — 배포 관문이 검사 규칙을 잃었습니다');
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
   더하면 로컬에서 다 확인하고 배포한 뒤 운영에서만 500이 난다 — 이 파일이 막으려는 바로 그 일이다.

   **그 어댑터 블록 안에서만 찾는다.** 전에는 파일 전체에서 `이름:` 를 찾았는데, 앱마다 같은 이름을
   쓰는 메서드가 많아(`getPack`·`putPack`·`getPackIds`·`putPackIds` 는 영어 내신·국어·하루에 다 있다)
   국어 어댑터에서 한 줄을 지워도 영어 쪽 이름이 걸려 **초록이었다**. 2026-10-13 에 실측으로 확인했다 —
   국어 어댑터의 `getPack:` 을 지우고 돌려도 통과했다. 라이선스 자료를 원장 PC 로 빼는 금고 작업이
   건드리는 것이 바로 그 네 칸이라, 이 관문이 정작 그 작업에서 아무것도 지켜 주지 못하는 상태였다. */
const adapterBody = (src, name, kind) => {
  /* 워커는 `function xStore(env) {`, 로컬은 `const xStore = {` — 여는 중괄호부터 균형이 맞는 곳까지 */
  const at = kind === 'fn' ? src.indexOf(`function ${name}(`) : src.indexOf(`const ${name} =`);
  if (at < 0) return null;
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (!depth) return src.slice(at, i + 1); }
  }
  return null;
};
const ADAPTERS = {
  'naesin-ko-api.mjs': 'naesinKoStore', 'naesin-api.mjs': 'naesinStore',
  'vocab-api.mjs': 'vocabStore', 'chunk-api.mjs': 'chunkStore',
};
for (const [api, adapter] of Object.entries(ADAPTERS)) {
  const src = fs.readFileSync(path.join(DIR, api), 'utf8');
  const used = new Set([...src.matchAll(/store\.([a-zA-Z]\w*)\s*\(/g)].map((m) => m[1]));
  /* 옵셔널 호출(store.x?.()) 과 구조분해(const {x} = store) 는 위 정규식이 못 본다 — 그 모양으로
     쓰면 이 관문을 통째로 피하므로, 라우터가 그렇게 쓰지 않는지도 같이 본다 */
  if (new RegExp('store\\.[a-zA-Z]\\w*\\?\\.\\(').test(src))
    E(`${api} 가 store.x?.() 꼴 옵셔널 호출을 씁니다 — 어댑터 짝 검사가 그 호출을 못 봅니다`);
  if (/(?:const|let|var)\s*\{[^}]*\}\s*=\s*(?:ctx\.)?store\b/.test(src))
    E(`${api} 가 store 를 구조분해해 씁니다 — 어댑터 짝 검사가 그 호출을 못 봅니다`);
  const bodies = { 'worker.mjs': adapterBody(worker, adapter, 'fn'), 'server.mjs': adapterBody(server, adapter, 'obj') };
  for (const [host, body] of Object.entries(bodies)) {
    if (!body) { E(`${host} 에서 ${adapter} 어댑터 블록을 찾지 못했습니다 — 이 검사가 헛돌고 있습니다`); continue; }
    /* 어댑터가 `...withPortalFamilies(...)` 처럼 **스프레드로 메서드를 받는** 자리가 있다(청크가 그렇다).
       그 헬퍼가 내보내는 이름까지 더해야 한다 — 안 그러면 멀쩡한 어댑터를 없다고 잡는다. */
    let have = body;
    for (const m of body.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      const helper = m[1];
      const where = ['portal-family.mjs', 'worker.mjs', 'server.mjs']
        .map((f) => fs.readFileSync(path.join(DIR, f), 'utf8'))
        .find((src) => new RegExp('(?:export )?(?:function|const) ' + helper + '\\b').test(src));
      if (!where) { E(`${host} 의 ${adapter} 가 ...${helper}() 를 펼치는데 그 정의를 찾지 못했습니다 — 이 검사가 헛돌고 있습니다`); continue; }
      have += adapterBody(where, helper, /function /.test(where.slice(where.indexOf(helper) - 10, where.indexOf(helper))) ? 'fn' : 'obj') || where;
    }
    for (const fn of [...used].sort()) {
      if (!new RegExp('\\b' + fn + '\\s*:').test(have))
        E(`${api} 가 store.${fn} 를 쓰는데 ${host} 의 ${adapter} 에 없습니다 — ${host === 'worker.mjs' ? '배포 후 운영에서만 실패합니다' : '로컬 확인이 운영과 달라집니다'}`);
    }
  }
}

/* ── 몸통 상한이 워커·로컬 양쪽에 같이 걸려 있는가 ──
   라우터 모듈이 상한 함수를 내보내면 그 상한은 **계약**이다. 한쪽 호스트만 걸면 로컬에서
   413 이던 팩이 운영에서는 통과하거나(반대도) — 로컬 확인이 운영을 대변하지 못한다.
   실제로 국어브레인이 워커에만 걸려 있었고, 로컬은 기본 2MB 라 3MB 팩이 로컬에서만 막혔다. */
const limits = fs.readdirSync(DIR).filter((f) => f.endsWith('-api.mjs'))
  .flatMap((f) => [...fs.readFileSync(path.join(DIR, f), 'utf8')
    .matchAll(/export const (\w*BodyLimit)\s*=/g)].map((m) => [f, m[1]]));
if (!limits.length) E('몸통 상한 함수를 하나도 찾지 못했습니다 — 이 검사가 헛돌고 있습니다');
for (const [file, fn] of limits) {
  const gate = new RegExp('>\\s*' + fn + '\\(p\\)');
  if (!gate.test(worker)) E(`${file} 의 ${fn} 이 worker.mjs 에서 쓰이지 않습니다 — 운영 상한이 없는 셈입니다`);
  if (!gate.test(server)) E(`${file} 의 ${fn} 이 server.mjs 에서 쓰이지 않습니다 — 로컬 확인이 운영과 달라집니다`);
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
console.log(`OK — 워커 가로채기 ${paths.size}개 · 관리 화면 ${pages.length}장 배포 배선(스크립트 포함) · 저장 어댑터 짝 맞음 · 몸통 상한 ${limits.length}개 양쪽 · 파일럿 기준값 일치`);
