# Tempolight installer for Windows 10/11.
#   irm https://raw.githubusercontent.com/D4RKGEEK/tempolight/main/install/install.ps1 | iex
# Installs Node.js LTS with winget if needed, puts Tempolight in %LOCALAPPDATA%\Tempolight, adds Start menu and
# desktop shortcuts, and starts it. Your settings are kept in %USERPROFILE%\.tempolight.
$ErrorActionPreference = "Stop"
$Repo = if ($env:TEMPOLIGHT_REPO) { $env:TEMPOLIGHT_REPO } else { "D4RKGEEK/tempolight" }
$Branch = if ($env:TEMPOLIGHT_BRANCH) { $env:TEMPOLIGHT_BRANCH } else { "main" }
$Dest = Join-Path $env:LOCALAPPDATA "Tempolight"
function Say($m) { Write-Host "> $m" -ForegroundColor Yellow }

function NodeOk { try { $v = (& node -p "process.versions.node.split('.')[0]") 2>$null; return [int]$v -ge 20 } catch { return $false } }
if (-not (NodeOk)) {
  Say "Tempolight needs Node.js 20 or newer. Installing Node.js LTS with winget..."
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (NodeOk)) { throw "Node.js didn't install. Get it from https://nodejs.org and run this again." }
}
Say "Node.js $(node -v)"

Say "Downloading Tempolight to $Dest"
$zip = Join-Path $env:TEMP "tempolight.zip"; $tmp = Join-Path $env:TEMP "tempolight-unzip"
Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive $zip $tmp
if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $Dest
Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue

$cmd = Join-Path $Dest "Start Tempolight.cmd"
Set-Content $cmd "@echo off`r`ntitle Tempolight`r`nnode `"%~dp0packages\server\src\index.js`" --open %*`r`npause" -Encoding ASCII
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))) {
  $lnk = $shell.CreateShortcut((Join-Path $dir "Tempolight.lnk")); $lnk.TargetPath = $cmd; $lnk.WorkingDirectory = $Dest; $lnk.Save()
}
Say "Installed. Starting Tempolight (Windows may ask to allow it on your network: allow it, so your lights and phone can reach it)."
Start-Process $cmd
