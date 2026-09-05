import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from utils.io_utils import load_parts


HAS_PSD_TOOLS = importlib.util.find_spec("psd_tools") is not None
if HAS_PSD_TOOLS:
    from psd_tools import PSDImage

    from utils.inference_utils import dump_parts_psd


class LoadPartsTests(unittest.TestCase):
    @unittest.skipUnless(HAS_PSD_TOOLS, "PSD integration requires the full runtime dependencies")
    def test_manual_order_draws_the_first_layer_in_front(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            front = np.full((4, 4, 4), (220, 20, 20, 255), dtype=np.uint8)
            back = np.full((4, 4, 4), (20, 20, 220, 255), dtype=np.uint8)
            parts = {
                "front hair": {
                    "tag": "front hair",
                    "img": front,
                    "depth": np.zeros((4, 4), dtype=np.uint8),
                    "depth_median": 0.8,
                },
                "back hair": {
                    "tag": "back hair",
                    "img": back,
                    "depth": np.full((4, 4), 255, dtype=np.uint8),
                    "depth_median": 0.2,
                },
            }
            psd_path = root / "manual.psd"

            dump_parts_psd(
                parts,
                (4, 4),
                str(psd_path),
                layer_order=["front hair", "back hair"],
            )

            composite = PSDImage.open(psd_path).composite()
            self.assertEqual(composite.getpixel((1, 1))[:3], (220, 20, 20))
            metadata = json.loads((root / "manual.psd.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["layer_order"], ["front hair", "back hair"])

    def test_missing_layer_record_is_ignored(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            rgba = np.zeros((128, 128, 4), dtype=np.uint8)
            rgba[20:60, 20:60] = (120, 80, 60, 255)
            depth = np.full((128, 128), 127, dtype=np.uint8)

            Image.fromarray(rgba).save(root / 'src_img.png')
            Image.fromarray(rgba).save(root / 'face.png')
            Image.fromarray(depth).save(root / 'face_depth.png')
            (root / 'info.json').write_text(
                json.dumps({'parts': {'headwear': {}, 'face': {}}}),
                encoding='utf-8',
            )

            _, _, parts = load_parts(str(root), rotate=False)

            self.assertEqual([part['tag'] for part in parts], ['face'])


if __name__ == '__main__':
    unittest.main()
