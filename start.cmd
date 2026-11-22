@echo off
rem Startet die LP-Bibliothek lokal: http://127.0.0.1:8765  (Beenden mit Strg+C)
setlocal
cd /d "%~dp0web"

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY where python3 >nul 2>nul && set "PY=python3"
if not defined PY (
  echo Python wurde nicht gefunden.
  echo Bitte von https://www.python.org/downloads/ installieren ^(Haken bei "Add python.exe to PATH"^).
  pause
  exit /b 1
)

cd /d "%~dp0"
%PY% app_server.py --open
if errorlevel 1 pause
