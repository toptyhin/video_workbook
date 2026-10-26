from __future__ import annotations

from tests.helpers import add_segment, add_tag, add_video


def seed(config):
    video_id = add_video(config, path="/tmp/search/lesson-01.mp4", title="lesson-01.mp4")
    add_segment(config, video_id, 72_000, 78_000, "Производная сложной функции")
    add_segment(config, video_id, 90_000, 95_000, "Правило дифференцирования")
    return video_id


def test_search_segments(client, config):
    seed(config)
    response = client.get("/api/search", params={"q": "производная"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] >= 1
    item = payload["items"][0]
    assert item["kind"] == "segment"
    assert item["start_ms"] == 72_000
    assert "<mark>" in item["snippet_html"]
    assert "производная" in item["snippet_html"].lower()
    assert payload["query"]["scope"] == "all"
    assert "took_ms" in payload["query"]


def test_search_files_scope(client, config):
    seed(config)
    response = client.get("/api/search", params={"q": "lesson", "scope": "files"})
    items = response.json()["items"]
    assert items and items[0]["kind"] == "file"
    assert items[0]["video_title"] == "lesson-01.mp4"


def test_search_prefixes(client, config):
    video_id = add_video(config, path="/tmp/search/prefix.mp4", title="prefix.mp4")
    tag_id = add_tag(config, "Математика")
    conn = None
    from app.db import connect

    conn = connect(config.db_path)
    conn.execute("INSERT INTO video_tags(video_id, tag_id) VALUES (?, ?)", (video_id, tag_id))
    conn.commit()
    conn.close()
    response = client.get("/api/search", params={"q": "tag:Математика", "scope": "files"})
    payload = response.json()
    assert any(item["kind"] == "file" and item["video_id"] == video_id for item in payload["items"])
    response = client.get("/api/search", params={"q": "file:prefix"})
    assert response.status_code == 200


def test_search_validation(client):
    assert client.get("/api/search", params={"q": "x", "scope": "bad"}).status_code == 422
    assert client.get("/api/search", params={"q": "x", "limit": 0}).status_code == 422
    long_query = "а" * 300
    response = client.get("/api/search", params={"q": long_query})
    assert response.status_code == 422
    assert response.json()["code"] == "query_too_long"


def test_search_xss_escaped(client, config):
    video_id = add_video(config, path="/tmp/search/xss.mp4", title="xss.mp4")
    add_segment(config, video_id, 0, 1000, '<img onerror="x"> производная')
    response = client.get("/api/search", params={"q": "производная"})
    snippet = response.json()["items"][0]["snippet_html"]
    assert "<img" not in snippet
    assert "&lt;img" in snippet
    assert "<mark>" in snippet


def test_search_empty_and_fts_operators(client, config):
    seed(config)
    assert client.get("/api/search", params={"q": ""}).json()["total"] == 0
    response = client.get("/api/search", params={"q": "производная OR дифференцирования"})
    assert response.status_code == 200
    assert response.json()["total"] >= 1
    response = client.get("/api/search", params={"q": 'NEAR(производная, правило)'})
    assert response.status_code == 200
