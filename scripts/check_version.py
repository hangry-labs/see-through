"""Validate the canonical project version and its runtime exposure."""

from __future__ import annotations

import runpy
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION_PATTERN = re.compile(r"^(\d+\.\d+\.\d+)(-snapshot)?$")


def main() -> None:
    release_version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    match = VERSION_PATTERN.fullmatch(release_version)
    if match is None:
        raise SystemExit(
            f"VERSION must look like 0.1.0 or 0.2.0-snapshot; found {release_version!r}"
        )
    runtime_version = runpy.run_path(ROOT / "see_through" / "__init__.py")["__version__"]
    if runtime_version != release_version:
        raise SystemExit(
            f"Runtime version {runtime_version!r} does not match VERSION {release_version!r}"
        )
    print(f"Version metadata is valid and available at runtime: {release_version}")


if __name__ == "__main__":
    main()
