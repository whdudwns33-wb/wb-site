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

console.log('dist/ 조립 완료:', fs.readdirSync(DIST).join(', '));
