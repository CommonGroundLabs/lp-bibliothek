#!/usr/bin/env python3
"""
Vorschau-Sync: holt 30-Sekunden-Clips zur Sammlung und legt web/previews.json an.

Quelle ist die iTunes-Search-API (Apple Music). Sie braucht keinen Key, keine
Anmeldung und liefert pro Track eine 30-Sekunden-URL. Diese URLs werden nur
abgespielt, nicht heruntergeladen - es entsteht also keine zweite Plattform,
sondern nur ein "Reinhören" direkt aus der Bibliothek.

Ablauf je Album:
  1. Album-Suche  (entity=album)  -> Kandidat mit Titel-/Künstler-/Jahr-Abgleich
  2. Track-Lookup (lookup?id=<collectionId>&entity=song) -> Titel + Preview-URLs
  3. Fallback bei Misserfolg: Song-Suche (entity=song), daraus die collectionId
  4. Zuordnung iTunes-Tracks -> Discogs-Positionen (A1, B2 ...) per Titelähnlichkeit

Die Datei ist inkrementell: bereits gematchte Releases werden nicht erneut
abgefragt. Fortschritt wird alle 10 Alben geschrieben, ein Abbruch ist harmlos.

Nutzung:
    python3 sync_previews.py --check          # nur API-Test, ein Album
    python3 sync_previews.py                  # alle offenen Alben
    python3 sync_previews.py --limit 40       # Testlauf
    python3 sync_previews.py --retry-missed   # Fehlschläge erneut versuchen
    python3 sync_previews.py --force          # alles neu
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
COLLECTION = ROOT / "web" / "collection.json"
OUT = ROOT / "web" / "previews.json"

USER_AGENT = "LPBiblothek/1.0 (+personal vinyl catalogue)"
API = "https://itunes.apple.com"
COUNTRY = "DE"
DELAY = 3.2          # Sekunden zwischen zwei Requests (~19/min, Apple verträgt ~20/min)
SAVE_EVERY = 10
MIN_TITLE = 0.82     # Titelähnlichkeit, ab der ein Kandidat akzeptiert wird
MIN_ARTIST = 0.55


# ---------------------------------------------------------------- Hilfsmittel
def norm(text: str) -> str:
    """Vergleichsform: Kleinschreibung, ohne Satzzeichen, ohne Klammerzusätze."""
    text = (text or "").lower()
    text = re.sub(r"\((?:[^)]*)\)", " ", text)
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = text.replace("&", " and ").replace("+", " and ")
    text = re.sub(r"\b(feat|featuring|ft)\.?\s+.*$", " ", text)
    text = re.sub(r"[^a-z0-9äöüß ]+", " ", text)
    text = re.sub(r"\b(the|a|an|vol|volume|ep|lp)\b", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def artist_norm(text: str) -> str:
    """Künstlername ohne Discogs-Nummerierung ("Sade (2)") und ohne führendes "The"."""
    text = re.sub(r"\s*\(\d+\)\s*$", "", text or "")
    text = re.split(r"\s+(?:feat\.?|featuring|vs\.?|pres\.?)\s+", text, flags=re.I)[0]
    return norm(text)


def ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def parse_duration(value) -> int:
    """Discogs liefert "4:16"; manche Releases "" oder Sekunden als Zahl."""
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value or "").strip()
    if not text:
        return 0
    parts = text.split(":")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return 0
    secs = 0
    for n in nums:
        secs = secs * 60 + n
    return secs


def artist_variants(artist: str) -> list[str]:
    """Discogs schreibt Mehrfach-Künstler als "A, B, A" – einzeln prüfen."""
    raw = re.sub(r"\s*\(\d+\)\s*", " ", artist or "")
    parts = [p.strip() for p in re.split(r",|;|/|&|\bvs\.?\b|\bfeat\.?\b", raw) if p.strip()]
    out = [artist_norm(raw)]
    out += [artist_norm(p) for p in parts[:4]]
    return [v for v in dict.fromkeys(out) if v]


def api(path: str, params: dict) -> dict:
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=25) as res:
                return json.loads(res.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as err:
            if err.code in (403, 429, 500, 502, 503):
                wait = 10 * (attempt + 1)
                print(f"   … HTTP {err.code}, warte {wait}s", flush=True)
                time.sleep(wait)
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as err:
            wait = 5 * (attempt + 1)
            print(f"   … Netzfehler ({err}), warte {wait}s", flush=True)
            time.sleep(wait)
    return {}


# ---------------------------------------------------------------- Abgleich
COMP_HINTS = ("hits", "best of", "greatest", "anthology", "essential", "collection",
              "compilation", "gold", "pop hits", "now that", "the very best")


def looks_like_compilation(name: str) -> bool:
    n = norm(name)
    return any(h in n for h in COMP_HINTS)


def score_album(album: dict, item: dict) -> float:
    """Ähnlichkeit eines iTunes-Treffers zum Discogs-Release (0..1)."""
    title = norm(album.get("title"))
    names = [n for n in (norm(item.get("collectionName")), norm(item.get("trackName"))) if n]
    t = max((ratio(title, n) for n in names), default=0.0)
    variants = artist_variants(album.get("artist", ""))
    a = max((ratio(v, artist_norm(item.get("artistName", ""))) for v in variants), default=0.0)
    if t < 0.62 or a < 0.45:
        return 0.0
    score = 0.62 * t + 0.38 * a
    # Sammelalben nur akzeptieren, wenn das Release selbst danach klingt
    coll = item.get("collectionName") or ""
    if looks_like_compilation(coll) and not looks_like_compilation(album.get("title", "")):
        score -= 0.18
    year = album.get("year") or 0
    it_year = int((item.get("releaseDate") or "0")[:4] or 0)
    if year and it_year:
        diff = abs(year - it_year)
        if diff <= 1:
            score += 0.06
        elif diff <= 3:
            score += 0.02
        else:
            score -= 0.10
    return round(min(score, 1.0), 3)


def find_album(album: dict) -> tuple[dict | None, float, str]:
    """Sucht den besten iTunes-Treffer: erst Album, dann Song, dann über den ersten Track."""
    artist = album.get("artist", "")
    title = album.get("title", "")
    first = next((t.get("title") for t in (album.get("tracklist") or []) if t.get("title")), "")
    queries = [f"{artist} {title}".strip()]
    if first and norm(first) != norm(title):
        queries.append(f"{artist} {first}".strip())

    best, best_score, via = None, 0.0, ""
    for qi, term in enumerate(queries):
        for entity in ("album", "song"):
            data = api("/search", {"term": term, "entity": entity, "limit": 14, "country": COUNTRY})
            for item in data.get("results", []):
                s = score_album(album, item)
                if s > best_score:
                    best, best_score, via = item, s, entity
            if best_score >= 0.90:
                return best, best_score, via
            time.sleep(DELAY)
        if qi == 0 and best_score >= 0.80:
            return best, best_score, via
    return (best, best_score, via) if best_score >= 0.80 else (None, round(best_score, 3), "")


def fetch_tracks(item: dict) -> list[dict]:
    cid = item.get("collectionId")
    if cid:
        time.sleep(DELAY)
        data = api("/lookup", {"id": cid, "entity": "song", "limit": 200, "country": COUNTRY})
        tracks = [r for r in data.get("results", []) if r.get("wrapperType") == "track" and r.get("previewUrl")]
        if tracks:
            return tracks
    if item.get("previewUrl"):
        return [item]
    return []


def map_to_positions(discogs_tracks: list[dict], itunes_tracks: list[dict]) -> dict:
    """Ordnet iTunes-Tracks den Discogs-Positionen zu (Titel zuerst, dann Reihenfolge)."""
    used: set[int] = set()
    mapping: dict[str, dict] = {}
    for dt in discogs_tracks:
        pos = str(dt.get("position") or "").strip()
        name = norm(dt.get("title"))
        secs = parse_duration(dt.get("duration"))
        if not pos or not name:
            continue
        best_i, best_s = None, 0.0
        for i, it in enumerate(itunes_tracks):
            if i in used:
                continue
            s = ratio(name, norm(it.get("trackName")))
            mi = (it.get("trackTimeMillis") or 0) / 1000
            if secs and mi and abs(secs - mi) <= 8:
                s += 0.15
            if s > best_s:
                best_i, best_s = i, s
        if best_i is None or best_s < 0.72:
            continue
        used.add(best_i)
        it = itunes_tracks[best_i]
        mapping[pos] = {
            "url": it["previewUrl"],
            "sec": int(round((it.get("trackTimeMillis") or 0) / 1000)) or None,
            "name": it.get("trackName"),
        }
    # Reine Reihenfolge als Nachschlag, wenn die Titel stark abweichen (Remixe u. Ä.)
    if len(mapping) < max(1, len(discogs_tracks) // 3):
        free = [i for i in range(len(itunes_tracks)) if i not in used]
        for dt in discogs_tracks:
            pos = str(dt.get("position") or "").strip()
            if not pos or pos in mapping or not free:
                continue
            it = itunes_tracks[free[0]]
            mapping[pos] = {
                "url": it["previewUrl"],
                "sec": int(round((it.get("trackTimeMillis") or 0) / 1000)) or None,
                "name": it.get("trackName"),
            }
            used.add(free.pop(0))
    return mapping


# ---------------------------------------------------------------- Hauptlauf
def load_state() -> dict:
    if OUT.exists():
        try:
            return json.loads(OUT.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print("previews.json unlesbar – wird neu aufgebaut")
    return {"meta": {}, "byRelease": {}}


def save_state(state: dict, total: int) -> None:
    by = state.get("byRelease", {})
    matched = sum(1 for e in by.values() if e.get("tracks"))
    state["meta"] = {
        "source": "iTunes Search API",
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "country": COUNTRY,
        "albums": total,
        "withPreview": matched,
        "withoutPreview": len(by) - matched,
    }
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, OUT)


def main() -> int:
    ap = argparse.ArgumentParser(description="Holt 30-s-Vorschauen zur Sammlung.")
    ap.add_argument("--limit", type=int, default=0, help="nur N Alben bearbeiten")
    ap.add_argument("--force", action="store_true", help="auch gematchte Alben neu abfragen")
    ap.add_argument("--retry-missed", action="store_true", help="Fehlschläge erneut versuchen")
    ap.add_argument("--check", action="store_true", help="nur ein Album testen")
    ap.add_argument("--redo-below", type=float, default=0.0,
                    help="Treffer mit Ähnlichkeits-Score unter X erneut suchen")
    args = ap.parse_args()

    if not COLLECTION.exists():
        print(f"Fehlt: {COLLECTION}. Erst sync.py laufen lassen.")
        return 2
    collection = json.loads(COLLECTION.read_text(encoding="utf-8"))
    albums = collection.get("albums", [])
    state = load_state()
    by_release = state.setdefault("byRelease", {})

    todo = []
    for album in albums:
        rid = str(album.get("release_id") or album.get("instance_id") or "")
        if not rid:
            continue
        entry = by_release.get(rid)
        if entry and not args.force:
            if entry.get("tracks") and args.redo_below and (entry.get("score") or 0) < args.redo_below:
                todo.append(album)
                continue
            if entry.get("tracks") or not args.retry_missed:
                continue
        todo.append(album)
    if args.check:
        todo = todo[:1]
    elif args.limit:
        todo = todo[: args.limit]

    matched = sum(1 for e in by_release.values() if e.get("tracks"))
    missed = len(by_release) - matched
    print(f"{len(albums)} Alben in der Sammlung · {len(todo)} offen für Vorschauen", flush=True)

    for i, album in enumerate(todo, 1):
        rid = str(album.get("release_id") or album.get("instance_id"))
        label = f"{album.get('artist', '?')} – {album.get('title', '?')}"
        try:
            item, score, via = find_album(album)
            entry = {"album": album.get("title"), "artist": album.get("artist"), "score": score, "via": via}
            tracks = {}
            if item:
                entry["match"] = {
                    "collection": item.get("collectionName"),
                    "artist": item.get("artistName"),
                    "year": int((item.get("releaseDate") or "0")[:4] or 0) or None,
                    "collectionId": item.get("collectionId"),
                }
                it_tracks = fetch_tracks(item)
                tracks = map_to_positions(album.get("tracklist") or [], it_tracks)
                entry["itunesTracks"] = len(it_tracks)
            entry["tracks"] = tracks
            by_release[rid] = entry
        except Exception as err:  # noqa: BLE001 - ein Album darf den Lauf nicht stoppen
            print(f"   ! {label}: {err}", flush=True)
            by_release.setdefault(rid, {"tracks": {}, "error": str(err)[:200]})
        if by_release[rid].get("tracks"):
            matched += 1
            mark = f"{len(by_release[rid]['tracks'])} Tracks"
        else:
            missed += 1
            mark = "keine Vorschau"
        print(f"{i}/{len(todo)} · {label[:52]:<52} {mark}", flush=True)
        if i % SAVE_EVERY == 0:
            save_state(state, len(albums))
        time.sleep(DELAY)

    save_state(state, len(albums))
    total_matched = sum(1 for e in by_release.values() if e.get("tracks"))
    print(f"\nFertig: {total_matched} Alben mit Vorschau, {len(by_release) - total_matched} ohne · {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nAbgebrochen – Zwischenstand ist gespeichert.")
        sys.exit(130)
