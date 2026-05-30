# syntax=docker/dockerfile:1.6
#
# simpleStem in a container. Build:
#   docker compose build                                       # native arch
#   docker buildx build --platform linux/amd64,linux/arm64 \
#       -t simplestem:latest --load .                          # multi-arch
#
# Run:
#   docker compose run --rm simplestem stem "Title" "Artist"
#   docker compose run --rm simplestem batch
#
# The container's HOME is /data, so scripts that write to
# $HOME/ClaudeDrive/simpleStem/STEMS land in /data/ClaudeDrive/...,
# which the compose file binds to ~/ClaudeDrive on the host.

FROM python:3.11-slim

# System deps: ffmpeg for audio I/O, curl for the Google Sheet fetch,
# unzip for the deno install. yt-dlp now needs a JS runtime for some
# YouTube formats — it warns "extraction without JS has been deprecated"
# and may break entirely soon. deno is the lightest supported runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y \
  && deno --version

# Python deps. Three things worth knowing:
#   1. We install torch + torchaudio + torchcodec from PyTorch's CPU wheel
#      index. The default PyPI torchcodec wheels are CUDA-linked (depend on
#      libnvrtc) and fail to load in a CPU-only container; the +cpu variant
#      from download.pytorch.org/whl/cpu does not.
#   2. demucs uses torchaudio.save, which on modern torchaudio delegates to
#      torchcodec — that's why torchcodec is mandatory, not optional.
#   3. yt-dlp / librosa / soundfile come from PyPI as usual.
RUN pip install --no-cache-dir \
      torch torchaudio torchcodec \
      --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir \
      yt-dlp \
      demucs \
      librosa \
      soundfile

# Pre-download the htdemucs_6s model (6-stem: vocals/drums/bass/other/
# piano/guitar) so the first run doesn't stall. ~53 MB.
# TORCH_HOME pins the cache to a fixed path independent of $HOME. Without
# this, the cache lands in /root/.cache/torch (build-time HOME) but demucs
# looks under /data/.cache/torch at runtime (because ENV HOME=/data below)
# and re-downloads every time.
ENV TORCH_HOME=/opt/torch_cache
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs_6s')"

# App
WORKDIR /app
COPY stem.sh post_process.py loop_detect.py metadata.py mpbbatch.bash entrypoint.sh ./
RUN chmod +x stem.sh mpbbatch.bash entrypoint.sh

# Make $HOME/ClaudeDrive/... resolve into the mounted host folder.
ENV HOME=/data
WORKDIR /data

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["batch"]
