'use strict';
/* dist/ 조립: 학생 앱(reading/) + 관리 웹(public/admin.html → /admin/) */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
const VOCAB_FILES = ['index.html', 'words.js', 'bridge.js', 'quiz.js', 'srs.js', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
for (const f of VOCAB_FILES) fs.copyFileSync(path.join(VOCAB, f), path.join(DIST, 'vocab', f));
/* 공통 음성 모듈 — 원본은 shared/ 하나, 두 앱에 같은 파일을 배급한다 */
const SHARED = path.join(ROOT, '..', 'shared', 'voice.js');
fs.copyFileSync(SHARED, path.join(DIST, 'voice.js'));
fs.copyFileSync(SHARED, path.join(DIST, 'vocab', 'voice.js'));
/* QR 인코더 — 관리 웹이 학생 연동 QR을 그린다. CSP가 'self'만 허용해 CDN을 못 쓴다. */
fs.copyFileSync(path.join(ROOT, '..', 'shared', 'qr.js'), path.join(DIST, 'admin', 'qr.js'));

/* ── 서비스 워커 캐시 이름을 내용에서 뽑는다 ──
   두 앱 모두 껍데기(index.html·words.js…)를 캐시 우선으로 물고 있다. 그래서
   sw.js 안의 VERSION 문자열이 그대로면, 이미 앱을 깔아 둔 학생은 새 코드를
   영영 못 받는다. 2026-09-02 에 실제로 그랬다 — 낱말을 135개에서 207개로
   늘려 배포했는데 기존 학생 화면은 그대로였다.

   손으로 올리는 것을 잊지 않기를 바라는 대신, 껍데기 파일 내용의 해시를 그대로
   VERSION 으로 박는다. 파일이 한 글자라도 바뀌면 캐시 이름이 달라지고,
   안 바뀌면 그대로다. 잊을 수가 없다. */
function stampSW(swPath, shellPaths, prefix) {
  const src = fs.readFileSync(swPath, 'utf8');
  const h = crypto.createHash('sha256');
  for (const f of shellPaths.slice().sort()) h.update(fs.readFileSync(f));
  h.update(src);                                   /* sw.js 자신도 포함 */
  const tag = prefix + '-' + h.digest('hex').slice(0, 10);
  const out = src.replace(/const VERSION = '[^']*';/, `const VERSION = '${tag}';`);
  if (out === src) throw new Error(`${swPath}: VERSION 을 못 바꿨습니다 — sw.js 의 선언 형태가 바뀌었나 봅니다`);
  fs.writeFileSync(swPath, out);
  return tag;
}
const rTag = stampSW(path.join(DIST, 'sw.js'),
  ['index.html', 'voice.js', 'manifest.webmanifest', 'icon.svg'].map(f => path.join(DIST, f)), 'wbr-shell');
const vTag = stampSW(path.join(DIST, 'vocab', 'sw.js'),
  ['index.html', 'voice.js', 'words.js', 'bridge.js', 'quiz.js', 'srs.js', 'manifest.webmanifest', 'icon.svg']
    .map(f => path.join(DIST, 'vocab', f)), 'wbv-shell');

console.log('dist/ 조립 완료:', fs.readdirSync(DIST).join(', '));
console.log('서비스 워커 캐시 이름:', rTag, '·', vTag);
