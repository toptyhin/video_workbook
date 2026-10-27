"""V5: перемещение/копирование файлов в папку и история адресатов (plans/15 §5)."""
from __future__ import annotations

import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

import pytest

from app.db import connect
from app.services import scanner
from tests.helpers import add_segment, add_video

FFMPEG = shutil.which("ffmpeg")


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


def _fake_file(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"not-a-real-video")
    return path


def _add_roots(config, *roots: Path) -> None:
    conn = connect(config.db_path)
    try:
        for root in roots:
            root.mkdir(parents=True, exist_ok=True)
            conn.execute(
                "INSERT OR IGNORE INTO watched_folders(path) VALUES (?)", (str(root),)
            )
        conn.commit()
    finally:
        conn.close()


def _transfer(client, action: Any, ids: Any, destination: Any):
    return client.post(
        "/api/videos/transfer",
        json={"action": action, "ids": ids, "destination": destination},
    )


def _db_row(config, video_id: int):
    conn = connect(config.db_path)
    try:
        return conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()
    finally:
        conn.close()


@pytest.fixture
def roots(client, config, tmp_path):
    """Два watched-корня; watcher остановлен для детерминизма."""
    root_a = (tmp_path / "root-a").resolve()
    root_b = (tmp_path / "root-b").resolve()
    _add_roots(config, root_a, root_b)
    client.app.state.watcher.stop()
    return root_a, root_b


def test_move_keeps_id_tags_segments_and_updates_history(client, config, roots):
    root_a, root_b = roots
    source = _fake_file(root_a / "lesson-01.mp4")
    video_id = add_video(config, path=str(source))
    tag = client.post("/api/tags", json={"name": "учебное"}).json()
    assert client.post(f"/api/videos/{video_id}/tags", json={"tag_id": tag["id"]}).status_code == 204
    segment_id = add_segment(config, video_id, 0, 1000, "первый сегмент")
    annotation = client.post(
        "/api/annotations",
        json={"video_id": video_id, "start_ms": 0, "end_ms": 1000, "label": "важное"},
    )
    assert annotation.status_code == 201

    events: list[tuple[str, dict[str, Any]]] = []
    client.app.state.bus.publish = lambda event_type, payload: events.append((event_type, payload))

    response = _transfer(client, "move", [video_id], str(root_b))
    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "move"
    assert body["destination"] == str(root_b)
    assert body["moved"] == 1
    assert body["copied"] == 0
    assert body["failed"] == 0
    assert body["recent_destinations"] == [str(root_b)]
    target = root_b / "lesson-01.mp4"
    assert body["items"] == [
        {
            "id": video_id,
            "ok": True,
            "code": None,
            "detail": None,
            "path": str(target),
            "new_id": None,
        }
    ]
    assert target.is_file()
    assert not source.exists()

    items = client.get("/api/videos").json()["items"]
    video = next(item for item in items if item["id"] == video_id)
    assert Path(video["path"]) == target
    assert video["tags_count"] == 1
    assert video["tag_ids"] == [tag["id"]]
    payload = client.get(f"/api/videos/{video_id}/segments").json()
    assert [segment["id"] for segment in payload["segments"]] == [segment_id]
    assert len(payload["annotations"]) == 1

    assert client.get("/api/settings").json()["files.recent_destinations"] == [str(root_b)]
    assert ("video.status", {"video_id": video_id, "status": "moved"}) in events
    assert ("settings.changed", {"keys": ["files.recent_destinations"]}) in events


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")
def test_copy_real_video_creates_duplicate_row(client, config, roots):
    root_a, root_b = roots
    source = make_video(root_a / "lesson-02.mp4")
    conn = connect(config.db_path)
    try:
        outcome, original_id = scanner.upsert_file(conn, config, source)
    finally:
        conn.close()
    assert outcome == "added"
    assert original_id is not None

    response = _transfer(client, "copy", [original_id], str(root_b))
    assert response.status_code == 200
    body = response.json()
    assert body["copied"] == 1
    assert body["moved"] == 0
    assert body["failed"] == 0
    item = body["items"][0]
    assert item["id"] == original_id
    assert item["ok"] is True
    assert item["code"] is None
    assert item["new_id"] is not None
    copy_path = root_b / "lesson-02.mp4"
    assert item["path"] == str(copy_path)
    assert copy_path.is_file()
    assert source.is_file()

    row = _db_row(config, item["new_id"])
    assert row is not None
    assert Path(row["path"]) == copy_path
    assert row["status"] == "duplicate"
    assert row["duplicate_of"] == original_id
    assert body["recent_destinations"][0] == str(root_b)


def test_transfer_request_errors(client, config, roots):
    root_a, root_b = roots
    video_id = add_video(config, path=str(_fake_file(root_a / "a.mp4")))
    plain_file = root_a / "note.txt"
    plain_file.write_text("x", encoding="utf-8")

    cases = [
        ({"action": "link", "ids": [video_id], "destination": str(root_b)}, "invalid_action"),
        ({"ids": [video_id], "destination": str(root_b)}, "invalid_action"),
        ({"action": "move", "ids": [], "destination": str(root_b)}, "invalid_ids"),
        ({"action": "move", "ids": [video_id, "1"], "destination": str(root_b)}, "invalid_ids"),
        ({"action": "move", "ids": [True], "destination": str(root_b)}, "invalid_ids"),
        ({"action": "move", "ids": list(range(1, 502)), "destination": str(root_b)}, "invalid_ids"),
        ({"action": "move", "ids": [video_id], "destination": ""}, "invalid_path"),
        ({"action": "move", "ids": [video_id]}, "invalid_path"),
        ({"action": "move", "ids": [video_id], "destination": 42}, "invalid_path"),
        (
            {"action": "move", "ids": [video_id], "destination": str(root_b / "nope")},
            "invalid_path",
        ),
        ({"action": "move", "ids": [video_id], "destination": str(plain_file)}, "invalid_path"),
    ]
    for payload, code in cases:
        response = client.post("/api/videos/transfer", json=payload)
        assert response.status_code == 400, payload
        assert response.json()["code"] == code, payload

    response = _transfer(client, "move", [video_id], str(root_b.parent))
    assert response.status_code == 403
    assert response.json()["code"] == "forbidden_path"

    assert client.get("/api/settings").json()["files.recent_destinations"] == []


def test_transfer_per_item_errors_and_partial_success(client, config, roots):
    root_a, root_b = roots
    same_folder_id = add_video(config, path=str(_fake_file(root_b / "same.mp4")))
    clash_id = add_video(config, path=str(_fake_file(root_a / "clash.mp4")))
    _fake_file(root_b / "clash.mp4")
    ghost_id = add_video(config, path=str(_fake_file(root_a / "ghost.mp4")))
    add_video(config, path=str(root_b / "ghost.mp4"))  # строка есть, файла нет
    missing_id = add_video(config, path=str(root_a / "gone.mp4"))
    ok_id = add_video(config, path=str(_fake_file(root_a / "ok.mp4")))
    ids = [same_folder_id, clash_id, ghost_id, missing_id, 999_999, ok_id]

    response = _transfer(client, "move", ids, str(root_b))
    assert response.status_code == 200
    body = response.json()
    assert body["moved"] == 1
    assert body["copied"] == 0
    assert body["failed"] == 5
    assert [item["id"] for item in body["items"]] == ids
    assert [item["code"] for item in body["items"]] == [
        "same_folder",
        "target_exists",
        "target_exists",
        "missing_file",
        "not_found",
        None,
    ]
    assert all(item["ok"] is False for item in body["items"][:5])
    assert body["items"][5]["ok"] is True
    assert body["items"][5]["path"] == str(root_b / "ok.mp4")
    assert (root_b / "ok.mp4").is_file()
    assert not (root_a / "ok.mp4").exists()
    # Частичный успех всё равно пополняет историю.
    assert body["recent_destinations"] == [str(root_b)]


def test_history_keeps_last_five_without_duplicates(client, config, roots):
    root_a, root_b = roots
    destinations = []
    for index in range(6):
        destination = root_b / f"sub-{index}"
        destination.mkdir(parents=True)
        destinations.append(destination)
        source = _fake_file(root_a / f"file-{index}.mp4")
        video_id = add_video(config, path=str(source))
        response = _transfer(client, "move", [video_id], str(destination))
        assert response.status_code == 200
        assert response.json()["moved"] == 1

    history = client.get("/api/settings").json()["files.recent_destinations"]
    assert history == [str(destination) for destination in reversed(destinations)][:5]
    assert len(history) == 5

    repeated = destinations[2]
    source = _fake_file(root_a / "again.mp4")
    video_id = add_video(config, path=str(source))
    body = _transfer(client, "move", [video_id], str(repeated)).json()
    history = body["recent_destinations"]
    assert history[0] == str(repeated)
    assert len(history) == 5
    assert len(set(history)) == 5
    assert history == client.get("/api/settings").json()["files.recent_destinations"]


def test_move_db_error_rolls_file_back(client, config, roots):
    root_a, root_b = roots
    source = _fake_file(root_a / "rollback.mp4")
    video_id = add_video(config, path=str(source))
    conn = connect(config.db_path)
    try:
        conn.execute(
            "CREATE TRIGGER fail_move BEFORE UPDATE OF path ON videos BEGIN "
            "SELECT RAISE(ABORT, 'db failure'); END"
        )
        conn.commit()
    finally:
        conn.close()

    response = _transfer(client, "move", [video_id], str(root_b))
    assert response.status_code == 200
    body = response.json()
    assert body["moved"] == 0
    assert body["failed"] == 1
    item = body["items"][0]
    assert item["ok"] is False
    assert item["code"] == "move_failed"
    # Best-effort откат: файл вернулся, строка не изменилась, история не пополнилась.
    assert source.is_file()
    assert not (root_b / "rollback.mp4").exists()
    row = _db_row(config, video_id)
    assert Path(row["path"]) == source
    assert body["recent_destinations"] == []


def test_copy_index_error_is_not_fatal(client, config, roots, monkeypatch):
    root_a, root_b = roots
    source = _fake_file(root_a / "unindexable.mp4")
    video_id = add_video(config, path=str(source))

    def fail_index(*_args, **_kwargs):
        raise sqlite3.IntegrityError("UNIQUE constraint failed: videos.path")

    monkeypatch.setattr(scanner, "upsert_file", fail_index)

    response = _transfer(client, "copy", [video_id], str(root_b))
    assert response.status_code == 200
    body = response.json()
    assert body["copied"] == 1
    assert body["failed"] == 0
    item = body["items"][0]
    assert item["ok"] is True
    assert item["code"] == "index_error"
    assert item["new_id"] is None
    assert (root_b / "unindexable.mp4").is_file()
    assert source.is_file()


def test_recent_destinations_setting_validation(client, roots):
    url = "/api/settings"
    assert client.get(url).json()["files.recent_destinations"] == []

    invalid_values = [
        "not-a-list",
        42,
        None,
        [1],
        ["ok", ""],
        ["x" * 4097],
        [f"/tmp/dir-{index}" for index in range(6)],
        ["/tmp/a", "/tmp/a"],
    ]
    for value in invalid_values:
        response = client.patch(url, json={"files.recent_destinations": value})
        assert response.status_code == 400, value
        assert response.json()["code"] == "invalid_setting", value

    assert client.patch(url, json={"files.recent_destinations": []}).status_code == 200
    valid = ["/tmp/a", "/tmp/b"]
    response = client.patch(url, json={"files.recent_destinations": valid})
    assert response.status_code == 200
    assert response.json()["files.recent_destinations"] == valid
    assert client.get(url).json()["files.recent_destinations"] == valid
