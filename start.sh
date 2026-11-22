#!/usr/bin/env bash
# Startet die LP-Bibliothek lokal: http://127.0.0.1:8765
set -e
cd "$(dirname "$0")"
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then
  echo "Python 3 wurde nicht gefunden. Bitte installieren: https://www.python.org/downloads/"
  exit 1
fi
exec "$PY" app_server.py --open
