#!/usr/bin/env python3
"""Offline, fail-closed folder draft builder for a verified local page-text bundle."""
import argparse, hashlib, json, os, re, stat, sys
from pathlib import Path
ROLES={'00':('textbook','00_교과서본문.pdf'),'01':('content_summary','01_내용정리.pdf'),'02':('passage_workbook','02_본문워크북.pdf'),'03':('vocabulary','03_단어시험.pdf'),'04s':('pre_step_student','04_예상문제_PRE-STEP.pdf'),'04t':('pre_step_teacher','04_예상문제_PRE-STEP_교사용.pdf'),'05s':('exam_1_student','05_예상문제_1회.pdf'),'05t':('exam_1_teacher','05_예상문제_1회_교사용.pdf'),'06s':('exam_2_student','06_예상문제_2회.pdf'),'06t':('exam_2_teacher','06_예상문제_2회_교사용.pdf'),'07':('grammar_workbook','07_문법워크북.pdf'),'08':('grammar_mcq','08_문법객관식.pdf'),'09':('grammar_subjective','09_문법주관식.pdf')}
REPO=Path(__file__).resolve().parents[2]
class DraftError(Exception): pass
def fail(code): raise DraftError(code)
def regular(p):
 s=p.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or p.resolve(strict=True)!=p.absolute(): fail('INVALID_FILE')
 return s
def norm(s): return re.sub(r'\s+',' ',s).strip()
def numbered(text):
 ms=list(re.finditer(r'(?<!\d)(\d{1,2})\)',text)); out={}
 for i,m in enumerate(ms):
  n=int(m.group(1)); v=norm(text[m.end():ms[i+1].start() if i+1<len(ms) else len(text)])
  if 1<=n<=25 and v: out.setdefault(n,[]).append(v)
 return out
def marked(text, endmark):
 text=re.sub(r'\s+',' ',text).strip(); out={}
 rx=re.compile(r'(?<!\S)(\d{1,2})'+endmark+r'\s+(.*?)(?=\s+\d{1,2}'+endmark+r'\s|$)')
 for m in rx.finditer(text):
  n=int(m.group(1)); value=norm(m.group(2))
  if 1<=n<=25 and value: out.setdefault(n,[]).append(value)
 return out
def words(src):
 rows=[]
 seen=set()
 for page in src['pages']:
  if page['page']>7: continue
  for line in page.get('text','').splitlines():
   line=norm(line)
   if '□' not in line: continue
   m=re.search(r'□\s*(.+?)\s+((?:n|v|a|adj|adv|prep|pron|conj|int|phr|aux)\.?)\s+(.+)$',line,re.I)
   if not m: continue
   head,pos,meaning=map(norm,m.groups())
   if not re.search('[A-Za-z]',head) or not re.search('[가-힣]',meaning): continue
   key=re.sub(r'\s+',' ',head).casefold()
   if key in seen: continue
   seen.add(key)
   pn=page['page']; rows.append({'candidateId':f'wc-{len(rows)+1:04d}','headCandidate':head,'meanings':[meaning],'posCandidates':[pos],'sourceRefs':[{'sourceDocumentId':'03','page':pn,'printedPage':pn,'section':None,'questionNo':None}],'reviewFlags':['REVIEW_REQUIRED','PLAIN_TEXT_NO_COORDINATES']})
 return rows
def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--text-bundle',required=True); ap.add_argument('--folder',required=True); ap.add_argument('--word-seed'); ap.add_argument('--passage-title-en'); ap.add_argument('--passage-title-ko'); ap.add_argument('--install-sources',action='store_true'); ap.add_argument('outdir'); a=ap.parse_args()
 try:
  folder_arg=Path(a.folder).absolute(); bundle_arg=Path(a.text_bundle).absolute()
  if folder_arg.is_symlink() or not folder_arg.is_dir() or folder_arg.resolve(strict=True)!=folder_arg: fail('PATH_POLICY')
  folder=folder_arg; out=Path(a.outdir).resolve(); bundle_path=bundle_arg
  if out.exists() or out.is_relative_to(REPO) or bundle_path.is_relative_to(REPO): fail('PATH_POLICY')
  regular(bundle_path)
  for sidecar in (folder/'_meta.txt',folder/'_rights.json'): regular(sidecar)
  meta=(folder/'_meta.txt').read_text(encoding='utf-8').strip(); rights=json.loads((folder/'_rights.json').read_text(encoding='utf-8'))
  if meta!='revision: 2022': fail('REVISION_MISMATCH')
  if rights.get('basis')!='licensed' or not rights.get('holder') or not rights.get('evidenceRef') or rights.get('studentUseAllowed') is not True or rights.get('derivativeUseAllowed') is not True or rights.get('externalAiAllowed') is not False or '원내' not in rights.get('notes',''): fail('RIGHTS_GATE_FAILED')
  regular(bundle_path); bundle=json.loads(bundle_path.read_text(encoding='utf-8'))
  if bundle.get('kind')!='wb-naesin-page-text-bundle' or bundle.get('version')!=1 or len(bundle.get('sources',[]))!=13: fail('BUNDLE_INVALID')
  docs=[]; srcs={}; seen=set()
  for src in bundle['sources']:
   sid=src.get('id'); expected=ROLES.get(sid)
   if expected is None or sid in seen or src.get('role')!=expected[0] or src.get('file')!=expected[1]: fail('SOURCE_ROLE_MISMATCH')
   seen.add(sid); p=folder/expected[1]; regular(p); b=p.read_bytes(); sha=hashlib.sha256(b).hexdigest()
   if len(b)!=src.get('bytes') or sha!=src.get('sha256') or len(src.get('pages',[]))!=src.get('pageCount'): fail('SOURCE_HASH_MISMATCH')
   docs.append({'sourceDocumentId':sid,'role':expected[0],'file':expected[1],'sha256':sha,'bytes':len(b),'pageCount':src['pageCount'],'reviewOnly':True}); srcs[sid]=src
  if seen!=set(ROLES): fail('SOURCE_SET_MISMATCH')
  total=sum(d['pageCount'] for d in docs)
  if total!=sum(len(s['pages']) for s in bundle['sources']): fail('BUNDLE_PAGE_COUNT_MISMATCH')
  wr=words(srcs['03']); seed_used=False
  if a.word_seed:
   seed_path=Path(a.word_seed).absolute()
   if seed_path.resolve(strict=True).is_relative_to(REPO): fail('WORD_SEED_PATH_POLICY')
   regular(seed_path)
   seed=json.loads(seed_path.read_text(encoding='utf-8')); sd=seed.get('draft',seed)
   meta03=next(d for d in docs if d['sourceDocumentId']=='03')
   s03=sd.get('sources',{}).get('03',{})
   if s03.get('sha256')!=meta03['sha256'] or s03.get('pageCount')!=meta03['pageCount'] or not isinstance(sd.get('wordCandidates'),list) or not sd['wordCandidates']: fail('WORD_SEED_SOURCE_MISMATCH')
   seeded=[]
   for item in sd['wordCandidates']:
    refs=[]
    for row in item.get('sourceRows',[]):
     if row.get('sha256')!=meta03['sha256'] or not isinstance(row.get('page'),int) or not 1<=row['page']<=meta03['pageCount']: fail('WORD_SEED_ROW_MISMATCH')
     bbox=row.get('bbox')
     if not isinstance(bbox,list) or len(bbox)!=4 or any(not isinstance(v,(int,float)) or v<0 for v in bbox) or bbox[0]>bbox[2] or bbox[1]>bbox[3]: fail('WORD_SEED_BBOX_INVALID')
     refs.append({'sourceDocumentId':'03','page':row['page'],'printedPage':row['page'],'section':None,'questionNo':None,'bbox':bbox})
    if not refs: fail('WORD_SEED_ROW_MISSING')
    seeded.append({'candidateId':item['candidateId'],'headCandidate':item['headCandidate'],'meanings':item.get('meanings',[]),'posCandidates':item.get('posCandidates',[]),'sourceRefs':refs,'reviewFlags':sorted(set(item.get('reviewFlags',[])+['REVIEW_REQUIRED']))})
   wr=seeded; seed_used=True
  en={}
  for pn in (9,10): en.update(marked(next(p['text'] for p in srcs['02']['pages'] if p['page']==pn),r'\.'))
  ko={}; ko_headers={}
  for pn in (29,30):
   t=next(p['text'] for p in srcs['02']['pages'] if p['page']==pn)
   if pn==29: t=t.split('워크북 4',1)[-1]
   else: t=re.sub(r'워크북 5.*','',t,flags=re.S)
   for m in re.finditer(r'8\s*월\s*[1-3]\s*일\s*(?:월|화|수)요일?',t):
    ko_headers.setdefault(len(ko_headers)+1,norm(m.group(0)))
   ko.update(marked(t,r'\)'))
  sent=[]
  for n in range(1,26):
   e=norm(' '.join(en.get(n,[]))); k=norm(' '.join(ko.get(n,[]))); ep=9 if n<=12 else 10; kp=29 if n<=20 else 30
   e=re.sub(r'\s*'+str(n)+r'\)$','',e).strip()
   header=None; header_ko=ko_headers.get(1 if n<11 else 2 if n<20 else 3)
   k=re.sub(r'^8\s*월\s*[1-3]\s*일\s*(?:월|화|수)요일?\s*','',k).strip()
   m=re.match(r'(?i)^(monday|tuesday|wednesday)\s*,?\s*august\s+(1|2|3)\b[,:]?\s*',e)
   if m and n in (1,11,20):
    header=m.group(0).strip(' ,:'); e=e[m.end():].strip()
   if n in (1,11,20):
    e=re.sub(r'(?i)^(monday|tuesday|wednesday)\s*,?\s*august\s+(1|2|3)\b[,:]?\s*','',e).strip()
   sent.append({'candidateId':f'sc-{n:04d}','seq':n,'en':e,'ko':k,'passageTitle':a.passage_title_en,'passageTitleEn':a.passage_title_en,'passageTitleKo':a.passage_title_ko,'dayHeaderEn':header,'dayHeaderKo':header_ko,'dayGroup':('8/1' if n<11 else '8/2' if n<20 else '8/3'),'chunks':[],'verbForms':[],'grammarChoices':[],'tokens':[],'writingKeywords':[],'sourceRefs':[{'sourceDocumentId':'02','page':ep,'printedPage':ep,'section':'workbook-4','questionNo':n},{'sourceDocumentId':'02','page':kp,'printedPage':kp,'section':'workbook-4-answer','questionNo':n}],'unmatchedEnrichment':[{'field':'verbForms','sourceRefs':[{'sourceDocumentId':'02','page':(11 if n<=9 else 12 if n<=19 else 13),'printedPage':(11 if n<=9 else 12 if n<=19 else 13),'section':'verb-form','questionNo':n},{'sourceDocumentId':'02','page':30,'printedPage':30,'section':'verb-form-answer','questionNo':n}]},{'field':'grammarChoices','sourceRefs':[{'sourceDocumentId':'02','page':(14 if n<=9 else 15 if n<=18 else 16),'printedPage':(14 if n<=9 else 15 if n<=18 else 16),'section':'grammar-choice','questionNo':n},{'sourceDocumentId':'02','page':30,'printedPage':30,'section':'grammar-choice-answer','questionNo':n}]},{'field':'tokens','sourceRefs':[{'sourceDocumentId':'02','page':(20 if n<=8 else 21 if n<=17 else 22),'printedPage':(20 if n<=8 else 21 if n<=17 else 22),'section':'tokens','questionNo':n}]},{'field':'writingKeywords','sourceRefs':[{'sourceDocumentId':'02','page':(23 if n<=6 else 24 if n<=12 else 25 if n<=19 else 26),'printedPage':(23 if n<=6 else 24 if n<=12 else 25 if n<=19 else 26),'section':'writing-keywords','questionNo':n},{'sourceDocumentId':'02','page':31,'printedPage':31,'section':'writing-keywords-answer','questionNo':n}]}],'reviewFlags':['REVIEW_REQUIRED','PLAIN_TEXT_NO_COORDINATES','ENRICHMENT_UNMATCHED']+([] if e else ['EN_UNRESOLVED'])+([] if k else ['KO_UNRESOLVED'])})
  draft={'kind':'naesin-folder-review-draft','version':1,'status':'needs-review','publishable':False,'rights':{k:rights[k] for k in ['basis','holder','evidenceRef','studentUseAllowed','derivativeUseAllowed','externalAiAllowed','notes']},'revision':'2022','wordSeedUsed':seed_used,'sourceDocuments':docs,'wordCandidates':wr,'sentenceCandidates':sent,'unmatched':[{'candidateId':r['candidateId'],'field':u['field'],'sourceRefs':u['sourceRefs'],'reason':'NO_DETERMINISTIC_MATCH'} for r in sent for u in r['unmatchedEnrichment']],'enrichmentSummary':{'verbForms':{'matched':0,'unmatched':25},'grammarChoices':{'matched':0,'unmatched':25},'tokens':{'matched':0,'unmatched':25},'writingKeywords':{'matched':0,'unmatched':25}},'reviewFlags':['REVIEW_REQUIRED','PLAIN_TEXT_NO_COORDINATES','NO_EXTERNAL_AI']+([] if a.passage_title_en and a.passage_title_ko else ['PASSAGE_TITLE_REVIEW'])}
  out.parent.mkdir(parents=True,exist_ok=True); out.mkdir(mode=0o700,exist_ok=False)
  target=out/'review-draft.json'
  with target.open('x',encoding='utf-8') as f: json.dump(draft,f,ensure_ascii=False,indent=2); f.write('\n')
  if a.install_sources:
   import datetime
   private=Path(os.environ.get('LOCALAPPDATA',Path.home()/'AppData'/'Local'))/'WB'/'naesin-materials'/folder.name
   private.mkdir(parents=True,exist_ok=True)
   if private.is_symlink() or not private.is_dir() or private.resolve(strict=True)!=private.absolute(): fail('INSTALL_PATH_INVALID')
   for doc in docs:
    dest=private/doc['file']; src=folder/doc['file']
    if dest.exists():
     regular(dest)
     if dest.stat().st_size!=doc['bytes'] or hashlib.sha256(dest.read_bytes()).hexdigest()!=doc['sha256']: fail('INSTALL_SOURCE_CONFLICT')
   for doc in docs:
    dest=private/doc['file']
    if not dest.exists():
     with dest.open('xb') as f: f.write((folder/doc['file']).read_bytes())
   analysis=private/'analysis'; analysis.mkdir(exist_ok=True)
   if analysis.is_symlink() or not analysis.is_dir() or analysis.resolve(strict=True)!=analysis.absolute(): fail('INSTALL_PATH_INVALID')
   stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
   review=analysis/f'draft-{stamp}-{hashlib.sha256(target.read_bytes()).hexdigest()[:6]}'
   review.mkdir(exist_ok=False)
   with (review/'review-draft.json').open('x',encoding='utf-8') as f: f.write(target.read_text(encoding='utf-8'))
  print(json.dumps({'ok':True,'publishable':False,'sourceDocuments':len(docs),'sourcePages':total,'words':len(wr),'sentences':len(sent),'enNonempty':sum(bool(x['en']) for x in sent),'koNonempty':sum(bool(x['ko']) for x in sent),'wordSeedUsed':seed_used,'unmatchedEnrichment':len(draft['unmatched']),'installed':a.install_sources},ensure_ascii=True))
 except DraftError as e: print(json.dumps({'ok':False,'error':str(e)})); return 1
 except Exception: print(json.dumps({'ok':False,'error':'SOURCE_OR_OUTPUT_FAILED'})); return 1
 return 0
if __name__=='__main__': sys.exit(main())
