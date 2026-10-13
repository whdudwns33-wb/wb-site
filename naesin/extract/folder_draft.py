#!/usr/bin/env python3
"""Offline, fail-closed folder draft builder for a verified local page-text bundle."""
import argparse, hashlib, json, os, re, stat, sys, unicodedata
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
def is_hangul_syllable(char):
 return len(char)==1 and 0xac00<=ord(char)<=0xd7a3
def is_structural_line_start(line):
 value=line.strip()
 if not value:return False
 if re.match(r'^\d{1,3}\s*[.)]',value) or re.match(r'^\(\s*\d{1,2}\s*\)',value):return True
 first=ord(value[0])
 if 0x2460<=first<=0x2473 or 0x2776<=first<=0x277f:return True
 if value[0] in 'GBMW' and len(value)>1 and value[1]==':':return True
 if first in {0x2022,0x25e6,0x25aa,0x25a0,0x25a1,0x25ab,0x25cf,0x25cb,0x25c6,0x25c7,0x25b6,0x25b9,0x25bc,0x25b8,0x203b,0x27a4,0x2713,0x2714}:return True
 if value[0] in 'nvNV' and len(value)>1 and value[1].isspace() and value[2:].lstrip().startswith(('다음','Look','Rewrite')):return True
 if value.startswith(('중2','중등 2022','NE능률','Lesson 6 Answer Key','실전편')) or re.match(r'^-\s*\d+\s*-$',value):return True
 if re.match(r'^[A-Z]\.\s',value) or re.match(r'(?i)^(?:PRE-STEP|PATTERN\s*\d+|Grammar\s+Build\s+Up|Let.s\s+Use\s+It|Functions\b|Topic\s+\d|Q\s*:|A\s*:)',value):return True
 compact=''.join(value.split())
 headers=('단어','어휘','어법','대화문','의사소통','본문','문법','실전편')
 if any(compact.startswith(header) and ('┃' in compact or '|' in compact) for header in headers):return True
 labels=tuple(sorted(headers+('객관식','주관식'),key=len,reverse=True)); pos=0
 while pos<len(compact):
  token=next((x for x in labels if compact.startswith(x,pos)),None)
  if token is None:break
  pos+=len(token)
 if pos==len(compact):return True
 return False
def source_line_separator(previous_content,previous_raw_line,next_raw_line):
 next_content=next_raw_line.strip()
 no_separator=bool(previous_content and previous_raw_line and not previous_raw_line[-1].isspace() and is_hangul_syllable(previous_content[-1]) and next_content and is_hangul_syllable(next_content[0]) and not is_structural_line_start(next_content))
 if no_separator and (next_content.startswith('것') or next_content.startswith('많은')):return ' '
 return '' if no_separator else ' '
def source_line_join(lines):
 result=''; previous_raw=None; previous_content=''
 for raw in lines:
  if not isinstance(raw,str): continue
  content=raw.strip()
  if not content:
   previous_raw=raw; previous_content=''; continue
  if result: result+=source_line_separator(previous_content,previous_raw,raw)
  result+=content
  previous_raw=raw; previous_content=content
 return result
def numbered(text):
 ms=list(re.finditer(r'(?<!\d)(\d{1,2})\)',text)); out={}
 for i,m in enumerate(ms):
  n=int(m.group(1)); v=norm(text[m.end():ms[i+1].start() if i+1<len(ms) else len(text)])
  if 1<=n<=25 and v: out.setdefault(n,[]).append(v)
 return out
def marked(text, endmark):
 text=source_line_join(text.splitlines())
 text=re.sub(r'\s+',' ',text).strip(); out={}
 rx=re.compile(r'(?<!\S)(\d{1,2})'+endmark+r'\s+(.*?)(?=\s+\d{1,2}'+endmark+r'\s|$)')
 for m in rx.finditer(text):
  n=int(m.group(1)); value=norm(m.group(2))
  if 1<=n<=25 and value: out.setdefault(n,[]).append(value)
 return out
def numbered_pages(src, page_numbers):
 rows={}
 for pn in page_numbers:
  page=next((p for p in src['pages'] if p['page']==pn),None)
  if page is None: continue
  for n,values in numbered(page.get('text','')).items():
   rows.setdefault(n,[]).extend({'text':value,'page':pn} for value in values)
 return rows
def numbered_page_blocks(src, page_numbers):
 rows={}
 for pn in page_numbers:
  page=next((p for p in src['pages'] if p['page']==pn),None)
  if page is None: continue
  text=page.get('text',''); marks=list(re.finditer(r'(?<!\d)(\d{1,2})\)',text))
  for i,mark in enumerate(marks):
   n=int(mark.group(1)); value=text[mark.end():marks[i+1].start() if i+1<len(marks) else len(text)].strip()
   if 1<=n<=25 and value: rows.setdefault(n,[]).append({'text':value,'page':pn})
 return rows
def exercise_answers(text, number, next_number):
 start=re.search(r'워크북\s*'+str(number)+r'\b',text)
 if not start: return {}
 tail=text[start.end():]
 if next_number is not None:
  end=re.search(r'워크북\s*'+str(next_number)+r'\b',tail)
  if end: tail=tail[:end.start()]
 return {n:[{'text':value,'page':30} for value in values] for n,values in numbered(tail).items()}
def page_ref(page, section, question_no=None):
 return {'sourceDocumentId':'02','page':page,'printedPage':page,'section':section,'questionNo':question_no}
def compare_text(value):
 return re.sub(r'\s+',' ',unicodedata.normalize('NFKC',value)).strip().casefold().strip('.,!?;:')
def slash_parts(value):
 parts=[norm(x).strip('.,!?;:') for x in value.split('/')]
 return parts if parts and all(parts) else None
def token_group_parts(value):
 parts=[norm(x) for x in value.split('/')]
 return parts if len(parts)>=2 and all(parts) else None
def balanced_parentheses(value):
 depth=0
 for char in value:
  if char=='(': depth+=1
  elif char==')':
   depth-=1
   if depth<0: return False
 return depth==0
def writing_keywords(text):
 boundaries=list(re.finditer(r'_{5,}|(?i:Monday|Tuesday|Wednesday)\s*,?\s*August\s+(?:[1-9]|[12]\d|3[01])\b',text))
 if not boundaries: return None,'NO_DETERMINISTIC_MATCH'
 prefix=text[:boundaries[0].start()]
 values=[norm(value) for value in prefix.split(',')]
 values=[value for value in values if value]
 return (values,None) if values else (None,'NO_DETERMINISTIC_MATCH')
def candidate_ref(source_id,page,section,side=None,line_start=None,line_end=None,question_no=None):
 ref={'sourceDocumentId':source_id,'page':page,'printedPage':page,'section':section}
 if side is not None: ref['side']=side
 if line_start is not None: ref['lineStart']=line_start
 if line_end is not None: ref['lineEnd']=line_end
 if question_no is not None: ref['questionNo']=question_no
 return ref
def numbered_sections(lines,offset=0,limit=3):
 marks=[(i,int(m.group(1))) for i,line in enumerate(lines) if (m:=re.fullmatch(r'\s*([1-9])\.\s*',line)) and int(m.group(1))<=limit]
 out={}
 for j,(i,n) in enumerate(marks):
  end=marks[j+1][0] if j+1<len(marks) else len(lines)
  out.setdefault(n,[]).append((lines[i+1:end],offset+i+1))
 return out
def dialogue_turns(lines,offset=0):
 turns=[]; current=None
 stop=re.compile(r'^\s*(?:\d+\s*\.\s|[A-D]\.\s|Q\s*:|\[|Let.s\s+Use\s+It|Topic\s+\d|◗|▌|❙|Functions\b)',re.I)
 for index,line in enumerate(lines):
  value=line.strip()
  if not value: continue
  if '↳' in value or '↲' in value or re.match(r'^\s*TIP\b',value,re.I): continue
  match=re.match(r'^\s*([GBMW]):\s*(.*)$',line)
  if match:
   body=re.sub(r'^\s*\d+\s+','',match.group(2)).strip()
   current={'speaker':match.group(1),'text':body,'lastRawLine':line,'startLine':offset+index+1,'endLine':offset+index+1};turns.append(current)
   continue
  if stop.match(value): current=None;continue
  if current and re.search(r'[A-Za-z\uac00-\ud7a3]',value):
   current['text']+=source_line_separator(current['text'],current['lastRawLine'],line)+value;current['endLine']=offset+index+1;current['lastRawLine']=line
 return [{'speaker':x['speaker'],'text':norm(x['text']),'startLine':x['startLine'],'endLine':x['endLine']} for x in turns]
def matched_dialogue_candidate(candidate_id,title,section,page,en_turns,ko_turns,en_section,ko_section,question_no=None):
 en_speakers=[x['speaker'] for x in en_turns];ko_speakers=[x['speaker'] for x in ko_turns]
 refs=[en_section,ko_section]
 if en_speakers!=ko_speakers:
  return {'candidateId':candidate_id,'id':candidate_id.replace('dc-','d-'),'title':title,'section':section,'lines':[],'sourceRefs':refs,'reviewFlags':['REVIEW_REQUIRED','SPEAKER_SEQUENCE_UNRESOLVED']},'SPEAKER_SEQUENCE_MISMATCH'
 if not en_turns or any(not x['text'] for x in en_turns+ko_turns):
  return {'candidateId':candidate_id,'id':candidate_id.replace('dc-','d-'),'title':title,'section':section,'lines':[],'sourceRefs':refs,'reviewFlags':['REVIEW_REQUIRED','EMPTY_DIALOGUE_LINE']},'EMPTY_OR_MISSING_DIALOGUE'
 lines=[{'speaker':e['speaker'],'en':e['text'],'ko':k['text']} for e,k in zip(en_turns,ko_turns)]
 return {'candidateId':candidate_id,'id':candidate_id.replace('dc-','d-'),'title':title,'section':section,'lines':lines,'sourceRefs':refs,'reviewFlags':['REVIEW_REQUIRED']},None
def extract_dialogue_candidates(src):
 pages={p['page']:p['text'].splitlines() for p in src['pages']}; candidates=[];unmatched=[]
 p1=pages.get(1,[]); split=max((i for i,line in enumerate(p1) if '의사소통 기능' in line or '우리말 해석' in line),default=len(p1))
 en1=p1[:split];ko_header=max((i for i,line in enumerate(p1[split:],split) if re.search(r'A\.\s*Listen and Check',line,re.I)),default=None)
 en_sections=numbered_sections(en1,0,3);ko_sections=numbered_sections(p1[ko_header+1:],ko_header+1,3) if ko_header is not None else {}
 for n in (1,2,3):
  er=en_sections.get(n,[]);kr=ko_sections.get(n,[]); et,kt=(dialogue_turns(er[0][0],er[0][1]) if len(er)==1 else []),(dialogue_turns(kr[0][0],kr[0][1]) if len(kr)==1 else [])
  eref=candidate_ref('01',1,'A. Listen and Check','EN',min((x['startLine'] for x in et),default=1),max((x['endLine'] for x in et),default=split),n)
  kref=candidate_ref('01',1,'A. Listen and Check','KO',min((x['startLine'] for x in kt),default=(ko_header or 0)+1),max((x['endLine'] for x in kt),default=len(p1)),n)
  row,reason=matched_dialogue_candidate(f'dc-{len(candidates)+1:04d}',f'A. Listen and Check {n}','A. Listen and Check',1,et,kt,eref,kref,n);candidates.append(row)
  if reason: unmatched.append({'candidateId':row['candidateId'],'field':'dialogueCandidates','reason':reason,'sourceRefs':[eref,kref]})
 for pn,section,heading in ((2,'C. Listen Up',r'C\.\s*Listen Up'),(3,'Real-Life Communication',r'Real-Life Communication')):
  lines=pages.get(pn,[]); marker=next((i for i,x in enumerate(lines) if '우리말 해석' in x),None)
  if marker is None: en_block=lines;ko_block=[];koff=0
  else: en_block=lines[:marker];ko_block=lines[marker+1:];koff=marker+1
  et=dialogue_turns(en_block,0);kt=dialogue_turns(ko_block,koff)
  anchor=next((i for i,x in enumerate(lines) if re.search(heading,x,re.I)),0)
  title=re.sub(r'^\s*[◗▌\s]+|\s*[┃|].*$','',lines[anchor]).strip() if lines else section
  eref=candidate_ref('01',pn,section,'EN',min((x['startLine'] for x in et),default=anchor+1),max((x['endLine'] for x in et),default=marker or len(lines)))
  kref=candidate_ref('01',pn,section,'KO',min((x['startLine'] for x in kt),default=koff+1),max((x['endLine'] for x in kt),default=len(lines)))
  row,reason=matched_dialogue_candidate(f'dc-{len(candidates)+1:04d}',title,section,pn,et,kt,eref,kref);candidates.append(row)
  if reason: unmatched.append({'candidateId':row['candidateId'],'field':'dialogueCandidates','reason':reason,'sourceRefs':[eref,kref]})
 line_count=sum(len(x['lines']) for x in candidates);summary={'matched':sum(bool(x['lines']) for x in candidates),'unmatched':sum(not bool(x['lines']) for x in candidates),'lines':line_count}
 return candidates,unmatched,summary
def extract_functions(src,dialogues):
 p=next((x for x in src['pages'] if x['page']==1),None);lines=p['text'].splitlines() if p else [];unmatched=[];out=[]
 start=next((i for i,x in enumerate(lines) if re.search(r'Functions\b',x,re.I)),None)
 end=next((i for i in range((start or 0)+1,len(lines)) if re.search(r'Topic\s+\d|A\.\s*Listen and Check',lines[i],re.I)),len(lines)) if start is not None else len(lines)
 bullets=[(i,re.sub(r'^\s*•\s*','',lines[i]).strip()) for i in range((start or 0)+1,end) if re.match(r'^\s*•\s*\S',lines[i])]
 annotations=[(i,line) for i,line in enumerate(lines[:start or 0]) if '↳' in line]
 for j,(idx,title) in enumerate(bullets):
  stop=bullets[j+1][0] if j+1<len(bullets) else end
  example=norm(source_line_join(lines[idx+1:stop]));direct=[]
  for ai,line in annotations:
   labels=[norm(x) for x in re.findall(r'\(([^()]*)\)',line)]
   if any(compare_text(x)==compare_text(title) for x in labels): direct.append((ai,line))
  explain='';direct_patterns=[]
  for ai,line in direct:
   quoted=[x.strip() for x in re.findall(r'[‘’](.*?)[‘’]',line) if re.search(r'[\uac00-\ud7a3]',x)]
   if quoted and not explain: explain=quoted[-1]
   direct_patterns.extend([x for x in annotation_pattern_segments(line)])
  pattern_options=[]
  if explain:
   for ai,line in annotations:
    quoted=[x.strip() for x in re.findall(r'[‘’](.*?)[‘’]',line)]
    if any(compare_text(q)==compare_text(explain) for q in quoted):
     pattern_options.extend((x,ai) for x in annotation_pattern_segments(line))
  if not pattern_options: pattern_options=[(x,ai) for ai,_ in direct for x in annotation_pattern_segments(_)]
  best_pattern,blank=find_pattern_blank(pattern_options,example)
  if not best_pattern: best_pattern=direct_patterns[0] if direct_patterns else ''
  pair=[]
  for d in dialogues:
   for ln in d['lines']:
    if norm(ln['en'])==example and ln['ko'].strip(): pair.append((ln,d))
  refs=[candidate_ref('01',1,'Functions',None,idx+1,stop)]
  refs.extend(candidate_ref('01',1,'function-annotation',None,ai+1,ai+1) for ai,_ in direct)
  if len(pair)==1:
   matched_line,dialogue=pair[0];example_ko=matched_line['ko']
   ref_match=next((r for r in dialogue['sourceRefs'] if r.get('side')=='EN'),None)
   if ref_match: refs.append(ref_match)
   ref_match=next((r for r in dialogue['sourceRefs'] if r.get('side')=='KO'),None)
   if ref_match: refs.append(ref_match)
  else: example_ko=''
  cid=f'fc-{len(out)+1:04d}';flags=['REVIEW_REQUIRED']
  if len(pair)!=1: flags.append('FUNCTION_EXAMPLE_UNPAIRED')
  row={'candidateId':cid,'id':cid.replace('fc-','fn-'),'name':title,'pattern':best_pattern,'explainKo':explain,'exampleEn':example,'exampleKo':example_ko,'sourceRefs':refs,'reviewFlags':flags};out.append(row)
  if len(pair)!=1 or not best_pattern or not explain: unmatched.append({'candidateId':cid,'field':'functionCandidates','reason':'FUNCTION_EXAMPLE_OR_ANNOTATION_UNRESOLVED','sourceRefs':refs})
 key_candidates=[]
 for i,row in enumerate(out):
  phrase_blank=find_pattern_blank([(row['pattern'],0)],row['exampleEn'])[1]
  if row['exampleEn'] and row['exampleKo'] and phrase_blank and re.search(r'(?<![A-Za-z])'+re.escape(phrase_blank)+r'(?![A-Za-z])',row['exampleEn'],re.I):
   refs=list(row['sourceRefs']);key_candidates.append({'candidateId':f'kc-{i+1:04d}','en':row['exampleEn'],'ko':row['exampleKo'],'blankAnswer':phrase_blank,'sourceRefs':refs,'reviewFlags':['REVIEW_REQUIRED']})
  else:
   unmatched.append({'candidateId':row['candidateId'],'field':'keyExpressionCandidates','reason':'BLANK_ANSWER_OR_EXACT_PAIR_UNRESOLVED','sourceRefs':row['sourceRefs']})
 return out,key_candidates,unmatched,{'matched':len(out)-sum(x['field']=='functionCandidates' for x in unmatched),'unmatched':sum(x['field']=='functionCandidates' for x in unmatched)}, {'matched':len(key_candidates),'unmatched':sum(x['field']=='keyExpressionCandidates' for x in unmatched)}
def annotation_pattern_segments(line):
 pieces=re.split(r'[‘’]',line);out=[]
 for piece in pieces:
  value=norm(piece.replace('↳','').strip(' =:'))
  if re.search(r'[A-Za-z]',value): out.append(value)
 return out
def find_pattern_blank(pattern_options,example):
 choices=[]
 for pattern,idx in pattern_options:
  phrase=re.split(r'[+~]',pattern,maxsplit=1)[0].strip()
  words=re.findall(r"[A-Za-z]+(?:['’][A-Za-z]+)?",phrase)
  for start in range(len(words)):
   suffix=' '.join(words[start:])
   hit=re.search(r'(?<![A-Za-z])'+re.escape(suffix)+r'(?![A-Za-z])',example,re.I)
   if hit: choices.append((len(words)-start,len(hit.group()),pattern,hit.group()))
 if not choices:return '',None
 best=max(x[:2] for x in choices);matches=[x for x in choices if x[:2]==best]
 if len({(x[2],x[3].casefold()) for x in matches})!=1:return '',None
 return matches[0][2],matches[0][3]
def numbered_dot_items(text,limit=4):
 text=source_line_join(text.splitlines())
 marks=[(m.start(),int(m.group(1)),m.end()) for m in re.finditer(r'(?<!\d)([1-9])\.\s*',text) if int(m.group(1))<=limit]
 out={}
 for j,(start,n,end) in enumerate(marks):
  stop=marks[j+1][0] if j+1<len(marks) else len(text)
  out.setdefault(n,[]).append(norm(text[end:stop]))
 return out
def parse_answers(value):
 value=norm(value)
 m=re.fullmatch(r'(.+?)\s*\[([^\]]+)\]',value)
 if m:return [norm(m.group(1)),norm(m.group(2))]
 return [value] if value else []
def parse_pattern_examples(lines,page_no):
 text='\n'.join(lines);mark=re.search(r'▼\s*교과서\s*예문',text)
 if not mark:return [],[]
 after=text[mark.end():];stop=re.search(r'(?m)^\s*(?:[A-B]\.\s|Let.s\s+Use\s+It)',after,re.I)
 region=after[:stop.start()] if stop else after
 blocks=[x for x in re.split(r'•',region) if x.strip()]
 pairs=[];issues=[]
 for index,block in enumerate(blocks,1):
  origin='교과서 본문' if '교과서 본문' in block else '워크북 예문';clean=block.replace('교과서 본문','')
  first=re.search(r'[\uac00-\ud7a3]',clean)
  if not first:
   issues.append((index,'PATTERN_EXAMPLE_PAIR_MISMATCH'));continue
  en=norm(source_line_join(clean[:first.start()].splitlines()));ko=norm(source_line_join(clean[first.start():].splitlines()))
  if en and ko:pairs.append({'en':en,'ko':ko,'origin':origin})
  else:issues.append((index,'PATTERN_EXAMPLE_PAIR_MISMATCH'))
 return pairs,issues
def extract_pattern_candidate(src,page_no):
 page=next((x for x in src['pages'] if x['page']==page_no),None);lines=page['text'].splitlines() if page else [];text='\n'.join(lines)
 h=next((i for i,line in enumerate(lines) if (m:=re.search(r'Pattern\s*([12])',line,re.I))),None)
 if h is None:return None,[{'field':'patternCandidates','reason':'PATTERN_HEADER_NOT_FOUND'}]
 pattern_no=int(re.search(r'Pattern\s*([12])',lines[h],re.I).group(1));title=norm(lines[0])
 marker=re.search(r'▼\s*교과서\s*예문',text);concept=''
 if marker:
  prefix=text[:marker.start()];head_pos=next(m.start() for m in re.finditer(r'Pattern\s*'+str(pattern_no),prefix,re.I));concept_tail=prefix[head_pos+len(re.search(r'Pattern\s*'+str(pattern_no),prefix,re.I).group(0)):].split('\n',1)[-1];concept=norm(source_line_join(concept_tail.splitlines()))
 concept=norm(re.sub(r'^\|+|\|+$','',concept))
 points=[norm(x) for x in re.split(r'(?<=[.!?])\s+',concept) if norm(x)] or ([concept] if concept else [])
 examples,exissues=parse_pattern_examples(lines,page_no);unmatched=[]
 for index,reason in exissues: unmatched.append({'candidateId':f'pc-{pattern_no:02d}','field':'textbookExamples','reason':reason,'sourceRefs':[candidate_ref('07',page_no,'textbook-examples',line_start=1,line_end=len(lines))],'pairIndex':index})
 marker1=re.search(r'Let.s\s+Use\s+It',text,re.I); translation=re.search(r'우리말\s*해석',text)
 translation_line_start=text.rfind('\n',0,translation.start())+1 if translation else len(text)
 qtext=text[marker1.end():translation_line_start] if marker1 and translation else ''
 en_items=numbered_dot_items(qtext,4)
 marker2=re.search(r'Let.s\s+Use\s+It',text[translation.end():],re.I) if translation else None
 ko_region=text[translation.end()+marker2.end():] if translation and marker2 else ''
 ansmark=re.search(r'❙\s*정답\s*❙',ko_region)
 ko_text=ko_region[:ansmark.start()] if ansmark else ko_region
 ans_text=ko_region[ansmark.end():] if ansmark else ''
 ko_items=numbered_dot_items(ko_text,4);answer_items=numbered_dot_items(ans_text,4)
 global_bank=[];uses=[]
 last_question=en_items.get(4,[])
 if len(last_question)==1 and not re.search(r'\s*\([^()]*/[^()]*\)\s*$',last_question[0]):
  tail_bank=re.search(r'(?<=[.!?])\s+([A-Za-z][A-Za-z0-9\'’\-]*(?:\s+[A-Za-z][A-Za-z0-9\'’\-]*)*)\s*$',last_question[0])
  if tail_bank: global_bank=[norm(x) for x in tail_bank.group(1).split() if norm(x)]
 for no in range(1,5):
  qrows=en_items.get(no,[]);krows=ko_items.get(no,[]);arows=answer_items.get(no,[])
  q=qrows[0] if len(qrows)==1 else '';ko=krows[0] if len(krows)==1 else '';answer=arows[0] if len(arows)==1 else ''
  bank=[];inline=re.search(r'\s*\(([^()]*/[^()]*)\)\s*$',q)
  if inline:
   bank=[norm(x) for x in inline.group(1).split('/') if norm(x)];q=norm(q[:inline.start()])
  elif no==4:
   m=re.search(r'(?<=[.!?])\s+([A-Za-z][A-Za-z0-9\'’\-]*(?:\s+[A-Za-z][A-Za-z0-9\'’\-]*)*)\s*$',q)
   if m:
    global_bank=[norm(x) for x in m.group(1).split() if norm(x)];q=norm(q[:m.start()])
  if not bank:bank=list(global_bank)
  if q and ko and answer and bank:
   uses.append({'no':no,'stem':q,'ko':ko,'wordBank':bank,'answers':parse_answers(answer)})
  else:
   refs=[candidate_ref('07',page_no,'lets-use-it-prompt',side='EN',question_no=no),candidate_ref('07',page_no,'lets-use-it-answer',side='KO',question_no=no)]
   unmatched.append({'candidateId':f'pc-{pattern_no:02d}','field':'letsUseIt','reason':'COUNT_MISMATCH_OR_SOURCE_MISSING','sourceRefs':refs,'expectedQuestionNo':no})
 refs=[candidate_ref('07',page_no,'pattern-title-concept',line_start=1,line_end=(h+1 if h is not None else 1)),candidate_ref('07',page_no,'textbook-examples',line_start=1,line_end=len(lines)),candidate_ref('07',page_no,'lets-use-it',line_start=1,line_end=len(lines))]
 row={'candidateId':f'pc-{pattern_no:02d}','patternNo':pattern_no,'title':title,'conceptKo':concept,'grammarPoint':points,'textbookExamples':examples,'letsUseIt':uses,'sourceRefs':refs,'reviewFlags':['REVIEW_REQUIRED']+(['PAIRING_UNRESOLVED'] if unmatched else [])}
 if not concept:unmatched.append({'candidateId':row['candidateId'],'field':'patternCandidates','reason':'PATTERN_CONCEPT_UNRESOLVED','sourceRefs':[refs[0]]})
 return row,unmatched
def extract_pattern_candidates(src):
 rows=[];unmatched=[]
 for page_no in (1,9):
  row,issues=extract_pattern_candidate(src,page_no)
  if row:rows.append(row)
  for issue in issues:
   if 'sourceRefs' not in issue:issue['sourceRefs']=[candidate_ref('07',page_no,'pattern-page')]
   unmatched.append(issue)
 return rows,unmatched,{'matched':len(rows)-sum(x['candidateId'] in {u['candidateId'] for u in unmatched} for x in rows),'unmatched':len({u['candidateId'] for u in unmatched}),'examples':sum(len(x['textbookExamples']) for x in rows),'letsUseIt':sum(len(x['letsUseIt']) for x in rows)}
def extract_candidate_sets(src01,src07):
 dialogues,du,ds=extract_dialogue_candidates(src01); functions,keyexpressions,fu,fs,ks=extract_functions(src01,dialogues);patterns,pu,ps=extract_pattern_candidates(src07)
 summary={'dialogues':ds,'functions':fs,'keyExpressions':ks,'patterns':ps}
 return dialogues,functions,keyexpressions,patterns,du+fu+pu,summary

EXAM_CONTRACTS=[
 {'source':'04','student':'04s','teacher':'04t','section':'PRE-STEP','problemRanges':[(1,12,1,64,None)],'answerPages':(13,14),'summaryPage':13,'expected':64,'expectedByType':{'objective':41,'subjective':23}},
 {'source':'05','student':'05s','teacher':'05t','section':'1회','problemRanges':[(1,6,1,30,None)],'answerPages':(7,10),'summaryPage':7,'expected':30,'expectedByType':{'objective':23,'subjective':7}},
 {'source':'06','student':'06s','teacher':'06t','section':'2회','problemRanges':[(1,8,1,30,None)],'answerPages':(9,12),'summaryPage':9,'expected':30,'expectedByType':{'objective':23,'subjective':7}},
 {'source':'08','student':'08','teacher':None,'section':'Grammar Build Up','problemRanges':[(2,6,1,45,1),(8,18,1,97,2)],'answerPages':(19,23),'expected':142,'expectedByType':{'objective':142,'subjective':0}},
 {'source':'09','student':'09','teacher':None,'section':'Grammar Build Up','problemRanges':[(2,10,1,79,1),(12,20,1,84,2)],'answerPages':(21,25),'expected':163,'expectedByType':{'objective':0,'subjective':163}},
]
QUESTION_MARKER_RE=re.compile(r'(?<!\d)(\d{1,3})\.\s*')
ANSWER_MARKER_RE=re.compile(r'(?<![\d(])(\d{1,3})\)\s*')
SUMMARY_ANSWER_RE=re.compile(r'(?<![\d(])(\d{1,3})\.\s*(주관식|[①②③④⑤](?:\s*[,，]\s*[①②③④⑤])*)')
PAGE_BOILERPLATE_RE=re.compile(r'^\s*(?:중2\s+NE능률\(김기택\)\s+6과\s+예상문제.*|NE능률\(김기택\).*|Lesson\s*6\s*Answer Key.*|중2(?:\s+정답)?|교사용|-\s*\d+\s*-|Pattern\s*[12]\b.*|PATTERN\s*[12]\b.*|Grammar Build Up.*|정답 및 해설.*|본 콘텐츠는 해당 출판사.*|이그잼포유에서 제작.*|무단 전재하거나 배포.*|을 물을 수 있습니다.*|저작권 침해 행위 또한 금지.*)\s*$',re.I)
EXAM_SECTION_BOILERPLATE_RE=re.compile(r'^\s*(?:중2\s+NE능률\(김기택\)\s+Lesson\s*6|PRE-STEP(?:\s+\d+)?|실전편|(?:본문|어휘|의사소통|대화문)\s*[┃|]\s*(?:객관식|주관식)\s*[┃|]?)\s*$',re.I)
CONTEXT_MARKER_046_RE=re.compile(r'^\s*v\s+(?=(?:다음\s*(?:대화|글|지문|내용|문장|그림|표)|Read\s+(?:the\s+)?(?:following|next)\s+(?:dialogue|passage|text)|Look\s+at\s+(?:the\s+)?(?:following\s+)?(?:dialogue|passage|picture)))',re.I)
CONTEXT_MARKER_09_RE=re.compile(r'^\s*n\s+(?=(?:다음\b|What\s+did\b|Look\s+at\b|Rewrite\b|Fill\b|Complete\b|Choose\b|Use\b|Put\b|Read\b|The\s+following\b))',re.I)

# Only strip exact printed-page section labels that leak past a question; never run this on context or answer fields.
TERMINAL_SECTION_LABEL_RE=re.compile(r'(?:\s+(?:대화문|의사소통|본문))+\s*$')

def strip_terminal_section_labels(value):
 return TERMINAL_SECTION_LABEL_RE.sub('',value).rstrip()

def is_exam_boilerplate(line):
 return bool(PAGE_BOILERPLATE_RE.match(line) or EXAM_SECTION_BOILERPLATE_RE.match(line))

def exam_line_text(line,no=None,marker=None):
 if is_exam_boilerplate(line):return ''
 had_trailing_space=bool(line and line[-1].isspace())
 if marker:line=re.sub(r'^\s*'+re.escape(marker)+r'\s+','',line,count=1,flags=re.I)
 if no is not None:line=re.sub(r'(?<![\d(])'+str(no)+r'\)\s*$','',line)
 return line.rstrip()+(' ' if had_trailing_space else '') if line.strip() else ''

def exam_span_rows(rows,offsets,start,end):
 parts=[]
 for index,row in enumerate(rows):
  line_start=offsets[index];line=row['text'];line_end=line_start+len(line)
  if line_end<=start or line_start>=end:continue
  left=max(0,start-line_start);right=min(len(line),end-line_start)
  if right>left:parts.append((row,line[left:right]))
 return parts

def clean_exam_span(text,rows,offsets,start,end,no=None,marker=None):
 parts=[];used=[];marker_pending=marker is not None
 for row,piece in exam_span_rows(rows,offsets,start,end):
  cleaned=exam_line_text(piece,no,marker if marker_pending else None)
  marker_pending=False
  if cleaned.strip():parts.append(cleaned);used.append(row)
  else:parts.append('')
 return norm(source_line_join(parts)),used

def exam_refs(source_id,section,lines,question_no=None):
 refs=[];group=None
 for row in lines:
  key=(row['page'],row['line'])
  if group and key[0]==group['page'] and key[1]==group['end']+1:group['end']=key[1]
  else:
   if group:refs.append(candidate_ref(source_id,group['page'],section,line_start=group['start'],line_end=group['end'],question_no=question_no))
   group={'page':key[0],'start':key[1],'end':key[1]}
 if group:refs.append(candidate_ref(source_id,group['page'],section,line_start=group['start'],line_end=group['end'],question_no=question_no))
 return refs

def exam_span_refs(source_id,rows,offsets,start,end,section,question_no=None):
 used=[row for row,piece in exam_span_rows(rows,offsets,start,end) if piece.strip()]
 return exam_refs(source_id,section,used,question_no)

def exam_context_markers(source_id,pattern_no,rows,offsets):
 markers=[]
 for index,row in enumerate(rows):
  line=row['text'];match=CONTEXT_MARKER_046_RE.match(line) if source_id in ('04s','05s','06s') else CONTEXT_MARKER_09_RE.match(line) if source_id=='09' else None
  if match:markers.append({'start':offsets[index],'page':row['page'],'line':row['line'],'kind':'v' if source_id in ('04s','05s','06s') else 'n'})
 return markers

def exam_context_groups(source_id,pattern_no,text,rows,offsets,items):
 markers=exam_context_markers(source_id,pattern_no,rows,offsets);ordered=sorted(items,key=lambda x:x['start']);groups=[];unresolved=set()
 for index,marker in enumerate(markers):
  later=[item for item in ordered if item['start']>marker['start']]
  if not later:
   previous=[item for item in ordered if item['start']<marker['start']]
   if previous:unresolved.add(previous[-1]['start'])
   continue
  first=later[0];next_marker=markers[index+1] if index+1<len(markers) else None
  if next_marker and next_marker['start']<first['start']:
   unresolved.add(first['start']);continue
  context,used=clean_exam_span(text,rows,offsets,marker['start'],first['start'],marker=marker['kind'])
  if not context or len(context)>12000 or not used:
   unresolved.add(first['start']);continue
  groups.append({'start':first['start'],'end':next_marker['start'] if next_marker else float('inf'),'text':context,'refs':exam_refs(source_id,'shared-context',used),'markerStart':marker['start']})
 contexts={item['start']:max((group for group in groups if group['start']<=item['start']<group['end']),key=lambda x:x['start'],default=None) for item in ordered}
 return markers,groups,contexts,unresolved

def exam_stream(source,p1,p2):
 pages={p['page']:p for p in source.get('pages',[]) if p1<=p.get('page',0)<=p2}
 rows=[]; offsets=[]; parts=[]; pos=0
 for pn in range(p1,p2+1):
  page=pages.get(pn)
  if not page: continue
  for line_no,line in enumerate(page.get('text','').splitlines(),1):
   offsets.append(pos); rows.append({'page':pn,'line':line_no,'text':line})
   parts.append(line); pos+=len(line)+1
 text='\n'.join(parts)
 return text,rows,offsets

def exam_line_at(rows,offsets,pos):
 import bisect
 i=max(0,bisect.bisect_right(offsets,pos)-1)
 return rows[min(i,len(rows)-1)] if rows else {'page':1,'line':1,'text':''}

def question_markers(source,p1,p2,lo,hi,pattern_no=None):
 text,rows,offsets=exam_stream(source,p1,p2); marks=list(QUESTION_MARKER_RE.finditer(text)); accepted=[]; boundaries=[]
 for i,m in enumerate(marks):
  no=int(m.group(1)); next_pos=marks[i+1].start() if i+1<len(marks) else len(text)
  if not lo<=no<=hi: continue
  line_start=text.rfind('\n',0,m.start())+1
  inline=m.start()>line_start and text[line_start:m.start()].strip()!=''
  missing08stem=source.get('id')=='08' and pattern_no==2 and no==55
  if inline and source.get('id')!='09' and not missing08stem and not (source.get('id') in ('05s','05t') and no==8 and re.match(r'\s*(?:위\s*대화|다음\s*대화)',text[m.end():m.end()+80])): continue
  # A numbered item must own an unparenthesized n) footnote before the next n. marker.
  if not re.search(r'(?<![\d(])'+str(no)+r'\)',text[m.end():next_pos]): continue
  line=exam_line_at(rows,offsets,m.start())
  marker={'no':no,'start':m.start(),'end':m.end(),'page':line['page'],'line':line['line'],'patternNo':pattern_no}
  boundaries.append(marker)
  # The extracted 08 Pattern 2 text has a 55. inline inside #54's final option. Keep
  # it as a segment delimiter, but do not turn it into an item candidate.
  if source.get('id')=='08' and pattern_no==2 and no==55: continue
  accepted.append(marker)
 ordered=sorted(boundaries,key=lambda item:item['start'])
 for mark in accepted:
  idx=next(i for i,item in enumerate(ordered) if item is mark)
  mark['endStart']=ordered[idx+1]['start'] if idx+1<len(ordered) else len(text)
  mark['segment']=text[mark['start']:mark['endStart']]
  mark['endPage']=exam_line_at(rows,offsets,max(mark['start'],mark['endStart']-1))['page']
  mark['endLine']=exam_line_at(rows,offsets,max(mark['start'],mark['endStart']-1))['line']
 return accepted,text,rows,offsets

def clean_exam_text(value,no):
 return norm(source_line_join([exam_line_text(line,no) for line in value.splitlines()]))

def parse_exam_choices(value,teacher=False):
 label_map={'❶':'①','❷':'②','❸':'③','❹':'④','❺':'⑤'}
 rx=re.compile(r'([①②③④⑤❶❷❸❹❺])\s*')
 if teacher:
  cut=re.search(r'^\s*(?:해설|정답 및 해설)\b',value,re.M)
  if cut: value=value[:cut.start()]
 value=source_line_join(value.splitlines())
 marks=list(rx.finditer(value)); choices=[]; seen=set()
 for i,m in enumerate(marks):
  label=label_map.get(m.group(1),m.group(1))
  if label in seen: continue
  seen.add(label); end=marks[i+1].start() if i+1<len(marks) else len(value)
  text=norm(value[m.end():end])
  if text: choices.append({'label':label,'text':text[:2000]})
 return choices

def summary_exam_answers(source,page_no,max_no):
 text,rows,offsets=exam_stream(source,page_no,page_no); out={}
 for m in SUMMARY_ANSWER_RE.finditer(text):
  no=int(m.group(1))
  if not 1<=no<=max_no or no in out: continue
  token=m.group(2); labels=re.findall(r'[①②③④⑤]',token)
  line=exam_line_at(rows,offsets,m.start())
  out[no]={'type':'subjective' if token=='주관식' else ('multi-select' if len(labels)>1 else 'mcq'),'answerLabels':labels,'answerTexts':[],'explanationKo':'','refs':[candidate_ref(source['id'],line['page'],'answer-key-summary',line_start=line['line'],line_end=line['line'],question_no=no)]}
 return out

def explicit_page_continuation(text,rows,offsets,start,end,start_page):
 end_line=exam_line_at(rows,offsets,max(start,end-1))
 if end_line['page']!=start_page: return None
 footer=any(row['page']==start_page and row_start>=start and row_start<end and PAGE_BOILERPLATE_RE.match(row['text']) for row,row_start in zip(rows,offsets))
 if not footer: return None
 next_page=start_page+1; seen_content=False; continuation_start=None; continuation_end_line=None
 for row,row_start in zip(rows,offsets):
  if row['page']!=next_page: continue
  line=row['text']
  if PAGE_BOILERPLATE_RE.match(line) or not line.strip(): continue
  stop=bool(re.match(r'^\s*(?:오답\b|제시문\b|질문\b|요약문\b|해설\b|정답 및 해설\b|\d{1,3}[.)]\s*)',line))
  if stop:
   if seen_content:
    return {'startOffset':continuation_start,'endOffset':row_start,'startPage':next_page,'endPage':next_page,'endLine':continuation_end_line,'text':text[continuation_start:row_start]}
   return None
  if continuation_start is None: continuation_start=row_start
  seen_content=True; continuation_end_line=row['line']
 return None

def answer_detail_records(source,p1,p2,max_no,marker_pattern=ANSWER_MARKER_RE):
 text,rows,offsets=exam_stream(source,p1,p2); markers=list(marker_pattern.finditer(text)); records=[]
 for i,m in enumerate(markers):
  no=int(m.group(1))
  if not 1<=no<=max_no: continue
  end=markers[i+1].start() if i+1<len(markers) else len(text)
  line=exam_line_at(rows,offsets,m.start())
  continuation=explicit_page_continuation(text,rows,offsets,m.start(),end,line['page'])
  tail=text[m.end():end]
  end_line=exam_line_at(rows,offsets,max(m.start(),end-1))
  if continuation: tail+='\n'+continuation['text']
  records.append({'no':no,'tail':tail.strip(),'page':line['page'],'line':line['line'],'endPage':continuation['endPage'] if continuation else end_line['page'],'endLine':continuation['endLine'] if continuation else end_line['line'],'startOffset':m.start(),'markerEnd':m.end(),'tailStart':m.end(),'endOffset':end,'continuation':continuation,'rows':rows,'offsets':offsets})
 return records

def answer_detail_continuation_refs(source_id,record,question_no,section='answer-explanation'):
 rows=record['rows']; offsets=record['offsets']; start=record['startOffset']; end=record['endOffset']
 continuation=record.get('continuation')
 if not continuation and record['endPage']<=record['page']: return []
 crossed=[row for row,row_start in zip(rows,offsets) if row['page']==record['page'] and row_start+len(row['text'])>start and row_start<end]
 if not any(PAGE_BOILERPLATE_RE.match(row['text']) for row in crossed): return []
 spans=[(start,end)]
 if continuation: spans.append((continuation['startOffset'],continuation['endOffset']))
 used=[]
 for span_start,span_end in spans:
  for row,row_start in zip(rows,offsets):
   row_end=row_start+len(row['text'])
   if row_end<=span_start or row_start>=span_end: continue
   if re.match(r'^\s*(?::|제시문\b|질문\b|요약문\b|오답\b|해설\b|정답 및 해설\b)',row['text']): break
   if PAGE_BOILERPLATE_RE.match(row['text']): continue
   if row['text'].strip(): used.append(row)
 if not any(row['page']>record['page'] for row in used): return []
 return exam_refs(source_id,section,used,question_no)

def clean_answer_text(value,normalize_wrapped_hangul=False):
 out=[]
 for line in value.splitlines():
  if PAGE_BOILERPLATE_RE.match(line): continue
  if re.match(r'^\s*(?::|제시문\b|질문\b|요약문\b|오답\b|해설\b|정답 및 해설\b)',line): break
  line=re.sub(r'^\s*(?:본문|어휘|의사소통)\s*[┃|].*$','',line)
  if line.strip(): out.append(line)
 return norm(source_line_join(out) if normalize_wrapped_hangul else ' '.join(out))[:8000]

def build_exam_answer_map(source,contract):
 p1,p2=contract['answerPages']; max_no=max(r[3] for r in contract['problemRanges']); out={}
 if contract['source'] in ('04','05','06'):
  out=summary_exam_answers(source,contract['summaryPage'],max_no)
  detail_records=answer_detail_records(source,p1,p2,max_no,re.compile(r'(?<![\d(])(\d{1,3})[.)]\s*'))
  for no,row in out.items():
   candidates=[r for r in detail_records if r['no']==no]
   for record in candidates:
    tail=record['tail'].strip()
    if re.match(r'^[①②③④⑤](?:\s*[,，]\s*[①②③④⑤])*\s*:?',tail):
     colon=tail.find(':'); explanation=tail[colon+1:].strip() if colon>=0 else ''
     if explanation: row['explanationKo']=clean_answer_text(explanation,normalize_wrapped_hangul=True)
     continuation_refs=answer_detail_continuation_refs(source['id'],record,no)
     if continuation_refs:
      row['refs']=[ref for ref in row['refs'] if not (ref.get('section')=='answer-explanation' and ref.get('questionNo')==no)]
      row['refs'].extend(continuation_refs)
     else:
      row['refs'].append(candidate_ref(source['id'],record['page'],'answer-explanation',line_start=record['line'],line_end=record['line'],question_no=no))
    elif row['type']=='subjective':
     answer=clean_answer_text(tail)
     if answer and not re.fullmatch(r'주관식|[①②③④⑤](?:\s*[,，]\s*[①②③④⑤])*',answer):
      row['answerTexts']=[answer]
      row['refs'].append(candidate_ref(source['id'],record['page'],'answer-text',line_start=record['line'],line_end=record['line'],question_no=no))
  return out
 pattern_max={1:45,2:97} if contract['source']=='08' else {1:79,2:84}
 text_by_pattern={1:[],2:[]}; rows_by_pattern={1:[],2:[]}; active=None
 for pn in range(p1,p2+1):
  page=next((p for p in source.get('pages',[]) if p.get('page')==pn),None)
  if not page: continue
  for line_no,line in enumerate(page.get('text','').splitlines(),1):
   h=re.search(r'Pattern\s*([12])',line,re.I)
   if h: active=int(h.group(1))
   if active:
    rows_by_pattern[active].append({'page':pn,'line':line_no,'text':line})
    text_by_pattern[active].append(line)
 for pattern_no in (1,2):
  text='\n'.join(text_by_pattern[pattern_no]); rows=rows_by_pattern[pattern_no]; offsets=[]; pos=0
  for row in rows: offsets.append(pos);pos+=len(row['text'])+1
  markers=list(ANSWER_MARKER_RE.finditer(text)); expected=1; accepted=[]
  for m in markers:
   no=int(m.group(1))
   if no!=expected or no>pattern_max[pattern_no]: continue
   line=exam_line_at(rows,offsets,m.start()); accepted.append({'no':no,'start':m.start(),'end':m.end(),'page':line['page'],'line':line['line']});expected+=1
  for i,marker in enumerate(accepted):
   end=accepted[i+1]['start'] if i+1<len(accepted) else len(text)
   end_line=exam_line_at(rows,offsets,max(marker['start'],end-1))
   marker['endOffset']=end; marker['endPage']=end_line['page']; marker['endLine']=end_line['line']
   tail=text[marker['end']:end].strip()
   labels=[]; explanation=''; answer_text=''
   match=re.match(r'\s*([①②③④⑤](?:\s*[,，]\s*[①②③④⑤])*)',tail)
   if match:
    labels=re.findall(r'[①②③④⑤]',match.group(1)); rest=tail[match.end():]
    colon=rest.find(':'); explanation=clean_answer_text(rest[colon+1:],normalize_wrapped_hangul=True) if colon>=0 else ''
   else: answer_text=clean_answer_text(tail)
   refs=exam_span_refs(source['id'],rows,offsets,marker['start'],end,'answer-key',marker['no'])
   out[(pattern_no,marker['no'])]={'type':'mcq' if contract['source']=='08' else 'subjective','answerLabels':labels,'answerTexts':[answer_text] if answer_text else [],'explanationKo':explanation,'refs':refs}
 return out

def teacher_crosscheck(source,contract):
 if not contract.get('teacher'): return {}
 rows={}
 for p1,p2,lo,hi,pattern_no in contract['problemRanges']:
  found,_,_,_=question_markers(source,p1,p2,lo,hi,pattern_no)
  for item in found:
   choices=parse_exam_choices(item['segment'],teacher=True)
   rows[(pattern_no,item['no'])]={'choiceLabels':{x['label'] for x in choices}}
 return rows

def exam_item_unmatched(source,section,pattern_no,no,reason,refs,field='examItemCandidates'):
 return {'candidateId':f'ic-{source}-{pattern_no or 0:02d}-{no:03d}','source':source,'section':section,'patternNo':pattern_no,'no':no,'field':field,'reason':reason,'sourceRefs':refs}

def extract_exam_item_candidates(sources):
 by_id={s['id']:s for s in sources}; candidates=[]; unmatched=[]; by_source={}; by_type={'mcq':0,'multi-select':0,'subjective':0,'unknown':0}; expected_total=0
 for contract in EXAM_CONTRACTS:
  source_name=contract['source']; student=by_id[contract['student']]; answers=build_exam_answer_map(by_id[contract['teacher']] if contract.get('teacher') else student,contract)
  teacher=teacher_crosscheck(by_id[contract['teacher']],contract) if contract.get('teacher') else {}
  expected_total+=contract['expected']; source_rows=[]; source_unresolved=0; answer_matched=0; source_types={'mcq':0,'multi-select':0,'subjective':0,'unknown':0}
  all_found={}
  for p1,p2,lo,hi,pattern_no in contract['problemRanges']:
   found,flat,rows,offsets=question_markers(student,p1,p2,lo,hi,pattern_no)
   context_markers,context_groups,context_by_start,unresolved_context=exam_context_groups(student['id'],pattern_no,flat,rows,offsets,found)
   valid_context_markers={group['markerStart'] for group in context_groups}
   grouped={}
   for item in found: grouped.setdefault(item['no'],[]).append(item)
   all_found.update({(pattern_no,no):items for no,items in grouped.items()})
   for no,items in grouped.items():
    if len(items)>1:
     refs=[candidate_ref(student['id'],x['page'],'problem-boundary',line_start=x['line'],line_end=x['line'],question_no=no) for x in items]
     unmatched.append(exam_item_unmatched(source_name,contract['section'],pattern_no,no,'BOUNDARY_AMBIGUOUS',refs));source_unresolved+=1;continue
    item=items[0]; answer_key=(pattern_no,no) if source_name in ('08','09') else no; answer=answers.get(answer_key)
    raw_end=item['endStart']
    next_context=[marker['start'] for marker in context_markers if marker['start'] in valid_context_markers and item['start']<marker['start']<raw_end]
    if next_context:raw_end=min(raw_end,min(next_context))
    raw,problem_lines=clean_exam_span(flat,rows,offsets,item['start'],raw_end,no=no)
    raw=strip_terminal_section_labels(raw)
    shared_context=context_by_start.get(item['start']);context_text=shared_context['text'] if shared_context else ''
    shared_refs=shared_context['refs'][:] if shared_context else []
    choices=parse_exam_choices(raw)
    if source_name=='09': format_type='subjective'
    elif answer and answer['type']=='subjective': format_type='subjective'
    elif source_name=='06' and no in (3,7): format_type='multi-select'
    elif (answer and len(answer.get('answerLabels',[]))>1) or re.search(r'정답\s*2\s*개|두\s*개\s*고르|모두\s*(?:고르|선택)|여러\s*개\s*(?:고르|선택)|해당하는\s*것을\s*모두',raw): format_type='multi-select'
    elif len(choices)>=2: format_type='mcq'
    else: format_type='unknown'
    flags=['REVIEW_REQUIRED']
    if item['start'] in unresolved_context:flags.append('SHARED_CONTEXT_REVIEW_REQUIRED')
    problem_refs=exam_refs(student['id'],'problem',problem_lines,no)
    answer_refs=answer['refs'][:] if answer else []
    refs=problem_refs+shared_refs+answer_refs
    if not answer or (not answer.get('answerLabels') and not answer.get('answerTexts')):
     flags.append('ANSWER_UNRESOLVED');unmatched.append(exam_item_unmatched(source_name,contract['section'],pattern_no,no,'ANSWER_MISSING',refs));source_unresolved+=1
    else: answer_matched+=1
    if format_type in ('mcq','multi-select') and len(choices)<2:
     flags.append('CHOICES_UNRESOLVED');unmatched.append(exam_item_unmatched(source_name,contract['section'],pattern_no,no,'CHOICES_MISSING',refs));source_unresolved+=1
    cross=teacher.get((pattern_no,no))
    if contract.get('teacher') and (cross is None or (choices and cross['choiceLabels']!=set(x['label'] for x in choices))):
     flags.append('TEACHER_CROSSCHECK_UNRESOLVED')
     # Cross-check issues stay review flags; canonical student stems and answer-key data remain the candidate source.
    row={'candidateId':f'ic-{source_name}-{pattern_no or 0:02d}-{no:03d}','source':source_name,'section':contract['section'],'patternNo':pattern_no,'no':no,'formatType':format_type,'rawText':raw[:12000],'contextText':context_text[:12000],'choices':choices,'answerLabels':answer.get('answerLabels',[]) if answer else [],'answerTexts':answer.get('answerTexts',[]) if answer else [],'explanationKo':answer.get('explanationKo','') if answer else '','sourceRefs':refs,'reviewFlags':sorted(set(flags))}
    candidates.append(row);source_rows.append(row);source_types[format_type]+=1;by_type[format_type]+=1
  for p1,p2,lo,hi,pattern_no in contract['problemRanges']:
   present={no for pn,no in all_found if pn==pattern_no}
   for no in range(lo,hi+1):
    if no in present: continue
    answer_key=(pattern_no,no) if source_name in ('08','09') else no; answer=answers.get(answer_key)
    nearest=[]
    for neighbor_no in (no-1,no+1):
     for neighbor in all_found.get((pattern_no,neighbor_no),[]):
      nearest.append(candidate_ref(student['id'],neighbor['page'],'problem-boundary-gap',line_start=neighbor['line'],line_end=neighbor['endLine'],question_no=no))
    if not nearest: nearest=[candidate_ref(student['id'],p1,'problem-boundary-gap',question_no=no)]
    refs=nearest+(answer['refs'][:] if answer else [])
    reason='STEM_MISSING' if source_name=='08' and pattern_no==2 and no==55 else 'STEM_MISSING'
    unmatched.append(exam_item_unmatched(source_name,contract['section'],pattern_no,no,reason,refs));source_unresolved+=1
  found_by_type={'objective':source_types['mcq']+source_types['multi-select'],'subjective':source_types['subjective']}
  by_source[source_name]={'expected':contract['expected'],'found':len(source_rows),'answerMatched':answer_matched,'unresolved':source_unresolved,'byType':source_types,'expectedByType':contract['expectedByType'],'foundByType':found_by_type}
 type_warnings=[]
 for source_name,stats in by_source.items():
  if stats['found']==stats['expected'] and stats['foundByType']!=stats['expectedByType']:
   type_warnings.append({'source':source_name,'field':'formatType','reason':'EXPECTED_TYPE_COUNT_MISMATCH','expected':stats['expectedByType'],'found':stats['foundByType']})
 summary={'expected':expected_total,'found':len(candidates),'answerMatched':sum(x['answerMatched'] for x in by_source.values()),'unresolved':len(unmatched),'bySource':by_source,'byType':by_type,'typeCountWarnings':type_warnings}
 return candidates,unmatched,summary

def attach_unmatched(row, field, reason, refs, **details):
 row['unmatchedEnrichment'].append({'field':field,'reason':reason,'sourceRefs':refs,**details})
 row['reviewFlags'].append(field.upper()+'_UNMATCHED')
def enrich_sentences(sentences, source):
 pages={p['page']:p['text'] for p in source['pages']}
 verb_prompts=numbered_pages(source,[11,12,13]); grammar_prompts=numbered_pages(source,[14,15,16])
 token_prompts=numbered_pages(source,[20,21,22]); writing_prompts=numbered_page_blocks(source,[23,24,25,26])
 verb_answers=exercise_answers(pages.get(30,''),5,6); grammar_answers=exercise_answers(pages.get(30,''),6,7)
 summary={field:{'matched':0,'unmatched':0} for field in ('verbForms','grammarChoices','tokens','writingKeywords')}
 for row in sentences:
  n=row['seq']; row['unmatchedEnrichment']=[]; row['enrichmentSourceRefs']={}; row['tokenGroups']=[]
  row['tokens']=[]; row['verbForms']=[]; row['grammarChoices']=[]; row['writingKeywords']=[]
  prompt=verb_prompts.get(n,[]); answers=verb_answers.get(n,[])
  vpage=prompt[0]['page'] if len(prompt)==1 else (11 if n<=9 else 12 if n<=19 else 13)
  vrefs=[page_ref(vpage,'verb-form',n),page_ref(30,'verb-form-answer',n)]
  bases=re.findall(r'\(([^()]*)\)',prompt[0]['text']) if len(prompt)==1 else []
  answer_parts=slash_parts(answers[0]['text']) if len(answers)==1 else None
  bases=[norm(x) for x in bases]
  if answer_parts and len(bases)!=len(answer_parts):
   sentence_bases=[]; used=set()
   for answer in answer_parts:
    hits=[i for i,base in enumerate(bases) if i not in used and compare_text(base)==compare_text(answer)
      and re.search(r'(?<![A-Za-z])'+re.escape(base)+r'(?![A-Za-z])',row['en'],re.I)]
    if len(hits)!=1: sentence_bases=[]; break
    used.add(hits[0]); sentence_bases.append(bases[hits[0]])
   if sentence_bases: bases=sentence_bases
  if len(prompt)==1 and len(answers)==1 and bases and all(bases) and answer_parts and len(bases)==len(answer_parts):
   row['verbForms']=[{'base':base,'answer':answer} for base,answer in zip(bases,answer_parts)]
   row['enrichmentSourceRefs']['verbForms']=vrefs; summary['verbForms']['matched']+=1
  else:
   attach_unmatched(row,'verbForms','COUNT_MISMATCH' if prompt and answers else 'NO_DETERMINISTIC_MATCH',vrefs,baseCount=len(bases),answerCount=len(answer_parts or [])); summary['verbForms']['unmatched']+=1
  gp=grammar_prompts.get(n,[]); ga=grammar_answers.get(n,[])
  if n>23:
   grefs=[page_ref(16,'grammar-choice-source-range',None),page_ref(30,'grammar-choice-answer-range',None)]
   attach_unmatched(row,'grammarChoices','SOURCE_NOT_PRESENT',grefs,expectedQuestionNo=n); summary['grammarChoices']['unmatched']+=1
  else:
   gpage=gp[0]['page'] if len(gp)==1 else (14 if n<=9 else 15 if n<=18 else 16)
   grefs=[page_ref(gpage,'grammar-choice',n),page_ref(30,'grammar-choice-answer',n)]
   groups=re.findall(r'\[([^\]]*)\]',gp[0]['text']) if len(gp)==1 else []
   answers_flat=[]
   for arow in ga: answers_flat.extend(slash_parts(arow['text']) or [])
   valid=[]; issues=[]
   if len(gp)!=1 or len(ga)!=1 or not groups or len(groups)!=len(answers_flat):
    issues.append({'reason':'COUNT_MISMATCH','expectedGroups':len(groups),'answerCount':len(answers_flat)})
   else:
    for i,(group,answer) in enumerate(zip(groups,answers_flat),1):
     options=[norm(x) for x in group.split('/')]
     if len(options)<2 or any(not x for x in options): issues.append({'reason':'INVALID_OPTIONS','groupIndex':i}); continue
     hits=[j for j,option in enumerate(options) if compare_text(option)==compare_text(answer)]
     if len(hits)!=1: issues.append({'reason':'ANSWER_NOT_UNIQUE_OPTION','groupIndex':i}); continue
     valid.append({'options':options,'answerIdx':hits[0]})
   row['grammarChoices']=valid
   if valid: row['enrichmentSourceRefs']['grammarChoices']=grefs
   if issues:
    for issue in issues: attach_unmatched(row,'grammarChoices',issue.pop('reason'),grefs,**issue)
    summary['grammarChoices']['unmatched']+=1
   else: summary['grammarChoices']['matched']+=1
  tp=token_prompts.get(n,[]); tpage=tp[0]['page'] if len(tp)==1 else (20 if n<=8 else 21 if n<=17 else 22)
  trefs=[page_ref(tpage,'token-choice-groups',n)]; groups=[]; invalid=False
  if len(tp)==1:
   if not balanced_parentheses(tp[0]['text']): invalid=True
   for raw in re.findall(r'\(([^()]*)\)',tp[0]['text']):
    if '/' not in raw: continue
    values=token_group_parts(raw)
    if not values: invalid=True
    else: groups.append(values)
  if len(tp)==1 and groups:
   outside=norm(re.sub(r'\([^()]*\)',' ',tp[0]['text']))
   row['tokenGroups']=groups; row['tokens']=[]
   row['tokensSafety']='TOKEN_GROUPS_ONLY_FIXED_TEXT_OUTSIDE' if outside else 'TOKEN_GROUPS_ONLY_ALTERNATIVES_NOT_SENTENCE_TOKENS'
   row['enrichmentSourceRefs']['tokens']=trefs
   if invalid:
    attach_unmatched(row,'tokens','INVALID_TOKEN_GROUP',trefs); summary['tokens']['unmatched']+=1
   else: summary['tokens']['matched']+=1
  else:
   attach_unmatched(row,'tokens','INVALID_TOKEN_GROUP' if invalid else 'NO_DETERMINISTIC_MATCH',trefs); summary['tokens']['unmatched']+=1
  wp=writing_prompts.get(n,[]); wpage=wp[0]['page'] if len(wp)==1 else (23 if n<=6 else 24 if n<=12 else 25 if n<=19 else 26)
  wrefs=[page_ref(wpage,'writing-keywords',n),page_ref(31,'writing-keywords-answer-crosscheck',n)]
  keywords,why=writing_keywords(wp[0]['text']) if len(wp)==1 else (None,'NO_DETERMINISTIC_MATCH')
  if keywords:
   row['writingKeywords']=keywords; row['enrichmentSourceRefs']['writingKeywords']=wrefs; summary['writingKeywords']['matched']+=1
  else:
   attach_unmatched(row,'writingKeywords',why or 'NO_DETERMINISTIC_MATCH',wrefs); summary['writingKeywords']['unmatched']+=1
  if row['unmatchedEnrichment']: row['reviewFlags']=sorted(set(row['reviewFlags']+['ENRICHMENT_UNMATCHED']))
 return summary
def exact_head(value):
 value=unicodedata.normalize('NFKC',norm(str(value))).casefold()
 value=re.sub(r'\s*\([a-z]+(?:-[a-z]+){1,5}\)\s*$','',value,flags=re.I)
 value=re.sub(r'\s*~\s*$','',value)
 return norm(value)
def master_entries(src):
 entries=[]
 for page in src['pages']:
  pn=page['page']
  if not 1<=pn<=4: continue
  section='conversation' if pn<=2 else 'reading'
  for line in page.get('text','').splitlines():
   upper=line.upper()
   if 'CONVERSATION' in upper and '│' in line: section='conversation' if pn<=2 else None
   if 'READING' in upper and '│' in line: section='reading' if pn>=3 else None
   m=re.match(r'^\s*□\s*(.*?)\s*$',line)
   if section and m and m.group(1): entries.append({'page':pn,'section':section,'entry':norm(m.group(1))})
 return entries
def master_entry_matches(head, entry):
 target=exact_head(head)
 raw=norm(entry)
 pos=re.search(r'\s+(?:n|v|a|adj|adv|prep|pron|conj|int|phr|aux)\.\s',raw,re.I)
 if pos and exact_head(raw[:pos.start()])==target: return True
 if exact_head(raw)==target: return True
 if not pos:
  for delimiter in (r'\s+\(',r'\s+\.\.\.',r'(?=[가-힣])'):
   match=re.search(delimiter,raw)
   if match and exact_head(raw[:match.start()])==target: return True
  for mark in re.finditer('~',raw):
   prefix=raw[:mark.start()].strip()
   tail=raw[mark.end():].lstrip()
   if (tail.startswith('~') or (tail and re.match(r'[가-힣]',tail))) and exact_head(prefix)==target: return True
 return False
def passage_word_refs(head, sentences):
 target=exact_head(head)
 if not target: return []
 pieces=target.split()
 pattern=re.compile(r'(?<![A-Za-z])'+'\\s+'.join(re.escape(x) for x in pieces)+r'(?![A-Za-z])',re.I)
 refs=[]
 for row in sentences:
  if not pattern.search(norm(row.get('en',''))): continue
  ref=next((r for r in row.get('sourceRefs',[]) if r.get('sourceDocumentId')=='02' and r.get('section')=='workbook-4' and r.get('questionNo')==row.get('seq')),None)
  if ref:
   refs.append(page_ref(ref['page'],'reading',ref['questionNo']))
 return refs
def attach_word_sections(candidates, source, sentences):
 entries=master_entries(source)
 for row in candidates:
  matches=[entry for entry in entries if master_entry_matches(row.get('headCandidate',''),entry['entry'])]
  if matches:
   for entry in matches:
    ref={'sourceDocumentId':'03','page':entry['page'],'printedPage':entry['page'],'section':entry['section'],'questionNo':None}
    if ref not in row['sourceRefs']: row['sourceRefs'].append(ref)
   row['reviewFlags']=sorted(set(row.get('reviewFlags',[])+['PLAIN_TEXT_MASTER_SECTION_REF']))
   continue
  refs=passage_word_refs(row.get('headCandidate',''),sentences)
  if refs:
   for ref in refs:
    if ref not in row['sourceRefs']: row['sourceRefs'].append(ref)
   row['reviewFlags']=sorted(set(row.get('reviewFlags',[])+['PASSAGE_SECTION_REF']))
def numbered_answer_blocks(text):
 lines=text.splitlines(); marks=[]
 for i,line in enumerate(lines):
  m=re.match(r'^\s*(\d{1,2})\)\s*(.*)$',line)
  if m: marks.append((i,int(m.group(1)),m.group(2)))
 out={}
 for j,(start,n,first) in enumerate(marks):
  end=marks[j+1][0] if j+1<len(marks) else len(lines)
  value=norm(' '.join([first]+lines[start+1:end]))
  if 1<=n<=25: out.setdefault(n,[]).append(value)
 return out
def answer_section(text, start_header, end_header):
 start=text.find(start_header)
 if start<0: return ''
 tail=text[start+len(start_header):]
 end=tail.find(end_header)
 return tail[:end] if end>=0 else tail
def exact_answer_parts(value):
 parts=[norm(part) for part in value.split('/')]
 return parts if parts and all(parts) else None
def attach_keyword_candidates(sentences, source):
 p29=next((p['text'] for p in source['pages'] if p['page']==29),'')
 ko_text=answer_section(p29,'워크북 2 빈칸 연습 (한글)','워크북 3 빈칸 연습 (영문)')
 en_text=answer_section(p29,'워크북 3 빈칸 연습 (영문)','워크북 4 해석 연습')
 ko=numbered_answer_blocks(ko_text); en=numbered_answer_blocks(en_text); summary={'matched':0,'unmatched':0}
 for row in sentences:
  n=row['seq']; ko_rows=ko.get(n,[]); en_rows=en.get(n,[])
  kparts=exact_answer_parts(ko_rows[0]) if len(ko_rows)==1 else None
  eparts=exact_answer_parts(en_rows[0]) if len(en_rows)==1 else None
  refs=[page_ref(29,'workbook-2-answer',n),page_ref(29,'workbook-3-answer',n)]
  row['keywordKoCandidates']=kparts or []; row['keywordEnCandidates']=eparts or []
  row['keywords']=[]
  row['reviewFlags']=sorted(set(row['reviewFlags']+['KEYWORD_ALIGNMENT_REVIEW_REQUIRED']))
  row.setdefault('enrichmentSourceRefs',{})['keywords']=refs
  attach_unmatched(row,'keywords','KEYWORD_ALIGNMENT_REVIEW_REQUIRED',refs,baseCount=len(eparts or []),answerCount=len(kparts or []))
  summary['unmatched']+=1
 return summary
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
   if n in (1,11,20): e=re.sub(r'(?i)^(monday|tuesday|wednesday)\s*,?\s*august\s+(1|2|3)\b[,:]?\s*','',e).strip()
   sent.append({'candidateId':f'sc-{n:04d}','seq':n,'en':e,'ko':k,'passageTitle':a.passage_title_en,'passageTitleEn':a.passage_title_en,'passageTitleKo':a.passage_title_ko,'dayHeaderEn':header,'dayHeaderKo':header_ko,'dayGroup':('8/1' if n<11 else '8/2' if n<20 else '8/3'),'chunks':[],'keywords':[],'verbForms':[],'grammarChoices':[],'tokens':[],'writingKeywords':[],'sourceRefs':[page_ref(ep,'workbook-4',n),page_ref(kp,'workbook-4-answer',n)],'reviewFlags':['REVIEW_REQUIRED','PLAIN_TEXT_NO_COORDINATES']+([] if e else ['EN_UNRESOLVED'])+([] if k else ['KO_UNRESOLVED'])})
  enrichment_summary=enrich_sentences(sent,srcs['02'])
  keyword_summary=attach_keyword_candidates(sent,srcs['02']); enrichment_summary['keywords']=keyword_summary
  attach_word_sections(wr,srcs['03'],sent)
  dialogues,functions,key_expressions,patterns,structure_unmatched,structure_summary=extract_candidate_sets(srcs['01'],srcs['07'])
  exam_items,unmatched_items,item_summary=extract_exam_item_candidates(bundle['sources'])
  enrichment_summary.update(structure_summary)
  unmatched=[{'candidateId':row['candidateId'],'field':item['field'],'sourceRefs':item['sourceRefs'],'reason':item['reason'],**{key:value for key,value in item.items() if key not in ('field','sourceRefs','reason')}} for row in sent for item in row['unmatchedEnrichment']]+structure_unmatched
  draft={'kind':'naesin-folder-review-draft','version':1,'status':'needs-review','publishable':False,'rights':{k:rights[k] for k in ['basis','holder','evidenceRef','studentUseAllowed','derivativeUseAllowed','externalAiAllowed','notes']},'revision':'2022','wordSeedUsed':seed_used,'sourceDocuments':docs,'wordCandidates':wr,'sentenceCandidates':sent,'dialogueCandidates':dialogues,'functionCandidates':functions,'keyExpressionCandidates':key_expressions,'patternCandidates':patterns,'examItemCandidates':exam_items,'unmatchedItems':unmatched_items,'itemSummary':item_summary,'unmatched':unmatched,'enrichmentSummary':enrichment_summary,'reviewFlags':['REVIEW_REQUIRED','PLAIN_TEXT_NO_COORDINATES','NO_EXTERNAL_AI']+(['UNMATCHED_ENRICHMENT_REVIEW'] if unmatched else [])+(['UNMATCHED_ITEMS_REVIEW'] if unmatched_items else [])+([] if a.passage_title_en and a.passage_title_ko else ['PASSAGE_TITLE_REVIEW'])}
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
  print(json.dumps({'ok':True,'publishable':False,'sourceDocuments':len(docs),'sourcePages':total,'words':len(wr),'sentences':len(sent),'enNonempty':sum(bool(x['en']) for x in sent),'koNonempty':sum(bool(x['ko']) for x in sent),'wordSeedUsed':seed_used,'unmatchedEnrichment':len(draft['unmatched']),'enrichmentSummary':draft['enrichmentSummary'],'installed':a.install_sources},ensure_ascii=True))
 except DraftError as e: print(json.dumps({'ok':False,'error':str(e)})); return 1
 except Exception: print(json.dumps({'ok':False,'error':'SOURCE_OR_OUTPUT_FAILED'})); return 1
 return 0
if __name__=='__main__': sys.exit(main())
