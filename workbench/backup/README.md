# 워크벤치 비공개 파일 — 암호화 백업

새 컴퓨터에서 이 저장소만 클론하면, **워크벤치 접속 비밀번호 하나로** 아래 두 파일을 복원해
전체 빌드·배포가 가능하다. 두 파일 모두 gzip 후 **AES-256-GCM + PBKDF2(SHA-256, 310,000회)** 암호화.

| 파일 | 내용 | 복원 위치 |
|---|---|---|
| `bulk-data.enc.json` | 입결 5개년 46,656행 + 전국 고교 2,396개교(학교알리미 진학 실적·재적 2,355곳 포함) + 호남 초·중 1,555개교 | `workbench/src/bulk-data.json` |
| `private-seed.enc.json` | 학생 14명 시드(관심대학·프로파일 포함) | `workbench/src/private-seed.json` |

평문 금지 이유 — bulk: 어디가(대교협) 발표 재정리본이라 약관상 공개 재배포 불가.
seed: 학생 개인정보. 두 복원 대상 경로는 `.gitignore`에 있어 실수로 커밋되지 않는다.

## 복원 ① bulk-data

```bash
WB_PASSWORD='<비밀번호>' node -e '
const c=require("crypto"),f=require("fs"),z=require("zlib");
const e=JSON.parse(f.readFileSync("workbench/backup/bulk-data.enc.json"));
const k=c.pbkdf2Sync(process.env.WB_PASSWORD,Buffer.from(e.s,"base64"),310000,32,"sha256");
const r=Buffer.from(e.ct,"base64");
const d=c.createDecipheriv("aes-256-gcm",k,Buffer.from(e.iv,"base64"));
d.setAuthTag(r.subarray(r.length-16));
f.writeFileSync("workbench/src/bulk-data.json",z.gunzipSync(Buffer.concat([d.update(r.subarray(0,r.length-16)),d.final()])));
console.log("복원 완료");'
```

## 복원 ② private-seed

```bash
WB_PASSWORD='<비밀번호>' node -e '
const c=require("crypto"),f=require("fs"),z=require("zlib");
const e=JSON.parse(f.readFileSync("workbench/backup/private-seed.enc.json"));
const k=c.pbkdf2Sync(process.env.WB_PASSWORD,Buffer.from(e.s,"base64"),310000,32,"sha256");
const r=Buffer.from(e.ct,"base64");
const d=c.createDecipheriv("aes-256-gcm",k,Buffer.from(e.iv,"base64"));
d.setAuthTag(r.subarray(r.length-16));
f.writeFileSync("workbench/src/private-seed.json",z.gunzipSync(Buffer.concat([d.update(r.subarray(0,r.length-16)),d.final()])));
console.log("복원 완료");'
```

두 파일을 복원한 뒤 `WB_PASSWORD='<비밀번호>' node workbench/src/build.mjs` 로 재빌드한다.
**앱 데이터(시드 이후 입력분)의 정본은 사용 중인 브라우저 localStorage** — 다른 기기는 시드 상태에서 시작하므로,
옮길 때는 기존 기기에서 내보내기/복사로 동기화한다. (Drive 이중 백업: `워크벤치_시드_v2_전체(재빌드용).json`)

데이터를 처음부터 다시 만들려면 Drive `WB_스킬교체_20260813` 폴더의
`대량입결_파서multi_20260901.py`(+`대량입결_파서_build_20260901.py`)와 재생성 레시피를 따른다.
