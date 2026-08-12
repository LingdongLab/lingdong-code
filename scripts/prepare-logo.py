"""Remove outer black canvas from logo export; keep the white icon plate as-is.

Usage:
  python scripts/prepare-logo.py [source.png]
Default source: docs/assets/logo-source.png

Does NOT add an extra white background — only makes the surrounding black transparent.
"""
from __future__ import annotations

import sys
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SRC = ROOT / "docs" / "assets" / "logo-source.png"
OUT_TRANSPARENT = ROOT / "docs" / "assets" / "logo.png"
OUT_BRAND = ROOT / "packaging" / "brand" / "logo.png"

BG_MAX = 18


def main() -> None:
    src_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    img = Image.open(src_path).convert("RGBA")
    w, h = img.size
    px = img.load()

    visited = [[False] * h for _ in range(w)]
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        q.append((x, 0))
        q.append((x, h - 1))
    for y in range(h):
        q.append((0, y))
        q.append((w - 1, y))

    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or visited[x][y]:
            continue
        visited[x][y] = True
        r, g, b, _a = px[x, y]
        if r > BG_MAX or g > BG_MAX or b > BG_MAX:
            continue
        px[x, y] = (0, 0, 0, 0)
        q.append((x + 1, y))
        q.append((x - 1, y))
        q.append((x, y + 1))
        q.append((x, y - 1))

    bbox = img.getbbox()
    if bbox:
        pad = 8
        img = img.crop(
            (
                max(0, bbox[0] - pad),
                max(0, bbox[1] - pad),
                min(w, bbox[2] + pad),
                min(h, bbox[3] + pad),
            )
        )

    OUT_TRANSPARENT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT_TRANSPARENT, "PNG")
    OUT_BRAND.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT_BRAND, "PNG")

    # Drop obsolete white-card variant if present
    readme_card = ROOT / "docs" / "assets" / "logo-readme.png"
    if readme_card.exists():
        readme_card.unlink()

    print("source:", src_path)
    print("corner:", Image.open(OUT_TRANSPARENT).getpixel((0, 0)))
    print("wrote:", OUT_TRANSPARENT, OUT_BRAND)


if __name__ == "__main__":
    main()
