#!/usr/bin/env node
/* 워크벤치 빌드 — app.html 을 비밀번호로 암호화해 ../index.html 로 출력한다.
   사용법:  WB_PASSWORD='비밀번호' node build.mjs
   비밀번호는 절대 이 파일이나 저장소에 적지 않는다. */
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const PASSWORD = process.env.WB_PASSWORD;
const ITER = 310000;

if (!PASSWORD) {
  console.error("WB_PASSWORD 환경변수가 필요합니다.\n예: WB_PASSWORD='...' node build.mjs");
  process.exit(1);
}

let htmlStr = readFileSync(join(HERE, "app.html"), "utf8");
// 비공개 시드(학생별 관심대학) 주입 — private-seed.json 은 저장소에 커밋하지 않는다
try {
  const seed = readFileSync(join(HERE, "private-seed.json"), "utf8");
  const marker = "const SEED_PRIV={univs:{},profiles:{}}; /*BUILD:PRIVATE_SEED*/";
  if (htmlStr.includes(marker)) {
    htmlStr = htmlStr.replace(marker, `const SEED_PRIV=${seed.trim()}; /*BUILD:PRIVATE_SEED*/`);
    console.log("비공개 시드 주입됨");
  }
} catch { console.log("비공개 시드 없음 — 빈 상태로 빌드"); }
// 대량 데이터(입결·학교)는 앱에 넣지 않는다 — 지연 로딩용 bulk.enc.json 으로 별도 암호화 (아래)
const html = Buffer.from(htmlStr, "utf8");
const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(PASSWORD, salt, ITER, 32, "sha256");
const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
// WebCrypto 는 인증 태그가 암호문 뒤에 붙어 있기를 기대한다
const ct = Buffer.concat([cipher.update(html), cipher.final(), cipher.getAuthTag()]);
const payload = JSON.stringify({
  s: salt.toString("base64"), i: iv.toString("base64"),
  c: ct.toString("base64"), it: ITER,
});

const out = readFileSync(join(HERE, "wrapper-template.html"), "utf8").replace("__PAYLOAD__", payload);
writeFileSync(join(HERE, "..", "index.html"), out);
console.log(`빌드 완료: app.html ${html.length}B → index.html ${out.length}B`);

// 자체 검증 — 브라우저와 같은 WebCrypto 경로로 복호화해 원본과 대조
const b2a = s => Uint8Array.from(Buffer.from(s, "base64"));
const P = JSON.parse(payload);
const km = await crypto.webcrypto.subtle.importKey("raw", new TextEncoder().encode(PASSWORD), "PBKDF2", false, ["deriveKey"]);
const k2 = await crypto.webcrypto.subtle.deriveKey(
  { name: "PBKDF2", salt: b2a(P.s), iterations: P.it, hash: "SHA-256" },
  km, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
const pt = await crypto.webcrypto.subtle.decrypt({ name: "AES-GCM", iv: b2a(P.i) }, k2, b2a(P.c));
if (!Buffer.from(pt).equals(html)) { console.error("검증 실패 — 배포하지 마세요"); process.exit(1); }
console.log("복호화 검증: 일치 ✓");

// ── 대량 데이터 지연 로딩 파일: gzip → 같은 키(같은 salt)·다른 IV 로 암호화 → ../bulk.enc.json
// 앱은 래퍼가 넘겨준 원시 키로 로그인 직후 이 파일을 받아 복호화한다.
import { gzipSync, gunzipSync } from "zlib";
try {
  const bulkRaw = readFileSync(join(HERE, "bulk-data.json"));
  const gz = gzipSync(bulkRaw, { level: 9 });
  const iv2 = crypto.randomBytes(12);
  const c2 = crypto.createCipheriv("aes-256-gcm", key, iv2);
  const ct2 = Buffer.concat([c2.update(gz), c2.final(), c2.getAuthTag()]);
  const env2 = JSON.stringify({ v: 1, inner: "gzip(bulk-data.json)",
    i: iv2.toString("base64"), c: ct2.toString("base64") });
  writeFileSync(join(HERE, "..", "bulk.enc.json"), env2);
  // 검증: WebCrypto 로 복호화 + gunzip 대조
  const rawKey = await crypto.webcrypto.subtle.exportKey("raw", k2);
  const k3 = await crypto.webcrypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const E = JSON.parse(env2);
  const dec = await crypto.webcrypto.subtle.decrypt({ name: "AES-GCM", iv: b2a(E.i) }, k3, b2a(E.c));
  if (!gunzipSync(Buffer.from(dec)).equals(bulkRaw)) { console.error("bulk 검증 실패 — 배포하지 마세요"); process.exit(1); }
  console.log(`대량 데이터 지연 파일: bulk.enc.json ${env2.length}B (원본 ${bulkRaw.length}B) — 검증 ✓`);
} catch (e) {
  if (e && e.code === "ENOENT") console.log("대량 데이터 없음 — bulk.enc.json 생략");
  else { console.error("bulk 빌드 실패:", e.message); process.exit(1); }
}
