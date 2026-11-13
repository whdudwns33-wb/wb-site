/* 회귀 검사용 자체 창작 지면. 구매 자료의 문장·그림은 포함하지 않는다. */
export const sp = (x, text, size = 9.1, color = '#000000', w = Math.min(text.length * 5, 210)) => ({ x, text, size, color, w });
export const ln = (y, ...spans) => ({ y, spans });
export const pg = (no, lines) => ({ no, width: 595, height: 842, lines });
const head = () => [ln(40, sp(60, '가상출판(가상저자)3-1', 7.9)), ln(65, sp(60, '중3 국어 1-1.등불의 약속', 11))];
const passage = () => [ln(100, sp(60, '※ 다음 글을 읽고 물음에 답하시오.', 7.9)),
  ln(125, sp(150, '등불의 약속')), ln(145, sp(253, '한새벽', 9.1, '#000000', 25)),
  ln(170, sp(70, '작은 등불이 새벽 바람을 비춘다'))];
const marker = (n, y) => [ln(y, sp(60, n + '.', 13.7, '#191919')), ln(y + 6, sp(86, '등불이 나타내는 마음으로 옳은 것은?'))];
const option = (n, y, color = '#000000') => ln(y, sp(70, '①②③④⑤'[n - 1] + ' 창작 선지 ' + n, 9.1, color));

export function basicFixture(series = '실력완성') {
  const student = [pg(1, [...head(), ...passage(), ...marker(1, 300),
    ...Array.from({ length: 5 }, (_, i) => option(i + 1, 340 + i * 30))]),
    pg(2, [ln(40, sp(400, '1-1.등불의 약속', 7.9)), ...marker(2, 100), ln(140, sp(70, '등불의 뜻을 한 문장으로 쓰시오.'))])];
  const teacher = [pg(3, [...head(), ...passage(), ...marker(1, 300),
    ...Array.from({ length: 5 }, (_, i) => [option(i + 1, 340 + i * 50, series === '실력완성' && i === 2 ? '#ff0000' : '#000000'),
      ...(series === '실력완성' ? [ln(355 + i * 50, sp(70, '→ 창작 근거 ' + (i + 1) + '이다.', 7, i === 2 ? '#ff0000' : '#0000ff'))] : [])]).flat(),
    ...(series === '대표유형' ? [ln(610, sp(70, '[정답] ③', 7.9)), ln(625, sp(70, '등불은 기다리는 마음이다. ', 7.9)),
      ...[1, 2, 4, 5].map((n, i) => ln(645 + i * 20, sp(70, '①②③④⑤'[n - 1] + ' 창작 오답 근거 ' + n + '. ', 7.9)))] : [])]),
    pg(4, [ln(40, sp(400, '1-1.등불의 약속', 7.9)), ...marker(2, 100), ln(140, sp(70, '등불의 뜻을 한 문장으로 쓰시오.')),
      ln(180, sp(70, '[정답] 새로운 하루를 기다리는 마음이다.', 7.9)), ln(200, sp(70, '◎ 채점기준: 기다림의 의미를 서술하면 인정.', 7.9))]),
    pg(5, [ln(100, sp(60, '1) [정답] ③', 7.9)), ln(120, sp(60, '[해설] 등불은 기다림을 뜻한다.', 7.9)),
      ln(200, sp(60, '2) [정답] 새로운 하루를 기다리는 마음이다.', 7.9)),
      ln(220, sp(60, '[해설] ◎ 채점기준: 기다림의 의미를 서술하면 인정.', 7.9))])];
  student[0].lines.push(ln(30, sp(60, '[' + series + ']', 7.9)));
  teacher[0].lines.push(ln(30, sp(60, '[' + series + ']', 7.9)));
  return { file: '창작-기본.pdf', pages: student.concat(teacher) };
}

function exercisePage(no, pageIndex, teacher, series) {
  const lines = pageIndex === 0 ? head() : [ln(40, sp(400, '1-1.등불의 약속', 7.9))];
  lines.push(ln(100, sp(70, '작은 등불은 강가의 새벽을 기다린다'), sp(320, '나는 등불 곁에서 약속을 떠올린다')));
  for (let ci = 0; ci < 2; ci++) {
    const x = ci ? 319 : 67, count = pageIndex === 1 ? 4 : 5;
    const stemX = series === 'concept2' ? x - 10 : x + 23;
    const size = series === 'concept2' ? 9.6 : 9.4;
    const stem = (series === 'concept2' ? 'Q' + (ci + 1) + '. ' : '') +
      (pageIndex === 1 && ci ? '각 설명이 옳은지 판단하시오.' : ci ? '적절하지 않은 설명은?' : '적절한 설명은?');
    lines.push(ln(220, sp(stemX, stem, size)));
    for (let i = 1; i <= count; i++) {
      const right = pageIndex === 0 ? (ci ? 4 : 3) : ci ? null : 3;
      const color = teacher && series !== 'concept2' && i === right ? '#d30000' : '#000000';
      lines.push(ln(260 + (i - 1) * 70, sp(x, '①②③④⑤'[i - 1] + ' 창작 설명 ' + i + '이다.', i === 2 ? 9.0 : 9.1, color)));
      if (teacher) {
        if (series === 'concept2') lines.push(ln(280 + (i - 1) * 70, sp(x, '⇨ ( ㉠, ㉡ ) ↳ 창작 첨삭 ' + i, 7.9, '#315f97')));
        else lines.push(ln(280 + (i - 1) * 70, sp(x, '↳ 창작 첨삭 ' + i, 7.4, '#28448e')));
        if (pageIndex === 1 && ci) lines.push(ln(260 + (i - 1) * 70, sp(x + 190, i % 2 ? '(◯)' : '(✕)', 9.1, '#d30000')));
      }
    }
    if (teacher && series === 'concept2' && !(pageIndex === 1 && ci)) lines.push(ln(710, sp(x + 120, '(정답 ' + '①②③④⑤'[(pageIndex === 0 ? ci ? 4 : 3 : 3) - 1] + ')', 7.9, '#315f97')));
  }
  if (teacher) lines.push(ln(745, sp(70, '근거를 찾아 설명을 고쳐 쓰는 창작 안내', 7.2, '#0a8667')));
  lines.sort((a, b) => a.y - b.y);
  return pg(no, lines);
}

export function puriFixture(series = 'solution') {
  const pages = [exercisePage(1, 0, false, series), exercisePage(2, 1, false, series),
    exercisePage(3, 0, true, series), exercisePage(4, 1, true, series)];
  for (const p of [pages[0], pages[2]]) p.lines.push(ln(30, sp(60, series === 'concept2' ? '풀이 전략 문제를 푸는 전략을 파악하자!!' : '[풀이완성]', 7.9)));
  return { file: '창작-풀이.pdf', pages };
}
