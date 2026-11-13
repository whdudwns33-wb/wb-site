'use strict';
/* 두 런처의 실제 Node 선택식만 실행한다. 자격증명·ACL·예약 작업에는 접근하지 않는다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = ['setup-local.ps1', 'start-local.ps1'].map(name => path.join(dir, name));
for (const file of files) assert.match(fs.readFileSync(file, 'utf8'), /Get-Command node\.exe[^\r\n]*\| Select-Object -First 1\)\.Source/);
if (process.platform === 'win32') {
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
  $native=@(Get-Command node.exe -CommandType Application -ErrorAction Stop)
  $expressions=@()
  foreach($file in @(${files.map(file => "'" + file.replace(/'/g, "''") + "'").join(',')})) {
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'PowerShell launcher parse failed.'}
    $assignments=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left -is [Management.Automation.Language.VariableExpressionAst] -and $n.Left.VariablePath.UserPath -eq 'node'},$true))
    if($assignments.Count -ne 1){throw 'Each launcher needs one Node selection.'}
    $expression=$assignments[0].Extent.Text;$expressions+=$expression
    . ([ScriptBlock]::Create($expression))
    if($node -isnot [string] -or $node -ne $native[0].Source){throw 'Native PATH did not choose its first executable.'}
  }
  function Get-Command {param($Name,$CommandType,$ErrorAction) [pscustomobject]@{Source='C:\\first\\node.exe'};[pscustomobject]@{Source='C:\\second\\node.exe'}}
  foreach($expression in $expressions){. ([ScriptBlock]::Create($expression));if($node -isnot [string] -or $node -ne 'C:\\first\\node.exe'){throw 'Duplicate PATH regression.'}}
  [pscustomobject]@{Launchers=$expressions.Count;NativeCandidates=$native.Count;SyntheticCandidates=2}|ConvertTo-Json -Compress`;
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = JSON.parse(execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' }));
  assert.equal(result.Launchers, 2);
  console.log(`OK — Windows PowerShell 5.1: 런처 2개, native 후보 ${result.NativeCandidates}개·synthetic 후보 2개 모두 첫 Node 선택`);
} else console.log('OK — 런처 2개 Node 선택식 확인; 실제 PowerShell 검사는 Windows에서 실행');
