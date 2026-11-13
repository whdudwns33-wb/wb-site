/* 체험 문제지 만들기 — node naesin-tg/extract/make-sample.mjs
   저장소에 들어가는 유일한 문제지다. 문항·그림은 전부 자체 창작이고 족보닷컴 지면과 무관하다.
   쪽은 SVG 로 그린다(의존성 없이 만들 수 있는 그림이 이것뿐이다). 실제 자료는 build-sheet.mjs 가 JPEG 로 만든다. */
import fs from 'node:fs';

const W = 794, H = 1123;   // A4 96dpi
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const spans = [];   // 쪽마다 문항 덩어리의 세로 범위 — 문항 영역(한 문제씩 보기)을 만든다
const page = (head, blocks) => {
  let y = 110; let body = ''; const sp = [];
  for (const b of blocks) {
    sp.push({ y0: y - 26 });
    for (const line of b) { body += `<text x="${line.startsWith(' ') ? 78 : 60}" y="${y}" font-size="${line.startsWith(' ') ? 17 : 19}"${line.startsWith(' ') ? '' : ' font-weight="700"'}>${esc(line.trim())}</text>`; y += 32; }
    sp[sp.length - 1].y1 = y - 14;
    y += 34;
  }
  spans.push(sp);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Noto Sans KR','Apple SD Gothic Neo',sans-serif" fill="#222A24">`
    + `<rect width="${W}" height="${H}" fill="#fff"/><text x="60" y="56" font-size="15" fill="#5F665C">${esc(head)}</text><line x1="60" y1="70" x2="${W - 60}" y2="70" stroke="#3E6B4A" stroke-width="2"/>${body}</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
};

const HEAD = '탐구브레인 체험 문제지 · 중2 과학 · 전기 (자체 창작)';
const pages = [
  page(HEAD, [
    ['1. 전기가 잘 통하는 물질을 무엇이라고 하는가?', ' ① 부도체   ② 도체   ③ 절연체', ' ④ 유전체   ⑤ 반도체'],
    ['2. 마찰한 두 물체가 서로 끌어당기는 까닭으로 옳은 것은?', ' ① 두 물체가 같은 종류의 전하를 띠어서', ' ② 두 물체가 다른 종류의 전하를 띠어서', ' ③ 두 물체의 질량이 달라져서', ' ④ 두 물체의 온도가 같아져서', ' ⑤ 두 물체가 전하를 모두 잃어서'],
    ['3. 전류의 세기를 나타내는 단위를 쓰시오. (한글로)'],
  ]),
  page(HEAD, [
    ['4. 전압이 같을 때 저항을 2배로 하면 전류의 세기는', '   어떻게 되는가?', ' ① 4배가 된다   ② 2배가 된다   ③ 변하지 않는다', ' ④ 절반이 된다   ⑤ 4분의 1이 된다'],
    ['5. 옳은 것을 모두 고르시오. (정답 2개)', ' ① 전자는 (-)전하를 띤다.', ' ② 전류는 전지의 (-)극에서 (+)극으로 흐른다고 약속했다.', ' ③ 저항의 단위는 옴(Ω)이다.', ' ④ 전압의 단위는 암페어(A)이다.', ' ⑤ 부도체에는 전자가 없다.'],
    ['6. [서술형] 건조한 겨울에 문손잡이를 잡을 때 따끔한', '   까닭을 전하의 이동으로 설명하시오.'],
  ]),
  page(HEAD + ' · 정답과 해설', [
    ['1. ②  전기가 잘 통하는 물질은 도체이다.'],
    ['2. ②  다른 종류의 전하 사이에는 끌어당기는 힘이 작용한다.'],
    ['3. 암페어  전류의 세기 단위는 암페어(A)이다.'],
    ['4. ④  전압이 같으면 전류는 저항에 반비례한다.'],
    ['5. ①, ③  전류의 방향은 (+)극에서 (-)극이고, 전압의 단위는 볼트(V)이다.'],
    ['6. 모범답안: 몸에 쌓여 있던 전하가 금속 손잡이로', '   한꺼번에 이동하기 때문이다.'],
  ]),
];

/* 문항 i 의 영역 = 그 쪽 i 번째 덩어리(정답 쪽은 빼고). 비율로 적는다 — 서버·화면이 쪽 크기를 몰라도 된다. */
const QPAGES = [1, 1, 1, 2, 2, 2];
const crops = {};
QPAGES.forEach((p, i) => {
  const k = QPAGES.slice(0, i).filter((x) => x === p).length, b = spans[p - 1][k];
  crops[i + 1] = [{ p, x: +(40 / W).toFixed(4), y: +(b.y0 / H).toFixed(4), w: +((W - 80) / W).toFixed(4), h: +((b.y1 - b.y0) / H).toFixed(4) }];
});
const out = {
  id: 'sample-sc-m2-elec-1',
  sheet: { title: '[체험] 전기 1회', subject: 'science', grade: '중2', unit: '체험', step: 3, kind: 'test', pages: 3, answerFrom: 3,
    questions: [
      { no: 1, type: 'choice', page: 1, answer: '2' }, { no: 2, type: 'choice', page: 1, answer: '2' },
      { no: 3, type: 'short', page: 1, answer: '암페어|A' }, { no: 4, type: 'choice', page: 2, answer: '4' },
      { no: 5, type: 'choice', page: 2, answer: '1,3' }, { no: 6, type: 'essay', page: 2, answer: '' },
    ], crops },
  pages,
};
fs.writeFileSync(new URL('../sheet-sample.json', import.meta.url), JSON.stringify(out));
console.log('sheet-sample.json', pages.length + '쪽', Math.round(JSON.stringify(out).length / 1024) + 'KB');
