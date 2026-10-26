from __future__ import annotations

import subprocess
import time
from pathlib import Path

import pytest

from app.services import external_player
from tests.helpers import add_video

pytestmark = pytest.mark.skipif(
    external_player.resolve_player_path("mpv") is None, reason="mpv не установлен"
)


def make_video(path: Path, seconds: float = 3.0) -> Path:
    ffmpeg = external_player.shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg не установлен")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"testsrc=size=160x120:rate=10:duration={seconds}",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
            "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
            str(path),
        ],
        check=True,
        timeout=120,
    )
    return path


@pytest.fixture
def external_env(monkeypatch):
    # headless-прогон mpv в тестах (без окна и звука)
    monkeypatch.setenv("VL_MPV_EXTRA_ARGS", "--vo=null --ao=null")


def test_players_detection(client, external_env):
    result = client.get("/api/external/players").json()
    assert set(result) == {"items", "configured", "policy", "pass_marks"}
    mpv = next(item for item in result["items"] if item["id"] == "mpv")
    assert mpv["available"] is True
    assert mpv["sync"] is True


def test_launch_sync_and_commands(client, config, external_env):
    video_path = make_video(config.data_dir / "external.mp4")
    client.post("/api/videos/scan", json={"path": str(video_path)})
    video_id = None
    for _ in range(100):
        items = client.get("/api/videos").json()["items"]
        if items:
            video_id = items[0]["id"]
            break
        time.sleep(0.1)
    assert video_id is not None
    client.post(f"/api/videos/{video_id}/prepare-preview")

    launched = client.post(
        "/api/external/launch",
        json={"video_id": video_id, "start_ms": 1000, "player": "mpv", "pass_marks": False},
    )
    assert launched.status_code == 200, launched.text
    session = launched.json()["session"]
    assert session["player"] == "mpv"
    assert session["sync"] is True

    # ждём, пока mpv откроет файл и IPC отдаст duration/time-pos
    deadline = time.monotonic() + 20
    state = None
    while time.monotonic() < deadline:
        state = client.get("/api/external/status").json()
        if state["active"] and state["session"]["duration_ms"] > 0:
            if state["session"]["position_ms"] >= 900:
                break
        time.sleep(0.2)
    assert state is not None and state["active"], state
    assert state["session"]["duration_ms"] > 0
    assert state["session"]["position_ms"] >= 900

    paused = client.post("/api/external/command", json={"action": "pause"}).json()
    assert paused["session"]["paused"] is True
    client.post("/api/external/command", json={"action": "play"})

    seeked = client.post("/api/external/command", json={"action": "seek", "value": 2000}).json()
    assert seeked["session"]["position_ms"] == 2000
    time.sleep(0.4)
    after = client.get("/api/external/status").json()
    assert 1800 <= after["session"]["position_ms"] <= 2600

    stopped = client.post("/api/external/stop").json()
    assert stopped["active"] is False
    assert client.get("/api/external/status").json()["active"] is False


def test_launch_unavailable_player(client, config, external_env):
    video_id = add_video(config, path="/tmp/external/missing.mp4")
    response = client.post(
        "/api/external/launch",
        json={"video_id": video_id, "player": "vlc"},
    )
    assert response.status_code in {404, 409}
    assert response.json()["code"] in {"file_missing", "player_unavailable"}


def test_marks_files_generation(tmp_path, monkeypatch):
    monkeypatch.setenv("VL_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("VL_TOKEN", "t")
    manager = external_player.ExternalPlayerManager.__new__(external_player.ExternalPlayerManager)
    manager._lock = __import__("threading").RLock()
    manager._files = []
    from app.config import Config

    config = Config()
    config.tmp_dir.mkdir(parents=True, exist_ok=True)
    manager.config = config
    marks = [
        {"start_ms": 1000, "end_ms": 2500, "label": "Пример {тест}", "color": "#3b82f6", "tags": ["Учёба"]},
        {"start_ms": 3000, "end_ms": 4000, "label": "Второй", "color": "#ef4444", "tags": []},
    ]
    chapters, subs = manager._write_marks(video_id=999_999, marks=marks)
    assert chapters is not None and subs is not None
    chapter_text = chapters.read_text(encoding="utf-8")
    assert "CHAPTER01=00:00:01.000" in chapter_text
    assert "CHAPTER01NAME=Пример {тест}" in chapter_text
    subs_text = subs.read_text(encoding="utf-8")
    assert "Dialogue:" in subs_text
    assert "🏷 Пример (тест)" in subs_text
    assert "Учёба" in subs_text
    for path in (chapters, subs):
        path.unlink(missing_ok=True)
