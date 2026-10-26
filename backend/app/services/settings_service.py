"""Настройки: канон ключей 00 §4.1 п.1, хранение в settings."""
from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any

log = logging.getLogger(__name__)

DEFAULTS: dict[str, Any] = {
    "language": "auto",
    "whisper_model": "small",
    "theme": "system",
    "tags.multi_select_mode": "union",
    "tags.max_depth": 5,
    "log.level": "INFO",
    "external.player": "mpv",
    "external.player_path": "",
    "external.policy": "ask",
    "external.pass_marks": True,
}

ALLOWED_VALUES: dict[str, set[Any]] = {
    "language": {"auto", "ru", "en"},
    "whisper_model": {"tiny", "base", "small", "medium"},
    "theme": {"light", "dark", "system"},
    "tags.multi_select_mode": {"union", "intersection"},
    "log.level": {"INFO", "DEBUG", "WARNING"},
    "external.player": {"mpv", "vlc", "system"},
    "external.policy": {"ask", "always", "never"},
}


class SettingsError(ValueError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def _decode(raw: str) -> Any:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:  # pragma: no cover - защита от порчи файла/БД
        return raw


def get_all(conn: sqlite3.Connection) -> dict[str, Any]:
    values = dict(DEFAULTS)
    for row in conn.execute("SELECT key, value FROM settings"):
        values[row["key"]] = _decode(row["value"])
    return values


def validate(key: str, value: Any) -> Any:
    if key not in DEFAULTS:
        raise SettingsError("unknown_setting", f"Неизвестная настройка: {key}")
    if key == "external.player_path":
        if not isinstance(value, str) or len(value) > 500:
            raise SettingsError("invalid_setting", "external.player_path: ожидается строка до 500 символов")
        return value.strip()
    if key == "external.pass_marks":
        if not isinstance(value, bool):
            raise SettingsError("invalid_setting", "external.pass_marks: ожидается true/false")
        return value
    if key == "tags.max_depth":
        if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 8:
            raise SettingsError("invalid_setting", "tags.max_depth: ожидается целое 1..8")
        return value
    if key in ALLOWED_VALUES:
        if value not in ALLOWED_VALUES[key]:
            raise SettingsError(
                "invalid_setting",
                f"{key}: допустимые значения: {sorted(ALLOWED_VALUES[key])}",
            )
        return value
    raise SettingsError("invalid_setting", f"{key}: неверный тип")


def patch(conn: sqlite3.Connection, values: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(values, dict) or not values:
        raise SettingsError("invalid_setting", "Ожидается непустой объект настроек")
    normalized: dict[str, Any] = {}
    for key, raw in values.items():
        normalized[key] = validate(key, raw)
    for key, value in normalized.items():
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )
    conn.commit()
    return get_all(conn)
