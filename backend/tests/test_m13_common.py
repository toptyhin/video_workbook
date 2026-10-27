"""Общие помощники тестов M13 (файл не содержит самих тестов).

Локальный HTTP-сервер моделей, сборка тестового manifest, установка файлов в
data/legacy-каталоги, ожидание состояний. Сеть в тестах не используется.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from app.services import model_resolver

MI_B = 1024 * 1024
DEFAULT_ID = "test-whisper"
DEFAULT_LOCAL_DIR = "faster-whisper-test"
REVISION = "rev-test-1"
REPO = "test/repo"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def model_entry(
    files: list[tuple[str, bytes]],
    *,
    model_id: str = DEFAULT_ID,
    kind: str = "transcription",
    local_dir: str = DEFAULT_LOCAL_DIR,
    revision: str = REVISION,
    repo: str = REPO,
    sha256s: bool = True,
    recommended: bool = True,
    default: bool = True,
    meta: dict | None = None,
    license: dict | None = None,
    estimate_bytes: int | None = None,
) -> tuple[dict, dict[str, bytes]]:
    """Собирает запись manifest и содержимое файлов (remote path → bytes)."""
    manifest_files = []
    contents: dict[str, bytes] = {}
    for remote, data in files:
        local = remote
        manifest_files.append(
            {
                "path": remote,
                "local": local,
                "size": len(data),
                "sha256": sha256(data) if sha256s else None,
            }
        )
        contents[local] = data
    entry = {
        "id": model_id,
        "kind": kind,
        "label": f"Test {model_id}",
        "local_dir": local_dir,
        "recommended": recommended,
        "default": default,
        "meta": meta or {},
        "estimate_bytes": estimate_bytes
        if estimate_bytes is not None
        else sum(len(data) for _remote, data in files),
        "source": {
            "type": "huggingface",
            "repo": repo,
            "revision": revision,
            "files": manifest_files,
        },
        "license": license or {"name": "MIT", "url": "https://example.invalid/license"},
    }
    return entry, contents


def use_manifest(monkeypatch, entries: list[dict]) -> dict:
    """Подменяет кэш manifest реестра (без правки файла manifest)."""
    manifest = {"schema": 1, "models": entries}
    monkeypatch.setattr(model_resolver, "_cache", manifest)
    return manifest


def install_entry(
    config,
    entry: dict,
    contents: dict[str, bytes],
    *,
    legacy: bool = False,
    marker_revision: str | None = None,
    write_marker: bool = True,
) -> Path:
    root = config.resources_dir / "models" if legacy else config.models_dir
    base = root / entry["local_dir"]
    for local, data in contents.items():
        target = base / local
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    if write_marker:
        marker = {
            "schema": 1,
            "id": entry["id"],
            "local_dir": entry["local_dir"],
            "revision": marker_revision or entry["source"]["revision"],
            "installed_at": "2026-10-27T00:00:00+00:00",
            "manifest": entry,
        }
        (base / ".installed.json").write_text(
            json.dumps(marker), encoding="utf-8"
        )
    return base


def migrate_db(config) -> None:
    from app.db import connect, migrate

    conn = connect(config.db_path)
    try:
        migrate(conn, config.migrations_dir)
    finally:
        conn.close()


def wait_until(predicate, timeout: float = 10.0, interval: float = 0.02):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError(f"условие не выполнено за {timeout}s; последнее значение: {last!r}")


def model_item(store, model_id: str) -> dict:
    for item in store.list_models()["items"]:
        if item["id"] == model_id:
            return item
    raise AssertionError(f"модель {model_id} отсутствует в list_models")


def wait_status(store, model_id: str, statuses: set[str], timeout: float = 10.0) -> dict:
    return wait_until(
        lambda: (
            item
            if (item := model_item(store, model_id))["status"] in statuses
            else None
        ),
        timeout=timeout,
    )


class RecordingBus:
    """EventBus-совместимый приёмник событий для потоковых публикаций."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def publish_threadsafe(self, event_type: str, payload: dict) -> None:
        self.events.append((event_type, payload))

    def publish(self, event_type: str, payload: dict) -> None:
        self.events.append((event_type, payload))

    def types(self) -> list[str]:
        return [event_type for event_type, _payload in self.events]

    def states(self, model_id: str) -> list[str]:
        return [
            payload["status"]
            for event_type, payload in self.events
            if event_type == "model.state" and payload.get("model_id") == model_id
        ]

    def last(self, event_type: str) -> dict | None:
        for kind, payload in reversed(self.events):
            if kind == event_type:
                return payload
        return None


class ModelHTTPServer:
    """Локальный HTTP-сервер с Range, однократным обрывом и медленной отдачей."""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.truncate_once: set[str] = set()
        self.short_once: set[str] = set()
        self.chunk_delay = 0.0
        self.chunk_size = 64 * 1024
        self.requests: list[dict] = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # noqa: D102 - отключаем шум тестов
                return

            def do_GET(self):  # noqa: N802 - API http.server
                path = urlparse(self.path).path
                owner.requests.append({"path": path, "headers": dict(self.headers)})
                data = owner.files.get(path)
                if data is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                start = 0
                range_header = self.headers.get("Range") or ""
                if range_header.startswith("bytes="):
                    try:
                        start = int(range_header.split("=", 1)[1].split("-")[0])
                    except ValueError:
                        start = 0
                if start >= len(data) and start != 0:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{len(data)}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = data[start:]
                if start == 0 and path in owner.short_once:
                    # «Короткий» ответ: успешный, но меньше ожидаемого размера —
                    # клиент должен докачать остаток через Range.
                    owner.short_once.discard(path)
                    body = body[: len(body) // 2]
                truncated = path in owner.truncate_once
                if truncated:
                    owner.truncate_once.discard(path)
                if start:
                    self.send_response(206)
                    self.send_header(
                        "Content-Range", f"bytes {start}-{len(data) - 1}/{len(data)}"
                    )
                else:
                    self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                limit = len(body) // 2 if truncated else len(body)
                sent = 0
                try:
                    while sent < limit:
                        piece = body[sent : min(sent + owner.chunk_size, limit)]
                        self.wfile.write(piece)
                        self.wfile.flush()
                        sent += len(piece)
                        if owner.chunk_delay:
                            time.sleep(owner.chunk_delay)
                except (BrokenPipeError, ConnectionResetError):  # pragma: no cover
                    return
                if truncated:
                    self.close_connection = True

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._httpd.serve_forever, name="m13-test-http", daemon=True
        )
        self._thread.start()

    @property
    def url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}"

    def add(self, remote_path: str, data: bytes) -> None:
        self.files[f"/{REPO}/resolve/{REVISION}/{remote_path}"] = data

    def close(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)
