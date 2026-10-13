# EXAM4YOU 로컬 획득 기록

Node 20+ 내장 모듈만 사용. 앱·서버·추출기와 연결하지 않은 별도 운영 도구다.
브라우저, 로그인, 다운로드, 네트워크, 정리/이동/삭제 기능이 없다. PDF는 읽기만 한다.
실제 manifest·백업·목록은 저장소 밖에 보관한다. 테스트는 임시 폴더의 자체 제작 바이트만 쓴다.

## 현재 PC 명령 (PowerShell)

~~~powershell
Set-Location 'C:\Users\wb\Projects\wb-site-naesin-handoff'
$root = 'C:\Users\wb\WB 학습자료\naesin\2026-2'
node naesin/acquire/acquire.mjs init --root "$root"
node naesin/acquire/acquire.mjs scan --root "$root"
node naesin/acquire/acquire.mjs verify --root "$root"
node naesin/acquire/acquire.mjs report --root "$root"
# 선택: 보고서를 원본 밖 관리 폴더에 저장
node naesin/acquire/acquire.mjs report --root "$root" > "$root\_acquisition\report.json"
node --test naesin/acquire/acquire.test.mjs
~~~

기본 root는 위 경로, 기본 manifest는 root/_acquisition/manifest.json.
--manifest로 다른 JSON 경로를 지정할 수 있다. 기존 manifest의 root는 바꾸지 않는다.
init은 기존 기록을 초기화하지 않는다. scan과 verify는 파일별로 실패를 기록하고 계속 진행한다.
종료코드: 0 정상(미확인/미보유가 있어도 정상), 1 설정·잠금·스키마 오류, 2 파일 오류.

## 두 층

- rawPath: 발견한 모든 PDF의 root 기준 상대 경로. 정본 대상이 아니거나 중복이어도 보존.
- canonicalPath: 정본 슬롯별 선택 파일을 가리키는 상대 경로. 파일을 만들거나 복사하는 명령이 아니다.
- SHA-256이 같은 후보는 슬롯당 하나만 선택. 같은 슬롯인데 해시가 다른 후보는 충돌로 남기고 자동 선택하지 않는다.
- 다른 단원/자료 슬롯 간 같은 해시는 보고하지만 의미가 다른 슬롯을 합치지 않는다.
- 각 확인된 폴더에는 정본 13 + 분리 10 슬롯을 unknown으로 시작한다. 23개가 반드시 존재한다는 뜻이 아니다.
- 폴더를 찾지 못한 출판사·학년·단원은 추측 생성하지 않는다. inventory로 나중에 추가한다.

### 정본 13 매핑

|파일 접두어|material|variant|수|
|---|---|---|---|
|00 교과서본문|textbook|student|1|
|01 내용정리|content|student|1|
|02 본문워크북 통합|workbook|integrated|1|
|03 단어시험|word-test|student|1|
|04 예상문제 PRE-STEP|pre-step|student / teacher|2|
|05 예상문제 1회|exam-1|student / teacher|2|
|06 예상문제 2회|exam-2|student / teacher|2|
|07 문법워크북|grammar-workbook|student|1|
|08 문법객관식|grammar-choice|student|1|
|09 문법주관식|grammar-written|student|1|

교사용 또는 teacher가 있으면 teacher. 일반 자료의 student는 학생용 단일 자료를 뜻한다.
워크북 이름에 stage-N / step-N / N단계 / 단계N (1~10)이 있으면 workbook + stage-N으로 먼저 판별하며 정본에서 제외한다.
사이트 원본 이름의 `본문10단계 워크북 N ...`도 N=1~10이면 분리 단계로 판별한다(공백 변형 허용). `본문10단계 워크북 통합본(1~10)`은 분리 단계가 아니며, 기존 02 접두어가 있을 때만 integrated로 판별한다.
그 밖의 이름은 unclassified/unknown으로 남는다. 새로운 사이트 파일명 규칙은 테스트를 추가한 뒤 확장한다.
00..09 접두어는 현재 정리된 파일의 의미만 나타낸다. 사이트 임의 번호에 적용하기 전에 목록과 대조해야 한다.

## 스키마와 재개

manifest.schema.json은 엄격한 JSON Schema 2020-12. CLI는 사용한 키워드만 내장 검증한다.
행 필드:
- id: 지속적인 행 식별자. scope = curriculum / grade / publisher / unitRawLabel / unitCode.
- curriculum: m1,m2=2022, m3=2015. 아직 모르면 null. publisher는 폴더의 안정 코드 또는 목록에서 확인한 코드.
- unitCode: L1~L12, SL/SL1/SL2, SR/SR1/SR2. Special Lesson/Reading의 번호 유무는 구별한다.
- 원본 label과 rawPath는 변경하지 않는다. 비교용 NFC 정규화 및 끝의 (1)/(2) 제거는 분류에만 사용한다. 서로 다른 파일 행은 절대 병합하지 않는다.
- material / variant: 위 정본 및 분리단계. 기타 자료도 별도 material 키로 기록 가능.
- source: listingId, title, catalogLabel, observedAt만 허용. 로그인 정보, 쿠키, URL(다운로드·서명 URL 포함)은 저장 금지. 스키마의 임의 필드는 거부하고 URL 문자열도 거부한다.
- status: unknown(목록 미확인), available(목록 확인·미확보), downloaded(로컬 해시/헤더 확인), verified(재검증), not_available(목록에서 없음 확인), blocked(접근 불가), error(파일/검사 실패).
- bytes / sha256 / pageCount, createdAt / updatedAt / scannedAt / verifiedAt(UTC ISO), attempts(로컬 검사 횟수), error.
- pageCount는 null. 기존 추출기는 Python pdfplumber 의존으로 별도 설치가 필요하므로 이 무의존 Node 도구에서 실행하지 않는다.
- verified는 파일 존재·0바이트 아님·첫 5바이트 %PDF-·해시 일치만 보장한다. PDF 전체 파싱, 암호화, 페이지 렌더링, 내용 및 판본 일치는 검증하지 않는다.

동일 경로 재스캔은 같은 행을 갱신한다. 이전 unclassified 파일 행이 새 규칙으로 분류되면 동일 범위·자료·단계의 빈 목록 슬롯에 연결하고 중복 행만 제거한다. 슬롯 id·생성시각·출처 목록 정보와 파일 rawPath·해시·크기·검증시각·페이지 수를 보존하며 파일 상태(verified/downloaded)가 available보다 우선한다. 파일은 이동·삭제하지 않는다.
같은 슬롯에 다른 rawPath가 있거나 후보 슬롯이 여러 개면 MIGRATION_SLOT_CONFLICT, 출처/페이지 메타데이터가 상충하면 MIGRATION_METADATA_CONFLICT로 두 행을 보존한다. verify는 이 오류를 해제하지 않는다. 원인을 수동 검토한 뒤 scan으로 재시도한다. 기존 해시와 달라지면 HASH_CHANGED이며 원래 해시를 덮어쓰지 않는다.
고친 파일의 재기준 설정은 별도 수동 검토가 필요하다. 오류/미확인 행은 자동 삭제하지 않는다.
쓰기는 같은 폴더 임시 파일 + fsync + rename. 이전 manifest는 매번 고유 .bak-* 파일로 보존한다.
CLI는 .lock 배타 잠금으로 동시 쓰기를 거부한다. 비정상 종료 시 PID를 확인하고 중단된 프로세스임을 확인한 뒤 잠금만 수동 제거하고 재실행한다.
.bak-* / .tmp-*는 자동 청소하지 않는다. 백업 복구는 중단 상태에서 JSON 확인 후 별도 수동 작업.
PDF/심볼릭 링크를 쓰지 않으며 스캔은 링크를 따라가지 않는다. root 밖 파일은 검증하지 않는다.

## 브라우저 배치 절차 (CLI와 별도)

1. 사이트에서 교육과정·출판사·단원·자료 목록을 확인한다. 다운로드 URL/쿠키 없이 목록 JSON을 만든다.
2. inventory로 조금씩 병합한다. 미확인과 실제 없음(not_available)을 구분한다.
3. 브라우저에서 Downloads로 다운로드한다. **이 CLI는 Downloads를 읽지 않는다.**
4. 별도 승인된 작업으로 원본 보존하며 raw archive 또는 현재 단원 폴더에 복사/정리한다.
5. scan → verify → report. 충돌·오류·unknown을 검토하고 다음 배치를 이어간다.
Downloads를 --root로 명시하지 않는 한 접근하지 않는다. 정리 기능은 명시 옵션으로도 제공하지 않는다.

목록 입력 예시(저장소 밖 inventory.json):
~~~json
[{"id":"inventory-m3-example-SR-workbook-stage1","curriculum":"2015","grade":"m3","publisher":"example","unitRawLabel":"Special Reading","unitCode":"SR","material":"workbook","variant":"stage-1","status":"unknown","source":{"listingId":null,"title":"본문워크북 1단계","catalogLabel":null,"observedAt":null}}]
~~~
~~~powershell
node naesin/acquire/acquire.mjs inventory --root "$root" --input "$root\_acquisition\inventory.json"
~~~
동일 id 또는 파일 없는 동일 슬롯은 갱신한다. 목록 행은 전체 상태를 다시 입력한다. 이미 파일이 연결된 행은 목록 입력으로 바꿀 수 없다.

## 보고서(JSON stdout)

root, generatedAt, rows, files, statusCounts, canonicalSelected,
duplicateHashes[{sha256,paths}], errors[{id,rawPath,error}], unclassified[],
units[{curriculum,grade,publisher,unitCode,canonical,readiness,missingCanonical,unknown,availableMissing,conflicts}].
complete는 정본 13슬롯 충족일 뿐 raw 전체 수집 완료가 아니다. special 단원은 실제 자료 구성이 다를 수 있으므로 partial을 결함으로 단정하지 않는다.
report는 저장된 마지막 검사 상태이며 실시간 파일 재검증은 하지 않는다.
