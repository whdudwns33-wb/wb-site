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

function curlCode(url, secs) {
  return new Promise(resolve => {
    execFile('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-L', '-m', String(secs), '-A', UA, url],
      { timeout: (secs + 3) * 1000 }, (err, stdout) => resolve((stdout || '000').trim()));
  });
}

const target = (it) => it.yt
  ? 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(it.url)
  : it.url;

function verdictOf(code) {
  const n = parseInt(code, 10) || 0;
  if (n >= 200 && n < 400) return 'ok';
  if ([400, 404, 410].includes(n)) return 'bad';     // 확실한 죽은 링크
  if ([403, 418, 429].includes(n)) return 'blocked'; // 봇 차단 — 사람이 열면 정상
  return 'warn';                                     // 000(응답 없음)·5xx — 사람이 확인
}

/* 1차: 빠르게 훑는다 */
const POOL = 8;
const results = [];
let i = 0;
async function worker() {
  while (i < items.length) {
    const it = items[i++];
    const code = await curlCode(target(it), 12);
    results.push({ ...it, code, verdict: verdictOf(code) });
    process.stderr.write(`\r점검 중 ${results.length}/${items.length}`);
  }
}
await Promise.all(Array.from({ length: POOL }, worker));
process.stderr.write('\n');

/* 2차: 실패한 것만 한 개씩 넉넉한 시간으로 다시.
 * 동시에 8개를 던지면 멀쩡한 정부 사이트도 타임아웃으로 000이 뜬다.
 * 그 노이즈를 매주 30건씩 보고하면 ⚠를 통째로 무시하게 되고,
 * 그때 진짜 죽은 링크가 섞여 들어간다. 그래서 재시도를 통과한 것만 보고한다. */
const retry = results.filter(r => r.verdict !== 'ok' && r.verdict !== 'bad');
if (retry.length) {
  process.stderr.write(`재확인 ${retry.length}건 (순차)\n`);
  for (const r of retry) {
    for (let k = 0; k < 2 && r.verdict !== 'ok'; k++) {
      const code = await curlCode(target(r), 25);
      const v = verdictOf(code);
      if (v === 'ok' || k === 1) { r.code = code; r.verdict = v; }
      if (v === 'ok') break;
    }
  }
}

const bad = results.filter(r => r.verdict === 'bad');
const warn = results.filter(r => r.verdict === 'warn');
const blocked = results.filter(r => r.verdict === 'blocked');
const ok = results.length - bad.length - warn.length - blocked.length;
console.log(`\n총 ${results.length}개 링크 — 정상 ${ok} · 봇 차단 ${blocked.length} · 확인 필요 ${warn.length} · 깨짐 ${bad.length}\n`);
const tag = { bad: '✕ 깨짐', warn: '⚠ 확인', blocked: '· 봇차단' };
for (const r of [...bad, ...warn, ...blocked]) {
  console.log(`[${tag[r.verdict]}] (${r.code}) ${r.kind} · ${r.id} · ${r.title}\n        ${r.url}`);
}
if (blocked.length && !bad.length && !warn.length)
  console.log('\n봇 차단은 사람이 브라우저로 열면 정상입니다 — 조치 불필요.');
if (!bad.length && !warn.length && !blocked.length) console.log('모든 링크가 정상입니다.');
process.exitCode = bad.length ? 1 : 0;
