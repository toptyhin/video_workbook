from __future__ import annotations

from tests.helpers import add_video


def test_models_endpoint(client):
    response = client.get("/api/models")
    assert response.status_code == 200
    payload = response.json()
    names = [item["name"] for item in payload["items"]]
    assert names == ["tiny", "base", "small", "medium"]
    assert isinstance(payload["total"], int)
    assert all("bundled" in item and "quantized" in item for item in payload["items"])


def test_clear_model_cache_is_idempotent(client):
    response = client.post("/api/maintenance/clear-model-cache")
    assert response.status_code == 200
    body = response.json()
    assert body["removed_files"] == 0
    assert body["removed_bytes"] == 0


def test_videos_include_tag_ids(client, config):
    video_id = add_video(config, path="/tmp/m9/v1.mp4")
    tag = client.post("/api/tags", json={"name": "тег-для-списка"}).json()
    client.post(f"/api/videos/{video_id}/tags", json={"tag_id": tag["id"]})
    items = client.get("/api/videos").json()["items"]
    video = next(item for item in items if item["id"] == video_id)
    assert video["tag_ids"] == [tag["id"]]
    assert video["tags_count"] == 1
