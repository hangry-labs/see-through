import tempfile
import unittest
from pathlib import Path

from PIL import Image

from see_through.revisions import (
    CANONICAL_PARTS,
    layer_manifest,
    prepare_hybrid_layers,
    validate_replacement_parts,
)


def save_layer(path: Path, color: tuple[int, int, int, int]) -> None:
    Image.new("RGBA", (16, 16), color).save(path)


class RevisionLayerTests(unittest.TestCase):
    def test_replacement_validation_is_unique_and_canonical(self):
        parts = validate_replacement_parts(["footwear", "bottomwear", "footwear"])

        self.assertEqual(parts, ["bottomwear", "footwear"])

    def test_replacement_validation_rejects_unknown_and_empty_parts(self):
        with self.assertRaisesRegex(ValueError, "unsupported replacement parts"):
            validate_replacement_parts(["background"])
        with self.assertRaisesRegex(ValueError, "select at least one part"):
            validate_replacement_parts([])

    def test_hybrid_uses_only_selected_candidate_layers(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            parent = root / "parent"
            candidate = root / "candidate"
            hybrid = root / "hybrid"
            parent.mkdir()
            candidate.mkdir()
            save_layer(parent / "src_img.png", (5, 5, 5, 255))
            save_layer(parent / "bottomwear.png", (200, 0, 0, 255))
            save_layer(parent / "topwear.png", (0, 200, 0, 255))
            save_layer(candidate / "bottomwear.png", (0, 0, 200, 255))
            save_layer(candidate / "topwear.png", (200, 200, 0, 255))

            prepare_hybrid_layers(parent, candidate, hybrid, ["bottomwear"])

            with Image.open(hybrid / "bottomwear.png") as image:
                self.assertEqual(image.getpixel((0, 0)), (0, 0, 200, 255))
            with Image.open(hybrid / "topwear.png") as image:
                self.assertEqual(image.getpixel((0, 0)), (0, 200, 0, 255))
            with Image.open(hybrid / "footwear.png") as image:
                self.assertIsNone(image.getchannel("A").getbbox())
            self.assertEqual(
                sorted(path.stem for path in hybrid.glob("*.png") if path.name != "src_img.png"),
                sorted(CANONICAL_PARTS),
            )

    def test_manifest_includes_visible_empty_and_missing_parts(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            save_layer(root / "bottomwear.png", (50, 60, 70, 255))
            save_layer(root / "footwear.png", (0, 0, 0, 0))

            manifest = {part["name"]: part for part in layer_manifest(root, "a" * 32)}

            self.assertTrue(manifest["bottomwear"]["visible"])
            self.assertTrue(manifest["bottomwear"]["available"])
            self.assertFalse(manifest["footwear"]["visible"])
            self.assertTrue(manifest["footwear"]["available"])
            self.assertFalse(manifest["topwear"]["available"])
            self.assertIsNone(manifest["topwear"]["url"])

    def test_hybrid_accepts_mixed_head_and_body_replacements(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            parent = root / "parent"
            candidate = root / "candidate"
            hybrid = root / "hybrid"
            parent.mkdir()
            candidate.mkdir()
            save_layer(parent / "src_img.png", (5, 5, 5, 255))
            save_layer(parent / "headwear.png", (100, 0, 0, 255))
            save_layer(parent / "footwear.png", (0, 100, 0, 255))
            save_layer(candidate / "headwear.png", (0, 0, 100, 255))
            save_layer(candidate / "footwear.png", (100, 100, 0, 255))

            prepare_hybrid_layers(parent, candidate, hybrid, ["headwear", "footwear"])

            with Image.open(hybrid / "headwear.png") as image:
                self.assertEqual(image.getpixel((0, 0)), (0, 0, 100, 255))
            with Image.open(hybrid / "footwear.png") as image:
                self.assertEqual(image.getpixel((0, 0)), (100, 100, 0, 255))


if __name__ == "__main__":
    unittest.main()
