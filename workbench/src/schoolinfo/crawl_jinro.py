import json,subprocess,time,re,os,sys,concurrent.futures
import os
SP=os.path.dirname(os.path.abspath(__file__))
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
OUT=f'{SP}/si/data/jinro.jsonl'
schools=[r for r in json.load(open(f'{SP}/si/data/hs_basic.json')) if r.get('SHL_IDF_CD') and r.get('CLOSE_YN')!='Y']
done=set()
if os.path.exists(OUT):
    for ln in open(OUT):
        try: done.add(json.loads(ln)['code'])
        except: pass
todo=[r for r in schools if r['SCHUL_CODE'] not in done]
print(f'total {len(schools)} done {len(done)} todo {len(todo)}',flush=True)
def fetch(r):
    uuid=r['SHL_IDF_CD']
    cmd=['curl','-sS','-m','45','-A',UA,'-b',f'{SP}/si/cookies.txt',
        '-H','Referer: https://www.schoolinfo.go.kr/ei/ss/pneiss_a03_s0.do',
        '-H','X-Requested-With: XMLHttpRequest',
        'https://www.schoolinfo.go.kr/ei/pp/Pneipp_b06_s0p.do']
    data={'GS_HANGMOK_CD':'06','GS_HANGMOK_NO':'13-다','GS_HANGMOK_NM':'졸업생의 진로 현황','GS_BURYU_CD':'JG040','JG_BURYU_CD':'JG130','JG_HANGMOK_CD':'52','JG_GUBUN':'1','JG_YEAR':'2026','JG_YEAR2':'2026','CHOSEN_JG_YEAR':'2026','PRE_JG_YEAR':'2026','SHL_IDF_CD':uuid,'GS_TYPE':'Y'}
    for k,v in data.items(): cmd+=['--data-urlencode',f'{k}={v}']
    for attempt in range(3):
        p=subprocess.run(cmd,capture_output=True)
        h=p.stdout.decode('euc-kr',errors='replace')
        if '졸업자' in h or '공시정보가 없습니다' in h or '데이터가 없습니다' in h: return h
        time.sleep(2*(attempt+1))
    return h
def parse(h):
    # find the summary table rows; take the 합계 row of the first 진로 table
    rows=re.findall(r'<tr[^>]*>(.*?)</tr>',h,re.S)
    yr=re.search(r'name="JG_YEAR"\s+value="(\d{4})"',h)
    for tr in rows:
        cells=[re.sub(r'<[^>]+>|&nbsp;|\s','',c) for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>',tr,re.S)]
        if cells and ('합계' in cells[0] or '합계' in (cells[0]+''.join(cells[:1]))):
            nums=[c for c in cells[1:] if re.fullmatch(r'-?[\d,]+(\.\d+)?',c or '')]
            if len(nums)>=7:
                v=[float(n.replace(',','')) for n in nums]
                return {'year':yr.group(1) if yr else None,'grads':v[0],'jc':v[1],'univ':v[2],'abroad':v[3],'go_sum':v[6] if len(v)>6 else None,'emp':v[7] if len(v)>7 else None,'etc':v[8] if len(v)>8 else None}
    return None
import threading
lock=threading.Lock()
cnt=0
def work(r):
    global cnt
    h=fetch(r)
    rec={'code':r['SCHUL_CODE'],'name':r['SCHUL_NM'],'lctn':r['LCTN_SC_CODE'],'adr':r.get('ADRCD_NM',''),'knd':r.get('HS_KND_SC_NM','')}
    d=parse(h)
    if d: rec.update(d)
    else: rec['nodata']=True
    with lock:
        with open(OUT,'a') as f: f.write(json.dumps(rec,ensure_ascii=False)+'\n')
        cnt+=1
        if cnt%100==0: print(f'{cnt}/{len(todo)}',flush=True)
    time.sleep(0.15)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
    list(ex.map(work,todo))
print('DONE',cnt)
