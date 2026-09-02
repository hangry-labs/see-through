"""Semantic ordering constraints for connected character layers."""

from __future__ import annotations

from typing import Any


SEMANTIC_DEPTH_ORDER = (
    ("neck", "topwear"),
    ("neckwear", "neck"),
)


def apply_semantic_depth_constraints(
    parts: dict[str, dict[str, Any]], *, gap: float = 0.002
) -> None:
    """Keep foreground/background relationships stable when estimated depths conflict."""
    for foreground, background in SEMANTIC_DEPTH_ORDER:
        if foreground not in parts or background not in parts:
            continue
        foreground_depth = float(parts[foreground].get("depth_median", 0.5))
        background_depth = float(parts[background].get("depth_median", 0.5))
        parts[foreground]["depth_median"] = min(
            foreground_depth, background_depth - gap
        )
