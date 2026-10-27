"""Системный звук (PulseAudio/PipeWire monitor) через ffmpeg/parec (M11).

Захват доступен только на Linux с PulseAudio/PipeWire. Маршруты (по приоритету):

1. ``pulse`` — ffmpeg со входным устройством ``pulse`` (системный ffmpeg с libpulse);
2. ``parec`` — ``parec`` (pulseaudio-utils) пишет PCM в pipe, встроенный ffmpeg
   кодирует в Ogg/Opus. Нужен потому, что поставляемая статическая сборка ffmpeg
   (johnvansickle) не содержит демuxера ``pulse``;

Иначе — ``available=false`` с пояснением про пакеты. Источник — monitor приёмника
по умолчанию. Ogg/Opus смешивается с дорожкой микрофона при финализации записи.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from ..config import Config

log = logging.getLogger(__name__)

PACTL_TIMEOUT = 5
START_TIMEOUT = 2.0
START_GRACE = 0.5
STOP_TIMEOUT = 3.0
READER_JOIN_TIMEOUT = 2.0
AUDIO_BITRATE = "128k"
SAMPLE_RATE = 48000
CHANNELS = 2
ROUTE_PULSE = "pulse"
ROUTE_PAREC = "parec"
PULSE_DEVICE_RE = re.compile(r"(?m)^\s*D[.E]?\s+pulse\b")


@dataclass(frozen=True)
class Availability:
    available: bool
    detail: str | None = None
    monitor: str | None = None
    route: str | None = None
    ffmpeg: str | None = None
    parec: str | None = None


def _run_pactl(args: list[str]) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=PACTL_TIMEOUT, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None


@lru_cache(maxsize=8)
def _supports_pulse(ffmpeg: str) -> bool:
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-devices"],
            capture_output=True,
            text=True,
            timeout=PACTL_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    output = (proc.stdout or "") + (proc.stderr or "")
    return PULSE_DEVICE_RE.search(output) is not None


@lru_cache(maxsize=8)
def _supports_encoder(ffmpeg: str, encoder: str = "libopus") -> bool:
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=PACTL_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    for line in ((proc.stdout or "") + (proc.stderr or "")).splitlines():
        if encoder in line.split():
            return True
    return False


def resolve_ffmpeg(config: Config) -> str | None:
    """ffmpeg с входным устройством pulse (системный предпочтительнее встроенного)."""
    candidates: list[str] = []
    system = shutil.which("ffmpeg")
    if system:
        candidates.append(system)
    if config.ffmpeg not in candidates:
        candidates.append(config.ffmpeg)
    for candidate in candidates:
        if _supports_pulse(candidate):
            return candidate
    return None


def _default_sink() -> str:
    pactl = shutil.which("pactl")
    if not pactl:  # pragma: no cover - вызывается только после проверки
        return ""
    sink = ""
    proc = _run_pactl([pactl, "get-default-sink"])
    if proc is not None and proc.returncode == 0:
        lines = (proc.stdout or "").strip().splitlines()
        sink = lines[0].strip() if lines else ""
    if not sink:
        proc = _run_pactl([pactl, "list", "short", "sinks"])
        if proc is not None and proc.returncode == 0:
            for line in (proc.stdout or "").splitlines():
                parts = line.split()
                if len(parts) >= 2:
                    sink = parts[1]
                    break
    return sink


def _route_missing_detail(parec_present: bool) -> str:
    if parec_present:
        return (
            "Системный звук: ffmpeg без поддержки PulseAudio/libopus; "
            "нужен parec (пакет pulseaudio-utils) и ffmpeg с libopus"
        )
    return (
        "Системный звук: не найдены parec (пакет pulseaudio-utils) и "
        "ffmpeg с поддержкой PulseAudio"
    )


def detect(config: Config | None = None) -> Availability:
    """Проверяет доступность системного звука и выбирает маршрут захвата."""
    if not sys.platform.startswith("linux"):
        return Availability(
            available=False,
            detail="Системный звук доступен только на Linux (PulseAudio/PipeWire)",
        )
    pactl = shutil.which("pactl")
    if not pactl:
        return Availability(
            available=False,
            detail="Утилита pactl не найдена (нужен PulseAudio/PipeWire)",
        )
    sink = _default_sink()
    if not sink:
        return Availability(
            available=False,
            detail="PulseAudio: приёмник (sink) по умолчанию не найден",
        )
    monitor = f"{sink}.monitor"
    if config is None:  # для диагностики достаточно pactl + sink
        return Availability(available=True, monitor=monitor)
    pulse_ffmpeg = resolve_ffmpeg(config)
    if pulse_ffmpeg is not None:
        return Availability(
            available=True,
            monitor=monitor,
            route=ROUTE_PULSE,
            ffmpeg=pulse_ffmpeg,
        )
    parec = shutil.which("parec")
    if parec is not None and _supports_encoder(config.ffmpeg, "libopus"):
        return Availability(
            available=True,
            monitor=monitor,
            route=ROUTE_PAREC,
            ffmpeg=config.ffmpeg,
            parec=parec,
        )
    return Availability(
        available=False,
        detail=_route_missing_detail(parec is not None),
    )


def capabilities(config: Config | None = None) -> dict[str, Any]:
    info = detect(config)
    return {"available": info.available, "detail": info.detail}


def _close_pipes(process: subprocess.Popen[bytes]) -> None:
    for stream in (process.stdin, process.stdout, process.stderr):
        if stream is not None:
            try:
                stream.close()
            except OSError:
                pass


def _continue_process(process: subprocess.Popen[bytes] | None) -> None:
    """Снимает SIGSTOP перед остановкой (сигнал не доставляется стоящему процессу)."""
    if process is None or process.poll() is not None or not hasattr(signal, "SIGCONT"):
        return
    try:
        os.kill(process.pid, signal.SIGCONT)
    except OSError:
        pass


def _terminate(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=STOP_TIMEOUT)
    except (subprocess.TimeoutExpired, OSError):
        try:
            process.kill()
            process.wait(timeout=STOP_TIMEOUT)
        except (subprocess.TimeoutExpired, OSError):
            pass


class SystemAudioCapture:
    """Потокобезопасный захват monitor-источника в Ogg/Opus (pulse или parec)."""

    def __init__(self, config: Config, session_id: str) -> None:
        self.config = config
        self.session_id = session_id
        self._output = config.recording_tmp_dir / f"{session_id}.audio.ogg"
        self._lock = threading.RLock()
        self._parec: subprocess.Popen[bytes] | None = None
        self._encoder: subprocess.Popen[bytes] | None = None
        self._route: str | None = None
        self._active = False
        self._paused = False
        self._detail: str | None = None
        self._stderr_lines: list[str] = []
        self._stderr_thread: threading.Thread | None = None

    # ---------- public ----------

    @property
    def output(self) -> Path:
        return self._output

    @property
    def active(self) -> bool:
        with self._lock:
            return self._active

    @property
    def detail(self) -> str | None:
        with self._lock:
            return self._detail

    @property
    def route(self) -> str | None:
        with self._lock:
            return self._route

    def start(self) -> dict[str, Any]:
        with self._lock:
            if self._encoder is not None or self._parec is not None:
                return {"active": self._active, "detail": self._detail}
        info = detect(self.config)
        if not info.available or not info.monitor or not info.ffmpeg or not info.route:
            detail = info.detail or "Системный звук недоступен"
            with self._lock:
                self._detail = detail
            return {"active": False, "detail": detail}
        self.config.recording_tmp_dir.mkdir(parents=True, exist_ok=True)
        self._output.unlink(missing_ok=True)
        # Маршрут нужен _teardown() ещё до успешного старта: при сбое
        # parec-маршрута иначе останется висеть процесс parec.
        with self._lock:
            self._route = info.route
        if info.route == ROUTE_PAREC:
            failure = self._start_parec(info)
        else:
            failure = self._start_pulse(info)
        if failure is not None:
            self._teardown(graceful=False)
            self._output.unlink(missing_ok=True)
            with self._lock:
                self._route = None
                self._active = False
                self._detail = failure
            log.warning("System audio capture failed: %s", failure)
            return {"active": False, "detail": failure}
        with self._lock:
            self._route = info.route
            self._active = True
            self._paused = False
            self._detail = None
        with _registry_lock:
            _registry.add(self)
        log.info("System audio capture started (%s): %s", info.route, info.monitor)
        return {"active": True, "detail": None}

    def pause(self) -> None:
        with self._lock:
            target = self._parec if self._route == ROUTE_PAREC else self._encoder
            if target is None or target.poll() is not None or self._paused:
                return
            if not hasattr(signal, "SIGSTOP"):  # pragma: no cover - не-POSIX
                return
            try:
                os.kill(target.pid, signal.SIGSTOP)
            except OSError as exc:
                log.warning("System audio pause failed: %s", exc)
                return
            self._paused = True

    def resume(self) -> None:
        with self._lock:
            target = self._parec if self._route == ROUTE_PAREC else self._encoder
            if target is None or target.poll() is not None or not self._paused:
                return
            _continue_process(target)
            self._paused = False

    def stop(self) -> Path | None:
        """Останавливает захват; возвращает непустой Ogg/Opus или None."""
        with self._lock:
            was_paused = self._paused
            self._paused = False
        if was_paused:
            # снимаем SIGSTOP, иначе terminate/q не доставятся дочернему процессу
            with self._lock:
                target = self._parec if self._route == ROUTE_PAREC else self._encoder
            _continue_process(target)
        self._teardown(graceful=True)
        output = self._output
        if output.exists() and output.stat().st_size > 0:
            return output
        return None

    # ---------- start routes ----------

    def _start_pulse(self, info: Availability) -> str | None:
        command = [
            str(info.ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            # stdin открыт: остановка — 'q' для корректного финала Ogg
            "-f",
            "pulse",
            "-i",
            str(info.monitor),
            "-c:a",
            "libopus",
            "-b:a",
            AUDIO_BITRATE,
            "-f",
            "ogg",
            str(self._output),
        ]
        try:
            encoder = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except OSError as exc:
            return f"Не удалось запустить ffmpeg: {exc}"
        self._encoder = encoder
        self._start_stderr_reader(encoder)
        return self._wait_ready([encoder])

    def _start_parec(self, info: Availability) -> str | None:
        parec_command = [
            str(info.parec),
            "--format=s16le",
            f"--rate={SAMPLE_RATE}",
            f"--channels={CHANNELS}",
            f"--device={info.monitor}",
        ]
        try:
            parec = subprocess.Popen(
                parec_command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except OSError as exc:
            return f"Не удалось запустить parec: {exc}"
        encoder_command = [
            str(info.ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "s16le",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            str(CHANNELS),
            "-i",
            "pipe:0",
            "-c:a",
            "libopus",
            "-b:a",
            AUDIO_BITRATE,
            "-f",
            "ogg",
            str(self._output),
        ]
        try:
            encoder = subprocess.Popen(
                encoder_command,
                stdin=parec.stdout,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except OSError as exc:
            _terminate(parec)
            _close_pipes(parec)
            return f"Не удалось запустить ffmpeg: {exc}"
        # родительская копия read-end не нужна: EOF придёт, когда parec завершится
        if parec.stdout is not None:
            try:
                parec.stdout.close()
            except OSError:  # pragma: no cover
                pass
        self._parec = parec
        self._encoder = encoder
        self._start_stderr_reader(encoder)
        return self._wait_ready([parec, encoder])

    # ---------- readiness / stop ----------

    def _start_stderr_reader(self, process: subprocess.Popen[bytes]) -> None:
        def drain() -> None:
            stream = process.stderr
            if stream is None:
                return
            try:
                for raw in iter(stream.readline, b""):
                    line = raw.decode("utf-8", "replace").strip()
                    if not line:
                        continue
                    with self._lock:
                        self._stderr_lines = (self._stderr_lines + [line])[-20:]
            except (OSError, ValueError):  # pragma: no cover - закрытие pipe
                pass
            finally:
                try:
                    stream.close()
                except OSError:  # pragma: no cover
                    pass

        thread = threading.Thread(target=drain, name="system-audio-stderr", daemon=True)
        self._stderr_thread = thread
        thread.start()

    def _stderr_detail(self) -> str | None:
        with self._lock:
            return self._stderr_lines[-1] if self._stderr_lines else None

    def _wait_ready(self, processes: list[subprocess.Popen[bytes]]) -> str | None:
        started = time.monotonic()
        while time.monotonic() - started < START_TIMEOUT:
            for process in processes:
                if process.poll() is not None:
                    return self._stderr_detail() or (
                        f"Процесс завершился при старте (код {process.returncode})"
                    )
            if self._output.exists() and self._output.stat().st_size > 0:
                return None
            if time.monotonic() - started >= START_GRACE:
                # ffmpeg буферизует Ogg до финализации: живые процессы без stderr-ошибок
                # за время grace — успешный старт (файл проверяется при стопе).
                return self._stderr_detail()
            time.sleep(0.02)
        return self._stderr_detail()

    def _teardown(self, *, graceful: bool) -> None:
        with self._lock:
            route = self._route
            parec, encoder = self._parec, self._encoder
            self._parec = None
            self._encoder = None
            self._route = None
            self._active = False
        with _registry_lock:
            _registry.discard(self)
        if route == ROUTE_PAREC and parec is not None:
            # SIGTERM parec -> EOF в pipe -> ffmpeg дописывает Ogg-трейлер
            _terminate(parec)
            if encoder is not None:
                try:
                    if encoder.poll() is None:
                        encoder.wait(timeout=STOP_TIMEOUT * 2)
                except (subprocess.TimeoutExpired, OSError):
                    _terminate(encoder)
                _close_pipes(encoder)
            _close_pipes(parec)
        elif encoder is not None:
            if graceful:
                self._graceful_encoder_stop(encoder)
            else:
                _terminate(encoder)
                _close_pipes(encoder)
        thread = self._stderr_thread
        self._stderr_thread = None
        if thread is not None:
            thread.join(timeout=READER_JOIN_TIMEOUT)

    @staticmethod
    def _graceful_encoder_stop(encoder: subprocess.Popen[bytes]) -> None:
        if encoder.poll() is None and encoder.stdin is not None:
            try:
                encoder.stdin.write(b"q")
                encoder.stdin.flush()
            except (OSError, ValueError):
                pass
        try:
            encoder.wait(timeout=STOP_TIMEOUT)
        except (subprocess.TimeoutExpired, OSError):
            _terminate(encoder)
        _close_pipes(encoder)


_registry: set[SystemAudioCapture] = set()
_registry_lock = threading.Lock()


def stop_all() -> None:
    """Останавливает все активные захваты (завершение backend)."""
    with _registry_lock:
        captures = list(_registry)
        _registry.clear()
    for capture in captures:
        try:
            capture.stop()
        except Exception:  # pragma: no cover - защита при завершении
            log.exception("Failed to stop system audio capture")
