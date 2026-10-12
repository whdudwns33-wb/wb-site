/* 실행기(run-server.mjs)가 사라지면 서버도 같이 끝난다 — 서버 자식 프로세스에 --import 로 미리 싣는다.

   Windows 는 부모를 죽여도 자식이 남는다. 작업 스케줄러가 실행기를 끝내거나(작업 끝내기) 실행기가
   비정상 종료되면 서버만 고아로 남아 포트를 잡고 있고, 다음에 뜬 실행기의 서버는 EADDRINUSE 로
   계속 죽는다 — 화면이 없는 PC 라 아무도 모른다. 부모와 이어 둔 IPC 통로가 끊기면('disconnect')
   스스로 끝나게 해서 그 상태를 없앤다. 통로가 없으면(사람이 server.mjs 를 직접 띄운 경우) 아무것도 안 한다. */
if (typeof process.send === 'function') {
  process.on('disconnect', () => process.exit(0));
  /* 통로가 서버를 붙잡아 두지 않게 — 서버가 할 일을 다 하면 통로 때문에 안 끝나는 일이 없게 */
  if (process.channel && typeof process.channel.unref === 'function') process.channel.unref();
}
