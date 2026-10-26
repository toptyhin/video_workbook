"""Pydantic-схемы API (расширяются по этапам)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class HealthOut(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    db: Literal["ok", "error"]


class SettingsOut(BaseModel):
    language: str
    whisper_model: str
    theme: str
    tags_multi_select_mode: str = Field(alias="tags.multi_select_mode")
    tags_max_depth: int = Field(alias="tags.max_depth")
    log_level: str = Field(alias="log.level")

    model_config = {"populate_by_name": True}


class SettingsPatch(BaseModel):
    model_config = {"extra": "forbid"}
    language: str | None = None
    whisper_model: str | None = None
    theme: str | None = None
    log_level: str | None = None


class ErrorOut(BaseModel):
    detail: str
    code: str | None = None


class AnnotationBadRequest(BaseModel):
    """Заготовка для M7 (используется в тестах контракта)."""

    detail: str
    code: str


SettingsValues = dict[str, Any]
