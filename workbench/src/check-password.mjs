#!/usr/bin/env node
/* 빌드 전 비밀번호 확인 — backup/bulk-data.enc.json 을 실제로 복호화해 본다.
   build.mjs 는 넘겨준 값으로 암호화하고 같은 값으로 되읽으므로 비밀번호가 틀려도 "일치 ✓" 가 뜬다.
   그대로 배포하면 원장이 기존 비밀번호로 못 여는 앱이 올라간다 — 배포 전 반드시 이걸 먼저 통과시킬 것.
   사용법:  WB_PASSWORD='...' node workbench/src/check-password.mjs
   평문은 만들지 않는다 (GCM 인증 태그 검증만 한다). */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import zlib from "zlib";

const PASSWORD = process.env.WB_PASSWORD;
if (!PASSWORD) { console.error("WB_PASSWORD 환경변수가 필요합니다."); process.exit(2); }

const HERE = dirname(fileURLToPath(import.meta.url));
const file = join(HERE, "..", "backup", "bulk-data.enc.json");
const e = JSON.parse(readFileSync(file, "utf8"));
const key = crypto.pbkdf2Sync(PASSWORD, Buffer.from(e.s, "base64"), 310000, 32, "sha256");
const raw = Buffer.from(e.ct, "base64");
try {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const plain = zlib.gunzipSync(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]));
  const n = JSON.parse(plain.toString("utf8"));
  console.log(`비밀번호 확인 ✓ — 백업 복호화 성공 (입결 ${(n.ip||[]).length}행 · 학교 ${(n.hs||[]).length}곳)`);
} catch {
  console.error("비밀번호 확인 ✗ — 백업이 복호화되지 않습니다. 이 값으로 빌드·배포하지 말 것.");
  process.exit(1);
}
