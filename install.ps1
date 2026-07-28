# Gentle-ai-mod installer (Windows PowerShell)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "node is required on PATH (Node 18+)"
  exit 1
}
& node (Join-Path $Root "install.mjs") @args
exit $LASTEXITCODE
