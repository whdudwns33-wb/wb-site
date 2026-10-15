"""Offline workbook sentence/translation pairing; never sends source text to AI."""
import re

STAGE=re.compile(r'워크북\s*(\d+)')
HEAD=re.compile(r'(?m)^\s*(\d{1,3})\.\s+')
NUMBER=re.compile(r'(?<![\d(])(\d{1,3})\)\s*')

def clean(text):
    lines=[line.strip() for line in text.splitlines() if not re.match(r'^\s*(?:중[123]\s|NE능률|교과서\s*본문|본문\s*[┃│|]|Lesson\s+\d+\s+Answer|\d+\s*과\s+정답|-[ \t]*\d+[ \t]*-\s*$)',line,re.I)]
    lines=[line for line in lines if not (len(line)<30 and '교과서본문' in re.sub(r'\s','',line) and not re.search('[A-Za-z]',line))]
    return re.sub(r'\s+',' ',' '.join(lines)).strip()

def pair_workbook(pages,doc):
    english={};korean={};stage=None
    def loc(page,column):return {'libraryId':doc['id'],'librarySha256':doc['sha256'],'page':page['page'],'bbox':column['bbox']}
    for page in pages:
        if not page['key']:
            if '4' not in page['stages']:continue
            for col in page['columns']:
                matches=[];expected=len(english)+1
                for marker in HEAD.finditer(col['text']):
                    if int(marker[1])==expected:matches.append(marker);expected+=1
                for i,m in enumerate(matches):
                    no=int(m[1]);text=col['text'][m.end():matches[i+1].start() if i+1<len(matches) else len(col['text'])]
                    text=re.sub(r'(?<![\d(])'+str(no)+r'\)[ \t]*','',text)
                    value=clean(text)
                    if no in english:raise ValueError('DUPLICATE_EN_NUMBER')
                    english[no]=(value,loc(page,col))
        else:
            for col in page['columns']:
                events=sorted([(m.start(),m.end(),'stage',int(m[1])) for m in STAGE.finditer(col['text'])]+[(m.start(),m.end(),'number',int(m[1])) for m in NUMBER.finditer(col['text'])])
                for i,(_,end,kind,no) in enumerate(events):
                    if kind=='stage':stage=no;continue
                    if stage!=4:continue
                    value=clean(col['text'][end:events[i+1][0] if i+1<len(events) else len(col['text'])])
                    if no in korean:raise ValueError('DUPLICATE_KO_NUMBER')
                    korean[no]=(value,loc(page,col))
    if not english or sorted(english)!=list(range(1,len(english)+1)) or set(english)!=set(korean):raise ValueError('SENTENCE_NUMBER_MISMATCH')
    rows=[]
    for no,(en,where) in sorted(english.items()):
        ko,answer_where=korean[no]
        if not re.search('[A-Za-z]',en) or not re.search('[가-힣]',ko):raise ValueError('SENTENCE_LANGUAGE_MISMATCH')
        rows.append({'seq':no,'dayGroup':str((no-1)//8+1),'dayHeaderKo':'학습 묶음 '+str((no-1)//8+1),'en':en,'ko':ko,
            'chunks':[{'en':en,'ko':ko}],'keywords':[{'en':en,'ko':ko}],'tokens':en.split(),'verbForms':[],'grammarChoices':[],'writingKeywords':[],
            'notes':['원문 문장 단위 대응 · 세부 구문 분할 없음'],
            '_pdfReview':{'flags':['SOURCE_NUMBER_PAIRED','NO_EXTERNAL_AI'],'locations':[where,answer_where]}})
    return rows

def pair_bilingual(pages,doc):
    rows=[]
    for page in pages:
        parts=[re.split(r'(?<=[.!?])\s+',clean(p['text'])) for p in page['parts']]
        if len(parts[0])!=len(parts[1]):raise ValueError('BILINGUAL_SENTENCE_COUNT_MISMATCH')
        for en,ko in zip(*parts):
            if not re.search('[A-Za-z]',en) or re.search('[가-힣]',en) or not re.search('[가-힣A-Za-z]',ko):raise ValueError('BILINGUAL_SENTENCE_LANGUAGE_MISMATCH')
            no=len(rows)+1
            rows.append({'seq':no,'dayGroup':str((no-1)//8+1),'dayHeaderKo':'학습 묶음 '+str((no-1)//8+1),'en':en,'ko':ko,
                'chunks':[{'en':en,'ko':ko}],'keywords':[{'en':en,'ko':ko}],'tokens':en.split(),'verbForms':[],'grammarChoices':[],'writingKeywords':[],
                'notes':['원문 문장 단위 대응 · 세부 구문 분할 없음'],
                '_pdfReview':{'flags':['PAGE_SENTENCE_PAIRED','NO_EXTERNAL_AI'],'locations':[{'libraryId':doc['id'],'librarySha256':doc['sha256'],'page':page['page'],'bbox':p['bbox']} for p in page['parts']]}})
    if not rows:raise ValueError('EMPTY_BILINGUAL_SOURCE')
    return rows
