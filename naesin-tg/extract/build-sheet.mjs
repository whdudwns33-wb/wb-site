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
  const sheet = { title: opt('title') || path.basename(pdf, '.pdf'), subject: 'science', grade: '', unit: '', step: 3, kind: 'test',
    pages: pages.length, answerFrom: guessAnswerFrom(texts), questions: [] };
  const out = opt('out') || path.join(path.dirname(pdf), id + '.sheet.json');
  fs.writeFileSync(out, JSON.stringify({ id, sheet, pages }));
  console.log(out + ' — ' + pages.length + '쪽, 정답·해설 시작 ' + (sheet.answerFrom || '못 찾음') + '쪽, ' + Math.round(fs.statSync(out).size / 1024) + 'KB');
  console.log('관리 웹(/admin/naesin-tg-admin.html)에서 이 파일을 고르고 과목·단원·정답을 넣으세요.');
}
