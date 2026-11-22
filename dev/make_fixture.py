#!/usr/bin/env python3
"""Erzeugt rein synthetische Demo-Daten (keine Discogs-Inhalte) fuer UI-Tests.

Schreibt web/collection.json mit meta.fixture = true und ein paar generierte
Cover nach web/covers/. Ein echter `python sync.py` ueberschreibt beides.
"""

from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from sync import dominant_colors  # noqa: E402  (gleiche Farb-Logik wie beim Sync)

WEB = ROOT / "web"
COVERS = WEB / "covers"

ARTISTS = [
    "Nova Kestrel", "Vela Sound System", "Marlowe Quartet", "Seabird Trio",
    "Hollow Coast", "Ivan Petrov Ensemble", "The Lantern Club", "Sable & Ash",
    "Fenwick Drive", "Aster Vale", "Kite Museum", "Low Tide Orchestra",
    "Marisol Vega", "Northbound Express", "Pale Harbour", "Quiet Machines",
    "Ravel Street Band", "Solstice Unit", "Tessa Marlowe", "Umbra Collective",
    "Velvet Ferry", "Westward Bloom", "Yara Lindqvist", "Zone Libre",
]
TITLES = [
    "Slow Weather", "Midnight Ledger", "Copper Rooms", "Paper Lanterns",
    "Under Glass", "Long Division", "Salt & Static", "Evening Ferry",
    "Blue Hour Tapes", "The Quiet Part", "Signal Gardens", "Low Ceilings",
    "After the Rain", "Velvet Corridor", "Night Bus Home", "Small Hours",
    "Glasshouse", "Radio Silence", "Warm Static", "Field Notes",
    "Riverlight", "Static Bloom", "Late Arrivals", "Open Windows",
]
GENRES = [("Electronic", "House"), ("Jazz", "Post Bop"), ("Rock", "Indie Rock"),
          ("Soul", "Neo Soul"), ("Folk, World, & Country", "Folk"),
          ("Funk / Soul", "Disco"), ("Electronic", "Downtempo"), ("Hip Hop", "Instrumental")]
LABELS = ["Quiet Harbour", "Northline", "Lantern Records", "Pale Blue", "Static Field", "Marlowe Music"]
COUNTRIES = ["Germany", "UK", "Europe", "US", "Netherlands", "France"]


def make_cover(path: Path, hue_a: float, hue_b: float) -> None:
    w = h = 640
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = (x / w * 0.6 + y / h * 0.4)
            hue = (hue_a + (hue_b - hue_a) * t) % 360
            light = 0.28 + 0.34 * (1 - abs(t - 0.5) * 1.4)
            hh = hue / 360
            c = 0.28 * light
            # einfache HSL->RGB
            import colorsys
            r, g, b = colorsys.hls_to_rgb(hh, light, 0.42)
            px[x, y] = (int(r * 255), int(g * 255), int(b * 255))
    draw = ImageDraw.Draw(img, "RGBA")
    rnd = random.Random(int(hue_a * 13))
    for _ in range(5):
        cx, cy = rnd.randint(0, w), rnd.randint(0, h)
        rad = rnd.randint(70, 260)
        tone = rnd.choice([(255, 255, 255, 32), (0, 0, 0, 46), (255, 240, 220, 26)])
        draw.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=tone)
    for i in range(9):
        y = int(h * (0.12 + i * 0.09))
        draw.line([(0, y), (w, y + rnd.randint(-6, 6))], fill=(255, 255, 255, 18), width=2)
    img = img.filter(ImageFilter.GaussianBlur(1.2))
    img.save(path, "JPEG", quality=88, optimize=True)


def main() -> None:
    COVERS.mkdir(parents=True, exist_ok=True)
    rnd = random.Random(7)
    albums = []
    for i, (artist, title) in enumerate(zip(ARTISTS, TITLES)):
        genre, style = GENRES[i % len(GENRES)]
        label = LABELS[i % len(LABELS)]
        year = rnd.choice([0, 1974, 1979, 1983, 1988, 1994, 1999, 2003, 2011, 2016, 2019, 2022])
        cover = None
        colors = ["#33333d", "#222228", "#3f3f4b"]
        if i not in (5, 17):  # zwei Alben ohne Cover
            name = f"demo-{i:02d}.jpg"
            make_cover(COVERS / name, rnd.uniform(0, 360), (rnd.uniform(0, 360)) % 360)
            cover = f"covers/{name}"
            with Image.open(COVERS / name) as img:
                colors = dominant_colors(img)
        tracks = []
        if i != 11:  # ein Album ohne Tracklist
            for n in range(rnd.randint(4, 6)):
                tracks.append({
                    "position": f"{'AB'[n % 2]}{n + 1}",
                    "title": f"{rnd.choice(['Slow', 'Night', 'Paper', 'Copper', 'Quiet', 'Open'])} "
                             f"{rnd.choice(['Weather', 'Rooms', 'Ferry', 'Lanterns', 'Static'])} {n + 1}",
                    "duration": f"{rnd.randint(2, 6)}:{rnd.randint(10, 58):02d}",
                })
        albums.append({
            "instance_id": 900000 + i,
            "release_id": 500000 + i,
            "artist": artist,
            "title": title,
            "year": year,
            "labels": [{"name": label, "catno": f"QH-{rnd.randint(100, 999)}"}],
            "label": label,
            "catno": f"QH-{rnd.randint(100, 999)}",
            "genres": [genre],
            "styles": [style],
            "country": rnd.choice(COUNTRIES),
            "formats": [{"name": "Vinyl", "qty": "1", "descriptions": ["LP", "Album", "33 ⅓ RPM"]}],
            "format": "Vinyl · LP · Album · 33 ⅓ RPM",
            "added": f"2026-0{rnd.randint(1, 9)}-{rnd.randint(10, 28)}T12:00:00-08:00",
            "rating": 0,
            "cover": cover,
            "colors": colors,
            "tracklist": tracks,
            "notes": "",
            "discogs_url": f"https://www.discogs.com/release/{500000 + i}",
        })

    WEB.mkdir(parents=True, exist_ok=True)
    (WEB / "collection.json").write_text(json.dumps({
        "meta": {"schema": 1, "username": "demo", "generated_at": "2026-11-21T18:00:00+0100",
                 "count": len(albums), "fixture": True,
                 "stats": {"without_year": 1, "without_cover": 2, "without_tracklist": 1}},
        "albums": albums,
    }, ensure_ascii=False), encoding="utf-8")
    print(f"Demo-Daten: {len(albums)} Alben -> {WEB / 'collection.json'}")


if __name__ == "__main__":
    main()
