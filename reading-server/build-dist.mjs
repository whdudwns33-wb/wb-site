'use strict';
/* dist/ 조립: 학생 앱(reading/) + 관리 웹(public/admin.html → /admin/) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(ROOT, '..', 'reading');
const DIST = path.join(ROOT, 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'admin'), { recursive: true });

const APP_FILES = ['index.html', 'articles.json', 'textbook.json', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'review.html', 'parent.html',
  /* 학년대별 분할본 — 학생 앱은 자기 학년대 하나만 받는다 (node reading/build-split.mjs 산출물) */
  'articles-L1.json', 'articles-L2.json', 'articles-L3.json', 'articles-L4.json', 'hanja.json', 'version.json',
  /* 보안 헤더(CSP·X-Frame-Options·Referrer-Policy 등)와 캐시 규칙.
     지금까지 dist에 넣지 않아 배포본에는 이 헤더가 하나도 붙지 않았다. */
  '_headers'];
for (const f of APP_FILES) fs.copyFileSync(path.join(APP, f), path.join(DIST, f));
fs.copyFileSync(path.join(ROOT, 'public', 'admin.html'), path.join(DIST, 'admin', 'index.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'vocab-review.html'), path.join(DIST, 'admin', 'vocab-review.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'metrics.html'), path.join(DIST, 'admin', 'metrics.html'));

/* 어휘 나이 진단 (vocab-age/) — 로그인 없이 열리는 공개 페이지.
   실리는 것은 index.html · age.js · words.json 셋뿐이다(낱말과 뜻만). */
const AGE = path.join(ROOT, '..', 'vocab-age');
fs.mkdirSync(path.join(DIST, 'vocab-age'), { recursive: true });
for (const f of ['index.html', 'age.js', 'words.json'])
  fs.copyFileSync(path.join(AGE, f), path.join(DIST, 'vocab-age', f));

/* 워드브레인 (vocab/) — 같은 오리진 /vocab/ 에서 서빙해야 진로독서와 localStorage·토큰이 공유된다 */
const VOCAB = path.join(ROOT, '..', 'vocab');
fs.mkdirSync(path.join(DIST, 'vocab'), { recursive: true });
const VOCAB_FILES = ['index.html', 'words.js', 'bridge.js', 'quiz.js', 'srs.js', 'trace.js', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
for (const f of VOCAB_FILES) fs.copyFileSync(path.join(VOCAB, f), path.join(DIST, 'vocab', f));
/* 공통 음성 모듈 — 원본은 shared/ 하나, 두 앱에 같은 파일을 배급한다 */
const SHARED = path.join(ROOT, '..', 'shared', 'voice.js');
fs.copyFileSync(SHARED, path.join(DIST, 'voice.js'));
fs.copyFileSync(SHARED, path.join(DIST, 'vocab', 'voice.js'));
/* QR 인코더 — 관리 웹이 학생 연동 QR을 그린다. CSP가 'self'만 허용해 CDN을 못 쓴다. */
fs.copyFileSync(path.join(ROOT, '..', 'shared', 'qr.js'), path.join(DIST, 'admin', 'qr.js'));

/* 조립한 것이 실제로 열리는지 확인한다.
   여기 목록에 새 파일을 안 적으면 배포본에서 404가 나고, 그 스크립트를 쓰는 화면이
   통째로 죽는다 — 그런데 빌드는 성공한다. 조용히 깨지는 쪽이라 빌드가 직접 막는다. */
function verifyRefs(htmlPath) {
  const dir = path.dirname(htmlPath);
  const html = fs.readFileSync(htmlPath, 'utf8');
  const refs = [];
  const add = (re) => { let m; while ((m = re.exec(html))) refs.push(m[1]); };
  add(/<script[^>]+src="([^"]+)"/g);
  add(/<link[^>]+href="([^"]+)"/g);
  const missing = refs
    .filter((r) => !/^(https?:)?\/\//.test(r) && !r.startsWith('#') && !r.startsWith('data:') && !r.startsWith('/'))
    .filter((r) => !fs.existsSync(path.join(dir, r.split('?')[0])));
  return missing.map((m) => path.relative(DIST, path.join(dir, m)));
}

const broken = [];
for (const f of ['index.html', 'vocab/index.html', 'vocab-age/index.html', 'admin/index.html',
  'admin/metrics.html', 'admin/vocab-review.html', 'review.html', 'parent.html']) {
  const full = path.join(DIST, f);
  if (fs.existsSync(full)) for (const m of verifyRefs(full)) broken.push(f + ' → ' + m);
}
if (broken.length) {
  console.error('dist/ 에 없는 파일을 화면이 부르고 있다:\n  ' + broken.join('\n  '));
  console.error('build-dist.mjs 의 복사 목록에 빠진 파일이 있는지 보라.');
  process.exit(1);
}

console.log('dist/ 조립 완료:', fs.readdirSync(DIST).join(', '));
