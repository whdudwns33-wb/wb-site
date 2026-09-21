#!/usr/bin/env node
/* node letter/fetch-fonts.test.mjs — Google Fonts CSS 를 우리 경로로 다시 쓰는 순수 함수만 본다(망은 안 탄다) */
import assert from 'node:assert/strict';
import { rewriteCss, versionOf } from './fetch-fonts.mjs';

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  ✓ ' + name); };

const FIX = `@font-face {
  font-family: 'Noto Sans KR';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/notosanskr/v39/AAAA.0.woff2) format('woff2');
  unicode-range: U+f9ca-fa0b;
}
@font-face {
  font-family: 'Noto Sans KR';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/notosanskr/v39/AAAA.1.woff2) format('woff2');
  unicode-range: U+ac00-ac96;
}
`;
t('조각 주소를 순서대로 우리 경로로 바꾸고 목록을 돌려준다', () => {
  const { css, files } = rewriteCss(FIX, (url, i) => 'sans-v39/' + String(i).padStart(3, '0') + '.woff2');
  assert.deepEqual(files.map((f) => f.file), ['sans-v39/000.woff2', 'sans-v39/001.woff2']);
  assert.equal(files[1].url, 'https://fonts.gstatic.com/s/notosanskr/v39/AAAA.1.woff2');
  assert.ok(css.includes("src: url(sans-v39/001.woff2) format('woff2')"));
  assert.ok(!/https?:\/\//.test(css), '외부 주소가 남았다');
  assert.ok(/unicode-range: U\+ac00-ac96/.test(css), 'unicode-range 가 사라지면 조각 나누기가 무의미하다');
  assert.ok(/font-weight: 100 900/.test(css), '가변 굵기 범위가 사라졌다');
});
t('woff2 가 아닌 src 가 남으면(형식이 바뀌면) 조용히 넘기지 않고 던진다', () => {
  assert.throws(() => rewriteCss(FIX.replace("format('woff2')", "format('truetype')"), () => 'x.woff2'), /외부 주소/);
});
t('판 번호는 주소의 /s/<글꼴>/vNN/ 에서 읽는다', () => {
  assert.equal(versionOf('https://fonts.gstatic.com/s/notoserifkr/v31/BBB.3.woff2'), 'v31');
  assert.equal(versionOf('https://example.com/x.woff2'), 'v0');
});
console.log(`\nOK — ${n}개 통과 (fetch-fonts.test.mjs)`);
