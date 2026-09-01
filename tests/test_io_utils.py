import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from utils.io_utils import load_parts


class LoadPartsTests(unittest.TestCase):
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
