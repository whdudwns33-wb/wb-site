'use strict';
/* WB 진로독서 서버 저장소 — 파일 기반 JSON (파일럿).
   프로덕션 이관 지점: 이 모듈만 Cloudflare KV/D1 또는 PostgreSQL로 교체. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const FILE = path.join(DIR, 'db.json');
const BDIR = path.join(DIR, 'backups');
const BACKUP_KEEP = 10;

const empty = () => ({ students: {}, states: {}, tokens: {}, levelLog: [], pubmap: {}, parents: {}, vocab: { states: {}, mnemos: {} } });

let db = empty();

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
    fs.writeFileSync(f, JSON.stringify({ service: 'wb-reading', savedAt: new Date().toISOString(), students: db.students, states: db.states, vocab: db.vocab }));
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
    fs.writeFileSync(f, JSON.stringify({ service: 'wb-reading', savedAt: new Date().toISOString(), students: db.students, states: db.states, vocab: db.vocab }));
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
