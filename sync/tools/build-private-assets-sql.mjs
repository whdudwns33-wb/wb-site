#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PAGES_ROLLBACK_FLOOR = '2026-08-03.3';
const USAGE = [
  '사용법: --repo <경로> --roster-input <저장소 밖 절대 경로> --textbooks-input <저장소 밖 절대 경로>',
  '        --out <저장소 밖 SQL 절대 경로> --receipt <저장소 밖 build receipt 절대 경로>',
  '        --roster-sha <SHA256> --textbooks-sha <SHA256> --roster-students <수>',
  '        --textbook-students <수> --books <수> --vendors <수>'
].join('\n');
const ARGUMENTS = new Set([
  'repo', 'roster-input', 'textbooks-input', 'out', 'receipt',
  'roster-sha', 'textbooks-sha', 'roster-students', 'textbook-students', 'books', 'vendors'
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--') || i + 1 >= argv.length) fail(USAGE);
    const key = raw.slice(2);
    if (!ARGUMENTS.has(key)) fail(`알 수 없는 인수입니다: --${key}\n${USAGE}`);
    if (Object.hasOwn(args, key)) fail(`인수를 두 번 지정할 수 없습니다: --${key}`);
    args[key] = argv[++i];
  }
  return args;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function realDirectory(raw, label) {
  let resolved;
  try { resolved = fs.realpathSync.native(path.resolve(raw)); }
  catch { fail(`${label} 경로를 찾을 수 없습니다.`); }
  if (!fs.statSync(resolved).isDirectory()) fail(`${label}은 폴더여야 합니다.`);
  return resolved;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function realExternalFile(raw, repo, label) {
  if (!path.isAbsolute(raw)) fail(`${label}은 저장소 밖의 절대 경로여야 합니다.`);
  let resolved;
  try { resolved = fs.realpathSync.native(raw); }
  catch { fail(`${label} 파일을 찾을 수 없습니다.`); }
  if (!fs.statSync(resolved).isFile()) fail(`${label}은 파일이어야 합니다.`);
  if (isWithin(repo, resolved)) fail(`${label}은 공개 repository 밖에 있어야 합니다.`);
  return resolved;
}

function newExternalFile(raw, repo, label) {
  if (!path.isAbsolute(raw)) fail(`${label}은 저장소 밖의 절대 경로여야 합니다.`);
  const requested = path.resolve(raw);
  let parent;
  try { parent = fs.realpathSync.native(path.dirname(requested)); }
  catch { fail(`${label}의 상위 폴더를 먼저 만들어야 합니다.`); }
  if (!fs.statSync(parent).isDirectory()) fail(`${label}의 상위 경로는 폴더여야 합니다.`);
  const resolved = path.join(parent, path.basename(requested));
  if (isWithin(repo, resolved)) fail(`${label}은 공개 repository 밖에 있어야 합니다.`);
  if (fs.existsSync(resolved)) fail(`${label}이 이미 있습니다. 기존 파일을 덮어쓰지 않습니다.`);
  return resolved;
}

function pathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function expectedHash(value, label) {
  if (!/^[A-Fa-f0-9]{64}$/.test(String(value || ''))) fail(`${label} 예상 SHA-256 형식이 올바르지 않습니다.`);
  return String(value).toUpperCase();
}

function positiveCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) fail(`${label} 예상 개수는 1 이상이어야 합니다.`);
  return count;
}

function parsePagesVersion(value, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/.exec(String(value || ''));
  if (!match) fail(`${label} 형식이 올바르지 않습니다.`);
  return match.slice(1).map(Number);
}

function comparePagesVersion(left, right) {
  const a = parsePagesVersion(left, 'version.json v');
  const b = parsePagesVersion(right, 'Pages rollback floor');
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function readPagesVersion(repo) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(path.join(repo, 'version.json'), 'utf8')); }
  catch { fail('repository version.json을 읽을 수 없습니다.'); }
  const version = String(parsed && parsed.v || '');
  if (comparePagesVersion(version, PAGES_ROLLBACK_FLOOR) < 0) {
    fail(`Pages 버전 ${version}은 비공개 자산 rollback floor ${PAGES_ROLLBACK_FLOOR}보다 낮습니다.`);
  }
  return version;
}

function readAsset(sourcePath, spec, expected, expectedCounts) {
  const bytes = fs.readFileSync(sourcePath);
  const hash = sha256(bytes);
  if (hash !== expected) fail(`${spec.key} SHA-256 불일치: ${hash}`);

  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch { fail(`${spec.key} private input은 올바른 JSON이 아닙니다.`); }

  if (!data || typeof data !== 'object' || !Array.isArray(data.students)) {
    fail(`${spec.key} private input에 students 배열이 없습니다.`);
  }
  for (const collection of spec.sharedCollections) {
    if (!Array.isArray(data[collection])) fail(`${spec.key} private input에 ${collection} 배열이 없습니다.`);
  }

  const counts = Object.fromEntries(
    ['students', ...spec.sharedCollections].map(collection => [collection, data[collection].length])
  );
  for (const [collection, expectedCount] of Object.entries(expectedCounts)) {
    if (counts[collection] !== expectedCount) {
      fail(`${spec.key} ${collection} 개수 불일치: ${counts[collection]} (예상 ${expectedCount})`);
    }
  }

  return { key: spec.key, bytes, hash, counts };
}

function exclusiveWrite(file, bytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
      descriptor = undefined;
      try { fs.unlinkSync(file); } catch {}
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

const args = parseArgs(process.argv.slice(2));
const required = [...ARGUMENTS];
if (required.some(key => !args[key])) fail(USAGE);

const repo = realDirectory(args.repo, 'repository');
const pagesVersion = readPagesVersion(repo);
const rosterInput = realExternalFile(args['roster-input'], repo, 'roster private input');
const textbooksInput = realExternalFile(args['textbooks-input'], repo, 'textbooks private input');
if (pathKey(rosterInput) === pathKey(textbooksInput)) fail('roster와 textbooks private input은 서로 다른 파일이어야 합니다.');

const out = newExternalFile(args.out, repo, 'SQL output');
const receiptPath = newExternalFile(args.receipt, repo, 'build receipt');
const allPaths = [rosterInput, textbooksInput, out, receiptPath].map(pathKey);
if (new Set(allPaths).size !== allPaths.length) fail('private input, SQL output, build receipt 경로는 모두 달라야 합니다.');

const rosterHash = expectedHash(args['roster-sha'], 'roster');
const textbooksHash = expectedHash(args['textbooks-sha'], 'textbooks');
const specs = [
  { key: 'roster', sourcePath: rosterInput, sharedCollections: [] },
  { key: 'textbooks', sourcePath: textbooksInput, sharedCollections: ['books', 'vendors'] }
];
const assets = specs.map(spec => readAsset(
  spec.sourcePath,
  spec,
  spec.key === 'roster' ? rosterHash : textbooksHash,
  spec.key === 'roster'
    ? { students: positiveCount(args['roster-students'], 'roster students') }
    : {
        students: positiveCount(args['textbook-students'], 'textbooks students'),
        books: positiveCount(args.books, 'books'),
        vendors: positiveCount(args.vendors, 'vendors')
      }
));

const now = Date.now();
// `wrangler d1 execute --file`가 원격에서 파일 전체를 원자 적용하므로
// SQL 파일 안에 BEGIN/COMMIT을 넣지 않는다(중첩 transaction 오류 방지).
const statements = [];
for (const asset of assets) {
  const hex = asset.bytes.toString('hex');
  statements.push(
    `INSERT INTO private_assets (app,asset_key,data,updated_at,content_hash) ` +
    `VALUES ('task','${asset.key}',CAST(X'${hex}' AS TEXT),${now},'${asset.hash}') ` +
    `ON CONFLICT(app,asset_key) DO UPDATE SET ` +
    `data=excluded.data,updated_at=excluded.updated_at,content_hash=excluded.content_hash;`
  );
}
statements.push('');

const sqlBytes = Buffer.from(statements.join('\n'), 'utf8');
const sqlHash = sha256(sqlBytes);
const buildId = sha256(Buffer.from([
  'wb-private-assets-build-v1', pagesVersion, sqlHash,
  ...assets.map(asset => `${asset.key}:${asset.hash}:${JSON.stringify(asset.counts)}`)
].join('\n'), 'utf8'));
const assetReceipt = Object.fromEntries(assets.map(asset => [asset.key, {
  hash: asset.hash,
  bytes: asset.bytes.length,
  ...asset.counts
}]));
const receipt = {
  schemaVersion: 1,
  kind: 'wb-private-assets-build',
  buildId,
  createdAt: new Date(now).toISOString(),
  updatedAt: now,
  app: 'task',
  pagesVersion,
  pagesRollbackFloor: PAGES_ROLLBACK_FLOOR,
  sourcePolicy: 'explicit-external-input-only',
  sourcePathsStored: false,
  gitHistoryVerified: false,
  assets: assetReceipt,
  sql: { sha256: sqlHash, bytes: sqlBytes.length }
};
const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

let sqlCreated = false;
try {
  exclusiveWrite(out, sqlBytes);
  sqlCreated = true;
  exclusiveWrite(receiptPath, receiptBytes);
} catch (error) {
  if (sqlCreated) {
    try { fs.unlinkSync(out); } catch {}
  }
  fail(`SQL/build receipt를 만들지 못했습니다: ${error.message}`);
}

console.log(JSON.stringify({
  ok: true,
  buildId,
  pagesVersion,
  sqlSha256: sqlHash,
  receiptSha256: sha256(receiptBytes),
  assets: assetReceipt
}, null, 2));
