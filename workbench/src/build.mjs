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

const html = readFileSync(join(HERE, "app.html"));
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
