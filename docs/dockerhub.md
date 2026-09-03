<p>
  <img src="https://github.com/Hangry-Labs/see-through/raw/main/see_through/brand/banner.jpg" alt="Hangry Labs banner">
</p>

# Hangry Labs See-through

Turn one anime character image into separate editable layers and a layered Photoshop fileâ€”privately on your own computer.

This Docker image includes:

- A simple browser interface
- Drag-and-drop image upload
- Automatic character layer generation
- An animated 2.5D layer preview
- Press-and-hold original/2.5D comparison
- Individual generated assets
- Selective regeneration of incorrect or missing layers
- A full-resolution brush editor for restoring source detail
- Non-destructive revision history
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
5. Inspect the animated preview and individual assets. Press and hold **Hold for original** to compare the source against the generated 2.5D result, then release it to return to motion.
6. Download the layered PSD, selectively regenerate incorrect layers, or use **Edit details** to restore fine source pixels before export.

Generation can be stopped safely with **Stop generation** while a job is running.

Move the pointer over the 2.5D preview to inspect layer separation, change motion strength, or pause it. The preview combines estimated depth with semantic safeguards so connected clothing and body layers remain sensibleâ€”for example, neck stays in front of topwear and neckwear stays in front of neck.

## Fix an Incorrect or Missing Layer

You do not need to discard a mostly good result when only a few pieces are wrong.

1. Select the cards for the layers you want to replace. Empty cards can also be selected.
2. Leave **Revision seed** empty to try a fresh random result.
3. Select **Regenerate selected**.
4. Wait while See-through generates a candidate and rebuilds its depth and PSD.
5. Inspect the complete animated preview and highlighted replacement cards. Press and release **Hold for original** as often as needed to spot changed details.
6. Select **Keep revision** if it is better, or **Try another seed** to make another attempt.

Only the selected image layers are taken from the new attempt. All other image layers come from the accepted parent result. The revision timeline lets you return to earlier results, and unsuccessful or canceled attempts do not overwrite them.

## Restore Fine Details from the Original

Generated layers can lose small visible details such as thin hair tips, eyelashes, jewellery, clothing trim, or sharp line work. The detail editor lets you recover those pixels from the aligned source without generating the whole image again.

1. Open an accepted result and select **Edit details** on the semantic layer you want to improve.
2. Choose **Restore original** and paint over details that should come from the source image.
3. Choose **Use generated** to erase restoration from an area without damaging the generated base layer.
4. Adjust brush size and hardness. The outer cursor ring shows the complete affected area; the inner ring shows the solid core. Low hardness creates a lighter feathered blend.
5. Scroll the mouse wheel over the image to zoom toward the pointer. Zoom ranges from 10% to 1200%, with a slider and **Fit canvas** available as well.
6. Select **Save detail revision**, inspect the rebuilt result, and choose **Keep revision** or **Return to parent**.

The editor provides three independent visibility controls:

- **Original reference** reveals the source beneath the working composition.
- **Selected layer** changes the opacity of the asset being edited.
- **Other layers** reveals the rest of the static composition.

The backdrop can be checkerboard, white, black, or a custom colour. To inspect the exact edited asset, set original and other-layer opacity to 0%, keep the selected layer at 100%, and choose a contrasting backdrop. This makes accidentally restored pixels easy to find.

Undo and redo are available in the toolbar. `Ctrl+Z`, `Ctrl+Shift+Z`, and `Ctrl+Y` work from the keyboard, while `[` and `]` change brush size.

Saving an edit stores the painted mask as a non-destructive child revision and never reruns LayerDiff3D. If the edit stays inside pixels already visible in the layer, the existing depth maps are preserved and the PSD is rebuilt on the CPU. If source restoration makes previously absent pixels visible, See-through detects that alpha expansion and automatically reruns Marigold for the complete edited layer set before PSD assembly. Kept edits can be reopened with **Continue editing**, and their masks remain adjustable. If that same semantic layer is later regenerated, its previous detail mask is intentionally reset; edits on other layers remain intact.

The editor copies pixels that are already visible in the original image. It does not generate parts hidden behind hair, clothing, or accessories. Paint one semantic layer at a time and use the isolated view to avoid copying pixels belonging to neighbouring objects.

## Recalculate Depth and Layer Ordering

Use **Recalculate depth** on an accepted result when the artwork looks correct but its 2.5D ordering needs another attempt. Choose a depth resolution from 512 to 1280 px and optionally enter a seed. An empty seed selects a fresh random value.

This creates an isolated candidate containing exactly the same artwork pixels as its parent. Marigold recalculates every visible layer, and the semantic ordering safeguards are applied when the PSD is rebuilt. Inspect the motion preview, then keep the candidate, retry it with another seed, or return to the parent. Higher resolutions can improve fine depth boundaries but use more GPU memory and time.

Affected asset cards are dimmed and locked while detail edits, selective regeneration, or depth recalculation are running. They become interactive again when the candidate completes, fails, or is canceled.

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

- `latest` â€” recommended full image with all model files included
- `latest_tiny` â€” smaller application image that downloads models on first use
- `vX.Y.Z` â€” versioned full release, for example `v0.1.0`
- `vX.Y.Z_tiny` â€” versioned tiny release

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

### Edit details is not shown

Detail editing is available on completed, accepted results. If you are reviewing a candidate revision, choose **Keep revision** first or return to its accepted parent.

### Soft brush strokes still restore too much

Start with hardness near 0% and make one pass. Repeated passes intentionally accumulate restoration. Use **Use generated** with a soft brush to reduce an area, or undo and repaint it.

## Local API

The UI and API run together on port `8000`.

- API documentation: `http://localhost:8000/docs`
- Health and GPU status: `GET /health/ready`
- Create a generation: `POST /v1/layer-decompositions`
- Read or stop a generation: `GET` or `DELETE /v1/layer-decompositions/{job_id}`
- Regenerate selected layers: `POST /v1/layer-decompositions/{job_id}/revisions`
- Apply one full-canvas source-detail mask: `POST /v1/layer-decompositions/{job_id}/edits`
- Recalculate all layer depths: `POST /v1/layer-decompositions/{job_id}/depth-revisions`
- Read the complete revision timeline: `GET /v1/layer-decompositions/{job_id}/revisions`
- Keep a completed candidate: `POST /v1/layer-decompositions/{job_id}/accept`
- Download a completed PSD: `GET /v1/layer-decompositions/{job_id}/download`

The detail-edit request uses multipart form data with a canonical `part` name and a mask image matching the full dimensions of that layer. Black retains generated pixels, white restores source pixels, and grey values blend between them. The endpoint returns a queued revision job; LayerDiff3D is never rerun, while Marigold is invoked automatically only if the edit reveals pixels outside the layer's current alpha.

The depth-revision request accepts optional `seed` and `depth_resolution` multipart fields. Supported resolutions are 512, 640, 768, 896, 1024, and 1280 px. If omitted, the seed is randomized and the parent depth resolution is reused.

## Models

Each normal generation uses:

1. [LayerDiff3D](https://huggingface.co/layerdifforg/seethroughv0.0.2_layerdiff3d)
2. [Marigold Depth](https://huggingface.co/layerdifforg/seethroughv0.0.1_marigold)
3. PSD assembly

SAM Body Parsing is upstream research and annotation tooling. It is not used by this browser application's PSD generation pipeline.

## Privacy and Responsible Use

Inputs, generated files, revision history, editor masks, and retained generated base layers remain in the configured local workspace. The application has no built-in login screen, so do not expose port `8000` directly to an untrusted network.

Only process images you have permission to use. Generated layers can contain segmentation, inpainting, ordering, or reconstruction mistakes and should be reviewed before production use.

## Project and Attribution

- Hangry Labs repository: https://github.com/Hangry-Labs/see-through
- Original See-through project: https://github.com/shitagaki-lab/see-through
- Research paper: https://arxiv.org/abs/2602.03749
- License: Apache License 2.0
- Hangry Labs: https://nuggies.website/

The original See-through models, research, authorship, citation, and acknowledgements belong to the upstream project and its authors.
