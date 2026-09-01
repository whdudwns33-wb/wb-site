'use strict';
/* 지문 출처 실사 점검 — 운영 루틴용 (앱 코드 아님)
 *
 *   node reading/srccheck.mjs              전체 출처
 *   node reading/srccheck.mjs marine-heatwave price-wage    지문 몇 편만
 *   node reading/srccheck.mjs --json out.json               결과를 파일로
 *
 * linkcheck.mjs 와 무엇이 다른가:
 *   linkcheck 는 "주소가 살아 있나"만 본다 — 상태 코드.
 *   여기서는 "학생이 눌렀을 때 근거가 보이나"를 본다. 2026-09-01 점검에서
 *   상태 코드만으로는 못 잡는 두 종류가 무더기로 나왔기 때문이다.
 *     · 게시판 목록 페이지  — 200 이지만 그날의 목록만 뜬다
 *     · 첨부 전용 전재 페이지 — 200 이고 제목도 맞지만 본문이 없다.
 *       korea.kr/briefing/pressReleaseView.do 가 그랬다. 화면에는 제목과
 *       20MB hwp 내려받기 단추뿐이고, 본문 문장은 <meta>·JSON-LD 안에만
 *       잘린 채 들어 있어서 "제목 키워드 일치" 검사까지 통과해 버렸다.
 *
 * 그래서 본문 판정은 <head> 를 잘라 낸 뒤 <body> 안에서만 한다.
 *
 * 요청은 반드시 하나씩 보낸다. 정부 누리집에 동시 요청을 걸면 프록시가
 * 연결을 끊어 000 이 무더기로 뜨는데, 순차로 다시 받으면 전부 200 이다.
 * 느리지만(출처 하나에 2~3초) 거짓 경보가 없는 쪽이 훨씬 쓸모 있다.
 *
 * 종료 코드: 확실한 결함(bad)이 있으면 1, 없으면 0.
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = JSON.parse(fs.readFileSync(path.join(HERE, 'articles.json'), 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const argv = process.argv.slice(2);
let jsonOut = null;
const only = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--json') jsonOut = argv[++i] || 'srccheck.json';
  else only.push(argv[i]);
}

const selftest = only.includes('--selftest');
const items = [];
for (const a of DB.articles) {
  if (only.length && !selftest && !only.includes(a.id)) continue;
  (a.sources || []).forEach((s, i) => items.push({ id: a.id, n: i + 1, title: s.title, url: s.url }));
}
if (!items.length) {
  console.error(only.length ? `그런 지문이 없습니다: ${only.join(', ')}` : '출처가 없습니다.');
  process.exit(1);
}

/* ── 주소 모양만 보고 거를 수 있는 것들 ───────────────────────
   content.test.cjs 의 isIndexPage·isAttachmentOnly 와 같은 규칙이다.
   거기서는 커밋을 막고, 여기서는 실사 결과에 함께 적어 준다. */
function shapeVerdict(u) {
  let x; try { x = new URL(u); } catch { return '주소를 해석할 수 없습니다'; }
  const p = x.pathname.replace(/\/$/, '');
  if (/korea\.kr\/briefing\/pressReleaseView\.do/.test(u)) return '첨부 전용 전재 페이지';
  if (p === '' || /^\/(index|main)\.(do|jsp|html?)$/.test(p)) return '기관 첫 화면';
  if (/(List|list)\.do|listRenew|boardCnts\/list/.test(p + x.search)) return '게시판 목록';
  if (/[?&]menuId=\d+$/.test(x.search) && /index\.do/.test(p)) return '기관 첫 화면';
  if (/\/(press|news|notice|board|list)\.(do|jsp|html?|php|asp)$/i.test(p) && !x.search) return '게시판 목록';
  return null;
}

/* 한국어가 거의 없는 문서(노벨재단·유네스코 같은 영어 페이지)는 우리 제목의
   한국어 낱말로 찾으면 늘 0/N 이 나온다. 그럴 때는 주소의 슬러그를 검사 낱말로
   쓴다 — pansori-epic-chant-00070 → pansori·epic·chant, chemistry/2020/summary
   → chemistry·2020. 우리가 적어 둔 주소가 그 문서를 가리키는지 확인하는 데는
   이쪽이 오히려 정확하다. */
const SLUG_STOP = /^(www|com|org|net|go|kr|en|ko|html?|php|jsp|asp|do|index|main|view|list|prizes|summary|facts|RL|ich|unesco|nobelprize|https?)$/i;
function slugWords(u) {
  let x; try { x = new URL(u); } catch { return []; }
  return (x.pathname + ' ' + x.search)
    .split(/[^A-Za-z0-9]+/)
    .filter(w => w.length >= 3 && !SLUG_STOP.test(w) && !/^\d{5,}$/.test(w))
    .slice(0, 6);
}
const hangul = t => (t.match(/[\uac00-\ud7a3]/g) || []).length;

/* 200 을 주면서 내용 대신 봇 검사를 내보내는 곳이 있다 — 유네스코가 그렇다.
   지금까지는 「다른 문서일 수 있습니다」로 떠서 진짜 결함과 섞였다. */
const CAPTCHA = /(whether you are a human|automated spam|Just a moment|Checking your browser|자동\s*등록\s*방지|Enable JavaScript and cookies|cf-browser-verification|hcaptcha|recaptcha)/i;

/* --selftest : 망을 타지 않고 판정 규칙만 확인한다.
   실제로 걸렸던 주소들을 넣어 두었으니, 규칙을 손대면 여기부터 돌려 본다. */
if (selftest) {
  const CASES = [
    ['https://www.kma.go.kr/kma/news/press.jsp', '게시판 목록'],
    ['https://www.korea.kr/briefing/pressReleaseView.do?newsId=156773394', '첨부 전용 전재 페이지'],
    ['https://www.kostat.go.kr/', '기관 첫 화면'],
    ['https://www.mcee.go.kr/home/web/board/list.do?menuId=10598', '게시판 목록'],
    /* 아래는 통과해야 하는 실제 근거 문서들 */
    ['https://www.kma.go.kr/kma/news/press_01.jsp?mode=view&num=1194719', null],
    ['https://www.mcee.go.kr/home/web/board/read.do?menuId=10598&boardMasterId=939&boardId=1877470', null],
    ['https://www.moel.go.kr/news/enews/report/enewsView.do?news_seq=19744', null],
    ['https://nsp.nanet.go.kr/plan/subject/detail.do?nationalPlanControlNo=PLAN0000053154', null],
  ];
  let fail = 0;
  for (const [u, want] of CASES) {
    const got = shapeVerdict(u);
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? '  ' : '✗ '}${String(got ?? '통과').padEnd(14)} ${u}`);
    if (!ok) console.log(`     기대: ${want ?? '통과'}`);
  }
  /* 봇 검사 화면을 알아보나 — 유네스코가 실제로 이걸 내보냈다 */
  const CAP = [
    ['This question is for testing whether you are a human visitor and to prevent automated spam submission.', true],
    ['Just a moment... Checking your browser before accessing', true],
    ['국립국어원 표준국어대사전 본문입니다. 판소리는 소리꾼이', false],
  ];
  for (const [t, want] of CAP) {
    const got = CAPTCHA.test(t);
    if (got !== want) { fail++; console.log(`✗ 봇 검사 판정 어긋남 — ${t.slice(0, 40)}…`); }
    else console.log(`  ${want ? '봇 검사로 봄  ' : '본문으로 봄   '} ${t.slice(0, 46)}…`);
  }

  /* 외국어 문서용 주소 낱말 뽑기 */
  const SLUGS = [
    ['https://ich.unesco.org/en/RL/pansori-epic-chant-00070', ['pansori', 'epic', 'chant']],
    ['https://www.nobelprize.org/prizes/chemistry/2020/summary/', ['chemistry', '2020']],
    ['https://www.nobelprize.org/prizes/literature/2024/han/facts/', ['literature', '2024', 'han']],
  ];
  for (const [u, want] of SLUGS) {
    const got = slugWords(u);
    const ok = want.every(w => got.includes(w));
    if (!ok) { fail++; console.log(`✗ 주소 낱말 — ${u}\n     뽑힘: ${got.join('·')} / 기대: ${want.join('·')}`); }
    else console.log(`  주소 낱말 ${got.join('·')}`);
  }

  /* 현재 지문의 출처가 모양 규칙에 걸리지 않는지도 함께 본다 */
  const caught = items.filter(it => shapeVerdict(it.url));
  caught.forEach(it => console.log(`✗ 지금 쓰는 출처가 규칙에 걸립니다 — ${it.id}#${it.n} ${it.url}`));
  const total = CASES.length + CAP.length + SLUGS.length;
  console.log(`\n규칙 ${total}건 중 ${total - fail}건 통과 · 현재 출처 ${items.length}개 중 걸린 것 ${caught.length}개`);
  process.exit(fail || caught.length ? 1 : 0);
}

function curl(url, secs) {
  return new Promise(resolve => {
    execFile('curl', ['-sSL', '-m', String(secs), '-A', UA, '-w', '\n@@@%{http_code}', url],
      { timeout: (secs + 5) * 1000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        const s = stdout || '';
        const at = s.lastIndexOf('\n@@@');
        if (at < 0) return resolve({ code: '000', html: '', failed: true });
        resolve({ code: s.slice(at + 4).trim() || '000', html: s.slice(0, at), failed: false });
      });
  });
}

/* 끊긴 연결은 재시도한다 — 프록시가 이따금 터널을 닫는다 */
async function fetchWithRetry(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await curl(url, 50);
    if (!r.failed && r.code !== '000') return r;
    await new Promise(z => setTimeout(z, 2500 * (i + 1)));
  }
  return { code: '000', html: '', failed: true };
}

const strip = s => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');
const unent = s => s
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const textOf = s => unent(strip(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/* 본문만 본다 — <head> 안의 meta·JSON-LD 는 화면에 안 보이므로 근거가 아니다 */
function bodyText(html) {
  const i = html.search(/<body\b/i);
  return textOf(i >= 0 ? html.slice(i) : html);
}

/* 출처 제목에서 검사할 낱말을 뽑는다 — 기관명·형식어는 버린다 */
const STOP = /^(보도자료|보도|자료|참고|알림|공지|누리집|홈페이지|포털|통계|현황|발표|개요|안내|바로가기|상세)$/;
function keywords(title) {
  return String(title)
    .replace(/\([^)]*\)/g, ' ')
    .split(/[\s—·,\/|:;'"“”‘’「」『』\[\]<>]+/)
    .map(w => w.replace(/^[0-9.]+$/, '').trim())
    .filter(w => w.length >= 2 && !STOP.test(w))
    .slice(0, 8);
}

const ERRPAGE = /(페이지를 찾을 수 없|파일을 찾을수없|요청하신 페이지|Not Found|错误|존재하지 않는 게시물|삭제된 게시물)/i;

const rows = [];
let bad = 0, warn = 0;

console.log(`출처 ${items.length}개를 하나씩 받아 봅니다 — 대략 ${Math.ceil(items.length * 2.5 / 60)}분\n`);

for (const it of items) {
  const shape = shapeVerdict(it.url);
  const r = await fetchWithRetry(it.url);
  const n = parseInt(r.code, 10) || 0;
  const txt = r.html ? bodyText(r.html) : '';
  /* 본문에 한국어가 거의 없으면 제목 낱말 대신 주소 슬러그로 맞춰 본다 */
  const foreign = txt.length > 300 && hangul(txt) < txt.length * 0.02;
  const kws = foreign ? slugWords(it.url) : keywords(it.title);
  const low = txt.toLowerCase();
  const hit = kws.filter(k => foreign ? low.includes(k.toLowerCase()) : txt.includes(k));
  const ratio = kws.length ? hit.length / kws.length : 1;

  /* PDF 는 본문을 글자로 읽을 수 없다 — 압축된 이진 파일이라 제목 낱말이 하나도 안 잡힌다.
     예전 점검에서 학회지 논문 PDF 가 매번 「다른 문서일 수 있습니다」로 떠서, 진짜 결함과
     섞여 신호가 흐려졌다. 파일이 진짜 PDF 이고 알맹이가 있을 만큼 크면 통과로 본다. */
  const isPdf = /^%PDF-/.test(r.html.slice(0, 8)) || (/\.pdf($|\?)/i.test(it.url) && r.html.length > 50000);

  let verdict, note;
  if (shape) { verdict = 'bad'; note = shape; }
  else if (r.failed || n === 0) { verdict = 'warn'; note = '응답 없음 — 사람이 직접 열어 보세요'; }
  else if ([400, 404, 410].includes(n)) { verdict = 'bad'; note = '없는 페이지'; }
  else if (isPdf) {
    const kb = Math.round(r.html.length / 1024);
    if (kb < 20) { verdict = 'warn'; note = `PDF 인데 ${kb}KB 뿐 — 빈 파일일 수 있습니다`; }
    else { verdict = 'ok'; note = `PDF ${kb}KB — 내용은 사람이 확인 (글자 추출 불가)`; }
  }
  else if ([403, 418, 429].includes(n)) { verdict = 'warn'; note = '봇 차단 — 사람이 열면 정상일 수 있습니다'; }
  else if (CAPTCHA.test(txt.slice(0, 4000))) { verdict = 'warn'; note = '봇 차단(사람 확인 화면) — 브라우저로 열어 보세요'; }
  else if (n >= 500) { verdict = 'warn'; note = '서버 오류'; }
  else if (ERRPAGE.test(txt.slice(0, 3000))) { verdict = 'bad'; note = '오류 안내 페이지'; }
  else if (txt.length < 400) { verdict = 'warn'; note = `본문 ${txt.length}자 — 첨부만 있거나 자바스크립트로 그리는 페이지` };
  if (!verdict) {
    const what = foreign ? '주소 낱말' : '제목 낱말';
    const tail = foreign ? ' (외국어 문서 — 주소로 맞춰 봄)' : '';
    if (ratio >= 0.4) { verdict = 'ok'; note = `${what} ${hit.length}/${kws.length} 본문 확인${tail}`; }
    else { verdict = 'warn'; note = `${what} ${hit.length}/${kws.length}만 본문에 있음 — 다른 문서일 수 있습니다${tail}`; }
  }

  if (verdict === 'bad') bad++; else if (verdict === 'warn') warn++;
  const mark = verdict === 'ok' ? '  ' : verdict === 'bad' ? '✗ ' : '⚠ ';
  console.log(`${mark}${it.id}#${it.n}  ${r.code}  ${note}`);
  if (verdict !== 'ok') console.log(`     ${it.title}\n     ${it.url}`);

  rows.push({ ...it, code: r.code, verdict, note, bodyLen: txt.length, foreign, kws, hit });
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`출처 ${items.length}개 · 정상 ${items.length - bad - warn} · 결함 ${bad} · 확인 필요 ${warn}`);
if (warn) console.log('⚠ 는 봇 차단이나 순간 오류일 수 있습니다 — 브라우저로 한 번 열어 보고 판단하세요.');
if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 2)); console.log(`결과 저장: ${jsonOut}`); }
process.exit(bad ? 1 : 0);
