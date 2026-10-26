from __future__ import annotations

import asyncio

from app.db import connect, get_user_version, migrate
from app.services.events import EventBus


def test_health_ok(client, config):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body == {"status": "ok", "version": config.version, "db": "ok"}


def test_auth_required(anon_client):
    response = anon_client.get("/api/health")
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_auth_wrong_token(anon_client):
    response = anon_client.get("/api/health", headers={"X-VL-Token": "wrong"})
    assert response.status_code == 401


def test_query_token_not_allowed_for_health(anon_client):
    response = anon_client.get("/api/health", params={"token": "test-token"})
    assert response.status_code == 401


def test_query_token_required_for_events(anon_client):
    response = anon_client.get("/api/events")
    assert response.status_code == 401


def test_settings_defaults_and_patch(client):
    response = client.get("/api/settings")
    assert response.status_code == 200
    body = response.json()
    assert body["language"] == "auto"
    assert body["whisper_model"] == "small"
    assert body["theme"] == "system"
    assert body["tags.multi_select_mode"] == "union"
    assert body["tags.max_depth"] == 5
    assert body["log.level"] == "INFO"

    response = client.patch("/api/settings", json={"language": "ru"})
    assert response.status_code == 200
    assert response.json()["language"] == "ru"
    assert client.get("/api/settings").json()["language"] == "ru"


def test_settings_invalid_key(client):
    response = client.patch("/api/settings", json={"nope": 1})
    assert response.status_code == 400
    assert response.json()["code"] == "unknown_setting"


def test_settings_invalid_value(client):
    response = client.patch("/api/settings", json={"language": "de"})
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_setting"
    response = client.patch("/api/settings", json={"tags.max_depth": 9})
    assert response.status_code == 400


def test_settings_survive_restart(config, app, client):
    client.patch("/api/settings", json={"theme": "dark"})
    from app.main import create_app

    app2 = create_app(config)
    from fastapi.testclient import TestClient

    with TestClient(app2, headers={"X-VL-Token": "test-token"}) as c2:
        assert c2.get("/api/settings").json()["theme"] == "dark"


def test_migrations_idempotent_and_version(config):
    conn = connect(config.db_path)
    try:
        assert migrate(conn, config.migrations_dir) == 3
        assert get_user_version(conn) == 3
        assert migrate(conn, config.migrations_dir) == 3
        tables = {
            row["name"]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        for table in ("videos", "segments", "tags", "video_tags", "segment_tags", "annotations",
                      "watched_folders", "settings", "folder_stats"):
            assert table in tables
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(videos)")}
        for column in ("lang", "model", "headline", "mtime_ms", "duplicate_of"):
            assert column in columns
    finally:
        conn.close()


def test_event_bus_publish_subscribe():
    async def scenario():
        bus = EventBus()
        async with bus.subscribe() as queue:
            bus.publish("video.status", {"video_id": 1, "status": "pending"})
            event = await asyncio.wait_for(queue.get(), timeout=1)
            assert event["type"] == "video.status"
            assert event["payload"]["video_id"] == 1
            assert event["ts"]
        assert bus.subscriber_count == 0

    asyncio.run(scenario())


def test_unknown_api_route(client):
    response = client.get("/api/does-not-exist")
    assert response.status_code == 404
