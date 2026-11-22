@echo off
chcp 65001 >nul
rem Discogs-Abgleich: Sammlung inkrementell aktualisieren (Details + Cover)
setlocal
cd /d "%~dp0"

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY where python3 >nul 2>nul && set "PY=python3"
if not defined PY (
  echo Python wurde nicht gefunden.
  pause
  exit /b 1
)

echo Discogs-Abgleich laeuft ... (Abbruch jederzeit mit Strg+C)
%PY% sync.py %*

echo.
if errorlevel 1 (
  echo Der Abgleich wurde mit einem Fehler beendet. Meldung oben pruefen.
) else (
  echo Fertig. Danach start.cmd doppelklicken - die Seite zeigt den neuen Stand.
)
pause
