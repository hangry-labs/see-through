"""Download pinned inference assets into explicit offline model directories."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from huggingface_hub import snapshot_download


MODEL_ROOT = Path("/app/models")


def download(repo_id: str, revision: str, destination: Path, allow_patterns: list[str] | None = None) -> None:
    print(f"Downloading {repo_id}@{revision} to {destination}", flush=True)
    snapshot_download(
        repo_id=repo_id,
        revision=revision,
        local_dir=destination,
        allow_patterns=allow_patterns,
    )


def model_record(name: str, repo_id: str, revision: str, destination: Path) -> dict[str, object]:
    files = [path for path in destination.rglob("*") if path.is_file()]
    return {
        "name": name,
        "repo_id": repo_id,
        "revision": revision,
        "path": str(destination),
        "file_count": len(files),
        "bytes": sum(path.stat().st_size for path in files),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--layerdiff-repo", required=True)
    parser.add_argument("--layerdiff-revision", required=True)
    parser.add_argument("--depth-repo", required=True)
    parser.add_argument("--depth-revision", required=True)
    parser.add_argument("--marigold-base-repo", required=True)
    parser.add_argument("--marigold-base-revision", required=True)
    parser.add_argument("--scheduler-repo", required=True)
    parser.add_argument("--scheduler-revision", required=True)
    args = parser.parse_args()

    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    download(args.layerdiff_repo, args.layerdiff_revision, MODEL_ROOT / "layerdiff")
    download(args.depth_repo, args.depth_revision, MODEL_ROOT / "marigold")
    download(
        args.marigold_base_repo,
        args.marigold_base_revision,
        MODEL_ROOT / "marigold-base",
        ["text_encoder/**", "tokenizer/**"],
    )
    download(
        args.scheduler_repo,
        args.scheduler_revision,
        MODEL_ROOT / "scheduler",
        ["scheduler/**"],
    )
    manifest = {
        "schema_version": 1,
        "models": [
            model_record("layerdiff3d", args.layerdiff_repo, args.layerdiff_revision, MODEL_ROOT / "layerdiff"),
            model_record("marigold", args.depth_repo, args.depth_revision, MODEL_ROOT / "marigold"),
            model_record(
                "marigold-base",
                args.marigold_base_repo,
                args.marigold_base_revision,
                MODEL_ROOT / "marigold-base",
            ),
            model_record("scheduler", args.scheduler_repo, args.scheduler_revision, MODEL_ROOT / "scheduler"),
        ],
    }
    (MODEL_ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("All pinned See-through inference assets are present.", flush=True)


if __name__ == "__main__":
    main()
