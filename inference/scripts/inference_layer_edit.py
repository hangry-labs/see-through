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
from utils.inference_utils import further_extr


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--srcp", required=True)
    parser.add_argument("--parent_dir", required=True)
    parser.add_argument("--save_dir", required=True)
    parser.add_argument("--part", required=True)
    parser.add_argument("--mask", required=True)
    args = parser.parse_args()

    part = validate_edit_part(args.part)
    srcname = osp.basename(osp.splitext(args.srcp)[0])
    edited_directory = Path(args.save_dir) / srcname

    print(f"applying original pixels to {part}...")
    prepare_detail_edit(Path(args.parent_dir), edited_directory, part, Path(args.mask))
    print("building edited PSD...")
    further_extr(str(edited_directory), rotate=False, save_to_psd=True, tblr_split=False)


if __name__ == "__main__":
    main()
