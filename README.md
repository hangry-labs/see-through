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

Selecting **Save detail revision** stores the mask and builds a reviewable child revision. The operation uses premultiplied-alpha blending, gives newly visible pixels a suitable depth derived from the existing layer, and rebuilds the PSD without rerunning LayerDiff3D or Marigold. It is therefore a CPU post-processing operation rather than another model generation.

Choose **Keep revision** to continue from the edit or **Return to parent** to leave it unaccepted. Kept masks can be reopened with **Continue editing**. Edits on untouched layers survive later selective-regeneration revisions; regenerating the edited semantic layer intentionally resets its recovery mask and establishes the new model output as its base.

The first editor version changes one semantic layer per saved revision. Restoring source pixels cannot invent details that were hidden in the input, and careless painting can copy pixels belonging to neighbouring objects. Use the isolated-layer view and contrasting backdrops to check the result before keeping it.

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
- Manual detail edits do not rerun either model; only mask application and PSD reconstruction run on the CPU.
- Only one generation, regeneration, or detail-edit job is processed at a time. Active jobs can be stopped from the UI or API.

## API

The UI and API share port `8000`.

- OpenAPI documentation: [http://localhost:8000/docs](http://localhost:8000/docs)
- Runtime and model status: `GET /health/ready`
- Create a job: `POST /v1/layer-decompositions`
- Read a job: `GET /v1/layer-decompositions/{job_id}`
- Stop a job: `DELETE /v1/layer-decompositions/{job_id}`
- Regenerate selected parts: `POST /v1/layer-decompositions/{job_id}/revisions`
- Apply a source-detail mask to one part: `POST /v1/layer-decompositions/{job_id}/edits`
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

## Models and pipeline

PSD generation always uses this pipeline:

1. [LayerDiff3D](https://huggingface.co/layerdifforg/seethroughv0.0.2_layerdiff3d) generates transparent semantic layers.
2. [Marigold Depth](https://huggingface.co/layerdifforg/seethroughv0.0.1_marigold) estimates their relative depth.
3. The application applies semantic depth-order constraints and assembles the generated assets into a layered PSD.

Selective layer regeneration runs the same models and stitches only the requested candidate layers into the parent result. Manual detail recovery is separate post-processing: it copies source pixels through the user-painted mask and reconstructs the PSD without model inference.

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
