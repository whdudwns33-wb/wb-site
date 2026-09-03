/* 배포본이 학생 브라우저의 캐시를 실제로 깨는가 (node reading-server/dist-cache.test.mjs)
 *
 * 2026-09-02, 낱말을 135 → 207개로 늘려 배포했는데 이미 앱을 깔아 둔 학생 화면은
 * 그대로였다. 두 앱 모두 서비스 워커가 껍데기(index.html·words.js…)를 캐시 우선으로
 * 물고 있는데, sw.js 안의 VERSION 문자열을 손으로 올리는 것을 잊었기 때문이다.
 * 잊어도 티가 안 나는 종류의 실수라 — 배포는 성공하고 파일도 새것인데 학생만 옛것을
 * 본다 — 사람이 기억하는 대신 빌드가 내용에서 뽑게 했다. 그 배선을 여기서 지킨다.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const build = () => execFileSync(process.execPath, [path.join(HERE, 'build-dist.mjs')], { encoding: 'utf8' });
const swVer = (p) => (fs.readFileSync(p, 'utf8').match(/const VERSION = '([^']*)'/) || [])[1];
const R_SW = path.join(DIST, 'sw.js');
const V_SW = path.join(DIST, 'vocab', 'sw.js');
const N_SW = path.join(DIST, 'naesin', 'sw.js');

build();
const before = { r: swVer(R_SW), v: swVer(V_SW), n: swVer(N_SW) };

t('배포본의 캐시 이름이 내용에서 나온다 — 손으로 적은 값이 아니다', () => {
  assert.ok(/^wbr-shell-[0-9a-f]{10}$/.test(before.r), '진로독서 sw.js: ' + before.r);
  assert.ok(/^wbv-shell-[0-9a-f]{10}$/.test(before.v), '워드브레인 sw.js: ' + before.v);
  assert.ok(/^wbn-shell-[0-9a-f]{10}$/.test(before.n), '내신브레인 sw.js: ' + before.n);
});

t('두 번 빌드해도 같다 — 안 바뀐 배포에서 캐시가 헛되이 날아가지 않는다', () => {
  build();
  assert.strictEqual(swVer(R_SW), before.r);
  assert.strictEqual(swVer(V_SW), before.v);
  assert.strictEqual(swVer(N_SW), before.n);
});

t('껍데기 파일이 바뀌면 캐시 이름이 바뀐다 — 학생이 새 코드를 받는다', () => {
  /* 원본을 잠깐 건드렸다 되돌린다. 실패해도 원본이 남지 않도록 finally 로 복구한다 */
  const cases = [
    { file: path.join(HERE, '..', 'vocab', 'words.js'), sw: V_SW, was: before.v, what: '워드브레인 낱말' },
    { file: path.join(HERE, '..', 'reading', 'index.html'), sw: R_SW, was: before.r, what: '진로독서 앱' },
    /* 내신은 아이콘으로 찌른다 — 코드 파일은 다른 작업자가 동시에 고치고 있을 수 있어 건드리지 않는다 */
    { file: path.join(HERE, '..', 'naesin', 'icon.svg'), sw: N_SW, was: before.n, what: '내신브레인 앱' },
  ];
  for (const c of cases) {
    const orig = fs.readFileSync(c.file);
    try {
      fs.writeFileSync(c.file, Buffer.concat([orig, Buffer.from('\n/* cache probe */\n')]));
      build();
      assert.notStrictEqual(swVer(c.sw), c.was, `${c.what}을 고쳤는데 캐시 이름이 그대로다 — 학생은 옛 화면을 본다`);
    } finally {
      fs.writeFileSync(c.file, orig);
    }
  }
  build();
  assert.strictEqual(swVer(R_SW), before.r, '되돌렸는데 값이 안 돌아왔다');
  assert.strictEqual(swVer(V_SW), before.v, '되돌렸는데 값이 안 돌아왔다');
  assert.strictEqual(swVer(N_SW), before.n, '되돌렸는데 값이 안 돌아왔다');
});

t('지문 데이터 버전이 articles.json 과 version.json 에서 같다', () => {
  /* 앱은 version.json 을 캐시 없이 받아 ?v= 로 붙여 분할본을 받는다.
     articles.json 을 고치고 build-split 을 안 돌리면 여기서 갈린다. */
  const a = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'reading', 'articles.json'), 'utf8')).version;
  const v = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'reading', 'version.json'), 'utf8')).v;
  assert.strictEqual(v, a, 'articles.json 을 고쳤으면 node reading/build-split.mjs 를 돌리세요');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DIST, 'version.json'), 'utf8')).v, a);
});

t('미러용 원본 sw.js 는 손으로 붙인 번호를 그대로 지닌다', () => {
  /* 미러(github.io)에는 빌드 단계가 없어 원본 sw.js 가 그대로 올라간다.
     빌드가 원본을 고쳐 버리면 미러의 캐시 이름이 배포마다 요동친다. */
  ['reading', 'vocab'].forEach((app) => {
    const v = swVer(path.join(HERE, '..', app, 'sw.js'));
    assert.ok(/^wb[rv]-shell-v\d+$/.test(v), `${app}/sw.js 의 VERSION 이 이상합니다: ${v}`);
  });
  /* 내신은 미러가 없어 원본에 해시 대신 'dev' 표식을 둔다 — 빌드가 원본을 고쳐 버렸으면 여기서 드러난다 */
  const n = swVer(path.join(HERE, '..', 'naesin', 'sw.js'));
  assert.ok(/^wbn-shell-(dev|v\d+)$/.test(n), `naesin/sw.js 의 VERSION 이 이상합니다: ${n}`);
});

/* _headers 규칙 — 배포본에 실리는 것은 reading/_headers 하나다(naesin/·vocab/ 의 것은 dist 에 없다).
   세 앱과 관리 웹의 화면·코드가 no-store 인지, noindex 가 전 경로에 붙는지, 캐시를 무력화하는
   /* Cache-Control 이 없는지를 파일 그대로 읽어 확인한다. */
function parseHeaders(text) {
  const rules = {}; let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) { cur = raw.trim(); rules[cur] = rules[cur] || {}; continue; }
    const m = raw.trim().match(/^([^:]+):\s*(.*)$/);
    if (m && cur) rules[cur][m[1].trim()] = m[2].trim();
  }
  return rules;
}
t('배포본 _headers — /naesin/*·/vocab/*·/admin/* 은 no-store, 전 경로 noindex, /* 에는 Cache-Control 없음', () => {
  const distText = fs.readFileSync(path.join(DIST, '_headers'), 'utf8');
  assert.strictEqual(distText, fs.readFileSync(path.join(HERE, '..', 'reading', '_headers'), 'utf8'), 'dist/_headers 는 reading/_headers 그대로여야 한다');
  const rules = parseHeaders(distText);
  for (const p of ['/naesin/*', '/vocab/*', '/admin/*']) {
    assert.ok(rules[p], p + ' 규칙이 없다 — 그 앱의 옛 화면이 브라우저 캐시에 굳는다');
    assert.strictEqual(rules[p]['Cache-Control'], 'no-store', p);
  }
  assert.ok(/noindex/.test(rules['/*']['X-Robots-Tag'] || ''), '전 경로 noindex 가 빠졌다');
  assert.ok(/nosniff/.test(rules['/*']['X-Content-Type-Options'] || ''));
  assert.strictEqual(rules['/*']['Cache-Control'], undefined, '/* 에 Cache-Control 을 두면 분할본의 max-age 와 합쳐져 캐시가 통째로 무력화된다');
  assert.strictEqual(rules['/articles-L1.json']['Cache-Control'], 'public, max-age=604800', '분할본 캐시 규칙은 그대로');
  /* 원본 자리의 두 파일은 안내 주석만 남는다 — 규칙이 두 곳에 있으면 한 곳만 고치는 사고가 난다 */
  for (const app of ['naesin', 'vocab']) {
    const own = fs.readFileSync(path.join(HERE, '..', app, '_headers'), 'utf8');
    assert.ok(own.split(/\r?\n/).every((l) => !l.trim() || l.trim().startsWith('#')), app + '/_headers 에 규칙이 남아 있다 — reading/_headers 로 옮기세요');
    assert.ok(!fs.existsSync(path.join(DIST, app, '_headers')), app + '/_headers 가 dist 에 실렸다');
  }
});

/* 관리 화면은 서비스 워커가 없다 — 빌드가 dist/admin/ 으로 복사하지 않으면 그 화면만
   운영에서 404 다. 로컬 서버는 public/ 을 직접 서빙해 티가 안 나므로 여기서 지킨다. */
t('관리 화면들이 dist/admin/ 에 실린다 — 하나 빠지면 그 화면만 운영에서 404', () => {
  const want = ['index.html', 'vocab-review.html', 'metrics.html', 'naesin-admin.html', 'naesin-studio.html', 'naesin-live.html'];
  for (const f of want) {
    const fp = path.join(DIST, 'admin', f);
    assert.ok(fs.existsSync(fp), 'dist/admin/' + f + ' 가 없다 — build-dist.mjs 에 복사를 추가하세요');
    assert.ok(fs.statSync(fp).size > 2000, 'dist/admin/' + f + ' 가 비었다');
  }
  /* 제작·수업 화면은 원천과 학생 실시간 상태를 다루므로 색인·추적을 막는 메타가 반드시 있어야 한다 */
  for (const f of ['naesin-studio.html', 'naesin-live.html']) {
    const txt = fs.readFileSync(path.join(DIST, 'admin', f), 'utf8');
    assert.ok(/noindex/.test(txt), f + ' 에 noindex 가 없다');
    assert.ok(/no-referrer/.test(txt), f + ' 에 referrer 정책이 없다');
  }
  /* 수업 화면은 학생 앱과 같은 문항 생성기를 불러 쓴다 — 그 경로가 배포본에 있어야 한다 */
  const live = fs.readFileSync(path.join(DIST, 'admin', 'naesin-live.html'), 'utf8');
  const genSrc = (live.match(/src="([^"]*gen\.js)"/) || [])[1];
  assert.ok(genSrc, '수업 화면이 gen.js 를 불러오지 않는다 — 투사 문제를 만들 수 없다');
  assert.ok(fs.existsSync(path.join(DIST, genSrc.replace(/^\//, ''))), '배포본에 ' + genSrc + ' 이 없다');
});

console.log(`\nOK — ${passed}개 통과. 배포하면 학생 화면도 함께 바뀝니다.`);
