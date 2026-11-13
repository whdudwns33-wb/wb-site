#!/usr/bin/env python3
"""Local review draft: draft.py <02.pdf> <03.pdf> <new-output-directory>.

Purchased text stays in the output JSON. stdout contains counts/error codes only.
shortcut: coordinates cover the verified NE middle-2 L6 layout; review a new layout before reusing it.
"""
import argparse
import contextlib
import hashlib
import io
import json
import logging
import os
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PRIVATE_ROOT = (Path(os.environ['LOCALAPPDATA']) if os.environ.get('LOCALAPPDATA')
                else Path.home() / '.local' / 'share') / 'WB' / 'naesin-materials'
POS = re.compile(r'^(?:n|v|a|adj|ad|adv|prep|pron|conj|int|phr|aux)\.?$', re.I)
KO = re.compile(r'[가-힣]')
EN = re.compile(r'[A-Za-z]')
WORD_PAGES = tuple(range(1, 9))
PASSAGE_PAGES = (1, 2)


class DraftError(Exception):
    pass


def normalized(text):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', text)).strip().casefold()


def lines_of(tokens):
    lines = []
    for token in sorted(tokens, key=lambda t: (t['top'], t['x0'])):
        if not lines or abs(token['top'] - lines[-1]['y']) > 3:
            lines.append({'y': token['top'], 'tokens': []})
        lines[-1]['tokens'].append(token)
    for line in lines:
        line['tokens'].sort(key=lambda t: t['x0'])
        line['y'] = round(line['y'], 1)
        line['text'] = ' '.join(t['text'] for t in line['tokens'])
    return lines


def joined(tokens):
    return '\n'.join(line['text'] for line in lines_of(tokens)).strip()


def bold(token):
    return 'bold' in token['fontname'].casefold()


def word_rows(page, sha256):
    tokens = [t for t in page['tokens'] if 40 <= t['x0'] < 560 and 80 <= t['top'] < page['height'] - 70]
    boxes = sorted([t for t in tokens if t['text'] == '\u25a1' and 45 <= t['x0'] <= 63
                    and 9.4 <= t['size'] <= 9.6], key=lambda t: t['top'])
    anchors = []
    for box in boxes:
        if anchors and box['top'] - anchors[-1]['top'] <= 3:
            anchors[-1]['duplicates'] += 1
        else:
            anchors.append({**box, 'duplicates': 0})
    rows = []
    for index, anchor in enumerate(anchors):
        bottom = anchors[index + 1]['top'] - 1 if index + 1 < len(anchors) else page['height'] - 70
        block = [t for t in tokens if anchor['top'] - 1 <= t['top'] < bottom and 65 <= t['x0'] < 215]
        start = [t for t in block if abs(t['top'] - anchor['top']) <= 3]
        use_bold = any(EN.search(t['text']) and bold(t) and t['x0'] < 131 for t in start)
        pos = [t for t in block if 120 <= t['x0'] < 145 and 9.4 <= t['size'] <= 9.6 and not bold(t) and POS.fullmatch(t['text'])]
        head = [t for t in block if 9.4 <= t['size'] <= 9.6 and t not in pos
                and not re.fullmatch(r'[\d.()]+', t['text'])
                and ((use_bold and bold(t)) or (not use_bold and t['x0'] < 131 and EN.search(t['text'])))]
        meaning = [t for t in block if t not in head and t not in pos and t['x0'] >= 132
                   and 7.8 <= t['size'] <= 10 and not bold(t) and t['x1'] <= 215]
        flags = ['REVIEW_REQUIRED']
        if anchor['duplicates']:
            flags.append('DUPLICATE_ROW_ANCHOR')
        if not use_bold:
            flags.append('PLAIN_HEAD_REVIEW')
        if not head or not EN.search(joined(head)):
            flags.append('HEAD_MISSING')
        if len(lines_of(head)) > 1:
            flags.append('HEAD_WRAP')
        if any(t['x0'] >= 131 or t['x1'] > 215 or KO.search(t['text']) for t in head):
            flags.append('HEAD_BOUNDARY_REVIEW')
        if not KO.search(joined(meaning)):
            flags.append('MEANING_MISSING')
        if any(t not in head and t not in pos and t['x0'] >= 132 and t['x1'] > 215 for t in block):
            flags.append('MEANING_COLUMN_OVERFLOW')
        if any(EN.search(t['text']) for t in meaning):
            flags.append('MEANING_NON_KOREAN_REVIEW')
        if not pos:
            flags.append('POS_MISSING')
        if page['no'] >= 7:
            flags.append('SUPPLEMENT_SECTION_REVIEW')
        rows.append({'source': '03', 'sha256': sha256, 'page': page['no'],
                     'bbox': [round(anchor['x0'], 1), round(anchor['top'], 1), 215, round(bottom, 1)],
                     'headRaw': joined(head), 'meaningRaw': joined(meaning), 'posRaw': [t['text'] for t in pos],
                     'leftEvidence': block, 'reviewFlags': flags})
    return rows


def merge_candidates(rows):
    candidates, unmatched, by_head = [], [], {}
    for row in rows:
        key = normalized(row['headRaw'])
        if not key or 'HEAD_MISSING' in row['reviewFlags']:
            unmatched.append(row)
            continue
        candidate = by_head.get(key)
        if candidate is None:
            candidate = {'candidateId': 'wc-%04d' % (len(candidates) + 1), 'headCandidate': row['headRaw'],
                         'meanings': [], 'posCandidates': [], 'sourceRows': [], 'reviewFlags': ['REVIEW_REQUIRED']}
            by_head[key] = candidate
            candidates.append(candidate)
        candidate['sourceRows'].append(row)
        for flag in row['reviewFlags']:
            if flag not in candidate['reviewFlags']:
                candidate['reviewFlags'].append(flag)
        for value in row['posRaw']:
            if value not in candidate['posCandidates']:
                candidate['posCandidates'].append(value)
        if row['meaningRaw'] and all(normalized(m) != normalized(row['meaningRaw']) for m in candidate['meanings']):
            candidate['meanings'].append(row['meaningRaw'])
    for candidate in candidates:
        if len(candidate['sourceRows']) > 1:
            candidate['reviewFlags'].append('DUPLICATE_SOURCE_ROWS')
        if len(candidate['meanings']) > 1:
            candidate['reviewFlags'].append('MEANING_VARIANTS_REVIEW')
    return candidates, unmatched


def build_draft(workbook, vocabulary):
    for source, expected in [(workbook, PASSAGE_PAGES), (vocabulary, WORD_PAGES)]:
        if not set(expected).issubset({page['no'] for page in source['pages']}):
            raise DraftError('SOURCE_PAGE_MISSING')
        if any(not (580 <= page['width'] <= 610 and 825 <= page['height'] <= 855) for page in source['pages']):
            raise DraftError('UNSUPPORTED_PAGE_LAYOUT')
    rows, columns, flags = [], [], ['REVIEW_REQUIRED', 'NO_SENTENCE_AUTOPAIR', 'WORD_PAGES_AFTER_8_NOT_PARSED']
    for page in vocabulary['pages']:
        if page['no'] in WORD_PAGES:
            found = word_rows(page, vocabulary['sha256'])
            rows.extend(found)
            if not found:
                flags.append('WORD_PAGE_WITHOUT_ANCHORS')
    for page in workbook['pages']:
        if page['no'] not in PASSAGE_PAGES:
            continue
        marks = []
        for label, x0, x1 in [('EN', 40, 365), ('KO', 370, 560)]:
            tokens = [t for t in page['tokens'] if x0 <= t['x0'] and t['x1'] <= x1 and 70 <= t['top'] < page['height'] - 70]
            text = joined(tokens)
            ends = len(re.findall(r'[.!?](?:["\u201d\u2019\x27)]|$|\s)', text))
            marks.append(ends)
            columns.append({'source': '02', 'sha256': workbook['sha256'], 'page': page['no'], 'column': label,
                            'bbox': [x0, 70, x1, round(page['height'] - 70, 1)], 'rawText': text,
                            'lines': lines_of(tokens), 'sentenceEndMarks': ends,
                            'reviewFlags': ['REVIEW_REQUIRED', 'COLUMN_NOT_SENTENCE_PAIRED'] + ([] if text else ['TEXT_EMPTY'])})
        if marks[0] != marks[1]:
            flags.append('SENTENCE_END_COUNT_MISMATCH')
    candidates, unmatched = merge_candidates(rows)
    return {'kind': 'naesin-pdf-review-draft', 'version': 1, 'status': 'needs-review', 'publishable': False,
            'sources': {label: {k: source[k] for k in ['file', 'sha256', 'pageCount']} for label, source in [('02', workbook), ('03', vocabulary)]},
            'parsedPages': {'02': list(PASSAGE_PAGES), '03': list(WORD_PAGES)},
            'wordCandidates': candidates, 'unmatchedWordRows': unmatched, 'passageColumns': columns,
            'reviewFlags': sorted(set(flags))}


def file_sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def read_pdf(path, selected):
    try:
        import pdfplumber
    except ImportError:
        raise DraftError('PDFPLUMBER_REQUIRED') from None
    sha256 = file_sha(path)
    with pdfplumber.open(path) as pdf:
        if pdf.doc.encryption:
            raise DraftError('ENCRYPTED_SOURCE')
        if len(pdf.pages) < max(selected):
            raise DraftError('SOURCE_PAGE_MISSING')
        pages = []
        for number in selected:
            page = pdf.pages[number - 1]
            tokens = page.extract_words(extra_attrs=['fontname', 'size'])
            pages.append({'no': number, 'width': page.width, 'height': page.height,
                          'tokens': [{k: token[k] for k in ['text', 'x0', 'x1', 'top', 'bottom', 'size', 'fontname']} for token in tokens]})
        return {'file': path.name, 'sha256': sha256, 'pageCount': len(pdf.pages), 'pages': pages}


def output_path(directory):
    directory = Path(directory).resolve()
    if directory.is_relative_to(REPO) or any((p / '.git').exists() for p in [directory, *directory.parents]):
        raise DraftError('OUTPUT_INSIDE_REPOSITORY')
    if directory.exists():
        raise DraftError('OUTPUT_ALREADY_EXISTS')
    if not directory.is_relative_to(PRIVATE_ROOT.resolve()) or str(directory).startswith('\\\\'):
        raise DraftError('OUTPUT_OUTSIDE_PRIVATE_ROOT')
    return directory


def write_draft(directory, draft):
    directory = output_path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    target = directory / 'review-draft.json'
    created = False
    try:
        with target.open('x', encoding='utf-8') as output:
            created = True
            json.dump(draft, output, ensure_ascii=False, indent=2)
            output.write('\n')
    except Exception:
        if created:
            target.unlink(missing_ok=True)
        try:
            directory.rmdir()
        except OSError:
            pass
        raise DraftError('OUTPUT_WRITE_FAILED') from None
    return target


def safe_summary(draft):
    counts = Counter(flag for candidate in draft['wordCandidates'] for flag in candidate['reviewFlags'])
    counts.update(flag for row in draft['unmatchedWordRows'] for flag in row['reviewFlags'])
    return {'ok': True, 'status': draft['status'], 'publishable': draft['publishable'],
            'counts': {'wordCandidates': len(draft['wordCandidates']),
                       'sourceWordRows': sum(len(c['sourceRows']) for c in draft['wordCandidates']) + len(draft['unmatchedWordRows']),
                       'unmatchedWordRows': len(draft['unmatchedWordRows']), 'passageColumns': len(draft['passageColumns'])},
            'reviewFlagCounts': dict(sorted(counts.items())), 'documentFlags': draft['reviewFlags']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workbook')
    parser.add_argument('vocabulary')
    parser.add_argument('outdir')
    args = parser.parse_args()
    try:
        output = output_path(args.outdir)
        paths = [Path(value).resolve(strict=True) for value in [args.workbook, args.vocabulary]]
        if paths[0] == paths[1] or any(not p.is_file() or p.suffix.casefold() != '.pdf' for p in paths):
            raise DraftError('INVALID_SOURCE_FILES')
        # Parser diagnostics can contain purchased tokens, so keep them off stdout/stderr.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            logging.disable(logging.CRITICAL)
            sources = [read_pdf(paths[0], PASSAGE_PAGES), read_pdf(paths[1], WORD_PAGES)]
            draft = build_draft(*sources)
            if any(file_sha(path) != source['sha256'] for path, source in zip(paths, sources)):
                raise DraftError('SOURCE_CHANGED_DURING_READ')
            write_draft(output, draft)
        print(json.dumps(safe_summary(draft), ensure_ascii=True))
    except DraftError as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        return 1
    except Exception:
        print(json.dumps({'ok': False, 'error': 'SOURCE_OR_OUTPUT_FAILED'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
