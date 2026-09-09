# -*- coding: utf-8 -*-
"""학교학업성취DB CSV → bulk-data.json 의 ach 블록.
   중학교: 전 학년 / 고등학교: 1학년 공통과목만(2·3학년 선택과목은 수강 집단이 편향된다).
   과제·연구·실험이 붙은 과목(과학탐구실험·수학과제탐구·사회과제연구)은 핵심 교과가 아니므로 뺀다."""
import csv, json, re, sys, collections

CORE = ('국어','영어','수학','사회','과학','역사','도덕')
DROP = re.compile(r'과제|연구|실험|탐구실험')

def norm_subj(s):
    t = re.sub(r'\s', '', str(s))
    if DROP.search(t): return None
    t = re.sub(r'[0-9Ⅰ-Ⅹ]+$', '', t)
    t = re.sub(r'^(공통|통합|기본|일반)', '', t)
    if t.startswith('한국사'): return '역사'
    for c in CORE:
        if t.startswith(c): return c
    return None

def num(x):
    try: return float(str(x).replace('%','').replace(',','').strip())
    except Exception: return None

def build(path):
    acc = collections.defaultdict(list)      # (school, hi, yr, gr, tm, subj) → [ (avg, d) ]
    lvl = {}
    seen_rows = kept = 0
    with open(path, encoding='utf-8-sig', newline='') as f:
        for row in csv.DictReader(f):
            seen_rows += 1
            hi = 1 if row['school_level'].startswith('고') else 0
            gr = num(row['grade'])
            if gr is None: continue
            gr = int(gr)
            if hi and gr != 1: continue          # 고교는 1학년 공통과목만
            sj = norm_subj(row['subject'])
            if not sj: continue
            d = [num(row.get('rate_'+k)) for k in 'ABCDE']
            if any(v is None for v in d): continue
            if abs(sum(d) - 100) > 3: continue
            avg = num(row.get('avg_score'))
            if avg is None: continue
            yr = num(row['academic_year'])
            if yr is None: continue
            tm = 2 if '2' in str(row['semester']) else 1
            sc = row['school_name'].strip()
            lvl[sc] = hi
            acc[(sc, hi, int(yr), gr, tm, sj)].append((avg, d))
            kept += 1
    schools = sorted(acc_k[0] for acc_k in {k[:1]: 1 for k in acc})
    schools = sorted({k[0] for k in acc})
    sidx = {n: i for i, n in enumerate(schools)}
    jidx = {n: i for i, n in enumerate(CORE)}
    out = []
    for (sc, hi, yr, gr, tm, sj), vs in acc.items():          # 계열이 여럿이면 평균
        n = len(vs)
        avg = round(sum(v[0] for v in vs) / n, 1)
        d = [round(sum(v[1][i] for v in vs) / n, 1) for i in range(5)]
        out.append([sidx[sc], hi, yr - 2000, gr, tm, jidx[sj], avg] + d)
    out.sort()
    return {'s': schools, 'j': list(CORE), 'r': out}, seen_rows, kept, lvl

if __name__ == '__main__':
    ach, seen, kept, lvl = build(sys.argv[1])
    hi = sorted(n for n in ach['s'] if lvl[n])
    mid = sorted(n for n in ach['s'] if not lvl[n])
    print(f"원본 {seen:,}행 → 채택 {kept:,}행 → 병합 {len(ach['r']):,}행")
    print(f"학교 {len(ach['s'])}곳 (고 {len(hi)} · 중 {len(mid)})")
    json.dump(ach, open(sys.argv[2], 'w'), ensure_ascii=False, separators=(',', ':'))
    print('저장:', sys.argv[2])
