#!/usr/bin/env python3
"""Génère les icônes MyCraft (PNG multi-tailles + .ico) sans ImageMagick.

Le dessin est déterministe : relancer le script redonne exactement les mêmes
fichiers, ce qui garde les builds reproductibles.
"""
import random
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
GRID = 16  # taille du quadrillage « bloc » de référence

GRASS = [(0x5D, 0x9C, 0x3F), (0x74, 0xB6, 0x53), (0x47, 0x76, 0x2F), (0x8F, 0xCE, 0x6A)]
DIRT = [(0x79, 0x55, 0x3A), (0x5F, 0x40, 0x28), (0x8D, 0x6A, 0x49), (0x4A, 0x31, 0x20)]


def draw_block(size: int) -> Image.Image:
    rnd = random.Random(0x4D5943)  # MyCraft
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = size / GRID
    draw = ImageDraw.Draw(img)

    def cell(x, y, color):
        x0, y0 = round(x * px), round(y * px)
        x1, y1 = round((x + 1) * px), round((y + 1) * px)
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=color)

    for y in range(GRID):
        # Frange déchirée là où l'herbe rejoint la terre.
        fringe = 3 + rnd.randint(0, 2) if 3 <= y <= 5 else (4 if y < 3 else 0)
        for x in range(GRID):
            if y < fringe:
                tone = GRASS[0] if rnd.random() < 0.6 else rnd.choice(GRASS[1:])
            else:
                tone = DIRT[0] if rnd.random() < 0.6 else rnd.choice(DIRT[1:])
            cell(x, y, tone + (255,))

    # Liseré sombre : sans lui, l'icône se noie sur un fond clair de la barre des tâches.
    edge = max(1, size // 32)
    draw.rectangle([0, 0, size - 1, size - 1], outline=(20, 16, 10, 255), width=edge)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    targets = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512}
    for name, size in targets.items():
        draw_block(size).save(OUT / name)

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    base = draw_block(256)
    base.save(OUT / "icon.ico", sizes=[(s, s) for s in ico_sizes])
    print(f"icônes écrites dans {OUT} : {', '.join(list(targets) + ['icon.ico'])}")


if __name__ == "__main__":
    main()
