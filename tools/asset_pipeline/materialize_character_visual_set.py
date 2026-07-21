#!/usr/bin/env python3
"""Materialize a canonical character visual set from generated source images."""

from __future__ import annotations

import argparse
import hashlib
import json
from io import BytesIO
from pathlib import Path

from PIL import Image


EMOTIONS = [
    "neutral",
    "joy",
    "caring",
    "confident",
    "sadness",
    "anger",
    "worried",
    "surprised",
    "embarrassed",
    "shy",
    "serious",
    "determined",
    "smug",
    "tired",
    "panic",
    "sick",
]

FACE_SIZE = 500
SHEET_SIZE = FACE_SIZE * 4
DEFAULT_SOURCE_PATH = "../../source_images/{visual_set_id}_emotion16_source_sheet.jpg"
JPEG_QUALITY_LADDER = (95, 90, 85, 80)
JPEG_SAVE_OPTIONS = {"optimize": True, "subsampling": 1}
JPEG_FLATTEN_BACKGROUND = (255, 255, 255)
DEFAULT_NEGATIVE = (
    "No text, labels, watermark, extra characters, scenery in face cells, UI, "
    "photorealism, placeholder art, flat vector styling, or simple cartoon styling."
)


STANDEE_DEFAULT_VARIANT_ID = "standee_character_01"
STANDEE_DEFAULT_SIZE = 1254

# (CLI flag, attribute) pairs for every standee-only argument. In face-only mode
# any of these being specified is a fail-fast conflict; in standee mode the
# required subset must be present.
STANDEE_ARGS = (
    ("--standee-full-scene", "standee_full_scene"),
    ("--standee-variant-id", "standee_variant_id"),
    ("--standee-size", "standee_size"),
    ("--standee-variation-basis", "standee_variation_basis"),
    ("--standee-prompt-summary", "standee_prompt_summary"),
)
STANDEE_REQUIRED_ARGS = (
    ("--standee-full-scene", "standee_full_scene"),
    ("--standee-variation-basis", "standee_variation_basis"),
    ("--standee-prompt-summary", "standee_prompt_summary"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--visual-set-id", required=True)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--emotion-sheet", required=True, type=Path)
    parser.add_argument(
        "--face-only",
        action="store_true",
        help="Materialize a face-only visual set (16 emotion crops + base, no standee).",
    )
    parser.add_argument("--standee-full-scene", type=Path)
    parser.add_argument("--standee-variant-id")
    parser.add_argument("--standee-size", type=int)
    parser.add_argument("--source-path")
    parser.add_argument("--normalized-source-out", type=Path)
    parser.add_argument("--role", required=True)
    parser.add_argument("--identity-lock", required=True)
    parser.add_argument("--characteristic-prop", required=True)
    parser.add_argument("--standee-variation-basis")
    parser.add_argument("--source-prompt-summary", required=True)
    parser.add_argument("--standee-prompt-summary")
    parser.add_argument("--negative-prompt-summary", default=DEFAULT_NEGATIVE)
    args = parser.parse_args()
    validate_mode(parser, args)
    return args


def validate_mode(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    if args.face_only:
        specified = [flag for flag, attr in STANDEE_ARGS if getattr(args, attr) is not None]
        if specified:
            parser.error(
                "--face-only visual sets have no standee; remove the standee "
                f"argument(s): {', '.join(specified)}"
            )
        return
    missing = [flag for flag, attr in STANDEE_REQUIRED_ARGS if getattr(args, attr) is None]
    if missing:
        parser.error(
            "the following arguments are required without --face-only: "
            f"{', '.join(missing)}"
        )
    if args.standee_variant_id is None:
        args.standee_variant_id = STANDEE_DEFAULT_VARIANT_ID
    if args.standee_size is None:
        args.standee_size = STANDEE_DEFAULT_SIZE


def scene_standee_id(standee_variant_id: str) -> str:
    text = standee_variant_id.strip()
    if not text.startswith("standee_character_"):
        raise ValueError(f"invalid standee variant id: {standee_variant_id}")
    suffix = text.removeprefix("standee_character_")
    if not suffix.isdigit():
        raise ValueError(f"invalid standee variant id: {standee_variant_id}")
    return f"scene_standee_character_{suffix}"


def ensure_clean_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    for child in path.iterdir():
        if child.is_dir():
            for nested in sorted(child.rglob("*"), reverse=True):
                if nested.is_file() or nested.is_symlink():
                    nested.unlink()
                elif nested.is_dir():
                    nested.rmdir()
            child.rmdir()
        else:
            child.unlink()


def center_crop_square(image: Image.Image) -> Image.Image:
    width, height = image.size
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    return image.crop((left, top, left + side, top + side))


def load_normalized_sheet(path: Path) -> Image.Image:
    image = Image.open(path).convert("RGBA")
    if image.size[0] != image.size[1]:
        image = center_crop_square(image)
    if image.size != (SHEET_SIZE, SHEET_SIZE):
        image = image.resize((SHEET_SIZE, SHEET_SIZE), Image.Resampling.LANCZOS)
    return image


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def flatten_to_rgb(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, (*JPEG_FLATTEN_BACKGROUND, 255))
    background.alpha_composite(rgba)
    return background.convert("RGB")


def encoded_jpeg_bytes(image: Image.Image, quality: int = JPEG_QUALITY_LADDER[0]) -> bytes:
    buffer = BytesIO()
    flatten_to_rgb(image).save(buffer, "JPEG", quality=quality, **JPEG_SAVE_OPTIONS)
    return buffer.getvalue()


def save_jpeg(image: Image.Image, path: Path) -> None:
    path.write_bytes(encoded_jpeg_bytes(image))


def encoded_standee_jpeg_bytes(standee: Image.Image) -> bytes:
    png_buffer = BytesIO()
    standee.save(png_buffer, "PNG")
    png_size = len(png_buffer.getvalue())
    candidates = [(quality, encoded_jpeg_bytes(standee, quality=quality)) for quality in JPEG_QUALITY_LADDER]
    for _quality, jpg_bytes in candidates:
        if len(jpg_bytes) < png_size:
            return jpg_bytes
    return candidates[-1][1]


def emotion_mapping() -> dict[str, dict[str, int]]:
    mapping = {}
    for index, emotion in enumerate(EMOTIONS):
        row = index // 4
        col = index % 4
        left = col * FACE_SIZE
        top = row * FACE_SIZE
        mapping[emotion] = {
            "row": row + 1,
            "col": col + 1,
            "x": left,
            "y": top,
            "w": FACE_SIZE,
            "h": FACE_SIZE,
        }
    return mapping


def slice_faces(
    sheet: Image.Image,
    output_dir: Path,
) -> tuple[list[dict[str, object]], dict[str, dict[str, int]]]:
    face_dir = output_dir / "face_emotions"
    base_dir = output_dir / "face"
    face_dir.mkdir(parents=True, exist_ok=True)
    base_dir.mkdir(parents=True, exist_ok=True)

    variants = []
    for index, emotion in enumerate(EMOTIONS):
        row = index // 4
        col = index % 4
        left = col * FACE_SIZE
        top = row * FACE_SIZE
        crop_box = (left, top, left + FACE_SIZE, top + FACE_SIZE)
        cell = sheet.crop(crop_box)
        if cell.size != (FACE_SIZE, FACE_SIZE):
            cell = cell.resize((FACE_SIZE, FACE_SIZE), Image.Resampling.LANCZOS)
        out_path = face_dir / f"{emotion}.jpg"
        save_jpeg(cell, out_path)
        variants.append(
            {
                "id": f"face_{emotion}",
                "emotion": emotion,
                "path": f"face_emotions/{emotion}.jpg",
                "source_cell": {"row": row + 1, "col": col + 1},
                "sha256": sha256_file(out_path),
            }
        )

    neutral_path = face_dir / "neutral.jpg"
    base_path = base_dir / "base.jpg"
    base_path.write_bytes(neutral_path.read_bytes())
    return variants, emotion_mapping()


def write_standee(standee: Image.Image, args: argparse.Namespace, output_dir: Path) -> dict[str, str]:
    standee_dir = output_dir / "scene_standee"
    standee_dir.mkdir(parents=True, exist_ok=True)
    standee_id = scene_standee_id(args.standee_variant_id)
    standee_filename = f"{standee_id}.jpg"
    standee_path = standee_dir / standee_filename
    standee_path.write_bytes(encoded_standee_jpeg_bytes(standee))
    return {
        "id": standee_id,
        "path": f"scene_standee/{standee_filename}",
        "sha256": sha256_file(standee_path),
    }


def fit_full_scene_square(image: Image.Image, size: int) -> Image.Image:
    scene = center_crop_square(image.convert("RGB"))
    if scene.size != (size, size):
        scene = scene.resize((size, size), Image.Resampling.LANCZOS)
    return scene


def materialize_full_scene_standee(args: argparse.Namespace, output_dir: Path) -> dict[str, str]:
    source = Image.open(args.standee_full_scene)
    standee = fit_full_scene_square(source, args.standee_size)
    return write_standee(standee, args, output_dir)


def write_identity_notes(args: argparse.Namespace, output_dir: Path) -> None:
    lines = [
        f"# {args.visual_set_id} Identity Notes",
        "",
        f"- Role: {args.role}",
        f"- Identity lock: {args.identity_lock}",
        f"- Characteristic prop/accessory: {args.characteristic_prop}",
    ]
    if args.face_only:
        lines.append(
            "- Style target: warm Magic Academy ADV visual-novel anime, clean cel shading with crisp color fills and light shading accents, bold clean linework, calm anime eyes, slightly stylized youthful proportions, identity motifs preserved crisply."
        )
        lines.append(
            "- Consistency requirement: emotion sheet preserves face structure, hair silhouette/color, costume language, palette, line weight, and rendering density."
        )
    else:
        lines.append(f"- Standee variation basis: {args.standee_variation_basis}")
        lines.append(
            "- Style target: warm Magic Academy ADV visual-novel anime, clean cel shading with crisp color fills and light shading accents, bold clean linework, calm anime eyes, slightly stylized youthful proportions, identity motifs preserved crisply."
        )
        lines.append(
            "- Consistency requirement: emotion sheet and all standees preserve face structure, hair silhouette/color, costume language, palette, line weight, and rendering density."
        )
    (output_dir / "identity_notes.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_manifest(
    args: argparse.Namespace,
    output_dir: Path,
    variants: list[dict[str, object]],
    face_mapping: dict[str, dict[str, int]],
    standee: dict[str, str] | None,
) -> None:
    source_path = args.source_path or DEFAULT_SOURCE_PATH.format(visual_set_id=args.visual_set_id)
    if standee is None:
        generation_notes = {
            "source_prompt_summary": args.source_prompt_summary,
            "negative_prompt_summary": args.negative_prompt_summary,
            "identity_consistency_checks": [
                "Same identity text anchor used across the emotion source sheet.",
                "Emotion crops were sliced from fixed 500x500 row-major grid offsets after 2000x2000 normalization.",
            ],
        }
    else:
        generation_notes = {
            "source_prompt_summary": args.source_prompt_summary,
            "standee_prompt_summary": args.standee_prompt_summary,
            "negative_prompt_summary": args.negative_prompt_summary,
            "identity_consistency_checks": [
                "Same identity text anchor used for emotion source sheet and standee source.",
                "Emotion crops were sliced from fixed 500x500 row-major grid offsets after 2000x2000 normalization.",
                "Set contact sheet, emotion grid, and scene standee preview generated for visual review.",
            ],
        }
    manifest = {
        "visual_set_id": args.visual_set_id,
        "character_assignment": None,
        "source_sheet": {
            "path": source_path,
            "width": SHEET_SIZE,
            "height": SHEET_SIZE,
            "grid": {
                "columns": 4,
                "rows": 4,
                "cell_width": FACE_SIZE,
                "cell_height": FACE_SIZE,
            },
            "emotion_cell_mapping": face_mapping,
        },
        "base_face": {
            "id": "face_base",
            "emotion": "neutral",
            "path": "face/base.jpg",
        },
        "face_emotion_variants": variants,
        "generation_notes": generation_notes,
    }
    if standee is not None:
        manifest["scene_standee"] = standee
    (output_dir / "manifest.json").write_text(f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    output_dir = args.output_dir
    ensure_clean_dir(output_dir)

    sheet = load_normalized_sheet(args.emotion_sheet)
    if args.normalized_source_out:
        args.normalized_source_out.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(args.normalized_source_out)

    variants, face_mapping = slice_faces(sheet, output_dir)
    standee = None if args.face_only else materialize_full_scene_standee(args, output_dir)
    write_manifest(args, output_dir, variants, face_mapping, standee)
    write_identity_notes(args, output_dir)


if __name__ == "__main__":
    main()
