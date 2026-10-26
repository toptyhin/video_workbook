"""Транскрипция: извлечение аудио и faster-whisper в отдельном процессе (M3)."""
from __future__ import annotations

import logging
import os
import subprocess
import traceback
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


def extract_audio(ffmpeg: str, video_path: str, wav_path: str, timeout: int = 3600) -> None:
    wav = Path(wav_path)
    wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        video_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        str(wav),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    if proc.returncode != 0 or not wav.exists() or wav.stat().st_size == 0:
        detail = (proc.stderr or "").strip().splitlines()
        raise RuntimeError(f"ffmpeg audio extraction failed: {detail[-1] if detail else 'unknown error'}")


def transcribe_task(
    *,
    video_id: int,
    video_path: str,
    wav_path: str,
    ffmpeg: str,
    model_name: str,
    model_dir: str | None,
    language: str,
    duration_ms: int | None,
    progress_queue: Any,
    result_queue: Any,
    error_queue: Any,
    cancel_event: Any,
) -> None:
    """Entrypoint дочернего процесса (spawn)."""
    try:
        extract_audio(ffmpeg, video_path, wav_path)
        if cancel_event.is_set():
            return
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:  # pragma: no cover - зависит от окружения
            error_queue.put(
                "faster-whisper не установлен. Установите backend/requirements-ml.txt."
            )
            raise RuntimeError("faster-whisper missing") from exc
        model_source = model_dir or model_name
        if model_dir is None and os.environ.get("VL_ALLOW_MODEL_DOWNLOAD") != "1":
            error_queue.put(
                f"Модель {model_name} не найдена в resources/models. "
                "Установите её скриптом scripts/fetch-model.sh."
            )
            return
        model = WhisperModel(
            model_source,
            device="cpu",
            compute_type="int8",
            cpu_threads=int(os.environ.get("VL_CPU_THREADS", "6")),
            num_workers=1,
        )
        segments_iter, info = model.transcribe(
            wav_path,
            language=None if language in (None, "", "auto") else language,
            vad_filter=True,
            word_timestamps=True,
            beam_size=5,
        )
        duration_s = float(getattr(info, "duration", 0) or (duration_ms or 0) / 1000 or 1)
        segments: list[dict[str, Any]] = []
        for segment in segments_iter:
            if cancel_event.is_set():
                return
            text = (segment.text or "").strip()
            if not text:
                continue
            segments.append(
                {
                    "start_ms": int(round(segment.start * 1000)),
                    "end_ms": int(round(segment.end * 1000)),
                    "text": text,
                }
            )
            try:
                progress_queue.put_nowait(min(0.999, max(0.0, segment.end / duration_s)))
            except Exception:  # pragma: no cover - очередь переполнена
                pass
        result_queue.put(
            {
                "segments": segments,
                "lang": getattr(info, "language", None),
                "duration_s": duration_s,
                "headline": segments[0]["text"][:120] if segments else None,
            }
        )
    except Exception as exc:  # pragma: no cover - защитная ветка
        error_queue.put(f"{type(exc).__name__}: {exc}\n{traceback.format_exc()[-1500:]}")
