#!/usr/bin/env node
'use strict';
/* 브레인레터 호 검증기 — node letter/issue-validate.mjs [파일…]
 *
 * 파일을 안 주면 저장소의 호를 전부 본다(issue-pilot.json·issue-sample.json).
 * 파일럿은 `/letter/` 가 링크만으로 여는 **살아 있는 호**다 — main 에 합치는 순간 가정 화면이 바뀐다.
 * 그래서 사람이 관리 웹을 거치지 않고 JSON 을 고칠 때도 같은 규칙으로 막아야 한다.
 *
 * 규칙은 여기 없다 — letter/letter.js 의 checkIssue 하나다(관리 웹 [검증]·서버 저장·AI 초안이 같은 것을 쓴다).
 * 이 파일이 하는 일은 파일을 읽어 주고, 파일 수준 오류(파싱 실패·id 와 파일명 불일치)를 붙여 사람이 읽게 찍는 것뿐이다.
 *
 * 나가는 값: 오류가 하나라도 있으면 1(경고만 있으면 0). */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const L = require('./letter.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = ['issue-pilot.json', 'issue-sample.json'].map((f) => path.join(HERE, f)).filter((f) => fs.existsSync(f));

export function validateFile(file) {
  const name = path.basename(file);
  let issue;
  try { issue = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { file: name, errors: [{ where: 'file', msg: 'JSON 을 읽을 수 없어요 — ' + e.message }], warnings: [], issue: null }; }
  const r = L.checkIssue(issue);
  const errors = r.errors.slice(), warnings = r.warnings.slice();
  /* 자체 창작 표시는 검증기가 형식만 본다 — 저장소에 두는 호는 라이선스 글이면 안 된다(CLAUDE.md 절대 규칙 1) */
  if (issue && typeof issue.source === 'string' && !/자체 창작/.test(issue.source)) {
    warnings.push({ where: 'source', msg: '저장소에 두는 호는 자체 창작이어야 한다 — source 에 "자체 창작" 표시가 없다' });
  }
  return { file: name, errors, warnings, issue };
}

/* 직접 실행할 때만 찍는다 — 테스트는 validateFile 만 쓴다 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;
  if (!files.length) { console.error('검증할 호 파일이 없습니다. 사용법: node letter/issue-validate.mjs <호.json>'); process.exit(1); }
  let bad = 0;
  for (const f of files) {
    const r = validateFile(f);
    const head = r.issue ? `${r.issue.id || '?'} 「${r.issue.title || '?'}」 · ${(r.issue.sections || []).length}섹션 · ${r.issue.status || '?'}` : '읽기 실패';
    console.log(`\n${r.file} — ${head}`);
    for (const e of r.errors) console.log(`  ✗ [${e.where}] ${e.msg}`);
    for (const w of r.warnings) console.log(`  · [${w.where}] ${w.msg}`);
    if (!r.errors.length && !r.warnings.length) console.log('  ✓ 오류·경고 없음');
    else if (!r.errors.length) console.log('  ✓ 오류 없음(경고는 발행을 막지 않는다)');
    if (r.errors.length) bad += 1;
  }
  console.log(bad ? `\n오류가 있는 호 ${bad}개 — 고치기 전에는 합치지 않는다.` : '\n모두 통과.');
  process.exit(bad ? 1 : 0);
}
