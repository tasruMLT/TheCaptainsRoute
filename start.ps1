# Starts Harbour Run on a local web server and opens it in the browser.
# Usage: right-click > Run with PowerShell, or from a terminal:  .\start.ps1
#        .\start.ps1 -Port 9000

param(
    [int]$Port = 8080
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$url = "http://localhost:$Port/index.html"

# Pick a server: Python first (no install needed on most PCs), then Node.
$python = Get-Command python -ErrorAction SilentlyContinue
$node = Get-Command node -ErrorAction SilentlyContinue

if ($python) {
    Write-Host "Starting server with Python on port $Port ..." -ForegroundColor Cyan
    $serverArgs = @("-m", "http.server", "$Port", "--bind", "127.0.0.1")
    $server = Start-Process -FilePath $python.Source -ArgumentList $serverArgs -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Minimized
}
elseif ($node) {
    Write-Host "Python not found. Starting server with Node on port $Port ..." -ForegroundColor Cyan
    $server = Start-Process -FilePath $node.Source -ArgumentList @("serve.js", "$Port") -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Minimized
}
else {
    Write-Host "Neither Python nor Node.js was found. Install one of them first (see HOW_TO_LAUNCH.md)." -ForegroundColor Red
    exit 1
}

# Give the server a moment to bind the port before opening the browser.
Start-Sleep -Seconds 2
if ($server.HasExited) {
    Write-Host "The server stopped right away. Port $Port may already be in use. Try: .\start.ps1 -Port 9000" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Harbour Run is running at $url" -ForegroundColor Green
Write-Host "Press Enter in this window to stop the server." -ForegroundColor Yellow
Start-Process $url

[void](Read-Host)

if (-not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
}
Write-Host "Server stopped."
