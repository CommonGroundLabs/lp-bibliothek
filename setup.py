#!/usr/bin/env python3
"""
Erster Start: prueft die Abhaengigkeiten und oeffnet die Einrichtung im Browser.

    python3 setup.py        (Windows: setup.cmd doppelklicken)

Danach fragt die Seite nach Discogs-Benutzername und Personal Access Token,
laedt die Sammlung und zeigt die Bibliothek an. Alles bleibt auf diesem Rechner.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MIN_PY = (3, 9)


def line(text: str = "") -> None:
    print(text, flush=True)


def ensure_pillow() -> bool:
    if importlib.util.find_spec("PIL") is not None:
        return True
    line("Pillow fehlt (wird fuer Cover-Verkleinerung und Farben gebraucht).")
    line("Installiere: pip install Pillow")
    try:
        answer = input("Jetzt automatisch installieren? [J/n] ").strip().lower()
    except EOFError:
        answer = "j"
    if answer not in ("", "j", "ja", "y", "yes"):
        return False
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--upgrade", "Pillow"],
        check=False,
    )
    return result.returncode == 0 and importlib.util.find_spec("PIL") is not None


def main() -> int:
    if sys.version_info < MIN_PY:
        line(f"Python {MIN_PY[0]}.{MIN_PY[1]}+ wird gebraucht (gefunden: {sys.version.split()[0]}).")
        return 2

    line("LP-Bibliothek – Einrichtung")
    line("=" * 40)
    if not ensure_pillow():
        line("Ohne Pillow kein Sync. Abbruch.")
        return 2

    line("Starte den lokalen Server und oeffne den Browser ...")
    line("")
    cmd = [sys.executable, str(ROOT / "app_server.py"), "--open"]
    try:
        return subprocess.call(cmd, cwd=str(ROOT))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
