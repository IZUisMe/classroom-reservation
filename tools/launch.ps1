param(
  [ValidateSet('admin', 'publish', 'app')][string]$Mode = 'admin',
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$projectRoot = Split-Path -Parent $PSScriptRoot
$messages = $null
try {
  $messages = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'launcher-ja.json') -Encoding UTF8 -Raw | ConvertFrom-Json
  $bundledNode = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $bundledNode) { $nodePath = $bundledNode }
  else { $nodePath = (Get-Command node -ErrorAction Stop).Source }
  if ($Check) {
    [pscustomobject]@{ mode = $Mode; node = $nodePath; root = $projectRoot; persistentWindow = $true } | ConvertTo-Json -Compress
    return
  }
  Push-Location -LiteralPath $projectRoot
  try {
    Write-Host ('Node: ' + (& $nodePath --version))
    if ($Mode -eq 'admin') {
      Write-Host $messages.adminStart -ForegroundColor Cyan
      & $nodePath (Join-Path $PSScriptRoot 'launch-admin.mjs')
    } elseif ($Mode -eq 'app') {
      Write-Host $messages.appStart -ForegroundColor Cyan
      & $nodePath (Join-Path $PSScriptRoot 'serve.mjs')
    } else {
      Write-Host $messages.publishStart -ForegroundColor Cyan
      $answer = Read-Host $messages.confirmPublish
      if ($answer -notmatch '^[Yy]$') {
        Write-Host $messages.cancelled
        return
      }
      & $nodePath (Join-Path $PSScriptRoot 'publish.mjs')
    }
    if ($LASTEXITCODE -ne 0) { throw ($messages.processingExit + $LASTEXITCODE) }
    Write-Host $messages.finished -ForegroundColor Green
  } finally { Pop-Location }
} catch {
  $message = $_.Exception.Message
  if ($messages) {
    Write-Host ($messages.failed + $message) -ForegroundColor Red
    Write-Host $messages.preserved -ForegroundColor Yellow
  } else { Write-Host ('Launcher failed: ' + $message) -ForegroundColor Red }
  try {
    $logDirectory = Join-Path $projectRoot '.build-temp'
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    Add-Content -LiteralPath (Join-Path $logDirectory 'launcher-error.log') -Encoding UTF8 -Value ((Get-Date -Format o) + ' [' + $Mode + '] ' + $message)
  } catch { }
}
