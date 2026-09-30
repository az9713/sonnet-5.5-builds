# Build the wallpaper host, install it under %LOCALAPPDATA%\Programs with its own copy of
# the scenes, and start it now and at every sign-in.
#
#   powershell -ExecutionPolicy Bypass -File windows\install.ps1
#   npm run wallpaper
param(
    [switch]$NoAutostart,   # do not add the sign-in entry
    [switch]$NoStart        # install, but do not launch
)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Split-Path -Parent $here
$dest = Join-Path $env:LOCALAPPDATA 'Programs\Deskworlds'
$exe = Join-Path $dest 'Deskworlds.exe'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error "The .NET SDK is missing. Install version 8 or newer: winget install Microsoft.DotNet.SDK.8"
}
$major = [int]((& dotnet --version).Split('.')[0])
if ($major -lt 8) { Write-Error "The .NET SDK is too old ($major). Install version 8 or newer." }

# The wallpaper draws inside the Edge WebView2 runtime, which ships with Windows 11 and
# current Windows 10. Warn rather than fail: the installer for it is small and separate.
$webview = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
           'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
           'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
if (-not ($webview | Where-Object { Test-Path $_ })) {
    Write-Warning "The Microsoft Edge WebView2 Runtime was not found. Get it from https://developer.microsoft.com/microsoft-edge/webview2/"
}

$rid = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$build = Join-Path ([IO.Path]::GetTempPath()) ("deskworlds-" + [Guid]::NewGuid().ToString('N'))
try {
    # Built for this machine's architecture and self-contained: no separate .NET install needed to run it.
    & dotnet publish (Join-Path $here 'Deskworlds\Deskworlds.csproj') -c Release -r $rid --self-contained true -o $build --nologo
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

    Get-Process Deskworlds -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500

    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Path $dest | Out-Null
    Copy-Item (Join-Path $build '*') $dest -Recurse -Force

    # Scenes, minus their tests. robocopy exit codes below 8 mean success.
    $scene = Join-Path $dest 'scene'
    robocopy (Join-Path $project 'scenes') (Join-Path $scene 'scenes') /E /XD tests /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copying the scenes failed" }
    foreach ($dir in 'vendor', 'ui') {
        robocopy (Join-Path $project $dir) (Join-Path $scene $dir) /E /XD tests /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "copying $dir failed" }
    }
    $global:LASTEXITCODE = 0
} finally {
    if (Test-Path $build) { Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue }
}

if (-not $NoAutostart) {
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Deskworlds' -Value "`"$exe`""
}
if (-not $NoStart) { Start-Process $exe }

# The desktop picture is left alone. The world draws behind your icons, over it, and your
# own wallpaper still shows at the sign-in screen.
Write-Host "Deskworlds installed: $dest"
Write-Host "Look for its icon in the taskbar tray (click the ^ if it is hidden)."
