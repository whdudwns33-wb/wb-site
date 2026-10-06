/* WB 세일즈데스크 — dist 조립
 *
 *   node crm/build.mjs
 *
 * 하는 일: crm/app/* → crm/dist/ · crm/crm-core.js → crm/dist/crm-core.js · crm/partner/* → crm/dist/partner/(파트너 포털).
 * index.html(둘 다)의 `?v=dev` 자산 참조를
 * 파일 내용 sha256 앞 10자리로 치환한다(desk/build.mjs 와 같은 규칙 — 워커 자산 캐시가 오래 남아 주소가 바뀌어야 새 코드가 간다).
 * 테스트 파일은 배포하지 않는다. 학생·보호자 정보는 어디에도 없다(전부 D1).
 */
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, 'app');
const DIST = path.join(here, 'dist');

function hashOf(buf) { return createHash('sha256').update(buf).digest('hex').slice(0, 10); }

async function main() {
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });
  const copied = [];
  for (const ent of await fs.readdir(APP, { withFileTypes: true })) {
    if (!ent.isFile() || /\.test\.(cjs|mjs|js)$/.test(ent.name)) continue;
    await fs.copyFile(path.join(APP, ent.name), path.join(DIST, ent.name));
    copied.push(ent.name);
  }
  await fs.copyFile(path.join(here, 'crm-core.js'), path.join(DIST, 'crm-core.js'));
  copied.push('crm-core.js');
  const PARTNER = path.join(here, 'partner');
  await fs.mkdir(path.join(DIST, 'partner'), { recursive: true });
  for (const ent of await fs.readdir(PARTNER, { withFileTypes: true })) {
    if (!ent.isFile() || /\.test\.(cjs|mjs|js)$/.test(ent.name)) continue;
    await fs.copyFile(path.join(PARTNER, ent.name), path.join(DIST, 'partner', ent.name));
    copied.push('partner/' + ent.name);
  }

  const stamped = [];
  /* HTML 스탬프 — src/href="./…?v=dev" 와 "../…?v=dev"(포털이 상위의 crm.css 를 쓴다)만 건드린다(외부 서체 링크 등은 그대로). */
  async function stampHtml(rel, minCount) {
    const htmlPath = path.join(DIST, rel);
    let html = await fs.readFile(htmlPath, 'utf8');
    const missing = [];
    html = html.replace(/(src|href)="(\.\.?\/[^"?]+)\?v=dev"/g, (m, attr, ref) => {
      let buf;
      try { buf = readFileSync(path.resolve(path.dirname(htmlPath), ref)); } catch (e) { missing.push(ref); return m; }
      const v = hashOf(buf);
      stamped.push(rel + ': ' + ref + ' → ' + v);
      return attr + '="' + ref + '?v=' + v + '"';
    });
    if (missing.length) throw new Error(rel + ' 이 참조하는 파일이 dist 에 없습니다: ' + missing.join(', '));
    await fs.writeFile(htmlPath, html);
    const check = await fs.readFile(htmlPath, 'utf8');
    if (/\?v=dev"/.test(check)) throw new Error(rel + ' 에 ?v=dev 참조가 남아 있습니다');
    if ((check.match(/\?v=[0-9a-f]{10}"/g) || []).length < minCount) throw new Error(rel + ' 의 스탬프된 자산이 너무 적습니다');
  }
  await stampHtml('index.html', 3);
  await stampHtml('partner/index.html', 2);
  console.log('dist 조립 완료 — ' + copied.length + '개 파일, 스탬프 ' + stamped.length + '개');
  stamped.forEach(s => console.log('  ' + s));
}

main().catch(err => { console.error('build 실패:', err && err.message || err); process.exit(1); });
