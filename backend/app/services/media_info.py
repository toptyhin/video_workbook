"""Кодеки/контейнер: определение совместимости с Chromium (M5/M9)."""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

BROWSER_CONTAINERS = {".mp4", ".m4v", ".webm", ".ogv"}
BROWSER_VIDEO_CODECS = {"h264", "vp8", "vp9", "av1"}
BROWSER_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis", "flac"}
UNSUPPORTED_H264_PIX_FMTS = {
    "yuv420p10le",
    "yuv422p10le",
    "yuv444p10le",
    "yuv420p12le",
    "yuv422p",
    "yuv444p",
    "yuvj422p",
    "yuvj444p",
}


class MediaInfoError(RuntimeError):
    pass


@dataclass
class StreamsInfo:
    container: str
    video_codec: str | None
    audio_codec: str | None
    pix_fmt: str | None
    width: int | None
    height: int | None
    audio_channels: int | None
    duration_ms: int | None

    @property
    def video_ok(self) -> bool:
        codec = self.video_codec
        if codec not in BROWSER_VIDEO_CODECS:
            return False
        if codec == "h264" and (self.pix_fmt or "") in UNSUPPORTED_H264_PIX_FMTS:
            return False
        return True

    @property
    def audio_ok(self) -> bool:
        return self.audio_codec in BROWSER_AUDIO_CODECS

    @property
    def container_ok(self) -> bool:
        return self.container in BROWSER_CONTAINERS

    @property
    def mode(self) -> str:
        """direct | remux | transcode."""
        if self.video_ok and self.container_ok and self.audio_ok:
            return "direct"
        if self.video_ok:
            return "remux"
        return "transcode"

    def describe(self) -> str:
        return (
            f"{self.video_codec or '?'}"
            f"{'/' + self.pix_fmt if self.pix_fmt else ''}"
            f" + {self.audio_codec or 'no audio'}"
            f" в {self.container or '?'}"
        )


def probe_streams(path: str, ffprobe: str = "ffprobe") -> StreamsInfo:
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise MediaInfoError(f"ffprobe failed: {exc}") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        raise MediaInfoError(detail[-1] if detail else "ffprobe error")
    try:
        payload = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise MediaInfoError(str(exc)) from exc
    video = next((s for s in payload.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in payload.get("streams", []) if s.get("codec_type") == "audio"), None)
    duration_raw = payload.get("format", {}).get("duration")
    try:
        duration_ms = int(round(float(duration_raw) * 1000)) if duration_raw else None
    except (TypeError, ValueError):
        duration_ms = None
    return StreamsInfo(
        container=Path(path).suffix.lower(),
        video_codec=(video or {}).get("codec_name"),
        audio_codec=(audio or {}).get("codec_name"),
        pix_fmt=(video or {}).get("pix_fmt"),
        width=(video or {}).get("width"),
        height=(video or {}).get("height"),
        audio_channels=(audio or {}).get("channels"),
        duration_ms=duration_ms,
    )
