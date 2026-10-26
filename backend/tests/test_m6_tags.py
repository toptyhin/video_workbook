from __future__ import annotations

from tests.helpers import add_segment, add_tag, add_video


def test_tags_crud_and_tree(client):
    root = client.post("/api/tags", json={"name": "Учёба"})
    assert root.status_code == 201
    root_id = root.json()["id"]
    child = client.post("/api/tags", json={"parent_id": root_id, "name": "Математика", "color": "#2563eb"})
    assert child.status_code == 201
    assert child.json()["color"] == "#2563eb"
    tree = client.get("/api/tags/tree").json()
    assert tree["total"] == 1
    assert tree["items"][0]["name"] == "Учёба"
    assert tree["items"][0]["children"][0]["name"] == "Математика"
    assert set(tree["items"][0]["counts"]) == {"files", "segments", "annotations", "children"}

    renamed = client.patch(f"/api/tags/{child.json()['id']}", json={"name": "Алгебра"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Алгебра"

    assert client.delete(f"/api/tags/{root_id}").status_code == 204
    assert client.get("/api/tags/tree").json()["total"] == 0


def test_tag_validation(client):
    assert client.post("/api/tags", json={"name": "  "}).status_code == 400
    assert client.post("/api/tags", json={"name": "a/b"}).status_code == 400
    assert client.post("/api/tags", json={"name": "Цикл"}).status_code == 201
    assert client.post("/api/tags", json={"name": "Цикл"}).status_code == 409
    parent = client.post("/api/tags", json={"name": "L0"}).json()["id"]
    current = parent
    for level in range(1, 5):
        response = client.post("/api/tags", json={"parent_id": current, "name": f"L{level}"})
        assert response.status_code == 201, (level, response.json())
        current = response.json()["id"]
    too_deep = client.post("/api/tags", json={"parent_id": current, "name": "L5"})
    assert too_deep.status_code == 400
    assert too_deep.json()["code"] == "tag_depth_exceeded"
    grandchild = client.get("/api/tags/tree").json()
    root = next(item for item in grandchild["items"] if item["id"] == parent)
    child_id = root["children"][0]["id"]
    cycle = client.patch(f"/api/tags/{parent}", json={"parent_id": child_id})
    assert cycle.status_code == 400
    assert cycle.json()["code"] == "tag_cycle"
    assert client.patch("/api/tags/9999", json={"name": "x"}).status_code == 404


def test_video_tag_filters(client, config):
    video_id = add_video(config, path="/tmp/tags/v1.mp4")
    parent = client.post("/api/tags", json={"name": "Учёба"}).json()
    child = client.post("/api/tags", json={"parent_id": parent["id"], "name": "Математика"}).json()
    assert client.post(f"/api/videos/{video_id}/tags", json={"tag_id": child["id"]}).status_code == 204
    client.post(f"/api/videos/{video_id}/tags", json={"tag_id": child["id"]})

    listing = client.get("/api/videos", params={"tag_ids": parent["id"]}).json()
    assert [item["id"] for item in listing["items"]] == [video_id]
    assert listing["items"][0]["tags_count"] == 1

    strict = client.get("/api/videos", params={"tag_ids": parent["id"], "include_children": 0}).json()
    assert strict["total"] == 0

    tree = client.get("/api/tags/tree").json()
    root_node = tree["items"][0]
    assert root_node["counts"]["files"] == 1
    assert root_node["children"][0]["counts"]["files"] == 1

    assert client.delete(f"/api/videos/{video_id}/tags/{child['id']}").status_code == 204
    assert client.get("/api/videos", params={"tag_ids": parent["id"]}).json()["total"] == 0
    assert client.post("/api/videos/999/tags", json={"tag_id": child["id"]}).status_code == 404


def test_segment_tags(client, config):
    video_id = add_video(config, path="/tmp/tags/v2.mp4")
    segment_id = add_segment(config, video_id, 0, 1000, "текст")
    tag = client.post("/api/tags", json={"name": "важное"}).json()
    assert client.post(f"/api/segments/{segment_id}/tags", json={"tag_id": tag["id"]}).status_code == 204
    segments = client.get(f"/api/videos/{video_id}/segments").json()["segments"]
    assert segments[0]["tag_ids"] == [tag["id"]]
    assert client.delete(f"/api/segments/{segment_id}/tags/{tag['id']}").status_code == 204
    segments = client.get(f"/api/videos/{video_id}/segments").json()["segments"]
    assert segments[0]["tag_ids"] == []


def test_tags_export_import(client):
    root = client.post("/api/tags", json={"name": "Курс", "color": "#22c55e"}).json()
    client.post("/api/tags", json={"parent_id": root["id"], "name": "Урок 1"})
    exported = client.get("/api/tags/export").json()
    assert exported["version"] == 1
    paths = {item["path"] for item in exported["tags"]}
    assert paths == {"Курс", "Курс/Урок 1"}

    client.delete(f"/api/tags/{root['id']}")
    assert client.get("/api/tags/tree").json()["total"] == 0
    result = client.post("/api/tags/import", json={"data": exported, "mode": "merge"}).json()
    assert result["imported"] == 2
    tree = client.get("/api/tags/tree").json()
    assert tree["items"][0]["name"] == "Курс"
    assert tree["items"][0]["children"][0]["name"] == "Урок 1"

    replaced = client.post("/api/tags/import", json={"data": {"version": 1, "tags": [{"path": "Only"}]}, "mode": "replace"}).json()
    assert replaced["imported"] == 1
    assert client.get("/api/tags/tree").json()["total"] == 1


def test_tag_ids_by_name_resolution(client, config):
    video_id = add_video(config, path="/tmp/tags/v3.mp4")
    root = client.post("/api/tags", json={"name": "Учёба"}).json()
    child = client.post("/api/tags", json={"parent_id": root["id"], "name": "Производные"}).json()
    client.post(f"/api/videos/{video_id}/tags", json={"tag_id": child["id"]})
    response = client.get("/api/search", params={"q": "tag:Производные", "scope": "files"})
    assert response.status_code == 200
    assert any(item["video_id"] == video_id for item in response.json()["items"])
