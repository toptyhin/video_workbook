"""ffprobe/ffmpeg-метаданные и sha256 (M2)."""
from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

HASH_CHUNK = 8 * 1024 * 1024
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v"}


class ProbeError(RuntimeError):
    pass


@dataclass
class VideoMeta:
    duration_ms: int
    size_bytes: int
    mtime_ms: int
    sha256: str


def is_video_file(path: Path) -> bool:
    return path.suffix.lower() in VIDEO_EXTENSIONS


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(HASH_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def probe_video(path: Path, ffprobe: str = "ffprobe") -> VideoMeta:
    stat = path.stat()
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ProbeError(f"ffprobe failed: {exc}") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        raise ProbeError(detail[-1] if detail else "ffprobe returned error")
    try:
        payload = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise ProbeError(f"bad ffprobe json: {exc}") from exc
    duration = payload.get("format", {}).get("duration")
    has_video = any(stream.get("codec_type") == "video" for stream in payload.get("streams", []))
    if not has_video:
        raise ProbeError("no video stream found")
    try:
        duration_ms = int(round(float(duration) * 1000))
    except (TypeError, ValueError):
        duration_ms = 0
    return VideoMeta(
        duration_ms=max(0, duration_ms),
        size_bytes=stat.st_size,
        mtime_ms=int(stat.st_mtime * 1000),
        sha256=sha256_file(path),
    )
