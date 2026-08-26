'use strict';
/* VAPID 키 생성 (1회) — 밤 9시 물주기 Web Push용.
   실행: node reading-server/gen-vapid.mjs
   출력된 두 값을 워커 시크릿(wrangler secret put …) 또는 로컬 환경변수로 등록한다. */
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log('VAPID_PUBLIC_KEY=' + b64u(raw));
console.log('VAPID_PRIVATE_JWK=' + JSON.stringify(jwk));
console.log('\n등록 (운영 워커):');
console.log('  cd reading-server && npx wrangler secret put VAPID_PUBLIC_KEY && npx wrangler secret put VAPID_PRIVATE_JWK');
console.log('선택: VAPID_SUBJECT (기본 mailto:admin@wb.local)');
