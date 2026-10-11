/* GitHub Pages 그림자 사본의 색인 차단 (node scripts/pages-noindex.test.mjs)
 *
 * 왜 있는가: 절대 규칙 3 은 `reading/_headers` 하나로 noindex 를 건다고 적는데, 그 파일은
 * **Cloudflare 전용**이다. 이 저장소는 public 이고 GitHub Pages 가 켜져 있어 저장소의 정적
 * 파일이 `whdudwns33-wb.github.io/wb-site/...` 로도 열린다. 거기서는 `_headers` 가 적용은
 * 커녕 **발행조차 되지 않는다** — Jekyll 이 `_` 접두 파일을 건너뛰어 `/reading/_headers` 가
 * 404 다. robots.txt 로도 못 막는다: robots.txt 는 **오리진 루트**(`github.io/robots.txt`)
 * 만 읽히고, 이 저장소에 두면 `/wb-site/robots.txt` 가 되어 크롤러가 보지 않는다.
 *
 * 그래서 Pages 사본에서 실제로 듣는 수단은 HTML 안의 `<meta name="robots">` 하나뿐이다.
 * 내부 화면이 그걸 빠뜨리면 **운영에서만, 색인된 뒤에야** 안다. 여기서 막는다.
 *
 * 공개 의도인 화면은 목록에서 빼 둔다 — 늘리기 전에 그게 정말 공개여도 되는지 생각하게.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

/* 공개가 의도된 것 — 이 셋만 noindex 가 없어도 된다.
   `/` 랜딩, 어휘 나이 진단(CLAUDE.md 가 "유일한 공개 페이지"로 적는다), 계산기. */
const PUBLIC_OK = new Set(['index.html', 'vocab-age/index.html', 'calc/index.html']);

/* 훑지 않는 곳: 빌드 산출물·의존성·데이터. dist 는 Cloudflare 전용이라 _headers 가 듣는다. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'data', '.wrangler', '.local', '.private', 'fonts', 'img']);

function htmlFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) htmlFiles(fp, out);
    else if (e.isFile() && e.name.endsWith('.html')) out.push(path.relative(ROOT, fp));
  }
  return out;
}

t('Pages 로 열리는 모든 HTML 에 noindex 가 있다 (공개 의도인 셋만 예외)', () => {
  const missing = htmlFiles(ROOT).filter((rel) => {
    if (PUBLIC_OK.has(rel.split(path.sep).join('/'))) return false;
    return !/name=["']robots["'][^>]*noindex/i.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  });
  assert.deepEqual(missing, [],
    'noindex 가 없다 — Pages 에서 색인된다. `<meta name="robots" content="noindex,nofollow">` 를 넣거나, '
    + '정말 공개해도 되는 화면이면 이 테스트의 PUBLIC_OK 에 넣고 왜 공개인지 적으세요');
});

t('_headers 와 robots.txt 에 Pages 보호를 기대하지 않는다', () => {
  /* _headers 는 Cloudflare 쪽에서 계속 일한다 — 지우지 않았는지만 본다 */
  const h = fs.readFileSync(path.join(ROOT, 'reading', '_headers'), 'utf8');
  assert.ok(/noindex/.test(h), 'reading/_headers 의 noindex 가 사라졌다 (Cloudflare 쪽 보호)');
  /* robots.txt 를 저장소에 두면 `/wb-site/robots.txt` 가 되어 크롤러가 읽지 않는다 —
     있으면 "막았다"는 착각을 만든다. 오리진 루트(github.io/robots.txt)는 다른 저장소 소관이다. */
  assert.ok(!fs.existsSync(path.join(ROOT, 'robots.txt')),
    'robots.txt 는 오리진 루트에서만 읽힌다 — 이 저장소에 두면 /wb-site/robots.txt 가 되어 무효이고 '
    + '막았다는 착각만 만든다. 오리진 루트는 whdudwns33-wb.github.io 저장소 소관이다');
});

console.log('통과 ' + passed);
