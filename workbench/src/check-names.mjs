#!/usr/bin/env node
/* 공개 파일 실명 검사 — 학생 이름은 gitignored 시드(private-seed.json)에서 읽는다.
   이름 목록을 문서·스크립트에 직접 적으면 그 자체가 공개 저장소 노출이 되고, 학생이 늘면 목록이 낡는다
   (2026-10 — 문서의 검사 목록이 12명이라 14명 중 2명이 검사에서 빠져 있었다).
   사용법:  node workbench/src/check-names.mjs          (workbench/ + AGENTS.md 의 추적 파일)
            node workbench/src/check-names.mjs --all    (저장소 전체 추적 파일)
   결과 0건이면 통과(종료 코드 0). 걸리면 파일·줄 번호만 출력한다 — 이름 자체는 출력하지 않는다. */
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const seedPath = join(HERE, "private-seed.json");
if (!existsSync(seedPath)) { console.error("private-seed.json 없음 — workbench/backup/README.md 로 먼저 복원하세요"); process.exit(2); }
const seed = JSON.parse(readFileSync(seedPath, "utf8"));
const names = [...new Set((seed.students || []).map(s => (s.name || "").trim()).filter(n => n.length >= 2))];
if (!names.length) { console.error("시드에 학생 이름이 없습니다"); process.exit(2); }

const scope = process.argv.includes("--all") ? [] : ["workbench", "AGENTS.md"];
/* 셸을 거치지 않고 인자 배열로 넘긴다 — 예전에는 '경로' 를 작은따옴표로 감싸 셸에 줬는데, Windows(cmd.exe)는 작은따옴표를
   따옴표로 보지 않아 git 이 따옴표째 경로를 받고 아무 파일도 못 찾았다 → "파일 0개" 로 거짓 통과(2026-10-15 발견). */
const files = execFileSync("git", ["ls-files", "-z", ...scope], { cwd: ROOT })
  .toString().split("\0").filter(Boolean)
  .filter(f => !/\.(enc\.json|png|jpe?g|gif|webp|pdf|ico|woff2?|zip)$/i.test(f))
  .filter(f => !/^workbench\/(index\.html|bulk\.enc\.json)$/.test(f));   // 암호문
/* 검사할 파일이 하나도 없으면 통과가 아니다 — 경로 지정이 틀렸거나 저장소 밖에서 돌린 것이다 */
if (!files.length) { console.error("실명 검사 ✗ — 검사할 파일이 0개입니다(경로 지정·작업 폴더 확인). 통과로 치지 않습니다"); process.exit(2); }
let hits = 0;
for (const f of files) {
  let txt; try { txt = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
  if (txt.includes("\u0000")) continue;
  txt.split("\n").forEach((line, i) => {
    const n = names.filter(x => line.includes(x)).length;
    if (n) { hits += n; console.log(`  ✗ ${f}:${i + 1} — 실명 ${n}건`); }
  });
}
console.log(hits ? `실명 검사 ✗ — ${hits}건 (학생 ${names.length}명 기준, 파일 ${files.length}개). 커밋 금지.`
                 : `실명 검사 ✓ — 0건 (학생 ${names.length}명 기준, 파일 ${files.length}개)`);
process.exit(hits ? 1 : 0);
