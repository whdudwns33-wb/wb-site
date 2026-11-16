# 족보닷컴 중등 국어 PDF 목록 → 단원 폴더(팩 id) 배치 계획. 복사는 하지 않고 계획(tsv)만 낸다.
#   python3 naesin-ko/extract/plan-folders.py <파일목록.txt> <계획.tsv>
#   파일목록: 원본 뿌리(족보닷컴 자료/국어)에서 `find ./중1 ./중2 ./중3 -name '*.pdf'` 로 뽑은 줄들
#   계획 한 줄: "<원본 상대경로>\t<교과서·학기 서랍>/<팩 id 폴더>"  (docs/자료-폴더-표준.md §1·§2)
# 인자 없이 돌리면 자체 점검만 한다.
import re, sys, collections

PUB = {'미래엔(민병곤)': 'mirae-minbyeonggon', '미래엔(신유식)': 'mirae-shinyoungsik', '비상(김진수)': 'bisang-kimjinsu',
       '비상(박영민)': 'bisang-parkyeongmin', '비상(박현숙)': 'bisang-parkhyeonsuk', '지학사(이삼형)': 'jihak-lisamhyeong',
       '창비(이도영)': 'changbi-leedoyeong', '천재(노미숙)': 'cheonjae-nomisuk', '천재(박영목)': 'cheonjae-parkyeongmok',
       '천재(정호웅)': 'cheonjae-jeonghoung', '해냄(강양희)': 'haenaem-kangyanghui'}
ALIAS = {'해냄(걍양희)': '해냄(강양희)', '해냄(강영희)': '해냄(강양희)'}   # 파일 이름 오타
REV = {'1': '2022', '2': '2022', '3': '2015'}   # 2026년 시행 기준


def place(p):
    """'./중2/천재 노미숙/…/[단원집중] 1-1.…_천재(노미숙) (1회).pdf' → '중2 천재(노미숙) 1학기/2022-cheonjae-nomisuk-m2-1-U1' (못 정하면 None)"""
    parts = p[2:].split('/'); name = parts[-1]
    g = parts[0][1]
    pub = re.search(r'(미래엔|비상|지학사|창비|천재|해냄)\((\S+?)\)', name)
    pubk = f'{pub.group(1)}({pub.group(2)})' if pub else parts[1].replace(' ', '(', 1) + ')'
    pubk = ALIAS.get(pubk, pubk)
    gm = re.search(r'\)\s?([123])-([12])|중([123]) 국어 ([123])-([12])|([12])학기', name)
    sem = (gm.group(2) or gm.group(5) or gm.group(6)) if gm else None
    if not sem:
        fm = re.search(r'/국어([12])/', p)
        sem = fm.group(1) if fm else None
    if name.startswith('[Final모의고사]'):
        unit = 'exam'
    else:
        um = re.search(r'\]\s*(?:개념이해[AB] )?(?:20\d\d )?(\d+)[-.]', name)
        unit = 'U' + um.group(1) if um else None
    if pubk not in PUB or not sem or not unit:
        return None
    base = f'{REV[g]}-{PUB[pubk]}-m{g}-{sem}'
    return f'중{g} {pubk} {sem}학기/' + (base + '-' + unit if unit != 'exam' else '시험 대비 모의고사')


def selftest():
    # 파일 이름에 학기가 없으면 상위 폴더 국어1/국어2 로 정한다
    assert place('./중2/천재 노미숙/단원집중/국어1/[단원집중] 1-1.가상 제목_중2 국어 천재(노미숙) (1회) [20문제] [Q].pdf') == '중2 천재(노미숙) 1학기/2022-cheonjae-nomisuk-m2-1-U1'
    assert place('./중2/모르는 출판사/[단원집중] 1-1.가상_중2 국어 모름(누구) (1회).pdf') is None
    assert place('./중2/천재 노미숙/서술형 공략/국어1/1/[서술형 공략] 1.가상 단원(01)_천재(노미숙)2-1 국어 [25문제].pdf') == '중2 천재(노미숙) 1학기/2022-cheonjae-nomisuk-m2-1-U1'
    assert place('./중3/천재 박영목/개념학습/국어2/[개념완성] 3-2.가상_천재(박영목) 중3 국어_step1.이해전략.pdf') == '중3 천재(박영목) 2학기/2015-cheonjae-parkyeongmok-m3-2-U3'
    assert place('./중1/해냄 강양희/실전대비/최다오답 공략/국어2/[최다오답 공략] 3.가상(01)_해냄(걍양희)1-2 국어 [20문제] [Q].pdf') == '중1 해냄(강양희) 2학기/2022-haenaem-kangyanghui-m1-2-U3'
    assert place('./중3/창비 이도영/시험직전대비/국어2/[Final모의고사] 2026년 2학기 기말 대비 중3 국어_창비(이도영)_1회 [Q].pdf') == '중3 창비(이도영) 2학기/시험 대비 모의고사'
    print('plan-folders 자체 점검 통과')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        selftest(); sys.exit(0)
    rows, bad = [], []
    for p in open(sys.argv[1], encoding='utf-8').read().splitlines():
        if not re.match(r'\./중[123]/', p):
            continue
        f = place(p)
        (rows if f else bad).append(f'{p}\t{f}' if f else p)
    open(sys.argv[2], 'w', encoding='utf-8').write('\n'.join(rows) + '\n')
    print('배치', len(rows), '/ 못 정함', len(bad))
    for b in bad[:20]:
        print('  ?', b)
