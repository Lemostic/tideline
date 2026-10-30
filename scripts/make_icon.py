"""生成潮线 tideline 的应用图标（1024×1024 PNG）。

用法：python scripts/make_icon.py branding/icon.png
依赖：Pillow
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
RADIUS = 232


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "branding/icon.png")
    out.parent.mkdir(parents=True, exist_ok=True)

    # 圆角矩形内的斜向渐变
    base = Image.new("RGB", (SIZE, SIZE), "#0f766e")
    top = (24, 148, 136)
    bottom = (9, 84, 79)
    for y in range(SIZE):
        for x in range(0, SIZE, 4):
            t = min(1.0, max(0.0, (x + y) / (SIZE * 2)))
            color = lerp(top, bottom, t)
            ImageDraw.Draw(base).rectangle([x, y, x + 4, y + 1], fill=color)

    # 柔光
    glow = Image.new("L", (SIZE, SIZE), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([180, 80, 900, 700], fill=90)
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    base = Image.composite(Image.new("RGB", (SIZE, SIZE), "#48c9b8"), base, glow)

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=255)

    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)
    draw = ImageDraw.Draw(icon, "RGBA")

    # 三条潮汐线
    def wave(cy: float, amplitude: float, width: int, alpha: int) -> None:
        points = []
        for i in range(0, SIZE + 1, 6):
            t = i / SIZE
            y = cy + amplitude * math.sin(t * math.tau * 1.15 + 0.6)
            points.append((i, y))
        draw.line(points, fill=(255, 255, 255, alpha), width=width, joint="curve")
        # 圆头
        for px, py in (points[0], points[-1]):
            r = width / 2
            draw.ellipse([px - r, py - r, px + r, py + r], fill=(255, 255, 255, alpha))

    wave(360, 46, 52, 255)
    wave(520, 46, 46, 225)
    wave(680, 46, 40, 170)

    icon.save(out)
    print(f"icon written: {out} ({icon.size[0]}x{icon.size[1]})")


if __name__ == "__main__":
    main()
