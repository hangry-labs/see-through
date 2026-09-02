import unittest

from utils.layer_order import apply_semantic_depth_constraints


class SemanticLayerOrderTests(unittest.TestCase):
    def test_neck_is_in_front_of_topwear_and_behind_neckwear(self):
        parts = {
            "topwear": {"depth_median": 0.60},
            "neck": {"depth_median": 0.67},
            "neckwear": {"depth_median": 0.69},
        }

        apply_semantic_depth_constraints(parts)

        self.assertLess(parts["neck"]["depth_median"], parts["topwear"]["depth_median"])
        self.assertLess(parts["neckwear"]["depth_median"], parts["neck"]["depth_median"])

    def test_correct_depths_are_not_moved_farther_back(self):
        parts = {
            "topwear": {"depth_median": 0.80},
            "neck": {"depth_median": 0.70},
            "neckwear": {"depth_median": 0.60},
        }

        apply_semantic_depth_constraints(parts)

        self.assertEqual(parts["topwear"]["depth_median"], 0.80)
        self.assertEqual(parts["neck"]["depth_median"], 0.70)
        self.assertEqual(parts["neckwear"]["depth_median"], 0.60)

    def test_missing_or_empty_semantic_layers_are_ignored(self):
        parts = {"topwear": {"depth_median": 0.60}}

        apply_semantic_depth_constraints(parts)

        self.assertEqual(parts, {"topwear": {"depth_median": 0.60}})


if __name__ == "__main__":
    unittest.main()
