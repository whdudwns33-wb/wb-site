#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PAGES_ROLLBACK_FLOOR = '2026-08-03.3';
const PUBLIC_STUB_DATE = '2026-08-03';
const MAX_BUILD_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_D1_RECEIPT_AGE_MS = 60 * 60 * 1000;
const USAGE = [
  '사용법: --repo <경로> --roster-input <저장소 밖 절대 경로> --textbooks-input <저장소 밖 절대 경로>',
  '        --roster-sha <SHA256> --textbooks-sha <SHA256> --build-receipt <저장소 밖 build receipt>',
  '        --d1-receipt <저장소 밖 D1 검증 receipt> --sanitize-receipt <저장소 밖 새 receipt>',
  '        --database-id <운영 D1 database_id>'
].join('\n');
const ARGUMENTS = new Set([
  'repo', 'roster-input', 'textbooks-input', 'roster-sha', 'textbooks-sha',
  'build-receipt', 'd1-receipt', 'sanitize-receipt', 'database-id'
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--') || index + 1 >= argv.length) fail(USAGE);
    const key = raw.slice(2);
    if (!ARGUMENTS.has(key)) fail(`알 수 없는 인수입니다: --${key}\n${USAGE}`);
    if (Object.hasOwn(args, key)) fail(`인수를 두 번 지정할 수 없습니다: --${key}`);
    args[key] = argv[++index];
  }
  return args;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function pathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function realDirectory(raw, label) {
  let resolved;
  try { resolved = fs.realpathSync.native(path.resolve(raw)); }
  catch { fail(`${label} 경로를 찾을 수 없습니다.`); }
  if (!fs.statSync(resolved).isDirectory()) fail(`${label}은 폴더여야 합니다.`);
  return resolved;
}

function realExternalFile(raw, repo, label) {
  if (!path.isAbsolute(raw)) fail(`${label}은 저장소 밖의 절대 경로여야 합니다.`);
  let resolved;
  try { resolved = fs.realpathSync.native(raw); }
  catch { fail(`${label} 파일을 찾을 수 없습니다.`); }
  if (!fs.statSync(resolved).isFile()) fail(`${label}은 일반 파일이어야 합니다.`);
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

function expectedHash(value, label) {
  if (!/^[A-Fa-f0-9]{64}$/.test(String(value || ''))) fail(`${label} SHA-256 형식이 올바르지 않습니다.`);
  return String(value).toUpperCase();
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

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail(`${label} JSON을 읽을 수 없습니다.`); }
}

function readPrivateAsset(file, key, expected) {
  const bytes = fs.readFileSync(file);
  const hash = sha256(bytes);
  if (hash !== expected) fail(`${key} private input SHA-256 불일치: ${hash}`);
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch { fail(`${key} private input은 올바른 JSON이 아닙니다.`); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.students)) {
    fail(`${key} private input에 students 배열이 없습니다.`);
  }
  const collections = key === 'textbooks' ? ['books', 'vendors'] : [];
  for (const collection of collections) {
    if (!Array.isArray(data[collection])) fail(`${key} private input에 ${collection} 배열이 없습니다.`);
  }
  const counts = Object.fromEntries(
    ['students', ...collections].map(collection => [collection, data[collection].length])
  );
  for (const count of Object.values(counts)) {
    if (!Number.isSafeInteger(count) || count < 1) fail(`${key} private input 개수는 모두 1 이상이어야 합니다.`);
  }
  return { key, bytes, hash, counts };
}

function sameAssetSummary(actual, expected) {
  const expectedBytes = Buffer.isBuffer(expected.bytes) ? expected.bytes.length : expected.bytes;
  if (!actual || actual.hash !== expected.hash || actual.bytes !== expectedBytes) return false;
  return Object.entries(expected.counts).every(([key, value]) => actual[key] === value);
}

function validateBuildReceipt(receipt, pagesVersion, assets, now) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== 'wb-private-assets-build' ||
      receipt.app !== 'task' || receipt.pagesVersion !== pagesVersion ||
      receipt.pagesRollbackFloor !== PAGES_ROLLBACK_FLOOR ||
      receipt.sourcePolicy !== 'explicit-external-input-only' ||
      receipt.sourcePathsStored !== false || receipt.gitHistoryVerified !== false ||
      !/^[A-F0-9]{64}$/.test(String(receipt.buildId || '')) ||
      !/^[A-F0-9]{64}$/.test(String(receipt.sql && receipt.sql.sha256 || '')) ||
      !Number.isSafeInteger(receipt.sql && receipt.sql.bytes) || receipt.sql.bytes < 1 ||
      !Number.isSafeInteger(receipt.updatedAt)) {
    fail('build receipt 형식 또는 rollback floor가 올바르지 않습니다.');
  }
  const createdAt = Date.parse(receipt.createdAt);
  if (!Number.isFinite(createdAt) || Math.abs(createdAt - receipt.updatedAt) > 1000 ||
      createdAt < now - MAX_BUILD_AGE_MS || createdAt > now + 5 * 60 * 1000) {
    fail('build receipt가 만료되었거나 시간이 올바르지 않습니다.');
  }
  for (const asset of assets) {
    if (!sameAssetSummary(receipt.assets && receipt.assets[asset.key], asset)) {
      fail(`build receipt의 ${asset.key} 정보가 private input과 일치하지 않습니다.`);
    }
  }
  const expectedBuildId = sha256(Buffer.from([
    'wb-private-assets-build-v1', pagesVersion, receipt.sql.sha256,
    ...assets.map(asset => `${asset.key}:${asset.hash}:${JSON.stringify(asset.counts)}`)
  ].join('\n'), 'utf8'));
  if (receipt.buildId !== expectedBuildId) fail('build receipt buildId가 재계산 결과와 일치하지 않습니다.');
  return receipt;
}

function validateD1Receipt(receipt, databaseId, build, assets, now) {
  const verifiedAt = Number(receipt && receipt.verifiedAt);
  if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== 'wb-private-assets-d1-verification' ||
      receipt.verified !== true || receipt.app !== 'task' || receipt.databaseId !== databaseId ||
      receipt.buildId !== build.buildId || receipt.sqlSha256 !== build.sql.sha256 ||
      receipt.rowCount !== 2 || receipt.jsonValid !== 2 ||
      !Number.isSafeInteger(verifiedAt) || verifiedAt < now - MAX_D1_RECEIPT_AGE_MS ||
      verifiedAt > now + 5 * 60 * 1000 ||
      !/^[A-Za-z0-9_.:-]{8,128}$/.test(String(receipt.operationId || '')) ||
      typeof receipt.workerDeploymentId !== 'string' || receipt.workerDeploymentId.length < 3 ||
      typeof receipt.workerOrigin !== 'string' || !receipt.workerOrigin.startsWith('https://') ||
      receipt.adminScopeVerified !== true || receipt.personScopeVerified !== true) {
    fail('운영 D1 검증 receipt가 없거나, build 연결이 없거나, 만료되었습니다.');
  }
  for (const asset of assets) {
    const actual = receipt.assets && receipt.assets[asset.key];
    if (!sameAssetSummary(actual, asset) || actual.updatedAt !== build.updatedAt ||
        actual.jsonValid !== true || actual.contentHashVerified !== true) {
      fail(`D1 ${asset.key} 검증 결과가 build/private input과 일치하지 않습니다.`);
    }
  }
  return receipt;
}

function canonicalStubs() {
  return {
    roster: {
      updated: PUBLIC_STUB_DATE,
      baseline: PUBLIC_STUB_DATE.slice(0, 7),
      note: '인증된 운영 앱에서만 제공되는 자료입니다.',
      students: []
    },
    textbooks: {
      updated: PUBLIC_STUB_DATE,
      note: '인증된 운영 앱에서만 제공되는 자료입니다.',
      vendors: [],
      books: [],
      students: []
    }
  };
}

function stubBytes(stub) {
  return Buffer.from(`${JSON.stringify(stub, null, 2)}\n`, 'utf8');
}

function preflightPublicTarget(repo, relative, asset, stub) {
  const requested = path.join(repo, ...relative.split('/'));
  let info;
  try { info = fs.lstatSync(requested); }
  catch { fail(`공개 target ${relative}를 찾을 수 없습니다.`); }
  if (!info.isFile() || info.isSymbolicLink()) fail(`공개 target ${relative}는 symlink가 아닌 일반 파일이어야 합니다.`);
  const real = fs.realpathSync.native(requested);
  if (!isWithin(repo, real) || pathKey(real) !== pathKey(path.resolve(requested))) {
    fail(`공개 target ${relative}가 repository 밖을 가리킵니다.`);
  }
  const current = fs.readFileSync(real);
  if (sha256(current) === asset.hash) return { key: asset.key, file: real, original: current, action: 'private-to-stub' };
  let parsed;
  try { parsed = JSON.parse(current.toString('utf8')); }
  catch { fail(`공개 target ${relative}가 private input도 canonical stub도 아닙니다.`); }
  if (JSON.stringify(parsed) !== JSON.stringify(stub)) {
    fail(`공개 target ${relative}가 private input도 canonical stub도 아닙니다.`);
  }
  return { key: asset.key, file: real, original: current, action: 'stub-refresh' };
}

function durableWrite(file, bytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'w');
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeStubPair(targets, expectedBytes) {
  try {
    for (const target of targets) durableWrite(target.file, expectedBytes[target.key]);
    for (const target of targets) {
      if (sha256(fs.readFileSync(target.file)) !== sha256(expectedBytes[target.key])) {
        throw new Error(`${target.key} post-write hash mismatch`);
      }
    }
  } catch (error) {
    for (const target of targets) {
      try { durableWrite(target.file, target.original); } catch {}
    }
    throw error;
  }
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
if ([...ARGUMENTS].some(key => !args[key])) fail(USAGE);

const now = Date.now();
const repo = realDirectory(args.repo, 'repository');
const pagesVersion = readPagesVersion(repo);
const rosterInput = realExternalFile(args['roster-input'], repo, 'roster private input');
const textbooksInput = realExternalFile(args['textbooks-input'], repo, 'textbooks private input');
const buildReceiptPath = realExternalFile(args['build-receipt'], repo, 'build receipt');
const d1ReceiptPath = realExternalFile(args['d1-receipt'], repo, 'D1 receipt');
const sanitizeReceiptPath = newExternalFile(args['sanitize-receipt'], repo, 'sanitize receipt');
const allPaths = [rosterInput, textbooksInput, buildReceiptPath, d1ReceiptPath, sanitizeReceiptPath].map(pathKey);
if (new Set(allPaths).size !== allPaths.length) fail('private input과 receipt 경로는 모두 달라야 합니다.');

const rosterHash = expectedHash(args['roster-sha'], 'roster');
const textbooksHash = expectedHash(args['textbooks-sha'], 'textbooks');
const assets = [
  readPrivateAsset(rosterInput, 'roster', rosterHash),
  readPrivateAsset(textbooksInput, 'textbooks', textbooksHash)
];
const build = validateBuildReceipt(readJson(buildReceiptPath, 'build receipt'), pagesVersion, assets, now);
const d1 = validateD1Receipt(
  readJson(d1ReceiptPath, 'D1 검증 receipt'), args['database-id'], build, assets, now
);

const stubs = canonicalStubs();
const expectedBytes = Object.fromEntries(Object.entries(stubs).map(([key, value]) => [key, stubBytes(value)]));
const targets = [
  preflightPublicTarget(repo, 'task/roster.json', assets[0], stubs.roster),
  preflightPublicTarget(repo, 'task/textbooks.json', assets[1], stubs.textbooks)
];

try { writeStubPair(targets, expectedBytes); }
catch (error) { fail(`공개 stub 반영과 사후 검증에 실패했습니다: ${error.message}`); }

const sanitizeReceipt = {
  schemaVersion: 1,
  kind: 'wb-private-assets-sanitize',
  createdAt: new Date().toISOString(),
  app: 'task',
  buildId: build.buildId,
  operationId: d1.operationId,
  databaseId: d1.databaseId,
  workerDeploymentId: d1.workerDeploymentId,
  pagesVersion,
  pagesRollbackFloor: PAGES_ROLLBACK_FLOOR,
  rollbackPolicy: 'roll-forward-only',
  privateSourcePolicy: 'explicit-external-input-only',
  privateSourcePathsStored: false,
  assets: Object.fromEntries(assets.map(asset => [asset.key, {
    hash: asset.hash,
    bytes: asset.bytes.length,
    ...asset.counts
  }])),
  publicStubs: Object.fromEntries(targets.map(target => [target.key, {
    action: target.action,
    sha256: sha256(expectedBytes[target.key])
  }])),
  gitHistoryVerified: false,
  historyRemediationStatus: 'human-approval-required',
  warning: '현재 파일의 stub 전환은 Git 과거 이력의 개인정보를 제거하지 않습니다.'
};
const receiptBytes = Buffer.from(`${JSON.stringify(sanitizeReceipt, null, 2)}\n`, 'utf8');
try { exclusiveWrite(sanitizeReceiptPath, receiptBytes); }
catch (error) { fail(`sanitize receipt를 만들지 못했습니다: ${error.message}`); }

console.log(JSON.stringify({
  ok: true,
  buildId: build.buildId,
  operationId: d1.operationId,
  pagesVersion,
  rollbackPolicy: 'roll-forward-only',
  publicStubs: sanitizeReceipt.publicStubs,
  sanitizeReceiptSha256: sha256(receiptBytes)
}, null, 2));
