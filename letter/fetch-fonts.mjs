#!/usr/bin/env node
/* 브레인레터 글꼴 받기 — node letter/fetch-fonts.mjs
 *
 * Noto Sans KR·Noto Serif KR(SIL OFL 1.1)을 Google Fonts 에서 받아 letter/fonts/ 에 둔다.
 * 왜 통째로가 아니라 조각인가: 한글 글꼴 하나가 수 MB 라 Google 은 유니코드 구간별로 120여 조각으로
 * 나눠 두고 @font-face 의 unicode-range 로 브라우저가 지면에 실제로 쓰인 글자의 조각만 받게 한다.
 * 그 CSS 를 그대로 받아 주소만 우리 경로로 바꿔 fonts.css 로 쓴다 — 앱은 CSP(default-src 'self')
 * 때문에 외부 글꼴을 못 부르므로 같은 오리진에 둬야 한다.
 * 가변 글꼴(굵기 100~900 한 파일)이라 400·700·800·900 을 조각 한 벌로 다 낸다.
 *
 * 다시 받을 때: 이 스크립트를 돌리고 fonts.css 머리의 판(v) 이 바뀌었는지 보고 커밋한다. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAMILIES = [
  { key: 'sans', query: 'Noto+Sans+KR:wght@100..900', host: 'notosanskr' },
  { key: 'serif', query: 'Noto+Serif+KR:wght@200..900', host: 'notoserifkr' },
];
/* 크롬 UA 로 받아야 woff2 + 가변 글꼴 + unicode-range 조각 CSS 가 온다(오래된 UA 에는 ttf 통짜를 준다) */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* Google 의 @font-face CSS 를 우리 경로로 다시 쓴다. 순수 함수 — 테스트가 이것만 본다.
   nameFor(url, i) 가 조각 파일의 상대 경로를 정한다. 돌려주는 files 는 [{url, file}] 순서대로 */
export function rewriteCss(css, nameFor) {
  const files = [];
  const out = css.replace(/src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)\s*format\('woff2'\)/g, (m, url) => {
    const file = nameFor(url, files.length);
    files.push({ url, file });
    return "src: url(" + file + ") format('woff2')";
  });
  if (/https?:\/\//.test(out)) throw new Error('외부 주소가 남아 있다 — Google 이 CSS 형식을 바꿨을 수 있다');
  return { css: out, files };
}
/* 조각 판 번호(v39 등) — 파일 이름에 넣어 두면 판이 바뀔 때 캐시가 저절로 갈린다 */
export function versionOf(url) { const m = url.match(/\/s\/[a-z]+\/(v\d+)\//); return m ? m[1] : 'v0'; }

async function main() {
  const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
  let all = '';
  for (const fam of FAMILIES) {
    const res = await fetch('https://fonts.googleapis.com/css2?family=' + fam.query + '&display=swap', { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(fam.key + ' CSS ' + res.status);
    const css = await res.text();
    if (!css.includes(fam.host)) throw new Error(fam.key + ': 기대한 글꼴이 아니다');
    const ver = versionOf((css.match(/url\((https:[^)]+)\)/) || [])[1] || '');
    const sub = fam.key + '-' + ver;
    fs.rmSync(path.join(DIR, sub), { recursive: true, force: true });
    for (const old of fs.readdirSync(DIR)) if (old.startsWith(fam.key + '-') && old !== sub) fs.rmSync(path.join(DIR, old), { recursive: true, force: true });
    fs.mkdirSync(path.join(DIR, sub), { recursive: true });
    const { css: local, files } = rewriteCss(css, (url, i) => sub + '/' + String(i).padStart(3, '0') + '.woff2');
    let n = 0, bytes = 0;
    /* 여덟 개씩 받는다 — 조각이 250개라 하나씩은 느리고, 한꺼번에는 프록시가 끊는다 */
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(files.slice(i, i + 8).map(async (f) => {
        const r = await fetch(f.url, { headers: { 'User-Agent': UA } });
        if (!r.ok) throw new Error(f.url + ' ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error(f.file + ': woff2 가 아니다');
        fs.writeFileSync(path.join(DIR, f.file), buf); n += 1; bytes += buf.length;
      }));
    }
    all += '/* ' + fam.key + ' — ' + ver + ', ' + n + '조각, ' + Math.round(bytes / 1024) + 'KB */\n' + local.trim() + '\n';
    console.log(fam.key, ver, n + '조각', Math.round(bytes / 1024) + 'KB');
  }
  const head = '/* 브레인레터 글꼴 — Noto Sans KR · Noto Serif KR (SIL Open Font License 1.1, 전문은 OFL.txt).\n' +
    '   letter/fetch-fonts.mjs 가 만든다 — 손으로 고치지 않는다. 받은 날: ' + new Date().toISOString().slice(0, 10) + '\n' +
    '   조각마다 unicode-range 가 있어 브라우저는 지면에 쓰인 글자의 조각만 받는다. */\n';
  fs.writeFileSync(path.join(DIR, 'fonts.css'), head + all);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
