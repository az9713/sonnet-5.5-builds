# Stop Deskworlds, remove its sign-in entry and delete the installed program.
# Your desktop picture was never changed, so it is already there underneath.
# Saved choices (%APPDATA%\Deskworlds) are kept.
$ErrorActionPreference = 'Stop'

Get-Process Deskworlds -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Deskworlds' -ErrorAction SilentlyContinue
$dest = Join-Path $env:LOCALAPPDATA 'Programs\Deskworlds'
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
# The private browser profile the scenes ran in.
$profile = Join-Path $env:LOCALAPPDATA 'Deskworlds\WebView2'
if (Test-Path $profile) { Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host "Deskworlds removed."
