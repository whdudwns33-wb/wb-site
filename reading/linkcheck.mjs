'use strict';
/* 지문 딥링크 생존 점검 — 운영 루틴용 (앱 코드 아님)
   사용: node reading/linkcheck.mjs
   대상: sources / videos / papers / books(url) / books.video
   유튜브는 oembed로 실제 시청 가능 여부까지 확인.
   종료 코드: 죽은 링크(bad)가 있으면 1, 없으면 0. curl 사용(프록시 환경 호환). */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = JSON.parse(fs.readFileSync(path.join(HERE, 'articles.json'), 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const items = [];
for (const a of DB.articles) {
  (a.sources || []).forEach(s => items.push({ kind: '출처', id: a.id, title: s.title, url: s.url }));
  (a.videos || []).forEach(v => items.push({ kind: '영상', id: a.id, title: v.title, url: v.url, yt: true }));
  (a.papers || []).forEach(p => items.push({ kind: '논문', id: a.id, title: p.title, url: p.url }));
  (a.books || []).forEach(b => {
    if (b.url) items.push({ kind: '책', id: a.id, title: b.title, url: b.url });
    if (b.video) items.push({ kind: '책영상', id: a.id, title: b.title, url: b.video.url, yt: true });
  });
}

function curlCode(url) {
  return new Promise(resolve => {
    execFile('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-L', '-m', '12', '-A', UA, url],
      { timeout: 15000 }, (err, stdout) => resolve((stdout || '000').trim()));
  });
}

async function check(it) {
  const target = it.yt
    ? 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(it.url)
    : it.url;
  const code = await curlCode(target);
  const n = parseInt(code, 10) || 0;
  let verdict;
  if (n >= 200 && n < 400) verdict = 'ok';
  else if ([400, 404, 410].includes(n)) verdict = 'bad'; // 확실한 죽은 링크
  else verdict = 'warn'; // 418(네이버 봇 차단)·403·000(해외 IP 차단 가능)·5xx 등 — 브라우저 수동 확인
  return { ...it, code, verdict };
}

const POOL = 8;
const results = [];
let i = 0;
async function worker() {
  while (i < items.length) {
    const it = items[i++];
    results.push(await check(it));
    process.stderr.write(`\r점검 중 ${results.length}/${items.length}`);
  }
}
await Promise.all(Array.from({ length: POOL }, worker));
process.stderr.write('\n');

const bad = results.filter(r => r.verdict === 'bad');
const warn = results.filter(r => r.verdict === 'warn');
console.log(`\n총 ${results.length}개 링크 — 정상 ${results.length - bad.length - warn.length} · 확인 필요 ${warn.length} · 깨짐 ${bad.length}\n`);
for (const r of [...bad, ...warn]) {
  console.log(`[${r.verdict === 'bad' ? '✕ 깨짐' : '⚠ 확인'}] (${r.code}) ${r.kind} · ${r.id} · ${r.title}\n        ${r.url}`);
}
if (!bad.length && !warn.length) console.log('모든 링크가 정상입니다.');
process.exitCode = bad.length ? 1 : 0;
