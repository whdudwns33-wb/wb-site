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

const APP_FILES = ['index.html', 'articles.json', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'review.html', 'parent.html'];
for (const f of APP_FILES) fs.copyFileSync(path.join(APP, f), path.join(DIST, f));
fs.copyFileSync(path.join(ROOT, 'public', 'admin.html'), path.join(DIST, 'admin', 'index.html'));
console.log('dist/ 조립 완료:', fs.readdirSync(DIST).join(', '));
