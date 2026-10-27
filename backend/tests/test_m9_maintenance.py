from __future__ import annotations

from tests.helpers import add_video


def test_models_endpoint(client):
    response = client.get("/api/models")
    assert response.status_code == 200
    payload = response.json()
    ids = [item["id"] for item in payload["items"]]
    assert "whisper-small" in ids
    assert "embedding-e5-small" in ids
    assert "summary-lfm2.5-350m" in ids
    assert "summary-qwen2.5-0.5b" in ids
    assert isinstance(payload["total_installed_bytes"], int)
    assert isinstance(payload["total_available_bytes"], int)
    assert isinstance(payload["models_dir"], str) and payload["models_dir"]
    assert payload["offline"] is False
    required = {"id", "kind", "label", "installed", "bundled", "status", "size_bytes",
                "progress", "license", "recommended", "default", "meta"}
    assert all(required <= set(item) for item in payload["items"])
    summary = {item["id"]: item for item in payload["items"] if item["kind"] == "summary"}
    assert summary["summary-lfm2.5-350m"]["recommended"] is True
    assert summary["summary-qwen2.5-0.5b"]["recommended"] is False


def test_models_offline_mode_blocks_download(client):
    patched = client.patch("/api/settings", json={"models.offline": True})
    assert patched.status_code == 200
    try:
        response = client.post("/api/models/whisper-medium/download")
        assert response.status_code == 403
        assert response.json()["code"] == "offline_mode"
    finally:
        client.patch("/api/settings", json={"models.offline": False})


def test_videos_include_tag_ids(client, config):
    video_id = add_video(config, path="/tmp/m9/v1.mp4")
    tag = client.post("/api/tags", json={"name": "тег-для-списка"}).json()
    client.post(f"/api/videos/{video_id}/tags", json={"tag_id": tag["id"]})
    items = client.get("/api/videos").json()["items"]
    video = next(item for item in items if item["id"] == video_id)
    assert video["tag_ids"] == [tag["id"]]
    assert video["tags_count"] == 1
