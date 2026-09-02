"""Hangry Labs runtime service for See-through."""

from pathlib import Path


_VERSION_FILE = Path(__file__).resolve().parent.parent / "VERSION"
__version__ = _VERSION_FILE.read_text(encoding="utf-8").strip()

if not __version__:
    raise RuntimeError(f"Version metadata is empty: {_VERSION_FILE}")
