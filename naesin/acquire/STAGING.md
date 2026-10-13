# 명시적 다운로드 스테이징

`stage-downloads.mjs`는 별도 수동 로컬 CLI다. 브라우저/로그인/다운로드/앱/서버와 연결하지 않는다.
실제 배치 JSON은 저장소 밖에 둔다. 입력의 root 또는 CLI --root가 필수이며 CLI가 우선한다.
--source-root 기본값은 `C:\Users\wb\Downloads`. 명시한 절대 src 파일만 읽고 폴더를 탐색하지 않는다.

```json
{
  "root": "C:\\Users\\wb\\WB 학습자료\\naesin\\2026-2",
  "scope": {
    "curriculum": "2022", "grade": "m2", "publisher": "ne-kimgitaek",
    "unitRawLabel": "1과", "unitCode": "L1", "folderName": "2022-ne-kimgitaek-m2-L1"
  },
  "files": [{
    "src": "C:\\Users\\wb\\Downloads\\explicit-downloaded-file.pdf",
    "suggestedFilename": "(2022개정)2026년_중2_NE능률(김기택)_1과_[01]내용정리 플러스.pdf"
  }],
  "source": {"listingId": null, "title": "목록 관찰", "catalogLabel": null, "observedAt": null}
}
```

source는 선택이며 위 네 키만 허용한다. 임의 필드, URL 형식, credential 관련 key/value 표기는 거부한다.
어떤 필드에도 비밀번호·쿠키·토큰·URL을 넣지 않는다. 자유 텍스트의 모든 비밀값은 자동 식별할 수 없으므로 작성자도 지켜야 한다.
폴더는 `<curriculum>-<publisher>-<grade>-<unit>`이며 scope와 일치해야 한다.
교육과정 2022/2015, 학년 m1/m2/m3, 안정 슬러그, 원본 단원명, 정규화 코드, 단일 폴더명은 모두 필수다.
Special Lesson/Reading과 번호 1/2는 각각 SL/SL1/SL2, SR/SR1/SR2로 구분한다.

## 실행 순서

```powershell
$root = 'C:\Users\wb\WB 학습자료\naesin\2026-2'
node naesin/acquire/stage-downloads.mjs --input 'C:\Users\wb\Downloads\batch.json' --root "$root"
# stage 종료코드 0을 확인한 뒤 별도로 실행한다. 도구가 자동 실행하지 않는다.
node naesin/acquire/acquire.mjs scan --root "$root"
node naesin/acquire/acquire.mjs verify --root "$root"
node naesin/acquire/acquire.mjs report --root "$root"
# 합성 임시 폴더만 사용하는 테스트
node --test naesin/acquire/stage-downloads.test.mjs naesin/acquire/acquire.test.mjs
```

## 이름 규칙

정본 이름은 실제 L1 폴더 목록을 Node UTF-8로 읽어 확인했다. 실제 PDF는 복사/수정하지 않았다.

- 번호 없는 `_본문.pdf` → `00_교과서본문.pdf` (Special Lesson/Reading 포함)
- `[01]내용정리 플러스` → `01_내용정리.pdf`
- `[02]본문10단계 워크북 통합본(1~10)` → `02_본문워크북.pdf` (단계가 아님)
- `[03]WORD TEST` → `03_단어시험.pdf`
- `[04]예상문제 PRE-STEP` → `04_예상문제_PRE-STEP.pdf`
- `[05]예상문제 1회` → `05_예상문제_1회.pdf`
- `[06]예상문제 2회` → `06_예상문제_2회.pdf`
- 위 04/05/06의 `(교사용)` → 확장자 앞 `_교사용` 추가
- `[07]Grammar Build Up 워크북` → `07_문법워크북.pdf`
- `[08]Grammar Build Up 객관식` → `08_문법객관식.pdf`
- `[09]Grammar Build Up 주관식` → `09_문법주관식.pdf`
- `본문10단계 워크북 N ..._단계별.pdf` (N=1~10) → `_raw/<suggestedFilename 그대로>`

끝의 `(1)/(2)`는 비교/분류에서만 제거한다. 입력 행은 합치지 않는다.
같은 목적지에 같은 해시인 두 행은 copied / already_present가 될 수 있다. 다른 해시면 전체 사전검사 실패.
raw는 suggestedFilename이 다르면 각각 보존한다. suggestedFilename은 basename만 허용하며 경로, URL,
Windows 예약 이름, 경로 구분자, 끝 공백/점은 거부한다.

## 사전검사와 쓰기

배치 전체의 분류·범위·경로·symlink/junction·파일 존재·0바이트·PDF 확장자·`%PDF-` 헤더·SHA-256·기존 목적지를 검사한다.
src basename과 suggestedFilename에서 추출 가능한 교육과정/학년/단원/출판사도 scope와 대조한다.
실패하면 폴더/임시파일/영수증을 포함해 새 쓰기 없음. 기존 동일 해시는 already_present, 다른 해시는 오류.

PDF는 같은 폴더의 고유 임시파일에 복사, fsync, 해시 재검증 후 원자적으로 공개한다.
**안전상 구현 차이:** Node rename은 경쟁 중 생성된 목적지를 덮어쓸 수 있다. 따라서 PDF 최종 공개는
fs.link의 배타적 생성으로 대체했다. 완성 파일만 보이며 no-overwrite를 보장한다.
하드링크 미지원 파일시스템은 실패시키고 위험한 rename fallback을 하지 않는다.
영수증은 고유 UUID 임시파일 + fsync + rename으로 기록한다. 원본/목적지는 삭제·이동하지 않는다.

## 정확한 영수증 동작

사전검사 통과 후 매 실행마다 `root/_acquisition/receipts/stage-<UTC>-<UUID>.json`을 새로 만든다.
내용: version, timestamp, scope, 선택 source, status, files.
각 파일: sourceName(원본 basename), suggestedFilename, destination(root 상대 경로), bytes, sha256, outcome.
src와 절대 원본 경로는 기록하지 않는다. 이전 영수증은 수정하지 않는다.

- 정상: status=complete, outcome=copied 또는 already_present. 종료코드 0.
- 복사 실패: status=partial. 성공 행은 그대로, 실패 행은 failed + COPY_FAILED, 이후 행 not_attempted.
  영수증을 남기고 종료코드 2. 이미 복사한 유효 파일은 유지한다.
- 영수증 쓰기 실패: stdout status=receipt_failed, receipt=null과 파일별 실제 결과. 종료코드 2.
  영수증이 없을 수 있으므로 stdout을 보관한다.
- 사전검사 실패: 새 파일과 영수증 없음. 종료코드 1.
- 정상 stdout에는 영수증 상대 경로 receipt를 추가한다(저장된 영수증 자체에는 이 필드 없음).

재실행은 같은 파일을 건너뛰므로 안전하다. 오류/강제 종료 후 남은 `.stage-*` 또는 receipt `.tmp-*`는 자동 대청소하지 않는다.
정상 완료 중 자신의 임시 이름만 제거한다. 원본은 항상 남는다.

## 한계

- 확인된 한글 출판사 대응은 NE능률(김기택) → ne-kimgitaek. 원본에 안정 슬러그가 직접 있으면 대조 가능.
  다른 한글 표기는 대응표와 테스트를 추가하기 전까지 추측하지 않고 거부한다.
- PDF 전체 파싱·암호화·페이지 수·교육 내용·구매 권한 검증은 하지 않는다.
- 신뢰할 수 있는 로컬 root/source-root에서 실행해야 한다. 검사와 쓰기 사이에 외부 프로세스가
  디렉터리를 악의적으로 교체하는 공격까지 막는 OS sandbox는 아니다. 실행 중 트리를 변경하지 않는다.
- 파일 fsync는 수행하지만 디렉터리 엔트리 fsync와 모든 파일시스템의 전원 장애 내구성을 보장하지 않는다.
- 자동 scan/verify/report, 브라우저 연결, 로그인, 다운로드, 앱/서버 설정 변경 없음.
