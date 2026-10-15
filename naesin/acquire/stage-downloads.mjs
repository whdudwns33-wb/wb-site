import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {normalizeUnit, folderScope} from './acquire.mjs';

export const DEFAULT_SOURCE_ROOT = 'C:\\Users\\wb\\Downloads';
// 2026-10-13: 실제 L1 디렉터리를 Node UTF-8로 읽어 대조한 이름. 원본 파일은 변경하지 않는다.
export const NAMES = [
  '00_교과서본문.pdf', '01_내용정리.pdf', '02_본문워크북.pdf', '03_단어시험.pdf',
  '04_예상문제_PRE-STEP.pdf', '04_예상문제_PRE-STEP_교사용.pdf',
  '05_예상문제_1회.pdf', '05_예상문제_1회_교사용.pdf',
  '06_예상문제_2회.pdf', '06_예상문제_2회_교사용.pdf',
  '07_문법워크북.pdf', '08_문법객관식.pdf', '09_문법주관식.pdf'
];
const reject = message => { throw Error(message); };
const unsafeText = s => /(?:[a-z][a-z\d+.-]*:\/\/|\b(?:https?|file|data|javascript):|\b(?:bearer|cookie|password|authorization|token)\s*[:=])/i.test(s);
function text(s, label) {
  if (typeof s !== 'string' || !s || /[\x00-\x1f\x7f]/.test(s) || unsafeText(s)) reject('Invalid '+label);
  return s;
}
function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('Invalid '+label);
  for (const k of Object.keys(value)) if (!allowed.includes(k)) reject('Unexpected '+label+' field');
}
function basename(s) {
  text(s, 'basename');
  if (/[\\/:*?"<>|]/.test(s) || /[. ]$/.test(s) || s === '.' || s === '..' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) reject('Invalid basename');
  return s;
}
function absolute(s, label) {
  text(s, label);
  if (!path.isAbsolute(s) || /^(?:\\\\|\/\/)/.test(s) || (process.platform === 'win32' && /:/.test(s.slice(2)))) reject('Invalid absolute '+label);
  return path.resolve(s);
}
function inside(root, target) {
  const rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel)) reject('Path outside allowed root');
  return target;
}
async function inspectPath(target, allowMissing = false) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); } catch (e) {
      if (e.code === 'ENOENT' && allowMissing) return null;
      throw e;
    }
    if (stat.isSymbolicLink()) reject('Symlink forbidden');
    if (current !== target && !stat.isDirectory()) reject('Non-directory ancestor');
  }
  return fs.lstat(target);
}
function compareName(name) {
  let s = name.normalize('NFC').replace(/\.pdf$/i, '').trimEnd();
  let revisionRemoved = false, duplicateRemoved = false;
  // 원본에는 손대지 않는다. 확인된 6/8자리 수정일과 다운로드 중복 번호를 순서와 무관하게 각 한 번만 제외한다.
  const revision = /\s*_\s*\(\s*(?:\d{8}|\d{6})\s*수정\s*\)\s*$/u;
  const duplicate = /\s*\(\d+\)\s*$/u;
  for (let i = 0; i < 2; i++) {
    if (!revisionRemoved && revision.test(s)) {
      s = s.replace(revision, '').trimEnd(); revisionRemoved = true;
    } else if (!duplicateRemoved && duplicate.test(s)) {
      s = s.replace(duplicate, '').trimEnd(); duplicateRemoved = true;
    } else break;
  }
  return s;
}
export function classifyDownload(name) {
  basename(name);
  if (!/\.pdf$/i.test(name)) reject('Non-PDF extension');
  const s = compareName(name);
  // 통합본의 (1~10)은 단계 번호가 아니다. 코드가 있더라도 분리 단계 검사를 먼저 한다.
  const stage = s.match(/본문\s*10\s*단계\s*워크북\s*(10|[1-9])(?=\s|_).*_단계별$/u);
  if (stage && !/통합본/u.test(s)) return {filename: '_raw/'+name, stage: Number(stage[1])};
  const code = s.match(/(?:^|_)(\[0[1-9]\])\s*(.*)$/u);
  if (!code) {
    if (/(?:^|_)본문$/.test(s)) return {filename: NAMES[0], stage: null};
    reject('Unclassified filename');
  }
  const title = code[2], n = Number(code[1].slice(1, -1));
  const teacher = /\(교사용\)$/.test(title);
  const clean = title.replace(/\s*\(교사용\)$/, '').trim();
  const rules = {
    1: [/^내용정리\s*플러스$/, 1],
    2: [/^본문\s*10\s*단계\s*워크북\s*통합본\s*\(1\s*[~～-]\s*10\)$/, 2],
    3: [/^WORD\s+TEST$/i, 3],
    4: [/^예상문제\s+PRE-STEP$/i, 4],
    5: [/^예상문제\s*1회$/, 6],
    6: [/^예상문제\s*2회$/, 8],
    7: [/^Grammar\s+Build\s+Up\s+워크북$/i, 10],
    8: [/^(?:Grammar\s+Build\s+Up\s+)?(?:문법\s*)?객관식$/i, 11],
    9: [/^(?:Grammar\s+Build\s+Up\s+)?(?:문법\s*)?주관식$/i, 12]
  };
  const rule = rules[n];
  if (!rule || !rule[0].test(clean) || (teacher && ![4,5,6].includes(n))) reject('Unclassified filename');
  return {filename: NAMES[rule[1]+(teacher ? 1 : 0)], stage: null};
}
function validateScope(s) {
  keys(s, ['curriculum','grade','publisher','publisherLabel','unitRawLabel','unitCode','folderName'], 'scope');
  for (const k of ['curriculum','grade','publisher','publisherLabel','unitRawLabel','unitCode','folderName']) text(s[k], 'scope');
  if (!s.publisherLabel.trim()) reject('Missing publisherLabel');
  if (!['2022','2015'].includes(s.curriculum) || !/^m[123]$/.test(s.grade) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.publisher)) reject('Invalid scope');
  basename(s.folderName);
  if (normalizeUnit(s.unitRawLabel) !== s.unitCode || !/^(?:L(?:[1-9]|1[0-2])|S[LR][12]?)$/.test(s.unitCode)) reject('Unit scope mismatch');
  const f = folderScope(s.folderName);
  if (!f || ['curriculum','grade','publisher','unitCode'].some(k => f[k] !== s[k])) reject('Folder scope mismatch');
}
// 출판사 표기와 안정 슬러그의 연결은 호출자가 확인한다. 음역·대응표를 추측하지 않는다.
const publisherText = value => value.normalize('NFC').trim();
export function checkFilenameScope(name, scope, requirePublisher = false) {
  const s = compareName(name);
  const curriculum = s.match(/\((2022|2015)개정\)/);
  const grade = s.match(/(?:^|_)중([123])(?:_|$)/);
  if (curriculum && curriculum[1] !== scope.curriculum) reject('Filename curriculum mismatch');
  if (grade && 'm'+grade[1] !== scope.grade) reject('Filename grade mismatch');
  const units = s.split('_').map(x => normalizeUnit(x)).filter(Boolean);
  if (units.some(x => x !== scope.unitCode)) reject('Filename unit mismatch');
  const pub = s.match(/(?:^|_)중[123]_([^_]+)_/);
  if (!pub && requirePublisher) reject('Filename publisher missing');
  if (pub && publisherText(pub[1]) !== publisherText(scope.publisherLabel)) reject('Filename publisher label mismatch');
}
async function digest(file) {
  const stat = await inspectPath(file);
  if (!stat.isFile() || !stat.size) reject('Missing, empty, or non-file PDF');
  if (!/\.pdf$/i.test(file)) reject('Non-PDF extension');
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(5);
    await handle.read(head, 0, 5, 0);
    if (head.toString() !== '%PDF-') reject('Invalid PDF magic');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({start:0, autoClose:false})) { hash.update(chunk); bytes += chunk.length; }
    const after = await handle.stat();
    if (bytes !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) reject('File changed while reading');
    return {bytes, sha256:hash.digest('hex')};
  } finally { await handle.close(); }
}
async function existing(file, expected) {
  if (!await inspectPath(file, true)) return false;
  const found = await digest(file);
  if (found.sha256 !== expected.sha256 || found.bytes !== expected.bytes) reject('Destination conflict');
  return true;
}
export async function preflight(input, options = {}) {
  keys(input, ['root','scope','files','source'], 'input');
  validateScope(input.scope);
  if (!Array.isArray(input.files) || !input.files.length) reject('Empty files list');
  let source;
  if (input.source !== undefined) {
    keys(input.source, ['listingId','title','catalogLabel','observedAt'], 'source');
    source = {};
    for (const [k,v] of Object.entries(input.source)) source[k] = v === null ? null : text(v, 'source');
  }
  if (!options.root && !input.root) reject('Missing explicit root');
  const root = absolute(options.root || input.root, 'root');
  const sourceRoot = absolute(options.sourceRoot || DEFAULT_SOURCE_ROOT, 'source root');
  if (input.root !== undefined) absolute(input.root, 'input root');
  const rootStat = await inspectPath(root, true), sourceStat = await inspectPath(sourceRoot);
  if ((rootStat && !rootStat.isDirectory()) || !sourceStat.isDirectory()) reject('Root must be directory');
  const folder = inside(root, path.join(root, input.scope.folderName));
  const receiptDir = inside(root, path.join(root, '_acquisition', 'receipts'));
  for (const p of [folder, path.join(folder, '_raw'), receiptDir]) {
    const st = await inspectPath(p, true);
    if (st && !st.isDirectory()) reject('Destination directory conflict');
  }
  const entries = [], destinations = new Map();
  for (const item of input.files) {
    keys(item, ['src','suggestedFilename'], 'file');
    const src = inside(sourceRoot, absolute(item.src, 'src'));
    basename(path.basename(src));
    const classification = classifyDownload(item.suggestedFilename);
    checkFilenameScope(item.suggestedFilename, input.scope, true);
    checkFilenameScope(path.basename(src), input.scope);
    const destination = inside(folder, path.join(folder, classification.filename));
    const info = await digest(src);
    const same = destinations.get(destination.normalize('NFC').toLowerCase());
    if (same && same.sha256 !== info.sha256) reject('Batch destination conflict');
    const present = await existing(destination, info);
    const entry = {src, sourceName:path.basename(src), suggestedFilename:item.suggestedFilename,
      destination:path.relative(root, destination).split(path.sep).join('/'), ...info,
      outcome:present ? 'already_present' : 'pending'};
    entries.push(entry);
    destinations.set(destination.normalize('NFC').toLowerCase(), entry);
  }
  return {root, receiptDir, scope:{...input.scope}, ...(source ? {source} : {}), entries};
}
async function mkdirSafe(dir) {
  await inspectPath(dir, true);
  await fs.mkdir(dir, {recursive:true});
  if (!(await inspectPath(dir)).isDirectory()) reject('Invalid directory');
}
async function writeReceipt(plan, result) {
  await mkdirSafe(plan.receiptDir);
  const id = 'stage-'+result.timestamp.replace(/[:.]/g, '-')+'-'+randomUUID()+'.json';
  const dest = path.join(plan.receiptDir, id), temp = dest+'.tmp-'+randomUUID();
  const handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(JSON.stringify(result, null, 2)+'\n'); await handle.sync(); }
  finally { await handle.close(); }
  // 고유 UUID 목적지와 전용 임시파일. 기존 영수증은 재사용하지 않는다.
  await fs.rename(temp, dest);
  return path.relative(plan.root, dest).split(path.sep).join('/');
}
async function copyOne(entry, destination) {
  await mkdirSafe(path.dirname(destination));
  if (await existing(destination, entry)) return 'already_present';
  const temp = path.join(path.dirname(destination), '.stage-'+randomUUID()+'.pdf');
  const source = await fs.open(entry.src, 'r');
  let target;
  try {
    target = await fs.open(temp, 'wx');
    for await (const chunk of source.createReadStream({autoClose:false})) await target.writeFile(chunk);
    await target.sync();
  } finally { await source.close(); if (target) await target.close(); }
  const copied = await digest(temp);
  if (copied.sha256 !== entry.sha256 || copied.bytes !== entry.bytes) reject('Source changed after preflight');
  await inspectPath(destination, true);
  // rename은 POSIX/Windows에서 경쟁 목적지를 덮어쓸 수 있어 link로 배타적으로 공개한다.
  // 같은 폴더의 fsync 완료 파일을 공개한다. 하드링크 미지원 파일시스템은 실패시킨다.
  try { await fs.link(temp, destination); }
  catch (e) {
    if (e.code !== 'EEXIST' || !await existing(destination, entry)) throw e;
    await fs.unlink(temp).catch(() => {});
    return 'already_present';
  }
  await fs.unlink(temp).catch(() => {}); // 도구의 임시이름만 제거. 원본과 목적지는 삭제하지 않는다.
  return 'copied';
}
export async function stageDownloads(input, options = {}) {
  const plan = await preflight(input, options); // 여기까지 완전히 읽기 전용. 실패하면 영수증도 만들지 않는다.
  const result = {version:1, timestamp:new Date().toISOString(), scope:plan.scope,
    ...(plan.source ? {source:plan.source} : {}), status:'complete',
    files:plan.entries.map(({src, ...entry}) => ({...entry}))};
  let failed = false;
  for (let i=0; i<plan.entries.length; i++) {
    const entry = plan.entries[i];
    if (failed) { result.files[i].outcome = 'not_attempted'; continue; }
    try {
      // 복사 직전에도 원본과 목적지의 링크 및 해시를 확인한다.
      const fresh = await digest(entry.src);
      if (fresh.sha256 !== entry.sha256 || fresh.bytes !== entry.bytes) reject('Source changed after preflight');
      result.files[i].outcome = await copyOne(entry, path.join(plan.root, entry.destination));
    } catch {
      failed = true;
      result.status = 'partial';
      result.files[i].outcome = 'failed';
      result.files[i].error = 'COPY_FAILED'; // OS 예외에 포함될 수 있는 원본 절대 경로는 기록하지 않는다.
    }
  }
  try { result.receipt = await writeReceipt(plan, result); }
  catch {
    result.receipt = null;
    result.status = 'receipt_failed';
  }
  return result;
}
export async function runStage(args) {
  const opts = {};
  for (let i=0;i<args.length;i+=2) {
    if (!['--input','--root','--source-root'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--') || opts[args[i]]) reject('Usage: stage-downloads.mjs --input batch.json [--root ROOT] [--source-root DIR]');
    opts[args[i]] = args[i+1];
  }
  if (!opts['--input']) reject('Missing --input');
  const inputPath = absolute(path.resolve(opts['--input']), 'input');
  await inspectPath(inputPath);
  return stageDownloads(JSON.parse(await fs.readFile(inputPath, 'utf8')), {root:opts['--root'], sourceRoot:opts['--source-root']});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStage(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'complete') process.exitCode = 2;
  }).catch(() => { console.error('Staging preflight/configuration failed; no batch files written. Check explicit paths, scope, PDF bytes and destination conflicts.'); process.exitCode = 1; });
}
