import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const script=String.raw`
import importlib.util
spec=importlib.util.spec_from_file_location('draft','naesin/extract/question_draft.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
doc={'id':'src-000001','source':'04','title':'Own test','sha256':'a'*64}
def page(no,text,key=False,header=''):
 return {'page':no,'header':header,'answerKey':key,'columns':[{'bbox':[30,45,300,800],'text':text}]}
body='1. Choose the correct word. 1)\n① own a\n② own b\n③ own c\n④ own d\n⑤ own e\n2. Write the two parts together. (1) first (2) second 2)'
key='1. ①, ②\n1) ①, ②\n2) (1) First part (2) Second part\n해설 Own explanation'
rows,audit=m.parse_document(doc,[page(1,body),page(2,key,True)])
assert len(rows)==2 and rows[0]['formatType']=='mcq_multi' and rows[0]['answer']==['1','2']
assert rows[1]['answer']==['(1) First part (2) Second part'], 'Required subparts must never become OR alternatives'
assert 'SUBPART_ANSWER_REVIEW' in rows[1]['_pdfReview']['flags']
assert rows[0]['_pdfReview']['locations'][1]['page']==2
assert rows[0]['_pdfReview']['locations'][0]['libraryId']==doc['id']
assert audit['missingNumbers']==[]
rows,audit=m.parse_document(doc,[page(1,body+'\n3)')]);assert audit['missingNumbers']==[{'pattern':0,'no':3}]
assert all(not r['answer'] and 'ANSWER_UNRESOLVED' in r['_pdfReview']['flags'] for r in rows)
rows,audit=m.parse_document(doc,[page(1,body),page(2,body),page(3,key,True)])
assert all('DUPLICATE_QUESTION_NUMBER' in r['_pdfReview']['flags'] and not r['answer'] for r in rows)
reading=[{'page':1,'width':595,'height':842,'fullText':'Own children enjoy reading wonderful stories.\n원문 교사 확인'}]
rows=m.reading_cloze(doc,reading);assert len(rows)==1 and rows[0]['answer']==['wonderful']
assert '________' in rows[0]['stimulus']['parts'][0]['text'] and rows[0]['_pdfReview']['flags']==['REVIEW_REQUIRED','CLOZE_SOURCE_REVIEW']
print('question boundaries, answer mapping, subparts, missing anchors, duplicate IDs and local reading cloze passed')
`;
const result=spawnSync(process.env.WB_NAESIN_PYTHON||'python',['-X','utf8','-c',script],{encoding:'utf8',cwd:new URL('../../',import.meta.url)});
assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
