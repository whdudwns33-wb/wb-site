/* Local draft parser: purchased text never belongs in these fixtures or test output. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./draft.py', import.meta.url));
const bundled = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const python = process.env.WB_NAESIN_PYTHON || (process.platform === 'win32' && fs.existsSync(bundled) ? bundled : 'python3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-naesin-draft-'));
const program = String.raw`
import hashlib, importlib.util, json, os, pathlib, subprocess, sys
spec = importlib.util.spec_from_file_location('local_draft', sys.argv[1])
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
root = pathlib.Path(sys.argv[2])
d.PRIVATE_ROOT = root/'WB'/'naesin-materials'
passed = 0
def check(value):
    global passed
    assert value
    passed += 1
def token(text, x, y, size=9.5, bold=True, width=25):
    return {'text':text, 'x0':x, 'x1':x+width, 'top':y, 'bottom':y+size,
            'size':size, 'fontname':'Fixture-Bold' if bold else 'Fixture-Regular'}
def box(y):
    return token('\u25a1', 58, y, bold=False, width=7)
def page(no, tokens=()):
    return {'no':no, 'height':842, 'width':595, 'tokens':list(tokens)}
def source(name, pages):
    return {'file':name, 'sha256':'a'*64, 'pageCount':len(pages), 'pages':pages}

v1 = page(1, [token('HEADING', 60, 95, size=14), box(130),
    token('turn', 72, 130, width=23), token('around', 100, 130, width=30),
    token('again', 72, 145, width=25), token('v.', 133, 145, bold=False, width=8),
    token('돌아서', 145, 131, size=8.1, bold=False),
    token('가다', 145, 146, size=8.1, bold=False),
    token('EXAMPLE_SENTINEL', 220, 130, width=80),
    token('HEADING_SENTINEL', 61.8, 168, size=9), box(180),
    token('shell', 72, 180), token('n.', 133, 180, bold=False, width=8),
    token('겉모습', 145, 181, size=8.1, bold=False)])
rows = d.word_rows(v1, 'a'*64)
check(len(rows) == 2)
check(rows[0]['headRaw'] == 'turn around\nagain')
check(rows[0]['meaningRaw'] == '돌아서\n가다')
check('HEAD_WRAP' in rows[0]['reviewFlags'])
check(all('SENTINEL' not in r['headRaw']+r['meaningRaw'] for r in rows))
check(all(r['page'] == 1 and r['bbox'][1] > 100 and r['sha256'] == 'a'*64 for r in rows))

v2 = page(2, [box(130), token('turn around again', 72, 130, width=70),
    token('v.', 133, 145, bold=False, width=8), token('회전하다', 145, 146, size=8.1, bold=False)])
merged, unmatched = d.merge_candidates(rows + d.word_rows(v2, 'a'*64))
check(not unmatched and len(merged) == 2)
check(len(merged[0]['sourceRows']) == 2 and len(merged[0]['meanings']) == 2)
check('MEANING_VARIANTS_REVIEW' in merged[0]['reviewFlags'])
check('DUPLICATE_SOURCE_ROWS' in merged[0]['reviewFlags'])

plain = page(3, [box(120), token('shell', 72, 120, bold=False),
    token('n.', 133, 120, bold=False, width=8), token('겉모습', 145, 121, size=8.1, bold=False)])
merged, _ = d.merge_candidates(rows + d.word_rows(plain, 'a'*64))
check(len(merged) == 2 and len(merged[1]['sourceRows']) == 2 and len(merged[1]['meanings']) == 1)
check('PLAIN_HEAD_REVIEW' in merged[1]['reviewFlags'])

adj = page(4, [box(120), token('clear', 72, 120), token('a.', 133, 120, bold=False, width=8),
    token('밝은', 145, 121, size=8.1, bold=False), token('잘린뜻', 203, 135, size=8.1, bold=False, width=28)])
adjrow = d.word_rows(adj, 'a'*64)[0]
check(adjrow['posRaw'] == ['a.'] and adjrow['meaningRaw'] == '밝은')
check('MEANING_COLUMN_OVERFLOW' in adjrow['reviewFlags'])
check(any(t['text'] == '잘린뜻' for t in adjrow['leftEvidence']))
article = page(6, [box(120), token('a', 72, 120, width=5), token('lot', 83, 120, width=14),
    token('of', 103, 120, width=11), token('a.', 133, 120, bold=False, width=8),
    token('많은', 145, 121, size=8.1, bold=False)])
check(d.word_rows(article, 'a'*64)[0]['headRaw'] == 'a lot of')
check(d.word_rows(article, 'a'*64)[0]['posRaw'] == ['a.'])

missing = page(5, [box(120), token('n.', 133, 120, bold=False, width=8)])
check('HEAD_MISSING' in d.word_rows(missing, 'a'*64)[0]['reviewFlags'])
check('MEANING_MISSING' in d.word_rows(missing, 'a'*64)[0]['reviewFlags'])

w1 = page(1, [token('HEADER_SENTINEL', 45, 30), token('A toy is blue.', 48, 120, bold=False, width=90),
    token('It is round.', 48, 140, bold=False, width=70), token('장난감이 파랗다.', 377, 121, size=9, bold=False, width=90)])
w2 = page(2, [token('A door opens.', 48, 120, bold=False, width=90),
    token('문이 열린다.', 377, 121, size=9, bold=False, width=90)])
draft = d.build_draft(source('self-02.pdf', [w1,w2]),
    source('self-03.pdf', [v1,v2,plain,adj,missing,page(6),page(7),page(8)]))
check(draft['status'] == 'needs-review' and draft['publishable'] is False)
check(not any(k in draft for k in ['packId','words','sentences','review']))
check(len(draft['passageColumns']) == 4)
check(draft['passageColumns'][0]['rawText'] == 'A toy is blue.\nIt is round.')
check(draft['passageColumns'][1]['rawText'] == '장난감이 파랗다.')
check('SENTENCE_END_COUNT_MISMATCH' in draft['reviewFlags'])
check(all('COLUMN_NOT_SENTENCE_PAIRED' in c['reviewFlags'] for c in draft['passageColumns']))
check(all('REVIEW_REQUIRED' in c['reviewFlags'] for c in draft['wordCandidates']))
check('HEAD_MISSING' in draft['unmatchedWordRows'][0]['reviewFlags'])
summary = d.safe_summary(draft)
check('돌아서' not in json.dumps(summary, ensure_ascii=False) and 'turn' not in json.dumps(summary))
try:
    d.build_draft(source('self-02.pdf', [w1]), source('self-03.pdf', [page(n) for n in range(1,9)]))
    raise AssertionError('missing source page accepted')
except d.DraftError as e:
    check(str(e) == 'SOURCE_PAGE_MISSING')

out = d.PRIVATE_ROOT/'new-draft'
target = d.write_draft(out, draft)
before = hashlib.sha256(target.read_bytes()).hexdigest()
try:
    d.write_draft(out, {'changed':True})
    raise AssertionError('existing output replaced')
except d.DraftError as e:
    check(str(e) == 'OUTPUT_ALREADY_EXISTS')
check(hashlib.sha256(target.read_bytes()).hexdigest() == before)
try:
    d.output_path(d.REPO/'must-not-create')
    raise AssertionError('repository output accepted')
except d.DraftError as e:
    check(str(e) == 'OUTPUT_INSIDE_REPOSITORY')
try:
    d.output_path(root/'outside-private')
    raise AssertionError('non-private output accepted')
except d.DraftError as e:
    check(str(e) == 'OUTPUT_OUTSIDE_PRIVATE_ROOT')
bad_page = page(1)
bad_page['width'] = 900
try:
    d.build_draft(source('self-02.pdf', [bad_page,w2]), source('self-03.pdf', [page(n) for n in range(1,9)]))
    raise AssertionError('unverified layout accepted')
except d.DraftError as e:
    check(str(e) == 'UNSUPPORTED_PAGE_LAYOUT')

original = root/'original.pdf'
original.write_bytes(b'self-created invalid PDF fixture; never purchased text')
original_before = original.read_bytes()
run = subprocess.run([sys.executable, sys.argv[1], str(original), str(original), str(original)], capture_output=True, text=True)
check(run.returncode == 1 and json.loads(run.stdout)['error'] == 'OUTPUT_ALREADY_EXISTS')
check(original.read_bytes() == original_before)
other = root/'other.pdf'
other.write_bytes(b'self-created malformed PDF')
run = subprocess.run([sys.executable, sys.argv[1], str(original), str(other), str(d.PRIVATE_ROOT/'bad-draft')],
    capture_output=True, text=True, env={**os.environ, 'LOCALAPPDATA':str(root)})
check(run.returncode == 1 and json.loads(run.stdout)['error'] in ['SOURCE_OR_OUTPUT_FAILED','PDFPLUMBER_REQUIRED'])
check(not run.stderr and 'self-created' not in run.stdout and not (d.PRIVATE_ROOT/'bad-draft').exists())
check(original.read_bytes() == original_before)
print(json.dumps({'passed':passed}))
`;
try {
  const result = spawnSync(python, ['-B', '-c', program, script, temp], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined, 'Python 3.11+ is required for local draft fixture tests');
  assert.equal(result.status, 0, result.stderr || 'draft fixtures failed');
  const { passed } = JSON.parse(result.stdout);
  assert.ok(passed >= 30);
  console.log(`OK — ${passed} synthetic local draft checks`);
} finally {
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('wb-naesin-draft-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
