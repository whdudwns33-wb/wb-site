"""Offline question candidates. Never approves or publishes; stdout is counts only."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path

QUESTION = re.compile(r'(?m)^\s*(\d{1,3})\s*\.\s*')
ANSWER = re.compile(r'(?<![\d(])(\d{1,3})\)\s*')
SUMMARY = re.compile(r'(?<![\d(])(\d{1,3})\s*\.\s*([①②③④⑤](?:\s*[,，]\s*[①②③④⑤])*)')
PATTERN = re.compile(r'(?i)pattern\s*([1-9])')
KEY = re.compile(r'(?i)answer\s*key|정답\s*및\s*해설')
CHOICES = '①②③④⑤'
FILES = {'04_예상문제_PRE-STEP.pdf':'04','05_예상문제_1회.pdf':'05','06_예상문제_2회.pdf':'06','08_문법객관식.pdf':'08','09_문법주관식.pdf':'09'}

def location(doc, page, bbox):
    return {'libraryId':doc['id'],'librarySha256':doc['sha256'],'page':page,'bbox':bbox}

def parse_document(doc, pages):
    """Inputs contain local text only; locations retain the exact source page/column."""
    problems=[]; answers={}; key_mode=False; pattern=0; expected=set(); expected_locations={}; unresolved=[]
    for page in pages:
        patterns=PATTERN.findall(page['header'])
        if page.get('answerKey') or KEY.search(page['header']): key_mode=True
        if patterns and (not key_mode or not any(PATTERN.search(c['text']) for c in page['columns'])): pattern=int(patterns[0])
        for column in page['columns']:
            text=column['text']; loc=location(doc,page['page'],column['bbox'])
            if key_mode:
                local_pattern=pattern
                for match in SUMMARY.finditer(text):
                    prefix=PATTERN.findall(text[:match.start()])
                    if prefix: local_pattern=int(prefix[-1])
                    key=(local_pattern,int(match[1])); value=[str(CHOICES.index(c)+1) for c in re.findall('[①②③④⑤]',match[2])]
                    record={'answer':value,'locations':[loc],'kind':'objective'}
                    if key in answers and answers[key]['answer']!=value: answers[key]={'answer':[],'locations':[loc],'kind':'conflict'}
                    else: answers[key]=record
                details=list(ANSWER.finditer(text))
                for i,match in enumerate(details):
                    prefix=PATTERN.findall(text[:match.start()])
                    if prefix:local_pattern=int(prefix[-1])
                    tail=text[match.end():details[i+1].start() if i+1<len(details) else len(text)].strip()
                    first=re.match(r'^([①②③④⑤](?:\s*[,，]\s*[①②③④⑤])*)',tail)
                    if first:value=[str(CHOICES.index(c)+1) for c in re.findall('[①②③④⑤]',first[1])];kind='objective'
                    else:
                        value=[re.split(r'(?mi)^\s*(?::|(?:해설|정답 및 해설|오답|제시문|질문)\b|pattern\s*[1-9]\b)',tail)[0].strip()[:8000]];kind='short'
                        if not value[0]:continue
                    key=(local_pattern,int(match[1]));record={'answer':value,'locations':[loc],'kind':kind}
                    if key not in answers:answers[key]=record
                    elif answers[key]['answer']!=value and answers[key]['kind']==kind:answers[key]={'answer':[],'locations':[loc],'kind':'conflict'}
                # Answer sections can change pattern in the right column and continue on later pages.
                remaining=PATTERN.findall(text)
                if remaining: pattern=int(remaining[-1])
                continue
            markers=list(QUESTION.finditer(text))
            # Footnotes give an independent count even if a question heading did not extract.
            for marker in ANSWER.finditer(text):
                key=(pattern,int(marker[1]));expected.add(key);expected_locations.setdefault(key,loc)
            for i,marker in enumerate(markers):
                no=int(marker[1]);end=markers[i+1].start() if i+1<len(markers) else len(text)
                raw=text[marker.end():end].strip()
                anchor=re.search(r'(?<![\d(])'+str(no)+r'\)\s*',raw)
                if not anchor:
                    unresolved.append({'pattern':pattern,'no':no,'page':page['page'],'reason':'QUESTION_ANCHOR_MISSING'});continue
                raw=raw[:anchor.start()]+raw[anchor.end():]
                raw=re.sub(r'(?m)^\s*(?:중[123]\s+NE능률.*|NE능률\(김기택\).*|-[ \t]*\d+[ \t]*-)\s*$','',raw).strip()
                marks=list(re.finditer('[①②③④⑤]',raw));start=None
                for j,mark in enumerate(marks):
                    if [m[0] for m in marks[j:]]==list(CHOICES):start=j;break
                flags=['REVIEW_REQUIRED','QUESTION_LAYOUT_REVIEW','ANSWER_SOURCE_REVIEW']
                choices=[];stem=raw;kind='short'
                if start is not None:
                    selected=marks[start:];stem=raw[:selected[0].start()].strip()
                    choices=[{'label':str(j+1),'text':raw[m.end():selected[j+1].start() if j+1<len(selected) else len(raw)].strip()} for j,m in enumerate(selected)]
                    kind='mcq'
                else: flags.append('SHORT_ANSWER_REVIEW')
                if not stem:flags.append('STEM_MISSING')
                if re.search(r'밑줄|그림|사진|표를|underlined|picture|diagram|chart',raw,re.I):flags.append('VISUAL_OR_UNDERLINE_REVIEW')
                if re.search(r'\([1-9]\)',raw):flags.append('SUBPART_ANSWER_REVIEW')
                if re.search(r'위\s*(?:글|대화|지문)|다음\s*(?:글|대화|지문)|following\s+(?:passage|dialogue)',raw,re.I):flags.append('SHARED_CONTEXT_REVIEW')
                prefix=text[:marker.start()].strip()
                context=re.split(r'(?m)^\s*(?:[vVnN]\s+|\[\s*\d+\s*[~～-])',prefix)[-1].strip() if not i else ''
                problems.append({'key':(pattern,no),'row':{'id':f'ic-{doc["id"]}-p{pattern}-q{no}-n{len(problems)+1}',
                    'no':len(problems)+1,'footnoteNo':no,'source':doc['source'],'section':('Pattern '+str(pattern)) if pattern else doc['title'],
                    'formatType':kind,'instructionKo':stem[:12000],'isNegative':bool(re.search(r'않는|아닌|제외|\bnot\b|\bexcept\b',stem,re.I)),
                    'answerCount':1,'stimulus':{'type':'text','parts':[{'text':context[:12000]}] if context else []},'choices':choices,
                    'answer':[],'explanationKo':'','targetRefs':[{'patternNo':pattern}] if pattern else [],'notes':[],
                    '_pdfReview':{'flags':flags,'locations':[loc]}}})
    duplicates={key for key in (p['key'] for p in problems) if sum(p['key']==key for p in problems)>1}
    for item in problems:
        row=item['row']; answer=answers.get(item['key']);flags=row['_pdfReview']['flags']
        if item['key'] in duplicates:flags.append('DUPLICATE_QUESTION_NUMBER')
        elif answer and answer['kind']=='objective' and row['choices']:
            row['answer']=answer['answer'];row['answerCount']=len(row['answer'])
            row['formatType']='mcq_multi' if len(row['answer'])>1 else 'mcq'
            row['_pdfReview']['locations']+=answer['locations']
        elif answer and answer['kind']=='short' and not row['choices']:
            row['answer']=answer['answer'];row['_pdfReview']['locations']+=answer['locations']
        else:
            flags.append('ANSWER_UNRESOLVED')
            if answer and answer['answer']:row['_pdfReview']['locations']+=answer['locations']
    found={p['key'] for p in problems}
    for pat,no in sorted(expected-found):
        problems.append({'key':(pat,no),'row':{'id':f'ic-{doc["id"]}-p{pat}-q{no}-missing','no':len(problems)+1,'footnoteNo':no,'source':doc['source'],
            'section':('Pattern '+str(pat)) if pat else doc['title'],'formatType':'short','instructionKo':'','isNegative':False,'answerCount':1,
            'stimulus':{'type':'text','parts':[]},'choices':[],'answer':[],'explanationKo':'','targetRefs':[],'notes':[],
            '_pdfReview':{'flags':['REVIEW_REQUIRED','QUESTION_NOT_EXTRACTED','ANSWER_UNRESOLVED'],'locations':[expected_locations[(pat,no)]]}}})
    return [p['row'] for p in problems],{'source':doc['source'],'pages':len(pages),'items':len(problems),
        'anchorNumbers':len(expected),'missingNumbers':[{'pattern':p,'no':n} for p,n in sorted(expected-found)],
        'answerMatched':sum(bool(p['row']['answer']) for p in problems),'ambiguousHeadings':unresolved}

def extract_pages(path, doc, cache):
    import pdfplumber
    if path.resolve()!=path.absolute() or not path.is_file() or path.stat().st_nlink!=1:raise ValueError('SOURCE_NOT_REGULAR')
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    if digest!=doc['sha256']:raise ValueError('SOURCE_HASH_CHANGED')
    cached=cache/(digest+'-v2.json')
    if cached.exists():return json.loads(cached.read_text(encoding='utf8'))
    pages=[]
    with pdfplumber.open(path) as pdf:
        for no,page in enumerate(pdf.pages,1):
            full=page.extract_text() or ''
            boxes=[[30,45,page.width/2,page.height-35],[page.width/2,45,page.width-20,page.height-35]]
            columns=[{'bbox':box,'text':page.crop(box).extract_text(x_tolerance=2) or ''} for box in boxes]
            pages.append({'page':no,'header':full[:900],'answerKey':bool(KEY.search(full)),'columns':columns})
    cached.write_text(json.dumps(pages,ensure_ascii=False),encoding='utf8')
    return pages

def reading_cloze(doc, pages):
    rows=[]
    for page in pages:
        # Reading PDFs are a single column; only unchanged English sentences become candidates.
        english=[]
        for line in page['fullText'].splitlines():
            if re.search('[가-힣]',line) or not re.search('[A-Za-z]',line) or re.search(r'NE능률|copyright|exam4you|Lesson\s*\d',line,re.I):continue
            english.append(line.strip())
        for sentence in re.split(r'(?<=[.!?])\s+', ' '.join(english)):
            words=re.findall(r"[A-Za-z]+(?:['’-][A-Za-z]+)*",sentence)
            eligible=[w for w in words if len(w)>=4]
            if len(words)<5 or not eligible or not re.search(r'[.!?]["\u201d\u2019]*$',sentence):continue
            word=max(eligible,key=len);blank=re.sub(r'\b'+re.escape(word)+r'\b','________',sentence,count=1)
            rows.append({'id':f'ic-{doc["id"]}-reading-{len(rows)+1}','no':len(rows)+1,'footnoteNo':len(rows)+1,'source':'00','section':'본문 빈칸',
                'formatType':'short','instructionKo':'빈칸에 알맞은 원문의 단어를 쓰세요.','isNegative':False,'answerCount':1,
                'stimulus':{'type':'text','parts':[{'text':blank}]},'choices':[],'answer':[word],'explanationKo':'','targetRefs':[],'notes':[],
                '_pdfReview':{'flags':['REVIEW_REQUIRED','CLOZE_SOURCE_REVIEW'],'locations':[location(doc,page['page'],[30,45,page['width']-20,page['height']-35])]}})
    return rows

def build_unit(library,pack_id,out):
    private=Path(os.environ['LOCALAPPDATA'])/'WB'/'naesin-materials'
    if not library.resolve().is_relative_to(private.resolve()) or not out.resolve().is_relative_to(private.resolve()):raise ValueError('PRIVATE_ROOT_REQUIRED')
    if not re.fullmatch(r'(?:2022|2015)-[a-z0-9-]+-m[123]-(?:L(?:[1-9]|1[0-2])|S[LR][12]?)',pack_id):raise ValueError('UNIT_ID_INVALID')
    index=json.loads((library/'index.json').read_text(encoding='utf8'))
    if index['rights'].get('externalAiAllowed') is not False or index['rights'].get('studentUseAllowed') is not True or index['rights'].get('derivativeUseAllowed') is not True:raise ValueError('RIGHTS_POLICY_MISMATCH')
    documents=[d for d in index['documents'] if d['packId']==pack_id]
    if not documents:raise ValueError('UNIT_NOT_FOUND')
    cache=out/'page-cache';cache.mkdir(parents=True,exist_ok=True)
    items=[];reports=[]
    for doc in documents:
        if not (library/doc['file']).resolve().is_relative_to(library.resolve()):raise ValueError('SOURCE_OUTSIDE_LIBRARY')
        name=Path(doc['file']).name
        if name=='00_교과서본문.pdf':
            doc={**doc,'source':'00'}
            pages=extract_pages(library/doc['file'],doc,cache)
            # Full-width text is needed here rather than joining two column crops across lines.
            import pdfplumber
            with pdfplumber.open(library/doc['file']) as pdf:
                for record,page in zip(pages,pdf.pages):record.update(fullText=page.extract_text() or '',width=page.width,height=page.height)
            rows=reading_cloze(doc,pages)
            for row in rows:row['no']=len(items)+1;items.append(row)
            reports.append({'source':'00','pages':len(pages),'items':len(rows),'answerMatched':len(rows),'missingNumbers':[]})
            continue
        if name not in FILES:continue
        doc={**doc,'source':FILES[name]}
        rows,report=parse_document(doc,extract_pages(library/doc['file'],doc,cache))
        for row in rows:row['no']=len(items)+1;items.append(row)
        reports.append(report)
    payload={'packId':pack_id,'meta':{'curriculum':documents[0].get('curriculum',pack_id[:4]),'textbook':documents[0].get('textbook','NE능률(김기택)'),'grade':documents[0]['grade'],
        'lesson':int(re.search(r'-L(\d+)$',pack_id)[1]) if re.search(r'-L(\d+)$',pack_id) else None,
        'lessonTitle':documents[0]['unit'],'contentMode':'questions','source':'원내 PC 변환 · 교사 원본 대조 필요'},
        'rights':index['rights'],'draft':{'items':items}}
    out.mkdir(parents=True,exist_ok=True)
    (out/(pack_id+'.pending.json')).write_text(json.dumps(payload,ensure_ascii=False),encoding='utf8')
    report={'packId':pack_id,'sourceDocuments':len(documents),'questionSources':len(reports),'items':len(items),
        'answerMatched':sum(bool(r['answer']) for r in items),'sources':reports,'teacherApproved':0,'published':False}
    (out/(pack_id+'.audit.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    return {k:v for k,v in report.items() if k!='sources'}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--library',type=Path,required=True);parser.add_argument('--pack-id',required=True);parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args();print(json.dumps(build_unit(args.library,args.pack_id,args.out),ensure_ascii=True))
