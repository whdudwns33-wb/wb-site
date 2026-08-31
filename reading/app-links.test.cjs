'use strict';
/* 두 학생 앱이 서로 오갈 수 있는지 (node reading/app-links.test.cjs)
 *
 * 연동 QR은 진로독서(/?c=<코드>)로 열린다. 코드를 받는 자리가 거기뿐이기 때문이다.
 * 그런데 워드브레인 파일럿에서 학생이 실제로 써야 하는 앱은 /vocab/ 이다.
 * 두 앱 사이에 링크가 없으면 학생이 주소를 손으로 쳐야 하고, 파일럿 첫날이 거기서 막힌다.
 * 실제로 한동안 그 링크가 양쪽 다 없었다.
 *
 * 헤더를 손보다가 조용히 사라지기 쉬운 두 줄이라 여기서 지킨다.
 */
const fs = require('fs');
const path = require('path');

const reading = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const vocab = fs.readFileSync(path.join(__dirname, '..', 'vocab', 'index.html'), 'utf8');
const errors = [];
const E = (m) => errors.push(m);

const head = (html, tag) => {
  const i = html.indexOf('<header');
  return i < 0 ? (E(tag + ': <header> 를 찾지 못했습니다'), '') : html.slice(i, i + 900);
};

/* 진로독서 → 워드브레인 */
const rh = head(reading, '진로독서');
if (!/href="\/vocab\/"/.test(rh)) E('진로독서 헤더에 /vocab/ 로 가는 링크가 없습니다 — QR로 들어온 학생이 워드브레인에 못 갑니다');

/* 워드브레인 → 진로독서 (연동은 진로독서 설정에서 한다) */
const vh = head(vocab, '워드브레인');
if (!/href="\/"/.test(vh)) E('워드브레인 헤더에 진로독서로 가는 링크가 없습니다 — 연동·재연동을 하러 갈 길이 없습니다');

/* 좁은 화면에서 헤더가 두 줄로 무너지지 않게 접는 규칙 */
if (!/@media \(max-width: 430px\)[\s\S]{0,220}\.swap \.lbl \{ display: none/.test(vocab))
  E('워드브레인의 좁은 화면 규칙이 없습니다 — 390px에서 헤더가 두 줄로 무너집니다');

/* 링크가 아니라 버튼+JS로 바뀌면 새 탭·뒤로 가기가 달라진다. 앵커여야 한다. */
if (!/<a class="swap"/.test(reading) || !/<a class="swap"/.test(vocab))
  E('앱 사이 이동은 <a> 여야 합니다 — 버튼+JS로 바꾸면 뒤로 가기가 달라집니다');

if (errors.length) {
  errors.forEach((e) => console.error('ERROR:', e));
  console.error('\nFAIL — ' + errors.length + '건');
  process.exit(1);
}
console.log('OK — 두 학생 앱이 서로 오갈 수 있고, 좁은 화면에서 헤더가 무너지지 않습니다');
