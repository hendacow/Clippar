FROM python:3.12-slim

# System deps for opencv, ffmpeg, librosa (libsndfile)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install CPU-only PyTorch first (much smaller than full CUDA build)
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create dirs
RUN mkdir -p jobs assets/music

EXPOSE 5050

# Longer timeout for video processing (10 min)
CMD ["gunicorn", "--bind", "0.0.0.0:5050", "--timeout", "600", "--workers", "1", "--threads", "2", "app:app"]
