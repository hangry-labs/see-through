"""Apply a manual front-to-back layer order and rebuild the layered PSD."""

from __future__ import annotations

import argparse
import os
import os.path as osp
from pathlib import Path


default_n_threads = 8
os.environ["OPENBLAS_NUM_THREADS"] = str(default_n_threads)
os.environ["MKL_NUM_THREADS"] = str(default_n_threads)
os.environ["OMP_NUM_THREADS"] = str(default_n_threads)

from see_through.revisions import (
    available_layer_order,
    prepare_order_revision,
    validate_layer_order,
)
from utils.inference_utils import further_extr


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--srcp", required=True)
    parser.add_argument("--parent_dir", required=True)
    parser.add_argument("--save_dir", required=True)
    parser.add_argument("--layer_order", action="append", required=True)
    args = parser.parse_args()

    parent_directory = Path(args.parent_dir)
    layer_order = validate_layer_order(
        args.layer_order,
        available_layer_order(parent_directory),
    )
    srcname = osp.basename(osp.splitext(args.srcp)[0])
    revised_directory = Path(args.save_dir) / srcname

    print("copying accepted layers for manual reordering...")
    prepare_order_revision(parent_directory, revised_directory)
    print("building manually ordered PSD...")
    further_extr(
        str(revised_directory),
        rotate=False,
        save_to_psd=True,
        tblr_split=False,
        layer_order=layer_order,
    )


if __name__ == "__main__":
    main()
