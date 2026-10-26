from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

TOKEN = "test-token"


@pytest.fixture
def config(tmp_path, monkeypatch):
    monkeypatch.setenv("VL_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("VL_TOKEN", TOKEN)
    from app.config import Config

    cfg = Config()
    cfg.ensure_dirs()
    return cfg


@pytest.fixture
def app(config):
    from app.main import create_app

    return create_app(config)


@pytest.fixture
def client(app):
    with TestClient(app, headers={"X-VL-Token": TOKEN}) as test_client:
        yield test_client


@pytest.fixture
def anon_client(app):
    with TestClient(app) as test_client:
        yield test_client
