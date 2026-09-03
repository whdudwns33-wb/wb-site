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
const K_SW = path.join(DIST, 'naesin-ko', 'sw.js');

build();
const before = { r: swVer(R_SW), v: swVer(V_SW), n: swVer(N_SW), k: swVer(K_SW) };

t('배포본의 캐시 이름이 내용에서 나온다 — 손으로 적은 값이 아니다', () => {
  assert.ok(/^wbr-shell-[0-9a-f]{10}$/.test(before.r), '진로독서 sw.js: ' + before.r);
  assert.ok(/^wbv-shell-[0-9a-f]{10}$/.test(before.v), '워드브레인 sw.js: ' + before.v);
  assert.ok(/^wbn-shell-[0-9a-f]{10}$/.test(before.n), '내신브레인 sw.js: ' + before.n);
  assert.ok(/^wbk-shell-[0-9a-f]{10}$/.test(before.k), '국어브레인 sw.js: ' + before.k);
});

t('두 번 빌드해도 같다 — 안 바뀐 배포에서 캐시가 헛되이 날아가지 않는다', () => {
  build();
  assert.strictEqual(swVer(R_SW), before.r);
  assert.strictEqual(swVer(V_SW), before.v);
  assert.strictEqual(swVer(N_SW), before.n);
  assert.strictEqual(swVer(K_SW), before.k);
});

t('껍데기 파일이 바뀌면 캐시 이름이 바뀐다 — 학생이 새 코드를 받는다', () => {
  /* 원본을 잠깐 건드렸다 되돌린다. 실패해도 원본이 남지 않도록 finally 로 복구한다 */
  const cases = [
    { file: path.join(HERE, '..', 'vocab', 'words.js'), sw: V_SW, was: before.v, what: '워드브레인 낱말' },
    { file: path.join(HERE, '..', 'reading', 'index.html'), sw: R_SW, was: before.r, what: '진로독서 앱' },
    { file: path.join(HERE, '..', 'naesin', 'engine.js'), sw: N_SW, was: before.n, what: '내신브레인 엔진' },
    /* 국어는 개념어 사전도 셸에 실린다 — 사전을 고치면 학생이 새 사전을 받아야 한다 */
    { file: path.join(HERE, '..', 'naesin-ko', 'concepts.json'), sw: K_SW, was: before.k, what: '국어브레인 개념어 사전' },
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
  assert.strictEqual(swVer(K_SW), before.k, '되돌렸는데 값이 안 돌아왔다');
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
});

console.log(`\nOK — ${passed}개 통과. 배포하면 학생 화면도 함께 바뀝니다.`);
