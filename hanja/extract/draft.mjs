#!/usr/bin/env node
/* WB 한자브레인 — 어휘 교재 텍스트 → 단어장 초안 (오프라인 도구)
 *   node hanja/extract/draft.mjs <텍스트.txt> <출력 디렉터리> [--id <단어장 id>] [--title <제목>]
 *
 * 문제집을 손으로 치는 것이 병목이다. PDF 를 텍스트로 뽑은 것(pdftotext -layout, 또는 뷰어에서 복사한 것)을
 * 받아 관리 웹 붙여넣기 형식(words.txt)으로 바꾼다. 구매 자료를 외부 AI API 로 보내지 않는다 — 규칙 기반 오프라인이다.
 *
 * 국어브레인 추출기와 같은 두 가지를 지킨다: ① 못 뽑은 줄은 조용히 넘기지 않는다 — review/unmatched.txt 에
 * 줄 번호·이유와 함께 내린다 ② 초안은 초안이다 — 사람이 words.txt 를 보고 고친 뒤 book-validate 로 검사해 올린다.
 *
 * 알아보는 줄 모양(번호 「1.」「(1)」은 떼고 본다):
 *   1일차 / 제1과 / Day 1 / Unit 3 / 3주차 …          → 단원(# 줄)
 *   관측(觀測) 자연 현상을 살펴 재는 것                  → 낱말 | 뜻 | 觀測
 *   觀測 관측 : 뜻    ·    관측 觀測 - 뜻               → 낱말 | 뜻 | 觀測
 *   다잡다 : 흐트러진 마음을 단단히 하다                  → 낱말 | 뜻   (구분 기호가 있어야 고유어로 본다)
 *   觀 볼 관 25획    ·    觀 볼 관                     → 觀 | 볼 관 | 25
 *   예) 별을 관측했다.  ·  예문: …                     → 바로 앞 낱말의 예문
 */
import fs from 'node:fs';
import path from 'node:path';

const HJ = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';
const RE = {
  /* \b 는 한글 뒤에서 안 통한다(ASCII 낱말 경계) — 한글 뒤에는 (?![가-힣]) 로 본다 */
  unit: new RegExp('^(?:제\\s*)?(\\d{1,3})\\s*(일차|일|과|단원|강|회|주차|장)(?![가-힣])|^(?:Day|DAY|Lesson|LESSON|Unit|UNIT|Part|PART)\\s*(\\d{1,3})(?!\\d)'),
  numbered: /^(?:\(?\d{1,3}[.)]|[①-⑳]|[•·▪▶■□●○-])\s*/,
  wordParen: new RegExp('^([가-힣]{1,12})\\s*[(（]\\s*([' + HJ + ']{1,8})\\s*[)）]\\s*[:：\\-–—=]?\\s*(.+)$'),
  hanjaWord: new RegExp('^([' + HJ + ']{1,8})\\s+([가-힣]{1,12})\\s*[:：\\-–—=]?\\s+(.+)$'),
  wordHanja: new RegExp('^([가-힣]{1,12})\\s+([' + HJ + ']{1,8})\\s*[:：\\-–—=]?\\s+(.+)$'),
  wordSep: /^([가-힣]{1,12})\s*[:：\-–—=]\s+(.+)$/,
  charLine: new RegExp('^([' + HJ + '])\\s+([가-힣]{1,8})\\s+([가-힣]{1,2})(?:\\s*[,·]?\\s*(\\d{1,2})\\s*획?)?\\s*$'),
  example: /^(?:예|예문|例|보기|예시)\s*[:：)）.]\s*(.+)$/,
  hanjaOnly: new RegExp('^[' + HJ + '\\s]+$'),
  pageNo: /^\d{1,3}$/,
};

function cleanMeaning(m) {
  return String(m || '').replace(/\s+/g, ' ').replace(/[|]/g, '/').replace(/\s*\d{1,3}\s*$/, '').trim();
}

/* 텍스트 → { lines(붙여넣기 형식), unmatched:[{no, line, reason}], counts } */
export function draftFromText(text) {
  const out = [], unmatched = [];
  const counts = { units: 0, words: 0, chars: 0, examples: 0 };
  let lastWord = -1;
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const no = i + 1;
    let line = raw.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) return;
    if (RE.pageNo.test(line)) return;                                   /* 쪽 번호 */
    const u = line.match(RE.unit);
    if (u) { out.push('# ' + line); counts.units += 1; lastWord = -1; return; }
    const ex = line.match(RE.example);
    if (ex) {
      if (lastWord >= 0 && out[lastWord].split(' | ').length < 4) {
        const cols = out[lastWord].split(' | ');
        if (cols.length === 2) cols.push('');                            /* 한자 칸 자리를 비워 두면 예문이 한자 칸으로 오인된다 — 비우지 않고 뒤에 붙인다 */
        out[lastWord] = cols.filter((c, k) => c || k < 2).concat([cleanMeaning(ex[1])]).join(' | ');
        counts.examples += 1;
      } else unmatched.push({ no, line, reason: '앞에 붙일 낱말이 없는 예문' });
      return;
    }
    line = line.replace(RE.numbered, '');
    let m;
    if ((m = line.match(RE.charLine))) { out.push(m[1] + ' | ' + m[2] + ' ' + m[3] + (m[4] ? ' | ' + m[4] : '')); counts.chars += 1; lastWord = -1; return; }
    if ((m = line.match(RE.wordParen))) { out.push(m[1] + ' | ' + cleanMeaning(m[3]) + ' | ' + m[2]); counts.words += 1; lastWord = out.length - 1; return; }
    if ((m = line.match(RE.hanjaWord))) { out.push(m[2] + ' | ' + cleanMeaning(m[3]) + ' | ' + m[1]); counts.words += 1; lastWord = out.length - 1; return; }
    if ((m = line.match(RE.wordHanja))) { out.push(m[1] + ' | ' + cleanMeaning(m[3]) + ' | ' + m[2]); counts.words += 1; lastWord = out.length - 1; return; }
    if ((m = line.match(RE.wordSep))) { out.push(m[1] + ' | ' + cleanMeaning(m[2])); counts.words += 1; lastWord = out.length - 1; return; }
    unmatched.push({ no, line: raw.trim(), reason: RE.hanjaOnly.test(line) ? '한자만 있고 낱말·뜻이 없음' : '형식을 모르겠어요 — 낱말·한자·뜻 순서를 확인' });
  });
  return { lines: out, unmatched, counts };
}

/* 낱말 줄에서 예문이 뜻 뒤 셋째 칸(한자 없는 고유어)에 붙는 경우를 정리한다 — 관리 웹 파서는 한자 없는 셋째 칸을 예문으로 본다 */
export function toWordsText(draft) { return draft.lines.join('\n') + '\n'; }

const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
  if (pos.length < 2) { console.error('사용법: node hanja/extract/draft.mjs <텍스트.txt> <출력 디렉터리> [--id <id>] [--title <제목>]'); process.exit(1); }
  const text = fs.readFileSync(pos[0], 'utf8');
  const d = draftFromText(text);
  const outDir = pos[1];
  fs.mkdirSync(path.join(outDir, 'review'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'words.txt'), toWordsText(d));
  fs.writeFileSync(path.join(outDir, 'review', 'unmatched.txt'), d.unmatched.map((u) => u.no + '행 [' + u.reason + '] ' + u.line).join('\n') + '\n');
  const meta = { id: opt('id') || '', title: opt('title') || '', source: path.basename(pos[0]), madeAt: new Date().toISOString(), counts: d.counts, unmatched: d.unmatched.length };
  fs.writeFileSync(path.join(outDir, '_meta.json'), JSON.stringify(meta, null, 1) + '\n');
  console.log('단원 ' + d.counts.units + ' · 낱말 ' + d.counts.words + ' · 한자 ' + d.counts.chars + ' · 예문 ' + d.counts.examples + ' → ' + path.join(outDir, 'words.txt'));
  console.log('못 뽑은 줄 ' + d.unmatched.length + ' → ' + path.join(outDir, 'review', 'unmatched.txt'));
  console.log('다음: words.txt 를 고친 뒤  node hanja/book-validate.mjs ' + path.join(outDir, 'words.txt') + ' --id <id> --title <제목>');
}
