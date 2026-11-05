# Runs the core logic tests in headless Edge. Exits with 1 if any test fails.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts using the system code page.
$ErrorActionPreference = 'Stop'

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge not found' }

$page = (Resolve-Path (Join-Path $PSScriptRoot '..\tests\core.test.html')).Path
$url = 'file:///' + ($page -replace '\\', '/')
$profile = Join-Path $env:TEMP "work-encourager-tests-$PID"

try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $edge
  $psi.Arguments = "--headless=new --disable-gpu --no-first-run --user-data-dir=`"$profile`" --virtual-time-budget=3000 --dump-dom `"$url`""
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $proc = [Diagnostics.Process]::Start($psi)
  $errTask = $proc.StandardError.ReadToEndAsync()
  $dom = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  [void]$errTask.Result
} finally {
  if (Test-Path $profile) { Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue }
}

$match = [regex]::Match($dom, '<pre id="result">(.*?)</pre>', 'Singleline')
if (-not $match.Success) { throw "Could not find test results in page output:`n$dom" }
$text = [Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
Write-Output $text
if ($text -match '(?m)^FAIL' -or $text -eq 'running') { exit 1 }
