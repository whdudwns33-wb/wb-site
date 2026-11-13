'use strict';
/* WB 진로독서 서버 저장소 — 파일 기반 JSON (파일럿).
   프로덕션 이관 지점: 이 모듈만 Cloudflare KV/D1 또는 PostgreSQL로 교체. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isReservedCode } from './naesin-api.mjs';
import { writeJson } from './json-file.mjs';

/* DATA_DIR 로 저장 위치를 옮길 수 있다 — 서버 머리말이 알리는 값이다.
   전에는 이 값을 읽지 않아, 다른 곳을 가리켜 놓고 시험해도 조용히 기본 자리에 쌓였다. */
const DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const FILE = path.join(DIR, 'db.json');
const AUTH_FILE = path.join(DIR, 'auth.json');
const NAESIN_STATES_FILE = path.join(DIR, 'naesin-states.json');
const STUDENT_ADMIN_FILE = path.join(DIR, 'student-admin.json');
const DELETIONS_FILE = path.join(DIR, 'student-deletions.json');
const BDIR = path.join(DIR, 'backups');
const PRIVATE_BDIR = path.join(DIR, 'private-backups');
const PACK_DIR = path.join(DIR, 'naesin-packs');
const PACK_ID_RE = /^[A-Za-z0-9-]{3,60}$/;
const BACKUP_KEEP = 10;
const BACKUP_ID_RE = /^\d{4}-\d{2}-\d{2}(?:-\d{9}-[a-f0-9]{8})?$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const deletionCode = c => typeof c === 'string' && /^[A-Za-z0-9-]{3,20}$/.test(c) && !isReservedCode(c);
const NAESIN_MAP_FIELDS = ['packs', 'states', 'exams', 'tasks', 'results', 'books', 'reports', 'jobs', 'jobSrc', 'live', 'votes'];

const empty = () => ({ students: {}, states: {}, tokens: {}, pending: {}, levelLog: [], pubmap: {}, parents: {}, textbook: {}, vocab: { states: {}, mnemos: {}, push: {}, assigns: {} },
  /* 어휘브레인 — 단어장 본문(books)은 라이선스 자료라 스냅샷에 싣지 않는다(hanjaSnapshot). index 는 본문 없는 목록 */
  hanja: { books: {}, index: null, states: {}, summaries: {}, assigns: {}, tasks: {}, strokes: null, push: {}, remaps: {} } });

let db = empty();
let deletions = {};
let revision = 0;
const captureDb = () => ({ ...db,
  tokens: structuredClone(db.tokens), pending: structuredClone(db.pending),
  ...(db.naesin ? { naesin: { ...db.naesin, states: { ...db.naesin.states } } } : {}),
});

/* Node의 삭제와 재기동 재적용은 같은 경로를 쓴다. 공통 교재·반 배정은 건드리지 않는다. */
function removeStudentData(code, links) {
  let removed = 0;
  const drop = (map, key) => { if (map && Object.hasOwn(map, key)) { delete map[key]; removed++; } };
  for (const [root, fields] of [[db, ['states']], [db.vocab, ['states', 'push']],
    [db.naesin, ['states', 'exams', 'results', 'books']], [db.naesinKo, ['states', 'summaries', 'reviews', 'exams', 'overlays']],
    [db.haru, ['states', 'mocks', 'paper']], [db.hanja, ['states', 'summaries', 'assigns', 'push', 'tasks']],
    [db.chunk, ['states', 'summaries', 'assigns']], [db.letter, ['states']], [db.naesinTg, ['states', 'exams']]]) {
    for (const field of fields) drop(root?.[field], code);
  }
  if (links.ptoken) {
    drop(db.parents, links.ptoken); drop(db.chunk?.pushes, 'f:' + links.ptoken); drop(db.letter?.push, 'f:' + links.ptoken);
  }
  if (links.haruPtoken) drop(db.haru?.parents, links.haruPtoken);
  drop(db.letter?.push, 's:' + code);
  for (const [id, list] of Object.entries(db.naesin?.reports || {})) {
    if (!Array.isArray(list) || !list.some(r => r && r.code === code)) continue;
    db.naesin.reports[id] = list.map(r => r && r.code === code ? { ...r, code: '' } : r); removed++;
  }
  for (const [key, rec] of Object.entries(db.tokens || {})) if (rec?.code === code) drop(db.tokens, key);
  for (const [key, rec] of Object.entries(db.pending || {})) if (rec?.code === code) drop(db.pending, key);
  drop(db.students, code);
  return removed;
}

/* db.json 은 살아 있는 저장소라 내신 팩 본문(db.naesin.packs — KV의 naesin:pack:* 에 해당)도 여기 있다.
   backups/ 의 일일 스냅샷은 팩을 싣지 않으며(naesinSnapshot) 기동 시 자동 복원되지도 않는다 —
   복원은 관리 export/import 로 사람이 한다. db.json 에 팩이 있든 없든 스냅샷과는 무관하다. */
export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!isObj(raw)) throw new Error('DB 최상위는 객체여야 합니다.');
    for (const [key, value] of Object.entries(empty())) {
      if (Object.hasOwn(raw, key) && !(Array.isArray(value) ? Array.isArray(raw[key]) : isObj(raw[key]))) throw new Error('DB 칸 형식 오류: ' + key);
    }
    if (Object.hasOwn(raw, 'naesin')) {
      if (!isObj(raw.naesin)) throw new Error('DB 내신 칸은 객체여야 합니다.');
      for (const key of NAESIN_MAP_FIELDS) {
        if (Object.hasOwn(raw.naesin, key) && !isObj(raw.naesin[key])) throw new Error('DB 내신 칸 형식 오류: ' + key);
      }
      if (Object.hasOwn(raw.naesin, 'packIds') && !Array.isArray(raw.naesin.packIds)) throw new Error('DB 내신 팩 목록은 배열이어야 합니다.');
      if (Object.hasOwn(raw.naesin, 'aiUse') && raw.naesin.aiUse !== null && !isObj(raw.naesin.aiUse)) throw new Error('DB 내신 AI 장부는 객체 또는 null이어야 합니다.');
    }
    db = Object.assign(empty(), raw);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('[store] db.json을 읽지 못해 서버를 시작하지 않습니다(기동을 중단합니다). 원본 파일과 백업을 확인해 주세요.');
    db = empty();
  }
  try {
    const files = fs.existsSync(PACK_DIR) ? fs.readdirSync(PACK_DIR) : [];
    for (const file of files.filter(f => f.endsWith('.json'))) {
      const hex = file.slice(0, -5), id = Buffer.from(hex, 'hex').toString();
      if (!PACK_ID_RE.test(id) || Buffer.from(id).toString('hex') !== hex) throw new Error('Invalid pack filename');
      const rec = JSON.parse(fs.readFileSync(path.join(PACK_DIR, file), 'utf8'));
      if (!isObj(rec) || !(rec.deleted === true || isObj(rec.pack) && rec.pack.packId === id)) throw new Error('Invalid pack record');
      applyPack(id, rec);
    }
  } catch (e) { throw new Error('naesin-packs를 읽지 못해 기동을 중단합니다. 원본을 보존하고 복구하세요.'); }
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (!isObj(auth) || !isObj(auth.tokens) || !isObj(auth.pending)) throw new Error('Invalid auth store');
    db.tokens = auth.tokens; db.pending = auth.pending;
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('auth.json을 읽지 못해 기동을 중단합니다. 원본을 보존하고 복구하세요.');
  }
  try {
    const states = JSON.parse(fs.readFileSync(NAESIN_STATES_FILE, 'utf8'));
    if (!isObj(states) || Object.values(states).some(rec => !isObj(rec))) throw new Error('Invalid study states');
    db.naesin = db.naesin || {}; db.naesin.states = states;
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('naesin-states.json을 읽지 못해 기동을 중단합니다. 원본을 보존하고 복구하세요.');
  }
  try {
    const admin = JSON.parse(fs.readFileSync(STUDENT_ADMIN_FILE, 'utf8'));
    if (!isObj(admin) || !isObj(admin.students) || Object.values(admin.students).some(s => !isObj(s))
      || !isObj(admin.books) || Object.values(admin.books).some(b => typeof b !== 'string')) throw new Error('Invalid student admin store');
    db.students = admin.students;
    db.naesin = db.naesin || {}; db.naesin.books = admin.books;
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('student-admin.json을 읽지 못해 기동을 중단합니다. 원본을 보존하고 복구하세요.');
  }
  try {
    const journal = JSON.parse(fs.readFileSync(DELETIONS_FILE, 'utf8'));
    if (!isObj(journal) || journal.v !== 1 || !isObj(journal.deleted)
      || Object.entries(journal.deleted).some(([code, rec]) => !deletionCode(code) || !isObj(rec)
        || ['ptoken', 'haruPtoken'].some(k => rec[k] != null && (typeof rec[k] !== 'string' || rec[k].length > 128)))) throw new Error('Invalid deletions');
    deletions = journal.deleted;
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('student-deletions.json을 읽지 못해 기동을 중단합니다. 원본을 보존하고 복구하세요.');
    deletions = {};
  }
  for (const [code, links] of Object.entries(deletions)) removeStudentData(code, links);
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
    books: src.books || {}, reports: src.reports || {}, votes: src.votes || {}, aiUse: src.aiUse ?? null,
    jobs: Object.fromEntries(Object.entries(src.jobs || {}).filter(([, job]) => isObj(job)).map(([id, job]) => {
      const { draft, review, ...meta } = job;
      return [id, { ...meta, review: Object.fromEntries(Object.entries(review || {}).filter(([, rec]) => isObj(rec)).map(([key, rec]) => {
        const { patch, ...fields } = rec; return [key, fields];
      })) }];
    })),
    live: Object.fromEntries(Object.entries(src.live || {}).map(([scope, rec]) => [scope, { ...rec, projector: null }])),
    omitted: [
      { section: 'naesin.packs', why: '구매 팩 본문은 백업에 넣지 않습니다. 로컬 원본 JSON으로 다시 올려 주세요.' },
      { section: 'naesin.jobSrc', why: '구매 원천과 작업 초안·수정 본문은 백업에 넣지 않습니다. 원본을 다시 반입해야 검수·배포할 수 있습니다.' },
      { section: 'naesin.live.projector', why: '구매 문항이 있는 투사 문제는 백업에서 제외합니다. 수업 화면에서 다시 시작해 주세요.' },
    ],
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

/* 탐구브레인 칸의 스냅샷 — 문제지 본문(sheets)·쪽 그림(pages)은 구매 자료라 뺀다. 워커 fullDump 의 naesinTg 와 같은 모양. */
export function naesinTgSnapshot(t) {
  const src = t || {};
  return { sheetIds: src.sheetIds || [], states: src.states || {}, exams: src.exams || {}, tasks: src.tasks || [] };
}

/* 스냅샷에 담을 것 — 학생 기록만이 아니라 강사가 손으로 만든 것(교재 검수·발행 상태)까지.
   이게 빠지면 복구했을 때 낱말 검수를 처음부터 다시 해야 한다. */
export function snapshotBody(src) {
  const db = src || getDb();
  const ko = db.naesinKo || {}, haru = db.haru || {}, chunk = db.chunk || {}, letter = db.letter || {};
  return { service: 'wb-reading', savedAt: new Date().toISOString(),
    students: db.students, portalFamilies: db.portalFamilies || {}, states: db.states, vocab: db.vocab,
    textbook: db.textbook || {}, pubmap: db.pubmap || {}, naesin: naesinSnapshot(db.naesin),
    naesinKo: { packIds: ko.packIds || Object.keys(ko.packs || {}), states: ko.states || {}, summaries: ko.summaries || {},
      reviews: ko.reviews || {}, overlays: ko.overlays || {}, exams: ko.exams || {}, tasks: ko.tasks || {} },
    textbookSrc: db.textbookSrc || {}, hanja: hanjaSnapshot(db.hanja), naesinTg: naesinTgSnapshot(db.naesinTg),
    haru: { packIds: haru.packIds || Object.keys(haru.packs || {}), paperkeys: haru.paperkeys || {}, plans: haru.plans || {},
      states: haru.states || {}, mocks: haru.mocks || {}, paper: haru.paper || {}, atoms: haru.atoms || null },
    chunk: { states: chunk.states || {}, summaries: chunk.summaries || {}, assigns: chunk.assigns || {}, customs: chunk.customs || null },
    letter: { issues: letter.issues || {}, states: letter.states || {}, push: letter.push || {}, calendar: letter.calendar || null,
      images: Object.values(letter.images || {}) } };
}

function dayKey() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}

// 구매 원문까지 필요한 장애 복구본은 PC 안에만 두고 export·백업 API에서 공개하지 않는다.
async function writeSnapshot(id) {
  fs.mkdirSync(PRIVATE_BDIR, { recursive: true, mode: 0o700 });
  const privateStat = fs.lstatSync(PRIVATE_BDIR);
  if (!privateStat.isDirectory() || privateStat.isSymbolicLink()
    // 상위 경로의 정상 링크(macOS /var → /private/var)는 허용하고, 폴더 자체가 다른 곳으로 꺾였는지만 본다
    || fs.realpathSync(PRIVATE_BDIR) !== path.join(fs.realpathSync(DIR), path.basename(PRIVATE_BDIR))) throw new Error('비공개 복구점 폴더를 확인해 주세요.');
  fs.mkdirSync(BDIR, { recursive: true });
  for (;;) {
    const version = revision, source = captureDb(), created = [], temps = [];
    try {
      for (const [file, contents] of [
        [path.join(PRIVATE_BDIR, 'db-' + id + '.json'), source],
        [path.join(BDIR, 'db-' + id + '.json'), snapshotBody(source)],
      ]) {
        const tmp = file + '.' + randomUUID() + '.tmp'; temps.push(tmp);
        await writeJson(tmp, contents);
        // 완성된 파일만 공개하고 기존 복구점은 덮어쓰지 않는다.
        if (revision !== version) break;
        fs.linkSync(tmp, file); created.push(file);
      }
      if (revision === version) break;
      for (const file of created) fs.unlinkSync(file);
    } catch (e) {
      for (const file of created) { try { fs.unlinkSync(file); } catch {} }
      throw e;
    } finally { for (const file of temps) { try { fs.unlinkSync(file); } catch {} } }
  }
  for (const oldId of listBackups().slice(BACKUP_KEEP)) {
    fs.unlinkSync(path.join(BDIR, 'db-' + oldId + '.json'));
    const privateFile = path.join(PRIVATE_BDIR, 'db-' + oldId + '.json');
    if (fs.existsSync(privateFile)) fs.unlinkSync(privateFile);
  }
}

/* 하루 1회 자동 스냅샷 — data/backups/db-<날짜>.json, 최근 10개 보관 */
let snapshotPromise = null;
function snapshotIfNeeded() {
  if (snapshotPromise) return snapshotPromise;
  snapshotPromise = (async () => { try {
    const day = dayKey();
    if (listBackups().some(id => id === day || id.startsWith(day + '-'))) return;
    await writeSnapshot(day);
  } catch (e) { console.error('[store] 스냅샷 실패:', e.message); }
  })().finally(() => { snapshotPromise = null; });
  return snapshotPromise;
}

export function listBackups() {
  try {
    return fs.readdirSync(BDIR).filter(x => x.startsWith('db-') && x.endsWith('.json') && BACKUP_ID_RE.test(x.slice(3, -5)))
      .map(x => x.slice(3, -5)).sort().reverse();
  } catch (e) { return []; }
}

export function getBackup(day) {
  try {
    if (!BACKUP_ID_RE.test(day)) return null;
    const f = path.join(BDIR, 'db-' + day + '.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  } catch (e) { return null; }
}

export async function snapshotNow() {
  try {
    const id = dayKey() + '-' + new Date().toISOString().slice(11, 23).replace(/\D/g, '') + '-' + randomUUID().slice(0, 8);
    await writeSnapshot(id);
    return id;
  } catch (e) { return null; }
}

let savePromise = null;
function atomicWrite(file, contents) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  replaceFile(tmp, file);
}
function replaceFile(tmp, file) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 4) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}
function writeAuth() {
  fs.mkdirSync(DIR, { recursive: true });
  atomicWrite(AUTH_FILE, JSON.stringify({ tokens: db.tokens, pending: db.pending }));
}
function writeNaesinStates() {
  fs.mkdirSync(DIR, { recursive: true });
  atomicWrite(NAESIN_STATES_FILE, JSON.stringify(db.naesin?.states || {}));
}
function writeStudentAdmin() {
  fs.mkdirSync(DIR, { recursive: true });
  atomicWrite(STUDENT_ADMIN_FILE, JSON.stringify({ students: db.students, books: db.naesin?.books || {} }));
}
function writeFailure(e) {
  const failure = new Error('기록을 디스크에 저장하지 못했습니다. 저장 공간과 쓰기 권한을 확인하고 다시 시도해 주세요.', { cause: e });
  failure.code = 'STORE_WRITE_FAILED'; return failure;
}
function applyPack(id, rec) {
  const root = db.naesin = db.naesin || {};
  root.packs = root.packs || {};
  root.packIds = root.packIds || Object.keys(root.packs);
  if (rec.deleted === true) {
    delete root.packs[id]; root.packIds = root.packIds.filter(x => x !== id);
  } else {
    root.packs[id] = rec;
    if (!root.packIds.includes(id)) root.packIds = [...root.packIds, id];
  }
}
const packWrites = new Map();
// 한 팩의 본문과 목록 반영을 한 파일로 커밋한다. 같은 팩의 동시 변경만 순서대로 처리한다.
export function persistNaesinPack(id, rec) {
  if (!PACK_ID_RE.test(id) || !isObj(rec) || !(rec.deleted === true || isObj(rec.pack) && rec.pack.packId === id)) return Promise.reject(new Error('Invalid pack record'));
  const work = (packWrites.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
    const file = path.join(PACK_DIR, Buffer.from(id).toString('hex') + '.json'), tmp = file + '.tmp';
    try {
      fs.mkdirSync(PACK_DIR, { recursive: true });
      await writeJson(tmp, rec);
      replaceFile(tmp, file);
      applyPack(id, rec); revision++;
      snapshotIfNeeded();
    } catch (e) { throw writeFailure(e); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  });
  packWrites.set(id, work);
  const done = () => { if (packWrites.get(id) === work) packWrites.delete(id); };
  work.then(done, done);
  return work;
}
export async function deleteStudent(code) {
  if (!deletionCode(code)) throw new Error('Invalid student code');
  const student = Object.hasOwn(db.students, code) ? db.students[code] : null;
  if (!student) return null;
  const links = { ptoken: student.ptoken || null, haruPtoken: student.haruPtoken || null };
  const next = { ...deletions, [code]: links };
  // 삭제를 먼저 원자적으로 기록한다. 실패하면 명부·토큰·학습 기록을 아직 바꾸지 않는다.
  try {
    fs.mkdirSync(DIR, { recursive: true });
    atomicWrite(DELETIONS_FILE, JSON.stringify({ v: 1, deleted: next }));
  } catch (e) { throw writeFailure(e); }
  deletions = next;
  revision++;
  return { code, name: student.name, removed: removeStudentData(code, links) };
}
// 승인·토큰 변경에 수백 MB 교재 전체를 다시 쓰지 않는다. 기존 DB의 인증 정보는 첫 실행에 승계한다.
export async function persistAuth() {
  try { writeAuth(); } catch (e) { throw writeFailure(e); }
}
// 학생 저장에는 교재·검수 원문을 직렬화하지 않는다. 일반 저장은 삭제·복원 변경도 이 파일에 반영한다.
export async function persistNaesinStates() {
  try { writeNaesinStates(); snapshotIfNeeded(); } catch (e) { throw writeFailure(e); }
}
// 명부·교과서 지정은 본문과 독립 저장한다. 삭제 코드 재사용은 전체 저장으로 옛 기록을 먼저 정리한다.
export async function persistStudentAdmin() {
  if (Object.keys(deletions).some(code => Object.hasOwn(db.students, code))) return persist();
  revision++;
  try { writeStudentAdmin(); snapshotIfNeeded(); } catch (e) { throw writeFailure(e); }
}
export function persist() {
  revision++;
  if (savePromise) return savePromise;
  savePromise = new Promise((resolve, reject) => setTimeout(async () => {
    try {
      for (;;) {
        const version = revision;
        fs.mkdirSync(DIR, { recursive: true });
        await writeJson(FILE + '.tmp', captureDb());
        if (version !== revision) continue;
        replaceFile(FILE + '.tmp', FILE);
        // 저장 도중 들어온 승인·학습은 최신 작은 파일을 유지한다.
        writeAuth();
        writeNaesinStates();
        writeStudentAdmin();
        // 이후 일반 저장이 삭제까지 반영했을 때만 저널을 비운다(같은 코드 재등록·복원 호환).
        if (Object.keys(deletions).length) {
          atomicWrite(DELETIONS_FILE, JSON.stringify({ v: 1, deleted: {} })); deletions = {};
        }
        await snapshotIfNeeded();
        if (version === revision) break;
      }
      savePromise = null;
      resolve();
    } catch (e) {
      console.error('[store] 저장 실패:', e.message);
      savePromise = null;
      reject(writeFailure(e));
    }
  }, 300));
  // 다른 앱의 기존 예약 저장 호출도 처리되지 않은 rejection으로 서버를 종료하지 않는다.
  savePromise.catch(() => {});
  return savePromise;
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
  naesin: ['packIds', 'states', 'exams', 'tasks', 'results', 'books', 'reports', 'jobs', 'live', 'votes', 'aiUse'],
  hanja: ['index', 'states', 'summaries', 'assigns', 'tasks', 'remaps', 'strokes'],
};
/* 되읽지 않는 칸과 그 이유 — dump 가 저장 모양과 다르다. 넣으면 그 앱이 깨진다.
   되읽으려면 역방향 매퍼를 먼저 만들어야 한다(haru 는 paperkeyIds·planIds 가 없고,
   letter 는 images 가 배열인데 저장은 맵이다). */
const IMPORT_SKIP = {
  haru: 'dumpHaru 에 paperkeyIds·planIds 가 없어 getPaperKeyIds()·getPlanIds() 가 빈다',
  letter: 'dumpLetter 의 images 는 배열인데 저장은 맵이다 (issues 레코드 꼴도 다르다)',
};

export async function importSnapshot(next) {
  if (!isObj(next)) return { ok: false, error: '스냅샷이 객체가 아닙니다.' };
  if (next.service && next.service !== 'wb-reading') {
    return { ok: false, error: '이 서버의 스냅샷이 아닙니다: ' + String(next.service).slice(0, 40) };
  }
  const applied = [], skipped = [], absent = [];
  for (const k of IMPORT_DIRECT) {
    if (Object.hasOwn(next, k) && !isObj(next[k])) return { ok: false, error: k + ' 칸은 객체여야 합니다.' };
  }
  for (const [root, fields] of Object.entries(IMPORT_MERGE)) {
    if (!Object.hasOwn(next, root)) continue;
    const src = next[root];
    if (!isObj(src)) return { ok: false, error: root + ' 칸은 객체여야 합니다.' };
    for (const k of fields) {
      if (!Object.hasOwn(src, k)) continue;
      if (src[k] === null && ['aiUse', 'index', 'strokes'].includes(k)) continue;
      if (!(k === 'packIds' || k === 'index' ? Array.isArray(src[k]) : isObj(src[k]))) return { ok: false, error: root + '.' + k + ' 칸 형식이 올바르지 않습니다.' };
      if (root === 'naesin' && k === 'jobs' && Object.values(src[k]).some((job) => !isObj(job))) return { ok: false, error: 'naesin.jobs 작업은 객체여야 합니다.' };
    }
  }
  IMPORT_DIRECT.forEach((k) => {
    if (!Object.hasOwn(next, k)) { absent.push(k); return; }
    db[k] = next[k]; applied.push(k);
  });
  Object.keys(IMPORT_MERGE).forEach((root) => {
    const src = next[root];
    if (src == null || typeof src !== 'object') { absent.push(root); return; }
    db[root] = db[root] || {};
    /* 본문(packs·books)은 건드리지 않는다 — 스냅샷에 없을 뿐 지울 이유가 없다 */
    IMPORT_MERGE[root].forEach((k) => {
      if (!Object.hasOwn(src, k)) { absent.push(root + '.' + k); return; }
      if (root === 'naesin' && k === 'jobs' && src[k]) {
        db[root][k] = Object.fromEntries(Object.entries(src[k]).map(([id, meta]) => {
          const current = (db[root].jobs || {})[id] || {};
          return [id, { ...meta, draft: current.draft || {}, review: current.review || {}, status: current.draft ? 'review' : 'draft', error: '본문 없는 백업에서 복원했습니다. 로컬 원본 JSON을 다시 넣고 검수해 주세요.' }];
        }));
      } else db[root][k] = src[k];
    });
    if (root === 'naesin') {
      for (const entry of Array.isArray(src.omitted) ? src.omitted : []) {
        if (isObj(entry) && typeof entry.section === 'string' && typeof entry.why === 'string') skipped.push({ section: entry.section.slice(0, 80), why: entry.why.slice(0, 300) });
      }
      if (Object.hasOwn(src, 'packs')) skipped.push({ section: 'naesin.packs', why: '구매 팩 본문은 스냅샷으로 가져오지 않습니다. 검증된 원본 JSON을 다시 올려 주세요.' });
      if (Object.hasOwn(src, 'jobSrc')) skipped.push({ section: 'naesin.jobSrc', why: '구매 원천은 스냅샷으로 가져오지 않습니다. 로컬 원본을 사용해 다시 제작해 주세요.' });
    }
    applied.push(root);
  });
  Object.keys(IMPORT_SKIP).forEach((k) => {
    if (next[k] != null) skipped.push({ section: k, why: IMPORT_SKIP[k] });
  });
  await persist();
  return { ok: true, applied, skipped, absent, savedAt: next.savedAt || null };
}

export function importSections() {
  return { direct: IMPORT_DIRECT.slice(), merge: Object.keys(IMPORT_MERGE), skip: Object.assign({}, IMPORT_SKIP) };
}

export function getDb() { return db; }
