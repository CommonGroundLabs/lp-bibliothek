#!/usr/bin/env python3
"""Discogs-LP-Katalog -- Sync der Sammlung, der Releases und der Cover.

Holt alle Releases einer Discogs-Sammlung ueber die offizielle API, laedt die
Cover lokal herunter, extrahiert pro Cover dominante Farben (fuer den Backglow)
und schreibt web/collection.json, aus der die statische Seite liest.

  python sync.py                # inkrementell (Standard)
  python sync.py --force        # alles neu laden
  python sync.py --check        # nur Token/User pruefen
  python sync.py --limit 20     # Testlauf mit 20 Releases

Token: .env im Projektordner mit DISCOS_USER und DISCOS_TOKEN.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import random
import sys
import time
from pathlib import Path
from urllib import error, parse, request

from PIL import Image

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
COVER_DIR = WEB_DIR / "covers"
DATA_FILE = WEB_DIR / "collection.json"

API = "https://api.discogs.com"
USER_AGENT = "MeinLPKatalog/1.0 +https://github.com/dithrium/lp-bibliothek"
MIN_INTERVAL = 1.05          # ~57 Requests/Minute (Limit: 60)
COVER_MAX_PX = 1100
COVER_QUALITY = 86


# ---------------------------------------------------------------- Hilfsfunktionen

def log(msg: str) -> None:
    print(msg, flush=True)


def load_env(path: Path = ROOT / ".env") -> dict[str, str]:
    """Minimaler .env-Parser (KEY=VALUE, Quotes, #-Kommentare)."""
    data: dict[str, str] = {}
    if not path.exists():
        return data
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        data[key.strip()] = value
    return data


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------- API-Client

class Discogs:
    def __init__(self, token: str, username: str):
        self.token = token
        self.username = username
        self._last = 0.0
        self.requests = 0

    def _throttle(self) -> None:
        wait = MIN_INTERVAL - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def _headers(self) -> dict[str, str]:
        return {
            "User-Agent": USER_AGENT,
            "Authorization": f"Discogs token={self.token}",
            "Accept": "application/json",
        }

    def get(self, path: str, params: dict | None = None) -> dict:
        url = API + path
        if params:
            url += "?" + parse.urlencode(params)
        last_exc: Exception | None = None
        for attempt in range(6):
            self._throttle()
            req = request.Request(url, headers=self._headers())
            try:
                with request.urlopen(req, timeout=45) as resp:
                    self.requests += 1
                    return json.loads(resp.read().decode("utf-8"))
            except error.HTTPError as exc:
                self.requests += 1
                body = ""
                try:
                    body = exc.read().decode("utf-8", "replace")[:200]
                except Exception:
                    pass
                if exc.code == 429:
                    delay = float(exc.headers.get("Retry-After") or 0) or 5 * (attempt + 1)
                    log(f"  ! Rate-Limit (429) -- warte {delay:.0f}s")
                    time.sleep(delay)
                    last_exc = exc
                    continue
                if exc.code in (500, 502, 503, 504):
                    delay = 3 * (2 ** attempt) + random.random()
                    log(f"  ! Server {exc.code} -- neuer Versuch in {delay:.0f}s")
                    time.sleep(delay)
                    last_exc = exc
                    continue
                if exc.code == 401:
                    raise SystemExit("401 Unauthorized: Token ungueltig. Bitte .env pruefen.") from exc
                if exc.code == 404:
                    raise
                raise
            except (error.URLError, TimeoutError, json.JSONDecodeError, ConnectionError) as exc:
                last_exc = exc
                delay = 3 * (2 ** attempt)
                log(f"  ! Netzwerkfehler ({exc.__class__.__name__}) -- neuer Versuch in {delay}s")
                time.sleep(delay)
        raise RuntimeError(f"Request endgueltig fehlgeschlagen: {url} ({last_exc})")

    def download(self, url: str) -> bytes:
        for attempt in range(5):
            self._throttle()
            req = request.Request(url, headers=self._headers())
            try:
                with request.urlopen(req, timeout=60) as resp:
                    self.requests += 1
                    return resp.read()
            except error.HTTPError as exc:
                self.requests += 1
                if exc.code in (429, 500, 502, 503, 504):
                    delay = float(exc.headers.get("Retry-After") or 0) or 4 * (attempt + 1)
                    time.sleep(delay)
                    continue
                raise
            except (error.URLError, TimeoutError, ConnectionError):
                time.sleep(3 * (attempt + 1))
        raise RuntimeError(f"Download fehlgeschlagen: {url}")


# ---------------------------------------------------------------- Farben

def _rgb_to_hsl(r: int, g: int, b: int) -> tuple[float, float, float]:
    rn, gn, bn = r / 255, g / 255, b / 255
    mx, mn = max(rn, gn, bn), min(rn, gn, bn)
    light = (mx + mn) / 2
    if mx == mn:
        return 0.0, 0.0, light
    delta = mx - mn
    sat = delta / (2 - mx - mn) if light > 0.5 else delta / (mx + mn)
    if mx == rn:
        hue = ((gn - bn) / delta) % 6
    elif mx == gn:
        hue = (bn - rn) / delta + 2
    else:
        hue = (rn - gn) / delta + 4
    return hue * 60, sat, light


def _hsl_to_hex(hue: float, sat: float, light: float) -> str:
    hue = (hue % 360) / 360
    sat = max(0.0, min(1.0, sat))
    light = max(0.0, min(1.0, light))
    if sat == 0:
        val = round(light * 255)
        return f"#{val:02x}{val:02x}{val:02x}"
    q = light * (1 + sat) if light < 0.5 else light + sat - light * sat
    p = 2 * light - q

    def channel(t: float) -> float:
        t %= 1.0
        if t < 1 / 6:
            return p + (q - p) * 6 * t
        if t < 1 / 2:
            return q
        if t < 2 / 3:
            return p + (q - p) * (2 / 3 - t) * 6
        return p

    r = round(channel(hue + 1 / 3) * 255)
    g = round(channel(hue) * 255)
    b = round(channel(hue - 1 / 3) * 255)
    return f"#{r:02x}{g:02x}{b:02x}"


def _hue_gap(a: float, b: float) -> float:
    diff = abs(a - b) % 360
    return min(diff, 360 - diff)


def dominant_colors(img: Image.Image, count: int = 3) -> list[str]:
    """2-3 dominante, fuer einen Glow brauchbare Farben (Hex)."""
    small = img.convert("RGB")
    small.thumbnail((110, 110))
    quant = small.quantize(colors=16, method=Image.Quantize.MEDIANCUT)
    palette = quant.getpalette() or []
    buckets = quant.getcolors() or []
    buckets.sort(reverse=True)

    scored: list[tuple[float, float, float, float]] = []
    for pixels, index in buckets:
        if index * 3 + 2 >= len(palette):
            continue
        r, g, b = palette[index * 3: index * 3 + 3]
        hue, sat, light = _rgb_to_hsl(r, g, b)
        if light > 0.94 or light < 0.04:
            continue
        score = (pixels ** 0.75) * (0.30 + sat) * (1.0 - abs(light - 0.5))
        scored.append((score, hue, sat, light))

    if not scored:  # fast schwarz/weiss: dann wenigstens die haeufigsten Toene
        for pixels, index in buckets[:3]:
            r, g, b = palette[index * 3: index * 3 + 3]
            hue, sat, light = _rgb_to_hsl(r, g, b)
            scored.append((float(pixels), hue, sat, light))

    chosen: list[tuple[float, float, float]] = []
    for _score, hue, sat, light in sorted(scored, reverse=True):
        if any(_hue_gap(hue, c[0]) < 28 for c in chosen):
            continue
        chosen.append((hue, sat, light))
        if len(chosen) == count:
            break
    while len(chosen) < count and scored:
        best = sorted(scored, reverse=True)[len(chosen) % len(scored)]
        chosen.append((best[1], best[2], best[3]))

    out: list[str] = []
    for hue, sat, light in chosen:
        boost_s = min(1.0, sat * 1.25 + 0.10)
        boost_l = min(0.62, max(0.40, light * 0.85 + 0.14))
        out.append(_hsl_to_hex(hue, boost_s, boost_l))
    return out


DEFAULT_COLORS = ["#3b3b46", "#2b2b34", "#4a4a58"]


# ---------------------------------------------------------------- Aufbereitung

def format_summary(formats: list[dict]) -> str:
    parts: list[str] = []
    for fmt in formats or []:
        name = (fmt.get("name") or "").strip()
        qty = (fmt.get("qty") or "").strip()
        head = name
        if qty and qty not in ("", "1"):
            head = f"{qty}× {name}" if name else qty
        descs = [d for d in (fmt.get("descriptions") or []) if d]
        chunk = ", ".join([head] + descs) if head else ", ".join(descs)
        if chunk:
            parts.append(chunk)
    return " · ".join(parts)


def pick_image(images: list[dict]) -> str | None:
    if not images:
        return None
    primary = [i for i in images if i.get("type") == "primary"]
    for candidate in primary + images:
        uri = candidate.get("uri") or candidate.get("uri150")
        if uri:
            return uri
    return None


def save_cover(client: Discogs, url: str, release_id: int) -> str | None:
    target = COVER_DIR / f"{release_id}.jpg"
    if target.exists() and target.stat().st_size > 2000:
        return f"covers/{target.name}"
    try:
        raw = client.download(url)
        img = Image.open(io.BytesIO(raw))
        img = img.convert("RGB")
        img.thumbnail((COVER_MAX_PX, COVER_MAX_PX), Image.Resampling.LANCZOS)
        img.save(target, "JPEG", quality=COVER_QUALITY, optimize=True, progressive=True)
        return f"covers/{target.name}"
    except Exception as exc:  # noqa: BLE001 - ein kaputtes Cover darf den Sync nicht stoppen
        log(f"  ! Cover {release_id} fehlgeschlagen: {exc.__class__.__name__}: {exc}")
        return None


def colors_for(cover_rel: str | None) -> list[str]:
    if not cover_rel:
        return DEFAULT_COLORS
    path = WEB_DIR / cover_rel
    if not path.exists():
        return DEFAULT_COLORS
    try:
        with Image.open(path) as img:
            return dominant_colors(img)
    except Exception:
        return DEFAULT_COLORS


def build_entry(item: dict, release: dict | None, cover_rel: str | None) -> dict:
    info = item.get("basic_information") or {}
    rel = release or {}
    labels = []
    for lab in rel.get("labels") or info.get("labels") or []:
        entry = {"name": (lab.get("name") or "").strip(), "catno": (lab.get("catno") or "").strip()}
        if entry["name"] or entry["catno"]:
            labels.append(entry)

    artists = [a.get("name", "") for a in (info.get("artists") or []) if a.get("name")]
    if not artists:
        artists = [a.get("name", "") for a in (rel.get("artists") or []) if a.get("name")]

    tracks = []
    for tr in rel.get("tracklist") or []:
        title = (tr.get("title") or "").strip()
        if not title:
            continue
        tracks.append({
            "position": (tr.get("position") or "").strip(),
            "title": title,
            "duration": (tr.get("duration") or "").strip(),
        })

    genres = rel.get("genres") or info.get("genres") or []
    styles = rel.get("styles") or info.get("styles") or []
    formats = rel.get("formats") or info.get("formats") or []
    year = rel.get("year") or info.get("year") or 0
    try:
        year = int(year or 0)
    except (TypeError, ValueError):
        year = 0

    return {
        "instance_id": item.get("instance_id"),
        "release_id": info.get("id") or rel.get("id"),
        "artist": ", ".join(artists) if artists else "Unbekannt",
        "title": (info.get("title") or rel.get("title") or "Ohne Titel").strip(),
        "year": year,
        "labels": labels,
        "label": labels[0]["name"] if labels else "",
        "catno": next((l["catno"] for l in labels if l["catno"]), ""),
        "genres": [g for g in genres if g],
        "styles": [s for s in styles if s],
        "country": rel.get("country") or "",
        "formats": [
            {
                "name": f.get("name") or "",
                "qty": f.get("qty") or "",
                "descriptions": [d for d in (f.get("descriptions") or []) if d],
            }
            for f in formats
        ],
        "format": format_summary(formats),
        "added": item.get("date_added") or "",
        "rating": item.get("rating") or 0,
        "cover": cover_rel,
        "colors": colors_for(cover_rel),
        "tracklist": tracks,
        "notes": (rel.get("notes") or "").strip()[:400],
        "discogs_url": f"https://www.discogs.com/release/{info.get('id') or rel.get('id')}",
    }


# ---------------------------------------------------------------- Hauptlauf

def fetch_collection(client: Discogs, limit: int | None = None) -> list[dict]:
    items: list[dict] = []
    page = 1
    pages = 1
    while page <= pages:
        payload = client.get(
            f"/users/{parse.quote(client.username)}/collection/folders/0/releases",
            {"per_page": 100, "page": page, "sort": "added", "sort_order": "desc"},
        )
        pagination = payload.get("pagination") or {}
        pages = int(pagination.get("pages") or 1)
        total = pagination.get("items")
        batch = payload.get("releases") or []
        items.extend(batch)
        log(f"Sammlung: Seite {page}/{pages} · {len(items)}"
            + (f" von {total} Eintraegen" if total else " Eintraege"))
        if limit and len(items) >= limit:
            items = items[:limit]
            break
        page += 1
    return items


def main() -> int:
    ap = argparse.ArgumentParser(description="Discogs-Sammlung synchronisieren")
    ap.add_argument("--force", action="store_true", help="alle Details neu laden")
    ap.add_argument("--check", action="store_true", help="nur Zugangsdaten pruefen")
    ap.add_argument("--limit", type=int, default=None, help="maximal N Releases (Test)")
    ap.add_argument("--refresh-covers", action="store_true", help="Cover neu herunterladen")
    args = ap.parse_args()

    env = {**load_env(), **os.environ}
    username = (env.get("DISCOGS_USER") or env.get("DISCOS_USER") or "").strip()
    token = (env.get("DISCOGS_TOKEN") or env.get("DISCOS_TOKEN") or "").strip()
    if not username or not token:
        log("Fehlende Zugangsdaten.")
        log("Am einfachsten: python3 setup.py (fragt Account und Token im Browser ab).")
        log("Oder .env im Projektordner anlegen mit:")
        log("  DISCOGS_USER=dithrium")
        log("  DISCOGS_TOKEN=dein_personal_access_token")
        log("Token erstellen: https://www.discogs.com/settings/developers")
        return 2

    client = Discogs(token, username)
    log(f"Discogs-Sync fuer '{username}' · User-Agent: {USER_AGENT}")

    if args.check:
        me = client.get("/oauth/identity")
        log(f"OK: angemeldet als {me.get('username')} (#{me.get('id')})")
        prof = client.get(f"/users/{parse.quote(username)}")
        log(f"Sammlung laut Profil: {prof.get('num_collection')} Releases")
        return 0

    WEB_DIR.mkdir(parents=True, exist_ok=True)
    COVER_DIR.mkdir(parents=True, exist_ok=True)

    previous = read_json(DATA_FILE) or {}
    prev_albums = {a.get("instance_id"): a for a in previous.get("albums", []) if a.get("instance_id")}
    log(f"Bestand: {len(prev_albums)} Eintraege bereits lokal")

    started = time.time()
    items = fetch_collection(client, args.limit)
    if not items:
        log("Sammlung ist leer -- nichts zu tun.")
        return 0

    albums: list[dict] = []
    removed = set(prev_albums) - {i.get("instance_id") for i in items}
    new_count = 0
    reused = 0
    errors = 0

    for idx, item in enumerate(items, 1):
        instance_id = item.get("instance_id")
        info = item.get("basic_information") or {}
        release_id = info.get("id")
        old = prev_albums.get(instance_id)

        reusable = (
            not args.force
            and old
            and old.get("release_id") == release_id
            and old.get("tracklist") is not None
            and old.get("colors")
            and (old.get("cover") is None or (WEB_DIR / str(old.get("cover"))).exists())
        )
        if reusable:
            albums.append(old)
            reused += 1
            if idx % 25 == 0 or idx == len(items):
                log(f"Details: {idx}/{len(items)} · {new_count} neu, {reused} aus Cache")
            continue

        try:
            release = client.get(f"/releases/{release_id}")
        except error.HTTPError as exc:
            log(f"  ! Release {release_id} ({info.get('title')}): HTTP {exc.code}")
            release = None
            errors += 1

        cover_rel = None
        if release:
            image_url = pick_image(release.get("images") or [])
            if image_url:
                if args.refresh_covers and (COVER_DIR / f"{release_id}.jpg").exists():
                    (COVER_DIR / f"{release_id}.jpg").unlink()
                cover_rel = save_cover(client, image_url, release_id)
        albums.append(build_entry(item, release, cover_rel))
        new_count += 1
        log(f"Details: {idx}/{len(items)} · {new_count} neu, {reused} aus Cache")

    unknown_years = sum(1 for a in albums if not a.get("year"))
    no_cover = sum(1 for a in albums if not a.get("cover"))
    no_tracks = sum(1 for a in albums if not a.get("tracklist"))

    write_json(DATA_FILE, {
        "meta": {
            "schema": 1,
            "username": username,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "count": len(albums),
            "fixture": False,
            "stats": {"without_year": unknown_years, "without_cover": no_cover, "without_tracklist": no_tracks},
        },
        "albums": albums,
    })

    elapsed = time.time() - started
    log("")
    log(f"Fertig in {elapsed/60:.1f} min · {len(albums)} Alben · {new_count} neu · "
        f"{reused} aus Cache · {len(removed)} entfernt · {errors} Fehler · {client.requests} Requests")
    log(f"Luecken: {no_cover} ohne Cover, {no_tracks} ohne Tracklist, {unknown_years} ohne Jahr")
    log(f"Datei: {DATA_FILE}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("\nAbgebrochen.")
        sys.exit(130)
