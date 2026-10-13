'use strict';
/* 구매 원천은 Node 원내 관리자 경로에서만 읽고 저장·검수 상태는 바꾸지 않는다. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DRAFT_MAX = 8 * 1024 * 1024;
const PDF_MAX = 32 * 1024 * 1024;
const SOURCES = ['02', '03'];
const FOLDER_SOURCES = {
  '00':'00_교과서본문.pdf','01':'01_내용정리.pdf','02':'02_본문워크북.pdf','03':'03_단어시험.pdf',
  '04s':'04_예상문제_PRE-STEP.pdf','04t':'04_예상문제_PRE-STEP_교사용.pdf',
  '05s':'05_예상문제_1회.pdf','05t':'05_예상문제_1회_교사용.pdf',
  '06s':'06_예상문제_2회.pdf','06t':'06_예상문제_2회_교사용.pdf',
  '07':'07_문법워크북.pdf','08':'08_문법객관식.pdf','09':'09_문법주관식.pdf'
};
const FOLDER_ROLES = {'00':'textbook','01':'content_summary','02':'passage_workbook','03':'vocabulary','04s':'pre_step_student','04t':'pre_step_teacher','05s':'exam_1_student','05t':'exam_1_teacher','06s':'exam_2_student','06t':'exam_2_teacher','07':'grammar_workbook','08':'grammar_mcq','09':'grammar_subjective'};
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
  if (!/^[A-Za-z0-9-]{3,60}$/.test(packId) || (source !== undefined && (!(SOURCES.includes(source) || Object.hasOwn(FOLDER_SOURCES, source)) || !/^[a-f0-9]{64}$/.test(expectedSha256)))) fail();
  const parent = directory(path.dirname(path.resolve(dataDir)));
  const root = directory(path.join(parent, 'naesin-materials'));
  const pack = directory(path.join(root, packId));
  const analysis = directory(path.join(pack, 'analysis'));
  const latest = fs.readdirSync(analysis).filter(n => /^draft-\d{8}-\d{6}-[a-f0-9]{6}$/.test(n)).sort().at(-1);
  if (!latest) fail();
  const draftDir = directory(path.join(analysis, latest));
  const draft = JSON.parse(readRegular(path.join(draftDir, 'review-draft.json'), DRAFT_MAX).toString('utf8'));
  if (draft?.kind === 'naesin-folder-review-draft') {
    if (draft.version !== 1 || draft.status !== 'needs-review' || draft.publishable !== false
      || !Array.isArray(draft.sourceDocuments) || draft.sourceDocuments.length !== 13
      || !Array.isArray(draft.wordCandidates) || !Array.isArray(draft.sentenceCandidates)
      || draft.rights?.externalAiAllowed !== false || draft.rights?.studentUseAllowed !== true
      || draft.rights?.derivativeUseAllowed !== true || draft.rights?.basis !== 'licensed'
      || typeof draft.rights?.holder !== 'string' || !draft.rights.holder
      || typeof draft.rights?.evidenceRef !== 'string' || !draft.rights.evidenceRef) fail();
    const seen = new Set(), pdfs = []; let bytes;
    for (const meta of draft.sourceDocuments) {
      const expectedFile = FOLDER_SOURCES[meta?.sourceDocumentId];
      if (!expectedFile || seen.has(meta.sourceDocumentId) || meta.role !== FOLDER_ROLES[meta.sourceDocumentId] || meta.file !== expectedFile
        || !/^[a-f0-9]{64}$/.test(meta.sha256) || !Number.isInteger(meta.bytes) || meta.bytes < 1
        || !Number.isInteger(meta.pageCount) || meta.pageCount < 1 || meta.pageCount > 1000) fail();
      seen.add(meta.sourceDocumentId);
      if (source === meta.sourceDocumentId && expectedSha256 !== meta.sha256) throw new Error('LOCAL_SOURCE_CHANGED');
      const pdf = readRegular(path.join(pack, meta.file), PDF_MAX);
      if (pdf.length !== meta.bytes || pdf.subarray(0, 5).toString('ascii') !== '%PDF-'
        || crypto.createHash('sha256').update(pdf).digest('hex') !== meta.sha256) fail();
      pdfs.push({ source: meta.sourceDocumentId, file: meta.file, pageCount: meta.pageCount, sha256: meta.sha256 });
      if (source === meta.sourceDocumentId) bytes = pdf;
    }
    if (seen.size !== Object.keys(FOLDER_SOURCES).length) fail();
    return source === undefined ? { draft, pdfs } : { bytes };
  }
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
