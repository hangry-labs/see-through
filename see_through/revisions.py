"""Filesystem helpers and validation for immutable layer revisions."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Iterable

from PIL import Image


BODY_PARTS = (
    "front hair",
    "back hair",
    "neck",
    "neckwear",
    "topwear",
    "handwear",
    "bottomwear",
    "legwear",
    "footwear",
    "tail",
    "wings",
    "objects",
)
HEAD_PARTS = (
    "headwear",
    "face",
    "irides",
    "eyebrow",
    "eyewhite",
    "eyelash",
    "eyewear",
    "ears",
    "earwear",
    "nose",
    "mouth",
)
CANONICAL_PARTS = BODY_PARTS + HEAD_PARTS
CANONICAL_PART_SET = frozenset(CANONICAL_PARTS)


def validate_replacement_parts(parts: Iterable[str]) -> list[str]:
    """Return unique canonical parts in display order or raise a clear error."""
    requested = {part.strip() for part in parts if part and part.strip()}
    invalid = sorted(requested - CANONICAL_PART_SET)
    if invalid:
        raise ValueError(f"unsupported replacement parts: {', '.join(invalid)}")
    if not requested:
        raise ValueError("select at least one part to regenerate")
    return [part for part in CANONICAL_PARTS if part in requested]


def prepare_hybrid_layers(
    parent_directory: Path,
    candidate_directory: Path,
    hybrid_directory: Path,
    replacement_parts: Iterable[str],
) -> None:
    """Build a clean raw-layer set from a parent and selected candidate layers."""
    parts = validate_replacement_parts(replacement_parts)
    source_image = parent_directory / "src_img.png"
    if not source_image.is_file():
        raise FileNotFoundError(f"parent source image is missing: {source_image}")

    if hybrid_directory.exists():
        shutil.rmtree(hybrid_directory)
    hybrid_directory.mkdir(parents=True)
    shutil.copy2(source_image, hybrid_directory / source_image.name)

    candidate_head = candidate_directory / "src_head.png"
    parent_head = parent_directory / "src_head.png"
    if candidate_head.is_file():
        shutil.copy2(candidate_head, hybrid_directory / candidate_head.name)
    elif parent_head.is_file():
        shutil.copy2(parent_head, hybrid_directory / parent_head.name)

    with Image.open(source_image) as source:
        canvas_size = source.size

    selected = set(parts)
    for part in CANONICAL_PARTS:
        source = candidate_directory / f"{part}.png" if part in selected else parent_directory / f"{part}.png"
        destination = hybrid_directory / f"{part}.png"
        if source.is_file():
            shutil.copy2(source, destination)
        else:
            Image.new("RGBA", canvas_size, (0, 0, 0, 0)).save(destination)


def layer_manifest(layer_directory: Path, job_id: str) -> list[dict[str, object]]:
    """Describe all canonical parts, including absent and fully transparent ones."""
    manifest: list[dict[str, object]] = []
    for part in CANONICAL_PARTS:
        path = layer_directory / f"{part}.png"
        available = path.is_file()
        visible = False
        pixel_count = 0
        size = 0
        if available:
            size = path.stat().st_size
            try:
                with Image.open(path).convert("RGBA") as image:
                    alpha = image.getchannel("A")
                    pixel_count = sum(alpha.histogram()[11:])
                    visible = pixel_count > 0
            except (OSError, ValueError):
                available = False
                visible = False
                pixel_count = 0
                size = 0
        manifest.append(
            {
                "name": part,
                "group": "body" if part in BODY_PARTS else "head",
                "available": available,
                "visible": visible,
                "pixel_count": pixel_count,
                "size": size,
                "url": (
                    f"/v1/layer-decompositions/{job_id}/assets/output/input/{part}.png"
                    if available
                    else None
                ),
            }
        )
    return manifest
