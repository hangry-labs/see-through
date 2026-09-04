"""Apply a manual source-restoration mask and rebuild the layered PSD."""

from __future__ import annotations

import argparse
import os
import os.path as osp
from pathlib import Path


default_n_threads = 8
os.environ["OPENBLAS_NUM_THREADS"] = str(default_n_threads)
os.environ["MKL_NUM_THREADS"] = str(default_n_threads)
os.environ["OMP_NUM_THREADS"] = str(default_n_threads)

from see_through.revisions import prepare_detail_edit, validate_edit_part
from utils.inference_utils import apply_marigold, further_extr


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--srcp", required=True)
    parser.add_argument("--parent_dir", required=True)
    parser.add_argument("--save_dir", required=True)
    parser.add_argument("--part", required=True)
    parser.add_argument("--layer_order", action="append")
    parser.add_argument("--mask", required=True)
    parser.add_argument("--repo_id_depth", required=True)
    parser.add_argument("--resolution_depth", type=int, default=768)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--inference_steps_depth", type=int, default=-1)
    parser.add_argument("--group_offload", action="store_true")
    args = parser.parse_args()

    part = validate_edit_part(args.part)
    srcname = osp.basename(osp.splitext(args.srcp)[0])
    edited_directory = Path(args.save_dir) / srcname

    print(f"applying original pixels to {part}...")
    requires_depth = prepare_detail_edit(Path(args.parent_dir), edited_directory, part, Path(args.mask))
    if requires_depth:
        print("newly visible pixels require fresh depth")
        print("running marigold on edited layers...")
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
    else:
        print("edited pixels remain inside the existing layer; preserving depth maps")
    print("building edited PSD...")
    further_extr(
        str(edited_directory),
        rotate=False,
        save_to_psd=True,
        tblr_split=False,
        layer_order=args.layer_order,
    )


if __name__ == "__main__":
    main()
