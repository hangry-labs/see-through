import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from see_through import runtime


class RevisionMetadataTests(unittest.TestCase):
    def setUp(self):
        with runtime._state_lock:
            runtime._jobs.clear()
            runtime._processes.clear()
            runtime._active_job_id = None

    def tearDown(self):
        with runtime._state_lock:
            runtime._jobs.clear()
            runtime._processes.clear()
            runtime._active_job_id = None

    def test_revision_relationship_and_acceptance(self):
        settings = {
            "seed": 1,
            "resolution": 768,
            "depth_resolution": 512,
            "inference_steps": 30,
            "group_offload": True,
        }
        parent = runtime.create_job(settings)
        parent.status = "completed"
        with runtime._state_lock:
            runtime._active_job_id = None
        revision = runtime.create_job(
            {**settings, "seed": 2},
            kind="revision",
            parent_job_id=parent.id,
            root_job_id=parent.root_job_id,
            revision_number=1,
            replaced_parts=["bottomwear", "footwear"],
        )
        revision.status = "completed"
        with runtime._state_lock:
            runtime._active_job_id = None

        history = runtime.revision_history(revision.id)

        self.assertEqual([job.id for job in history], [parent.id, revision.id])
        self.assertEqual(revision.root_job_id, parent.id)
        self.assertEqual(revision.parent_job_id, parent.id)
        self.assertIsNone(revision.accepted_at)
        with tempfile.TemporaryDirectory() as temporary_directory:
            with patch.object(runtime, "JOBS_ROOT", Path(temporary_directory)):
                accepted = runtime.accept_revision(revision.id)
                self.assertIsNotNone(accepted.accepted_at)
                self.assertTrue((Path(temporary_directory) / revision.id / "job.json").is_file())

    def test_revision_relationship_survives_disk_restore(self):
        settings = {
            "seed": 10,
            "resolution": 768,
            "depth_resolution": 512,
            "inference_steps": 30,
            "group_offload": True,
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            with patch.object(runtime, "JOBS_ROOT", Path(temporary_directory)):
                parent = runtime.create_job(settings)
                parent.status = "completed"
                parent.stage = "completed"
                parent.accepted_at = runtime.utc_now()
                runtime.persist_job(parent)
                with runtime._state_lock:
                    runtime._active_job_id = None
                revision = runtime.create_job(
                    {**settings, "seed": 11},
                    kind="revision",
                    parent_job_id=parent.id,
                    root_job_id=parent.id,
                    revision_number=1,
                    replaced_parts=["irides", "footwear"],
                )
                revision.status = "completed"
                revision.stage = "completed"
                runtime.persist_job(revision)
                with runtime._state_lock:
                    runtime._jobs.clear()
                    runtime._active_job_id = None

                runtime.load_jobs_from_disk()
                restored = runtime.revision_history(revision.id)

                self.assertEqual([job.id for job in restored], [parent.id, revision.id])
                self.assertEqual(restored[1].replaced_parts, ["irides", "footwear"])
                self.assertEqual(restored[1].parent_job_id, parent.id)

    def test_branched_revision_attempts_receive_unique_numbers(self):
        settings = {"seed": 1}
        parent = runtime.create_job(settings)
        parent.status = "completed"
        with runtime._state_lock:
            runtime._active_job_id = None
        first = runtime.create_job(
            {"seed": 2},
            kind="revision",
            parent_job_id=parent.id,
            root_job_id=parent.id,
        )
        first.status = "completed"
        with runtime._state_lock:
            runtime._active_job_id = None
        second = runtime.create_job(
            {"seed": 3},
            kind="revision",
            parent_job_id=parent.id,
            root_job_id=parent.id,
        )

        self.assertEqual(first.revision_number, 1)
        self.assertEqual(second.revision_number, 2)

    def test_detail_edits_share_the_revision_number_sequence(self):
        settings = {"seed": 1}
        parent = runtime.create_job(settings)
        parent.status = "completed"
        with runtime._state_lock:
            runtime._active_job_id = None
        edit = runtime.create_job(
            {**settings, "edit_part": "face"},
            kind="edit",
            parent_job_id=parent.id,
            root_job_id=parent.id,
            replaced_parts=["face"],
        )
        edit.status = "completed"
        with runtime._state_lock:
            runtime._active_job_id = None
        revision = runtime.create_job(
            {"seed": 2},
            kind="revision",
            parent_job_id=edit.id,
            root_job_id=parent.id,
        )

        self.assertEqual(edit.revision_number, 1)
        self.assertEqual(revision.revision_number, 2)

    def test_depth_revisions_share_the_revision_number_sequence(self):
        settings = {"seed": 1, "depth_resolution": 512, "group_offload": True}
        parent = runtime.create_job(settings)
        parent.status = "completed"
        with runtime._state_lock:
            runtime._active_job_id = None
        depth = runtime.create_job(
            {**settings, "seed": 2},
            kind="depth",
            parent_job_id=parent.id,
            root_job_id=parent.id,
        )
        depth.status = "completed"
        with runtime._state_lock:
            runtime._active_job_id = None
        edit = runtime.create_job(
            {**settings, "edit_part": "face"},
            kind="edit",
            parent_job_id=depth.id,
            root_job_id=parent.id,
            replaced_parts=["face"],
        )

        self.assertEqual(depth.revision_number, 1)
        self.assertEqual(edit.revision_number, 2)

    def test_order_revisions_share_the_revision_number_sequence(self):
        settings = {"seed": 1, "layer_order": ["face", "topwear"]}
        parent = runtime.create_job(settings)
        parent.status = "completed"
        with runtime._state_lock:
            runtime._active_job_id = None
        order = runtime.create_job(
            settings,
            kind="order",
            parent_job_id=parent.id,
            root_job_id=parent.id,
        )

        self.assertEqual(order.revision_number, 1)

    def test_depth_revision_number_survives_disk_restore(self):
        settings = {
            "seed": 1,
            "resolution": 768,
            "depth_resolution": 512,
            "inference_steps": 30,
            "group_offload": True,
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            with patch.object(runtime, "JOBS_ROOT", Path(temporary_directory)):
                parent = runtime.create_job(settings)
                parent.status = "completed"
                parent.stage = "completed"
                parent.accepted_at = runtime.utc_now()
                runtime.persist_job(parent)
                with runtime._state_lock:
                    runtime._active_job_id = None
                depth = runtime.create_job(
                    {**settings, "seed": 2},
                    kind="depth",
                    parent_job_id=parent.id,
                    root_job_id=parent.id,
                    revision_number=7,
                )
                depth.status = "completed"
                depth.stage = "completed"
                runtime.persist_job(depth)
                with runtime._state_lock:
                    runtime._jobs.clear()
                    runtime._active_job_id = None

                runtime.load_jobs_from_disk()
                restored = runtime.revision_history(depth.id)

                self.assertEqual(restored[1].kind, "depth")
                self.assertEqual(restored[1].revision_number, 1)


if __name__ == "__main__":
    unittest.main()
