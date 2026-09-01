<p>
  <img src="https://github.com/Hangry-Labs/see-through/raw/main/see_through/brand/banner.jpg" alt="Hangry Labs banner">
</p>

# Hangry Labs See-through

Turn one anime character image into separate editable layers and a layered Photoshop file—privately on your own computer.

This Docker image includes:

- A simple browser interface
- Drag-and-drop image upload
- Automatic character layer generation
- An animated 2.5D layer preview
- Individual generated assets
- Layered PSD download
- A local HTTP API
- All required model files in the standard image

Your image stays on the computer running Docker. The application does not require a cloud image-processing service.

## What It Looks Like

Open the application in your browser, add an image, select the quality settings, and start generation:

<p>
  <img src="https://github.com/Hangry-Labs/see-through/raw/main/docs/ui1.jpg" alt="See-through browser interface generating character layers">
</p>

When generation finishes, you can inspect the generated pieces and download the layered PSD:

<p>
  <img src="https://github.com/Hangry-Labs/see-through/raw/main/docs/ui2.png" alt="See-through generated character assets">
</p>

## Before You Start

You need:

1. A computer with an NVIDIA graphics card
2. Current NVIDIA drivers
3. Docker with NVIDIA GPU support
4. Approximately 16 GB of GPU memory for the recommended experience

Windows users should install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) and enable its WSL 2 backend. Docker provides a separate [Windows GPU setup and test guide](https://docs.docker.com/desktop/features/gpu/).

Linux users need [Docker Engine](https://docs.docker.com/engine/install/) and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html).

## Start See-through

Open PowerShell, Windows Terminal, or a Linux terminal and copy these commands.

Create a place for generated files:

```bash
docker volume create see_through_workspace
```

Start the application:

```bash
docker run -d \
  --name see-through \
  --restart unless-stopped \
  --gpus all \
  -p 8000:8000 \
  -v see_through_workspace:/app/workspace \
  hangrylabs/see-through:latest
```

The first pull can take a while because the standard image contains the application and all model files.

When Docker reports the container is running, open:

```text
http://localhost:8000
```

## Generate a Layered PSD

1. Drop an anime character image onto the upload area.
2. Keep the default settings for your first test.
3. Select **Generate layered PSD**.
4. Wait while the application generates layers and estimates their depth.
5. Inspect the animated preview and individual assets.
6. Select **Download layered PSD**.

Generation can be stopped safely with **Stop generation** while a job is running.

## Recommended Settings

| Setting | Recommended starting value | What it changes |
|---------|----------------------------|-----------------|
| Output resolution | 768 px | Layer detail and GPU-memory use |
| Depth resolution | 512 px | Depth detail and GPU-memory use |
| Image framing | Preserve full image | Keeps the whole character and adds transparent padding |
| Seed | Empty / Random | Chooses a new generation result each time |
| Steps | 30 | Generation quality and time |
| 16 GB safe mode | Enabled | Reduces peak GPU-memory use but takes longer |

Use 1280 px output and 768 px depth for the upstream full-quality profile. Start with the lower settings first; higher resolutions take more GPU memory and more time.

Thirty steps is the model pipeline's standard inference default and the recommended starting point. More steps are slower and are not guaranteed to improve the result.

## Useful Commands

See whether the application is running:

```bash
docker ps --filter name=see-through
```

View its log:

```bash
docker logs -f see-through
```

Stop it:

```bash
docker stop see-through
```

Start it again later:

```bash
docker start see-through
```

## Update the Image

Stop and remove the old container:

```bash
docker stop see-through
docker rm see-through
```

Download the newest image:

```bash
docker pull hangrylabs/see-through:latest
```

Run the command from **Start See-through** again. Your completed jobs remain in the `see_through_workspace` Docker volume.

## Image Tags

- `latest` — recommended full image with all model files included
- `latest_tiny` — smaller application image that downloads models on first use
- `vX.Y.Z` — versioned full release, for example `v0.1.0`
- `vX.Y.Z_tiny` — versioned tiny release

The full image can run inference without contacting Hugging Face after it has been pulled.

## Tiny Image

The tiny image is intended for advanced users who prefer model files in a separate persistent cache:

```bash
docker volume create see_through_workspace
docker volume create see_through_hf_cache

docker run -d \
  --name see-through \
  --restart unless-stopped \
  --gpus all \
  -p 8000:8000 \
  -e HF_HUB_OFFLINE=0 \
  -e TRANSFORMERS_OFFLINE=0 \
  -v see_through_workspace:/app/workspace \
  -v see_through_hf_cache:/app/.cache/huggingface \
  hangrylabs/see-through:latest_tiny
```

An internet connection is required for its first model download.

## Troubleshooting

### The page does not open

Check the container:

```bash
docker ps --filter name=see-through
docker logs see-through
```

### Docker cannot access the GPU

Run:

```bash
docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi
```

If that fails, update the NVIDIA driver and verify Docker's NVIDIA GPU setup before running See-through again.

### Generation runs out of GPU memory

- Keep output resolution at 768 px.
- Keep depth resolution at 512 px.
- Enable **16 GB safe mode**.
- Close other applications using the GPU.

### Generation takes a long time

The two model stages run one after another and can take several minutes. Safe mode reduces memory use by moving model blocks between system memory and GPU memory, which makes generation slower.

## Local API

The UI and API run together on port `8000`.

- API documentation: `http://localhost:8000/docs`
- Health and GPU status: `GET /health/ready`
- Create a generation: `POST /v1/layer-decompositions`
- Read or stop a generation: `GET` or `DELETE /v1/layer-decompositions/{job_id}`

## Models

Each normal generation uses:

1. [LayerDiff3D](https://huggingface.co/layerdifforg/seethroughv0.0.2_layerdiff3d)
2. [Marigold Depth](https://huggingface.co/layerdifforg/seethroughv0.0.1_marigold)
3. PSD assembly

SAM Body Parsing is upstream research and annotation tooling. It is not used by this browser application's PSD generation pipeline.

## Privacy and Responsible Use

Inputs and generated files remain in the configured local workspace. The application has no built-in login screen, so do not expose port `8000` directly to an untrusted network.

Only process images you have permission to use. Generated layers can contain segmentation, inpainting, ordering, or reconstruction mistakes and should be reviewed before production use.

## Project and Attribution

- Hangry Labs repository: https://github.com/Hangry-Labs/see-through
- Original See-through project: https://github.com/shitagaki-lab/see-through
- Research paper: https://arxiv.org/abs/2602.03749
- License: Apache License 2.0
- Hangry Labs: https://nuggies.website/

The original See-through models, research, authorship, citation, and acknowledgements belong to the upstream project and its authors.
