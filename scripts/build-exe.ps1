$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tauriCliPath = Join-Path $projectRoot 'node_modules\.bin\tauri.cmd'

if (-not (Test-Path -LiteralPath $tauriCliPath)) {
  throw 'The local Tauri CLI was not found. Run npm ci from the project root first.'
}

if (-not $env:windir) {
  if ($env:SystemRoot) {
    $env:windir = $env:SystemRoot
  } else {
    $env:windir = 'C:\Windows'
  }
}

$programFilesX86 = ${env:ProgramFiles(x86)}
$candidateVswherePaths = @(
  (Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe')
)

$vswherePath = $candidateVswherePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $vswherePath) {
  throw 'vswhere.exe was not found. Install Visual Studio Build Tools with the C++ toolchain.'
}

$installationPath = & $vswherePath -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installationPath) {
  throw 'Visual Studio C++ Build Tools were not found. Install the MSVC C++ toolchain.'
}

$devCommandPath = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $devCommandPath)) {
  throw "VsDevCmd.bat was not found at $devCommandPath."
}

Push-Location -LiteralPath $projectRoot
try {
  $buildCommand = 'set "windir=' + $env:windir + '" && call "' + $devCommandPath + '" -arch=x64 -host_arch=x64 >NUL && call "' + $tauriCliPath + '" build --bundles none'
  cmd.exe /d /s /c $buildCommand
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  $releaseExePath = Join-Path $projectRoot 'src-tauri\target\release\PortKiller.exe'
  $distDirectory = Join-Path $projectRoot 'dist'
  $distExePath = Join-Path $distDirectory 'PortKiller.exe'
  New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null
  Copy-Item -LiteralPath $releaseExePath -Destination $distExePath -Force
} finally {
  Pop-Location
}
