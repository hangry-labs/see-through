"""Recalculate depth for an accepted layer set and build a candidate PSD."""

from __future__ import annotations

import argparse
import os
import os.path as osp
from pathlib import Path


default_n_threads = 8
os.environ["OPENBLAS_NUM_THREADS"] = str(default_n_threads)
os.environ["MKL_NUM_THREADS"] = str(default_n_threads)
os.environ["OMP_NUM_THREADS"] = str(default_n_threads)

from see_through.revisions import prepare_depth_revision
from utils.inference_utils import apply_marigold, further_extr


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--srcp", required=True)
    parser.add_argument("--parent_dir", required=True)
    parser.add_argument("--save_dir", required=True)
    parser.add_argument("--repo_id_depth", required=True)
    parser.add_argument("--resolution_depth", type=int, default=768)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--inference_steps_depth", type=int, default=-1)
    parser.add_argument("--group_offload", action="store_true")
    args = parser.parse_args()

    srcname = osp.basename(osp.splitext(args.srcp)[0])
    revised_directory = Path(args.save_dir) / srcname
    print("copying accepted layers for depth recalculation...")
    prepare_depth_revision(Path(args.parent_dir), revised_directory)
    print("running marigold on copied layers...")
    apply_marigold(
        args.srcp,
        args.repo_id_depth,
        save_dir=args.save_dir,
        seed=args.seed,
        disable_progressbar=True,
        resolution=args.resolution_depth,
        num_inference_steps=args.inference_steps_depth,
        group_offload=args.group_offload,
    )
    print("building depth revision PSD...")
    further_extr(str(revised_directory), rotate=False, save_to_psd=True, tblr_split=False)


if __name__ == "__main__":
    main()
