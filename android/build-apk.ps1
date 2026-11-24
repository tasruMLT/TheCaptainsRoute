# Builds the Harbour Run Android app (debug-signed, for testing) and copies
# it to ..\dist\. Needs the Android SDK (Android Studio installs it).
#   powershell -NoProfile -ExecutionPolicy Bypass -File android\build-apk.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not $env:JAVA_HOME) {
    $jbr = "C:\Program Files\Android\Android Studio\jbr"
    if (Test-Path $jbr) { $env:JAVA_HOME = $jbr }
}
if (-not (Test-Path "local.properties")) {
    $sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
    "sdk.dir=$($sdk -replace '\', '\')" | Set-Content -Encoding ascii local.properties
}

& .\gradlew.bat assembleDebug
if ($LASTEXITCODE -ne 0) { throw "Gradle build failed" }

$version = (Select-String -Path ..\game.js -Pattern 'const GAME_VERSION = "([^"]+)"').Matches[0].Groups[1].Value
New-Item -ItemType Directory -Force ..\dist | Out-Null
$apk = "..\dist\HarbourRun-$version-debug.apk"
Copy-Item build\outputs\apk\debug\*-debug.apk $apk -Force
Write-Host "APK ready: $((Resolve-Path $apk).Path)"
