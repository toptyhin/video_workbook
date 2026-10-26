from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import pytest

STATIC_FFMPEG = Path(__file__).resolve().parents[2] / "resources" / "ffmpeg" / "ffmpeg"
FFMPEG = str(STATIC_FFMPEG) if STATIC_FFMPEG.exists() else (shutil.which("ffmpeg") or "")
FFPROBE = str(STATIC_FFMPEG.parent / "ffprobe") if STATIC_FFMPEG.exists() else (shutil.which("ffprobe") or "")

pytestmark = pytest.mark.skipif(not FFMPEG, reason="ffmpeg not available")


FORMATS = {"mkv": "matroska", "mp4": "mp4", "webm": "webm"}


def make_video(path: Path, video_codec: str, container: str = "mkv") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    encode = ["-c:v", "libx264", "-pix_fmt", "yuv420p"] if video_codec == "h264" else ["-c:v", "mpeg4"]
    subprocess.run(
        [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1.2",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2",
            "-shortest", *encode, "-c:a", "aac",
            "-f", FORMATS[container], str(path),
        ],
        check=True,
        timeout=120,
    )
    return path


def wait_indexed(client, timeout: float = 30.0) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        items = client.get("/api/videos").json()["items"]
        if items:
            return int(items[0]["id"])
        time.sleep(0.1)
    raise AssertionError("video was not indexed")


def wait_ready(client, video_id: int, timeout: float = 120.0) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = client.get(f"/api/videos/{video_id}/playback").json()
        if last["state"] in {"ready", "error", "direct"}:
            return last
        time.sleep(0.25)
    raise AssertionError(f"preview not finished: {last}")


def test_direct_playback_for_compatible_mp4(client, config):
    path = make_video(config.data_dir / "direct.mp4", "h264", container="mp4")
    client.post("/api/videos/scan", json={"path": str(path)})
    video_id = wait_indexed(client)
    info = client.get(f"/api/videos/{video_id}/playback").json()
    assert info["mode"] == "direct"
    assert info["state"] == "direct"
    assert info["video_codec"] == "h264"


def test_unsupported_codec_transcodes_preview(client, config):
    # mpeg4/mkv — гарантированно несовместимый случай (как HEVC в mkv)
    path = make_video(config.data_dir / "legacy.mkv", "mpeg4")
    client.post("/api/videos/scan", json={"path": str(path)})
    video_id = wait_indexed(client)
    info = client.get(f"/api/videos/{video_id}/playback").json()
    assert info["mode"] == "transcode"
    assert info["state"] in {"idle", "queued", "preparing"}

    prepared = client.post(f"/api/videos/{video_id}/prepare-preview")
    assert prepared.status_code in {200, 202}

    info = wait_ready(client, video_id)
    assert info["state"] == "ready", info
    assert info["ready"] is True

    preview = client.get(f"/api/videos/{video_id}/preview")
    assert preview.status_code == 200
    assert preview.headers["accept-ranges"] == "bytes"
    assert len(preview.content) > 1000

    ranged = client.get(f"/api/videos/{video_id}/preview", headers={"Range": "bytes=0-99"})
    assert ranged.status_code == 206
    assert len(ranged.content) == 100

    files = list((config.data_dir / "cache" / "preview").glob(f"{video_id}_*_transcode.mp4"))
    assert files, "preview cache file not found"
    probe = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=codec_name,pix_fmt", "-of", "csv=p=0", str(files[0])],
        capture_output=True, text=True, check=False,
    )
    assert "h264" in probe.stdout.lower(), probe.stdout
    assert "10" not in probe.stdout, probe.stdout


def test_remux_for_compatible_codec_in_mkv(client, config):
    path = make_video(config.data_dir / "h264-in-mkv.mkv", "h264")
    client.post("/api/videos/scan", json={"path": str(path)})
    video_id = wait_indexed(client)
    info = client.get(f"/api/videos/{video_id}/playback").json()
    assert info["mode"] == "remux"
    assert client.post(f"/api/videos/{video_id}/prepare-preview").status_code in {200, 202}
    info = wait_ready(client, video_id)
    assert info["state"] == "ready", info
    ranged = client.get(f"/api/videos/{video_id}/preview", headers={"Range": "bytes=0-49"})
    assert ranged.status_code == 206
    assert len(ranged.content) == 50
