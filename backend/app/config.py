"""Конфигурация и пути приложения (A3, A12, §7 конвенций)."""
from __future__ import annotations

import os
import secrets
import shutil
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# дочерние процессы (spawn) должны видеть пакет app
os.environ.setdefault("PYTHONPATH", str(REPO_ROOT / "backend"))


def _env_path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    return Path(value).expanduser().resolve() if value else default


def default_data_dir() -> Path:
    if os.environ.get("VL_DATA_DIR"):
        return Path(os.environ["VL_DATA_DIR"]).expanduser().resolve()
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "share"
    return base / "VideoLessons"


class Config:
    """Единая точка конфигурации; создаётся один раз на процесс."""

    version = "0.1.0"

    def __init__(self) -> None:
        self.repo_root = REPO_ROOT
        self.data_dir = default_data_dir()
        self.resources_dir = _env_path("VL_RESOURCES_DIR", REPO_ROOT / "resources")
        self.db_path = self.data_dir / "library.db"
        self.logs_dir = self.data_dir / "logs"
        self.thumbs_dir = self.data_dir / "cache" / "thumbs"
        self.tmp_dir = self.data_dir / "tmp"
        self.recordings_dir = self.data_dir / "recordings"
        self.recording_tmp_dir = self.tmp_dir / "recordings"
        # M13: модели управляются менеджером моделей и живут в data dir
        # (в AppImage resources только для чтения). VL_MODELS_DIR — dev/e2e.
        self.models_dir = _env_path("VL_MODELS_DIR", self.data_dir / "models")
        self.offline = os.environ.get("VL_OFFLINE") == "1"
        # M14: CPU-runtime llama.cpp (в поставке — resources/llama/llama-cli).
        self.llama_cli = _env_path(
            "VL_LLAMA_CLI", self.resources_dir / "llama" / "llama-cli"
        )
        try:
            self.summary_threads = max(1, min(8, int(os.environ.get("VL_SUMMARY_THREADS", "4"))))
        except ValueError:
            self.summary_threads = 4
        self.frontend_dir = self._resolve_frontend_dir()
        self.migrations_dir = Path(__file__).resolve().parent / "migrations"
        self.token = os.environ.get("VL_TOKEN") or secrets.token_hex(32)
        self.token_generated = "VL_TOKEN" not in os.environ
        self.dev_port = int(os.environ.get("VL_DEV_BACKEND_PORT", "8765"))
        self.ffmpeg = self._resolve_bin("VL_FFMPEG", "ffmpeg")
        self.ffprobe = self._resolve_bin("VL_FFPROBE", "ffprobe")
        self.host = "127.0.0.1"
        # --- семантический поиск (M12) ---
        self.embedding_model_dir = _env_path(
            "VL_EMBEDDING_MODEL_DIR",
            self.resources_dir / "models" / "multilingual-e5-small-onnx",
        )
        self.embedding_model_name = "multilingual-e5-small"
        self.embedding_dim = 384
        self.embedding_autoindex = os.environ.get("VL_EMBED_AUTOINDEX") != "0"
        try:
            embedding_threads = int(os.environ.get("VL_EMBED_THREADS", "2"))
        except ValueError:
            embedding_threads = 2
        self.embedding_threads = max(1, embedding_threads)

    def _resolve_frontend_dir(self) -> Path:
        explicit = os.environ.get("VL_FRONTEND_DIR")
        if explicit:
            return Path(explicit).expanduser().resolve()
        packaged = self.resources_dir / "frontend" / "dist"
        if (packaged / "index.html").exists():
            return packaged
        return REPO_ROOT / "frontend" / "dist"

    def _resolve_bin(self, env_name: str, name: str) -> str:
        explicit = os.environ.get(env_name)
        if explicit:
            return explicit
        candidate = self.resources_dir / "ffmpeg" / name
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
        return shutil.which(name) or name

    def ensure_dirs(self) -> None:
        for path in (
            self.data_dir,
            self.logs_dir,
            self.thumbs_dir,
            self.tmp_dir,
            self.recordings_dir,
            self.recording_tmp_dir,
            self.models_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)

    @property
    def api_prefix(self) -> str:
        return "/api"


_config: Config | None = None


def get_config() -> Config:
    global _config
    if _config is None:
        _config = Config()
    return _config


def reset_config() -> None:
    """Только для тестов."""
    global _config
    _config = None
