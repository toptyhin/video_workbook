from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import pytest

from app.services import probe

FFMPEG = shutil.which("ffmpeg")
pytestmark = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")


def make_video(path: Path, color: str = "black", seconds: float = 1.0) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            FFMPEG,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s=320x240:d={seconds}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={seconds}",
            "-shortest",
            "-c:v",
            "mpeg4",
            "-c:a",
            "aac",
            str(path),
        ],
        check=True,
        timeout=60,
    )
    return path


def wait_for(client, predicate, timeout: float = 15.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        response = client.get("/api/videos", params={"limit": 500})
        payload = response.json()
        last = payload
        if predicate(payload):
            return payload
        time.sleep(0.1)
    raise AssertionError(f"condition not met in time: {last}")


@pytest.fixture
def video_file(tmp_path):
    return make_video(tmp_path / "lesson-01.mp4")


def test_probe_metadata(video_file):
    meta = probe.probe_video(video_file, shutil.which("ffprobe") or "ffprobe")
    assert 500 <= meta.duration_ms <= 2000
    assert meta.size_bytes == video_file.stat().st_size
    assert len(meta.sha256) == 64
    assert meta.mtime_ms > 0


def test_scan_single_file(client, video_file):
    response = client.post("/api/videos/scan", json={"path": str(video_file)})
    assert response.status_code == 202
    assert response.json()["state"] == "running"
    payload = wait_for(client, lambda data: data["total"] == 1)
    item = payload["items"][0]
    assert item["title"] == "lesson-01.mp4"
    assert item["status"] == "pending"
    assert item["duration_ms"] >= 500
    assert item["tags_count"] == 0


def test_scan_duplicate(client, video_file, tmp_path):
    copy_path = tmp_path / "lesson-copy.mp4"
    shutil.copyfile(video_file, copy_path)
    client.post("/api/videos/scan", json={"path": str(video_file)})
    wait_for(client, lambda data: data["total"] == 1)
    client.post("/api/videos/scan", json={"path": str(copy_path)})
    payload = wait_for(client, lambda data: data["total"] == 2)
    by_path = {Path(item["path"]).name: item for item in payload["items"]}
    assert by_path["lesson-copy.mp4"]["status"] == "duplicate"
    assert by_path["lesson-copy.mp4"]["duplicate_of"] == by_path["lesson-01.mp4"]["id"]


def test_scan_invalid_path(client, tmp_path):
    response = client.post("/api/videos/scan", json={"path": str(tmp_path / "missing")})
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_path"


def test_folders_and_scan_tree(client, tmp_path):
    folder = tmp_path / "course"
    make_video(folder / "a.mp4", color="red")
    make_video(folder / "b.mp4", color="blue")
    response = client.post("/api/folders", json={"path": str(folder)})
    assert response.status_code == 201
    payload = wait_for(client, lambda data: data["total"] == 2)
    assert {item["title"] for item in payload["items"]} == {"a.mp4", "b.mp4"}

    folders = client.get("/api/folders").json()
    assert folders["total"] == 1
    assert folders["items"][0]["path"] == str(folder.resolve())

    listing = client.get("/api/fs/list").json()
    assert any(entry["path"] == str(folder.resolve()) for entry in listing["entries"])

    sub = client.get("/api/fs/list", params={"path": str(folder)})
    assert sub.status_code == 200
    assert sub.json()["entries"] == []

    forbidden = client.get("/api/fs/list", params={"path": "/etc"})
    assert forbidden.status_code == 403


def test_videos_sorting_and_folder_filter(client, tmp_path):
    folder = tmp_path / "sorted"
    make_video(folder / "zeta.mp4", color="red")
    make_video(folder / "alpha.mp4", color="blue")
    client.post("/api/folders", json={"path": str(folder)})
    wait_for(client, lambda data: data["total"] == 2)
    response = client.get(
        "/api/videos", params={"folder": str(folder.resolve()), "sort": "title", "dir": "asc"}
    )
    assert [item["title"] for item in response.json()["items"]] == ["alpha.mp4", "zeta.mp4"]
    bad = client.get("/api/videos", params={"sort": "nope"})
    assert bad.status_code == 400


def test_stream_range_requests(client, video_file):
    client.post("/api/videos/scan", json={"path": str(video_file)})
    payload = wait_for(client, lambda data: data["total"] == 1)
    video_id = payload["items"][0]["id"]
    size = video_file.stat().st_size

    full = client.get(f"/api/videos/{video_id}/stream")
    assert full.status_code == 200
    assert full.headers["accept-ranges"] == "bytes"
    assert len(full.content) == size

    partial = client.get(f"/api/videos/{video_id}/stream", headers={"Range": "bytes=0-99"})
    assert partial.status_code == 206
    assert len(partial.content) == 100
    assert partial.headers["content-range"] == f"bytes 0-99/{size}"

    suffix = client.get(f"/api/videos/{video_id}/stream", headers={"Range": "bytes=-50"})
    assert suffix.status_code == 206
    assert len(suffix.content) == 50

    invalid = client.get(f"/api/videos/{video_id}/stream", headers={"Range": "bytes=999999999-"})
    assert invalid.status_code == 416


def test_thumbnail_generation(client, video_file):
    client.post("/api/videos/scan", json={"path": str(video_file)})
    payload = wait_for(client, lambda data: data["total"] == 1)
    video_id = payload["items"][0]["id"]
    response = client.get(f"/api/videos/{video_id}/thumb")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert len(response.content) > 100


def test_delete_from_index(client, video_file):
    client.post("/api/videos/scan", json={"path": str(video_file)})
    payload = wait_for(client, lambda data: data["total"] == 1)
    video_id = payload["items"][0]["id"]
    assert client.delete(f"/api/videos/{video_id}").status_code == 204
    assert client.get("/api/videos").json()["total"] == 0
    assert video_file.exists()
    assert client.get(f"/api/videos/{video_id}/segments").status_code == 404


def test_segments_empty(client, video_file):
    client.post("/api/videos/scan", json={"path": str(video_file)})
    payload = wait_for(client, lambda data: data["total"] == 1)
    video_id = payload["items"][0]["id"]
    response = client.get(f"/api/videos/{video_id}/segments")
    assert response.status_code == 200
    assert response.json() == {"segments": [], "annotations": []}
