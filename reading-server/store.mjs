'use strict';
/* WB 진로독서 서버 저장소 — 파일 기반 JSON (파일럿).
   프로덕션 이관 지점: 이 모듈만 Cloudflare KV/D1 또는 PostgreSQL로 교체. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* DATA_DIR 로 저장 위치를 옮길 수 있다 — 서버 머리말이 알리는 값이다.
   전에는 이 값을 읽지 않아, 다른 곳을 가리켜 놓고 시험해도 조용히 기본 자리에 쌓였다. */
const DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const FILE = path.join(DIR, 'db.json');
const BDIR = path.join(DIR, 'backups');
const BACKUP_KEEP = 10;

const empty = () => ({ students: {}, states: {}, tokens: {}, pending: {}, levelLog: [], pubmap: {}, parents: {}, textbook: {}, vocab: { states: {}, mnemos: {}, push: {}, assigns: {} },
  /* 어휘브레인 — 단어장 본문(books)은 라이선스 자료라 스냅샷에 싣지 않는다(hanjaSnapshot). index 는 본문 없는 목록 */
  hanja: { books: {}, index: null, states: {}, summaries: {}, assigns: {}, tasks: {}, strokes: null, push: {}, remaps: {} } });

let db = empty();

/* db.json 은 살아 있는 저장소라 내신 팩 본문(db.naesin.packs — KV의 naesin:pack:* 에 해당)도 여기 있다.
   backups/ 의 일일 스냅샷은 팩을 싣지 않으며(naesinSnapshot) 기동 시 자동 복원되지도 않는다 —
   복원은 관리 export/import 로 사람이 한다. db.json 에 팩이 있든 없든 스냅샷과는 무관하다. */
export function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      db = Object.assign(empty(), raw);
    }
  } catch (e) {
    console.error('[store] db.json 파싱 실패 — 빈 DB로 시작:', e.message);
    db = empty();
  }
  return db;
}

/* 내신 칸의 스냅샷 — 팩 본문(packs)은 뺀다. 팩은 라이선스 원문이라 백업 파일로 흩어지면 안 되고,
   원장이 보관한 원본 JSON 으로 언제든 재업로드할 수 있다. id 목록만 남겨 무엇이 있었는지는 알게 한다.
   워커의 fullDump 와 같은 모양({packIds, states, exams, tasks, results}) — 로컬 /api/admin/export 도 이걸 쓴다.
   시험 결과(results)는 강사가 손으로 넣은 유일한 실제 성과 자료라 반드시 담는다 — 팩과 달리 다시 만들 수 없다. */
export function naesinSnapshot(n) {
  const src = n || {};
  return {
    packIds: Array.isArray(src.packIds) ? src.packIds : Object.keys(src.packs || {}),
    states: src.states || {}, exams: src.exams || {}, tasks: src.tasks || {}, results: src.results || {},
  };
}

/* 어휘브레인 칸의 스냅샷 — 단어장 본문(books)은 뺀다. 워커 dumpHanja 와 같은 모양({bookIds, index, states, assigns}).
   단어장은 원장이 보관한 원본 JSON 으로 다시 올릴 수 있고, 학생 기록·배정은 다시 만들 수 없어 담는다. */
/* 국어브레인 칸의 스냅샷 — 팩 본문(packs)은 영어와 같은 이유로 뺀다. 워커 fullDump 의
   naesinKo 와 같은 모양({packIds, states, summaries, reviews, overlays, exams, tasks}).
   오버레이·서술형 확정은 **강사가 손으로 만든 것**이라 다시 만들 수 없어 반드시 담는다. */
export function naesinKoSnapshot(k) {
  const src = k || {};
  return {
    packIds: Array.isArray(src.packIds) ? src.packIds : Object.keys(src.packs || {}),
    states: src.states || {}, summaries: src.summaries || {}, reviews: src.reviews || {},
    overlays: src.overlays || {}, exams: src.exams || {}, tasks: src.tasks || {},
  };
}

/* 청크브레인 칸의 스냅샷 — 지문·카드는 저장소의 정적 자산이라 애초에 여기 없다.
   워커 fullDump 의 chunk 와 같은 모양({states, summaries, assigns, customs}).
   customs(선생님 지문)는 키 하나지만 강사가 쓴 것이라 담는다. */
export function chunkSnapshot(c) {
  const src = c || {};
  return { states: src.states || {}, summaries: src.summaries || {},
    assigns: src.assigns || {}, customs: src.customs || null };
}

export function hanjaSnapshot(h) {
  const src = h || {};
  const index = Array.isArray(src.index) ? src.index : [];
  return { bookIds: index.map((e) => e && e.id).filter(Boolean), index, states: src.states || {}, summaries: src.summaries || {}, assigns: src.assigns || {},
    tasks: src.tasks || {}, remaps: src.remaps || {}, strokes: src.strokes || null };
}

/* 스냅샷에 담을 것 — 학생 기록만이 아니라 강사가 손으로 만든 것(교재 검수·발행 상태)까지.
   이게 빠지면 복구했을 때 낱말 검수를 처음부터 다시 해야 한다.

   **불변식: 가져오기(importSnapshot)가 덮을 수 있는 칸은 전부 여기 있어야 한다.** 없으면
   「덮기 전에 스냅샷을 만든다」가 그 칸에 대해 거짓이 된다 — 되돌릴 수 있다고 안내받고
   되돌릴 수 없는 상태가 가장 나쁘다. store-import.test.mjs 가 두 목록을 대조해 고정한다. */
function snapshotBody() {
  return { service: 'wb-reading', savedAt: new Date().toISOString(),
    students: db.students, portalFamilies: db.portalFamilies || {}, states: db.states, vocab: db.vocab,
    textbook: db.textbook || {}, pubmap: db.pubmap || {}, naesin: naesinSnapshot(db.naesin),
    naesinKo: naesinKoSnapshot(db.naesinKo), chunk: chunkSnapshot(db.chunk),
    textbookSrc: db.textbookSrc || {}, hanja: hanjaSnapshot(db.hanja) };
}

function dayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* 백업 이름 두 갈래. 일일 슬롯은 날짜 하나당 파일 하나(db-<날짜>.json)이고,
   가져오기 직전 스냅샷은 **시각까지 넣은 별도 파일**이다 — 같은 날 두 번 가져오면 일일
   슬롯 하나를 서로 덮어, 두 번째 가져오기의 '되돌릴 자리'가 첫 번째 결과가 되어 버린다
   (되돌릴 수 있다고 안내하면서 원본을 지우는 셈이다). 그래서 슬롯을 나눈다. */
const PRE = 'pre-import-';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRE_RE = /^pre-import-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d{1,3})?$/;
const isBackupLabel = (x) => DAY_RE.test(x) || PRE_RE.test(x);
const PRE_KEEP = 10;

/* 하루 1회 자동 스냅샷 — data/backups/db-<날짜>.json, 최근 10개 보관 */
function snapshotIfNeeded() {
  try {
    const f = path.join(BDIR, 'db-' + dayKey() + '.json');
    if (fs.existsSync(f)) return;
    fs.mkdirSync(BDIR, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(snapshotBody()));
    const all = fs.readdirSync(BDIR).filter(x => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
    all.slice(0, Math.max(0, all.length - BACKUP_KEEP)).forEach(x => fs.unlinkSync(path.join(BDIR, x)));
  } catch (e) { console.error('[store] 스냅샷 실패:', e.message); }
}

/* 일일 슬롯을 먼저, 가져오기 직전 스냅샷을 뒤에 — 각각 새 것부터. 섞어서 한 줄로
   정렬하면 'pre-import-…' 가 날짜보다 뒤로 가 평소 보는 목록의 순서가 흔들린다. */
export function listBackups() {
  try {
    const names = fs.readdirSync(BDIR).filter((x) => /^db-.+\.json$/.test(x))
      .map((x) => x.slice(3, -5)).filter(isBackupLabel);
    const days = names.filter((x) => DAY_RE.test(x)).sort().reverse();
    const pres = names.filter((x) => PRE_RE.test(x)).sort().reverse();
    return days.concat(pres);
  } catch (e) { return []; }
}

/* label 은 날짜(2026-10-12) 또는 가져오기 직전 스냅샷 이름(pre-import-…Z) 둘 다 받는다 */
export function getBackup(label) {
  try {
    if (!isBackupLabel(String(label || ''))) return null;
    const f = path.join(BDIR, 'db-' + label + '.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  } catch (e) { return null; }
}

/* 가져오기 직전 스냅샷 — 일일 슬롯을 건드리지 않는다. 라벨을 돌려주고, 그 라벨이
   그대로 `GET /api/admin/export?backup=<라벨>` 에 쓰인다. 밀리초까지 넣어 같은 초에
   두 번 가져와도 겹치지 않게 한다. */
export function snapshotBeforeImport() {
  try {
    fs.mkdirSync(BDIR, { recursive: true });
    const stamp = PRE + new Date().toISOString().replace(/:/g, '-').replace('.', '-');
    /* 밀리초만으로는 모자란다 — 같은 밀리초에 두 번 부르면(연달아 가져오기, 테스트) 라벨이
       겹쳐 **두 되돌림 지점이 한 파일이 된다.** 이름을 나누는 이유가 거기 있으니 여기서 끝낸다. */
    let label = stamp;
    for (let i = 2; i < 1000 && fs.existsSync(path.join(BDIR, 'db-' + label + '.json')); i++) label = stamp + '-' + i;
    if (!PRE_RE.test(label) || fs.existsSync(path.join(BDIR, 'db-' + label + '.json'))) return null;
    fs.writeFileSync(path.join(BDIR, 'db-' + label + '.json'), JSON.stringify(snapshotBody()));
    /* 일일 슬롯과 **따로** 줄인다 — 가져오기를 자주 하면 일일 백업이 밀려 사라진다 */
    const pres = fs.readdirSync(BDIR).filter((x) => x.startsWith('db-' + PRE)).sort();
    pres.slice(0, Math.max(0, pres.length - PRE_KEEP)).forEach((x) => fs.unlinkSync(path.join(BDIR, x)));
    return label;
  } catch (e) { console.error('[store] 가져오기 직전 스냅샷 실패:', e.message); return null; }
}

export function snapshotNow() {
  try {
    fs.mkdirSync(BDIR, { recursive: true });
    const f = path.join(BDIR, 'db-' + dayKey() + '.json');
    fs.writeFileSync(f, JSON.stringify(snapshotBody()));
    return dayKey();
  } catch (e) { return null; }
}

/* 읽기 전용 모드 — 터널로 외부에 연 검토용 서버(docs/로컬-서버-외부공개-터널.md 의 결정 ㄱ).
   server.mjs 가 쓰기 메서드를 HTTP 자리에서 먼저 막지만, 이 자리까지 잠가야 **GET 라우트가
   몰래 쓰는 길**이 남지 않는다(연동 nonce 정리처럼 GET 이면서 persist() 를 부르는 자리가 있다).
   화면을 눌러 생긴 변경은 메모리에만 남고 프로세스와 함께 사라진다 — 가져온 스냅샷이 그대로
   남는 쪽이 검토용 서버의 조건이다. 가져오기(import)는 이 모드의 **목적**이라 제 손으로 쓴다. */
let readOnly = false;
export function setReadOnly(on) { readOnly = !!on; }
export function isReadOnly() { return readOnly; }

function writeDb() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
    snapshotIfNeeded();
  } catch (e) { console.error('[store] 저장 실패:', e.message); }
}

let saveTimer = null;
export function persist() {
  if (readOnly) return;            // 검토용 서버에서는 화면 조작이 db.json 에 닿지 않는다
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeDb(); }, 300);
}

/* 읽기 전용 모드에서도 디스크에 써야 하는 단 하나 — 가져오기. 디바운스를 거치지 않는 이유는
   둘이다: ① 모드 판정을 우회해야 한다 ② 라우트가 200 을 돌려준 뒤 저장이 끝나 있어야
   "가져왔다는데 재기동하니 없다"가 생기지 않는다. */
function persistNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeDb();
}

/* export 스냅샷을 되읽어 db 에 올린다 — 운영(KV)에서 뜬 자료를 이 PC 서버로 가져와 **보기만** 할 때
   쓴다(docs/로컬-서버-외부공개-터널.md 의 결정 ㄱ). 터널 결정 A 는 이 서버를 원장·강사 전용으로
   좁혔지만, 그래도 데이터가 KV 와 db.json 으로 갈린 채였다 — export 는 양쪽에 있는데 되읽는 길이
   없었다. 그 한쪽을 메운다.

   **반드시 제자리에서 고친다(재할당 금지).** server.mjs 가 기동 때 `const db = getDb()` 로 이
   객체의 참조를 붙들고, haruRoot()·letterRoot() 같은 어댑터도 전부 그 참조를 닫아 두었다.
   여기서 `db = next` 로 바꿔치우면 모듈 안의 db 만 새 객체가 되고 **서버는 옛 객체를 계속 본다** —
   import 가 성공했다고 답하는데 화면은 아무것도 안 바뀌는, 가장 알아채기 어려운 고장이 된다.

   **되읽을 수 있는 칸만 올린다.** export 의 일부 칸은 저장 모양과 꼴이 달라서(아래 SKIP) 그대로
   넣으면 그 앱이 깨진다. 모르는 것을 밀어 넣지 않고 skipped 로 돌려준다 — 조용히 넘기면
   "가져왔다"는 응답을 받고도 그 앱만 비어 있는 상태가 된다. */

/* 꼴이 같아 그대로 올릴 수 있는 칸 */
const IMPORT_DIRECT = ['students', 'states', 'portalFamilies', 'textbook', 'textbookSrc', 'pubmap'];
/* 스냅샷이 일부만 담는 칸 — 담긴 것만 덮고 나머지는 그대로 둔다.
   **화이트리스트가 꼭 필요한 이유**: dump 가 만드는 칸보다 저장된 칸이 넓다. vocab 을 통째로
   갈면 dumpVocab 에 없는 `push`(밤 알림 구독)·`usage`·`arena` 가 조용히 사라지고, naesin·
   naesinKo 를 통째로 갈면 올려 둔 팩 본문(packs)이 사라진다. 키 이름은 워커 fullDump 와
   같아야 한다 — 다르면 그 칸이 아무 말 없이 버려진다(그래서 아래 unknown 보고를 둔다). */
const IMPORT_MERGE = {
  vocab: ['states', 'mnemos', 'assigns'],
  naesin: ['packIds', 'states', 'exams', 'tasks', 'results'],
  naesinKo: ['packIds', 'states', 'summaries', 'reviews', 'overlays', 'exams', 'tasks'],
  chunk: ['states', 'summaries', 'assigns', 'customs'],
  hanja: ['index', 'states', 'summaries', 'assigns', 'tasks', 'remaps', 'strokes'],
};
/* 되읽지 않는 칸과 그 이유 — dump 가 저장 모양과 다르다. 넣으면 그 앱이 깨진다.
   되읽으려면 역방향 매퍼를 먼저 만들어야 한다(haru 는 paperkeyIds·planIds 가 없고,
   letter 는 images 가 배열인데 저장은 맵이다). */
const IMPORT_SKIP = {
  haru: 'dumpHaru 에 paperkeyIds·planIds 가 없어 getPaperKeyIds()·getPlanIds() 가 빈다',
  letter: 'dumpLetter 의 images 는 배열인데 저장은 맵이다 (issues 레코드 꼴도 다르다)',
};
/* 자료가 아닌 머리 칸 — unknown 으로 세면 매번 거짓 경고가 된다 */
const IMPORT_META = ['service', 'savedAt', 'confirm', 'snapshot'];

/* 이 칸들은 전부 맵·객체다(students 는 코드→레코드, vocab 은 하위 맵 묶음…).
   꼴 검사가 없으면 잘린 파일 하나로 `db.students = "..."` 같은 상태가 되고, 그대로
   디스크에 저장돼 **재기동으로도 안 돌아온다**(백업을 꺼내 와야 한다). 관리 인증이 걸려
   있어 아무나 보낼 수는 없지만, 사람이 잘못된 파일을 고르는 일은 인증이 막아 주지 않는다. */
const WRONG_SHAPE = '꼴이 달라 받지 않았다 — 객체(맵)여야 하는 칸이다';
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/* 받을 수 있는 스냅샷인지만 본다 — **아무것도 고치지 않는다.** 라우트가 이것을 먼저 불러서,
   받지도 않을 파일 때문에 되돌릴 자리(가져오기 직전 스냅샷)를 희생하지 않게 한다. */
export function importPrecheck(next) {
  if (!isMap(next)) return { ok: false, error: '스냅샷이 객체가 아닙니다.' };
  if (next.service && next.service !== 'wb-reading') {
    return { ok: false, error: '이 서버의 스냅샷이 아닙니다: ' + String(next.service).slice(0, 40) };
  }
  return { ok: true };
}

/* 가족 링크 복구 — 토큰→학생코드 맵(db.parents)은 어느 스냅샷에도 없다(워커는 `parent:<t>` 를
   따로 쓰고 fullDump 가 담지 않는다). 그런데 학생 레코드에는 ptoken 이 그대로 들어온다.
   맵만 비면 가정에 나간 링크 전부가 404 가 되고 — 브레인레터 가족 링크·청크 가족 모드까지 —
   이 서버에서는 다시 만들 길도 없다(만드는 자리가 `if (!stu.ptoken)` 분기뿐이라 토큰이 이미
   있는 학생은 영원히 비어 있다). 토큰이 학생 레코드에 있으니 역맵은 여기서 다시 세운다.
   **지우지 않고 더한다** — 이 기기에만 있던 링크를 끊을 이유가 없다. */
function relinkParents() {
  if (!isMap(db.parents)) db.parents = {};
  const stu = isMap(db.students) ? db.students : {};
  let n = 0;
  Object.keys(stu).forEach((code) => {
    const t = stu[code] && stu[code].ptoken;
    if (typeof t === 'string' && t && db.parents[t] !== code) { db.parents[t] = code; n += 1; }
  });
  return n;
}

export function importSnapshot(next, opts) {
  const pre = importPrecheck(next);
  if (!pre.ok) return { ok: false, error: pre.error };
  /* 칸의 **기본 꼴은 어댑터가 정본이다**(server.mjs 의 naesinRoot·naesinKoRoot·chunkRoot·
     hanjaRoot). 여기서 다시 적으면 어댑터가 칸을 하나 늘릴 때 가져오기만 옛 꼴을 만들고,
     그 칸이 undefined 인 db 가 디스크에 남는다 — 예를 들어 db.naesin 을 packs 없이 만들면
     `db.naesin.packs[id]` 에서 팩 라우트가 영구 500 이 된다(재기동으로도 안 낫는다).
     그래서 어댑터를 먼저 불러 기본 꼴을 세우고, 그 객체에 덮는다. */
  const roots = (opts && isMap(opts.roots)) ? opts.roots : {};
  const applied = [], skipped = [], absent = [], unknown = [];
  IMPORT_DIRECT.forEach((k) => {
    if (next[k] == null) { absent.push(k); return; }
    /* 꼴이 다르면 **덮지 않고** 알린다 — 조용히 넣으면 그 칸을 쓰는 라우트가 전부 깨진다 */
    if (!isMap(next[k])) { skipped.push({ section: k, why: WRONG_SHAPE }); return; }
    db[k] = next[k]; applied.push(k);
  });
  Object.keys(IMPORT_MERGE).forEach((root) => {
    const src = next[root];
    if (src == null) { absent.push(root); return; }
    if (!isMap(src)) { skipped.push({ section: root, why: WRONG_SHAPE }); return; }
    const target = typeof roots[root] === 'function'
      ? roots[root]()
      : (db[root] = isMap(db[root]) ? db[root] : {});
    /* 본문(packs·books)·이 기기 것(vocab.push)은 건드리지 않는다 — 화이트리스트 밖이다 */
    IMPORT_MERGE[root].forEach((k) => { if (src[k] != null) target[k] = src[k]; });
    applied.push(root);
  });
  Object.keys(IMPORT_SKIP).forEach((k) => {
    if (next[k] != null) skipped.push({ section: k, why: IMPORT_SKIP[k] });
  });
  /* 세 목록 어디에도 없는 최상위 키 — **조용히 버리지 않는다.** 워커 fullDump 에 칸이 하나
     늘면(국어·청크가 실제로 그랬다) 이 목록만 보고 바로 알 수 있어야 한다. */
  const known = new Set(IMPORT_DIRECT.concat(Object.keys(IMPORT_MERGE), Object.keys(IMPORT_SKIP), IMPORT_META));
  Object.keys(next).forEach((k) => { if (!known.has(k)) unknown.push(k); });
  const parentsLinked = relinkParents();
  persistNow();      // 읽기 전용 모드에서도 저장한다 — 가져오기가 그 모드의 목적이다
  return { ok: true, applied, skipped, absent, unknown, parentsLinked, savedAt: next.savedAt || null };
}

export function importSections() {
  return { direct: IMPORT_DIRECT.slice(), merge: Object.assign({}, IMPORT_MERGE), skip: Object.assign({}, IMPORT_SKIP) };
}

/* 스냅샷이 담는 칸 이름 — 테스트가 「가져오기가 덮는 칸 ⊆ 스냅샷이 담는 칸」을 대조한다 */
export function snapshotSections() { return Object.keys(snapshotBody()).filter((k) => !IMPORT_META.includes(k)); }

export function getDb() { return db; }
