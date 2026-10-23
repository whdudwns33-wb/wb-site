import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

function dpapi(value, mode) {
  const command = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::" + mode + "($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))";
  const result = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {input: value.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 20000});
  if (result.status !== 0 || !result.stdout.trim()) throw Error('Windows protected key storage is unavailable.');
  return Buffer.from(result.stdout.trim(), 'base64');
}
export const protectAppKey = key => { if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('Invalid application key.'); return dpapi(key, 'Protect'); };
export function loadProtectedAppKey(file) {
  const key = dpapi(readFileSync(file), 'Unprotect');
  if (key.length !== 32) throw Error('Invalid protected application key.');
  return key;
}
