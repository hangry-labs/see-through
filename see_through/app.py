"""FastAPI service and local browser UI for See-through."""

from __future__ import annotations

import mimetypes
import os
from io import BytesIO
from pathlib import Path

import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError

from see_through import __version__
from see_through.runtime import (
    JOBS_ROOT,
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
    run_job,
)


MAX_UPLOAD_BYTES = int(os.getenv("SEE_THROUGH_MAX_UPLOAD_BYTES", str(30 * 1024 * 1024)))
STATIC_ROOT = Path(__file__).resolve().parent / "static"
BRAND_ROOT = Path(__file__).resolve().parent / "brand"

app = FastAPI(
    title="See-through API",
    description="Local anime-character layer decomposition and PSD generation.",
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
    seed: int = Form(42, ge=0, le=2_147_483_647),
    resolution: int = Form(1280),
    depth_resolution: int = Form(768),
    inference_steps: int = Form(30, ge=1, le=100),
    group_offload: bool = Form(True),
) -> dict[str, object]:
    if resolution not in {768, 896, 1024, 1152, 1280}:
        raise HTTPException(422, "resolution must be one of 768, 896, 1024, 1152, or 1280")
    if depth_resolution not in {512, 640, 768, 896, 1024, 1280}:
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
        "seed": seed,
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
    return job.public(include_logs=include_logs)


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
