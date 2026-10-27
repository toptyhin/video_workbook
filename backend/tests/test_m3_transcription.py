from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import pytest

from app.services import transcriber

FFMPEG = shutil.which("ffmpeg")
pytestmark = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")


def make_video(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=black:s=160x120:d=1.5",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5",
            "-shortest", "-c:v", "mpeg4", "-c:a", "aac", str(path),
        ],
        check=True,
        timeout=60,
    )
    return path


def wait_status(client, video_id: int, expected: set[str], timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        items = client.get("/api/videos", params={"limit": 100}).json()["items"]
        for item in items:
            if item["id"] == video_id:
                last = item
                if item["status"] in expected:
                    return item
        time.sleep(0.2)
    raise AssertionError(f"status {expected} not reached: {last}")


def test_extract_audio(tmp_path):
    video = make_video(tmp_path / "clip.mp4")
    wav = tmp_path / "audio.wav"
    transcriber.extract_audio(FFMPEG, str(video), str(wav))
    assert wav.exists()
    assert wav.stat().st_size > 1000


def test_queue_reports_missing_model(client, config, tmp_path, monkeypatch):
    monkeypatch.setenv("VL_ALLOW_MODEL_DOWNLOAD", "0")
    # В dev в resources/models есть tiny/small; для проверки ошибки «нет модели»
    # принудительно отключаем резолвер (M13).
    from app.services import queue as queue_module

    monkeypatch.setattr(queue_module.model_resolver, "resolve_whisper", lambda config, name: None)
    video = make_video(tmp_path / "lesson.mp4")
    response = client.post("/api/videos/scan", json={"path": str(video)})
    assert response.status_code == 202
    deadline = time.monotonic() + 20
    video_id = None
    while time.monotonic() < deadline and video_id is None:
        items = client.get("/api/videos", params={"limit": 50}).json()["items"]
        if items:
            video_id = items[0]["id"]
        time.sleep(0.1)
    assert video_id is not None
    response = client.post("/api/videos/enqueue", json={"ids": [video_id]})
    assert response.status_code == 200
    assert response.json()["queued"] == [video_id]
    item = wait_status(client, video_id, {"error", "done"}, timeout=40)
    assert item["status"] == "error"
    assert ("Модель" in (item["error"] or "")) or ("faster-whisper" in (item["error"] or ""))
    queue = client.get("/api/queue").json()
    assert "current" in queue and "pending" in queue


def test_cancel_unknown_and_done(client, config):
    assert client.post("/api/videos/999/cancel").status_code == 404
    from tests.helpers import add_video

    video_id = add_video(config, path="/tmp/videos/done.mp4", status="done")
    response = client.post(f"/api/videos/{video_id}/cancel")
    assert response.status_code == 409


def test_reprocess_clears_segments(client, config):
    from tests.helpers import add_segment, add_video

    video_id = add_video(config, path="/tmp/videos/reproc.mp4", status="done")
    add_segment(config, video_id, 0, 1000, "старый сегмент")
    response = client.post(f"/api/videos/{video_id}/reprocess")
    assert response.status_code == 202
    segments = client.get(f"/api/videos/{video_id}/segments").json()["segments"]
    assert segments == []
    wait_status(client, video_id, {"queued", "processing", "error"}, timeout=40)
