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
    # M13: менеджер моделей.
    "models.endpoint": "",
    "models.offline": False,
    "models.auto_download": False,
    # M14: саммари транскрибации.
    "summary.enabled": True,
    "summary.auto": True,
    "summary.thinking": "auto",
    "summary.model": "summary-lfm2.5-350m",
    # V5: история адресатов «Переместить/Скопировать в папку» (свежие первыми).
    "files.recent_destinations": [],
}

RECENT_DESTINATIONS_KEY = "files.recent_destinations"
RECENT_DESTINATIONS_LIMIT = 5

ALLOWED_VALUES: dict[str, set[Any]] = {
    "language": {"auto", "ru", "en"},
    "whisper_model": {"tiny", "base", "small", "medium"},
    "theme": {"light", "dark", "system"},
    "tags.multi_select_mode": {"union", "intersection"},
    "log.level": {"INFO", "DEBUG", "WARNING"},
    "external.player": {"mpv", "vlc", "system"},
    "external.policy": {"ask", "always", "never"},
    "summary.thinking": {"auto", "off"},
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


_BOOL_KEYS = {"models.offline", "models.auto_download", "summary.enabled", "summary.auto"}


def validate(key: str, value: Any) -> Any:
    if key not in DEFAULTS:
        raise SettingsError("unknown_setting", f"Неизвестная настройка: {key}")
    if key in _BOOL_KEYS:
        if not isinstance(value, bool):
            raise SettingsError("invalid_setting", f"{key}: ожидается true/false")
        return value
    if key == "models.endpoint":
        if not isinstance(value, str) or len(value) > 300:
            raise SettingsError("invalid_setting", "models.endpoint: ожидается строка до 300 символов")
        value = value.strip()
        if value and not (value.startswith("https://") or value.startswith("http://127.0.0.1") or value.startswith("http://localhost")):
            raise SettingsError("invalid_setting", "models.endpoint: допустим https://… или http://127.0.0.1…")
        return value.rstrip("/")
    if key == "summary.model":
        from .model_resolver import summary_model_ids

        if value not in summary_model_ids():
            raise SettingsError("invalid_setting", "summary.model: неизвестная модель саммари")
        return value
    if key == "external.player_path":
        if not isinstance(value, str) or len(value) > 500:
            raise SettingsError("invalid_setting", "external.player_path: ожидается строка до 500 символов")
        return value.strip()
    if key == "external.pass_marks":
        if not isinstance(value, bool):
            raise SettingsError("invalid_setting", "external.pass_marks: ожидается true/false")
        return value
    if key == "files.recent_destinations":
        if not isinstance(value, list):
            raise SettingsError(
                "invalid_setting", "files.recent_destinations: ожидается список строк"
            )
        if len(value) > RECENT_DESTINATIONS_LIMIT:
            raise SettingsError(
                "invalid_setting",
                f"files.recent_destinations: не больше {RECENT_DESTINATIONS_LIMIT} значений",
            )
        seen: set[str] = set()
        for item in value:
            if not isinstance(item, str):
                raise SettingsError(
                    "invalid_setting", "files.recent_destinations: ожидается список строк"
                )
            if not 1 <= len(item) <= 4096:
                raise SettingsError(
                    "invalid_setting",
                    "files.recent_destinations: длина пути должна быть 1..4096 символов",
                )
            if item in seen:
                raise SettingsError(
                    "invalid_setting", "files.recent_destinations: дубли путей недопустимы"
                )
            seen.add(item)
        return list(value)
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


def remember_destination(conn: sqlite3.Connection, destination: str) -> list[str]:
    """Кладёт путь в начало истории адресатов, убирает дубли, обрезает до 5."""
    current = get_all(conn).get(RECENT_DESTINATIONS_KEY)
    history: list[str] = [destination]
    for item in current if isinstance(current, list) else []:
        if isinstance(item, str) and item != destination and item not in history:
            history.append(item)
    history = history[:RECENT_DESTINATIONS_LIMIT]
    patch(conn, {RECENT_DESTINATIONS_KEY: history})
    return history
