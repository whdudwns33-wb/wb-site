# 워크벤치 대량 데이터 — 암호화 백업

`bulk-data.enc.json` = `workbench/src/bulk-data.json`(입결 5개년 46,656행 + 전국 고교 2,396개교)을
gzip 후 **AES-256-GCM + PBKDF2(SHA-256, 310,000회)** 로 암호화한 것. 워크벤치 접속 비밀번호가 곧 복호화 키다.

입결 원자료는 어디가(대교협) 발표 수치의 재정리본이라 **평문으로는 공개 저장소에 두지 않는다**
(약관 제15조 재제공 금지 — 암호화 상태로만 보관). 학생 개인정보는 이 파일에 없다.

## 복원

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

복원 후 `WB_PASSWORD='<비밀번호>' node workbench/src/build.mjs` 로 재빌드한다
(`private-seed.json`은 Drive 백업 `워크벤치_시드_v2_전체(재빌드용).json` 참조).

데이터를 처음부터 다시 만들려면 Drive `WB_스킬교체_20260813` 폴더의
`대량입결_파서multi_20260901.py`(+`대량입결_파서_build_20260901.py`)와 재생성 레시피를 따른다.
