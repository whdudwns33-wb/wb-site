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
const ISSUES_DIR = path.join(HERE, 'issues');
const MANIFEST = path.join(HERE, 'issues.json');
/* 기본 대상 — 파일럿 호 전부(issues/*.json) + 체험 호. 저장소에 든 호는 모두 오류 0 이어야 한다 */
export function defaultFiles() {
  const out = fs.existsSync(ISSUES_DIR) ? fs.readdirSync(ISSUES_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(ISSUES_DIR, f)) : [];
  for (const f of ['issue-pilot.json', 'issue-sample.json']) { const q = path.join(HERE, f); if (fs.existsSync(q)) out.push(q); }
  return out;
}
const DEFAULTS = defaultFiles();

/* 호 목록(issues.json)과 실제 파일이 어긋나면 앱이 없는 파일을 부르거나 새 호를 못 본다 —
   파일을 넣고 목록에 안 적는 실수가 가장 흔해서 여기서 막는다 */
export function checkManifest() {
  const errors = [];
  if (!fs.existsSync(MANIFEST)) return { errors: [{ where: 'issues.json', msg: '호 목록이 없습니다' }], issues: [] };
  let man;
  try { man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
  catch (e) { return { errors: [{ where: 'issues.json', msg: 'JSON 을 읽을 수 없어요 — ' + e.message }], issues: [] };
  }
  const rows = Array.isArray(man && man.issues) ? man.issues : [];
  if (!rows.length) errors.push({ where: 'issues.json', msg: 'issues 목록이 비었습니다' });
  const listed = new Set();
  for (const b of rows) {
    if (!b || !b.file) { errors.push({ where: 'issues.json', msg: 'file 없는 줄이 있습니다' }); continue; }
    listed.add(b.file);
    const full = path.join(ISSUES_DIR, b.file);
    if (!fs.existsSync(full)) { errors.push({ where: 'issues.json ' + b.file, msg: '목록에 있는 파일이 없습니다' }); continue; }
    let issue;
    try { issue = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { continue; }   // 본문 오류는 validateFile 이 잡는다
    for (const k of ['id', 'week', 'title', 'publishAt', 'status']) {
      if (String(b[k] == null ? '' : b[k]) !== String(issue[k] == null ? '' : issue[k])) {
        errors.push({ where: 'issues.json ' + b.file, msg: k + ' 가 호 본문과 다릅니다(목록 "' + b[k] + '" · 본문 "' + issue[k] + '")' });
      }
    }
  }
  for (const f of (fs.existsSync(ISSUES_DIR) ? fs.readdirSync(ISSUES_DIR).filter((x) => x.endsWith('.json')) : [])) {
    if (!listed.has(f)) errors.push({ where: 'issues/' + f, msg: '호 파일이 목록(issues.json)에 없습니다 — 앱이 이 호를 열지 못합니다' });
  }
  return { errors, issues: rows };
}

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
  /* 목록 대조는 기본 대상일 때만 — 파일 하나를 콕 집어 부를 때는 그 파일만 본다 */
  if (!process.argv.slice(2).length) {
    const man = checkManifest();
    console.log('\nissues.json — 호 ' + man.issues.length + '개');
    for (const e of man.errors) console.log(`  ✗ [${e.where}] ${e.msg}`);
    if (!man.errors.length) console.log('  ✓ 목록과 파일이 일치');
    if (man.errors.length) bad += 1;
  }
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
