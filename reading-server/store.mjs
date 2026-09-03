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

const empty = () => ({ students: {}, states: {}, tokens: {}, pending: {}, levelLog: [], pubmap: {}, parents: {}, textbook: {}, vocab: { states: {}, mnemos: {}, push: {}, assigns: {} } });

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
   워커의 fullDump 와 같은 모양({packIds, states, exams, tasks}) — 로컬 /api/admin/export 도 이걸 쓴다. */
export function naesinSnapshot(n) {
  const src = n || {};
  return {
    packIds: Array.isArray(src.packIds) ? src.packIds : Object.keys(src.packs || {}),
    states: src.states || {}, exams: src.exams || {}, tasks: src.tasks || {},
  };
}

/* 스냅샷에 담을 것 — 학생 기록만이 아니라 강사가 손으로 만든 것(교재 검수·발행 상태)까지.
   이게 빠지면 복구했을 때 낱말 검수를 처음부터 다시 해야 한다. */
function snapshotBody() {
  return { service: 'wb-reading', savedAt: new Date().toISOString(),
    students: db.students, states: db.states, vocab: db.vocab,
    textbook: db.textbook || {}, pubmap: db.pubmap || {}, naesin: naesinSnapshot(db.naesin),
    textbookSrc: db.textbookSrc || {} };
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

export function getDb() { return db; }
