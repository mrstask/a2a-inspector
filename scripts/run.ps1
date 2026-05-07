# Script to run A2A Inspector frontend and backend simultaneously on Windows.
# Both processes are tracked and stopped when the script exits or Ctrl+C is pressed.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$frontendDir = Join-Path $root 'frontend'
$backendDir = Join-Path $root 'backend'

if (-not (Test-Path $frontendDir)) {
    Write-Host "Error: $frontendDir not found!" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $backendDir)) {
    Write-Host "Error: $backendDir not found!" -ForegroundColor Red
    exit 1
}

$script:frontend = $null
$script:backend = $null

function Stop-All {
    Write-Host "`nShutting down A2A Inspector..." -ForegroundColor Yellow
    foreach ($p in @($script:frontend, $script:backend)) {
        if ($p -and -not $p.HasExited) {
            try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    Write-Host "A2A Inspector stopped." -ForegroundColor Green
}

try {
    Write-Host "Starting A2A Inspector..." -ForegroundColor Green

    Write-Host "Starting frontend build (watch mode)..." -ForegroundColor Blue
    $script:frontend = Start-Process -FilePath 'npm.cmd' `
        -ArgumentList 'run', 'build', '--', '--watch=forever' `
        -WorkingDirectory $frontendDir -NoNewWindow -PassThru

    Start-Sleep -Seconds 2

    Write-Host "Starting backend server..." -ForegroundColor Blue
    $script:backend = Start-Process -FilePath 'uv' `
        -ArgumentList 'run', 'app.py' `
        -WorkingDirectory $backendDir -NoNewWindow -PassThru

    Write-Host "A2A Inspector is running!" -ForegroundColor Green
    Write-Host "Open http://127.0.0.1:5001 in your browser" -ForegroundColor Green
    Write-Host "(The frontend has no separate port — assets are built into .\frontend\public and served by the backend on 5001.)" -ForegroundColor Yellow
    Write-Host "Frontend build PID: $($script:frontend.Id)" -ForegroundColor Yellow
    Write-Host "Backend server PID: $($script:backend.Id) (listening on 127.0.0.1:5001)" -ForegroundColor Yellow
    Write-Host "Press Ctrl+C to stop both services." -ForegroundColor Yellow

    while ($true) {
        if ($script:frontend.HasExited) {
            Write-Host "Frontend process died unexpectedly!" -ForegroundColor Red
            break
        }
        if ($script:backend.HasExited) {
            Write-Host "Backend process died unexpectedly!" -ForegroundColor Red
            break
        }
        Start-Sleep -Seconds 1
    }
}
finally {
    Stop-All
}
