'use strict';
/* 구매 원천은 Node 원내 관리자 경로에서만 읽고 저장·검수 상태는 바꾸지 않는다. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DRAFT_MAX = 8 * 1024 * 1024;
const PDF_MAX = 32 * 1024 * 1024;
const SOURCES = ['02', '03'];
const CANONICAL_FILES = { '02': '02_본문워크북.pdf', '03': '03_단어시험.pdf' };
const fail = () => { throw new Error('LOCAL_SOURCE_UNAVAILABLE'); };
const samePath = (a, b) => !path.relative(a, b);

function directory(p) {
  const stat = fs.lstatSync(p);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(p, fs.realpathSync(p))) fail();
  return p;
}

function readRegular(p, max) {
  const before = fs.lstatSync(p);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > max
    || !samePath(p, fs.realpathSync(p))) fail();
  const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size) fail();
    const bytes = Buffer.alloc(opened.size + 1);
    let size = 0, n;
    while (size < bytes.length && (n = fs.readSync(fd, bytes, size, bytes.length - size, null))) size += n;
    const after = fs.fstatSync(fd), current = fs.lstatSync(p);
    if (size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || current.isSymbolicLink() || current.dev !== opened.dev
      || current.ino !== opened.ino || !samePath(p, fs.realpathSync(p))) fail();
    return bytes.subarray(0, size);
  } finally { fs.closeSync(fd); }
}

export function readLocalMaterials(dataDir, packId, source, expectedSha256) {
  if (!/^[A-Za-z0-9-]{3,60}$/.test(packId) || (source !== undefined && (!SOURCES.includes(source) || !/^[a-f0-9]{64}$/.test(expectedSha256)))) fail();
  const parent = directory(path.dirname(path.resolve(dataDir)));
  const root = directory(path.join(parent, 'naesin-materials'));
  const pack = directory(path.join(root, packId));
  const analysis = directory(path.join(pack, 'analysis'));
  const latest = fs.readdirSync(analysis).filter(n => /^draft-\d{8}-\d{6}-[a-f0-9]{6}$/.test(n)).sort().at(-1);
  if (!latest) fail();
  const draftDir = directory(path.join(analysis, latest));
  const draft = JSON.parse(readRegular(path.join(draftDir, 'review-draft.json'), DRAFT_MAX).toString('utf8'));
  if (draft?.kind !== 'naesin-pdf-review-draft' || draft.version !== 1 || draft.status !== 'needs-review'
    || draft.publishable !== false || !Array.isArray(draft.wordCandidates) || !Array.isArray(draft.passageColumns)) fail();
  const pdfs = [];
  let bytes;
  for (const key of SOURCES) {
    const meta = draft.sources?.[key];
    const downloadName = typeof meta?.file === 'string' && !meta.file.startsWith(key + '_') && meta.file.includes('[' + key + ']');
    if (!meta || typeof meta.file !== 'string' || meta.file.length > 160 || (!meta.file.startsWith(key + '_') && !downloadName)
      || !/\.pdf$/i.test(meta.file) || /[\\/:\x00-\x1f\x7f]/.test(meta.file) || /[. ]$/.test(meta.file)
      || !/^[a-f0-9]{64}$/.test(meta.sha256) || !Number.isInteger(meta.pageCount) || meta.pageCount < 1 || meta.pageCount > 1000) fail();
    if (source === key && expectedSha256 !== meta.sha256) throw new Error('LOCAL_SOURCE_CHANGED');
    let file = meta.file;
    /* 추출 당시 다운로드 이름이 없을 때만 정해 둔 보관 이름을 확인하며 원본 해시는 그대로 대조한다. */
    if (downloadName) {
      try { fs.lstatSync(path.join(pack, file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; file = CANONICAL_FILES[key]; }
    }
    const pdf = readRegular(path.join(pack, file), PDF_MAX);
    if (pdf.subarray(0, 5).toString('ascii') !== '%PDF-' || crypto.createHash('sha256').update(pdf).digest('hex') !== meta.sha256) fail();
    pdfs.push({ source: key, file, pageCount: meta.pageCount, sha256: meta.sha256 });
    if (source === key) bytes = pdf;
  }
  return source === undefined ? { draft, pdfs } : { bytes };
}
