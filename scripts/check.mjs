#!/usr/bin/env node
'use strict';
/* 저장소 전체 검증 한 방 — node scripts/check.mjs
 *
 * 에이전트(Codex·Claude Code)와 사람이 고친 뒤 무엇을 돌려야 하는지 찾아다니지 않게 하는 입구다.
 * 앱마다 테스트 실행법이 달랐고(파일별 node 실행, 앱별 README), 배포 워크플로우는 55개만 부른다 —
 * 그래서 haru/·sync/·task/ 처럼 목록에 없는 테스트는 고쳐도 아무도 안 돌려 본 채 들어갔다.
 * 여기서는 저장소의 *.test.cjs / *.test.mjs 를 전부 찾아 돌린다(외부 의존성 없음, 망 안 탐).
 *
 * 사용법:
 *   node scripts/check.mjs               전부 (CPU 만큼 병렬, 2분 안쪽)
 *   node scripts/check.mjs --only letter 경로에 letter 가 든 것만 (고친 앱만 빠르게)
 *   node scripts/check.mjs --list        돌릴 목록만 출력
 *   node scripts/check.mjs --serial      한 개씩 (출력이 섞이지 않게)
 *
 * 나가는 값: 하나라도 실패하면 1. CI 와 사람이 같은 판정을 쓴다. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 들어가지 않는 폴더 — 남의 코드(node_modules)·빌드 산출물·로컬 데이터. .private 은 운영 학생 원본이다 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', 'data', '.local', '.private', 'fonts']);
const TEST_RE = /\.test\.(cjs|mjs)$/;

function findTests(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) findTests(path.join(dir, ent.name), out); continue; }
    if (TEST_RE.test(ent.name)) out.push(path.relative(ROOT, path.join(dir, ent.name)));
  }
  return out;
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const only = valueOf('--only');

let tests = findTests(ROOT).sort();
if (only) tests = tests.filter((f) => f.includes(only));
if (!tests.length) { console.error(only ? `--only ${only} 에 맞는 테스트가 없습니다.` : '테스트를 찾지 못했습니다.'); process.exit(1); }
if (has('--list')) { console.log(tests.join('\n')); process.exit(0); }

const run = (file) => new Promise((resolve) => {
  const t0 = Date.now();
  /* 테스트는 저장소 뿌리에서 돈다 — 상대 경로로 자료를 읽는 테스트가 있어 실행 위치가 바뀌면 깨진다 */
  execFile(process.execPath, [file], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ file, ok: !err, ms: Date.now() - t0, out: ((stdout || '') + (stderr || '')).trimEnd() });
  });
});

const lanes = has('--serial') ? 1 : Math.max(1, Math.min(8, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1));
const queue = tests.slice();
const results = [];
let done = 0;

async function worker() {
  for (let file = queue.shift(); file; file = queue.shift()) {
    const r = await run(file);
    results.push(r);
    done += 1;
    /* 실패는 그 자리에서 전부 보여 준다 — 끝까지 기다렸다 보면 어느 변경이 깼는지 잇기 어렵다 */
    if (!r.ok) console.log(`\n✗ ${r.file}\n${r.out.split('\n').slice(-25).join('\n')}\n`);
    else if (!process.stdout.isTTY) console.log(`  ✓ ${r.file} (${r.ms}ms)`);
    else process.stdout.write(`\r  ${done}/${tests.length} ${r.file.padEnd(60).slice(0, 60)}`);
  }
}

const t0 = Date.now();
console.log(`wb-site 검증 — 테스트 ${tests.length}개${only ? ` (--only ${only})` : ''}, 동시 ${lanes}`);
await Promise.all(Array.from({ length: lanes }, worker));
if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(70) + '\r');

const failed = results.filter((r) => !r.ok).map((r) => r.file).sort();
const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (failed.length) {
  console.log(`\n실패 ${failed.length}/${tests.length} (${secs}초)\n` + failed.map((f) => '  ✗ ' + f).join('\n'));
  console.log('\n한 개만 다시: node <위 경로>');
  process.exit(1);
}
console.log(`통과 ${tests.length}/${tests.length} (${secs}초). 배포 CI 는 이 가운데 진로독서 워커 몫만 다시 돌린다.`);
