"""Превью-кадры через ffmpeg с кэшем (M2/M5)."""
from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

from ..config import Config

log = logging.getLogger(__name__)


def thumb_file(config: Config, video_id: int, mtime_ms: int | None, at_ms: int | None = None) -> Path:
    suffix = f"_at{at_ms}" if at_ms is not None else ""
    return config.thumbs_dir / f"{video_id}_{mtime_ms or 0}{suffix}.jpg"


def ensure_thumb(
    config: Config,
    video_id: int,
    video_path: str,
    duration_ms: int | None,
    mtime_ms: int | None,
    at_ms: int | None = None,
) -> Path | None:
    target = thumb_file(config, video_id, mtime_ms, at_ms)
    if target.exists() and target.stat().st_size > 0:
        return target
    source = Path(video_path)
    if not source.exists():
        return None
    position_ms = at_ms if at_ms is not None else int((duration_ms or 0) * 0.05)
    position_ms = max(0, position_ms)
    config.thumbs_dir.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp.jpg")
    cmd = [
        config.ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{position_ms / 1000:.3f}",
        "-i",
        str(source),
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-2",
        "-q:v",
        "4",
        "-y",
        str(tmp),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=25, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning("Thumbnail failed for video %s: %s", video_id, exc)
        return None
    if proc.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        log.warning("Thumbnail failed for video %s: %s", video_id, (proc.stderr or "").strip()[-300:])
        tmp.unlink(missing_ok=True)
        return None
    os.replace(tmp, target)
    return target


def drop_thumbs(config: Config, video_id: int) -> None:
    for candidate in config.thumbs_dir.glob(f"{video_id}_*.jpg"):
        candidate.unlink(missing_ok=True)
