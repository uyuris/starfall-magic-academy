#!/usr/bin/env python3
"""Derive the canonical eight moon phase assets from one full-moon source."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image


OUTPUT_SIZE = 500
JPEG_QUALITY = 95
JPEG_SAVE_OPTIONS = {"optimize": True, "subsampling": 1}
SHADOW_LUMINANCE = 0.13
TERMINATOR_SOFTNESS_PX = 3.0
EDGE_SOFTNESS_PX = 1.5

PHASES = (
    {"index": 0, "name": "new moon", "kind": "new"},
    {"index": 1, "name": "waxing crescent", "kind": "crescent", "sun_side": 1, "angle": 3 * math.pi / 4},
    {"index": 2, "name": "first quarter", "kind": "quarter", "sun_side": 1, "angle": math.pi / 2},
    {"index": 3, "name": "waxing gibbous", "kind": "gibbous", "sun_side": 1, "angle": math.pi / 4},
    {"index": 4, "name": "full moon", "kind": "full"},
    {"index": 5, "name": "waning gibbous", "kind": "gibbous", "sun_side": -1, "angle": math.pi / 4},
    {"index": 6, "name": "last quarter", "kind": "quarter", "sun_side": -1, "angle": math.pi / 2},
    {"index": 7, "name": "waning crescent", "kind": "crescent", "sun_side": -1, "angle": 3 * math.pi / 4},
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("master", type=Path, help="Full-moon source image.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("assets/canonical/moon_phases"),
        help="Directory for phase_0.jpg through phase_7.jpg.",
    )
    parser.add_argument(
        "--center-x",
        type=float,
        default=628.0,
        help="Measured moon-disc center X in the master source image.",
    )
    parser.add_argument(
        "--center-y",
        type=float,
        default=603.0,
        help="Measured moon-disc center Y in the master source image.",
    )
    parser.add_argument(
        "--radius",
        type=float,
        default=356.0,
        help="Measured moon-disc radius in the master source image.",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if not args.master.is_file():
        raise ValueError(f"master image does not exist: {args.master}")
    if args.radius <= 0:
        raise ValueError("--radius must be greater than 0")


def average_corner_color(image: Image.Image, sample: int = 16) -> tuple[int, int, int]:
    width, height = image.size
    pixels = image.load()
    totals = [0, 0, 0]
    count = 0
    for x_start, y_start in ((0, 0), (width - sample, 0), (0, height - sample), (width - sample, height - sample)):
        for y in range(max(0, y_start), min(height, y_start + sample)):
            for x in range(max(0, x_start), min(width, x_start + sample)):
                r, g, b = pixels[x, y]
                totals[0] += r
                totals[1] += g
                totals[2] += b
                count += 1
    if count == 0:
        raise ValueError("cannot sample source background color")
    return tuple(round(channel / count) for channel in totals)


def normalize_master(
    path: Path,
    center_x: float,
    center_y: float,
    radius: float,
) -> tuple[Image.Image, float]:
    source = Image.open(path).convert("RGB")
    width, height = source.size
    if center_x < 0 or center_x > width or center_y < 0 or center_y > height:
        raise ValueError(
            f"moon center ({center_x}, {center_y}) is outside source bounds {width}x{height}"
        )

    side = max(width, height)
    background = average_corner_color(source)
    square = Image.new("RGB", (side, side), background)
    source_left = (side - width) // 2
    source_top = (side - height) // 2
    square.paste(source, (source_left, source_top))

    center_x += source_left
    center_y += source_top
    target_center = side / 2
    shift_x = round(target_center - center_x)
    shift_y = round(target_center - center_y)
    shifted = Image.new("RGB", (side, side), background)
    shifted.paste(square, (shift_x, shift_y))

    normalized = shifted.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.Resampling.LANCZOS)
    normalized_radius = radius * OUTPUT_SIZE / side
    return normalized, normalized_radius


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    if edge0 == edge1:
        return 1.0 if value >= edge1 else 0.0
    t = (value - edge0) / (edge1 - edge0)
    t = max(0.0, min(1.0, t))
    return t * t * (3.0 - 2.0 * t)


def moon_edge_alpha(distance: float, radius: float) -> float:
    return smoothstep(radius + EDGE_SOFTNESS_PX, radius - EDGE_SOFTNESS_PX, distance)


def light_weight_for_phase(phase: dict[str, object], nx: float, ny: float, radius: float) -> float:
    kind = phase["kind"]
    if kind == "full":
        return 1.0
    if kind == "new":
        return 0.0

    z_squared = 1.0 - nx * nx - ny * ny
    if z_squared <= 0.0:
        z = 0.0
    else:
        z = math.sqrt(z_squared)

    sun_side = float(phase["sun_side"])
    angle = float(phase["angle"])
    field = sun_side * nx * math.sin(angle) + z * math.cos(angle)
    softness = TERMINATOR_SOFTNESS_PX / radius
    return smoothstep(-softness, softness, field)


def darken_pixel(channel: int, shadow_amount: float) -> int:
    factor = 1.0 - shadow_amount * (1.0 - SHADOW_LUMINANCE)
    return max(0, min(255, round(channel * factor)))


def derive_phase(master: Image.Image, radius: float, phase: dict[str, object]) -> Image.Image:
    output = master.copy()
    pixels = output.load()
    center = (OUTPUT_SIZE - 1) / 2

    for y in range(OUTPUT_SIZE):
        dy = y - center
        for x in range(OUTPUT_SIZE):
            dx = x - center
            distance = math.hypot(dx, dy)
            edge_alpha = moon_edge_alpha(distance, radius)
            if edge_alpha <= 0.0:
                continue

            nx = dx / radius
            ny = dy / radius
            light_weight = light_weight_for_phase(phase, nx, ny, radius)
            shadow_amount = (1.0 - light_weight) * edge_alpha
            if shadow_amount <= 0.0:
                continue

            r, g, b = pixels[x, y]
            pixels[x, y] = (
                darken_pixel(r, shadow_amount),
                darken_pixel(g, shadow_amount),
                darken_pixel(b, shadow_amount),
            )

    return output


def save_jpeg(image: Image.Image, path: Path) -> None:
    image.save(path, "JPEG", quality=JPEG_QUALITY, **JPEG_SAVE_OPTIONS)


def main() -> None:
    args = parse_args()
    validate_args(args)
    normalized, radius = normalize_master(args.master, args.center_x, args.center_y, args.radius)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    for phase in PHASES:
        image = normalized if phase["kind"] == "full" else derive_phase(normalized, radius, phase)
        output_path = args.output_dir / f"phase_{phase['index']}.jpg"
        save_jpeg(image, output_path)
        print(f"wrote {output_path} ({phase['name']})")


if __name__ == "__main__":
    main()
