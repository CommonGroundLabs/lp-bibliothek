#!/usr/bin/env python3
"""
Lokaler Server + Einrichtung fuer die LP-Bibliothek.

Startet die statische Seite auf http://127.0.0.1:8765 und stellt drei kleine
Endpunkte bereit, damit man seinen Discogs-Account direkt im Browser verbinden
kann - ohne .env von Hand zu schreiben:

    GET  /api/status      Ist ein Account verbunden? Wie viele Alben liegen vor?
    POST /api/connect     {username, token} -> prueft, schreibt .env
    POST /api/sync        Sammlung laden (startet sync.py im Hintergrund)
    POST /api/previews    30-Sekunden-Vorschauen laden (sync_previews.py)
    POST /api/demo        Beispiel-Sammlung erzeugen (ohne Discogs)
    GET  /api/progress    Fortschritt des laufenden Jobs

Das Token wird nur an diesen lokalen Server geschickt (nie an Dritte), landet
ausschliesslich in .env und erscheint in keiner Antwort und keinem Log.

    python3 app_server.py              # Server starten
    python3 app_server.py --open       # ... und Browser oeffnen
    python3 app_server.py --port 9000  # anderer Port
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
DATA_FILE = WEB_DIR / "collection.json"
PREVIEW_FILE = WEB_DIR / "previews.json"
ENV_FILE = ROOT / ".env"
SYNC_LOG = ROOT / "sync.log"
PREVIEW_LOG = ROOT / "previews.log"

USER_AGENT = "LPBiblothek/1.0 (+personal vinyl catalogue)"
API_BASE = "https://api.discogs.com"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


# ---------------------------------------------------------------- Hilfsmittel

def read_env(path: Path = ENV_FILE) -> dict[str, str]:
    data: dict[str, str] = {}
    if not path.exists():
        return data
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key.strip()] = value.strip().strip('"').strip("'")
    return data


def write_env(username: str, token: str) -> None:
    """.env schreiben - Kommentarzeilen bleiben erhalten, Token nie im Klartext loggen."""
    lines: list[str] = []
    if ENV_FILE.exists():
        for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
            key = raw.split("=", 1)[0].strip()
            if key in ("DISCOS_USER", "DISCOS_TOKEN", "DISCOGS_USER", "DISCOGS_TOKEN"):
                continue
            if raw.strip():
                lines.append(raw)
    lines.append(f"DISCOGS_USER={username}")
    lines.append(f"DISCOGS_TOKEN={token}")
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        os.chmod(ENV_FILE, 0o600)
    except OSError:
        pass  # Windows kennt keine POSIX-Rechte


def credentials() -> tuple[str, str]:
    env = {**read_env(), **{k: v for k, v in os.environ.items() if k.startswith("DISCO")}}
    user = (env.get("DISCOGS_USER") or env.get("DISCOS_USER") or "").strip()
    token = (env.get("DISCOGS_TOKEN") or env.get("DISCOS_TOKEN") or "").strip()
    return user, token


def discogs_get(path: str, token: str) -> dict:
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Discogs token={token}", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=25) as res:
        return json.loads(res.read().decode("utf-8", "replace"))


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def collection_info() -> dict:
    data = read_json(DATA_FILE)
    meta = data.get("meta") or {}
    return {
        "count": int(meta.get("count") or len(data.get("albums") or [])),
        "username": meta.get("username") or "",
        "demo": bool(meta.get("fixture")),
        "generated": meta.get("generated_at") or "",
    }


# ---------------------------------------------------------------- Hintergrund-Jobs

class Job:
    """Ein Kindprozess (sync.py / sync_previews.py) mit Logdatei und Fortschritt."""

    def __init__(self, name: str, cmd: list[str], log_path: Path) -> None:
        self.name = name
        self.log_path = log_path
        self.started = time.time()
        self.done = False
        self.error = ""
        self.exit_code: int | None = None
        log_path.write_text("", encoding="utf-8")
        self._fh = open(log_path, "w", encoding="utf-8", buffering=1)
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        self.proc = subprocess.Popen(
            cmd, cwd=str(ROOT), stdout=self._fh, stderr=subprocess.STDOUT, env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )

    def poll(self) -> None:
        if self.done:
            return
        code = self.proc.poll()
        if code is None:
            return
        self.done = True
        self.exit_code = code
        try:
            self._fh.close()
        except OSError:
            pass

    def stop(self) -> None:
        if not self.done:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.done = True

    def tail(self, lines: int = 6) -> list[str]:
        try:
            text = self.log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return []
        return [l for l in text.splitlines() if l.strip()][-lines:]

    def progress(self) -> dict:
        last = self.tail(40)
        done, total, stage = 0, 0, ""
        for line in reversed(last):
            m = re.search(r"Details:\s*(\d+)/(\d+)", line)
            if m:
                done, total, stage = int(m.group(1)), int(m.group(2)), "Details & Cover"
                break
            m = re.search(r"Sammlung:\s*Seite\s*(\d+)/(\d+)", line)
            if m:
                stage = f"Sammlung, Seite {m.group(1)}/{m.group(2)}"
                break
            m = re.search(r"^(\d+)/(\d+)\s*·", line)
            if m:
                done, total, stage = int(m.group(1)), int(m.group(2)), "Vorschauen"
                break
        pct = round(done / total * 100) if total else 0
        return {
            "name": self.name,
            "running": not self.done,
            "exit": self.exit_code,
            "done": done,
            "total": total,
            "percent": pct,
            "stage": stage,
            "seconds": round(time.time() - self.started),
            "tail": self.tail(4),
        }


JOB: Job | None = None
JOB_LOCK = threading.Lock()


def start_job(name: str, cmd: list[str], log_path: Path) -> Job:
    global JOB
    with JOB_LOCK:
        if JOB and not JOB.done:
            JOB.poll()
            if not JOB.done:
                raise RuntimeError("Es laeuft bereits ein Job.")
        JOB = Job(name, cmd, log_path)
        return JOB


# ---------------------------------------------------------------- HTTP-Handler

class Handler(SimpleHTTPRequestHandler):
    server_version = "LPBiblothek/1.0"

    def log_message(self, fmt: str, *args) -> None:  # ruhiger Server, keine Tokengefahr
        text = fmt % args if args else str(fmt)
        if "/api/" in text:
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), text))

    # ---------- Helfer
    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if not length or length > 64_000:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {}

    def _local_only(self) -> bool:
        """Nur Aufrufe aus der eigenen Maschine annehmen (kein CSRF von aussen)."""
        host = (self.headers.get("Host") or "").split(":")[0].strip("[]")
        if host not in LOCAL_HOSTS:
            return False
        origin = self.headers.get("Origin")
        if origin:
            parsed = urllib.parse.urlparse(origin)
            if parsed.hostname not in LOCAL_HOSTS:
                return False
        if self.command == "POST":
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip()
            if ctype != "application/json":
                return False
        return True

    # ---------- GET
    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            if not self._local_only():
                return self._json({"error": "Nur lokal erlaubt."}, 403)
            return self._api_get(path)
        return super().do_GET()

    def _api_get(self, path: str) -> None:
        if path == "/api/status":
            user, token = credentials()
            info = collection_info()
            job = JOB.progress() if JOB else None
            return self._json({
                "configured": bool(user and token),
                "hasToken": bool(token),
                "user": info["username"] or user,
                "count": info["count"],
                "demo": info["demo"],
                "generated": info["generated"],
                "previews": PREVIEW_FILE.exists(),
                "previewAlbums": (read_json(PREVIEW_FILE).get("meta") or {}).get("withPreview", 0),
                "job": job,
                "version": "1.0",
            })
        if path == "/api/progress":
            if not JOB:
                return self._json({"running": False, "idle": True})
            JOB.poll()
            return self._json(JOB.progress())
        return self._json({"error": "Unbekannter Endpunkt."}, 404)

    # ---------- POST
    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/"):
            return self._json({"error": "Nur API-Pfade."}, 404)
        if not self._local_only():
            return self._json({"error": "Nur lokal erlaubt."}, 403)
        body = self._body()
        try:
            if path == "/api/connect":
                return self._connect(body)
            if path == "/api/sync":
                return self._start_sync(body)
            if path == "/api/previews":
                return self._start_previews()
            if path == "/api/demo":
                return self._demo()
            if path == "/api/cancel":
                if JOB and not JOB.done:
                    JOB.stop()
                    return self._json({"ok": True, "cancelled": True})
                return self._json({"ok": True, "cancelled": False})
        except RuntimeError as exc:
            return self._json({"error": str(exc)}, 409)
        except Exception as exc:  # noqa: BLE001 - dem Nutzer eine lesbare Meldung geben
            return self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)
        return self._json({"error": "Unbekannter Endpunkt."}, 404)

    def _connect(self, body: dict) -> None:
        username = str(body.get("username") or "").strip().lstrip("@")
        token = str(body.get("token") or "").strip()
        if not username or not token:
            return self._json({"error": "Benutzername und Token werden gebraucht."}, 400)
        if not re.fullmatch(r"[A-Za-z0-9._\-]{1,64}", username):
            return self._json({"error": "Der Benutzername sieht nicht gueltig aus."}, 400)
        if len(token) < 12 or len(token) > 200 or " " in token:
            return self._json({"error": "Der Token sieht nicht gueltig aus (keine Leerzeichen)."}, 400)

        try:
            me = discogs_get("/oauth/identity", token)
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                return self._json({"error": "Discogs lehnt den Token ab (HTTP 401). Bitte neu erzeugen."}, 401)
            return self._json({"error": f"Discogs antwortet mit HTTP {exc.code}."}, 502)
        except (urllib.error.URLError, TimeoutError):
            return self._json({"error": "Discogs ist nicht erreichbar (Netzwerk?)."}, 502)

        owner = str(me.get("username") or "")
        try:
            profile = discogs_get(f"/users/{urllib.parse.quote(username)}", token)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return self._json({"error": f"Benutzer '{username}' gibt es bei Discogs nicht."}, 404)
            return self._json({"error": f"Profil nicht lesbar (HTTP {exc.code})."}, 502)

        write_env(owner or username, token)
        self._json({
            "ok": True,
            "user": owner or username,
            "releases": int(profile.get("num_collection") or 0),
            "id": me.get("id"),
        })

    def _start_sync(self, body: dict) -> None:
        user, token = credentials()
        if not user or not token:
            return self._json({"error": "Kein Account verbunden."}, 400)
        cmd = [sys.executable, "-u", str(ROOT / "sync.py")]
        if body.get("force"):
            cmd.append("--force")
        job = start_job("sync", cmd, SYNC_LOG)
        self._json({"ok": True, "job": job.progress()})

    def _start_previews(self) -> None:
        job = start_job("previews", [sys.executable, "-u", str(ROOT / "sync_previews.py")], PREVIEW_LOG)
        self._json({"ok": True, "job": job.progress()})

    def _demo(self) -> None:
        job = start_job("demo", [sys.executable, "-u", str(ROOT / "dev" / "make_fixture.py")], ROOT / "demo.log")
        self._json({"ok": True, "job": job.progress()})


# ---------------------------------------------------------------- Start

def main() -> int:
    ap = argparse.ArgumentParser(description="Lokaler Server fuer die LP-Bibliothek")
    ap.add_argument("--port", type=int, default=int(os.environ.get("LPB_PORT", "8765")))
    ap.add_argument("--host", default="127.0.0.1", help="Standard: nur lokal erreichbar")
    ap.add_argument("--open", action="store_true", help="Browser oeffnen")
    ap.add_argument("--no-open", action="store_true", help="Browser nicht oeffnen")
    args = ap.parse_args()

    if not WEB_DIR.exists():
        print(f"Fehlt: {WEB_DIR}")
        return 2

    handler = partial(Handler, directory=str(WEB_DIR))
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as exc:
        print(f"Port {args.port} ist belegt ({exc}). Anderer Port: --port 8766")
        return 3

    url = f"http://{args.host}:{args.port}/"
    user, token = credentials()
    info = collection_info()
    print(f"LP-Bibliothek laeuft auf {url}")
    print(f"Account: {info['username'] or user or 'noch nicht verbunden'} · "
          f"{info['count']} Alben{' (Demo)' if info['demo'] else ''}")
    print("Beenden mit Ctrl+C")
    if args.open and not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer beendet.")
    finally:
        httpd.server_close()
        if JOB and not JOB.done:
            JOB.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
