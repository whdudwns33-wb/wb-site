$ErrorActionPreference = 'Stop'
if (!$IsWindows -or ![Environment]::Is64BitProcess) { throw 'Run this check with 64-bit PowerShell 7 on Windows.' }
$probeRoot = Join-Path ([IO.Path]::GetTempPath()) ('wb-host-test-' + [guid]::NewGuid().ToString('N'))
$taskName = 'WB_Workbench_JobProbe_' + [guid]::NewGuid().ToString('N')
$created = $false
$probeChild = $null
$launcher = $null
$pwsh = Join-Path $PSHOME 'pwsh.exe'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'start-host.ps1') -Raw
function Assert-Probe($condition, $message) { if (!$condition) { throw $message } }
try {
    [void](New-Item -ItemType Directory -Path (Join-Path $probeRoot 'logs'))
    $script = Join-Path $probeRoot 'start.ps1'
    $fixture = Join-Path $probeRoot 'serve.mjs'
    $pidFile = Join-Path $probeRoot 'probe.pid'
    Set-Content -LiteralPath $script -Value $source -Encoding utf8NoBOM
    $sleepChild = "import fs from 'node:fs';fs.writeFileSync('probe.pid',String(process.pid));setInterval(()=>{},1000);"
    Set-Content -LiteralPath $fixture -Value $sleepChild -Encoding utf8NoBOM
    $argsText = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $script + '" -Component server'
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $argsText
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    $created = $true
    Start-ScheduledTask -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (!(Test-Path -LiteralPath $pidFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    Assert-Probe (Test-Path -LiteralPath $pidFile) 'Synthetic child did not start.'
    $probeChild = Get-Process -Id ([int](Get-Content -LiteralPath $pidFile -Raw))
    $null = $probeChild.Handle
    Start-Sleep -Milliseconds 500
    Assert-Probe (!$probeChild.HasExited) 'Synthetic child exited before task-stop test.'
    Stop-ScheduledTask -TaskName $taskName
    Assert-Probe ($probeChild.WaitForExit(5000)) 'Stopping the temporary task left its child running.'
    Write-Output 'PASS: stopping the temporary scheduled task terminates its child.'

    Set-Content -LiteralPath $fixture -Value 'setTimeout(()=>process.exit(7),500);' -Encoding utf8NoBOM
    $launcher = Start-Process -FilePath $pwsh -ArgumentList $argsText -WindowStyle Hidden -PassThru
    Assert-Probe ($launcher.WaitForExit(20000)) 'Exit-code probe timed out.'
    Assert-Probe ($launcher.ExitCode -eq 7) 'Child exit code was not propagated.'
    $launcher.Dispose(); $launcher = $null
    Write-Output 'PASS: child exit code 7 is propagated.'

    Remove-Item -LiteralPath $pidFile
    Set-Content -LiteralPath $fixture -Value $sleepChild -Encoding utf8NoBOM
    $invalidJob = $source.Replace('[WorkbenchChildJob]::Assign($job, $child.Handle)', 'Start-Sleep -Milliseconds 500; [WorkbenchChildJob]::Assign([IntPtr]::Zero, $child.Handle)')
    Assert-Probe ($invalidJob -ne $source) 'Assignment-failure injection point missing.'
    Set-Content -LiteralPath $script -Value $invalidJob -Encoding utf8NoBOM
    $launcher = Start-Process -FilePath $pwsh -ArgumentList $argsText -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $probeRoot 'expected-error.log')
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (!(Test-Path -LiteralPath $pidFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    Assert-Probe (Test-Path -LiteralPath $pidFile) 'Assignment-failure child did not start.'
    $probeChild.Dispose()
    $probeChild = Get-Process -Id ([int](Get-Content -LiteralPath $pidFile -Raw))
    $null = $probeChild.Handle
    Assert-Probe ($launcher.WaitForExit(20000)) 'Assignment-failure probe timed out.'
    Assert-Probe ($launcher.ExitCode -ne 0) 'Assignment failure was reported as success.'
    Assert-Probe ($probeChild.WaitForExit(5000)) 'Assignment failure left its child running.'
    Write-Output 'PASS: assignment failure terminates the child and fails the launcher.'
} finally {
    if ($created) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    foreach ($owned in @($launcher, $probeChild)) {
        if ($owned) {
            if (!$owned.HasExited) { $owned.Kill($true); $owned.WaitForExit() }
            $owned.Dispose()
        }
    }
    $absolute = [IO.Path]::GetFullPath($probeRoot)
    Assert-Probe (([IO.Path]::GetDirectoryName($absolute) -eq [IO.Path]::GetTempPath().TrimEnd('\')) -and ([IO.Path]::GetFileName($absolute).StartsWith('wb-host-test-'))) 'Unexpected cleanup path.'
    if (Test-Path -LiteralPath $absolute) { Remove-Item -LiteralPath $absolute -Recurse -Force }
}
