#!/usr/bin/env python3
"""
Generates every launcher icon and splash asset for both platforms from one
definition, so the mark is identical everywhere and regenerating it is a
one-line command rather than a manual export from a design tool.

    python3 scripts/generate-icons.py

Requires Pillow (`pip install pillow`). It is a build-time tool only — nothing
in the shipped app depends on it.

The mark: two arrows circling each other — one shift going out, one coming
back. It reads at 48px, which is the size that actually matters on a launcher.
"""

from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent

# The brand palette, matching src/styles.css.
BRAND = (13, 110, 128)          # deep teal, the primary surface of the icon
BRAND_DEEP = (10, 82, 96)       # the darker end of the background gradient
INK_DARK = (15, 23, 42)         # splash background, matches capacitor.config.ts
WHITE = (255, 255, 255)

# Android adaptive icons are 108dp with only the middle 72dp guaranteed
# visible; the mark is drawn inside that safe circle.
ADAPTIVE_SAFE_FRACTION = 72 / 108


def draw_mark(canvas: Image.Image, size: int, scale: float = 1.0) -> None:
    """Draws the two-arrow switch mark, centred, scaled to `scale` of `size`."""
    layer = Image.new("RGBA", (size * 4, size * 4), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    big = size * 4
    centre = big / 2
    radius = big * 0.30 * scale
    thickness = big * 0.085 * scale
    head = big * 0.085 * scale

    # Two 150-degree arcs facing opposite directions, each ending in a head.
    for rotation in (0, 180):
        start = 20 + rotation
        end = 160 + rotation
        box = [
            centre - radius,
            centre - radius,
            centre + radius,
            centre + radius,
        ]
        draw.arc(box, start=start, end=end, fill=WHITE, width=int(thickness))

        # Arrowhead at the leading end of the arc, pointing along the tangent.
        angle = math.radians(end)
        tip_x = centre + radius * math.cos(angle)
        tip_y = centre + radius * math.sin(angle)
        tangent = angle + math.pi / 2
        points = []
        for offset in (0, 2 * math.pi / 3, 4 * math.pi / 3):
            points.append(
                (
                    tip_x + head * math.cos(tangent + offset),
                    tip_y + head * math.sin(tangent + offset),
                )
            )
        draw.polygon(points, fill=WHITE)

    canvas.alpha_composite(layer.resize((size, size), Image.LANCZOS))


def gradient_background(size: int, radius_fraction: float | None) -> Image.Image:
    """A vertical brand gradient, optionally with rounded or circular corners."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (size, size))
    pixels = gradient.load()
    assert pixels is not None
    for y in range(size):
        ratio = y / max(size - 1, 1)
        colour = tuple(
            int(BRAND[i] + (BRAND_DEEP[i] - BRAND[i]) * ratio) for i in range(3)
        )
        for x in range(size):
            pixels[x, y] = (*colour, 255)

    if radius_fraction is None:
        return gradient

    mask = Image.new("L", (size * 4, size * 4), 0)
    mask_draw = ImageDraw.Draw(mask)
    if radius_fraction >= 0.5:
        mask_draw.ellipse([0, 0, size * 4 - 1, size * 4 - 1], fill=255)
    else:
        mask_draw.rounded_rectangle(
            [0, 0, size * 4 - 1, size * 4 - 1],
            radius=int(size * 4 * radius_fraction),
            fill=255,
        )
    image.paste(gradient, (0, 0), mask.resize((size, size), Image.LANCZOS))
    return image


def square_icon(size: int, radius_fraction: float | None = 0.22) -> Image.Image:
    icon = gradient_background(size, radius_fraction)
    draw_mark(icon, size, scale=1.0)
    return icon


def adaptive_foreground(size: int) -> Image.Image:
    """Transparent, with the mark inside the guaranteed-visible safe circle."""
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_mark(icon, size, scale=ADAPTIVE_SAFE_FRACTION)
    return icon


def write(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "PNG")
    try:
        print(f"  {path.relative_to(ROOT)}")
    except ValueError:
        # Store assets live outside mobile/, in the repository's release/ dir.
        print(f"  {path.relative_to(ROOT.parent)}")


def generate_android() -> None:
    print("Android launcher icons")
    densities = {
        "mdpi": 1,
        "hdpi": 1.5,
        "xhdpi": 2,
        "xxhdpi": 3,
        "xxxhdpi": 4,
    }
    res = ROOT / "android/app/src/main/res"
    for density, factor in densities.items():
        legacy = int(48 * factor)
        write(
            square_icon(legacy),
            res / f"mipmap-{density}/ic_launcher.png",
        )
        write(
            square_icon(legacy, radius_fraction=0.5),
            res / f"mipmap-{density}/ic_launcher_round.png",
        )
        write(
            adaptive_foreground(int(108 * factor)),
            res / f"mipmap-{density}/ic_launcher_foreground.png",
        )

    print("Android splash")
    # The splash drawable is centred on a solid background by splash.xml, so a
    # single large mark on transparency scales cleanly to every screen.
    splash = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    draw_mark(splash, 1024, scale=0.55)
    for density, factor in densities.items():
        size = int(320 * factor)
        write(
            splash.resize((size, size), Image.LANCZOS),
            res / f"drawable-{density}/splash.png",
        )
    write(splash.resize((640, 640), Image.LANCZOS), res / "drawable/splash.png")


def generate_ios() -> None:
    print("iOS app icon")
    # Xcode 14+ takes a single 1024x1024 with no alpha channel; the system
    # generates every other size. An alpha channel is an App Store rejection.
    icon = square_icon(1024, radius_fraction=None).convert("RGB")
    write(
        icon,
        ROOT / "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
    )

    print("iOS splash")
    for name, size in (
        ("splash-2732x2732.png", 2732),
        ("splash-2732x2732-1.png", 2732),
        ("splash-2732x2732-2.png", 2732),
    ):
        splash = Image.new("RGB", (size, size), INK_DARK)
        overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw_mark(overlay, size, scale=0.22)
        splash.paste(overlay, (0, 0), overlay)
        write(
            splash,
            ROOT / "ios/App/App/Assets.xcassets/Splash.imageset" / name,
        )


def generate_store() -> None:
    print("Store listing assets")
    release = ROOT.parent / "release/assets"
    # Play Console: 512x512 32-bit PNG with alpha.
    write(square_icon(512, radius_fraction=None), release / "play-icon-512.png")
    # App Store Connect: 1024x1024, no alpha.
    write(
        square_icon(1024, radius_fraction=None).convert("RGB"),
        release / "app-store-icon-1024.png",
    )

    # Play Console feature graphic: 1024x500.
    feature = Image.new("RGBA", (1024, 500), (0, 0, 0, 0))
    gradient = gradient_background(1024, None).resize((1024, 1024), Image.LANCZOS)
    feature.paste(gradient.crop((0, 262, 1024, 762)), (0, 0))
    mark = Image.new("RGBA", (400, 400), (0, 0, 0, 0))
    draw_mark(mark, 400, scale=1.0)
    feature.alpha_composite(mark, (312, 50))
    write(feature.convert("RGB"), release / "play-feature-graphic-1024x500.png")


def main() -> None:
    os.chdir(ROOT)
    generate_android()
    generate_ios()
    generate_store()
    print("\nDone. Run `npx cap sync` to copy them into the native projects.")


if __name__ == "__main__":
    main()
