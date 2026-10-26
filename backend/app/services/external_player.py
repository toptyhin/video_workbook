"""Внешний плеер: запуск mpv/VLC/системного и синхронизация по mpv IPC (V3).

mpv общается по UNIX-сокету JSON-строками (command/observe_property/property-change).
Для VLC и системного плеера доступен только запуск (sync=False).
"""
from __future__ import annotations

import json
import logging
import os
import shlex
import shutil
import socket
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from ..config import Config
from .events import EventBus

log = logging.getLogger(__name__)

PLAYER_IDS = ("mpv", "vlc", "system")
PLAYER_LABELS = {"mpv": "mpv", "vlc": "VLC", "system": "Системный плеер"}
OBSERVE_PROPS = ("time-pos", "duration", "pause", "volume", "idle-active")


class ExternalPlayerError(ValueError):
    def __init__(self, code: str, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code


def _which_system() -> str | None:
    return shutil.which("xdg-open")


def resolve_player_path(player: str, path_override: str | None = None) -> str | None:
    if path_override:
        candidate = Path(path_override).expanduser()
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
        return None
    if player == "mpv":
        return shutil.which("mpv")
    if player == "vlc":
        return shutil.which("vlc") or shutil.which("cvlc")
    return _which_system()


def players_info(settings: dict[str, Any]) -> list[dict[str, Any]]:
    configured = str(settings.get("external.player") or "mpv")
    override = str(settings.get("external.player_path") or "").strip()
    items = []
    for player in PLAYER_IDS:
        path = resolve_player_path(player, override if configured == player else "")
        items.append(
            {
                "id": player,
                "label": PLAYER_LABELS[player],
                "path": path,
                "available": path is not None,
                "sync": player == "mpv" and path is not None,
            }
        )
    return items


class ExternalPlayerManager:
    def __init__(self, config: Config, bus: EventBus) -> None:
        self.config = config
        self.bus = bus
        self._lock = threading.RLock()
        self._session: dict[str, Any] | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._sock: socket.socket | None = None
        self._reader: threading.Thread | None = None
        self._watcher: threading.Thread | None = None
        self._stop_reader = threading.Event()
        self._ipc_ready = threading.Event()
        self._files: list[Path] = []

    # ---------- public ----------

    def players(self, settings: dict[str, Any]) -> dict[str, Any]:
        return {
            "items": players_info(settings),
            "configured": str(settings.get("external.player") or "mpv"),
            "policy": str(settings.get("external.policy") or "ask"),
            "pass_marks": bool(settings.get("external.pass_marks", True)),
        }

    def status(self) -> dict[str, Any]:
        with self._lock:
            if self._session is None:
                return {"active": False, "session": None}
            return {"active": True, "session": dict(self._session)}

    def launch(
        self,
        *,
        video: dict[str, Any],
        start_ms: int = 0,
        player: str = "mpv",
        pass_marks: bool = True,
        marks: list[dict[str, Any]] | None = None,
        player_path: str | None = None,
        extra_args: list[str] | None = None,
    ) -> dict[str, Any]:
        if player not in PLAYER_IDS:
            raise ExternalPlayerError("invalid_player", f"Неизвестный плеер: {player}")
        path = resolve_player_path(player, player_path)
        if path is None:
            raise ExternalPlayerError(
                "player_unavailable",
                f"Плеер {PLAYER_LABELS[player]} не найден в системе",
                409,
            )
        source = Path(str(video["path"]))
        if not source.exists():
            raise ExternalPlayerError("file_missing", "Файл не найден на диске", 404)

        self.stop()
        with self._lock:
            session_id = uuid.uuid4().hex
            chapters_path, subs_path = (None, None)
            if pass_marks and marks:
                chapters_path, subs_path = self._write_marks(video_id=int(video["id"]), marks=marks)
            socket_path = None
            sync = player == "mpv" and path.endswith("mpv")
            if sync:
                socket_path = self._socket_path()
            env_args = os.environ.get("VL_MPV_EXTRA_ARGS", "").strip()
            combined_extra = list(extra_args or [])
            if env_args:
                combined_extra.extend(shlex.split(env_args))
            args = self._build_args(
                player=player,
                path=path,
                source=source,
                start_ms=start_ms,
                socket_path=socket_path,
                chapters_path=chapters_path,
                subs_path=subs_path,
                extra_args=combined_extra or None,
            )
            log.info("External player %s: %s", player, " ".join(args))
            try:
                process = subprocess.Popen(
                    args,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except OSError as exc:
                self._cleanup_files()
                raise ExternalPlayerError("launch_failed", str(exc), 500) from exc
            self._process = process
            self._stop_reader.clear()
            self._session = {
                "session_id": session_id,
                "player": player,
                "player_label": PLAYER_LABELS[player],
                "sync": bool(sync),
                "video_id": int(video["id"]),
                "title": video.get("title"),
                "start_ms": int(start_ms),
                "position_ms": int(start_ms),
                "duration_ms": int(video.get("duration_ms") or 0),
                "paused": False,
                "volume": 100.0,
                "active": True,
                "ended": False,
                "chapters": chapters_path is not None,
                "subtitles": subs_path is not None,
            }
            snapshot = dict(self._session)
        if sync and socket_path is not None:
            self._ipc_ready.clear()
            self._reader = threading.Thread(
                target=self._reader_loop,
                args=(socket_path, session_id),
                name="external-mpv-reader",
                daemon=True,
            )
            self._reader.start()
            if not self._ipc_ready.wait(timeout=4.0):
                log.warning("mpv IPC did not connect in time, sync disabled")
                with self._lock:
                    if self._session and self._session["session_id"] == session_id:
                        self._session["sync"] = False
        else:
            with self._lock:
                if self._session is not None:
                    self._session["sync"] = False
        self._watcher = threading.Thread(
            target=self._watch_process,
            args=(session_id, process),
            name="external-process-watcher",
            daemon=True,
        )
        self._watcher.start()
        self.bus.publish_threadsafe("external.state", {"state": "launched", "session": snapshot})
        return {"active": True, "session": snapshot}

    def command(self, action: str, value: Any = None) -> dict[str, Any]:
        with self._lock:
            session = self._session
            if session is None:
                raise ExternalPlayerError("not_running", "Внешний плеер не запущен", 409)
            if not session.get("sync"):
                raise ExternalPlayerError(
                    "sync_unavailable",
                    "Синхронизация доступна только для mpv",
                    409,
                )
            player = session["player"]
        if player != "mpv":
            raise ExternalPlayerError("sync_unavailable", "Синхронизация недоступна", 409)
        if action == "seek":
            try:
                ms = int(value)
            except (TypeError, ValueError) as exc:
                raise ExternalPlayerError("invalid_value", "seek: ожидается миллисекунды") from exc
            self._send({"command": ["seek", max(0.0, ms / 1000), "absolute+exact"]})
            with self._lock:
                if self._session is not None:
                    self._session["position_ms"] = max(0, ms)
        elif action in {"play", "pause"}:
            self._send({"command": ["set_property", "pause", action == "pause"]})
            with self._lock:
                if self._session is not None:
                    self._session["paused"] = action == "pause"
        elif action == "toggle":
            self._send({"command": ["cycle", "pause"]})
        elif action == "volume":
            try:
                volume = max(0.0, min(100.0, float(value)))
            except (TypeError, ValueError) as exc:
                raise ExternalPlayerError("invalid_value", "volume: ожидается 0..100") from exc
            self._send({"command": ["set_property", "volume", volume]})
        elif action == "stop":
            self.stop()
        else:
            raise ExternalPlayerError("invalid_action", f"Неизвестное действие: {action}")
        return self.status()

    def stop(self) -> None:
        self._stop_reader.set()
        self._ipc_ready.clear()
        with self._lock:
            session = self._session
            process = self._process
            sock = self._sock
            self._sock = None
        if session is not None and session.get("sync") and sock is not None:
            try:
                sock.sendall(b'{"command":["quit"]}\n')
            except OSError:
                pass
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
        with self._lock:
            sock = self._sock
            self._sock = None
            self._process = None
            was_active = self._session is not None
            self._session = None
        for candidate in (sock,):
            if candidate is not None:
                try:
                    candidate.close()
                except OSError:
                    pass
        self._cleanup_files()
        if was_active:
            self.bus.publish_threadsafe("external.state", {"state": "stopped", "session": None})

    # ---------- internals ----------

    def _socket_path(self) -> Path:
        directory = self.config.tmp_dir / "external"
        directory.mkdir(parents=True, exist_ok=True)
        return directory / f"mpv-{uuid.uuid4().hex[:12]}.sock"

    def _write_marks(self, video_id: int, marks: list[dict[str, Any]]) -> tuple[Path | None, Path | None]:
        directory = self.config.tmp_dir / "external"
        directory.mkdir(parents=True, exist_ok=True)
        chapters = directory / f"{video_id}-chapters.txt"
        subtitles = directory / f"{video_id}-marks.ass"
        chapter_lines: list[str] = []
        ass_lines = [
            "[Script Info]",
            "ScriptType: v4.00+",
            "PlayResX: 1920",
            "PlayResY: 1080",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
            "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
            "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
            "Style: Mark,Arial,42,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,"
            "1,2,0,2,40,40,60,1",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        ]
        for index, mark in enumerate(sorted(marks, key=lambda item: item["start_ms"]), start=1):
            start = max(0, int(mark["start_ms"]))
            end = max(start + 300, int(mark["end_ms"]))
            label = str(mark.get("label") or f"Метка {index}")
            chapter_lines.append(f"CHAPTER{index:02d}={_chapter_time(start)}")
            chapter_lines.append(f"CHAPTER{index:02d}NAME={label}")
            color = _ass_color(str(mark.get("color") or "#3b82f6"))
            tags = mark.get("tags") or []
            suffix = f" · {', '.join(tags)}" if tags else ""
            text = _ass_escape(f"🏷 {label}{suffix}")
            ass_lines.append(
                f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Mark,,0,0,0,,"
                f"{{\\c&H{color}&}}{text}"
            )
        chapters.write_text("\n".join(chapter_lines) + "\n", encoding="utf-8")
        subtitles.write_text("\n".join(ass_lines) + "\n", encoding="utf-8")
        with self._lock:
            self._files = [chapters, subtitles]
        return chapters, subtitles

    def _build_args(
        self,
        *,
        player: str,
        path: str,
        source: Path,
        start_ms: int,
        socket_path: Path | None,
        chapters_path: Path | None,
        subs_path: Path | None,
        extra_args: list[str] | None,
    ) -> list[str]:
        start_seconds = max(0.0, start_ms / 1000)
        if player == "mpv":
            args = [
                path,
                "--no-config",
                "--load-scripts=no",
                "--ytdl=no",
                "--no-terminal",
                "--really-quiet",
                "--keep-open=no",
                "--force-window=yes",
            ]
            if socket_path is not None:
                args.append(f"--input-ipc-server={socket_path}")
            if start_seconds > 0:
                args.append(f"--start={start_seconds:.3f}")
            if chapters_path is not None:
                args.append(f"--chapters-file={chapters_path}")
            if subs_path is not None:
                args.append(f"--sub-file={subs_path}")
        elif player == "vlc":
            args = [path, "--no-video-title-show", "--quiet"]
            if start_seconds > 0:
                args.append(f"--start-time={start_seconds:.3f}")
            if subs_path is not None:
                args.append(f"--sub-file={subs_path}")
        else:
            args = [path]
        if extra_args:
            args.extend(extra_args)
        args.append(str(source))
        return args

    def _send(self, payload: dict[str, Any]) -> None:
        with self._lock:
            sock = self._sock
        if sock is None:
            raise ExternalPlayerError("sync_unavailable", "Нет соединения с mpv", 409)
        try:
            sock.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        except OSError as exc:
            raise ExternalPlayerError("sync_lost", f"Связь с mpv потеряна: {exc}", 409) from exc

    def _reader_loop(self, socket_path: Path, session_id: str) -> None:
        deadline = time.monotonic() + 5.0
        sock: socket.socket | None = None
        while time.monotonic() < deadline and not self._stop_reader.is_set():
            candidate = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                candidate.connect(str(socket_path))
                sock = candidate
                break
            except OSError:
                candidate.close()
                time.sleep(0.1)
        if sock is None:
            with self._lock:
                if self._session and self._session["session_id"] == session_id:
                    self._session["sync"] = False
            log.warning("mpv IPC socket not available, sync disabled")
            return
        sock.settimeout(0.5)
        with self._lock:
            if self._session is None or self._session["session_id"] != session_id:
                sock.close()
                return
            self._sock = sock
        self._ipc_ready.set()
        for index, prop in enumerate(OBSERVE_PROPS, start=1):
            try:
                sock.sendall(
                    (json.dumps({"command": ["observe_property", index, prop]}) + "\n").encode()
                )
            except OSError:
                break
        buffer = b""
        while not self._stop_reader.is_set():
            try:
                chunk = sock.recv(65536)
            except TimeoutError:
                continue
            except OSError:
                break
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    event = json.loads(line.decode("utf-8", "replace"))
                except json.JSONDecodeError:
                    continue
                self._handle_event(event, session_id)
        try:
            sock.close()
        except OSError:
            pass
        with self._lock:
            if self._sock is sock:
                self._sock = None
            if self._session and self._session["session_id"] == session_id:
                self._session["paused"] = True
                self._session["ended"] = True
        self.bus.publish_threadsafe(
            "external.state", {"state": "ended", "session": {"session_id": session_id}}
        )

    def _handle_event(self, event: dict[str, Any], session_id: str) -> None:
        if event.get("event") != "property-change":
            return
        name = event.get("name")
        value = event.get("data")
        snapshot: dict[str, Any] | None = None
        with self._lock:
            session = self._session
            if session is None or session["session_id"] != session_id:
                return
            if name == "time-pos" and isinstance(value, (int, float)):
                session["position_ms"] = max(0, int(value * 1000))
            elif name == "duration" and isinstance(value, (int, float)):
                session["duration_ms"] = max(0, int(value * 1000))
            elif name == "volume" and isinstance(value, (int, float)):
                session["volume"] = float(value)
            elif name == "pause" and isinstance(value, bool):
                if session["paused"] != value:
                    session["paused"] = value
                    snapshot = {"session_id": session_id, "paused": value}
            elif name == "idle-active" and value is True:
                session["ended"] = True
        if snapshot is not None:
            self.bus.publish_threadsafe("external.state", {"state": "paused", "session": snapshot})

    def _watch_process(self, session_id: str, process: subprocess.Popen[bytes]) -> None:
        process.wait()
        with self._lock:
            if self._session is None or self._session["session_id"] != session_id:
                return
            self._session = None
            self._process = None
        self._cleanup_files()
        self.bus.publish_threadsafe(
            "external.state", {"state": "stopped", "session": {"session_id": session_id}}
        )

    def _cleanup_files(self) -> None:
        with self._lock:
            files = list(self._files)
            self._files = []
        for path in files:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass


def _chapter_time(ms: int) -> str:
    seconds, millis = divmod(max(0, ms), 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def _ass_time(ms: int) -> str:
    centiseconds = max(0, ms) // 10
    seconds, centis = divmod(centiseconds, 100)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{centis:02d}"


def _ass_color(hex_color: str) -> str:
    value = hex_color.lstrip("#")
    if len(value) != 6:
        return "00F6A23B"
    red, green, blue = value[0:2], value[2:4], value[4:6]
    return f"00{blue}{green}{red}".upper()


def _ass_escape(text: str) -> str:
    return text.replace("{", "(").replace("}", ")").replace("\n", " ")
