"""M11: запись экрана/окна — API сессий, финализация, системный звук (plan §7.1)."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db import connect
from app.services import recording, system_audio

REPO_ROOT = Path(__file__).resolve().parents[2]
STATIC_FFMPEG = REPO_ROOT / "resources" / "ffmpeg" / "ffmpeg"
FFMPEG = str(STATIC_FFMPEG) if STATIC_FFMPEG.exists() else (shutil.which("ffmpeg") or "")
FFPROBE = str(STATIC_FFMPEG.parent / "ffprobe") if STATIC_FFMPEG.exists() else (
    shutil.which("ffprobe") or ""
)
TOKEN = "test-token"
SESSION_RE = re.compile(r"^[0-9a-f]{32}$")

pytestmark = pytest.mark.skipif(
    not FFMPEG or not FFPROBE, reason="ffmpeg/ffprobe не установлены"
)


# ---------- helpers ----------


def make_webm(directory: Path, *, frequency: int = 440, duration: float = 2.0) -> Path:
    """Реальный WebM VP9+Opus (как MediaRecorder в Electron)."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"fixture-{frequency}-{duration}.webm"
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
            f"testsrc=size=320x240:rate=15:duration={duration}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={frequency}:duration={duration}",
            "-shortest",
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "300k",
            "-c:a",
            "libopus",
            "-b:a",
            "96k",
            "-f",
            "webm",
            str(path),
        ],
        check=True,
        timeout=180,
    )
    return path


def split_chunks(data: bytes, parts: int = 5) -> list[bytes]:
    size = max(1, len(data) // parts)
    chunks = [data[i : i + size] for i in range(0, len(data), size)]
    assert b"".join(chunks) == data
    return chunks


@pytest.fixture(scope="module")
def fixture_chunks(tmp_path_factory) -> list[bytes]:
    path = make_webm(tmp_path_factory.mktemp("rec-fixtures"), frequency=440, duration=2.0)
    data = path.read_bytes()
    assert len(data) > 10_000
    return split_chunks(data)


def start_session(client: TestClient, **overrides) -> dict:
    payload = {
        "source_kind": "screen",
        "source_title": "Экран 1",
        "mime_type": "video/webm;codecs=vp9,opus",
        "system_audio": False,
    }
    payload.update(overrides)
    response = client.post("/api/recordings", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def upload_chunks(client: TestClient, recording_id: str, chunks: list[bytes]) -> int:
    total = 0
    for chunk in chunks:
        response = client.post(
            f"/api/recordings/{recording_id}/chunks",
            content=chunk,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert response.status_code == 202, response.text
        assert response.json()["bytes"] == len(chunk)
        total += len(chunk)
    return total


def finish_session(client: TestClient, recording_id: str, payload: dict | None = None) -> dict:
    response = client.post(
        f"/api/recordings/{recording_id}/finish",
        json=payload if payload is not None else {},
    )
    assert response.status_code == 201, response.text
    return response.json()


def video_row(config, video_id: int) -> dict:
    conn = connect(config.db_path)
    try:
        row = conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()
        return dict(row) if row is not None else {}
    finally:
        conn.close()


def recording_row(config, recording_id: str) -> dict:
    conn = connect(config.db_path)
    try:
        row = conn.execute("SELECT * FROM recordings WHERE id = ?", (recording_id,)).fetchone()
        return dict(row) if row is not None else {}
    finally:
        conn.close()


def probe(path: Path) -> dict:
    proc = subprocess.run(
        [
            FFPROBE,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout or "{}")


def video_total(client: TestClient) -> int:
    return int(client.get("/api/videos").json()["total"])


# ---------- capabilities ----------


def test_capabilities_shape(client):
    response = client.get("/api/recordings/capabilities")
    assert response.status_code == 200
    caps = response.json()
    assert caps["max_chunk_bytes"] == recording.MAX_CHUNK_BYTES == 32 * 1024 * 1024
    assert set(caps["system_audio"]) == {"available", "detail"}
    assert isinstance(caps["system_audio"]["available"], bool)
    assert caps["system_audio"]["detail"] is None or isinstance(
        caps["system_audio"]["detail"], str
    )


def test_capabilities_without_pactl(client, monkeypatch):
    monkeypatch.setattr(system_audio.shutil, "which", lambda name: None)
    caps = client.get("/api/recordings/capabilities").json()
    assert caps["system_audio"]["available"] is False
    assert "pactl" in (caps["system_audio"]["detail"] or "")


# ---------- route selection (pulse -> parec -> unavailable) ----------


def _fake_which(mapping: dict[str, str]):
    return lambda name: mapping.get(name)


def _fake_pactl(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args, 0, "testsink\n", "")


def test_route_selection_prefers_pulse_ffmpeg(config, monkeypatch):
    monkeypatch.setattr(
        system_audio.shutil,
        "which",
        _fake_which({"pactl": "/usr/bin/pactl", "ffmpeg": "/usr/bin/ffmpeg"}),
    )
    monkeypatch.setattr(system_audio, "_run_pactl", _fake_pactl)
    monkeypatch.setattr(system_audio, "_supports_pulse", lambda ffmpeg: True)
    info = system_audio.detect(config)
    assert info.available is True
    assert info.route == system_audio.ROUTE_PULSE
    assert info.ffmpeg == "/usr/bin/ffmpeg"
    assert info.monitor == "testsink.monitor"


def test_route_selection_falls_back_to_parec(config, monkeypatch):
    monkeypatch.setattr(
        system_audio.shutil,
        "which",
        _fake_which(
            {
                "pactl": "/usr/bin/pactl",
                "ffmpeg": "/usr/bin/ffmpeg",
                "parec": "/usr/bin/parec",
            }
        ),
    )
    monkeypatch.setattr(system_audio, "_run_pactl", _fake_pactl)
    monkeypatch.setattr(system_audio, "_supports_pulse", lambda ffmpeg: False)
    monkeypatch.setattr(system_audio, "_supports_encoder", lambda ffmpeg, encoder="libopus": True)
    info = system_audio.detect(config)
    assert info.available is True
    assert info.route == system_audio.ROUTE_PAREC
    assert info.ffmpeg == config.ffmpeg
    assert info.parec == "/usr/bin/parec"
    assert info.monitor == "testsink.monitor"


def test_route_selection_unavailable_without_parec(config, monkeypatch):
    monkeypatch.setattr(
        system_audio.shutil,
        "which",
        _fake_which({"pactl": "/usr/bin/pactl", "ffmpeg": "/usr/bin/ffmpeg"}),
    )
    monkeypatch.setattr(system_audio, "_run_pactl", _fake_pactl)
    monkeypatch.setattr(system_audio, "_supports_pulse", lambda ffmpeg: False)
    info = system_audio.detect(config)
    assert info.available is False
    assert "parec" in (info.detail or "")


# ---------- happy path ----------


def test_start_chunks_finish_registers_video(client, config, fixture_chunks, monkeypatch):
    events: list[tuple[str, dict]] = []
    bus = client.app.state.bus
    monkeypatch.setattr(
        bus, "publish_threadsafe", lambda event_type, payload: events.append((event_type, payload))
    )

    started = start_session(
        client,
        source_kind="screen",
        source_title="Экран 1",
        title="Лекция по физике",
        mime_type="video/webm;codecs=vp9,opus",
    )
    recording_id = started["recording_id"]
    assert SESSION_RE.match(recording_id)
    assert started["system_audio"] == {"active": False, "detail": None}

    state = client.get(f"/api/recordings/{recording_id}").json()
    assert state["state"] == "recording"
    assert state["bytes"] == 0
    assert state["system_audio"] is False

    total = upload_chunks(client, recording_id, fixture_chunks)
    state = client.get(f"/api/recordings/{recording_id}").json()
    assert state["bytes"] == total
    assert client.post(f"/api/recordings/{recording_id}/pause").status_code == 204
    assert client.get(f"/api/recordings/{recording_id}").json()["state"] == "paused"
    assert client.post(f"/api/recordings/{recording_id}/resume").status_code == 204
    assert client.get(f"/api/recordings/{recording_id}").json()["state"] == "recording"

    result = finish_session(
        client, recording_id, {"duration_ms": 2000, "width": 320, "height": 240}
    )
    assert set(result) == {
        "video_id",
        "title",
        "duration_ms",
        "size_bytes",
        "path",
        "playback_mode",
    }
    assert result["title"] == "Лекция по физике"
    assert 1500 <= result["duration_ms"] <= 3000
    assert result["size_bytes"] > 0
    assert result["playback_mode"] == "direct"
    final_path = Path(result["path"])
    assert final_path.parent == config.recordings_dir
    assert final_path.suffix == ".webm"
    assert final_path.exists()
    assert final_path.stat().st_size == result["size_bytes"]

    video = video_row(config, result["video_id"])
    assert video["path"] == str(final_path)
    assert video["title"] == "Лекция по физике"
    assert video["status"] == "pending"
    assert int(video["duration_ms"]) == result["duration_ms"]
    assert video["size_bytes"] == result["size_bytes"]
    assert video["sha256"]
    assert video["mtime_ms"]

    row = recording_row(config, recording_id)
    assert row["video_id"] == result["video_id"]
    assert row["source_kind"] == "screen"
    assert row["source_title"] == "Экран 1"
    assert row["mime_type"] == "video/webm;codecs=vp9,opus"
    assert row["system_audio"] == 0
    assert row["duration_ms"] == result["duration_ms"]
    assert row["size_bytes"] == result["size_bytes"]

    items = client.get("/api/videos").json()["items"]
    assert any(item["id"] == result["video_id"] for item in items)

    thumb = client.get(f"/api/videos/{result['video_id']}/thumb")
    assert thumb.status_code == 200
    assert thumb.headers["content-type"] == "image/jpeg"
    assert thumb.content.startswith(b"\xff\xd8")

    playback = client.get(f"/api/videos/{result['video_id']}/playback").json()
    assert playback["mode"] == "direct"

    finished_state = client.get(f"/api/recordings/{recording_id}").json()
    assert finished_state["state"] == "finished"
    assert finished_state["duration_ms"] == result["duration_ms"]
    assert finished_state["bytes"] == total

    chunk_after = client.post(
        f"/api/recordings/{recording_id}/chunks",
        content=b"x",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert chunk_after.status_code == 409
    assert chunk_after.json()["code"] == "recording_finished"
    assert client.post(f"/api/recordings/{recording_id}/finish", json={}).status_code == 409

    event_types = [event_type for event_type, _payload in events]
    assert "recording.finished" in event_types
    assert "video.status" in event_types
    finished_payload = next(p for t, p in events if t == "recording.finished")
    assert finished_payload["video_id"] == result["video_id"]
    assert finished_payload["path"] == str(final_path)
    assert finished_payload["title"] == "Лекция по физике"
    status_payload = next(p for t, p in events if t == "video.status")
    assert status_payload == {
        "video_id": result["video_id"],
        "status": "added",
        "path": str(final_path),
    }
    assert list(config.recording_tmp_dir.iterdir()) == []

    # отмена после финала идемпотентна и не удаляет запись из библиотеки
    assert client.post(f"/api/recordings/{recording_id}/cancel").status_code == 204
    assert final_path.exists()
    assert video_row(config, result["video_id"])["path"] == str(final_path)
    assert client.get(f"/api/recordings/{recording_id}").status_code == 404


def test_default_title_when_missing(client, config, fixture_chunks):
    data = make_webm(config.data_dir / "fixtures", frequency=500, duration=1.5).read_bytes()
    started = start_session(client, source_kind="window", source_title="Firefox")
    upload_chunks(client, started["recording_id"], split_chunks(data, 4))
    result = finish_session(client, started["recording_id"], {"duration_ms": 1500})
    assert re.match(r"^Запись окна \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$", result["title"])
    assert video_row(config, result["video_id"])["title"] == result["title"]


# ---------- validation / errors ----------


@pytest.mark.parametrize(
    ("overrides", "status", "code"),
    [
        ({"source_kind": "camera"}, 400, "invalid_source"),
        ({"mime_type": "video/mp4"}, 400, "invalid_mime"),
        ({"mime_type": ""}, 400, "invalid_mime"),
        ({"title": "x" * 201}, 400, "invalid_payload"),
        ({"source_title": "x" * 301}, 400, "invalid_payload"),
        ({"system_audio": "yes"}, 400, "invalid_payload"),
    ],
)
def test_start_validation(client, overrides, status, code):
    payload = {
        "source_kind": "screen",
        "mime_type": "video/webm;codecs=vp9,opus",
        "system_audio": False,
        **overrides,
    }
    response = client.post("/api/recordings", json=payload)
    assert response.status_code == status, response.text
    assert response.json()["code"] == code


def test_unknown_session_errors(client):
    unknown = "0" * 32
    for method, url, kwargs in [
        ("get", f"/api/recordings/{unknown}", {}),
        ("post", f"/api/recordings/{unknown}/pause", {}),
        ("post", f"/api/recordings/{unknown}/resume", {}),
        ("post", f"/api/recordings/{unknown}/finish", {"json": {}}),
    ]:
        response = getattr(client, method)(url, **kwargs)
        assert response.status_code == 404, (url, response.text)
        assert response.json()["code"] == "recording_not_found"
    chunk = client.post(
        f"/api/recordings/{unknown}/chunks",
        content=b"data",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert chunk.status_code == 404
    assert chunk.json()["code"] == "recording_not_found"
    # cancel идемпотентен даже для несуществующей сессии
    assert client.post(f"/api/recordings/{unknown}/cancel").status_code == 204
    assert client.post("/api/recordings/not-a-session/cancel").status_code == 204


def test_empty_chunk_and_empty_recording(client, config):
    recording_id = start_session(client)["recording_id"]
    empty = client.post(
        f"/api/recordings/{recording_id}/chunks",
        content=b"",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert empty.status_code == 400
    assert empty.json()["code"] == "invalid_chunk"

    finish = client.post(f"/api/recordings/{recording_id}/finish", json={})
    assert finish.status_code == 400
    assert finish.json()["code"] == "recording_empty"
    assert client.get(f"/api/recordings/{recording_id}").status_code == 404
    assert list(config.recording_tmp_dir.iterdir()) == []


def test_finish_invalid_payload(client):
    recording_id = start_session(client)["recording_id"]
    for payload in ({"duration_ms": "abc"}, {"duration_ms": -5}, {"width": 0}):
        response = client.post(f"/api/recordings/{recording_id}/finish", json=payload)
        assert response.status_code == 400, response.text
        assert response.json()["code"] == "invalid_payload"
    # после ошибки валидации сессия продолжает принимать чанки
    assert (
        client.post(f"/api/recordings/{recording_id}/pause").status_code == 204
    )
    assert client.post(f"/api/recordings/{recording_id}/cancel").status_code == 204


def test_chunk_too_large(client, monkeypatch):
    monkeypatch.setattr(recording, "MAX_CHUNK_BYTES", 16)
    recording_id = start_session(client)["recording_id"]
    assert client.get("/api/recordings/capabilities").json()["max_chunk_bytes"] == 16
    response = client.post(
        f"/api/recordings/{recording_id}/chunks",
        content=b"x" * 17,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 413
    assert response.json()["code"] == "chunk_too_large"
    assert client.post(f"/api/recordings/{recording_id}/cancel").status_code == 204


def test_cancel_removes_temp_files(client, config, fixture_chunks):
    before = video_total(client)
    recording_id = start_session(client)["recording_id"]
    upload_chunks(client, recording_id, fixture_chunks[:2])
    part = config.recording_tmp_dir / f"{recording_id}.webm.part"
    assert part.exists() and part.stat().st_size > 0

    assert client.post(f"/api/recordings/{recording_id}/cancel").status_code == 204
    assert not part.exists()
    assert list(config.recording_tmp_dir.iterdir()) == []
    assert client.get(f"/api/recordings/{recording_id}").status_code == 404
    cancelled_chunk = client.post(
        f"/api/recordings/{recording_id}/chunks",
        content=b"x",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert cancelled_chunk.status_code == 404
    # повторная отмена — идемпотентно 204
    assert client.post(f"/api/recordings/{recording_id}/cancel").status_code == 204
    assert video_total(client) == before


def test_cancel_during_finalizing_returns_conflict(client):
    recording_id = start_session(client)["recording_id"]
    manager = client.app.state.recording
    with manager._lock:
        manager._sessions[recording_id].state = recording.STATE_FINALIZING
    response = client.post(f"/api/recordings/{recording_id}/cancel")
    assert response.status_code == 409
    assert response.json()["code"] == "recording_finished"
    with manager._lock:
        manager._sessions[recording_id].state = recording.STATE_RECORDING
    assert client.post(f"/api/recordings/{recording_id}/cancel").status_code == 204


def test_finalize_rejects_garbage_without_video(client, config):
    before = video_total(client)
    recording_id = start_session(client)["recording_id"]
    upload_chunks(client, recording_id, [b"not-a-webm-" * 10, b"definitely-garbage" * 10])
    response = client.post(f"/api/recordings/{recording_id}/finish", json={"duration_ms": 1000})
    assert response.status_code == 400, response.text
    assert response.json()["code"] == "invalid_recording"
    assert video_total(client) == before
    assert list(config.recordings_dir.iterdir()) == []
    assert list(config.recording_tmp_dir.iterdir()) == []
    assert client.get(f"/api/recordings/{recording_id}").status_code == 404


def test_finish_without_json_body(client, config):
    data = make_webm(config.data_dir / "fixtures", frequency=700, duration=1.8).read_bytes()
    recording_id = start_session(client)["recording_id"]
    upload_chunks(client, recording_id, split_chunks(data, 4))
    response = client.post(f"/api/recordings/{recording_id}/finish")
    assert response.status_code == 201, response.text
    body = response.json()
    video = video_row(config, body["video_id"])
    assert body["duration_ms"] == int(video["duration_ms"])
    assert recording_row(config, recording_id)["duration_ms"] == body["duration_ms"]


# ---------- fallback / системный звук ----------


def test_finalize_fallback_when_ffmpeg_fails(client, config, monkeypatch):
    fixture = make_webm(config.data_dir / "fixtures", frequency=523, duration=1.6)
    data = fixture.read_bytes()
    recording_id = start_session(client)["recording_id"]
    upload_chunks(client, recording_id, split_chunks(data, 3))
    monkeypatch.setattr(config, "ffmpeg", "/bin/false")

    result = finish_session(client, recording_id, {"duration_ms": 1600})
    assert Path(result["path"]).exists()
    # fallback: чанки скопированы как есть, файл всё равно играется
    assert Path(result["path"]).read_bytes() == data
    assert result["playback_mode"] == "direct"
    assert 1400 <= result["duration_ms"] <= 2000
    video = video_row(config, result["video_id"])
    assert video["status"] in {"pending", "duplicate"}
    assert int(video["duration_ms"]) == result["duration_ms"]
    assert video["path"] == result["path"]
    assert recording_row(config, recording_id)["video_id"] == result["video_id"]


def test_system_audio_unavailable_keeps_recording(client, monkeypatch):
    monkeypatch.setattr(system_audio.shutil, "which", lambda name: None)
    started = start_session(client, system_audio=True)
    assert started["system_audio"]["active"] is False
    assert "pactl" in (started["system_audio"]["detail"] or "")
    state = client.get(f"/api/recordings/{started['recording_id']}").json()
    assert state["system_audio"] is False
    assert client.post(f"/api/recordings/{started['recording_id']}/pause").status_code == 204
    assert client.post(f"/api/recordings/{started['recording_id']}/resume").status_code == 204
    assert client.post(f"/api/recordings/{started['recording_id']}/cancel").status_code == 204


def test_real_system_audio_mixed_into_webm(client, config):
    info = system_audio.detect(config)
    if not info.available:
        pytest.skip(f"system audio недоступен: {info.detail}")
    ffmpeg = system_audio.resolve_ffmpeg(config)
    if ffmpeg is None:  # pragma: no cover - согласовано с detect()
        pytest.skip("ffmpeg без поддержки PulseAudio")
    player = subprocess.Popen(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=330:duration=8",
            "-f",
            "pulse",
            "default",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        data = make_webm(config.data_dir / "fixtures", frequency=660, duration=2.0).read_bytes()
        started = start_session(client, system_audio=True)
        if not started["system_audio"]["active"]:
            pytest.skip(f"system audio capture не стартовал: {started['system_audio']['detail']}")
        recording_id = started["recording_id"]
        upload_chunks(client, recording_id, split_chunks(data, 4))
        assert client.post(f"/api/recordings/{recording_id}/pause").status_code == 204
        time.sleep(0.2)
        assert client.post(f"/api/recordings/{recording_id}/resume").status_code == 204
        time.sleep(0.3)
        result = finish_session(client, recording_id, {"duration_ms": 2000})
        assert 1500 <= result["duration_ms"] <= 3000
        assert result["duration_ms"] == int(
            video_row(config, result["video_id"])["duration_ms"]
        )
        streams = probe(Path(result["path"]))["streams"]
        audio = [item for item in streams if item.get("codec_type") == "audio"]
        assert audio, streams
        assert audio[0]["codec_name"] == "opus"
        assert result["playback_mode"] == "direct"
        row = recording_row(config, recording_id)
        assert row["system_audio"] == 1
        assert row["duration_ms"] == result["duration_ms"]
    finally:
        player.terminate()
        try:
            player.wait(timeout=5)
        except subprocess.TimeoutExpired:  # pragma: no cover
            player.kill()


def test_real_system_audio_via_parec_route(client, config, monkeypatch):
    """Parec-маршрут: встроенный ffmpeg без pulse-демуксера + parec (release fallback)."""
    monkeypatch.setattr(system_audio, "_supports_pulse", lambda ffmpeg: False)
    info = system_audio.detect(config)
    if not info.available or info.route != system_audio.ROUTE_PAREC:
        pytest.skip(f"parec route недоступен: {info.detail}")
    play_ffmpeg = shutil.which("ffmpeg")
    if play_ffmpeg is None:
        pytest.skip("нет системного ffmpeg для воспроизведения тестового тона")
    player = subprocess.Popen(
        [
            play_ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=392:duration=8",
            "-f",
            "pulse",
            "default",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        data = make_webm(config.data_dir / "fixtures", frequency=784, duration=2.0).read_bytes()
        started = start_session(client, system_audio=True)
        if not started["system_audio"]["active"]:
            pytest.skip(f"parec capture не стартовал: {started['system_audio']['detail']}")
        recording_id = started["recording_id"]
        upload_chunks(client, recording_id, split_chunks(data, 4))
        time.sleep(0.4)
        result = finish_session(client, recording_id, {"duration_ms": 2000})
        assert result["playback_mode"] == "direct"
        assert result["duration_ms"] == int(video_row(config, result["video_id"])["duration_ms"])
        streams = probe(Path(result["path"]))["streams"]
        audio = [item for item in streams if item.get("codec_type") == "audio"]
        assert audio, streams
        assert audio[0]["codec_name"] == "opus"
        assert recording_row(config, recording_id)["system_audio"] == 1
        assert list(config.recording_tmp_dir.iterdir()) == []
    finally:
        player.terminate()
        try:
            player.wait(timeout=5)
        except subprocess.TimeoutExpired:  # pragma: no cover
            player.kill()


# ---------- startup cleanup ----------


def test_stale_tmp_cleanup_on_startup(config):
    config.recording_tmp_dir.mkdir(parents=True, exist_ok=True)
    stray_part = config.recording_tmp_dir / ("f" * 32 + ".webm.part")
    stray_part.write_bytes(b"stale")
    stray_dir = config.recording_tmp_dir / "dead-session"
    stray_dir.mkdir()
    (stray_dir / "leftover").write_bytes(b"x")

    from app.main import create_app

    app = create_app(config)
    with TestClient(app, headers={"X-VL-Token": TOKEN}):
        assert not stray_part.exists()
        assert not stray_dir.exists()
        assert config.recordings_dir.is_dir()
