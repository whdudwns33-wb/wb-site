// 브라우저 왕복 상태 쿠키로 다른 브라우저에서 만든 로그인 링크 주입을 막는다.
export const handoffCookie=(nonce='',production=true)=>`${production?'__Host-':''}wb_blended_handoff=${nonce}; Path=/; ${production?'Secure; ':''}HttpOnly; SameSite=Strict; Max-Age=${nonce?90:0}`;
export const handoffNonce=(cookies='',production=true)=>new RegExp('(?:^|;\\s*)'+(production?'__Host-':'')+'wb_blended_handoff=([a-f0-9]{64})(?:;|$)').exec(cookies)?.[1] || '';
export function startHandoff(url,academyOrigin,production=true) {
 const sid=url.searchParams.get('academyStudent');
 if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(sid || ''))return null;
 const nonce=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
 return {location:academyOrigin+'/ops/students/'+encodeURIComponent(sid)+'?tab=planner&plannerState='+nonce,cookie:handoffCookie(nonce,production)};
}
