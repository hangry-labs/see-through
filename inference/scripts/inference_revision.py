"""Regenerate selected semantic layers and rebuild a hybrid layered PSD."""

from __future__ import annotations

import argparse
import os
import os.path as osp
import shutil
from pathlib import Path


default_n_threads = 8
os.environ["OPENBLAS_NUM_THREADS"] = str(default_n_threads)
os.environ["MKL_NUM_THREADS"] = str(default_n_threads)
os.environ["OMP_NUM_THREADS"] = str(default_n_threads)

from see_through.revisions import prepare_hybrid_layers, validate_replacement_parts
from utils.inference_utils import apply_layerdiff, apply_marigold, further_extr
from utils.torch_utils import seed_everything


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--srcp", required=True)
    parser.add_argument("--parent_dir", required=True)
    parser.add_argument("--save_dir", required=True)
    parser.add_argument("--replace_tag", action="append", required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--repo_id_layerdiff", required=True)
    parser.add_argument("--repo_id_depth", required=True)
    parser.add_argument("--resolution", type=int, default=1280)
    parser.add_argument("--resolution_depth", type=int, default=768)
    parser.add_argument("--inference_steps", type=int, default=30)
    parser.add_argument("--inference_steps_depth", type=int, default=-1)
    parser.add_argument("--group_offload", action="store_true")
    parser.add_argument("--disable_progressbar", action="store_true")
    args = parser.parse_args()

    replacement_parts = validate_replacement_parts(args.replace_tag)
    srcname = osp.basename(osp.splitext(args.srcp)[0])
    output_root = Path(args.save_dir)
    hybrid_directory = output_root / srcname
    candidate_root = output_root.parent / ".candidate"
    candidate_directory = candidate_root / srcname

    if candidate_root.exists():
        shutil.rmtree(candidate_root)

    try:
        seed_everything(args.seed)
        print("running layerdiff candidate regeneration...")
        apply_layerdiff(
            args.srcp,
            args.repo_id_layerdiff,
            save_dir=str(candidate_root),
            seed=args.seed,
            resolution=args.resolution,
            disable_progressbar=args.disable_progressbar,
            num_inference_steps=args.inference_steps,
            group_offload=args.group_offload,
        )

        print("stitching selected candidate layers with accepted layers...")
        prepare_hybrid_layers(
            Path(args.parent_dir),
            candidate_directory,
            hybrid_directory,
            replacement_parts,
        )

        print("running marigold on stitched layers...")
        apply_marigold(
            args.srcp,
            args.repo_id_depth,
            save_dir=str(output_root),
            seed=args.seed,
            disable_progressbar=args.disable_progressbar,
            resolution=args.resolution_depth,
            num_inference_steps=args.inference_steps_depth,
            group_offload=args.group_offload,
        )

        print("building revised PSD...")
        further_extr(str(hybrid_directory), rotate=False, save_to_psd=True, tblr_split=False)
    finally:
        shutil.rmtree(candidate_root, ignore_errors=True)


if __name__ == "__main__":
    main()
