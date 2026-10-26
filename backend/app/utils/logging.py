"""Логи приложения: файл с ротацией + stderr (A13)."""
from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

_FORMAT = "%(asctime)s | %(levelname)s | %(name)s | %(message)s"


def setup_logging(logs_dir: Path, level: str = "INFO") -> None:
    logs_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    if getattr(root, "_videolessons_configured", False):
        return
    root.setLevel(level.upper())
    formatter = logging.Formatter(_FORMAT)
    file_handler = RotatingFileHandler(
        logs_dir / "backend.log", maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(formatter)
    root.addHandler(file_handler)
    root.addHandler(stderr_handler)
    root._videolessons_configured = True  # type: ignore[attr-defined]
