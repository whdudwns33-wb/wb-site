param(
    [string]$DataDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WB\naesin-server')
)
$ErrorActionPreference = 'Stop'
# Invoke with -ExecutionPolicy RemoteSigned for this process; Windows and organization policies stay unchanged.

try {
    $DataDir = [IO.Path]::GetFullPath($DataDir)
    if ((Split-Path $DataDir -Leaf) -ne 'naesin-server') { throw 'Use an app-specific naesin-server data directory.' }
    $credential = Import-Clixml -LiteralPath (Join-Path $DataDir 'admin.credential.xml')
    if ($credential -isnot [System.Management.Automation.PSCredential] -or !$credential.UserName -or !$credential.Password.Length) {
        throw 'A local administrator credential is required. Run setup-local.ps1 on this PC.'
    }
    $settings = Get-Content -LiteralPath (Join-Path $DataDir 'settings.json') -Raw | ConvertFrom-Json
    if ($settings.Port -ne 8890 -or !($settings.Host -is [string]) -or !$settings.Host -or !($settings.InhouseNetworks -is [string])) {
        throw 'Local server settings are invalid.'
    }
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $server = Join-Path $PSScriptRoot 'server.mjs'
    $logs = Join-Path $DataDir 'logs'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    Get-ChildItem -LiteralPath $logs -File -Filter '*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $logs ($stamp + '-stdout.log')
    $stderr = Join-Path $logs ($stamp + '-stderr.log')
    foreach ($file in @($node, $server, $stdout, $stderr)) {
        if (![IO.Path]::IsPathRooted($file) -or $file -match '[%"\r\n]') { throw 'Unsafe local execution path.' }
    }
    if (!(Test-Path -LiteralPath $server -PathType Leaf)) { throw 'The local server entry point is missing.' }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $env:ComSpec
    $start.Arguments = '/d /q /v:off /s /c ""{0}" "{1}" 1>>"{2}" 2>>"{3}""' -f $node, $server, $stdout, $stderr
    $start.WorkingDirectory = $PSScriptRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.EnvironmentVariables['ADMIN_ID'] = $credential.UserName
    $start.EnvironmentVariables['ADMIN_PASSWORD'] = $credential.GetNetworkCredential().Password
    $start.EnvironmentVariables.Remove('ADMIN_PIN')
    $start.EnvironmentVariables['PORT'] = '8890'
    $start.EnvironmentVariables['HOST'] = $settings.Host
    $start.EnvironmentVariables['DATA_DIR'] = $DataDir
    $start.EnvironmentVariables['WB_ADMIN_ONLY'] = '0'
    $start.EnvironmentVariables['WB_INHOUSE_ONLY'] = '1'
    $start.EnvironmentVariables['WB_INHOUSE_NETWORKS'] = $settings.InhouseNetworks
    $process = [Diagnostics.Process]::Start($start)
    $start.EnvironmentVariables.Remove('ADMIN_PASSWORD')
    $credential.Password.Dispose()
    # shortcut: logs are pruned at startup; add size rotation if a long-lived process produces large logs.
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $process.Dispose()
    exit $exitCode
} catch {
    # Credential and settings values never enter the error log.
    [Console]::Error.WriteLine('Local server startup failed. Check local credentials, settings, file permissions and the server logs.')
    exit 1
}
