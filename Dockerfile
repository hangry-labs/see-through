FROM python:3.12-slim AS runtime-base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore \
    HF_HOME=/app/.cache/huggingface \
    HF_HUB_DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1 \
    PYTHONPATH=/app:/app/common \
    SEE_THROUGH_WORKSPACE=/app/workspace \
    SEE_THROUGH_LAYERDIFF_MODEL=layerdifforg/seethroughv0.0.2_layerdiff3d \
    SEE_THROUGH_DEPTH_MODEL=layerdifforg/seethroughv0.0.1_marigold \
    SEE_THROUGH_MARIGOLD_BASE_MODEL=prs-eth/marigold-depth-v1-1 \
    SEE_THROUGH_SCHEDULER_MODEL=frankjoshua/juggernautXL_version6Rundiffusion \
    HOST=0.0.0.0 \
    PORT=8000

WORKDIR /app

LABEL org.opencontainers.image.title="See-through" \
    org.opencontainers.image.description="Local anime-character layer decomposition with browser UI, HTTP API, and layered PSD export" \
    org.opencontainers.image.url="https://github.com/hangry-labs/see-through" \
    org.opencontainers.image.source="https://github.com/hangry-labs/see-through" \
    org.opencontainers.image.documentation="https://github.com/hangry-labs/see-through#readme" \
    org.opencontainers.image.vendor="Hangry Labs" \
    org.opencontainers.image.licenses="Apache-2.0"

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential git libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/

RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m pip install \
        --extra-index-url https://download.pytorch.org/whl/cu128 \
        -r /app/requirements.txt

COPY common /app/common
COPY inference /app/inference
COPY see_through /app/see_through
COPY LICENSE README.md VERSION /app/

RUN python -m pip install -e /app/common --no-deps \
    && mkdir -p /app/workspace /app/.cache/huggingface

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/live', timeout=4).read()"]

CMD ["python", "-u", "-m", "see_through.app"]

FROM runtime-base AS tiny

ENV HF_HUB_OFFLINE=0 \
    TRANSFORMERS_OFFLINE=0

FROM runtime-base AS baked

ARG SEE_THROUGH_LAYERDIFF_REPO=layerdifforg/seethroughv0.0.2_layerdiff3d
ARG SEE_THROUGH_LAYERDIFF_REVISION=966721bb4ef2ddc3af3696862fa10b3f78d9785d
ARG SEE_THROUGH_DEPTH_REPO=layerdifforg/seethroughv0.0.1_marigold
ARG SEE_THROUGH_DEPTH_REVISION=aa7a892f83ff68d7b09186a405ba08d5d33f770f
ARG SEE_THROUGH_MARIGOLD_BASE_REPO=prs-eth/marigold-depth-v1-1
ARG SEE_THROUGH_MARIGOLD_BASE_REVISION=9571e7123e258cf052b4e54241f17971c290e9a8
ARG SEE_THROUGH_SCHEDULER_REPO=frankjoshua/juggernautXL_version6Rundiffusion
ARG SEE_THROUGH_SCHEDULER_REVISION=aadab4c7cb252b83a0e2d6f3386b8c837af23932

RUN python -u -m see_through.prefetch_assets \
        --layerdiff-repo "${SEE_THROUGH_LAYERDIFF_REPO}" \
        --layerdiff-revision "${SEE_THROUGH_LAYERDIFF_REVISION}" \
        --depth-repo "${SEE_THROUGH_DEPTH_REPO}" \
        --depth-revision "${SEE_THROUGH_DEPTH_REVISION}" \
        --marigold-base-repo "${SEE_THROUGH_MARIGOLD_BASE_REPO}" \
        --marigold-base-revision "${SEE_THROUGH_MARIGOLD_BASE_REVISION}" \
        --scheduler-repo "${SEE_THROUGH_SCHEDULER_REPO}" \
        --scheduler-revision "${SEE_THROUGH_SCHEDULER_REVISION}" \
    && test -f /app/models/layerdiff/model_index.json \
    && test -f /app/models/marigold/model_index.json \
    && test -d /app/models/marigold-base/text_encoder \
    && test -d /app/models/marigold-base/tokenizer \
    && test -f /app/models/scheduler/scheduler/scheduler_config.json \
    && test -f /app/models/manifest.json

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_DATASETS_OFFLINE=1 \
    SEE_THROUGH_LAYERDIFF_MODEL=/app/models/layerdiff \
    SEE_THROUGH_DEPTH_MODEL=/app/models/marigold \
    SEE_THROUGH_MARIGOLD_BASE_MODEL=/app/models/marigold-base \
    SEE_THROUGH_SCHEDULER_MODEL=/app/models/scheduler
