import unittest

import numpy as np

from utils.cv import crop_head_region


class CropHeadRegionTests(unittest.TestCase):
    def setUp(self):
        self.image = np.zeros((120, 80, 4), dtype=np.uint8)

    def test_empty_detection_is_skipped(self):
        self.assertIsNone(crop_head_region(self.image, (0, 0, 0, 0)))

    def test_detection_outside_image_is_skipped(self):
        self.assertIsNone(crop_head_region(self.image, (100, 20, 10, 10)))

    def test_partial_detection_is_clamped_to_image(self):
        cropped, bounds = crop_head_region(self.image, (-5, 10, 25, 30))

        self.assertGreater(cropped.shape[0], 0)
        self.assertGreater(cropped.shape[1], 0)
        self.assertEqual(bounds[0], 0)
        self.assertGreaterEqual(bounds[1], 0)
        self.assertLessEqual(bounds[2], self.image.shape[1])
        self.assertLessEqual(bounds[3], self.image.shape[0])

    def test_valid_detection_includes_context(self):
        cropped, bounds = crop_head_region(self.image, (30, 40, 20, 20))

        self.assertEqual(bounds, (26, 36, 54, 64))
        self.assertEqual(cropped.shape, (28, 28, 4))


if __name__ == '__main__':
    unittest.main()
