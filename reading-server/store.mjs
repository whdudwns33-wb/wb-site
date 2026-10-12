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
export function hanjaSnapshot(h) {
  const src = h || {};
  const index = Array.isArray(src.index) ? src.index : [];
  return { bookIds: index.map((e) => e && e.id).filter(Boolean), index, states: src.states || {}, summaries: src.summaries || {}, assigns: src.assigns || {},
    tasks: src.tasks || {}, remaps: src.remaps || {}, strokes: src.strokes || null };
}

/* 스냅샷에 담을 것 — 학생 기록만이 아니라 강사가 손으로 만든 것(교재 검수·발행 상태)까지.
   이게 빠지면 복구했을 때 낱말 검수를 처음부터 다시 해야 한다. */
function snapshotBody() {
  return { service: 'wb-reading', savedAt: new Date().toISOString(),
    students: db.students, portalFamilies: db.portalFamilies || {}, states: db.states, vocab: db.vocab,
    textbook: db.textbook || {}, pubmap: db.pubmap || {}, naesin: naesinSnapshot(db.naesin),
    textbookSrc: db.textbookSrc || {}, hanja: hanjaSnapshot(db.hanja) };
}

function dayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

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

export function listBackups() {
  try {
    return fs.readdirSync(BDIR).filter(x => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(x))
      .map(x => x.slice(3, 13)).sort().reverse();
  } catch (e) { return []; }
}

export function getBackup(day) {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const f = path.join(BDIR, 'db-' + day + '.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  } catch (e) { return null; }
}

export function snapshotNow() {
  try {
    fs.mkdirSync(BDIR, { recursive: true });
    const f = path.join(BDIR, 'db-' + dayKey() + '.json');
    fs.writeFileSync(f, JSON.stringify(snapshotBody()));
    return dayKey();
  } catch (e) { return null; }
}

let saveTimer = null;
export function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, FILE);
      snapshotIfNeeded();
    } catch (e) { console.error('[store] 저장 실패:', e.message); }
  }, 300);
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
const IMPORT_DIRECT = ['students', 'states', 'vocab', 'portalFamilies', 'textbook', 'textbookSrc', 'pubmap'];
/* 스냅샷이 본문을 뺀 칸 — 있는 본문(packs·books)은 지우지 않고 나머지만 덮는다 */
const IMPORT_MERGE = {
  naesin: ['packIds', 'states', 'exams', 'tasks', 'results'],
  hanja: ['index', 'states', 'summaries', 'assigns', 'tasks', 'remaps', 'strokes'],
};
/* 되읽지 않는 칸과 그 이유 — dump 가 저장 모양과 다르다. 넣으면 그 앱이 깨진다.
   되읽으려면 역방향 매퍼를 먼저 만들어야 한다(haru 는 paperkeyIds·planIds 가 없고,
   letter 는 images 가 배열인데 저장은 맵이다). */
const IMPORT_SKIP = {
  haru: 'dumpHaru 에 paperkeyIds·planIds 가 없어 getPaperKeyIds()·getPlanIds() 가 빈다',
  letter: 'dumpLetter 의 images 는 배열인데 저장은 맵이다 (issues 레코드 꼴도 다르다)',
};

export function importSnapshot(next) {
  if (!next || typeof next !== 'object') return { ok: false, error: '스냅샷이 객체가 아닙니다.' };
  if (next.service && next.service !== 'wb-reading') {
    return { ok: false, error: '이 서버의 스냅샷이 아닙니다: ' + String(next.service).slice(0, 40) };
  }
  const applied = [], skipped = [], absent = [];
  IMPORT_DIRECT.forEach((k) => {
    if (next[k] == null) { absent.push(k); return; }
    db[k] = next[k]; applied.push(k);
  });
  Object.keys(IMPORT_MERGE).forEach((root) => {
    const src = next[root];
    if (src == null || typeof src !== 'object') { absent.push(root); return; }
    db[root] = db[root] || {};
    /* 본문(packs·books)은 건드리지 않는다 — 스냅샷에 없을 뿐 지울 이유가 없다 */
    IMPORT_MERGE[root].forEach((k) => { if (src[k] != null) db[root][k] = src[k]; });
    applied.push(root);
  });
  Object.keys(IMPORT_SKIP).forEach((k) => {
    if (next[k] != null) skipped.push({ section: k, why: IMPORT_SKIP[k] });
  });
  persist();
  return { ok: true, applied, skipped, absent, savedAt: next.savedAt || null };
}

export function importSections() {
  return { direct: IMPORT_DIRECT.slice(), merge: Object.keys(IMPORT_MERGE), skip: Object.assign({}, IMPORT_SKIP) };
}

export function getDb() { return db; }
