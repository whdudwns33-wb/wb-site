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

const APP_FILES = ['index.html', 'articles.json', 'hanja-grades.json', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'review.html', 'parent.html'];
for (const f of APP_FILES) fs.copyFileSync(path.join(APP, f), path.join(DIST, f));
fs.copyFileSync(path.join(ROOT, 'public', 'admin.html'), path.join(DIST, 'admin', 'index.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'vocab-review.html'), path.join(DIST, 'admin', 'vocab-review.html'));

/* 워드브레인 (vocab/) — 같은 오리진 /vocab/ 에서 서빙해야 진로독서와 localStorage·토큰이 공유된다 */
const VOCAB = path.join(ROOT, '..', 'vocab');
fs.mkdirSync(path.join(DIST, 'vocab'), { recursive: true });
const VOCAB_FILES = ['index.html', 'words.js', 'hanja-grades.js', 'bridge.js', 'quiz.js', 'srs.js', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
for (const f of VOCAB_FILES) fs.copyFileSync(path.join(VOCAB, f), path.join(DIST, 'vocab', f));
console.log('dist/ 조립 완료:', fs.readdirSync(DIST).join(', '));
