/* Windows 관리자 기동: 자체 시험 자격증명, 임시 데이터, 실제 HTTP만 사용한다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('SKIP — Windows 관리자 기동 검사');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-admin-start-'));
  const credential = path.join(tmp, 'test.credential.xml');
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'start-admin.ps1');
  const port = 35000 + process.pid % 10000;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "$p=ConvertTo-SecureString 'synthetic-admin-test-password' -AsPlainText -Force; [Management.Automation.PSCredential]::new('synthetic-admin-test',$p) | Export-Clixml -LiteralPath $env:WB_TEST_CREDENTIAL"],
  { env: { ...env, WB_TEST_CREDENTIAL: credential }, windowsHide: true, stdio: 'ignore' });
  const server = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', entry,
    '-DataDir', tmp, '-CredentialPath', credential, '-Port', String(port)], { env, windowsHide: true, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  try {
    let ready = false;
    for (let i = 0; i < 100; i += 1) {
      try { ready = (await fetch(base + '/api/health')).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, '관리 서버가 기동되지 않았다');
    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'synthetic-admin-test', password: 'synthetic-admin-test-password' }) });
    assert.equal(login.status, 200, '저장된 Windows 자격증명으로 로그인한다');
    assert.ok((await login.json()).token);
    assert.equal((await fetch(base + '/api/login/status?nonce=test')).status, 403);
    assert.equal((await fetch(base + '/admin/naesin-ko-admin.html')).status, 200);
    for (const file of ['server.log', 'server-error.log']) {
      const log = fs.readFileSync(path.join(tmp, 'logs', file), 'utf8');
      assert.ok(!log.includes('synthetic-admin-test-password'), '로그에 암호가 기록됐다');
    }
    console.log('OK — Windows 기동·기존 자격증명·관리전용·로그 암호 미노출');
  } finally {
    execFileSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tmp).startsWith('wb-admin-start-'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
