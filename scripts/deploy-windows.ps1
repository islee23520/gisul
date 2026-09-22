[CmdletBinding()]
param(
  [string]$Repository = "https://github.com/islee23520/gisul.git",
  [string]$DeployRoot = "E:\git\gisul",
  [string]$Branch = "main",
  [string]$SkillsPath = "$env:USERPROFILE\.agents\skills",
  [string]$StatePath = "$env:USERPROFILE\.config\gisul-mcp",
  [string]$LogPath = "E:\git\gisul-deploy.log",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-DeployLog([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Write-Output $line
  $parent = Split-Path -Parent $LogPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Add-Content -LiteralPath $LogPath -Value $line
}

function Invoke-Git([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments) {
  & git -C $DeployRoot @Arguments
  if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function Invoke-Compose([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments) {
  & docker compose --project-directory $DeployRoot --file (Join-Path $DeployRoot "compose.yaml") @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker compose $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

foreach ($command in @("git", "docker")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is required" }
}

$lockPath = Join-Path ([System.IO.Path]::GetTempPath()) "gisul-windows-deploy.lock"
$lock = $null
try {
  $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch [System.IO.IOException] {
  Write-DeployLog "status=skipped reason=deployment-already-running"
  exit 0
}

try {
  if (-not (Test-Path (Join-Path $DeployRoot ".git"))) {
    if (Test-Path $DeployRoot) {
      $entries = @(Get-ChildItem -Force -LiteralPath $DeployRoot)
      if ($entries.Count -gt 0) { throw "$DeployRoot exists but is not an empty Git checkout" }
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DeployRoot) | Out-Null
    }
    & git clone --branch $Branch --single-branch $Repository $DeployRoot
    if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE" }
  }

  $origin = (& git -C $DeployRoot remote get-url origin).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Cannot read Git origin" }
  if ($origin -ne $Repository) {
    Invoke-Git -Arguments @("remote", "set-url", "origin", $Repository)
    Write-DeployLog "status=origin-updated origin=$Repository"
  }

  Invoke-Git -Arguments @("fetch", "--prune", "origin", $Branch)
  $target = (& git -C $DeployRoot rev-parse "origin/$Branch").Trim()
  if ($LASTEXITCODE -ne 0 -or $target -notmatch "^[0-9a-f]{40}$") { throw "Cannot resolve origin/$Branch" }
  $current = if (Test-Path (Join-Path $DeployRoot ".git")) { (& git -C $DeployRoot rev-parse HEAD 2>$null) } else { "" }
  $current = "$current".Trim()
  $deployedFile = Join-Path $DeployRoot ".docker\deployed-commit"
  $deployed = if (Test-Path $deployedFile) { (Get-Content -Raw -LiteralPath $deployedFile).Trim() } else { "" }

  if (-not $Force -and $current -eq $target -and $deployed -eq $target) {
    $inspection = @(& docker inspect gisul 2>$null | ConvertFrom-Json)[0]
    if ($LASTEXITCODE -eq 0 -and $inspection.State.Running -and $inspection.State.Health.Status -eq "healthy") {
      Write-DeployLog "status=unchanged commit=$target health=healthy"
      exit 0
    }
  }

  Invoke-Git -Arguments @("checkout", "-B", $Branch, "origin/$Branch")
  Invoke-Git -Arguments @("reset", "--hard", "origin/$Branch")
  Invoke-Git -Arguments @("clean", "-ffd", "-e", ".docker/")

  New-Item -ItemType Directory -Force -Path $SkillsPath, $StatePath, (Split-Path -Parent $deployedFile) | Out-Null
  $env:GISUL_GIT_COMMIT = $target
  $env:GISUL_SKILLS_PATH = $SkillsPath
  $env:GISUL_STATE_PATH = $StatePath

  $previousInspection = @(& docker inspect gisul 2>$null | ConvertFrom-Json)[0]
  $previousImage = if ($LASTEXITCODE -eq 0) { "$($previousInspection.Image)" } else { "" }
  $rollbackTag = "gisul-mcp:rollback"
  if ($previousImage -match "^sha256:[0-9a-f]{64}$") {
    & docker image tag $previousImage $rollbackTag
    if ($LASTEXITCODE -ne 0) { throw "Cannot retain the current image for rollback" }
  }

  Write-DeployLog "status=building commit=$target"
  Invoke-Compose build --pull gisul
  try {
    & docker rm -f gisul 2>$null | Out-Null
    Invoke-Compose up -d --no-build --wait --wait-timeout 90 gisul
  } catch {
    if ($previousImage -match "^sha256:[0-9a-f]{64}$") {
      Write-DeployLog "status=rolling-back commit=$target previousImage=$previousImage"
      & docker image tag $rollbackTag "gisul-mcp:local"
      if ($LASTEXITCODE -eq 0) {
        Invoke-Compose up -d --no-build --wait --wait-timeout 90 gisul
      }
    }
    throw
  }

  $inspection = @(& docker inspect gisul | ConvertFrom-Json)[0]
  $containerCommit = "$($inspection.Config.Labels.'io.gisul.deployed-commit')"
  $health = "$($inspection.State.Health.Status)"
  if ($LASTEXITCODE -ne 0 -or $containerCommit -ne $target -or $health -ne "healthy") {
    throw "Deployed container verification failed: commit=$containerCommit health=$health"
  }

  Set-Content -LiteralPath $deployedFile -Value $target -NoNewline
  & docker image rm $rollbackTag 2>$null | Out-Null
  Write-DeployLog "status=deployed commit=$target health=$health"
} catch {
  Write-DeployLog "status=failed message=$($_.Exception.Message.Replace([Environment]::NewLine, ' '))"
  throw
} finally {
  if ($lock) { $lock.Dispose() }
}
