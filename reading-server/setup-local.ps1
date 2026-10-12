param(
    [string]$HostAddress = '127.0.0.1',
    [string]$InhouseNetworks = '',
    [string]$DataDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WB\naesin-server')
)
$ErrorActionPreference = 'Stop'

function Protect-LocalPath($Path, $Directory) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
        $acl.RemoveAccessRuleSpecific($rule)
    }
    $inherit = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, 'S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier ([string]$sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule ($identity, 'FullControl', $inherit, 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Write-SetupStatus($State, $Stage, $ErrorType = '') {
    $script:setupStage = $Stage
    if (!$script:setupStatusReady) { return }
    @{ state = $State; stage = $Stage; pid = $PID; errorType = $ErrorType } |
        ConvertTo-Json | Set-Content -LiteralPath $script:setupStatusPath -Encoding UTF8
}

$setupStage = 'validate'
$setupStatusReady = $false
$setupStatusPath = $null
try {
$DataDir = [IO.Path]::GetFullPath($DataDir)
if ((Split-Path $DataDir -Leaf) -ne 'naesin-server') { throw 'Use an app-specific naesin-server data directory; shared folders cannot have their ACL replaced.' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($DataDir -eq $repository -or $DataDir.StartsWith($repository + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Server data and credentials must stay outside the repository.'
}
$settingsPath = Join-Path $DataDir 'settings.json'
$localSettings = @{ Host = $HostAddress; Port = 8890; InhouseNetworks = $InhouseNetworks }
if (Test-Path -LiteralPath $settingsPath) {
    $saved = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if ($saved.Port -ne 8890 -or !($saved.Host -is [string]) -or !($saved.InhouseNetworks -is [string])) { throw 'Existing local settings are invalid; they were not overwritten.' }
    if (!$PSBoundParameters.ContainsKey('HostAddress')) { $localSettings.Host = $saved.Host }
    if (!$PSBoundParameters.ContainsKey('InhouseNetworks')) { $localSettings.InhouseNetworks = $saved.InhouseNetworks }
}
$ip = $null
if (![Net.IPAddress]::TryParse($localSettings.Host, [ref]$ip) -or $ip.ToString() -ne $localSettings.Host) { throw 'HostAddress must be an exact IP address.' }
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$accessModule = ([Uri](Join-Path $PSScriptRoot 'inhouse-access.mjs')).AbsoluteUri
& $node --input-type=module -e 'const {createInhouseAccess}=await import(process.argv[1]);createInhouseAccess(process.argv[2]);' $accessModule $localSettings.InhouseNetworks
if ($LASTEXITCODE -ne 0) { throw 'Local network settings failed the server access check.' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$launcher = Join-Path $PSScriptRoot 'start-local.ps1'
$powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
if ($launcher -match '[%"\r\n]' -or $DataDir -match '[%"\r\n]') { throw 'Unsafe scheduled task path.' }
$taskArguments = '-NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "{0}" -DataDir "{1}"' -f $launcher, $DataDir
$existing = Get-ScheduledTask -TaskPath '\' -TaskName 'WB Naesin Local Server' -ErrorAction SilentlyContinue
if ($existing -and (@($existing.Actions).Count -ne 1 -or $existing.Actions[0].Execute -ne $powershell -or $existing.Actions[0].Arguments -ne $taskArguments -or $existing.Actions[0].WorkingDirectory -ne $PSScriptRoot)) {
    throw 'A different service uses this task name. It was not replaced.'
}
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$setupStatusPath = Join-Path $DataDir 'latest-setup-status.json'
$setupStatusReady = $true
Write-SetupStatus 'working' 'security-commands'
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
Write-SetupStatus 'working' 'protect-data-dir'
Protect-LocalPath $DataDir $true
$credentialPath = Join-Path $DataDir 'admin.credential.xml'
if (!(Test-Path -LiteralPath $credentialPath)) {
    Write-SetupStatus 'waiting-admin' 'get-admin-credential'
    $credential = Get-Credential -Message 'Create the local Naesin administrator login. Values stay on this PC.'
    if (!$credential -or !$credential.UserName -or $credential.Password.Length -lt 12) { throw 'An administrator login with a password of at least 12 characters is required.' }
    Write-SetupStatus 'working' 'write-admin-credential'
    $credential | Export-Clixml -LiteralPath $credentialPath
    $credential.Password.Dispose()
}
Write-SetupStatus 'working' 'protect-admin-credential'
Protect-LocalPath $credentialPath $false
Write-SetupStatus 'working' 'write-settings'
$localSettings | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
Protect-LocalPath $settingsPath $false
Write-SetupStatus 'working' 'register-task'
$action = New-ScheduledTaskAction -Execute $powershell -Argument $taskArguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
# This registers only the new app task; it neither starts it nor changes other app tasks.
Register-ScheduledTask -TaskName 'WB Naesin Local Server' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-SetupStatus 'complete' 'complete'
Write-Host 'Local setup complete. The server will start after this user signs in, or run start-local.ps1 manually.'
} catch {
    $errorType = $_.Exception.GetType().FullName
    try { Write-SetupStatus 'failed' $setupStage $errorType } catch {}
    throw "Local setup failed at $setupStage ($errorType)."
}
