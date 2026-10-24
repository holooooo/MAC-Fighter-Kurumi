#!/usr/bin/env python3
"""Build the macOS application icon from the approved transparent idle drawing.

Writes assets/app-icon.png and assets/app-icon.icns. Requires Pillow and macOS
iconutil; no external downloads, fonts, original screenshots, or random input.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "kurumi-generated-idle.png"
PNG = ROOT / "assets" / "app-icon.png"
ICNS = ROOT / "assets" / "app-icon.icns"
SIZE = 1024
SCALE = 2  # antialias only the vector-like framing, not the source artwork


def rounded_mask() -> Image.Image:
    mask = Image.new("L", (SIZE * SCALE, SIZE * SCALE))
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        (64 * SCALE, 64 * SCALE, 960 * SCALE, 960 * SCALE),
        radius=190 * SCALE,
        fill=255,
    )
    return mask.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def render() -> Image.Image:
    source = Image.open(SOURCE).convert("RGBA")
    if source.size != (336, 452) or source.getchannel("A").getextrema() != (0, 255):
        raise ValueError("Unexpected canonical character image size or transparency")

    # An opaque, rose-lit plum tile remains legible even in a tiny Dock icon.
    tile = Image.new("RGBA", (SIZE, SIZE))
    draw = ImageDraw.Draw(tile)
    stops = ((0, (89, 43, 82)), (480, (52, 30, 65)), (1023, (21, 20, 42)))
    for y in range(SIZE):
        lo, hi = (stops[0], stops[1]) if y <= stops[1][0] else (stops[1], stops[2])
        t = (y - lo[0]) / (hi[0] - lo[0])
        rgb = tuple(round(a + (b - a) * t) for a, b in zip(lo[1], hi[1]))
        draw.line((0, y, SIZE, y), fill=(*rgb, 255))

    light = Image.new("RGBA", (SIZE, SIZE))
    ImageDraw.Draw(light).ellipse((232, 107, 792, 733), fill=(249, 119, 169, 175))
    tile = Image.alpha_composite(tile, light.filter(ImageFilter.GaussianBlur(83)))

    # One quiet orbit belongs behind the figure, never over the eyes.
    orbit = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE))
    ImageDraw.Draw(orbit).arc(
        (158 * SCALE, 157 * SCALE, 866 * SCALE, 865 * SCALE),
        194, 350, fill=(255, 170, 205, 64), width=8 * SCALE,
    )
    tile = Image.alpha_composite(tile, orbit.resize((SIZE, SIZE), Image.Resampling.LANCZOS))

    rim = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE))
    ImageDraw.Draw(rim).rounded_rectangle(
        (70 * SCALE, 70 * SCALE, 954 * SCALE, 954 * SCALE),
        radius=185 * SCALE, outline=(255, 198, 221, 156), width=5 * SCALE,
    )
    tile = Image.alpha_composite(tile, rim.resize((SIZE, SIZE), Image.Resampling.LANCZOS))

    # A portrait crop preserves the existing character design while making the
    # hair and eyes readable at 16px. The tile itself masks the lower silhouette.
    portrait = source.crop((49, 9, 286, 293))
    portrait = portrait.resize((818, 980), Image.Resampling.LANCZOS)
    position = (103, 98)
    shadow = Image.new("RGBA", portrait.size, (18, 9, 27, 0))
    shadow.putalpha(portrait.getchannel("A").filter(ImageFilter.GaussianBlur(21)).point(lambda a: a * 0.45))
    tile.alpha_composite(shadow, (position[0] + 8, position[1] + 15))
    tile.alpha_composite(portrait, position)
    tile.putalpha(ImageChops.multiply(tile.getchannel("A"), rounded_mask()))
    return tile


def build_iconset(png: Image.Image) -> None:
    with tempfile.TemporaryDirectory(prefix="kurumi-app-icon-") as directory:
        iconset = Path(directory) / "app-icon.iconset"
        iconset.mkdir()
        for logical in (16, 32, 128, 256, 512):
            for density in (1, 2):
                pixels = logical * density
                name = f"icon_{logical}x{logical}{'@2x' if density == 2 else ''}.png"
                png.resize((pixels, pixels), Image.Resampling.LANCZOS).save(iconset / name, optimize=True)
        subprocess.run(("iconutil", "--convert", "icns", "--output", str(ICNS), str(iconset)), check=True)


def main() -> None:
    png = render()
    png.save(PNG, optimize=True)
    build_iconset(png)
    print(f"Built {PNG.relative_to(ROOT)} ({SIZE}x{SIZE}) and {ICNS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
