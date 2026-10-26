"""Автопревью для несовместимых с Chromium видео: remux/transcode через ffmpeg."""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from ..config import Config
from . import media_info
from .events import EventBus

log = logging.getLogger(__name__)

PREVIEW_SUBDIR = "preview"
MAX_PARALLEL = 1


class PreviewManager:
    """Одна очередь транскодинга; состояние доступно фронтенду через /playback."""

    def __init__(self, config: Config, bus: EventBus) -> None:
        self.config = config
        self.bus = bus
        self._lock = threading.Lock()
        self._states: dict[int, dict[str, Any]] = {}
        self._threads: dict[int, threading.Thread] = {}
        self._processes: dict[int, subprocess.Popen[str]] = {}
        self._info_cache: dict[int, tuple[Any, media_info.StreamsInfo]] = {}
        self._semaphore = threading.Semaphore(MAX_PARALLEL)
        self._stop = threading.Event()

    # ---------- paths ----------

    def _dir(self) -> Path:
        path = self.config.data_dir / "cache" / PREVIEW_SUBDIR
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _target(self, video: dict[str, Any], mode: str) -> Path:
        mtime = video.get("mtime_ms") or 0
        suffix = ".webm" if mode == "transcode-webm" else ".mp4"
        return self._dir() / f"{video['id']}_{mtime}_{mode}{suffix}"

    # ---------- probing ----------

    def streams(self, video: dict[str, Any]) -> media_info.StreamsInfo:
        key = int(video["id"])
        mtime = video.get("mtime_ms") or 0
        with self._lock:
            cached = self._info_cache.get(key)
            if cached is not None and cached[0] == mtime:
                return cached[1]
        streams = media_info.probe_streams(video["path"], self.config.ffprobe)
        with self._lock:
            self._info_cache[key] = (mtime, streams)
        return streams

    def plan(self, video: dict[str, Any]) -> dict[str, Any]:
        try:
            streams = self.streams(video)
        except media_info.MediaInfoError as exc:
            return {
                "video_id": int(video["id"]),
                "mode": "unsupported",
                "state": "error",
                "progress": 0.0,
                "error": str(exc),
                "detail": None,
            }
        mode = streams.mode
        target = self._target(video, mode)
        ready = mode == "direct" or (target.exists() and target.stat().st_size > 0)
        state = self.state(int(video["id"]))
        if mode == "direct":
            state_name = "direct"
        elif ready:
            state_name = "ready"
        elif state and state["state"] in {"preparing", "queued"}:
            state_name = state["state"]
        elif state and state["state"] == "error":
            state_name = "error"
        else:
            state_name = "idle"
        return {
            "video_id": int(video["id"]),
            "mode": mode,
            "state": state_name,
            "progress": float(state["progress"]) if state else (1.0 if ready else 0.0),
            "error": state.get("error") if state else None,
            "ready": ready and mode != "direct",
            "video_codec": streams.video_codec,
            "audio_codec": streams.audio_codec,
            "pix_fmt": streams.pix_fmt,
            "width": streams.width,
            "height": streams.height,
            "audio_channels": streams.audio_channels,
            "detail": streams.describe(),
        }

    # ---------- state ----------

    def state(self, video_id: int) -> dict[str, Any] | None:
        with self._lock:
            state = self._states.get(video_id)
            return dict(state) if state else None

    def _set_state(self, video_id: int, **values: Any) -> None:
        with self._lock:
            current = dict(self._states.get(video_id) or {"video_id": video_id, "progress": 0.0})
            current.update(values)
            self._states[video_id] = current
            snapshot = dict(current)
        self.bus.publish_threadsafe("video.preview", snapshot)

    def clear_cache(self) -> dict[str, int]:
        removed_bytes = 0
        removed_files = 0
        for path in self._dir().glob("*"):
            if path.is_file():
                removed_bytes += path.stat().st_size
                path.unlink(missing_ok=True)
                removed_files += 1
        with self._lock:
            self._states.clear()
            self._info_cache.clear()
        return {"removed_bytes": removed_bytes, "removed_files": removed_files}

    # ---------- running ----------

    def start(self, video: dict[str, Any]) -> dict[str, Any]:
        info = self.plan(video)
        video_id = int(video["id"])
        if info["mode"] == "direct" or info["state"] == "ready":
            return info
        if info["state"] in {"preparing", "queued"}:
            return info
        with self._lock:
            thread = self._threads.get(video_id)
            if thread and thread.is_alive():
                return self.plan(video)
            self._states[video_id] = {
                "video_id": video_id,
                "state": "queued",
                "progress": 0.0,
                "error": None,
                "mode": info["mode"],
            }
            thread = threading.Thread(
                target=self._run,
                args=(dict(video), info["mode"]),
                name=f"preview-{video_id}",
                daemon=True,
            )
            self._threads[video_id] = thread
            thread.start()
        return self.plan(video)

    def _run(self, video: dict[str, Any], mode: str) -> None:
        video_id = int(video["id"])
        target = self._target(video, mode)
        tmp = target.with_suffix(".tmp.mp4")
        try:
            with self._semaphore:
                if self._stop.is_set():
                    return
                self._set_state(video_id, state="preparing", progress=0.0, error=None, mode=mode)
                target.parent.mkdir(parents=True, exist_ok=True)
                cmd = self._command(video, mode, tmp)
                log.info("Preview %s: %s", video_id, " ".join(cmd))
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                )
                with self._lock:
                    self._processes[video_id] = proc
                duration_us = max(1, int((video.get("duration_ms") or 0) * 1000))
                assert proc.stdout is not None
                for line in proc.stdout:
                    if self._stop.is_set():
                        proc.terminate()
                        break
                    if line.startswith("out_time_us="):
                        try:
                            progress = min(0.99, int(line.split("=", 1)[1].strip()) / duration_us)
                        except (ValueError, ZeroDivisionError):
                            continue
                        self._set_state(video_id, state="preparing", progress=round(progress, 3))
                stderr = (proc.stderr.read() if proc.stderr else "") or ""
                code = proc.wait()
                with self._lock:
                    self._processes.pop(video_id, None)
                if self._stop.is_set():
                    tmp.unlink(missing_ok=True)
                    return
                if code != 0:
                    tail = " ".join(stderr.strip().splitlines()[-3:])[:1500]
                    raise RuntimeError(f"ffmpeg exit {code}: {tail}")
                if not tmp.exists() or tmp.stat().st_size == 0:
                    raise RuntimeError("ffmpeg produced empty preview")
                os.replace(tmp, target)
                # чистим устаревшие превью этого видео (другой mtime/режим)
                for stale in target.parent.glob(f"{video_id}_*"):
                    if stale != target and stale.suffix in {".mp4", ".webm"}:
                        stale.unlink(missing_ok=True)
                self._set_state(video_id, state="ready", progress=1.0, error=None)
                log.info("Preview %s ready: %s", video_id, target)
        except Exception as exc:  # noqa: BLE001 - состояние должно сообщать ошибку
            tmp.unlink(missing_ok=True)
            log.warning("Preview %s failed: %s", video_id, exc)
            self._set_state(video_id, state="error", progress=0.0, error=str(exc)[:1500])

    def _command(self, video: dict[str, Any], mode: str, target: Path) -> list[str]:
        streams = self.streams(video)
        ffmpeg = self.config.ffmpeg
        base = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", video["path"]]
        maps = ["-map", "0:v:0", "-map", "0:a:0?"]
        audio = ["-c:a", "copy"]
        if not streams.audio_ok or mode == "transcode" or (streams.audio_channels or 0) > 2:
            audio = ["-c:a", "aac", "-b:a", "160k", "-ac", "2"]
        if mode == "remux":
            video_args = ["-c:v", "copy"]
        else:
            video_args = [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-profile:v",
                "high",
            ]
            if streams.height and streams.height > 720:
                video_args += ["-vf", "scale=-2:720"]
        return [
            *base,
            *maps,
            *video_args,
            *audio,
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
            str(target),
        ]

    def preview_file(self, video: dict[str, Any]) -> Path | None:
        mode = self.plan(video)["mode"]
        if mode == "direct":
            return None
        target = self._target(video, mode)
        return target if target.exists() and target.stat().st_size > 0 else None

    def stop(self) -> None:
        self._stop.set()
        with self._lock:
            procs = list(self._processes.values())
        for proc in procs:
            try:
                proc.terminate()
            except OSError:
                pass
        deadline = time.monotonic() + 3
        with self._lock:
            threads = list(self._threads.values())
        for thread in threads:
            remaining = max(0.0, deadline - time.monotonic())
            thread.join(timeout=remaining)


def free_space_mb(path: Path) -> int:
    total, _used, free = shutil.disk_usage(path)
    return int(free // (1024 * 1024))
