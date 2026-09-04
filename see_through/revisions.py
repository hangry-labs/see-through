"""Filesystem helpers and validation for immutable layer revisions."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Iterable

import numpy as np
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


def validate_edit_part(part: str) -> str:
    """Validate the one semantic layer supported by a detail-edit revision."""
    normalized = part.strip()
    if normalized not in CANONICAL_PART_SET:
        raise ValueError(f"unsupported edit part: {normalized or part}")
    return normalized


def available_layer_order(layer_directory: Path) -> list[str]:
    """Return the semantic layers represented by a completed PSD metadata file."""
    metadata_path = layer_directory.parent / f"{layer_directory.name}.psd.json"
    if not metadata_path.is_file():
        raise FileNotFoundError(f"layer metadata is missing: {metadata_path}")
    payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    parts = payload.get("parts")
    if not isinstance(parts, dict):
        raise ValueError("layer metadata does not contain a parts object")
    available = [name for name in parts if name in CANONICAL_PART_SET]
    if not available:
        raise ValueError("layer metadata does not contain any reorderable layers")
    return available


def validate_layer_order(order: Iterable[str], available: Iterable[str]) -> list[str]:
    """Validate a complete, front-to-back permutation of the available layers."""
    requested = [part.strip() for part in order if part and part.strip()]
    if len(requested) != len(set(requested)):
        raise ValueError("layer order must not contain duplicates")
    invalid = sorted(set(requested) - CANONICAL_PART_SET)
    if invalid:
        raise ValueError(f"unsupported layers in order: {', '.join(invalid)}")
    expected = list(available)
    missing = sorted(set(expected) - set(requested))
    extra = sorted(set(requested) - set(expected))
    if missing or extra or len(requested) != len(expected):
        details = []
        if missing:
            details.append(f"missing {', '.join(missing)}")
        if extra:
            details.append(f"unexpected {', '.join(extra)}")
        raise ValueError("layer order must include every visible layer exactly once" + (f": {'; '.join(details)}" if details else ""))
    return requested


def _premultiplied_restore(base: Image.Image, source: Image.Image, mask: Image.Image) -> Image.Image:
    """Blend source into base using a soft mask without introducing RGB fringes."""
    base_uint8 = np.asarray(base.convert("RGBA"), dtype=np.uint8)
    source_uint8 = np.asarray(source.convert("RGBA"), dtype=np.uint8)
    mask_uint8 = np.asarray(mask.convert("L"), dtype=np.uint8)[..., None]
    base_array = base_uint8.astype(np.float32) / 255.0
    source_array = source_uint8.astype(np.float32) / 255.0
    mask_array = mask_uint8.astype(np.float32) / 255.0

    base_alpha = base_array[..., 3:4]
    source_alpha = source_array[..., 3:4]
    output_alpha = base_alpha * (1.0 - mask_array) + source_alpha * mask_array
    output_rgb_premultiplied = (
        base_array[..., :3] * base_alpha * (1.0 - mask_array)
        + source_array[..., :3] * source_alpha * mask_array
    )
    output_rgb = np.divide(
        output_rgb_premultiplied,
        output_alpha,
        out=np.zeros_like(output_rgb_premultiplied),
        where=output_alpha > 0,
    )
    output = np.rint(np.clip(np.concatenate((output_rgb, output_alpha), axis=2), 0, 1) * 255).astype(np.uint8)
    output = np.where(mask_uint8 == 0, base_uint8, output)
    output = np.where(mask_uint8 == 255, source_uint8, output)
    return Image.fromarray(output, "RGBA")


def prepare_detail_edit(
    parent_directory: Path,
    edited_directory: Path,
    part: str,
    mask_path: Path,
) -> bool:
    """Apply an absolute restoration mask and report whether fresh depth is needed."""
    part = validate_edit_part(part)
    source_path = parent_directory / "src_img.png"
    current_layer_path = parent_directory / f"{part}.png"
    if not source_path.is_file():
        raise FileNotFoundError(f"parent source image is missing: {source_path}")
    if not current_layer_path.is_file():
        raise FileNotFoundError(f"parent layer is missing: {current_layer_path}")
    if edited_directory.exists():
        raise FileExistsError(f"edit destination already exists: {edited_directory}")

    shutil.copytree(parent_directory, edited_directory, ignore=shutil.ignore_patterns("optimized"))
    base_directory = edited_directory / "edit_base"
    masks_directory = edited_directory / "edit_masks"
    base_directory.mkdir(exist_ok=True)
    masks_directory.mkdir(exist_ok=True)
    base_path = base_directory / f"{part}.png"
    inherited_base = parent_directory / "edit_base" / f"{part}.png"
    shutil.copy2(inherited_base if inherited_base.is_file() else current_layer_path, base_path)

    with (
        Image.open(source_path).convert("RGBA") as source,
        Image.open(base_path).convert("RGBA") as base,
        Image.open(current_layer_path).convert("RGBA") as current,
        Image.open(mask_path).convert("L") as mask,
    ):
        if source.size != base.size or current.size != base.size or mask.size != base.size:
            raise ValueError(
                "source, current layer, base layer, and edit mask dimensions must match; got "
                f"source={source.size}, current={current.size}, base={base.size}, mask={mask.size}"
            )
        output = _premultiplied_restore(base, source, mask)
        normalized_mask_path = masks_directory / f"{part}.png"
        mask.save(normalized_mask_path, format="PNG")
        output.save(edited_directory / f"{part}.png", format="PNG")

        current_alpha = np.asarray(current.getchannel("A"), dtype=np.uint8)
        output_alpha = np.asarray(output.getchannel("A"), dtype=np.uint8)
        mask_array = np.asarray(mask, dtype=np.uint8)
        existing = current_alpha > 10
        newly_visible = (mask_array > 0) & (output_alpha > 10) & ~existing
        depth_path = edited_directory / f"{part}_depth.png"
        requires_depth_recalculation = bool(np.any(newly_visible)) or (
            bool(np.any(output_alpha > 10)) and not depth_path.is_file()
        )
        if depth_path.is_file():
            with Image.open(depth_path).convert("L") as depth:
                if depth.size != base.size:
                    raise ValueError(f"layer and depth dimensions must match for {part}")
                depth_array = np.asarray(depth, dtype=np.uint8).copy()
            fallback_depth = int(np.median(depth_array[existing])) if np.any(existing) else 255
            depth_array[newly_visible] = fallback_depth
            Image.fromarray(depth_array, "L").save(depth_path, format="PNG")
        return requires_depth_recalculation


def prepare_depth_revision(parent_directory: Path, revised_directory: Path) -> None:
    """Copy an accepted raw layer set before recalculating all of its depth maps."""
    if not parent_directory.is_dir():
        raise FileNotFoundError(f"parent layer directory is missing: {parent_directory}")
    if revised_directory.exists():
        raise FileExistsError(f"depth revision destination already exists: {revised_directory}")
    shutil.copytree(parent_directory, revised_directory, ignore=shutil.ignore_patterns("optimized"))


def prepare_order_revision(parent_directory: Path, revised_directory: Path) -> None:
    """Copy an accepted raw layer set before rebuilding it with a manual stack."""
    if not parent_directory.is_dir():
        raise FileNotFoundError(f"parent layer directory is missing: {parent_directory}")
    if revised_directory.exists():
        raise FileExistsError(f"order revision destination already exists: {revised_directory}")
    shutil.copytree(parent_directory, revised_directory, ignore=shutil.ignore_patterns("optimized"))


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

    for state_directory_name in ("edit_base", "edit_masks"):
        source_state_directory = parent_directory / state_directory_name
        if not source_state_directory.is_dir():
            continue
        destination_state_directory = hybrid_directory / state_directory_name
        for part in CANONICAL_PARTS:
            state_path = source_state_directory / f"{part}.png"
            if part not in selected and state_path.is_file():
                destination_state_directory.mkdir(exist_ok=True)
                shutil.copy2(state_path, destination_state_directory / state_path.name)


def layer_manifest(layer_directory: Path, job_id: str) -> list[dict[str, object]]:
    """Describe all canonical parts, including absent and fully transparent ones."""
    manifest: list[dict[str, object]] = []
    for part in CANONICAL_PARTS:
        path = layer_directory / f"{part}.png"
        base_path = layer_directory / "edit_base" / f"{part}.png"
        mask_path = layer_directory / "edit_masks" / f"{part}.png"
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
                "edited": mask_path.is_file(),
                "url": (
                    f"/v1/layer-decompositions/{job_id}/assets/output/input/{part}.png"
                    if available
                    else None
                ),
                "base_url": (
                    f"/v1/layer-decompositions/{job_id}/assets/output/input/edit_base/{part}.png"
                    if base_path.is_file()
                    else (
                        f"/v1/layer-decompositions/{job_id}/assets/output/input/{part}.png"
                        if available
                        else None
                    )
                ),
                "edit_mask_url": (
                    f"/v1/layer-decompositions/{job_id}/assets/output/input/edit_masks/{part}.png"
                    if mask_path.is_file()
                    else None
                ),
            }
        )
    return manifest
