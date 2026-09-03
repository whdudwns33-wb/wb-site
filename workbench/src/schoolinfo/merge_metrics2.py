import json,collections
import os
SP=os.path.dirname(os.path.abspath(__file__))
BD=os.path.join(SP,'..','bulk-data.json')
LCTN={'01':'서울특별시','02':'부산광역시','03':'대구광역시','04':'인천광역시','05':None,'06':'대전광역시','07':'울산광역시','08':'세종특별자치시','10':'경기도','11':'강원특별자치도','12':'충청북도','13':'충청남도','14':'전북특별자치도','16':'경상북도','17':'경상남도','18':'제주특별자치도'}
TYPE={'일반고등학교':'일반고','특성화고등학교':'특성화고','특수목적고등학교':'특목고','자율고등학교':'자율고'}
jinro={}
for ln in open(f'{SP}/si/data/jinro.jsonl'):
    r=json.loads(ln)
    if 'grads' in r and r['grads']>0: jinro[r['code']]=(int(r['grads']),int(r['go_sum'] or 0),int(r['univ'] or 0))
drop={r['SCHUL_CODE']:(int(r.get('STDNT_SUM') or 0),int(r.get('MVT_SUM') or 0)) for r in json.load(open(f'{SP}/si/data/hs_drop.json'))}
basic=json.load(open(f'{SP}/si/data/hs_basic.json'))
d=json.load(open(BD)); hs=d['hs']
EM=('초등학교','중학교')
for r in hs:
    if len(r)>6: del r[6:]          # 재계산을 위해 기존 지표 제거
byname=collections.defaultdict(list)
for i,r in enumerate(hs):
    if r[1] not in EM: byname[r[0]].append(i)
matched=0;amb=0;nomatch=0;typed=0;used=set()
for b in basic:
    code=b['SCHUL_CODE']; j=jinro.get(code); dr=drop.get(code)
    if not j and not dr: continue
    idxs=[i for i in byname.get(b['SCHUL_NM'],[]) if i not in used]
    pick=None
    if len(idxs)==1: pick=idxs[0]
    elif len(idxs)>1:
        sido=LCTN.get(b['LCTN_SC_CODE']); adr=(b.get('ADRCD_NM') or '').split(); gungu=adr[-1] if adr else ''
        cand=[i for i in idxs if (sido and hs[i][2]==sido) or (not sido and hs[i][2] in ('광주광역시','전라남도'))]
        if len(cand)>1 and gungu: cand=[i for i in cand if hs[i][3]==gungu] or cand
        if len(cand)==1: pick=cand[0]
        else: amb+=1
    else: nomatch+=1
    if pick is None: continue
    row=hs[pick]; used.add(pick); matched+=1
    row.append([j[0] if j else 0, j[1] if j else 0, j[2] if j else 0, dr[0] if dr else 0, dr[1] if dr else 0])
    if not row[1] and TYPE.get(b.get('HS_KND_SC_NM','')): row[1]=TYPE[b['HS_KND_SC_NM']]; typed+=1
print('matched',matched,'ambiguous',amb,'nomatch',nomatch,'types filled',typed)
print('with 진로:',sum(1 for r in hs if len(r)>6 and r[6][0]>0),'empty types left:',sum(1 for r in hs if r[1] not in EM and not r[1]))
json.dump(d,open(BD,'w'),ensure_ascii=False,separators=(',',':'))
