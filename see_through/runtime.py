"""Serialized subprocess runner for the upstream See-through inference pipeline."""

from __future__ import annotations

import os
import re
import json
import signal
import subprocess
import sys
import threading
from collections import deque
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from see_through.revisions import CANONICAL_PARTS, layer_manifest


APP_ROOT = Path(os.getenv("SEE_THROUGH_APP_ROOT", "/app"))
WORKSPACE_ROOT = Path(os.getenv("SEE_THROUGH_WORKSPACE", "/app/workspace"))
JOBS_ROOT = WORKSPACE_ROOT / "jobs"
LAYERDIFF_MODEL = os.getenv("SEE_THROUGH_LAYERDIFF_MODEL", "layerdifforg/seethroughv0.0.2_layerdiff3d")
DEPTH_MODEL = os.getenv("SEE_THROUGH_DEPTH_MODEL", "layerdifforg/seethroughv0.0.1_marigold")
LAYERDIFF_MODEL_ID = os.getenv(
    "SEE_THROUGH_LAYERDIFF_MODEL_ID", "layerdifforg/seethroughv0.0.2_layerdiff3d"
)
DEPTH_MODEL_ID = os.getenv(
    "SEE_THROUGH_DEPTH_MODEL_ID", "layerdifforg/seethroughv0.0.1_marigold"
)
MARIGOLD_BASE_MODEL_ID = os.getenv(
    "SEE_THROUGH_MARIGOLD_BASE_MODEL_ID", "prs-eth/marigold-depth-v1-1"
)
SAM_BODY_MODEL_ID = os.getenv("SEE_THROUGH_SAM_BODY_MODEL_ID", "24yearsold/l2d_sam_iter2")
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class Job:
    id: str
    status: str
    settings: dict[str, Any]
    kind: str = "generation"
    parent_job_id: str | None = None
    root_job_id: str | None = None
    revision_number: int = 0
    replaced_parts: list[str] = field(default_factory=list)
    accepted_at: str | None = None
    created_at: str = field(default_factory=utc_now)
    started_at: str | None = None
    completed_at: str | None = None
    stage: str = "queued"
    error: str | None = None
    exit_code: int | None = None
    cancel_requested: bool = False
    logs: deque[str] = field(default_factory=lambda: deque(maxlen=300))
    assets: list[dict[str, Any]] = field(default_factory=list)
    parts: list[dict[str, Any]] = field(default_factory=list)

    def public(self, include_logs: bool = True, include_assets: bool = True) -> dict[str, Any]:
        payload = asdict(self)
        payload["logs"] = list(self.logs) if include_logs else []
        if not include_assets:
            payload["assets"] = []
            payload["parts"] = []
        if self.status == "completed":
            payload["download_url"] = f"/v1/layer-decompositions/{self.id}/download"
        return payload


_jobs: dict[str, Job] = {}
_state_lock = threading.Lock()
_persistence_lock = threading.Lock()
_active_job_id: str | None = None
_processes: dict[str, subprocess.Popen[str]] = {}


def create_job(
    settings: dict[str, Any],
    *,
    kind: str = "generation",
    parent_job_id: str | None = None,
    root_job_id: str | None = None,
    revision_number: int | None = None,
    replaced_parts: list[str] | None = None,
) -> Job:
    global _active_job_id
    with _state_lock:
        if _active_job_id is not None:
            active = _jobs.get(_active_job_id)
            if active and active.status in {"queued", "running"}:
                raise RuntimeError(f"job {active.id} is already running")
        job_id = uuid4().hex
        resolved_root_id = root_job_id or job_id
        if revision_number is None:
            revision_number = (
                max(
                    (
                        item.revision_number
                        for item in _jobs.values()
                        if (item.root_job_id or item.id) == resolved_root_id
                    ),
                    default=0,
                )
                + 1
                if kind in {"revision", "edit", "depth", "order"}
                else 0
            )
        job = Job(
            id=job_id,
            status="queued",
            settings=settings,
            kind=kind,
            parent_job_id=parent_job_id,
            root_job_id=resolved_root_id,
            revision_number=revision_number,
            replaced_parts=list(replaced_parts or []),
        )
        _jobs[job.id] = job
        _active_job_id = job.id
        return job


def get_job(job_id: str) -> Job | None:
    with _state_lock:
        return _jobs.get(job_id)


def revision_history(job_id: str) -> list[Job] | None:
    """Return every job in the same immutable revision tree."""
    with _state_lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        root_id = job.root_job_id or job.id
        related = [item for item in _jobs.values() if (item.root_job_id or item.id) == root_id]
        return sorted(related, key=lambda item: (item.created_at, item.id))


def accept_revision(job_id: str) -> Job | None:
    """Mark a completed candidate as kept without modifying its generated assets."""
    with _state_lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        if job.status != "completed":
            raise RuntimeError(f"job is {job.status}")
        if job.accepted_at is None:
            job.accepted_at = utc_now()
        accepted = job
    persist_job(accepted)
    return accepted


def discard_queued_job(job_id: str) -> None:
    """Release a job reservation when its input cannot be staged."""
    global _active_job_id
    with _state_lock:
        job = _jobs.get(job_id)
        if job is not None and job.status == "queued":
            _jobs.pop(job_id, None)
        if _active_job_id == job_id:
            _active_job_id = None


def _stop_process(process: subprocess.Popen[str]) -> None:
    """Terminate an inference process group, escalating if it does not exit."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (OSError, ProcessLookupError):
        try:
            process.terminate()
        except OSError:
            return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            try:
                process.kill()
            except OSError:
                pass


def cancel_job(job_id: str) -> Job | None:
    """Request cancellation while preserving serialization until GPU work exits."""
    global _active_job_id
    process: subprocess.Popen[str] | None = None
    with _state_lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        if job.status == "queued":
            job.cancel_requested = True
            job.status = "canceled"
            job.stage = "canceled"
            job.completed_at = utc_now()
            job.logs.append("Generation canceled before inference started")
            if _active_job_id == job.id:
                _active_job_id = None
        elif job.status == "running":
            job.cancel_requested = True
            job.stage = "canceling"
            job.logs.append("Cancellation requested; stopping inference")
            process = _processes.get(job.id)
        return_job = job
    persist_job(return_job)
    if process is not None:
        threading.Thread(target=_stop_process, args=(process,), daemon=True).start()
    return return_job


def active_job() -> Job | None:
    with _state_lock:
        return _jobs.get(_active_job_id) if _active_job_id else None


def pipeline_runtime(job: Job | None = None) -> dict[str, Any]:
    """Describe the fixed production pipeline and its current on-demand state."""
    stage = job.stage if job and job.status in {"queued", "running"} else None
    layerdiff_state = "on-demand"
    depth_state = "on-demand"
    if stage in {"queued", "starting"}:
        if job and job.kind == "order":
            pass
        elif job and job.kind in {"edit", "depth"}:
            depth_state = "loading" if job.kind == "depth" else "on-demand"
        else:
            layerdiff_state = "loading"
            depth_state = "pending"
    elif stage == "layer-decomposition":
        layerdiff_state = "active"
        depth_state = "pending"
    elif stage in {"layer-stitching", "depth-estimation"}:
        layerdiff_state = "on-demand" if job and job.kind in {"edit", "depth"} else "resident"
        depth_state = "active" if stage == "depth-estimation" else "pending"
    elif stage == "psd-assembly":
        layerdiff_state = "on-demand" if job and job.kind in {"edit", "depth", "order"} else "resident"
        depth_state = "resident" if job and job.settings.get("depth_recalculated") else "on-demand"

    return {
        "mode": "fixed",
        "load_strategy": "per-job subprocess",
        "summary": "LayerDiff 3D → Marigold Depth → PSD assembly",
        "models": [
            {
                "key": "layerdiff3d",
                "name": "LayerDiff 3D",
                "model_id": LAYERDIFF_MODEL_ID,
                "role": "Generates inpainted semantic RGBA character layers.",
                "pipeline_order": 1,
                "used_by_generation": True,
                "included_in_runtime": True,
                "state": layerdiff_state,
            },
            {
                "key": "marigold-depth",
                "name": "Marigold Depth",
                "model_id": DEPTH_MODEL_ID,
                "supporting_model_id": MARIGOLD_BASE_MODEL_ID,
                "role": "Estimates per-layer pseudo-depth for drawing order.",
                "pipeline_order": 2,
                "used_by_generation": True,
                "included_in_runtime": True,
                "state": depth_state,
            },
            {
                "key": "sam-body-parsing",
                "name": "SAM Body Parsing",
                "model_id": SAM_BODY_MODEL_ID,
                "role": "Optional 19-class body-part segmentation demo and research tool.",
                "pipeline_order": None,
                "used_by_generation": False,
                "included_in_runtime": False,
                "state": "optional-not-loaded",
            },
        ],
    }


def job_root(job_id: str) -> Path:
    return JOBS_ROOT / job_id


def input_path(job_id: str) -> Path:
    return job_root(job_id) / "input.png"


def output_root(job_id: str) -> Path:
    return job_root(job_id) / "output"


def persist_job(job: Job) -> None:
    """Atomically persist job metadata separately from the full inference log."""
    root = job_root(job.id)
    root.mkdir(parents=True, exist_ok=True)
    destination = root / "job.json"
    temporary = root / "job.json.tmp"
    with _persistence_lock:
        payload = job.public(include_logs=False)
        payload.pop("logs", None)
        temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        temporary.replace(destination)


def _set_stage(job: Job, line: str) -> None:
    lowered = line.lower()
    if "running layerdiff" in lowered:
        job.stage = "layer-decomposition"
    elif "stitching selected" in lowered:
        job.stage = "layer-stitching"
    elif "running marigold" in lowered:
        job.stage = "depth-estimation"
        job.settings["depth_recalculated"] = True
    elif "applying original pixels" in lowered:
        job.stage = "layer-editing"
    elif (
        "building revised psd" in lowered
        or "building edited psd" in lowered
        or "building depth revision psd" in lowered
        or "building manually ordered psd" in lowered
        or "psd saved" in lowered
    ):
        job.stage = "psd-assembly"


def _public_log_line(line: str) -> str | None:
    """Keep polling payloads readable while the complete raw log stays on disk."""
    cleaned = ANSI_ESCAPE.sub("", line).strip()
    if not cleaned or "Materializing param=" in cleaned:
        return None
    return cleaned


def _collect_assets(job: Job) -> list[dict[str, Any]]:
    root = job_root(job.id)
    assets: list[dict[str, Any]] = []
    allowed = {".png", ".json", ".psd"}
    for path in sorted(root.rglob("*")):
        relative_path = path.relative_to(root)
        if (
            not path.is_file()
            or path.suffix.lower() not in allowed
            or path == input_path(job.id)
            or path.name == "job.json"
            or ".candidate" in relative_path.parts
        ):
            continue
        relative = relative_path.as_posix()
        assets.append(
            {
                "name": path.name,
                "path": relative,
                "kind": path.suffix.lower().lstrip("."),
                "size": path.stat().st_size,
                "url": f"/v1/layer-decompositions/{job.id}/assets/{relative}",
            }
        )
    return assets


def run_job(job_id: str) -> None:
    global _active_job_id
    with _state_lock:
        job = _jobs.get(job_id)
        if job is None or job.status == "canceled" or job.cancel_requested:
            return
        job.status = "running"
        job.stage = "starting"
        job.started_at = utc_now()

    settings = job.settings
    command = [sys.executable, "-u"]
    if job.kind in {"revision", "edit", "depth", "order"}:
        if not job.parent_job_id:
            job.status = "failed"
            job.stage = "failed"
            job.error = "revision is missing its parent job"
            job.completed_at = utc_now()
            persist_job(job)
            with _state_lock:
                if _active_job_id == job.id:
                    _active_job_id = None
            return
        if job.kind == "order":
            layer_order = settings.get("layer_order")
            if not isinstance(layer_order, list) or not layer_order:
                job.status = "failed"
                job.stage = "failed"
                job.error = "order revision is missing its layer order"
                job.completed_at = utc_now()
                persist_job(job)
                with _state_lock:
                    if _active_job_id == job.id:
                        _active_job_id = None
                return
            command.extend(
                [
                    str(APP_ROOT / "inference" / "scripts" / "inference_order_revision.py"),
                    "--parent_dir",
                    str(output_root(job.parent_job_id) / "input"),
                    "--srcp",
                    str(input_path(job_id)),
                    "--save_dir",
                    str(output_root(job_id)),
                ]
            )
            for part in layer_order:
                command.extend(["--layer_order", part])
        elif job.kind == "edit":
            if len(job.replaced_parts) != 1:
                job.status = "failed"
                job.stage = "failed"
                job.error = "detail edit must contain exactly one layer"
                job.completed_at = utc_now()
                persist_job(job)
                with _state_lock:
                    if _active_job_id == job.id:
                        _active_job_id = None
                return
            command.extend(
                [
                    str(APP_ROOT / "inference" / "scripts" / "inference_layer_edit.py"),
                    "--parent_dir",
                    str(output_root(job.parent_job_id) / "input"),
                    "--part",
                    job.replaced_parts[0],
                    "--mask",
                    str(job_root(job.id) / "edit-mask.png"),
                    "--srcp",
                    str(input_path(job_id)),
                    "--save_dir",
                    str(output_root(job_id)),
                    "--seed",
                    str(settings["seed"]),
                    "--resolution_depth",
                    str(settings["depth_resolution"]),
                    "--repo_id_depth",
                    DEPTH_MODEL,
                ]
            )
            if settings.get("group_offload"):
                command.append("--group_offload")
        elif job.kind == "depth":
            command.extend(
                [
                    str(APP_ROOT / "inference" / "scripts" / "inference_depth_revision.py"),
                    "--parent_dir",
                    str(output_root(job.parent_job_id) / "input"),
                    "--srcp",
                    str(input_path(job_id)),
                    "--save_dir",
                    str(output_root(job_id)),
                    "--seed",
                    str(settings["seed"]),
                    "--resolution_depth",
                    str(settings["depth_resolution"]),
                    "--repo_id_depth",
                    DEPTH_MODEL,
                ]
            )
            if settings.get("group_offload"):
                command.append("--group_offload")
        else:
            command.extend(
                [
                    str(APP_ROOT / "inference" / "scripts" / "inference_revision.py"),
                    "--parent_dir",
                    str(output_root(job.parent_job_id) / "input"),
                ]
            )
            for part in job.replaced_parts:
                command.extend(["--replace_tag", part])
        if job.kind in {"revision", "edit"}:
            for part in settings.get("layer_order", []):
                command.extend(["--layer_order", part])
    else:
        command.extend(
            [
                str(APP_ROOT / "inference" / "scripts" / "inference_psd.py"),
                "--save_to_psd",
            ]
        )
    if job.kind in {"generation", "revision"}:
        command.extend(
            [
                "--srcp",
                str(input_path(job_id)),
                "--save_dir",
                str(output_root(job_id)),
                "--seed",
                str(settings["seed"]),
                "--resolution",
                str(settings["resolution"]),
                "--resolution_depth",
                str(settings["depth_resolution"]),
                "--inference_steps",
                str(settings["inference_steps"]),
                "--repo_id_layerdiff",
                LAYERDIFF_MODEL,
                "--repo_id_depth",
                DEPTH_MODEL,
            ]
        )
        if settings.get("group_offload"):
            command.append("--group_offload")

    start_labels = {
        "generation": "Starting See-through inference",
        "revision": "Starting See-through revision",
        "edit": "Starting See-through detail edit",
        "depth": "Starting See-through depth revision",
        "order": "Starting See-through order revision",
    }
    job.logs.append(start_labels.get(job.kind, "Starting See-through job"))
    job.logs.append("Command settings: " + ", ".join(f"{key}={value}" for key, value in settings.items()))
    persist_job(job)

    try:
        log_path = job_root(job_id) / "inference.log"
        with log_path.open("w", encoding="utf-8", buffering=1) as log_file:
            log_file.write(job.logs[0] + "\n")
            log_file.write(job.logs[1] + "\n")
            process = subprocess.Popen(
                command,
                cwd=APP_ROOT,
                env=os.environ.copy(),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                start_new_session=True,
            )
            with _state_lock:
                _processes[job.id] = process
                cancel_after_start = job.cancel_requested
            if cancel_after_start:
                threading.Thread(target=_stop_process, args=(process,), daemon=True).start()
            assert process.stdout is not None
            for raw_line in process.stdout:
                log_file.write(raw_line)
                line = _public_log_line(raw_line)
                if line:
                    if not job.logs or job.logs[-1] != line:
                        job.logs.append(line)
                    _set_stage(job, line)
            job.exit_code = process.wait()
        job.assets = _collect_assets(job)
        job.parts = layer_manifest(output_root(job.id) / "input", job.id)
        psd_path = output_root(job_id) / "input.psd"
        if job.cancel_requested:
            job.status = "canceled"
            job.stage = "canceled"
            job.error = None
            job.logs.append("Generation canceled")
        elif job.exit_code != 0:
            raise RuntimeError(f"inference process exited with code {job.exit_code}")
        elif not psd_path.is_file():
            raise RuntimeError("inference completed without producing input.psd")
        else:
            job.status = "completed"
            job.stage = "completed"
            if job.kind == "generation":
                job.accepted_at = utc_now()
    except Exception as exc:
        job.status = "failed"
        job.stage = "failed"
        job.error = str(exc)
        job.logs.append(f"ERROR: {exc}")
    finally:
        job.completed_at = utc_now()
        persist_job(job)
        with _state_lock:
            _processes.pop(job.id, None)
            if _active_job_id == job.id:
                _active_job_id = None


def gpu_runtime() -> dict[str, Any]:
    try:
        import torch

        available = torch.cuda.is_available()
        devices = []
        if available:
            for index in range(torch.cuda.device_count()):
                properties = torch.cuda.get_device_properties(index)
                devices.append(
                    {
                        "index": index,
                        "name": properties.name,
                        "vram_bytes": properties.total_memory,
                    }
                )
        return {
            "available": available,
            "torch_version": torch.__version__,
            "cuda_version": torch.version.cuda,
            "devices": devices,
        }
    except Exception as exc:
        return {"available": False, "error": str(exc), "devices": []}


def load_jobs_from_disk() -> None:
    """Restore completed jobs so downloads survive a service restart."""
    if not JOBS_ROOT.is_dir():
        return
    for root in JOBS_ROOT.iterdir():
        if not root.is_dir():
            continue
        metadata_path = root / "job.json"
        try:
            if metadata_path.is_file():
                payload = json.loads(metadata_path.read_text(encoding="utf-8"))
                job = Job(
                    id=payload["id"],
                    status=payload["status"],
                    settings=payload.get("settings", {}),
                    kind=payload.get("kind", "generation"),
                    parent_job_id=payload.get("parent_job_id"),
                    root_job_id=payload.get("root_job_id", payload["id"]),
                    revision_number=payload.get("revision_number", 0),
                    replaced_parts=payload.get("replaced_parts", []),
                    accepted_at=payload.get("accepted_at"),
                    created_at=payload.get("created_at", utc_now()),
                    started_at=payload.get("started_at"),
                    completed_at=payload.get("completed_at"),
                    stage=payload.get("stage", payload["status"]),
                    error=payload.get("error"),
                    exit_code=payload.get("exit_code"),
                    cancel_requested=payload.get("cancel_requested", False),
                    assets=payload.get("assets", []),
                    parts=payload.get("parts", []),
                )
            elif (root / "output" / "input.psd").is_file():
                timestamp = datetime.fromtimestamp(root.stat().st_mtime, UTC).isoformat()
                job = Job(
                    id=root.name,
                    status="completed",
                    settings={"recovered": True},
                    created_at=timestamp,
                    started_at=None,
                    completed_at=timestamp,
                    stage="completed",
                    exit_code=0,
                    root_job_id=root.name,
                    accepted_at=timestamp,
                )
            else:
                continue
            if job.status in {"queued", "running"}:
                job.status = "failed"
                job.stage = "failed"
                job.error = "service restarted before inference completed"
                job.completed_at = utc_now()
            job.assets = _collect_assets(job)
            if len(job.parts) != len(CANONICAL_PARTS):
                job.parts = layer_manifest(output_root(job.id) / "input", job.id)
            if job.kind == "generation" and job.status == "completed" and job.accepted_at is None:
                job.accepted_at = job.completed_at or job.created_at
            _jobs[job.id] = job
            persist_job(job)
        except (KeyError, OSError, ValueError, TypeError, json.JSONDecodeError):
            continue

    roots = {job.root_job_id or job.id for job in _jobs.values()}
    for root_id in roots:
        revisions = sorted(
            (
                job
                for job in _jobs.values()
                if (job.root_job_id or job.id) == root_id
                and job.kind in {"revision", "edit", "depth", "order"}
            ),
            key=lambda job: (job.created_at, job.id),
        )
        for revision_number, job in enumerate(revisions, start=1):
            if job.revision_number != revision_number:
                job.revision_number = revision_number
                persist_job(job)


load_jobs_from_disk()
