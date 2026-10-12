'use strict';
/* native 명령 존재를 먼저 확인하고 ACL/상태 함수는 메모리 spy로만 실행한다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup-local.ps1');
const code = fs.readFileSync(source, 'utf8');
assert.ok(code.indexOf('$setupStatusReady = $true') > code.indexOf('New-Item -ItemType Directory -Path $DataDir -Force'));
assert.ok(code.indexOf("Write-SetupStatus 'waiting-admin' 'get-admin-credential'") < code.indexOf('$credential = Get-Credential'));
assert.match(code, /Write-SetupStatus 'complete' 'complete'/);
assert.match(code, /Write-SetupStatus 'failed' \$setupStage \$errorType/);
assert.ok(code.indexOf("Write-SetupStatus 'working' 'security-commands'") > code.indexOf('$setupStatusReady = $true'));
assert.ok(code.indexOf("Write-SetupStatus 'working' 'security-commands'") < code.indexOf('Import-Module -Name'));
if (process.platform !== 'win32') {
  assert.match(code, /\$acl = Get-Acl -LiteralPath \$Path/);
  assert.match(code, /Import-Module -Name \(Join-Path \$PSHOME 'Modules\\Microsoft\.PowerShell\.Security\\Microsoft\.PowerShell\.Security\.psd1'\)/);
  console.log('OK — ACL·상태 기록 소스 경로 확인; 실제 PowerShell 검사는 Windows에서 실행');
} else {
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile('${source.replace(/'/g, "''")}',[ref]$tokens,[ref]$errors)
  if($errors.Count){throw 'Setup parse failed.'}
  $beforeMissing=0
  foreach($name in @('Get-Acl','Set-Acl','Get-Credential')){try{Get-Command -Name $name -CommandType Cmdlet -ErrorAction Stop|Out-Null}catch{$beforeMissing++}}
  $imports=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Import-Module'},$true))
  if($imports.Count -ne 1){throw 'One native security module import is required.'}
  . ([ScriptBlock]::Create($imports[0].Extent.Text))
  $native=Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'
  $nativeCommands=0
  foreach($name in @('Get-Acl','Set-Acl','Get-Credential')){
    $command=Get-Command -Name $name -CommandType Cmdlet -ErrorAction Stop
    if($command.Module.Path -ne $native){throw 'A security command came from another PowerShell runtime.'}
    $nativeCommands++
  }
  $functions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Protect-LocalPath'},$true))
  if($functions.Count -ne 1){throw 'One ACL protection function is required.'}
  . ([ScriptBlock]::Create($functions[0].Extent.Text))
  function Get-Acl {param($LiteralPath) $script:ReadCount++;return $script:Fixture}
  function Set-Acl {param($LiteralPath,$AclObject) $script:WriteCount++;$script:Written=$AclObject;$script:WrittenPath=$LiteralPath}
  $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $group=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'
  $identityType=[Security.Principal.SecurityIdentifier]
  $expected=@($owner.Value,'S-1-5-18','S-1-5-32-544')|Sort-Object
  $cases=0
  foreach($directory in @($true,$false)) {
    $script:Fixture=if($directory){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}
    $script:Fixture.SetOwner($owner);$script:Fixture.SetGroup($group)
    $script:Fixture.SetSecurityDescriptorSddlForm('D:AI(A;;FA;;;WD)(A;ID;FR;;;WD)',[Security.AccessControl.AccessControlSections]::Access)
    if(@($script:Fixture.GetAccessRules($false,$true,$identityType)).Count -ne 1){throw 'The fixture needs an inherited unsafe rule.'}
    $script:ReadCount=0;$script:WriteCount=0;$script:Written=$null
    $target=if($directory){'in-memory-directory'}else{'in-memory-file'}
    Protect-LocalPath $target $directory
    $written=$script:Written
    if(!$written -or $written.GetOwner($identityType).Value -ne $owner.Value -or $written.GetGroup($identityType).Value -ne $group.Value){throw 'Owner/group were lost by ACL protection.'}
    if($script:ReadCount -ne 1 -or $script:WriteCount -ne 1 -or $script:WrittenPath -ne $target){throw 'Each target must read and persist its own descriptor once.'}
    if(!$written.AreAccessRulesProtected){throw 'ACL inheritance was not disabled.'}
    $rules=@($written.GetAccessRules($true,$true,$identityType))
    $ids=@($rules|ForEach-Object{$_.IdentityReference.Value}|Sort-Object)
    if($rules.Count -ne 3 -or ($ids -join ',') -ne ($expected -join ',')){throw 'The ACL must contain only the current user, SYSTEM and Administrators.'}
    $inherit=if($directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
    foreach($rule in $rules){
      if($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){throw 'ACL rights or directory/file inheritance flags differ.'}
    }
    $cases++
  }
  $statusFunctions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Write-SetupStatus'},$true))
  if($statusFunctions.Count -ne 1){throw 'One setup status function is required.'}
  . ([ScriptBlock]::Create($statusFunctions[0].Extent.Text))
  function Set-Content {
    param([Parameter(ValueFromPipeline=$true)]$Value,$LiteralPath,$Encoding)
    process{$script:StatusWrites++;$script:Status=$Value|ConvertFrom-Json;$script:StatusPath=$LiteralPath}
  }
  $script:setupStatusReady=$false;$script:setupStatusPath='in-memory-status';$script:StatusWrites=0
  Write-SetupStatus 'working' 'validate'
  if($script:StatusWrites -ne 0){throw 'Status must not be written before guarded directory creation.'}
  $script:setupStatusReady=$true
  foreach($state in @('working','waiting-admin','complete','failed')) {
    Write-SetupStatus $state 'synthetic-stage' 'SyntheticErrorType'
    $keys=@($script:Status.PSObject.Properties.Name|Sort-Object)
    if(($keys -join ',') -ne 'errorType,pid,stage,state' -or $script:Status.state -ne $state -or $script:Status.stage -ne 'synthetic-stage' -or $script:Status.pid -ne $PID -or $script:Status.errorType -ne 'SyntheticErrorType' -or $script:StatusPath -ne $script:setupStatusPath){throw 'Status must contain only state, stage, this process id and error type.'}
  }
  [pscustomobject]@{NativeCommands=$nativeCommands;BeforeImportMissing=$beforeMissing;Cases=$cases;StatusCases=$script:StatusWrites;ActualAclWrites=0;PowerShellMajor=$PSVersionTable.PSVersion.Major}|ConvertTo-Json -Compress`;
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = JSON.parse(execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true }));
  assert.equal(result.Cases, 2);
  assert.equal(result.PowerShellMajor, 5);
  assert.equal(result.NativeCommands, 3);
  assert.equal(result.ActualAclWrites, 0);
  assert.equal(result.StatusCases, 4);
  console.log(`OK — 부모 환경 상속 Windows PowerShell 5.1: native 명령 3개(import 전 누락 ${result.BeforeImportMissing}개), ACL 2건·상태 4건, 실제 ACL/자격증명 호출·상태 파일 쓰기 0`);
}
