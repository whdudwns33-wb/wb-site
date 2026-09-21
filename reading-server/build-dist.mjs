'use strict';
/* dist/ 조립: 학생 앱(reading/) + 관리 웹(public/admin.html → /admin/) */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(ROOT, '..', 'reading');
const DIST = path.join(ROOT, 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'admin'), { recursive: true });

/* textbook.json(코칭 원문)은 더 이상 싣지 않는다 — 공개 저장소·정적 자산에서 빼고
   KV(textbook-src)로 옮겼다. 관리 웹의 「교재 코칭 원문」 카드에서 업로드한다. */
const APP_FILES = ['index.html', 'articles.json', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'review.html', 'parent.html',
  /* 학년대별 분할본 — 학생 앱은 자기 학년대 하나만 받는다 (node reading/build-split.mjs 산출물) */
  'articles-L1.json', 'articles-L2.json', 'articles-L3.json', 'articles-L4.json', 'hanja.json', 'version.json',
  /* 보안 헤더(CSP·X-Frame-Options·Referrer-Policy 등)와 캐시 규칙.
     지금까지 dist에 넣지 않아 배포본에는 이 헤더가 하나도 붙지 않았다. */
  '_headers'];
for (const f of APP_FILES) fs.copyFileSync(path.join(APP, f), path.join(DIST, f));
fs.copyFileSync(path.join(ROOT, 'public', 'admin.html'), path.join(DIST, 'admin', 'index.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'vocab-review.html'), path.join(DIST, 'admin', 'vocab-review.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'metrics.html'), path.join(DIST, 'admin', 'metrics.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'naesin-admin.html'), path.join(DIST, 'admin', 'naesin-admin.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'naesin-studio.html'), path.join(DIST, 'admin', 'naesin-studio.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'naesin-live.html'), path.join(DIST, 'admin', 'naesin-live.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'haru-admin.html'), path.join(DIST, 'admin', 'haru-admin.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'naesin-ko-admin.html'), path.join(DIST, 'admin', 'naesin-ko-admin.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'hanja-admin.html'), path.join(DIST, 'admin', 'hanja-admin.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'hanja-print.html'), path.join(DIST, 'admin', 'hanja-print.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'chunk-admin.html'), path.join(DIST, 'admin', 'chunk-admin.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'letter-admin.html'), path.join(DIST, 'admin', 'letter-admin.html'));

/* 어휘 나이 진단 (vocab-age/) — 로그인 없이 열리는 공개 페이지.
   실리는 것은 index.html · age.js · words.json 셋뿐이다(낱말과 뜻만). */
const AGE = path.join(ROOT, '..', 'vocab-age');
fs.mkdirSync(path.join(DIST, 'vocab-age'), { recursive: true });
for (const f of ['index.html', 'age.js', 'words.json'])
  fs.copyFileSync(path.join(AGE, f), path.join(DIST, 'vocab-age', f));

/* 워드브레인 (vocab/) — 같은 오리진 /vocab/ 에서 서빙해야 진로독서와 localStorage·토큰이 공유된다 */
const VOCAB = path.join(ROOT, '..', 'vocab');
fs.mkdirSync(path.join(DIST, 'vocab'), { recursive: true });
const VOCAB_FILES = ['index.html', 'words.js', 'bridge.js', 'quiz.js', 'srs.js', 'trace.js', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
for (const f of VOCAB_FILES) fs.copyFileSync(path.join(VOCAB, f), path.join(DIST, 'vocab', f));
/* 공통 음성 모듈 — 원본은 shared/ 하나, 두 앱에 같은 파일을 배급한다 */
const SHARED = path.join(ROOT, '..', 'shared', 'voice.js');
fs.copyFileSync(SHARED, path.join(DIST, 'voice.js'));
fs.copyFileSync(SHARED, path.join(DIST, 'vocab', 'voice.js'));
/* QR 인코더 — 관리 웹이 학생 연동 QR을 그린다. CSP가 'self'만 허용해 CDN을 못 쓴다. */
fs.copyFileSync(path.join(ROOT, '..', 'shared', 'qr.js'), path.join(DIST, 'admin', 'qr.js'));

/* 내신브레인 (naesin/) — 같은 오리진 /naesin/ 에서 서빙해야 학생 코드·API가 공유된다.
   팩 콘텐츠(구매 자료)는 dist에 싣지 않는다 — KV에만 산다(기획서 §9.3).
   pack-sample.json 은 실제 교재와 무관한 자체 창작 체험 팩이라 실어도 된다. */
const NAESIN = path.join(ROOT, '..', 'naesin');
fs.mkdirSync(path.join(DIST, 'naesin'), { recursive: true });
const NAESIN_FILES = ['index.html', 'engine.js', 'grade.js', 'gen.js', 'pack-sample.json', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
for (const f of NAESIN_FILES) fs.copyFileSync(path.join(NAESIN, f), path.join(DIST, 'naesin', f));
fs.copyFileSync(SHARED, path.join(DIST, 'naesin', 'voice.js'));

/* 국어브레인 (naesin-ko/) — 같은 오리진 /naesin-ko/ 에서 서빙해야 학생 토큰·API가 공유된다.
   팩 콘텐츠는 여기 없다(KV 전용). concepts.json·grammar-examples.json은 자체 창작이라
   정적 자산으로 나간다 — naesin-ko/concepts.test.cjs가 그 전제를 지킨다(국어 기획서 §9.3). */
const NAESINKO = path.join(ROOT, '..', 'naesin-ko');
fs.mkdirSync(path.join(DIST, 'naesin-ko'), { recursive: true });
const NAESINKO_FILES = ['index.html', 'engine.js', 'grade.js', 'gen.js', 'pack-check.js',
  'readiness.js', 'concepts.json', 'pack-sample.json', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
for (const f of NAESINKO_FILES) fs.copyFileSync(path.join(NAESINKO, f), path.join(DIST, 'naesin-ko', f));
fs.copyFileSync(SHARED, path.join(DIST, 'naesin-ko', 'voice.js'));
/* 하루브레인 (haru/) — 같은 오리진 /haru/ 에서 서빙해야 학생 코드·API가 공유된다.
   실리는 것은 앱 껍데기 + 순수 로직 모듈 + atoms.json(원자 목록, 문항 0)뿐이다. 팩·대응표·플랜·시험지는 dist 에 없다(설계안 §5-0). */
const HARU = path.join(ROOT, '..', 'haru');
fs.mkdirSync(path.join(DIST, 'haru'), { recursive: true });
const HARU_FILES = ['index.html', 'parent.html', 'strings.js', 'plan.js', 'mastery.js', 'srs.js', 'cause.js', 'probe.js', 'atoms.json', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
for (const f of HARU_FILES) fs.copyFileSync(path.join(HARU, f), path.join(DIST, 'haru', f));

/* 한자브레인 (hanja/) — 같은 오리진 /hanja/ 에서 서빙해야 학생 토큰·API가 공유된다.
   단어장(문제집 낱말)은 dist 에 싣지 않는다 — KV(hanja:book:*)에만 산다. book-sample.json 은 자체 창작 체험 단어장이라 실어도 된다. */
const HANJA = path.join(ROOT, '..', 'hanja');
fs.mkdirSync(path.join(DIST, 'hanja'), { recursive: true });
const HANJA_FILES = ['index.html', 'srs.js', 'quiz.js', 'trace.js', 'book-check.js', 'bridge.js', 'book-sample.json', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
for (const f of HANJA_FILES) fs.copyFileSync(path.join(HANJA, f), path.join(DIST, 'hanja', f));
fs.copyFileSync(SHARED, path.join(DIST, 'hanja', 'voice.js'));
/* 청크브레인 (chunk/) — 의미단위 끊어읽기. 같은 오리진 /chunk/ 에서 서빙해야 학생 토큰이 공유된다.
   지문(passages.js)·카드(lessons.js)는 자체 창작이라 정적 자산으로 나간다 — chunk/content.test.cjs 가 그 전제를 지킨다.
   print.html 은 브라우저 인쇄로 PDF 교재를 만드는 화면이라 셸에 함께 싣는다. */
const CHUNK = path.join(ROOT, '..', 'chunk');
fs.mkdirSync(path.join(DIST, 'chunk'), { recursive: true });
const CHUNK_FILES = ['index.html', 'print.html', 'rules.js', 'sched.js', 'lessons.js', 'passages.js', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
for (const f of CHUNK_FILES) fs.copyFileSync(path.join(CHUNK, f), path.join(DIST, 'chunk', f));
fs.copyFileSync(SHARED, path.join(DIST, 'chunk', 'voice.js'));
/* 브레인레터 (letter/) — 같은 오리진 /letter/ 에서 서빙해야 학생 토큰·가족 링크·API 가 공유된다.
   호 본문은 KV 에만 있다. issue-sample.json 은 자체 창작 체험 호라 실어도 된다(라이선스 콘텐츠 0).
   관리 웹의 편집기 미리보기가 학생 앱과 같은 렌더러(letter.js)를 쓴다 — 원본은 letter/letter.js 하나. */
const LETTER = path.join(ROOT, '..', 'letter');
fs.mkdirSync(path.join(DIST, 'letter'), { recursive: true });
const LETTER_FILES = ['index.html', 'letter.js', 'shapes.js', 'drills.js', 'issue-sample.json', 'calendar.json', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
for (const f of LETTER_FILES) fs.copyFileSync(path.join(LETTER, f), path.join(DIST, 'letter', f));
/* 파일럿 호 — 있으면 싣는다. 편집실이 만든 이번 주 호(자체 창작)를 링크만으로 연다. 없으면 앱이 샘플 호로 넘어간다 */
if (fs.existsSync(path.join(LETTER, 'issue-pilot.json'))) fs.copyFileSync(path.join(LETTER, 'issue-pilot.json'), path.join(DIST, 'letter', 'issue-pilot.json'));
/* 읽어 주기·한자 따라쓰기 — 원본은 shared/voice.js·vocab/trace.js 하나씩. 다른 앱과 같은 파일을 letter/ 에도 배급한다(SW 껍데기가 ./ 상대 경로로 캐시한다) */
fs.copyFileSync(SHARED, path.join(DIST, 'letter', 'voice.js'));
fs.copyFileSync(path.join(ROOT, '..', 'vocab', 'trace.js'), path.join(DIST, 'letter', 'trace.js'));
/* 배포본 삽화(letter/img/*.svg) — 자체 제작 벡터 그림만. 올린 사진은 KV 에서 /api/letter/img/<id> 로 나간다 */
fs.mkdirSync(path.join(DIST, 'letter', 'img'), { recursive: true });
for (const f of fs.readdirSync(path.join(LETTER, 'img')).filter((x) => /\.svg$/.test(x))) fs.copyFileSync(path.join(LETTER, 'img', f), path.join(DIST, 'letter', 'img', f));
/* 글꼴(letter/fonts/) — Noto Sans/Serif KR 조각(OFL, letter/fetch-fonts.mjs 가 받는다). fonts.css 가 가리키는 판 디렉터리째 복사한다 */
const FONTS = path.join(LETTER, 'fonts');
fs.mkdirSync(path.join(DIST, 'letter', 'fonts'), { recursive: true });
for (const f of ['fonts.css', 'OFL.txt']) fs.copyFileSync(path.join(FONTS, f), path.join(DIST, 'letter', 'fonts', f));
for (const d of fs.readdirSync(FONTS).filter((x) => fs.statSync(path.join(FONTS, x)).isDirectory())) {
  fs.mkdirSync(path.join(DIST, 'letter', 'fonts', d), { recursive: true });
  for (const f of fs.readdirSync(path.join(FONTS, d)).filter((x) => /\.woff2$/.test(x))) fs.copyFileSync(path.join(FONTS, d, f), path.join(DIST, 'letter', 'fonts', d, f));
}
fs.copyFileSync(path.join(LETTER, 'letter.js'), path.join(DIST, 'admin', 'letter.js'));
fs.copyFileSync(path.join(LETTER, 'shapes.js'), path.join(DIST, 'admin', 'shapes.js'));
fs.copyFileSync(path.join(LETTER, 'drills.js'), path.join(DIST, 'admin', 'drills.js'));

/* ── 서비스 워커 캐시 이름을 내용에서 뽑는다 ──
   두 앱 모두 껍데기(index.html·words.js…)를 캐시 우선으로 물고 있다. 그래서
   sw.js 안의 VERSION 문자열이 그대로면, 이미 앱을 깔아 둔 학생은 새 코드를
   영영 못 받는다. 2026-09-02 에 실제로 그랬다 — 낱말을 135개에서 207개로
   늘려 배포했는데 기존 학생 화면은 그대로였다.

   손으로 올리는 것을 잊지 않기를 바라는 대신, 껍데기 파일 내용의 해시를 그대로
   VERSION 으로 박는다. 파일이 한 글자라도 바뀌면 캐시 이름이 달라지고,
   안 바뀌면 그대로다. 잊을 수가 없다. */
function stampSW(swPath, shellPaths, prefix) {
  const src = fs.readFileSync(swPath, 'utf8');
  const h = crypto.createHash('sha256');
  for (const f of shellPaths.slice().sort()) h.update(fs.readFileSync(f));
  h.update(src);                                   /* sw.js 자신도 포함 */
  const tag = prefix + '-' + h.digest('hex').slice(0, 10);
  const out = src.replace(/const VERSION = '[^']*';/, `const VERSION = '${tag}';`);
  if (out === src) throw new Error(`${swPath}: VERSION 을 못 바꿨습니다 — sw.js 의 선언 형태가 바뀌었나 봅니다`);
  fs.writeFileSync(swPath, out);
  return tag;
}
const rTag = stampSW(path.join(DIST, 'sw.js'),
  ['index.html', 'voice.js', 'manifest.webmanifest', 'icon.svg'].map(f => path.join(DIST, f)), 'wbr-shell');
const vTag = stampSW(path.join(DIST, 'vocab', 'sw.js'),
  ['index.html', 'voice.js', 'words.js', 'bridge.js', 'quiz.js', 'srs.js', 'trace.js', 'manifest.webmanifest', 'icon.svg']
    .map(f => path.join(DIST, 'vocab', f)), 'wbv-shell');
const nTag = stampSW(path.join(DIST, 'naesin', 'sw.js'),
  ['index.html', 'voice.js', 'engine.js', 'grade.js', 'gen.js', 'pack-sample.json', 'manifest.webmanifest', 'icon.svg']
    .map(f => path.join(DIST, 'naesin', f)), 'wbn-shell');
const kTag = stampSW(path.join(DIST, 'naesin-ko', 'sw.js'),
  ['index.html', 'voice.js', 'engine.js', 'grade.js', 'gen.js', 'pack-check.js', 'readiness.js',
    'concepts.json', 'pack-sample.json', 'manifest.webmanifest', 'icon.svg']
    .map(f => path.join(DIST, 'naesin-ko', f)), 'wbk-shell');

const cTag = stampSW(path.join(DIST, 'chunk', 'sw.js'),
  ['index.html', 'print.html', 'voice.js', 'rules.js', 'sched.js', 'lessons.js', 'passages.js', 'manifest.webmanifest', 'icon.svg']
    .map(f => path.join(DIST, 'chunk', f)), 'wbc-shell');

const hTag = stampSW(path.join(DIST, 'haru', 'sw.js'),
  ['index.html', 'strings.js', 'plan.js', 'mastery.js', 'srs.js', 'cause.js', 'probe.js', 'manifest.webmanifest', 'icon.svg']
    .map(f => path.join(DIST, 'haru', f)), 'wbh-shell');
const jTag = stampSW(path.join(DIST, 'hanja', 'sw.js'),
  ['index.html', 'voice.js', 'srs.js', 'quiz.js', 'trace.js', 'book-check.js', 'bridge.js', 'book-sample.json', 'manifest.webmanifest', 'icon.svg']
    .map(f => path.join(DIST, 'hanja', f)), 'wbhj-shell');
const lTag = stampSW(path.join(DIST, 'letter', 'sw.js'),
  ['index.html', 'letter.js', 'shapes.js', 'drills.js', 'voice.js', 'trace.js', 'manifest.webmanifest', 'icon.svg'].map(f => path.join(DIST, 'letter', f)), 'wbl-shell');

/* 조립한 것이 실제로 열리는지 확인한다.
   여기 목록에 새 파일을 안 적으면 배포본에서 404가 나고, 그 스크립트를 쓰는 화면이
   통째로 죽는다 — 그런데 빌드는 성공한다. 조용히 깨지는 쪽이라 빌드가 직접 막는다. */
function verifyRefs(htmlPath) {
  const dir = path.dirname(htmlPath);
  const html = fs.readFileSync(htmlPath, 'utf8');
  const refs = [];
  const add = (re) => { let m; while ((m = re.exec(html))) refs.push(m[1]); };
  add(/<script[^>]+src="([^"]+)"/g);
  add(/<link[^>]+href="([^"]+)"/g);
  const missing = refs
    .filter((r) => !/^(https?:)?\/\//.test(r) && !r.startsWith('#') && !r.startsWith('data:') && !r.startsWith('/'))
    .filter((r) => !fs.existsSync(path.join(dir, r.split('?')[0])));
  return missing.map((m) => path.relative(DIST, path.join(dir, m)));
}

const broken = [];
for (const f of ['index.html', 'vocab/index.html', 'vocab-age/index.html', 'admin/index.html',
  'admin/metrics.html', 'admin/vocab-review.html', 'review.html', 'parent.html',
  'naesin/index.html', 'haru/index.html', 'haru/parent.html', 'admin/haru-admin.html', 'admin/naesin-admin.html',
  'hanja/index.html', 'admin/hanja-admin.html', 'admin/hanja-print.html',
  'chunk/index.html', 'chunk/print.html', 'admin/chunk-admin.html',
  'letter/index.html', 'admin/letter-admin.html']) {
  const full = path.join(DIST, f);
  if (fs.existsSync(full)) for (const m of verifyRefs(full)) broken.push(f + ' → ' + m);
}
if (broken.length) {
  console.error('dist/ 에 없는 파일을 화면이 부르고 있다:\n  ' + broken.join('\n  '));
  console.error('build-dist.mjs 의 복사 목록에 빠진 파일이 있는지 보라.');
  process.exit(1);
}

console.log('dist/ 조립 완료:', fs.readdirSync(DIST).join(', '));
console.log('서비스 워커 캐시 이름:', rTag, '·', vTag, '·', nTag, '·', kTag, '·', hTag, '·', cTag, '·', lTag, '·', jTag);
