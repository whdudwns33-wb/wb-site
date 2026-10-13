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

const objectRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => objectRecord(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const shortText = (value, max = 1200, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
const flagsValid = value => Array.isArray(value) && value.length <= 20 && value.every(flag => shortText(flag, 80));
function validateFolderCandidates(draft) {
  const docs = new Map(draft.sourceDocuments.map(doc => [doc.sourceDocumentId, doc]));
  const refKeys = ['sourceDocumentId','page','printedPage','section','side','lineStart','lineEnd','questionNo'];
  const refsValid = refs => Array.isArray(refs) && refs.length > 0 && refs.length <= 40 && refs.every(ref => {
    if (!exactKeys(ref, Object.keys(ref).filter(key => refKeys.includes(key)))
      || !['sourceDocumentId','page','printedPage','section'].every(key => Object.hasOwn(ref, key))) return false;
    const doc = docs.get(ref.sourceDocumentId);
    return !!doc && Number.isInteger(ref.page) && ref.page >= 1 && ref.page <= doc.pageCount
      && ref.printedPage === ref.page && shortText(ref.section, 120) && !/[\\\\:]/.test(ref.section) && !ref.section.includes('/')
      && (!Object.hasOwn(ref,'side') || ['EN','KO'].includes(ref.side))
      && (!Object.hasOwn(ref,'lineStart') || (Number.isInteger(ref.lineStart) && ref.lineStart >= 1 && ref.lineStart <= 1000))
      && (!Object.hasOwn(ref,'lineEnd') || (Number.isInteger(ref.lineEnd) && ref.lineEnd >= (ref.lineStart || 1) && ref.lineEnd <= 1000))
      && (!Object.hasOwn(ref,'questionNo') || ref.questionNo === null || (Number.isInteger(ref.questionNo) && ref.questionNo >= 1 && ref.questionNo <= 99));
  });
  const common = row => refsValid(row.sourceRefs) && flagsValid(row.reviewFlags);
  const dialogueKeys = ['candidateId','id','title','section','lines','sourceRefs','reviewFlags'];
  if (!Array.isArray(draft.dialogueCandidates) || draft.dialogueCandidates.length > 20
    || !draft.dialogueCandidates.every(row => exactKeys(row, dialogueKeys) && /^dc-\d{4}$/.test(row.candidateId) && /^d-\d{4}$/.test(row.id)
      && shortText(row.title,200) && shortText(row.section,120) && Array.isArray(row.lines) && row.lines.length <= 40 && common(row)
      && row.lines.every(line => exactKeys(line,['speaker','en','ko']) && ['G','B','M','W'].includes(line.speaker) && shortText(line.en) && shortText(line.ko)))) return false;
  const functionKeys = ['candidateId','id','name','pattern','explainKo','exampleEn','exampleKo','sourceRefs','reviewFlags'];
  if (!Array.isArray(draft.functionCandidates) || draft.functionCandidates.length > 20
    || !draft.functionCandidates.every(row => exactKeys(row,functionKeys) && /^fc-\d{4}$/.test(row.candidateId) && /^fn-\d{4}$/.test(row.id)
      && shortText(row.name,200) && shortText(row.pattern,500,true) && shortText(row.explainKo,500,true)
      && shortText(row.exampleEn) && shortText(row.exampleKo) && common(row))) return false;
  const keyKeys = ['candidateId','en','ko','blankAnswer','sourceRefs','reviewFlags'];
  if (!Array.isArray(draft.keyExpressionCandidates) || draft.keyExpressionCandidates.length > 20
    || !draft.keyExpressionCandidates.every(row => exactKeys(row,keyKeys) && /^kc-\d{4}$/.test(row.candidateId)
      && shortText(row.en) && shortText(row.ko) && shortText(row.blankAnswer,300) && common(row))) return false;
  const patternKeys = ['candidateId','patternNo','title','conceptKo','grammarPoint','textbookExamples','letsUseIt','sourceRefs','reviewFlags'];
  if (!Array.isArray(draft.patternCandidates) || draft.patternCandidates.length > 20
    || !draft.patternCandidates.every(row => exactKeys(row,patternKeys) && /^pc-\d{2}$/.test(row.candidateId) && [1,2].includes(row.patternNo)
      && shortText(row.title,300) && shortText(row.conceptKo,2000,true) && Array.isArray(row.grammarPoint) && row.grammarPoint.length <= 20
      && row.grammarPoint.every(item => shortText(item,1000)) && Array.isArray(row.textbookExamples) && row.textbookExamples.length <= 40
      && row.textbookExamples.every(item => exactKeys(item,['en','ko','origin']) && shortText(item.en) && shortText(item.ko) && ['교과서 본문','워크북 예문'].includes(item.origin))
      && Array.isArray(row.letsUseIt) && row.letsUseIt.length <= 40 && row.letsUseIt.every(item => exactKeys(item,['no','stem','ko','wordBank','answers'])
        && Number.isInteger(item.no) && item.no >= 1 && item.no <= 20 && shortText(item.stem) && shortText(item.ko)
        && Array.isArray(item.wordBank) && item.wordBank.length <= 50 && item.wordBank.every(word => shortText(word,200))
        && Array.isArray(item.answers) && item.answers.length >= 1 && item.answers.length <= 20 && item.answers.every(answer => shortText(answer,300)))
      && common(row))) return false;
  const itemKeys = ['candidateId','source','section','patternNo','no','formatType','rawText','choices','answerLabels','answerTexts','explanationKo','sourceRefs','reviewFlags'];
  const itemSources = {'04':64,'05':30,'06':30,'08':142,'09':163};
  const labels = ['①','②','③','④','⑤'];
  if (!Array.isArray(draft.examItemCandidates) || draft.examItemCandidates.length > 429
    || !draft.examItemCandidates.every(row => exactKeys(row,itemKeys) && /^ic-(04|05|06|08|09)-(00|01|02)-\d{3}$/.test(row.candidateId)
      && Object.hasOwn(itemSources,row.source) && shortText(row.section,120) && (row.patternNo === null || [1,2].includes(row.patternNo))
      && ((row.source==='08'||row.source==='09') ? [1,2].includes(row.patternNo) : row.patternNo===null)
      && Number.isInteger(row.no) && row.no>=1 && row.no<=99 && ['mcq','multi-select','subjective','unknown'].includes(row.formatType)
      && shortText(row.rawText,12000,true) && !/(?:[A-Za-z]:[\\/]|\\\\)/.test(row.rawText) && Array.isArray(row.choices) && row.choices.length<=5
      && row.choices.every(choice=>exactKeys(choice,['label','text'])&&labels.includes(choice.label)&&shortText(choice.text,2000))
      && new Set(row.choices.map(choice=>choice.label)).size===row.choices.length
      && Array.isArray(row.answerLabels)&&row.answerLabels.length<=5&&row.answerLabels.every(label=>labels.includes(label))
      && new Set(row.answerLabels).size===row.answerLabels.length
      && Array.isArray(row.answerTexts)&&row.answerTexts.length<=20&&row.answerTexts.every(text=>shortText(text,8000))
      && shortText(row.explanationKo,8000,true)&&common(row)&&row.reviewFlags.includes('REVIEW_REQUIRED')
      && row.sourceRefs.some(ref=>ref.sourceDocumentId===`${row.source}s`||ref.sourceDocumentId===row.source)
      && row.sourceRefs.some(ref=>ref.sourceDocumentId===`${row.source}t`||ref.sourceDocumentId===row.source))) return false;
  const unmatchedItemKeys=['candidateId','source','section','patternNo','no','field','reason','sourceRefs'];
  if(!Array.isArray(draft.unmatchedItems)||draft.unmatchedItems.length>429||!draft.unmatchedItems.every(row=>exactKeys(row,unmatchedItemKeys)
    &&/^ic-(04|05|06|08|09)-(00|01|02)-\d{3}$/.test(row.candidateId)&&Object.hasOwn(itemSources,row.source)&&shortText(row.section,120)
    &&(row.patternNo===null||[1,2].includes(row.patternNo))&&Number.isInteger(row.no)&&row.no>=1&&row.no<=99
    &&row.field==='examItemCandidates'&&['STEM_MISSING','ANSWER_MISSING','CHOICES_MISSING','BOUNDARY_AMBIGUOUS'].includes(row.reason)&&refsValid(row.sourceRefs)))return false;
  const itemSummary=draft.itemSummary,itemSummaryKeys=['expected','found','answerMatched','unresolved','bySource','byType','typeCountWarnings'];
  if(!exactKeys(itemSummary,itemSummaryKeys)||!['expected','found','answerMatched','unresolved'].every(key=>Number.isInteger(itemSummary[key])&&itemSummary[key]>=0&&itemSummary[key]<=429)
    ||!exactKeys(itemSummary.bySource,Object.keys(itemSources))||!exactKeys(itemSummary.byType,['mcq','multi-select','subjective','unknown']))return false;
  const typeKeys=['mcq','multi-select','subjective','unknown'];let expectedTotal=0,foundTotal=0,answerTotal=0,unresolvedTotal=0;const typeTotals={mcq:0,'multi-select':0,subjective:0,unknown:0};
  for(const [source,expected] of Object.entries(itemSources)){
    const stats=itemSummary.bySource[source];if(!exactKeys(stats,['expected','found','answerMatched','unresolved','byType','expectedByType','foundByType'])
      ||stats.expected!==expected||!['found','answerMatched','unresolved'].every(key=>Number.isInteger(stats[key])&&stats[key]>=0&&stats[key]<=expected)
      ||!exactKeys(stats.byType,typeKeys)||!Object.values(stats.byType).every(n=>Number.isInteger(n)&&n>=0&&n<=expected)
      ||!exactKeys(stats.expectedByType,['objective','subjective'])||!exactKeys(stats.foundByType,['objective','subjective'])
      ||![...Object.values(stats.expectedByType),...Object.values(stats.foundByType)].every(n=>Number.isInteger(n)&&n>=0&&n<=expected))return false;
    expectedTotal+=stats.expected;foundTotal+=stats.found;answerTotal+=stats.answerMatched;unresolvedTotal+=stats.unresolved;
    for(const type of typeKeys)typeTotals[type]+=stats.byType[type];
    if(stats.found!==draft.examItemCandidates.filter(row=>row.source===source).length
      ||stats.unresolved!==draft.unmatchedItems.filter(row=>row.source===source).length
      ||stats.answerMatched!==draft.examItemCandidates.filter(row=>row.source===source&&(row.answerLabels.length||row.answerTexts.length)).length
      ||Object.values(stats.byType).reduce((a,b)=>a+b,0)!==stats.found
      ||stats.foundByType.objective!==stats.byType.mcq+stats.byType['multi-select']||stats.foundByType.subjective!==stats.byType.subjective)return false;
  }
  if(expectedTotal!==itemSummary.expected||foundTotal!==itemSummary.found||answerTotal!==itemSummary.answerMatched||unresolvedTotal!==itemSummary.unresolved
    ||draft.examItemCandidates.length!==itemSummary.found||Object.entries(typeTotals).some(([key,value])=>itemSummary.byType[key]!==value))return false;
  if(!Array.isArray(itemSummary.typeCountWarnings)||itemSummary.typeCountWarnings.length>10||!itemSummary.typeCountWarnings.every(row=>exactKeys(row,['source','field','reason','expected','found'])
    &&Object.hasOwn(itemSources,row.source)&&row.field==='formatType'&&row.reason==='EXPECTED_TYPE_COUNT_MISMATCH'
    &&exactKeys(row.expected,['objective','subjective'])&&exactKeys(row.found,['objective','subjective'])
    &&[...Object.values(row.expected),...Object.values(row.found)].every(n=>Number.isInteger(n)&&n>=0&&n<=429)))return false;
  const unmatchedKeys = ['candidateId','field','reason','sourceRefs','expectedQuestionNo','baseCount','answerCount','groupIndex','expectedGroups','pairIndex'];
  const numericDetails = ['expectedQuestionNo','baseCount','answerCount','groupIndex','expectedGroups','pairIndex'];
  if (!Array.isArray(draft.unmatched) || draft.unmatched.length > 500 || !draft.unmatched.every(row =>
    objectRecord(row) && Object.keys(row).every(key => unmatchedKeys.includes(key)) && shortText(row.candidateId,100)
      && shortText(row.field,80) && shortText(row.reason,120) && refsValid(row.sourceRefs)
      && numericDetails.every(key => !Object.hasOwn(row,key) || (Number.isInteger(row[key]) && row[key] >= 0 && row[key] <= 1000)))) return false;
  const summaryKeys = ['verbForms','grammarChoices','tokens','writingKeywords','dialogues','functions','keyExpressions','patterns'];
  if (!exactKeys(draft.enrichmentSummary,summaryKeys)) return false;
  for (const key of summaryKeys.slice(0,4)) if (!exactKeys(draft.enrichmentSummary[key],['matched','unmatched'])
    || !Object.values(draft.enrichmentSummary[key]).every(n => Number.isInteger(n) && n >= 0 && n <= 1000)) return false;
  for (const [key,keys] of [['dialogues',['matched','unmatched','lines']],['functions',['matched','unmatched']],['keyExpressions',['matched','unmatched']],['patterns',['matched','unmatched','examples','letsUseIt']]])
    if (!exactKeys(draft.enrichmentSummary[key],keys) || !Object.values(draft.enrichmentSummary[key]).every(n => Number.isInteger(n) && n >= 0 && n <= 1000)) return false;
  const totals = draft.enrichmentSummary;
  return totals.dialogues.matched + totals.dialogues.unmatched === draft.dialogueCandidates.length
    && totals.dialogues.lines === draft.dialogueCandidates.reduce((n,row) => n + row.lines.length,0)
    && totals.functions.matched + totals.functions.unmatched === draft.functionCandidates.length
    && totals.keyExpressions.matched + totals.keyExpressions.unmatched === draft.keyExpressionCandidates.length
    && totals.patterns.matched + totals.patterns.unmatched === draft.patternCandidates.length
    && totals.patterns.examples === draft.patternCandidates.reduce((n,row) => n + row.textbookExamples.length,0)
    && totals.patterns.letsUseIt === draft.patternCandidates.reduce((n,row) => n + row.letsUseIt.length,0);
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
    if (seen.size !== Object.keys(FOLDER_SOURCES).length || !validateFolderCandidates(draft)) fail();
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
