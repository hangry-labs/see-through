# See-through

Local, private anime-character layer decomposition with a browser UI, HTTP API, layered PSD export, interactive 2.5D preview, selective regeneration, and manual source-detail recovery.

[![Docker Hub](https://img.shields.io/badge/Docker%20Hub-hangrylabs%2Fsee--through-2496ed?logo=docker&logoColor=white)](https://hub.docker.com/r/hangrylabs/see-through)
[![GitHub](https://img.shields.io/badge/GitHub-hangry--labs%2Fsee--through-181717?logo=github)](https://github.com/hangry-labs/see-through)
[![Upstream](https://img.shields.io/badge/Upstream-shitagaki--lab%2Fsee--through-555)](https://github.com/shitagaki-lab/see-through)

This distribution packages the [original See-through project](https://github.com/shitagaki-lab/see-through) as a simple, Docker-first local application. See the upstream repository for the research paper, native Python setup, training, dataset preparation, annotation tools, citation, and acknowledgements.

## Requirements

- An NVIDIA GPU; 16 GB VRAM is recommended
- Current NVIDIA drivers
- Docker with NVIDIA GPU access

On Windows, install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) and use its WSL 2 backend. Follow Docker's [GPU support guide](https://docs.docker.com/desktop/features/gpu/) to verify the GPU is available.

On Linux, install [Docker Engine](https://docs.docker.com/engine/install/) and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html).

## Run

The standard image contains all model files and does not download anything during inference.

```bash
docker volume create see_through_workspace

docker run -d \
  --name see-through \
  --restart unless-stopped \
  --gpus all \
  -p 8000:8000 \
  -v see_through_workspace:/app/workspace \
  hangrylabs/see-through:latest
```

Open [http://localhost:8000](http://localhost:8000), add an image, choose the generation settings, and select **Generate layered PSD**. The result view provides an animated 2.5D preview, press-and-hold source comparison, individual semantic layers, non-destructive refinement tools, and PSD download.

### Inspect the 2.5D result

Move the pointer over the 2.5D viewport to inspect layer separation, adjust motion strength, or pause the animation for a static comparison. Press and hold **Hold for original** to replace the moving layer stack with the aligned source; release it to return immediately to the generated result. This makes repeated before/after checks quick enough to spot softened details, missing pixels, and regeneration candidates.

The preview applies semantic ordering safeguards in addition to estimated depth. In particular, the neck is kept in front of topwear and neckwear is kept in front of the neck when the estimated medians would otherwise hide them.

### Improve individual layers

After generation, select any incorrect or empty layer cards and choose **Regenerate selected**. A fresh seed generates a candidate in an isolated revision, while every unselected layer stays byte-for-byte identical to the accepted result. See-through recalculates depth for the stitched layer set and builds a new PSD.

Review the assembled candidate and then choose:

- **Keep revision** to continue working from it
- **Try another seed** to repeat the same replacements from the last accepted result
- **Return to parent** to leave the candidate unchanged and go back

The revision timeline keeps the initial result, accepted revisions, unsuccessful candidates, and canceled attempts available without overwriting their parent artifacts. Empty layers are selectable, so a missing item such as footwear can be retried directly.

### Recover original details with the layer editor

Layer generation can soften fine visible details such as hair tips, jewellery, eyelashes, trim, or line work. Every available layer card in an accepted result has an **Edit details** action that opens the full-resolution recovery editor.

The editor does not generate new content. It paints an editable mask that chooses between two already aligned images:

- **Restore original** uses pixels from the original source image.
- **Use generated** removes restoration and returns the area to the generated layer.
- **Brush size** controls the complete affected diameter. The outer cursor ring shows its full reach.
- **Brush hardness** controls both the solid inner region and the strength of the feathered transition. The inner cursor ring shows the solid core. Low hardness produces a deliberately lighter, gradual blend instead of immediately reaching full source opacity.
- The mouse wheel zooms toward the pointer from 10% to 1200%. The zoom slider and **Fit canvas** remain available for larger movements.
- **Original reference**, **Selected layer**, and **Other layers** have independent opacity controls.
- The backdrop can be checkerboard, white, black, or any custom colour.
- Undo and redo are available from the toolbar; `Ctrl+Z`, `Ctrl+Shift+Z`, and `Ctrl+Y` are supported. The `[` and `]` keys adjust brush size.

A useful inspection setup is **Original reference: 0%**, **Selected layer: 100%**, and **Other layers: 0%**. This shows exactly which pixels belong to the edited asset against the chosen backdrop. Increase original opacity to locate details worth restoring, or increase other-layer opacity to inspect the complete static composition.

Selecting **Save detail revision** stores the mask and builds a reviewable child revision. The operation uses premultiplied-alpha blending and never reruns LayerDiff3D. Edits contained entirely inside the layer's existing visible area preserve the current depth maps and rebuild quickly on the CPU. If the edit reveals pixels that did not previously exist in that layer, See-through detects the alpha expansion and automatically reruns Marigold for the complete edited layer set before rebuilding the PSD. This gives restored pixels a real place in the 2.5D ordering instead of relying on a fallback depth.

Choose **Keep revision** to continue from the edit or **Return to parent** to leave it unaccepted. Kept masks can be reopened with **Continue editing**. Edits on untouched layers survive later selective-regeneration revisions; regenerating the edited semantic layer intentionally resets its recovery mask and establishes the new model output as its base.

The first editor version changes one semantic layer per saved revision. Restoring source pixels cannot invent details that were hidden in the input, and careless painting can copy pixels belonging to neighbouring objects. Use the isolated-layer view and contrasting backdrops to check the result before keeping it.

### Recalculate depth and ordering

On any accepted result, **Recalculate depth** creates an isolated candidate without changing the artwork layers. Choose a depth resolution from 512 to 1280 px and optionally enter a seed; leaving the seed empty generates a fresh one. Marigold recalculates every visible layer, the semantic ordering safeguards are applied during PSD assembly, and the result can be kept, retried with another seed, or discarded by returning to its parent.

Higher depth resolutions can preserve finer depth boundaries but require more GPU memory and time. A new seed may change the estimated ordering because Marigold's inference is seeded. While an edit, regeneration, or depth recalculation is active, the affected layer cards are dimmed and locked until the candidate is ready or the job stops.

Useful commands:

```bash
docker logs -f see-through
docker stop see-through
docker start see-through
```

To update the image:

```bash
docker stop see-through
docker rm see-through
docker pull hangrylabs/see-through:latest
```

Then run the original `docker run` command again. The named workspace volume preserves completed jobs.

## Image variants

| Tag | Contents | Runtime network |
|-----|----------|-----------------|
| `latest` or `vX.Y.Z` | Application and pinned model assets | Not required |
| `latest_tiny` or `vX.Y.Z_tiny` | Application only; models enter a mounted Hugging Face cache on first use | Required for the first download |

The baked `latest` image is recommended. The `tiny` image is mainly useful for development or environments where image transfer size matters more than first-run setup.

## Settings and hardware

- The default 768 px layer resolution and 512 px depth resolution are intended as a lower-memory starting point.
- Upstream full-quality generation uses 1280 px and approximately 12–16 GB VRAM.
- Lower resolutions use less memory but retain less detail.
- Group offload lowers peak VRAM use at the cost of generation speed.
- Selective regeneration reruns both model stages for the requested candidate layers.
- Manual detail edits do not rerun LayerDiff3D. Marigold runs automatically only when an edit makes pixels newly visible; contained edits remain CPU-only.
- Manual depth recalculation reruns Marigold for every visible layer without changing the artwork pixels.
- Only one generation, regeneration, detail-edit, or depth-recalculation job is processed at a time. Active jobs can be stopped from the UI or API.

## API

The UI and API share port `8000`.

- OpenAPI documentation: [http://localhost:8000/docs](http://localhost:8000/docs)
- Runtime and model status: `GET /health/ready`
- Create a job: `POST /v1/layer-decompositions`
- Read a job: `GET /v1/layer-decompositions/{job_id}`
- Stop a job: `DELETE /v1/layer-decompositions/{job_id}`
- Regenerate selected parts: `POST /v1/layer-decompositions/{job_id}/revisions`
- Apply a source-detail mask to one part: `POST /v1/layer-decompositions/{job_id}/edits`
- Recalculate all layer depths: `POST /v1/layer-decompositions/{job_id}/depth-revisions`
- Read its revision timeline: `GET /v1/layer-decompositions/{job_id}/revisions`
- Keep a completed candidate: `POST /v1/layer-decompositions/{job_id}/accept`
- Download its PSD: `GET /v1/layer-decompositions/{job_id}/download`

The detail-edit endpoint accepts multipart form data:

```bash
curl -X POST http://localhost:8000/v1/layer-decompositions/JOB_ID/edits \
  -F "part=front hair" \
  -F "mask=@front-hair-mask.png;type=image/png"
```

The mask must have the same full-canvas dimensions as the selected layer. Black keeps generated pixels, white restores original pixels, and intermediate values create a soft blend. A successful request returns `202 Accepted` with a normal queued job payload. Poll its job URL, review the completed candidate, and use the existing accept endpoint to keep it.

The depth-revision endpoint accepts optional `seed` and `depth_resolution` multipart fields. Supported depth resolutions are 512, 640, 768, 896, 1024, and 1280 px. Omitting the seed selects a new random value; omitting the resolution inherits it from the parent result.

Completed part records expose `url`, `base_url`, `edited`, and `edit_mask_url`. `base_url` is the untouched model result used by **Use generated**; `edit_mask_url` allows a kept edit to be reopened and adjusted.

## Local development

[Task](https://taskfile.dev/) provides the standard local workflow:

```bash
task image
task imagerun
task smoke
```

Use `task logs` to follow the service and `task imagestop` to stop it. Use `task image-tiny` and `task imagerun-tiny` for the cache-backed development image.

Dependencies are declared in `requirements.in` and compiled into the Docker-consumed `requirements.txt` lock with `task deps`.

Local test images belong in `test_assets/`, which is ignored by Git.

### Release workflow

Releases run from a clean `main` branch synchronized with `origin/main`. Preview the release first, then run it without `DRY_RUN` only when the reported version, tag, next snapshot, and validation results are correct:

```bash
task release DRY_RUN=1
task release
```

The root `VERSION` file is the single source of truth used by the runtime, API, and browser UI. The guarded release task validates that metadata and its runtime exposure, compiles the Python sources, checks the browser JavaScript, runs the unit suite inside the local `see-through:tiny` image, and validates the Dockerfile. It does not build or pull images locally.

The real release converts the current snapshot to a stable version, creates a release metadata commit and annotated `vX.Y.Z` tag, prepares the next minor snapshot commit, and atomically pushes `main` and the tag. GitHub Actions is solely responsible for publishing the full `vX.Y.Z`/`latest` and tiny `vX.Y.Z_tiny`/`latest_tiny` images. Use `NEXT_VERSION=0.1.1-snapshot` to override the default next-minor snapshot, or `SKIP_VALIDATION=1` only when the same release commit has already passed the complete validation suite.

Run the validation gate without invoking any release logic with:

```bash
task validate-release
```

## Version history

### v0.1.0 (in development)

- Packaged the upstream See-through inference pipeline as full offline and cache-backed tiny Docker images with pinned model revisions.
- Added a combined FastAPI browser application and HTTP API on port 8000 with health, model-status, progress, cancellation, asset, and PSD-download routes.
- Added drag-and-drop image input, framing, quality, seed, inference-step, and 16 GB VRAM-safe group-offload controls.
- Added an interactive 2.5D layer preview with pointer motion, adjustable strength, pause, and press-and-hold original-image comparison.
- Added semantic depth safeguards so neck, topwear, and neckwear remain in a sensible visual order.
- Added immutable revision history and selective regeneration of incorrect or missing semantic layers while preserving accepted parent results.
- Added a full-resolution source-detail editor with restore/erase painting, soft brush falloff, brush-footprint outlines, undo/redo, pointer-centered zoom up to 1200%, configurable backdrops, and independent source, selected-layer, and composition opacity.
- Added retained editable masks, premultiplied-alpha blending, automatic Marigold recalculation when restored pixels expand a layer, manual seeded depth revisions from 512 to 1280 px, and clear per-layer processing states.
- Added automated source checks plus full and tiny Docker publication workflows for rolling and immutable release tags.
- Preserved local workspace privacy, upstream authorship, research citations, model attribution, and the Apache-2.0 license.

## Models and pipeline

PSD generation always uses this pipeline:

1. [LayerDiff3D](https://huggingface.co/layerdifforg/seethroughv0.0.2_layerdiff3d) generates transparent semantic layers.
2. [Marigold Depth](https://huggingface.co/layerdifforg/seethroughv0.0.1_marigold) estimates their relative depth.
3. The application applies semantic depth-order constraints and assembles the generated assets into a layered PSD.

Selective layer regeneration runs the same models and stitches only the requested candidate layers into the parent result. Manual detail recovery copies source pixels through the user-painted mask; it preserves existing depth for contained edits and automatically reruns Marigold when new visible pixels need ordering. Manual depth revisions can also rerun Marigold for the unchanged accepted artwork with a chosen seed and resolution.

[SAM Body Parsing](https://huggingface.co/24yearsold/l2d_sam_iter2) belongs to upstream annotation and research tooling. It is not loaded by the browser/API generation pipeline.

## Data and privacy

Inputs, generated files, immutable revision parents, detail masks, and editor base layers remain in `/app/workspace/jobs/`, backed by the configured Docker volume. The service does not include authentication. Do not expose port `8000` to an untrusted network without an authenticated reverse proxy.

Only process images you have permission to use. Generated layers can contain segmentation, inpainting, ordering, or reconstruction errors and should be reviewed before production use.

## Upstream and license

See-through was created by Jian Lin, Chengze Li, Haoyun Qin, Kwun Wang Chan, Yanghua Jin, Hanyuan Liu, Stephen Chun Wang Choy, and Xueting Liu.

- Original project and complete research documentation: [shitagaki-lab/see-through](https://github.com/shitagaki-lab/see-through)
- Paper: [arXiv](https://arxiv.org/abs/2602.03749) · [ACM Digital Library](https://dl.acm.org/doi/10.1145/3799902.3811209)
- License: [Apache License 2.0](LICENSE)

Upstream training, dataset-preparation, annotator, and desktop annotation UI documentation remains available in the [original repository](https://github.com/shitagaki-lab/see-through). Training and annotator packages are intentionally not carried by this application because they are not used for local PSD generation.
