#!/usr/bin/env node
/* reading/extract-source.mjs 단위 테스트 — node reading/extract-source.test.mjs
 *
 * 망을 쓰지 않는다. 지면 모양을 흉내 낸 HTML 조각으로 「짧은 줄을 남기는 규칙」을 잰다 —
 * 그 규칙이 무너져서 W41·W44 에 두 번 사고가 났다. */
import { htmlToText, decode } from './extract-source.mjs';

let fail = 0;
const ok = (c, what) => { if (!c) { console.error('X', what); fail++; } };
const hasLine = (t, frag, what) => ok(t.includes(frag), what + ' — 「' + frag + '」 가 빠졌다');
const noLine = (t, frag, what) => ok(!t.includes(frag), what + ' — 「' + frag + '」 가 남았다');

/* ── W44 사고 재현: 한 문장 가운데 끼인 짧은 줄 ──
   우리역사넷 지면이 이 모양이었다. 가운데 줄이 17자라 길이로 거르면 사라지고,
   그러면 「호전」만 남아 뒤의 「나머지 4전」과 셈이 맞지 않는다. */
{
  const html = `<div><p>이때 세조는 사람들의 실생활에 직접 관계되는 부문부터 먼저 편찬하도록 했는데, 그 결과 1460년(세조 6)에 「호전(戶典)」,</p>
<p>1461년에 「형전(刑典)」</p>
<p>이 차례로 완성되었다. 그리고 「호전」 편찬이 완성되었을 때 새 법전의 이름을 ‘경국대전’으로 확정하였다.</p></div>`;
  const t = htmlToText(html);
  hasLine(t, '1461년에 「형전(刑典)」', '문장 가운데 끼인 짧은 줄 (앞줄이 쉼표로 열려 있다)');
  hasLine(t, '이 차례로 완성되었다', '그 다음 줄');
}

/* ── W41 사고 재현: 조문의 호·목 ── */
{
  const html = `<ul><li>다음 각 호의 어느 하나에 해당하는 경우에는 청약철회를 할 수 없습니다.</li>
<li>1. 재화가 멸실된 경우</li>
<li>2. 소비자가 사용해서 가치가 떨어진 경우</li>
<li>① 복제가 가능한 재화</li>
<li>가. 그 밖의 경우</li></ul>`;
  const t = htmlToText(html);
  hasLine(t, '1. 재화가 멸실된 경우', '아라비아 호');
  hasLine(t, '2. 소비자가 사용해서', '아라비아 호 2');
  hasLine(t, '① 복제가 가능한 재화', '동그라미 호');
  hasLine(t, '가. 그 밖의 경우', '한글 목');
}

/* ── 보도자료의 ▲ 불릿도 남긴다 (협력 내용 나열이 여기 실린다) ── */
{
  const t = htmlToText('<p>주요 협력 내용</p><p>▲협의체 구성·운영</p><p>▷지원금 배분 확대</p>');
  hasLine(t, '▲협의체 구성·운영', '▲ 불릿');
  hasLine(t, '▷지원금 배분 확대', '▷ 불릿');
}

/* ── 연도가 든 짧은 줄 ── */
{
  const t = htmlToText('<p>머리말</p><p>2026. 10. 16.</p><p>1485년(성종 16)</p>');
  hasLine(t, '1485년(성종 16)', '연도가 든 줄');
}

/* ── 메뉴로 보이는 짧은 줄은 버린다 ── */
{
  const t = htmlToText(`<nav><a>로그인</a><a>검색</a><a>사이트맵</a></nav>
<p>본문은 스물다섯 글자를 넘기므로 그대로 남아 있어야 하는 줄이다.</p>`);
  noLine(t, '로그인', '메뉴는 버린다');
  noLine(t, '사이트맵', '메뉴는 버린다 2');
  hasLine(t, '본문은 스물다섯 글자를', '긴 본문은 남는다');
}

/* ── script·style·주석은 통째로 지운다 ── */
{
  const t = htmlToText(`<script>var secretVariableName = "자바스크립트 안의 긴 문장이 본문처럼 섞이면 안 된다";</script>
<style>.cls { content: "스타일 안의 긴 문장도 마찬가지로 섞이면 안 된다"; }</style>
<!-- 주석 안의 긴 문장도 본문이 아니므로 섞이면 안 된다 -->
<p>이것만 본문으로 남아야 하고 길이도 스물다섯 자를 넘는다.</p>`);
  noLine(t, 'secretVariableName', 'script 제거');
  noLine(t, '스타일 안의 긴 문장', 'style 제거');
  noLine(t, '주석 안의 긴 문장', '주석 제거');
  hasLine(t, '이것만 본문으로 남아야', '본문은 남는다');
}

/* ── 같은 줄이 두 번 나오면 한 번만 ── */
{
  const t = htmlToText('<p>똑같은 문장이 지면에 두 번 실려 있는 경우가 흔하다.</p><p>똑같은 문장이 지면에 두 번 실려 있는 경우가 흔하다.</p>');
  ok(t.split('똑같은 문장이').length - 1 === 1, '중복 줄은 한 번만');
}

/* ── 엔티티 ── */
ok(decode('&amp;&lt;&gt;&quot;') === '&<>"', '기본 엔티티');
ok(decode('&#49;&#x32;') === '12', '숫자 엔티티');
ok(decode('&middot;&hellip;') === '·…', '이름 엔티티');
ok(decode('&unknownent;') === '&unknownent;', '모르는 엔티티는 그대로');
{
  const t = htmlToText('<p>따옴표가 &lsquo;이렇게&rsquo; 풀려야 스물다섯 자를 넘는 줄이 된다.</p>');
  hasLine(t, '‘이렇게’', '작은따옴표 엔티티');
}

/* ── <br> 과 블록 끝은 줄바꿈이다 (한 문단이 통째로 붙어 버리면 안 된다) ── */
{
  const t = htmlToText('<p>앞 문단은 스물다섯 자를 넘도록 적어 둔 줄이다.<br>뒤 문단도 스물다섯 자를 넘도록 적어 둔 줄이다.</p>');
  hasLine(t, '앞 문단은 스물다섯 자를', 'br 앞');
  hasLine(t, '뒤 문단도 스물다섯 자를', 'br 뒤');
  ok(!t.includes('줄이다.뒤 문단'), 'br 이 줄을 가른다');
}

/* ── 표 안의 숫자 칸 (등록일자가 여기 있다) ── */
{
  const t = htmlToText('<table><tr><th>등록일자</th><td>2026-10-21</td></tr></table>');
  hasLine(t, '2026-10-21', '표 안의 날짜');
}

if (fail) { console.error(`\nFAIL — ${fail}건`); process.exit(1); }
console.log('OK — extract-source 검사 통과');
