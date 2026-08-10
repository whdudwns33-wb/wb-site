# 엔진 검증 예시 — HTP 샘플 케이스 (워크드 예시)

> AI 해석 엔진 프롬프트 스펙 v0를 샘플 HTP 케이스에 적용한 **end-to-end 워크드 예시**.
> 목적: 파이프라인이 실제로 안전규칙(가설 언어·근거수준·연령보정·확정 게이트·위기 라인)을 적용하는지 지면 검증.
> ⚠️ **한계**: 이것은 스펙 검증용 예시입니다. **정식 검증은** 실제 Claude Vision 백엔드 + 실제 아동 그림 다수 + **심리사 채점과의 비교(초안 채택률·재작성률)**가 필요합니다. 아래 텍스트 출력은 스펙에 따라 작성한 기대 산출물입니다.

---

## 입력

- 검사: **HTP**
- 아동: 별명 "○○(샘플)", 만 **8세**, 남아
- 상황: "동생이 태어난 뒤 그린 그림"
- 이미지: 프로토타입 SVG 샘플(집=지붕 큼·문 손잡이 없음, 나무=뿌리 강조, 사람=손 생략·큰 눈·미소)

---

## [S0] 안전·품질 게이트

```json
{ "image_quality": { "ok": true, "issues": [] },
  "crisis_scan": { "level": "none", "flags": [] } }
```
→ 위기 신호 없음, 품질 양호 → 파이프라인 진행. (urgent였다면 자동 해석 중단·전문가 즉시검토)

---

## [S1] 관찰 추출 (Vision) — 해석 없이 사실만

```json
{
  "test_type": "HTP",
  "observations": [
    { "element": "house.roof", "present": true, "attributes": { "size": "large" }, "note": "지붕이 몸체보다 크게", "vision_confidence": "high" },
    { "element": "house.door", "present": true, "attributes": { "handle": false }, "note": "문 손잡이 없음", "vision_confidence": "medium" },
    { "element": "house.window", "present": true, "attributes": { "count": 2 }, "note": "창문 2개", "vision_confidence": "high" },
    { "element": "tree.root", "present": true, "attributes": { "emphasis": "strong" }, "note": "뿌리·밑동 강조", "vision_confidence": "medium" },
    { "element": "person.hand", "present": false, "note": "손 생략", "vision_confidence": "high" },
    { "element": "person.eyes", "present": true, "attributes": { "size": "large" }, "note": "큰 눈", "vision_confidence": "high" },
    { "element": "person.mouth", "present": true, "attributes": { "expression": "smile" }, "note": "미소", "vision_confidence": "high" }
  ],
  "crisis_flags": []
}
```

---

## [S2] 가설 매핑 (KB 조회 + 안전 규칙)

> 규칙 적용: 연령 보정(만 8세) → `person.hand`는 정상 범위 가능 → 신뢰도 강등. 색채·자유화 없음. 모든 항목에 caveat.

```json
{
  "hypotheses": [
    { "id": "house.roof", "observation": "지붕을 크게",
      "hypothesis": "상상·공상에 대한 관심이 큰 경향 (가능성)",
      "confidence": "low", "caveats": ["HTP 지붕 해석 근거 약함", "연구 간 의미 상충"], "needs_expert_check": true },
    { "id": "house.door", "observation": "문 손잡이 없음",
      "hypothesis": "관계 접근에 신중한 경향 (가능성)",
      "confidence": "mid", "caveats": ["단일 지표 단정 금지", "면담(PDI)으로 확인"], "needs_expert_check": true },
    { "id": "tree.root", "observation": "뿌리 강조",
      "hypothesis": "안정감·현실 지향 추구 가능성",
      "confidence": "low", "caveats": ["뿌리 상징 해석 근거 약함"], "needs_expert_check": true },
    { "id": "person.hand", "observation": "손 생략",
      "hypothesis": "행위·대인접촉에 조심스러움 가능성",
      "confidence": "low",
      "age_adjustment": "만 8세 전후에서는 발달상 정상 범위일 수 있음 — 병리 단정 금지",
      "caveats": ["귀찮음 등 대안 설명 가능", "반복 시에만 의미"], "needs_expert_check": true },
    { "id": "person.face", "observation": "큰 눈·미소",
      "hypothesis": "정서 표현이 개방적, 긍정 정서 (강점)",
      "confidence": "mid", "caveats": ["노골적 정서 기호만 참고", "진단 아님"], "needs_expert_check": true }
  ],
  "crisis_assessment": { "level": "none" }
}
```

**검증 체크**: ✅ '강' 신뢰도 없음(투사검사 특성 반영) · ✅ 손 생략 연령보정으로 mid→low 강등 · ✅ 전 항목 caveat + needs_expert_check.

---

## [S3-a] 전문가용 초안 (검수 대상)

> **관찰 → 가설(신뢰도) → 상담 확인질문** 형식. "진단" 단어 없음.

- **큰 눈·미소** (강점, 근거 중): 정서 표현이 개방적이고 긍정 정서가 드러남. *확인질문:* "이 사람은 지금 기분이 어때?"
- **문 손잡이 없음** (근거 중): 관계 접근에 신중한 경향 가능성. 단일 지표로 단정 불가. *확인질문:* "이 집에는 누가 들어와?"
- **지붕 크게** (근거 약): 상상·공상 관심 가능성. 근거 약함, 대안 해석 여지 큼.
- **뿌리 강조** (근거 약): 안정감·현실 지향 추구 가능성.
- **손 생략** (근거 약, 연령보정): 만 8세 전후 발달상 정상 범위일 수 있음. 병리 단정 금지. 반복 시에만 의미. *확인질문:* "손은 왜 안 그렸어?"
- **종합**: 전반적으로 긍정 정서 자원이 관찰됨. 동생 출생 맥락 고려 시 가족 내 위치 탐색 권장. **본 초안은 가설이며, 타 검사·면담과 통합 필요.**

---

## [S3-b] 학부모용 미리보기 (확정 전, 순한 버전)

> 강점 우선·관찰 중심·불안 유발 금지.

"○○의 그림에는 밝은 표정과 큰 눈이 담겨 있어, 자기 마음을 표현하는 데 열려 있는 모습이 보여요. 튼튼한 나무처럼 안정감을 좋아하는 느낌도 있습니다. 더 자세한 이야기는 전문 선생님이 확인한 뒤 정식 리포트로 전해 드릴게요. *(참고용이며 진단이 아닙니다.)*"

---

## [게이트] 전문가 확정 (예시: '지붕 크게'를 근거 약함으로 삭제)

- accepted: 큰 눈·미소, 문 손잡이 없음, 뿌리 강조, 손 생략(연령보정)
- rejected: 지붕 크게
- → parent_report는 accepted 4건만 반영, rejected 제외.

## [S3-c] 학부모 정식 리포트 (확정 후)

> 구조: 강점 → 관찰된 특징 → 집에서 돕는 법 → 다음 단계. (프로토타입 학부모 리포트 화면과 동일 톤)

- **강점**: 밝은 정서 표현, 안정감 선호.
- **관찰된 특징**: 새로운 관계에 조금 신중한 편일 가능성. 동생 출생 시기와 겹쳐 가족 내 자기 자리를 살피는 마음일 수 있음.
- **집에서 돕는 법**: 그림으로 이야기 열어주기, 아이만의 시간, 구체적 칭찬.
- **다음 단계**: 1:1 해석 상담 안내. *하단 면책 고정.*

---

## 검증 결론

| 안전규칙 | 적용 여부 |
|---------|:--------:|
| 관찰(S1)과 해석(S2) 분리 | ✅ |
| 근거수준 강/중/약 부착, '강' 남발 없음 | ✅ |
| 연령 보정(손 생략 강등 + 문구) | ✅ |
| 가설 언어·"진단" 미사용 | ✅ |
| 전 항목 caveat + 전문가 확인 플래그 | ✅ |
| 확정 게이트(rejected 제외) → 정식 리포트 | ✅ |
| 위기 라인 우선 처리 | ✅ (none 케이스) |

→ 스펙은 지면상 일관되게 안전규칙을 강제함. **다음 검증 단계**: 실제 Vision 백엔드 연동 후 실제 아동 그림으로 심리사 채점 대비 초안 채택률·오탐/미탐 측정.
