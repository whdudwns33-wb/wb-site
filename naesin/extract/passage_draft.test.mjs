import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const result=spawnSync(process.env.WB_NAESIN_PYTHON||'python',['-X','utf8','-c',String.raw`
import importlib.util
s=importlib.util.spec_from_file_location('p','naesin/extract/passage_draft.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
d={'id':'src-000001','sha256':'a'*64}
def col(text):return {'text':text,'bbox':[30,45,300,800]}
pages=[{'page':1,'key':False,'stages':['4'],'columns':[col('1. A toy is blue. 1)\n2. My toy is red.\n1. An internal list label\n2)\n- 1 -')]},
 {'page':2,'key':True,'stages':[],'columns':[col('워크북 3\n1) unrelated\n워크북 4\n1) 장난감이 파랗다.'),col('2) 내 장난감이 빨갛다.\n워크북 5\n1) unrelated')]}]
rows=m.pair_workbook(pages,d)
assert len(rows)==2 and rows[0]['en']=='A toy is blue.' and rows[0]['ko']=='장난감이 파랗다.'
assert not rows[1]['en'].endswith('- 1 -') and rows[1]['_pdfReview']['locations'][1]['page']==2
assert rows[0]['tokens']==['A','toy','is','blue.'] and rows[0]['chunks']==[{'en':rows[0]['en'],'ko':rows[0]['ko']}]
assert rows[0]['keywords']==[{'en':rows[0]['en'],'ko':rows[0]['ko']}]
pages[1]['columns'][1]=col('워크북 5\n1) unrelated')
try:m.pair_workbook(pages,d);raise AssertionError('Missing translation accepted')
except ValueError:pass
pair=[{'page':1,'parts':[col('교과서본문 중2\nA toy is blue. My toy is red.\n- 1 -'),col('장난감이 파랗다. 내 장난감이 빨갛다.')]}]
assert len(m.pair_bilingual(pair,d))==2
pair[0]['parts'][1]=col('장난감이 파랗다.')
try:m.pair_bilingual(pair,d);raise AssertionError('Unequal source sentences accepted')
except ValueError:pass
print('Local source numbering, continued translations, source locations, footer removal and bilingual count guards passed')
`],{encoding:'utf8',cwd:new URL('../../',import.meta.url)});
assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
