#!/usr/bin/env python3
"""WB 국어브레인 — PDF → span JSON (추출 파이프라인 1단계)

  python3 naesin-ko/extract/pdf-spans.py <PDF> [> spans.json]
  python3 naesin-ko/extract/pdf-spans.py <PDF> --colors   # 색 분포만 본다(새 출판사 자료 점검)

왜 이 단계가 따로 있나:
  족보닷컴 자료의 **빈칸 정답은 흰색(#ffffff)·연회색(#e5e5e5) 텍스트로 지면에 이미 있다.**
  학생용 지면과 선생님용 지면의 텍스트 레이어가 같고, 눈에 안 보이게 색만 바꿔 둔 것이다.
  그래서 "학생용/선생님용을 이미지로 대조한다"가 아니라 **색으로 가른다** — 이게 검수 비용을
  가장 크게 줄이는 지점이다(기획서 §7 난점 표를 이 발견으로 갱신했다).

  색 정보는 pdftotext가 주지 않아 PyMuPDF가 필요하다. 이 스크립트는 **오프라인 도구**이고
  앱·CI는 건드리지 않는다(저장소의 '외부 의존성 없음' 규칙은 브라우저 코드 규칙이다).

준비:  pip install pymupdf

출력(JSON): { file, pages:[ { no, width, height, lines:[ { y, spans:[ {x, w, size, color, text} ] } ] } ] }
  - 같은 행(y 근사)의 span을 x 순으로 묶어 둔다 — 다음 단계가 행 단위로 읽는다.
  - 색은 '#rrggbb' 문자열. hidden 판정은 다음 단계 몫이다(자료마다 색이 다를 수 있어
    여기서 버리지 않는다 — 원문 보존).
"""
import json
import sys

try:
    import pymupdf
except ImportError:  # 옛 이름
    try:
        import fitz as pymupdf
    except ImportError:
        sys.exit("PyMuPDF가 필요합니다:  pip install pymupdf")

ROW_TOL = 3.0   # 같은 행으로 볼 y 오차(pt). 첨자·괄호가 미세하게 어긋난다.


def extract(path):
    doc = pymupdf.open(path)
    pages = []
    for pno, page in enumerate(doc, start=1):
        raw = []
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                for s in line["spans"]:
                    text = s["text"]
                    if not text.strip():
                        continue
                    x0, y0, x1, y1 = s["bbox"]
                    raw.append({
                        "x": round(x0, 1), "w": round(x1 - x0, 1), "y": round(y0, 1),
                        "size": round(s["size"], 1),
                        "color": "#%06x" % s["color"],
                        "text": text,
                    })
        raw.sort(key=lambda r: (r["y"], r["x"]))

        lines = []
        for r in raw:
            if lines and abs(r["y"] - lines[-1]["y"]) <= ROW_TOL:
                lines[-1]["spans"].append(r)
            else:
                lines.append({"y": r["y"], "spans": [r]})
        for ln in lines:
            ln["spans"].sort(key=lambda s: s["x"])
            for s in ln["spans"]:
                del s["y"]
        pages.append({
            "no": pno,
            "width": round(page.rect.width, 1),
            "height": round(page.rect.height, 1),
            "lines": lines,
        })
    return {"file": path.split("/")[-1], "pages": pages}


def colors(doc):
    """색 → (span 수, 예시 글자). 새 출판사 자료를 받으면 이걸 먼저 본다 —
    '안 보이는 색'이 #ffffff 가 아닐 수 있고, 그러면 build-ihae 의 PALE 을 넓혀야 한다."""
    tally = {}
    for page in doc["pages"]:
        for line in page["lines"]:
            for s in line["spans"]:
                c = tally.setdefault(s["color"], {"n": 0, "sample": ""})
                c["n"] += 1
                if not c["sample"]:
                    c["sample"] = s["text"].strip()[:20]
    rows = sorted(tally.items(), key=lambda kv: -kv[1]["n"])
    return "\n".join("%s  %6d  %s" % (c, v["n"], v["sample"]) for c, v in rows)


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    doc = extract(args[0])
    if "--colors" in args:
        print(colors(doc))
    else:
        print(json.dumps(doc, ensure_ascii=False))
