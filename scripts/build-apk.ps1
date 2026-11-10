# Compila l'APK de debug amb el JDK i l'SDK de ~/android-tools (no cal tenir-los al PATH).
$ErrorActionPreference = 'Stop'
$tools = Join-Path $HOME 'android-tools'
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = Join-Path $tools 'jdk' }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $tools 'sdk' }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

$android = Join-Path $PSScriptRoot '..\android'
# Gradle llegeix l'SDK de local.properties (barres invertides escapades)
"sdk.dir=$($env:ANDROID_HOME -replace '\\','\\')" | Set-Content -Encoding ascii (Join-Path $android 'local.properties')

Push-Location $android
try {
  & .\gradlew.bat assembleDebug --no-daemon
  if ($LASTEXITCODE -ne 0) { throw "Gradle ha fallat ($LASTEXITCODE)" }
} finally { Pop-Location }

$apk = Join-Path $android 'app\build\outputs\apk\debug\app-debug.apk'
$out = Join-Path $PSScriptRoot '..\Xoriguer.apk'
Copy-Item $apk $out -Force
Write-Host "APK: $((Resolve-Path $out).Path)"
