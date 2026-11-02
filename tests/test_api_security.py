"""Regression coverage for the public API's filesystem and diagnostic boundaries."""

import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

import see_through.app as application
from see_through import runtime


class ApiSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.jobs_root = Path(self.temporary.name) / "jobs"
        for patcher in (
            patch.object(runtime, "JOBS_ROOT", self.jobs_root),
            patch.object(runtime, "_jobs", {}),
            patch.object(runtime, "_processes", {}),
            patch.object(runtime, "_active_job_id", None),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.job = runtime.create_job({})
        self.job.status = "completed"
        self.root = runtime.job_root(self.job.id)
        self.layers = runtime.output_root(self.job.id) / "input"
        self.layers.mkdir(parents=True)
        self.png = self.layers / "front hair.png"
        Image.new("RGBA", (64, 64), (20, 40, 60, 255)).save(self.png)
        runtime.input_path(self.job.id).write_bytes(self.png.read_bytes())
        self.psd = runtime.output_root(self.job.id) / "input.psd"
        self.psd.write_bytes(b"test PSD download")
        self.outside = self.jobs_root / f"{self.job.id}-neighbor"
        self.outside.mkdir()
        (self.outside / "secret.txt").write_text("private sentinel", encoding="utf-8")
        self.client = TestClient(application.app)

    def asset_url(self, path):
        return f"/v1/layer-decompositions/{self.job.id}/assets/{path}"

    def test_asset_paths_cannot_escape_the_job(self):
        candidates = (
            f"%2e%2e/{self.outside.name}/secret.txt",
            f"%2e%2e%5c{self.outside.name}%5csecret.txt",
            str(self.outside / "secret.txt"),
            "/etc/passwd",
        )
        for candidate in candidates:
            with self.subTest(path=candidate):
                response = self.client.get(self.asset_url(candidate))
                self.assertEqual(response.status_code, 404)
                self.assertNotIn("private sentinel", response.text)

    def test_symlink_asset_cannot_escape_the_job(self):
        link = self.root / "linked-secret.txt"
        try:
            link.symlink_to(self.outside / "secret.txt")
        except (OSError, NotImplementedError):
            self.skipTest("creating symlinks is unavailable")
        response = self.client.get(self.asset_url(link.name))
        self.assertEqual(response.status_code, 404)

    def test_valid_assets_and_psd_download_still_work(self):
        response = self.client.get(self.asset_url("output/input/front%20hair.png"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, self.png.read_bytes())
        response = self.client.get(f"/v1/layer-decompositions/{self.job.id}/download")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, self.psd.read_bytes())

    def test_unknown_job_cannot_access_files(self):
        for job_id in ("0" * 32, f"..%5c{self.outside.name}"):
            for suffix in ("download", "assets/output/input/front%20hair.png"):
                with self.subTest(job_id=job_id, suffix=suffix):
                    response = self.client.get(f"/v1/layer-decompositions/{job_id}/{suffix}")
                    self.assertEqual(response.status_code, 404)

    def test_edit_part_traversal_is_rejected_before_opening_a_layer(self):
        mask = BytesIO()
        Image.new("L", (64, 64), 255).save(mask, format="PNG")
        for part in ("../secret", "..\\secret", "/etc/passwd", "front hair/../../secret"):
            with self.subTest(part=part), patch.object(application.Image, "open") as open_image:
                response = self.client.post(
                    f"/v1/layer-decompositions/{self.job.id}/edits",
                    data={"part": part},
                    files={"mask": ("mask.png", mask.getvalue(), "image/png")},
                )
                self.assertEqual(response.status_code, 422)
                open_image.assert_not_called()

    def test_gpu_exception_details_are_logged_but_not_returned(self):
        # Exercise the real runtime error handler through every flagged endpoint.
        import builtins

        real_import = builtins.__import__

        def fail_torch_import(name, *args, **kwargs):
            if name == "torch":
                raise RuntimeError("private sentinel /internal/library/path")
            return real_import(name, *args, **kwargs)

        for endpoint in ("/health/ready", "/health", "/v1/runtime"):
            with self.subTest(endpoint=endpoint):
                with patch("builtins.__import__", side_effect=fail_torch_import):
                    with self.assertLogs("see_through.runtime", level="ERROR") as logs:
                        response = self.client.get(endpoint)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["status"], "degraded")
                self.assertFalse(response.json()["gpu"]["available"])
                self.assertNotIn("private sentinel", response.text)
                self.assertNotIn("/internal/library/path", response.text)
                self.assertIn("private sentinel", "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
