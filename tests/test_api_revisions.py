import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

import see_through.app as application
from see_through import runtime


class RevisionApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.jobs_root_patch = patch.object(
            runtime,
            "JOBS_ROOT",
            Path(self.temporary_directory.name),
        )
        self.jobs_root_patch.start()
        with runtime._state_lock:
            runtime._jobs.clear()
            runtime._processes.clear()
            runtime._active_job_id = None
        settings = {
            "seed": 42,
            "resolution": 768,
            "depth_resolution": 512,
            "inference_steps": 30,
            "group_offload": True,
        }
        self.parent = runtime.create_job(settings)
        self.parent.status = "completed"
        self.parent.stage = "completed"
        self.parent.accepted_at = runtime.utc_now()
        with runtime._state_lock:
            runtime._active_job_id = None
        root = runtime.job_root(self.parent.id)
        (root / "output" / "input").mkdir(parents=True)
        Image.new("RGBA", (64, 64), (1, 2, 3, 255)).save(runtime.input_path(self.parent.id))
        Image.new("RGBA", (64, 64), (1, 2, 3, 255)).save(root / "output" / "input" / "src_img.png")
        Image.new("RGBA", (64, 64), (10, 20, 30, 255)).save(root / "output" / "input" / "front hair.png")
        runtime.persist_job(self.parent)
        self.client = TestClient(application.app)

    def tearDown(self):
        with runtime._state_lock:
            runtime._jobs.clear()
            runtime._processes.clear()
            runtime._active_job_id = None
        self.jobs_root_patch.stop()
        self.temporary_directory.cleanup()

    def test_revision_endpoint_stages_an_immutable_child(self):
        with patch.object(application, "run_job"), patch.object(application.secrets, "randbelow", return_value=123456):
            response = self.client.post(
                f"/v1/layer-decompositions/{self.parent.id}/revisions",
                files=[("parts", (None, "footwear")), ("parts", (None, "bottomwear"))],
            )

        self.assertEqual(response.status_code, 202)
        payload = response.json()
        self.assertEqual(payload["kind"], "revision")
        self.assertEqual(payload["parent_job_id"], self.parent.id)
        self.assertEqual(payload["replaced_parts"], ["bottomwear", "footwear"])
        self.assertEqual(payload["settings"]["seed"], 123456)
        self.assertTrue(runtime.input_path(payload["id"]).is_file())
        self.assertTrue(runtime.input_path(self.parent.id).is_file())

        history = self.client.get(f"/v1/layer-decompositions/{payload['id']}/revisions")
        self.assertEqual(history.status_code, 200)
        self.assertEqual(len(history.json()["items"]), 2)

    def test_revision_endpoint_rejects_unknown_parts(self):
        response = self.client.post(
            f"/v1/layer-decompositions/{self.parent.id}/revisions",
            data={"parts": "background"},
        )

        self.assertEqual(response.status_code, 422)
        self.assertIn("unsupported replacement parts", response.json()["detail"])

    def test_revision_endpoint_preserves_single_gpu_job_conflict(self):
        runtime.create_job(dict(self.parent.settings))

        response = self.client.post(
            f"/v1/layer-decompositions/{self.parent.id}/revisions",
            data={"parts": "footwear"},
        )

        self.assertEqual(response.status_code, 409)
        self.assertIn("already running", response.json()["detail"])

    def test_detail_edit_endpoint_stages_mask_as_an_immutable_child(self):
        mask_file = BytesIO()
        Image.new("L", (64, 64), 127).save(mask_file, format="PNG")
        with patch.object(application, "run_job"):
            response = self.client.post(
                f"/v1/layer-decompositions/{self.parent.id}/edits",
                data={"part": "front hair"},
                files={"mask": ("mask.png", mask_file.getvalue(), "image/png")},
            )

        self.assertEqual(response.status_code, 202)
        payload = response.json()
        self.assertEqual(payload["kind"], "edit")
        self.assertEqual(payload["parent_job_id"], self.parent.id)
        self.assertEqual(payload["replaced_parts"], ["front hair"])
        self.assertEqual(payload["revision_number"], 1)
        self.assertTrue((runtime.job_root(payload["id"]) / "edit-mask.png").is_file())
        self.assertTrue(runtime.input_path(payload["id"]).is_file())

    def test_detail_edit_endpoint_rejects_a_misaligned_mask(self):
        mask_file = BytesIO()
        Image.new("L", (32, 64), 255).save(mask_file, format="PNG")
        response = self.client.post(
            f"/v1/layer-decompositions/{self.parent.id}/edits",
            data={"part": "front hair"},
            files={"mask": ("mask.png", mask_file.getvalue(), "image/png")},
        )

        self.assertEqual(response.status_code, 422)
        self.assertIn("dimensions must be 64x64", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
