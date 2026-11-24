@echo off
REM Double-click this file to start Harbour Run.
REM Runs start.ps1 with a bypass so PowerShell's script policy doesn't block it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
