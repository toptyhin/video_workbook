"""M13: реестр моделей и разрешение путей (plans/13-model-store.md).

Порядок разрешения: `$VL_MODELS_DIR`/`$VL_DATA_DIR/models` → legacy
`$VL_RESOURCES_DIR/models` (старые поставки) → модель отсутствует.
Никаких сетевых запросов здесь нет.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..config import Config

MANIFEST_PATH = Path(__file__).resolve().parents[1] / "model_manifest.json"

_cache: dict[str, Any] | None = None


def load_manifest(force: bool = False) -> dict[str, Any]:
    global _cache
    if _cache is None or force:
        _cache = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return _cache


def models(kind: str | None = None) -> list[dict[str, Any]]:
    items = [dict(item) for item in load_manifest().get("models", [])]
    if kind is not None:
        items = [item for item in items if item.get("kind") == kind]
    return items


def get_model(model_id: str) -> dict[str, Any] | None:
    for item in load_manifest().get("models", []):
        if item.get("id") == model_id:
            return dict(item)
    return None


def summary_model_ids() -> list[str]:
    return [item["id"] for item in models("summary")]


def summary_default_model() -> str:
    for item in models("summary"):
        if item.get("default"):
            return str(item["id"])
    return summary_model_ids()[0]


def model_dir(config: Config, entry: dict[str, Any]) -> Path:
    return config.models_dir / str(entry["local_dir"])


def legacy_model_dir(config: Config, entry: dict[str, Any]) -> Path:
    return config.resources_dir / "models" / str(entry["local_dir"])


def _files_present(base: Path, entry: dict[str, Any]) -> bool:
    files = entry.get("source", {}).get("files", [])
    if not files:
        return False
    for file in files:
        target = base / str(file.get("local") or file["path"])
        if not target.is_file():
            return False
        size = file.get("size")
        if isinstance(size, int) and size > 0 and target.stat().st_size != size:
            return False
    return True


def is_installed(config: Config, entry: dict[str, Any]) -> bool:
    return _files_present(model_dir(config, entry), entry) or _files_present(
        legacy_model_dir(config, entry), entry
    )


def is_bundled(config: Config, entry: dict[str, Any]) -> bool:
    """Модель найдена в read-only resources и не скачана в data dir."""
    return not _files_present(model_dir(config, entry), entry) and _files_present(
        legacy_model_dir(config, entry), entry
    )


def resolve_model(config: Config, entry: dict[str, Any]) -> Path | None:
    data_dir = model_dir(config, entry)
    if _files_present(data_dir, entry):
        return data_dir
    legacy = legacy_model_dir(config, entry)
    if _files_present(legacy, entry):
        return legacy
    return None


def resolve_whisper(config: Config, name: str) -> Path | None:
    entry = get_model(f"whisper-{name}")
    if entry is not None:
        return resolve_model(config, entry)
    # Совместимость с моделями, положенными вручную (legacy без manifest).
    for base in (config.models_dir, config.resources_dir / "models"):
        candidate = base / f"faster-whisper-{name}"
        if (candidate / "model.bin").is_file():
            return candidate
    return None


def resolve_embedding(config: Config) -> Path | None:
    entry = get_model("embedding-e5-small")
    if entry is not None:
        resolved = resolve_model(config, entry)
        if resolved is not None:
            return resolved
    for base in (config.models_dir, config.resources_dir / "models"):
        candidate = base / "multilingual-e5-small-onnx"
        if (candidate / "tokenizer.json").is_file():
            return candidate
    return None


def resolve_summary_gguf(config: Config, model_id: str) -> Path | None:
    entry = get_model(model_id)
    if entry is None:
        return None
    base = resolve_model(config, entry)
    if base is None:
        return None
    for file in entry.get("source", {}).get("files", []):
        target = base / str(file.get("local") or file["path"])
        if target.is_file() and target.suffix == ".gguf":
            return target
    candidate = base / "model.gguf"
    return candidate if candidate.is_file() else None
