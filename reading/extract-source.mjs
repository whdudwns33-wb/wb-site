#!/usr/bin/env node
/* 출처 지면 → 본문 텍스트 — node reading/extract-source.mjs <주소|파일.html> [-o 출력.txt]
 *
 * 게시판 목록에서 글 주소와 제목만 뽑으려면 `--links <패턴>` 을 쓴다 —
 * 세 주 연속으로 이 한 줄짜리 스크립트를 스크래치패드에 다시 썼다(루틴 v2.2 의 교훈).
 *   node reading/extract-source.mjs <목록 주소> --links artclView
 * 본문 추출은 링크를 버리므로(본문용이다) 목록에는 이 플래그를 쓴다.
 *
 * ③에서 출처를 확정할 때와 ④에서 집필 에이전트에게 근거를 넘길 때 쓴다.
 * 집필에 출처 원문 파일을 그대로 넘기는 것이 규칙이고(루틴 v2.1), 요약해 넘기면
 * 「등」·「기본적으로」·「이내」 같은 한정어가 떨어져 나가 지문이 단정으로 바뀐다.
 *
 * 짧은 줄을 길이만으로 버리면 안 된다 — 두 번 사고가 났다.
 *   W41: 조문의 호·목(「2. 소비자가 사용해서…」)이 사라져 브리프에 없는 사실을 적었다.
 *   W44: 한 문장 가운데 끼인 「1461년에 「형전(刑典)」」이 사라져, 출처에 있는
 *        「나머지 4전」을 그대로 옮겨 쓰고도 지문 안에서 셈이 맞지 않았다.
 * 그래서 아래 세 가지는 짧아도 남긴다.
 *
 * 정부 누리집은 간헐적으로 끊기니 재시도한다. 끊긴다고 다른 주소로 바꿔 적지 않는다. */

import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';

/* 앞줄이 이 글자로 끝났으면 문장이 아직 닫히지 않았다 — 다음 줄은 그 문장의 일부다 */
const OPEN = [',', '·', '(', '「', '『', ';', ':', '-', '~', '＋', '…'];
const SHORT = 25;

export function htmlToText(html) {
  let s = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|td|tr|th|dd|dt|h[1-6]|section|article)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '\n');
  s = decode(s);
  s = s.replace(/[ \t ]+/g, ' ');

  const out = [];
  const seen = new Set();
  for (const raw of s.split('\n')) {
    const l = raw.trim();
    if (!l || seen.has(l)) continue;
    let keep = l.length >= SHORT;
    /* 조문의 호·목 */
    if (!keep && /^(\d+\.|[①-⑳]|[가-힣]\.|▲|▷|※|\*)/.test(l)) keep = true;
    /* 연도·날짜가 든 줄은 사실을 나른다. 게시판의 「등록일자 / 2026-10-21」처럼
       날짜만 든 칸이 따로 떨어져 있는 지면이 있고, 보도자료 날짜는 그 칸에서 확인한다. */
    if (!keep && (/\d{3,4}\s*년/.test(l) || /(19|20)\d{2}/.test(l))) keep = true;
    /* 앞줄이 열려 있다 — 문장 가운데다 */
    if (!keep && out.length && OPEN.some((c) => out[out.length - 1].endsWith(c))) keep = true;
    if (!keep) continue;
    seen.add(l);
    out.push(l);
  }
  return out.join('\n\n') + '\n';
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
export function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] ?? m));
}

export async function fetchPage(url, tries = 4) {
  let last = '';
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' },
        signal: AbortSignal.timeout(45000)
      });
      if (r.ok) return await r.text();
      last = String(r.status);
    } catch (e) { last = e.name === 'TimeoutError' ? '시간 초과' : e.message; }
    if (i < tries) await new Promise((r) => setTimeout(r, i * 3000));
  }
  throw new Error(`받지 못했다 (${last}) — ${url}`);
}

/* 목록 지면에서 (상세 주소, 제목) 짝을 뽑는다 */
export function links(html, pattern) {
  const re = new RegExp(`href="([^"]*${pattern}[^"]*)"[^>]*>\\s*([^<]{4,160})`, 'g');
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(re)) {
    const href = m[1];
    const title = decode(m[2]).replace(/\s+/g, ' ').trim();
    if (!title || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, title });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('-o');
  const outPath = oi >= 0 ? args[oi + 1] : null;
  const li = args.indexOf('--links');
  const skip = new Set([oi + 1, li + 1].filter((i) => i > 0));
  const target = args.filter((a, i) => !a.startsWith('-') && !skip.has(i))[0];
  if (!target) {
    console.error('쓰기: node reading/extract-source.mjs <주소|파일.html> [-o 출력.txt]');
    process.exit(2);
  }
  const html = /^https?:\/\//.test(target) ? await fetchPage(target) : fs.readFileSync(target, 'utf8');
  if (li >= 0) {
    const pat = args[li + 1];
    if (!pat) { console.error('--links 뒤에 패턴이 필요하다 (예: --links artclView)'); process.exit(2); }
    const found = links(html, pat);
    if (!found.length) console.error(`(짝을 못 찾음 — 받은 길이 ${html.length}. 목록이 자바스크립트로 그려지는 지면일 수 있다)`);
    for (const f of found) console.log(f.href, '|', f.title);
    process.exit(0);
  }
  const text = htmlToText(html);
  if (outPath) {
    fs.writeFileSync(outPath, text);
    console.error(`${text.split('\n\n').length - 1}줄 · ${text.length}자 → ${outPath}`);
  } else {
    process.stdout.write(text);
  }
}
