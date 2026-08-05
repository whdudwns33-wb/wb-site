# Solapi 원장 수행보고 문자 운영

현재 `/director-report-send` 기능은 직원·학부모에게 보내는 범용 발송기가 아니다.
한 번 클릭할 때 서버에 고정된 원장 본인 번호로 당일 수행보고 LMS 1건을 접수하는 테스트 기능이다.
코드상 한도는 직원별 하루 2건·전체 하루 30건이지만, 최초 운영 검증은 원장 본인 1건만 수행한다.

## 필요한 Worker 설정

Solapi 연결값:

```text
SOLAPI_API_KEY
SOLAPI_API_SECRET
SOLAPI_SENDER_NUMBER
SOLAPI_TEST_RECIPIENT_PHONE
```

실발송 안전 게이트:

```text
WB_SEND_MODE=test
WB_TEST_RECIPIENT_ID=TEST-SMS-001
WB_ACTUAL_TEST_SEND_APPROVED=false
```

네 연결값 중 하나라도 없거나 세 안전 게이트가 정확히 일치하지 않으면 발송은 차단된다.
평상시에는 `WB_ACTUAL_TEST_SEND_APPROVED=false`로 둔다. 원장 본인 1건 테스트를 별도로 승인받은
직후에만 `true`로 바꾸고, 결과 확인 즉시 다시 `false`로 바꾸거나 해당 Secret을 삭제한다.

## 보안 원칙

- 기존 API Key의 Secret을 재생성하지 않는다. 다른 자동화가 중단될 수 있다.
- 업무지시서 Worker 전용 API Key를 새로 만든다.
- API Key, Secret, 발신번호, 수신번호를 GitHub·README·`wrangler.toml`·`.dev.vars`에 기록하지 않는다.
- 모든 민감값은 Cloudflare Worker Secrets에만 등록한다.
- 발신번호는 Solapi에서 `활성화` 상태인 번호만 사용한다.
- 테스트 수신번호는 원장 본인 번호만 사용한다.
- 실제 직원·학부모 발송은 별도의 수신자 원장, 승인 게이트, 발송 로그를 먼저 설계한다.

## 안전한 적용 순서

1. 운영 D1 백업과 마이그레이션 `011` 적용 여부를 확인한다.
2. Solapi 전용 API Key를 만들고 Secret을 즉시 안전하게 보관한다.
3. Solapi 연결값 4개를 Worker Secrets에 등록한다.
4. `WB_SEND_MODE=test`, `WB_TEST_RECIPIENT_ID=TEST-SMS-001`,
   `WB_ACTUAL_TEST_SEND_APPROVED=false`를 Worker Secrets에 등록한다.
5. Worker를 배포하고 `/health`를 확인한다. 이 단계까지는 실제 발송이 차단돼야 한다.
6. 원장 본인 1건 테스트를 명시적으로 승인받은 직후에만
   `WB_ACTUAL_TEST_SEND_APPROVED=true`로 바꾼다.
7. 원장 인증 화면에서 당일 수행보고 1건만 접수한다.
8. Solapi 발송 내역과 원장 휴대전화 수신을 함께 확인한다.
9. 즉시 `WB_ACTUAL_TEST_SEND_APPROVED=false`로 되돌리거나 해당 Secret을 삭제하고,
   추가 발송 시도가 차단되는지 다시 확인한다.
10. 승인 시각, 발송 결과, 게이트 비활성화 시각을 운영 로그에 기록한다.

승인 게이트를 다시 닫을 때는 값을 명령행에 직접 쓰지 말고 Wrangler 입력창에서 `false`를 넣거나,
다음 명령으로 Secret 자체를 삭제한다.

```bash
npx wrangler secret delete WB_ACTUAL_TEST_SEND_APPROVED
```

## 현재 한계

- Solapi 접수 성공은 단말기 배송 완료를 뜻하지 않는다.
- 배송 결과 webhook과 재조회 화면은 아직 없다.
- timeout 또는 응답 불명 상태는 운영자가 Solapi 발송 내역에서 확인해야 한다.
- 직원·학부모·임의 전화번호로 보내는 기능은 제공하지 않는다.
