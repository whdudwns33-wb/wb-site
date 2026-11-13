/* PDF 한 건 → 올릴 문제지 파일(JSON) — node naesin-tg/extract/build-sheet.mjs <PDF> --id <id> [--title 제목] [--out 파일]
   지면을 고치지 않는다: 쪽을 그림(JPEG)으로 바꾸기만 한다. poppler 의 pdftoppm·pdftotext 가 있어야 한다(brew install poppler).
   오프라인 도구다 — 구매 자료를 외부로 보내지 않는다. 결과 파일도 저장소 밖 작업 폴더에 둔다(저장소는 public).

   정답은 여기서 읽지 않는다. 족보닷컴 지면은 정답의 동그라미 숫자가 글자층에 없어서(2026-11-12 실측)
   강사가 관리 웹에서 번호별로 넣는다. 이 도구는 "정답·해설이 시작하는 쪽"만 글자로 짐작해 채워 둔다. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/* '정답'과 '해설'이 같이 나오는 첫 쪽 — 표지 안내문에도 두 낱말이 있어 2쪽부터 본다. 못 찾으면 0(잠금 없음, 강사가 고친다). */
export const guessAnswerFrom = (pageTexts) => {
  const i = pageTexts.findIndex((t, k) => k > 0 && /정답/.test(t) && /해설/.test(t));
  return i < 0 ? 0 : i + 1;
};

/* 문항 영역 — 한 문제씩 보여 주려고 쪽 그림에서 그 문항만 잘라 낼 사각형을 글자층 좌표로 잡는다(지면은 고치지 않는다).
   pages: [{w, h, words:[{x0,y0,x1,y1,t}]}] (문제 쪽만, 1쪽부터). 2단 조판: 단은 쪽 가운데로 나눈다.
   - 문항 머리 「N.」 을 읽는 순서(쪽 → 왼단 → 오른단 → 위에서 아래)로 1, 2, 3… 차례대로만 받는다(단원 제목 번호 같은 엇나간 숫자는 버림).
   - 영역 = 머리부터 같은 단의 다음 머리(또는 단 끝)까지. 다음 머리가 다음 단 중간에 있으면 그 단 위쪽도 이어 붙인다(넘어간 문항).
   - 「[3~4] 다음 자료를…」 같은 묶음 머리는 그 아래 공통 자료를 해당 문항마다 맨 위에 붙인다.
   결과: { [no]: [{p, x, y, w, h}] } — 쪽 크기 대비 비율(0~1). 못 잡은 번호는 빠진다(화면은 쪽 보기로 되돌아간다). */
export function cropsFromWords(pages) {
  const HEAD = /^(\d{1,2})[.．]$/, GROUP = /^\[(\d{1,2})\s*[~∼～\-–]\s*(\d{1,2})\]/;
  const cols = [];   // 읽는 순서의 단 목록
  pages.forEach((pg, i) => {
    for (const side of [0, 1]) {
      const ws = pg.words.filter((w) => (side ? w.x0 >= pg.w / 2 : w.x0 < pg.w / 2) && w.y0 > pg.h * 0.04 && w.y1 < pg.h * 0.955);
      if (!ws.length) continue;
      cols.push({ p: i + 1, pg, x0: Math.max(0, Math.min(...ws.map((w) => w.x0)) - 6), x1: Math.min(pg.w, Math.max(...ws.map((w) => w.x1)) + 6),
        top: Math.min(...ws.map((w) => w.y0)), bottom: pg.h * 0.955, ws: ws.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0) });
    }
  });
  const starts = []; let want = 1;   // {ci, y, no?, group?}
  cols.forEach((c, ci) => {
    for (const w of c.ws) {
      if (w.x0 > c.x0 + 30) continue;   // 단 왼쪽 끝에서 시작하는 낱말만 머리로 본다
      const g = w.t.match(GROUP);
      if (g && Number(g[1]) === want && Number(g[2]) >= want) { starts.push({ ci, y: w.y0, group: [Number(g[1]), Number(g[2])] }); continue; }
      const m = w.t.match(HEAD);
      if (m && Number(m[1]) === want) { starts.push({ ci, y: w.y0, no: want }); want += 1; }
    }
  });
  const pad = 4;
  const rect = (c, y0, y1) => ({ p: c.p, x: c.x0 / c.pg.w, y: Math.max(0, y0 - pad) / c.pg.h, w: (c.x1 - c.x0) / c.pg.w, h: (Math.min(y1, c.bottom) - Math.max(0, y0 - pad)) / c.pg.h });
  const span = (k) => {   // starts[k] 부터 다음 머리 전까지의 사각형들
    const s = starts[k], nx = starts[k + 1], c = cols[s.ci];
    if (nx && nx.ci === s.ci) return [rect(c, s.y, nx.y - pad)];
    const out = [rect(c, s.y, c.bottom)];
    const c2 = cols[s.ci + 1];
    if (nx && nx.ci === s.ci + 1 && nx.y - c2.top > c2.pg.h * 0.03) out.push(rect(c2, c2.top, nx.y - pad));
    return out;
  };
  const crops = {}; let stem = null;
  starts.forEach((s, k) => {
    if (s.group) { stem = { range: s.group, rects: span(k) }; return; }
    const pre = stem && s.no >= stem.range[0] && s.no <= stem.range[1] ? stem.rects : [];
    crops[s.no] = pre.concat(span(k)).map((r) => Object.fromEntries(Object.entries(r).map(([k2, v]) => [k2, k2 === 'p' ? v : Math.round(v * 10000) / 10000])))
      .filter((r) => r.h > 0.005);
  });
  return crops;
}

/* PDF 의 문제 쪽(1..last) 글자층 → cropsFromWords */
export function cropsForPdf(pdf, last) {
  const pages = [];
  for (let n = 1; n <= last; n += 1) {
    const bb = execFileSync('pdftotext', ['-bbox', '-f', String(n), '-l', String(n), pdf, '-'], { encoding: 'utf8' });
    const size = bb.match(/<page width="([\d.]+)" height="([\d.]+)"/);
    pages.push({ w: +size[1], h: +size[2], words: [...bb.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: m[5] })) });
  }
  return cropsFromWords(pages);
}

if (process.argv[1] && import.meta.url === new URL('file://' + path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf('--' + k); return i < 0 ? '' : args[i + 1]; };
  const pdf = args[0];
  const id = opt('id');
  if (!pdf || !/^[A-Za-z0-9-]{3,60}$/.test(id)) { console.error('쓰는 법: node naesin-tg/extract/build-sheet.mjs <PDF> --id <영문·숫자·하이픈> [--title 제목] [--out 파일]'); process.exit(1); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
  execFileSync('pdftoppm', ['-r', '110', '-jpeg', '-jpegopt', 'quality=72', pdf, path.join(tmp, 'p')]);
  const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.jpg')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const pages = files.map((f) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(tmp, f)).toString('base64'));
  const texts = files.map((_, i) => execFileSync('pdftotext', ['-f', String(i + 1), '-l', String(i + 1), pdf, '-'], { encoding: 'utf8' }));
  fs.rmSync(tmp, { recursive: true });
  const big = pages.findIndex((p) => p.length > 1_400_000);
  if (big >= 0) { console.error((big + 1) + '쪽 그림이 서버 상한을 넘어요. 해상도(-r)를 낮춰 주세요.'); process.exit(1); }
  const answerFrom = guessAnswerFrom(texts);
  const sheet = { title: opt('title') || path.basename(pdf, '.pdf'), subject: 'science', grade: '', unit: '', step: 3, kind: 'test',
    pages: pages.length, answerFrom, questions: [], crops: cropsForPdf(pdf, answerFrom ? answerFrom - 1 : pages.length) };
  const out = opt('out') || path.join(path.dirname(pdf), id + '.sheet.json');
  fs.writeFileSync(out, JSON.stringify({ id, sheet, pages }));
  console.log(out + ' — ' + pages.length + '쪽, 정답·해설 시작 ' + (sheet.answerFrom || '못 찾음') + '쪽, 문항 영역 ' + Object.keys(sheet.crops).length + '개, ' + Math.round(fs.statSync(out).size / 1024) + 'KB');
  console.log('관리 웹(/admin/naesin-tg-admin.html)에서 이 파일을 고르고 과목·단원·정답을 넣으세요.');
}
