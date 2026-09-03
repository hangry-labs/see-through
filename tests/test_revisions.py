import tempfile
import unittest
from pathlib import Path

from PIL import Image

from see_through.revisions import (
    CANONICAL_PARTS,
    layer_manifest,
    prepare_depth_revision,
    prepare_detail_edit,
    prepare_hybrid_layers,
    validate_edit_part,
    validate_replacement_parts,
)


def save_layer(path: Path, color: tuple[int, int, int, int]) -> None:
    Image.new("RGBA", (16, 16), color).save(path)


class RevisionLayerTests(unittest.TestCase):
    def test_edit_part_validation_accepts_only_canonical_layers(self):
        self.assertEqual(validate_edit_part(" front hair "), "front hair")
        with self.assertRaisesRegex(ValueError, "unsupported edit part"):
            validate_edit_part("background")

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

    def test_hybrid_retains_edit_state_only_for_layers_not_regenerated(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            parent = root / "parent"
            candidate = root / "candidate"
            hybrid = root / "hybrid"
            parent.mkdir()
            candidate.mkdir()
            save_layer(parent / "src_img.png", (5, 5, 5, 255))
            for directory_name in ("edit_base", "edit_masks"):
                (parent / directory_name).mkdir()
                save_layer(parent / directory_name / "face.png", (1, 2, 3, 255))
                save_layer(parent / directory_name / "front hair.png", (4, 5, 6, 255))

            prepare_hybrid_layers(parent, candidate, hybrid, ["front hair"])

            self.assertTrue((hybrid / "edit_base" / "face.png").is_file())
            self.assertTrue((hybrid / "edit_masks" / "face.png").is_file())
            self.assertFalse((hybrid / "edit_base" / "front hair.png").exists())
            self.assertFalse((hybrid / "edit_masks" / "front hair.png").exists())

    def test_detail_edit_blends_source_and_preserves_an_absolute_base(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            parent = root / "parent"
            first = root / "first"
            second = root / "second"
            parent.mkdir()
            source = Image.new("RGBA", (4, 4), (200, 100, 50, 255))
            base = Image.new("RGBA", (4, 4), (10, 20, 30, 0))
            base.putpixel((1, 1), (20, 40, 60, 255))
            source.save(parent / "src_img.png")
            base.save(parent / "front hair.png")
            Image.new("L", (4, 4), 120).save(parent / "front hair_depth.png")
            (parent / "info.json").write_text('{"parts":{"front hair":{}}}', encoding="utf-8")

            first_mask = Image.new("L", (4, 4), 0)
            first_mask.putpixel((2, 2), 255)
            first_mask.save(root / "first-mask.png")
            self.assertTrue(prepare_detail_edit(parent, first, "front hair", root / "first-mask.png"))

            with Image.open(first / "front hair.png") as edited:
                self.assertEqual(edited.getpixel((2, 2)), (200, 100, 50, 255))
                self.assertEqual(edited.getpixel((1, 1)), (20, 40, 60, 255))
            with Image.open(first / "front hair_depth.png") as depth:
                self.assertEqual(depth.getpixel((2, 2)), 120)
            self.assertTrue((first / "edit_base" / "front hair.png").is_file())
            self.assertTrue((first / "edit_masks" / "front hair.png").is_file())

            Image.new("L", (4, 4), 0).save(root / "second-mask.png")
            self.assertFalse(prepare_detail_edit(first, second, "front hair", root / "second-mask.png"))
            with Image.open(second / "front hair.png") as reverted:
                self.assertEqual(reverted.getpixel((2, 2)), (10, 20, 30, 0))

    def test_detail_edit_inside_existing_alpha_preserves_depth(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            parent = root / "parent"
            parent.mkdir()
            save_layer(parent / "src_img.png", (200, 100, 50, 255))
            save_layer(parent / "face.png", (10, 20, 30, 255))
            Image.new("L", (16, 16), 100).save(parent / "face_depth.png")
            Image.new("L", (16, 16), 255).save(root / "mask.png")

            requires_depth = prepare_detail_edit(parent, root / "edited", "face", root / "mask.png")

            self.assertFalse(requires_depth)

    def test_depth_revision_copies_editable_layers_without_optimized_outputs(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            parent = root / "parent"
            parent.mkdir()
            save_layer(parent / "src_img.png", (5, 5, 5, 255))
            save_layer(parent / "face.png", (10, 20, 30, 255))
            (parent / "edit_masks").mkdir()
            Image.new("L", (16, 16), 100).save(parent / "edit_masks" / "face.png")
            (parent / "optimized").mkdir()
            save_layer(parent / "optimized" / "face.png", (1, 2, 3, 255))

            revised = root / "revised"
            prepare_depth_revision(parent, revised)

            self.assertTrue((revised / "face.png").is_file())
            self.assertTrue((revised / "edit_masks" / "face.png").is_file())
            self.assertFalse((revised / "optimized").exists())

    def test_detail_edit_rejects_a_misaligned_mask(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            parent = root / "parent"
            parent.mkdir()
            save_layer(parent / "src_img.png", (5, 5, 5, 255))
            save_layer(parent / "face.png", (10, 20, 30, 255))
            Image.new("L", (8, 8), 255).save(root / "mask.png")

            with self.assertRaisesRegex(ValueError, "dimensions must match"):
                prepare_detail_edit(parent, root / "edited", "face", root / "mask.png")

    def test_manifest_exposes_retained_edit_state(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            save_layer(root / "face.png", (10, 20, 30, 255))
            (root / "edit_base").mkdir()
            (root / "edit_masks").mkdir()
            save_layer(root / "edit_base" / "face.png", (1, 2, 3, 255))
            Image.new("L", (16, 16), 100).save(root / "edit_masks" / "face.png")

            face = {part["name"]: part for part in layer_manifest(root, "b" * 32)}["face"]

            self.assertTrue(face["edited"])
            self.assertIn("edit_base/face.png", face["base_url"])
            self.assertIn("edit_masks/face.png", face["edit_mask_url"])


if __name__ == "__main__":
    unittest.main()
