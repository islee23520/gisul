[CmdletBinding()]
param(
  [string]$DeployRoot = "E:\git\gisul",
  [string]$TaskName = "Gisul Git Main Auto Deploy",
  [string]$Repository = "https://github.com/islee23520/gisul.git",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptPath = Join-Path $DeployRoot "scripts\deploy-windows.ps1"
if (-not (Test-Path $scriptPath)) { throw "Deployment script is missing: $scriptPath" }

$arguments = @(
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy", "Bypass",
  "-File", ('"{0}"' -f $scriptPath),
  "-DeployRoot", ('"{0}"' -f $DeployRoot),
  "-Repository", ('"{0}"' -f $Repository),
  "-Branch", $Branch
) -join " "

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Fetch Gisul main from GitHub and rebuild Docker when the commit changes." -Force | Out-Null
Write-Output "Installed scheduled task '$TaskName' for $Repository#$Branch using $scriptPath"
