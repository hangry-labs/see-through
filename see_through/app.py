"""FastAPI service and local browser UI for See-through."""

from __future__ import annotations

import mimetypes
import os
import secrets
import shutil
from io import BytesIO
from pathlib import Path

import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageChops, UnidentifiedImageError

from see_through import __version__
from see_through.revisions import (
    available_layer_order,
    layer_manifest,
    validate_edit_part,
    validate_layer_order,
    validate_replacement_parts,
)
from see_through.runtime import (
    JOBS_ROOT,
    accept_revision,
    active_job,
    cancel_job,
    create_job,
    discard_queued_job,
    get_job,
    gpu_runtime,
    input_path,
    job_root,
    output_root,
    pipeline_runtime,
    persist_job,
    revision_history,
    run_job,
)


MAX_UPLOAD_BYTES = int(os.getenv("SEE_THROUGH_MAX_UPLOAD_BYTES", str(30 * 1024 * 1024)))
MAX_EDIT_MASK_BYTES = int(os.getenv("SEE_THROUGH_MAX_EDIT_MASK_BYTES", str(16 * 1024 * 1024)))
SUPPORTED_DEPTH_RESOLUTIONS = {512, 640, 768, 896, 1024, 1280}
STATIC_ROOT = Path(__file__).resolve().parent / "static"
BRAND_ROOT = Path(__file__).resolve().parent / "brand"

app = FastAPI(
    title="See-through API",
    description="Local anime-character layer decomposition, non-destructive refinement, detail recovery, and PSD generation.",
    version=__version__,
)
app.mount("/static", StaticFiles(directory=STATIC_ROOT), name="static")
app.mount("/brand", StaticFiles(directory=BRAND_ROOT), name="brand")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_ROOT / "index.html")


@app.get("/health/live")
def health_live() -> dict[str, object]:
    return {"status": "ok", "version": __version__}


@app.get("/health/ready")
def health_ready() -> dict[str, object]:
    gpu = gpu_runtime()
    current = active_job()
    return {
        "status": "ready" if gpu.get("available") else "degraded",
        "version": __version__,
        "gpu": gpu,
        "pipeline": pipeline_runtime(current),
        "active_job": current.public(include_logs=False) if current else None,
    }


@app.get("/health")
def health() -> dict[str, object]:
    return health_ready()


@app.get("/v1/runtime")
def runtime_info() -> dict[str, object]:
    return health_ready()


@app.post("/v1/layer-decompositions", status_code=status.HTTP_202_ACCEPTED)
async def create_decomposition(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    seed: int | None = Form(None, ge=0, le=2_147_483_647),
    resolution: int = Form(1280),
    depth_resolution: int = Form(768),
    inference_steps: int = Form(30, ge=1, le=100),
    group_offload: bool = Form(True),
) -> dict[str, object]:
    if resolution not in {768, 896, 1024, 1152, 1280}:
        raise HTTPException(422, "resolution must be one of 768, 896, 1024, 1152, or 1280")
    if depth_resolution not in SUPPORTED_DEPTH_RESOLUTIONS:
        raise HTTPException(422, "depth_resolution is not supported")

    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"image exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB upload limit")
    try:
        image = Image.open(BytesIO(content))
        image.verify()
        image = Image.open(BytesIO(content)).convert("RGBA")
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(422, "uploaded file is not a supported image") from exc
    if image.width < 64 or image.height < 64 or image.width > 8192 or image.height > 8192:
        raise HTTPException(422, "image dimensions must be between 64 and 8192 pixels")

    settings = {
        "seed": seed if seed is not None else secrets.randbelow(2_147_483_648),
        "resolution": resolution,
        "depth_resolution": depth_resolution,
        "inference_steps": inference_steps,
        "group_offload": group_offload,
    }
    try:
        job = create_job(settings)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc

    try:
        root = job_root(job.id)
        root.mkdir(parents=True, exist_ok=False)
        output_root(job.id).mkdir(parents=True, exist_ok=True)
        image.save(input_path(job.id), format="PNG")
        persist_job(job)
    except (OSError, ValueError) as exc:
        discard_queued_job(job.id)
        raise HTTPException(500, "could not stage the uploaded image") from exc
    background_tasks.add_task(run_job, job.id)
    return job.public()


@app.get("/v1/layer-decompositions/{job_id}")
def decomposition_status(job_id: str, include_logs: bool = True) -> dict[str, object]:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.status == "completed" and (
        not job.parts
        or any("base_url" not in part or "edit_mask_url" not in part for part in job.parts)
    ):
        job.parts = layer_manifest(output_root(job.id) / "input", job.id)
        persist_job(job)
    return job.public(include_logs=include_logs)


@app.post(
    "/v1/layer-decompositions/{job_id}/revisions",
    status_code=status.HTTP_202_ACCEPTED,
)
def create_decomposition_revision(
    job_id: str,
    background_tasks: BackgroundTasks,
    parts: list[str] = Form(...),
    seed: int | None = Form(None, ge=0, le=2_147_483_647),
    inference_steps: int | None = Form(None, ge=1, le=100),
) -> dict[str, object]:
    parent = get_job(job_id)
    if parent is None:
        raise HTTPException(404, "parent job not found")
    if parent.status != "completed":
        raise HTTPException(409, f"parent job is {parent.status}")
    if not input_path(parent.id).is_file() or not (output_root(parent.id) / "input").is_dir():
        raise HTTPException(409, "parent job does not contain reusable inference layers")
    try:
        replacement_parts = validate_replacement_parts(parts)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    required_settings = {"resolution", "depth_resolution", "inference_steps", "group_offload"}
    if not required_settings.issubset(parent.settings):
        raise HTTPException(409, "parent job does not contain reusable generation settings")
    settings = {
        "seed": seed if seed is not None else secrets.randbelow(2_147_483_648),
        "resolution": parent.settings["resolution"],
        "depth_resolution": parent.settings["depth_resolution"],
        "inference_steps": inference_steps or parent.settings["inference_steps"],
        "group_offload": parent.settings["group_offload"],
    }
    if isinstance(parent.settings.get("layer_order"), list):
        settings["layer_order"] = list(parent.settings["layer_order"])
    try:
        revision = create_job(
            settings,
            kind="revision",
            parent_job_id=parent.id,
            root_job_id=parent.root_job_id or parent.id,
            replaced_parts=replacement_parts,
        )
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc

    try:
        root = job_root(revision.id)
        root.mkdir(parents=True, exist_ok=False)
        output_root(revision.id).mkdir(parents=True, exist_ok=True)
        shutil.copy2(input_path(parent.id), input_path(revision.id))
        persist_job(revision)
    except OSError as exc:
        discard_queued_job(revision.id)
        raise HTTPException(500, "could not stage the revision") from exc
    background_tasks.add_task(run_job, revision.id)
    return revision.public()


@app.post(
    "/v1/layer-decompositions/{job_id}/edits",
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_layer_detail_edit(
    job_id: str,
    background_tasks: BackgroundTasks,
    part: str = Form(...),
    mask: UploadFile = File(...),
) -> dict[str, object]:
    """Create a detail revision, recalculating depth if pixels become newly visible."""
    parent = get_job(job_id)
    if parent is None:
        raise HTTPException(404, "parent job not found")
    if parent.status != "completed":
        raise HTTPException(409, f"parent job is {parent.status}")
    parent_layers = output_root(parent.id) / "input"
    if not input_path(parent.id).is_file() or not parent_layers.is_dir():
        raise HTTPException(409, "parent job does not contain editable inference layers")
    try:
        edit_part = validate_edit_part(part)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    layer_path = parent_layers / f"{edit_part}.png"
    if not layer_path.is_file():
        raise HTTPException(409, f"parent job does not contain the {edit_part} layer")

    content = await mask.read(MAX_EDIT_MASK_BYTES + 1)
    if len(content) > MAX_EDIT_MASK_BYTES:
        raise HTTPException(413, "edit mask exceeds the 16 MiB upload limit")
    try:
        with Image.open(layer_path) as layer:
            expected_size = layer.size
        with Image.open(BytesIO(content)) as uploaded_mask:
            if uploaded_mask.size != expected_size:
                raise HTTPException(
                    422,
                    f"edit mask dimensions must be {expected_size[0]}x{expected_size[1]}",
                )
            uploaded_mask.load()
            if "A" in uploaded_mask.getbands():
                rgba_mask = uploaded_mask.convert("RGBA")
                normalized_mask = ImageChops.multiply(
                    rgba_mask.convert("L"),
                    rgba_mask.getchannel("A"),
                )
            else:
                normalized_mask = uploaded_mask.convert("L")
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(422, "uploaded edit mask is not a supported image") from exc

    settings = dict(parent.settings)
    settings["edit_part"] = edit_part
    settings["depth_recalculated"] = False
    try:
        edit = create_job(
            settings,
            kind="edit",
            parent_job_id=parent.id,
            root_job_id=parent.root_job_id or parent.id,
            replaced_parts=[edit_part],
        )
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc

    try:
        root = job_root(edit.id)
        root.mkdir(parents=True, exist_ok=False)
        output_root(edit.id).mkdir(parents=True, exist_ok=True)
        shutil.copy2(input_path(parent.id), input_path(edit.id))
        normalized_mask.save(root / "edit-mask.png", format="PNG")
        persist_job(edit)
    except (OSError, ValueError) as exc:
        discard_queued_job(edit.id)
        raise HTTPException(500, "could not stage the detail edit") from exc
    background_tasks.add_task(run_job, edit.id)
    return edit.public()


@app.post(
    "/v1/layer-decompositions/{job_id}/depth-revisions",
    status_code=status.HTTP_202_ACCEPTED,
)
def create_depth_revision(
    job_id: str,
    background_tasks: BackgroundTasks,
    seed: int | None = Form(None, ge=0, le=2_147_483_647),
    depth_resolution: int | None = Form(None),
) -> dict[str, object]:
    """Create an immutable candidate with freshly inferred depth for every layer."""
    parent = get_job(job_id)
    if parent is None:
        raise HTTPException(404, "parent job not found")
    if parent.status != "completed":
        raise HTTPException(409, f"parent job is {parent.status}")
    parent_layers = output_root(parent.id) / "input"
    if not input_path(parent.id).is_file() or not parent_layers.is_dir():
        raise HTTPException(409, "parent job does not contain reusable inference layers")
    if "group_offload" not in parent.settings:
        raise HTTPException(409, "parent job does not contain reusable generation settings")

    resolved_depth_resolution = (
        parent.settings.get("depth_resolution") if depth_resolution is None else depth_resolution
    )
    if resolved_depth_resolution not in SUPPORTED_DEPTH_RESOLUTIONS:
        raise HTTPException(422, "depth_resolution is not supported")
    settings = dict(parent.settings)
    settings.pop("edit_part", None)
    settings.pop("layer_order", None)
    settings.update(
        {
            "seed": seed if seed is not None else secrets.randbelow(2_147_483_648),
            "depth_resolution": resolved_depth_resolution,
            "depth_recalculated": True,
        }
    )
    try:
        revision = create_job(
            settings,
            kind="depth",
            parent_job_id=parent.id,
            root_job_id=parent.root_job_id or parent.id,
        )
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc

    try:
        root = job_root(revision.id)
        root.mkdir(parents=True, exist_ok=False)
        output_root(revision.id).mkdir(parents=True, exist_ok=True)
        shutil.copy2(input_path(parent.id), input_path(revision.id))
        persist_job(revision)
    except OSError as exc:
        discard_queued_job(revision.id)
        raise HTTPException(500, "could not stage the depth revision") from exc
    background_tasks.add_task(run_job, revision.id)
    return revision.public()


@app.post(
    "/v1/layer-decompositions/{job_id}/order-revisions",
    status_code=status.HTTP_202_ACCEPTED,
)
def create_order_revision(
    job_id: str,
    background_tasks: BackgroundTasks,
    order: list[str] = Form(...),
) -> dict[str, object]:
    """Create an immutable candidate with a user-defined front-to-back stack."""
    parent = get_job(job_id)
    if parent is None:
        raise HTTPException(404, "parent job not found")
    if parent.status != "completed":
        raise HTTPException(409, f"parent job is {parent.status}")
    parent_layers = output_root(parent.id) / "input"
    if not input_path(parent.id).is_file() or not parent_layers.is_dir():
        raise HTTPException(409, "parent job does not contain reusable inference layers")
    try:
        layer_order = validate_layer_order(order, available_layer_order(parent_layers))
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc

    settings = dict(parent.settings)
    settings.pop("edit_part", None)
    settings["layer_order"] = layer_order
    settings["depth_recalculated"] = False
    try:
        revision = create_job(
            settings,
            kind="order",
            parent_job_id=parent.id,
            root_job_id=parent.root_job_id or parent.id,
        )
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc

    try:
        root = job_root(revision.id)
        root.mkdir(parents=True, exist_ok=False)
        output_root(revision.id).mkdir(parents=True, exist_ok=True)
        shutil.copy2(input_path(parent.id), input_path(revision.id))
        persist_job(revision)
    except OSError as exc:
        discard_queued_job(revision.id)
        raise HTTPException(500, "could not stage the order revision") from exc
    background_tasks.add_task(run_job, revision.id)
    return revision.public()


@app.get("/v1/layer-decompositions/{job_id}/revisions")
def decomposition_revisions(job_id: str) -> dict[str, object]:
    jobs = revision_history(job_id)
    if jobs is None:
        raise HTTPException(404, "job not found")
    return {
        "root_job_id": jobs[0].root_job_id or jobs[0].id,
        "items": [job.public(include_logs=False, include_assets=False) for job in jobs],
    }


@app.post("/v1/layer-decompositions/{job_id}/accept")
def keep_decomposition_revision(job_id: str) -> dict[str, object]:
    try:
        job = accept_revision(job_id)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    if job is None:
        raise HTTPException(404, "job not found")
    return job.public(include_logs=False)


@app.delete("/v1/layer-decompositions/{job_id}", status_code=status.HTTP_202_ACCEPTED)
def cancel_decomposition(job_id: str) -> dict[str, object]:
    job = cancel_job(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.status not in {"queued", "running", "canceled"}:
        raise HTTPException(409, f"job is already {job.status}")
    return job.public()


@app.get("/v1/layer-decompositions/{job_id}/download")
def download_psd(job_id: str) -> FileResponse:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.status != "completed":
        raise HTTPException(409, f"job is {job.status}")
    path = output_root(job_id) / "input.psd"
    if not path.is_file():
        raise HTTPException(404, "PSD output is missing")
    return FileResponse(path, media_type="image/vnd.adobe.photoshop", filename=f"see-through-{job_id[:8]}.psd")


@app.get("/v1/layer-decompositions/{job_id}/assets/{asset_path:path}")
def job_asset(job_id: str, asset_path: str) -> FileResponse:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    root = job_root(job_id).resolve()
    path = (root / asset_path).resolve()
    if root not in path.parents or not path.is_file():
        raise HTTPException(404, "asset not found")
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type)


if __name__ == "__main__":
    JOBS_ROOT.mkdir(parents=True, exist_ok=True)
    uvicorn.run(
        "see_through.app:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        log_level=os.getenv("LOG_LEVEL", "info"),
    )
