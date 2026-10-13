param(
    [string]$DataDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WB\korean-admin-server'),
    [string]$CredentialPath = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WB\naesin-server\admin.credential.xml'),
    [ValidateRange(1024,65535)][int]$Port = 8891
)
$ErrorActionPreference = 'Stop'
$credential = Import-Clixml -LiteralPath $CredentialPath
if ($credential -isnot [Management.Automation.PSCredential]) { throw 'The saved admin credential is invalid.' }
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$server = Join-Path $PSScriptRoot 'server.mjs'
$DataDir = [IO.Path]::GetFullPath($DataDir)
$logs = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$stdout = Join-Path $logs 'server.log'
$stderr = Join-Path $logs 'server-error.log'
foreach ($file in @($node, $server, $stdout, $stderr)) {
    if (![IO.Path]::IsPathRooted($file) -or $file -match '[%"\r\n]') { throw 'Unsafe local execution path.' }
}
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $env:ComSpec
$start.Arguments = '/d /q /v:off /s /c ""{0}" "{1}" 1>>"{2}" 2>>"{3}""' -f $node, $server, $stdout, $stderr
$start.WorkingDirectory = $PSScriptRoot
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.EnvironmentVariables['ADMIN_ID'] = $credential.UserName
$start.EnvironmentVariables['ADMIN_PASSWORD'] = $credential.GetNetworkCredential().Password
$start.EnvironmentVariables.Remove('ADMIN_PIN')
$start.EnvironmentVariables['WB_ADMIN_ONLY'] = '1'
$start.EnvironmentVariables['HOST'] = '127.0.0.1'
$start.EnvironmentVariables['PORT'] = [string]$Port
$start.EnvironmentVariables['DATA_DIR'] = $DataDir
$process = [Diagnostics.Process]::Start($start)
$start.EnvironmentVariables.Remove('ADMIN_PASSWORD')
$credential = $null
$process.WaitForExit()
$exitCode = $process.ExitCode
$process.Dispose()
exit $exitCode
