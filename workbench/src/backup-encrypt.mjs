#!/usr/bin/env node
/* 비공개 평문 → 정본 백업 재암호화 (backup/README 의 복원 명령과 정확히 역방향).
   bulk-data.json · private-seed.json 은 gitignored 라 기기·컨테이너가 초기화되면 사라진다.
   내용을 바꿨다면 배포보다 **먼저** 이걸 돌리고 backup/*.enc.json 을 커밋할 것
   (2026-09-16 — 538개교 성취도 데이터를 만들고 재암호화 전에 컨테이너가 초기화되어 통째로 잃었다).
   사용법:  WB_PASSWORD='...' node workbench/src/backup-encrypt.mjs [bulk|seed|all]   (기본 all)
   안전장치: ① 지금 백업이 이 비밀번호로 열리는지 먼저 확인 — 틀린 비밀번호로 덮어쓰면 백업이 영영 안 열린다
            ② 쓴 직후 다시 복호화해 원본과 바이트 단위로 대조 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import zlib from "zlib";

const PW = process.env.WB_PASSWORD;
if (!PW) { console.error("WB_PASSWORD 환경변수가 필요합니다."); process.exit(2); }
const HERE = dirname(fileURLToPath(import.meta.url));
const BK = join(HERE, "..", "backup");
const ITER = 310000;
const which = process.argv[2] || "all";
const jobs = [["bulk", "bulk-data"], ["seed", "private-seed"]].filter(([k]) => which === "all" || which === k);
if (!jobs.length) { console.error("인자는 bulk | seed | all"); process.exit(2); }

const dec = (e) => {
  const key = crypto.pbkdf2Sync(PW, Buffer.from(e.s, "base64"), ITER, 32, "sha256");
  const raw = Buffer.from(e.ct, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return zlib.gunzipSync(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]));
};

for (const [, name] of jobs) {
  const encPath = join(BK, `${name}.enc.json`), plainPath = join(HERE, `${name}.json`);
  if (!existsSync(plainPath)) { console.error(`✗ ${name}.json 없음 — 먼저 backup/README 로 복원하세요`); process.exit(1); }
  if (existsSync(encPath)) {
    try { dec(JSON.parse(readFileSync(encPath, "utf8"))); }
    catch { console.error(`✗ 지금 ${name}.enc.json 이 이 비밀번호로 열리지 않습니다 — 덮어쓰지 않습니다.`); process.exit(1); }
  }
  const plain = readFileSync(plainPath);
  JSON.parse(plain.toString("utf8")); // 깨진 JSON 은 백업하지 않는다
  const s = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(PW, s, ITER, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(zlib.gzipSync(plain, { level: 9 })), c.final(), c.getAuthTag()]);
  const env = { v: 1, kdf: "PBKDF2-SHA256-310000", alg: "AES-256-GCM", inner: `gzip(${name}.json)`,
    s: s.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") };
  writeFileSync(encPath, JSON.stringify(env));
  const back = dec(JSON.parse(readFileSync(encPath, "utf8")));
  if (!back.equals(plain)) { console.error(`✗ ${name}: 되읽기 불일치 — 커밋하지 마세요`); process.exit(1); }
  console.log(`✓ ${name}.enc.json 재암호화 + 되읽기 일치 (${plain.length.toLocaleString()}B → ${ct.length.toLocaleString()}B)`);
}
console.log("→ git add workbench/backup/*.enc.json 후 커밋");
