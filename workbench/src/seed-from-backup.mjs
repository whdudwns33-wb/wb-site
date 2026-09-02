#!/usr/bin/env node
/* 원장 브라우저의 "백업 내보내기" 파일(wb-consulting-backup-*.json)을 받아
   private-seed.json 을 통째로 갱신한다 — 학생 전체 상태(기록 포함) + 수동 DB(extras).
   사용법:  node seed-from-backup.mjs <백업파일.json>
   이후 build.mjs 재빌드 → index.html/bulk.enc.json 두 파일 함께 배포.
   주의: private-seed.json 은 gitignored — 갱신 후 ../backup/private-seed.enc.json 재암호화 필수 (backup/README). */
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src) { console.error("사용법: node seed-from-backup.mjs <wb-consulting-backup-*.json>"); process.exit(1); }

const b = JSON.parse(readFileSync(src, "utf8"));
if (!Array.isArray(b.students) || !b.students.length) { console.error("백업 형식이 아니거나 학생이 없습니다"); process.exit(1); }

const extras = {
  ipdb: b.ipdb || [], hsdb: b.hsdb || [], partners: b.partners || [],
  trends: b.trends || [], adiga: b.adiga || [], lessons: b.lessons || [],
};
extras.stamp = crypto.createHash("sha256").update(JSON.stringify(extras)).digest("hex").slice(0, 12);

/* univs/profiles 맵은 구형 시드용 — 학생 객체가 전체 데이터를 직접 갖고 있으므로 비워 둔다 */
const seed = { univs: {}, profiles: {}, students: b.students, extras };
writeFileSync(join(HERE, "private-seed.json"), JSON.stringify(seed, null, 1));
const nRec = b.students.reduce((a, s) => a + (s.records || []).length + (s.tasks || []).length, 0);
console.log(`private-seed.json 갱신 — 학생 ${b.students.length}명 (기록·수행 ${nRec}건), extras stamp ${extras.stamp}`);
console.log(`extras: 입결 수동 ${extras.ipdb.length} · 고교 평가 ${extras.hsdb.length} · 파트너십 ${extras.partners.length}`);
