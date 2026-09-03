import json,subprocess,time,sys
import os
SP=os.path.dirname(os.path.abspath(__file__))
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
OFFICES=['01','05','02','03','04','06','07','08','10','12','13','16','17','18','11','14']
def call(apitype,knd,office,year='2026'):
    for attempt in range(3):
        r=subprocess.run(['curl','-sS','-m','90','-A',UA,'-b',f'{SP}/si/cookies.txt',
            '-H','Referer: https://www.schoolinfo.go.kr/ng/go/pnnggo_a01_l2.do',
            '-H','X-Requested-With: XMLHttpRequest',
            'https://www.schoolinfo.go.kr/openData.do','--data',
            f'APIKEY=schoolinfo2020&APITYPE={apitype}&DEPTHNO=0&SCHULKNDCODE={knd}&PBANYR={year}&LCTNSCCODE={office}'],
            capture_output=True,text=True)
        try:
            d=json.loads(r.stdout); return d.get('list',[])
        except Exception as e:
            time.sleep(3*(attempt+1))
    return []
schools=[];drop=[]
for o in OFFICES:
    l=call('0','04',o); schools+=l
    l2=call('10','04',o); drop+=l2
    print(o,'basic',len(l),'drop',len(l2),flush=True); time.sleep(0.5)
json.dump(schools,open(f'{SP}/si/data/hs_basic.json','w'),ensure_ascii=False)
json.dump(drop,open(f'{SP}/si/data/hs_drop.json','w'),ensure_ascii=False)
print('TOTAL basic',len(schools),'drop',len(drop))
if drop: print('drop row keys:',list(drop[0].keys())); print(drop[0])
