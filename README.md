# See-through

Local, private anime-character layer decomposition with a browser UI, HTTP API, layered PSD export, and an interactive 2.5D preview.

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

Open [http://localhost:8000](http://localhost:8000), add an image, choose the generation settings, and select **Generate layered PSD**. The result view provides the reconstructed preview, individual layers, and PSD download.

### Improve individual layers

After generation, select any incorrect or empty layer cards and choose **Regenerate selected**. A fresh seed generates a candidate in an isolated revision, while every unselected layer stays byte-for-byte identical to the accepted result. See-through recalculates depth for the stitched layer set and builds a new PSD.

Review the assembled candidate and then choose:

- **Keep revision** to continue working from it
- **Try another seed** to repeat the same replacements from the last accepted result
- **Return to parent** to leave the candidate unchanged and go back

The revision timeline keeps the initial result, accepted revisions, unsuccessful candidates, and canceled attempts available without overwriting their parent artifacts. Empty layers are selectable, so a missing item such as footwear can be retried directly.

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
- Only one generation job runs at a time. Active jobs can be stopped from the UI or API.

## API

The UI and API share port `8000`.

- OpenAPI documentation: [http://localhost:8000/docs](http://localhost:8000/docs)
- Runtime and model status: `GET /health/ready`
- Create a job: `POST /v1/layer-decompositions`
- Read a job: `GET /v1/layer-decompositions/{job_id}`
- Stop a job: `DELETE /v1/layer-decompositions/{job_id}`
- Regenerate selected parts: `POST /v1/layer-decompositions/{job_id}/revisions`
- Read its revision timeline: `GET /v1/layer-decompositions/{job_id}/revisions`
- Keep a completed candidate: `POST /v1/layer-decompositions/{job_id}/accept`
- Download its PSD: `GET /v1/layer-decompositions/{job_id}/download`

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
3. The application assembles the generated assets into a layered PSD.

[SAM Body Parsing](https://huggingface.co/24yearsold/l2d_sam_iter2) belongs to upstream annotation and research tooling. It is not loaded by the browser/API generation pipeline.

## Data and privacy

Inputs and generated files remain in `/app/workspace/jobs/`, backed by the configured Docker volume. The service does not include authentication. Do not expose port `8000` to an untrusted network without an authenticated reverse proxy.

Only process images you have permission to use. Generated layers can contain segmentation, inpainting, ordering, or reconstruction errors and should be reviewed before production use.

## Upstream and license

See-through was created by Jian Lin, Chengze Li, Haoyun Qin, Kwun Wang Chan, Yanghua Jin, Hanyuan Liu, Stephen Chun Wang Choy, and Xueting Liu.

- Original project and complete research documentation: [shitagaki-lab/see-through](https://github.com/shitagaki-lab/see-through)
- Paper: [arXiv](https://arxiv.org/abs/2602.03749) · [ACM Digital Library](https://dl.acm.org/doi/10.1145/3799902.3811209)
- License: [Apache License 2.0](LICENSE)

Upstream training, dataset-preparation, annotator, and desktop annotation UI documentation remains available in the [original repository](https://github.com/shitagaki-lab/see-through). Training and annotator packages are intentionally not carried by this application because they are not used for local PSD generation.
