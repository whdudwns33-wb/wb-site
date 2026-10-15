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
    acc = collections.defaultdict(list)      # (school_key, hi, yr, gr, tm, subj) → [ (avg, d) ]
    meta, identities = {}, {}
    seen_rows = kept = 0
    with open(path, encoding='utf-8-sig', newline='') as f:
        for row in csv.DictReader(f):
            seen_rows += 1
            hi = 1 if row['school_level'].startswith('고') else 0
            key, sc, region = ((row.get(k) or '').strip() for k in ('school_key', 'school_name', 'region'))
            if not key or not sc or not region:
                raise ValueError(f'{seen_rows + 1}행: school_key·학교명·지역은 필수입니다')
            info = (sc, region, hi)
            if key in meta and meta[key] != info:
                raise ValueError(f'{seen_rows + 1}행: 같은 school_key의 학교명·지역·학교급이 다릅니다')
            if identities.setdefault((sc, region), key) != key:
                raise ValueError(f'{sc} ({region}): 서로 다른 school_key를 표시명으로 구분할 수 없습니다')
            meta[key] = info
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
            acc[(key, hi, int(yr), gr, tm, sj)].append((avg, d))
            kept += 1
    school_ids = {k[0] for k in acc}
    name_counts = collections.Counter(meta[key][0] for key in school_ids)
    labels, ambiguous = {}, collections.defaultdict(list)
    for key in school_ids:
        sc, region, hi = meta[key]
        labels[key] = sc if name_counts[sc] == 1 else f'{sc} ({region})'
        if name_counts[sc] > 1:
            ambiguous[sc].append(labels[key])
    if len(set(labels.values())) != len(labels):
        raise ValueError('학교 표시명이 충돌합니다 — 학교명·지역을 확인하세요')
    schools = sorted(labels.values())
    lvl = {labels[key]: meta[key][2] for key in school_ids}
    sidx = {n: i for i, n in enumerate(schools)}
    jidx = {n: i for i, n in enumerate(CORE)}
    out = []
    for (key, hi, yr, gr, tm, sj), vs in acc.items():          # 같은 학교의 계열이 여럿이면 평균
        n = len(vs)
        avg = round(sum(v[0] for v in vs) / n, 1)
        d = [round(sum(v[1][i] for v in vs) / n, 1) for i in range(5)]
        out.append([sidx[labels[key]], hi, yr - 2000, gr, tm, jidx[sj], avg] + d)
    out.sort()
    ach = {'s': schools, 'j': list(CORE), 'r': out}
    if ambiguous:
        ach['ambiguous'] = {name: sorted(ambiguous[name]) for name in sorted(ambiguous)}
    return ach, seen_rows, kept, lvl

if __name__ == '__main__':
    ach, seen, kept, lvl = build(sys.argv[1])
    hi = sorted(n for n in ach['s'] if lvl[n])
    mid = sorted(n for n in ach['s'] if not lvl[n])
    print(f"원본 {seen:,}행 → 채택 {kept:,}행 → 병합 {len(ach['r']):,}행")
    print(f"학교 {len(ach['s'])}곳 (고 {len(hi)} · 중 {len(mid)})")
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        json.dump(ach, f, ensure_ascii=False, separators=(',', ':'))
    print('저장:', sys.argv[2])
