"""Зависимости FastAPI: конфиг, БД, шина событий."""
from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from typing import Any

from fastapi import Request

from .config import Config
from .db import connect


def get_config(request: Request) -> Config:
    return request.app.state.config


def get_bus(request: Request) -> Any:
    return request.app.state.bus


def get_db(request: Request) -> Iterator[sqlite3.Connection]:
    conn = connect(request.app.state.config.db_path)
    try:
        yield conn
    finally:
        conn.close()
