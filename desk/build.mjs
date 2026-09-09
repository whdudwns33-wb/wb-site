/* WB 프로그램데스크 — dist 조립 (계약 §0·§7)
 *
 *   node desk/build.mjs
 *
 * 하는 일: desk/app/* → desk/dist/ · desk/lib/*.js(테스트 제외)·runbook-pack.json·../shared/external-links.js → desk/dist/lib/
 *         index.html의 로컬 `?v=dev` 자산 참조를 파일 내용 sha256 앞 10자리로 치환한다.
 * 왜 내용 해시인가: 워커 자산은 캐시가 오래 남는다. 파일이 바뀌면 주소가 바뀌어야 옛 app.js가 새 패널과 섞이지 않는다.
 * 런북 팩은 dist/lib/ 말고 dist/ 루트에도 둔다 — runbook-ui.js가 문서 기준 상대 경로('./runbook-pack.json')로 읽기 때문.
 */
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, 'app');
const LIB = path.join(here, 'lib');
const SHARED = path.join(here, '..', 'shared');
const DIST = path.join(here, 'dist');

async function copyFile(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

async function listFiles(dir) {
  const rows = await fs.readdir(dir, { withFileTypes: true });
  return rows.filter(r => r.isFile()).map(r => r.name);
}

function hashOf(buf) { return createHash('sha256').update(buf).digest('hex').slice(0, 10); }

async function main() {
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(path.join(DIST, 'lib'), { recursive: true });

  const copied = [];
  for (const name of await listFiles(APP)) {
    if (/\.test\.(cjs|mjs|js)$/.test(name)) continue;   // 테스트는 배포하지 않는다
    await copyFile(path.join(APP, name), path.join(DIST, name));
    copied.push(name);
  }
  for (const name of await listFiles(LIB)) {
    const isLib = /\.js$/.test(name) && !/\.test\./.test(name);
    if (!isLib && name !== 'runbook-pack.json') continue;
    await copyFile(path.join(LIB, name), path.join(DIST, 'lib', name));
    copied.push('lib/' + name);
  }
  await copyFile(path.join(LIB, 'runbook-pack.json'), path.join(DIST, 'runbook-pack.json'));
  copied.push('runbook-pack.json');
  await copyFile(path.join(SHARED, 'external-links.js'), path.join(DIST, 'lib', 'external-links.js'));
  copied.push('lib/external-links.js');

  /* index.html 스탬프 — src/href="./…?v=dev" 만 건드린다(외부 서체 링크 등은 그대로). */
  const indexPath = path.join(DIST, 'index.html');
  let html = await fs.readFile(indexPath, 'utf8');
  const stamped = [];
  const missing = [];
  html = html.replace(/(src|href)="(\.\/[^"?]+)\?v=dev"/g, (m, attr, rel) => {
    const file = path.join(DIST, rel.replace(/^\.\//, ''));
    let buf;
    /* replace 콜백은 async가 될 수 없어 여기만 동기 읽기다 */
    try { buf = readFileSync(file); } catch (e) { missing.push(rel); return m; }
    const v = hashOf(buf);
    stamped.push(rel + ' → ' + v);
    return attr + '="' + rel + '?v=' + v + '"';
  });
  if (missing.length) throw new Error('index.html이 참조하는 파일이 dist에 없습니다: ' + missing.join(', '));
  await fs.writeFile(indexPath, html);

  /* 자체 확인 — 스탬프가 실제로 붙었는지 다시 읽어 본다 */
  const check = await fs.readFile(indexPath, 'utf8');
  if (/\?v=dev"/.test(check)) throw new Error('?v=dev 참조가 남아 있습니다');
  const n = (check.match(/\?v=[0-9a-f]{10}"/g) || []).length;
  if (n < 10) throw new Error('스탬프된 자산이 너무 적습니다: ' + n);

  console.log('dist 조립 완료 — ' + copied.length + '개 파일, 스탬프 ' + n + '개');
  stamped.forEach(s => console.log('  ' + s));
}

main().catch(err => { console.error('build 실패:', err && err.message || err); process.exit(1); });
