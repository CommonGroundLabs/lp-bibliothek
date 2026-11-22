@echo off
REM LP-Bibliothek: Einrichtung + Start (Windows)
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python wurde nicht gefunden.
  echo Bitte von https://www.python.org/downloads/ installieren ^(Haken bei "Add python.exe to PATH"^).
  pause
  exit /b 1
)
python setup.py
if errorlevel 1 pause
