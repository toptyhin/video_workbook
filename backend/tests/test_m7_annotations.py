from __future__ import annotations

from tests.helpers import add_video


def seed_video(config, path="/tmp/ann/lesson.mp4", duration=600_000):
    return add_video(config, path=path, duration_ms=duration, status="done")


def make_annotation(client, video_id, **overrides):
    payload = {
        "video_id": video_id,
        "start_ms": 30_000,
        "end_ms": 75_000,
        "label": "важный пример",
        "color": "#3b82f6",
        "note": "производная сложной функции",
        **overrides,
    }
    return client.post("/api/annotations", json=payload)


def test_annotation_crud(client, config):
    video_id = seed_video(config)
    created = make_annotation(client, video_id)
    assert created.status_code == 201, created.json()
    annotation = created.json()
    assert annotation["label"] == "важный пример"
    assert annotation["tag_ids"] == []
    assert annotation["updated_at"]

    listing = client.get("/api/annotations", params={"video_id": video_id}).json()
    assert listing["total"] == 1
    assert listing["items"][0]["id"] == annotation["id"]

    updated = client.patch(
        f"/api/annotations/{annotation['id']}",
        json={"label": "переименовано", "start_ms": 31_000, "end_ms": 80_000, "color": "#ef4444"},
    )
    assert updated.status_code == 200
    assert updated.json()["label"] == "переименовано"
    assert updated.json()["start_ms"] == 31_000

    assert client.delete(f"/api/annotations/{annotation['id']}").status_code == 204
    assert client.get(f"/api/annotations/{annotation['id']}").status_code == 404
    assert client.patch("/api/annotations/9999", json={"label": "x"}).status_code == 404


def test_annotation_validation(client, config):
    video_id = seed_video(config)
    cases = [
        ({"start_ms": 5000, "end_ms": 5000}, "annotation_invalid_range"),
        ({"start_ms": 5000, "end_ms": 5100}, "annotation_invalid_range"),
        ({"start_ms": -10, "end_ms": 5000}, "annotation_invalid_range"),
        ({"start_ms": 10_000, "end_ms": 700_000}, "annotation_invalid_range"),
        ({"label": "   "}, "annotation_empty_label"),
        ({"label": "я" * 201}, "annotation_label_too_long"),
        ({"color": "red"}, "annotation_invalid_color"),
        ({"note": "я" * 2001}, "annotation_note_too_long"),
    ]
    for overrides, expected_code in cases:
        response = make_annotation(client, video_id, **overrides)
        assert response.status_code == 400, (overrides, response.json())
        assert response.json()["code"] == expected_code, (overrides, response.json())
    response = make_annotation(client, 9999)
    assert response.status_code == 404
    response = make_annotation(client, video_id, tag_ids=[9999])
    assert response.status_code == 404


def test_bulk_atomic(client, config):
    video_id = seed_video(config)
    items = [
        {"start_ms": 0, "end_ms": 1000, "label": "a"},
        {"start_ms": 2000, "end_ms": 3000, "label": "b"},
        {"start_ms": 5000, "end_ms": 10, "label": "broken"},
    ]
    response = client.post("/api/annotations/bulk", json={"video_id": video_id, "items": items})
    assert response.status_code == 400
    assert client.get("/api/annotations", params={"video_id": video_id}).json()["total"] == 0
    ok = client.post("/api/annotations/bulk", json={"video_id": video_id, "items": items[:2]})
    assert ok.status_code == 201
    assert ok.json()["total"] == 2


def test_annotation_tags_and_segments(client, config):
    video_id = seed_video(config)
    tag = client.post("/api/tags", json={"name": "важное"}).json()
    created = make_annotation(client, video_id, tag_ids=[tag["id"]]).json()
    assert created["tag_ids"] == [tag["id"]]
    segments = client.get(f"/api/videos/{video_id}/segments").json()
    assert segments["annotations"][0]["tag_ids"] == [tag["id"]]
    filtered = client.get("/api/annotations", params={"tag_id": tag["id"]}).json()
    assert [item["id"] for item in filtered["items"]] == [created["id"]]
    tree = client.get("/api/tags/tree").json()
    assert tree["items"][0]["counts"]["annotations"] == 1


def test_search_annotations(client, config):
    video_id = seed_video(config)
    tag = client.post("/api/tags", json={"name": "важное"}).json()
    make_annotation(client, video_id, tag_ids=[tag["id"]], label="важный пример", note="производная сложной функции")
    other = make_annotation(client, video_id, start_ms=100_000, end_ms=140_000, label="обычный фрагмент", color="#22c55e", note=None).json()

    by_label = client.get("/api/search", params={"q": "важный", "scope": "annotations"}).json()
    assert by_label["total"] == 1
    item = by_label["items"][0]
    assert item["kind"] == "annotation"
    assert item["annotation_id"]
    assert item["start_ms"] == 30_000
    assert "<mark>" in item["snippet_html"]

    by_note = client.get("/api/search", params={"q": "производная", "scope": "annotations"}).json()
    assert by_note["total"] == 1
    assert by_note["items"][0]["annotation_id"] != other["id"]

    by_tag = client.get("/api/search", params={"q": "tag:важное", "scope": "annotations"}).json()
    assert by_tag["total"] == 1

    by_color = client.get("/api/search", params={"q": "", "scope": "annotations", "colors": "#22c55e"}).json()
    assert by_color["total"] == 1
    assert by_color["items"][0]["annotation_id"] == other["id"]

    mixed = client.get("/api/search", params={"q": "важный"}).json()
    kinds = {entry["kind"] for entry in mixed["items"]}
    assert "annotation" in kinds


def test_annotation_export_import(client, config):
    video_id = seed_video(config)
    tag = client.post("/api/tags", json={"name": "важное"}).json()
    make_annotation(client, video_id, tag_ids=[tag["id"]])
    make_annotation(client, video_id, start_ms=100_000, end_ms=140_000, label="второй")

    exported = client.get("/api/annotations/export", params={"video_id": video_id}).json()
    assert exported["version"] == 1
    assert len(exported["annotations"]) == 2
    assert exported["annotations"][0]["tags"] == ["важное"]

    for _ in exported["annotations"]:
        annotation_id = client.get("/api/annotations", params={"video_id": video_id}).json()["items"][0]["id"]
        client.delete(f"/api/annotations/{annotation_id}")
    assert client.get("/api/annotations", params={"video_id": video_id}).json()["total"] == 0

    imported = client.post("/api/annotations/import", json={"video_id": video_id, "data": exported, "mode": "merge"}).json()
    assert imported["imported"] == 2
    assert client.get("/api/annotations", params={"video_id": video_id}).json()["total"] == 2
    again = client.post("/api/annotations/import", json={"video_id": video_id, "data": exported, "mode": "merge"}).json()
    assert again["skipped"] == 2


def test_annotations_require_token(anon_client):
    assert anon_client.get("/api/annotations").status_code == 401
