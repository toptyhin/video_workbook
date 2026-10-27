"""M14: клиент llama.cpp (spawn ``llama-cli``, plans/14 D-14.2).

Один вызов = один дочерний процесс: инструкция через ``-sys``, данные через
``-p``, ``-st`` (single-turn) — процесс завершается сам. Structured-стадии
идут с ``-rea off`` и GBNF-грамматикой (``--grammar-file``); в pinned-сборке
``--json-schema`` падает, поэтому он не используется. Таймаут 180 с, kill при
отмене, reasoning (``<think>``) из ответа вырезается и не сохраняется.
"""
from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import threading
from pathlib import Path

from . import LLMCancelled, LLMError, LLMTimeout, is_repetitive, strip_thinking

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 180.0
CONTEXT_SIZE = 4096
DEFAULT_TEMP = 0.2
RETRY_TEMP = 0.1
TOP_P = "0.9"
REPEAT_PENALTY = "1.05"
MAX_OUTPUT_TOKENS = 512
MAX_STDERR_CHARS = 500
_STDOUT_CUT_MARKERS = ("\n\nExiting...", "\n[ Prompt:", "\n\n[ Prompt:")


class LlamaCliClient:
    """Синхронный клиент llama-cli; один экземпляр — один job генерации."""

    name = "llama-cli"

    def __init__(
        self,
        config,
        model_path: Path | str | None,
        *,
        threads: int | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        binary: str | Path | None = None,
    ) -> None:
        self.config = config
        self.model_path = Path(model_path) if model_path is not None else None
        self.binary = str(
            binary if binary is not None else getattr(config, "llama_cli", "llama-cli")
        )
        self.threads = int(
            threads if threads is not None else getattr(config, "summary_threads", 4)
        )
        self.timeout = float(timeout)
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._cancelled = threading.Event()

    # ---------- отмена ----------

    def cancel(self) -> None:
        """Kill текущего процесса; безопасно вызывать из любого потока."""
        self._cancelled.set()
        with self._lock:
            process = self._process
        self._terminate(process)

    # ---------- генерация ----------

    def generate(
        self,
        prompt: str,
        *,
        json_schema: dict | None = None,
        grammar: str | None = None,
        system: str | None = None,
        max_tokens: int = MAX_OUTPUT_TOKENS,
        thinking: bool = False,
    ) -> str:
        del json_schema, thinking  # JSON-схема не поддерживается pinned-сборкой
        if self._cancelled.is_set():
            raise LLMCancelled
        if self.model_path is None or not Path(self.model_path).is_file():
            raise LLMError("model_missing", "Файл модели не найден")
        max_tokens = max(16, min(4096, int(max_tokens)))
        grammar_path = self._write_grammar(grammar)
        try:
            raw = self._invoke(prompt, system, grammar_path, max_tokens, DEFAULT_TEMP)
            content = self._content(raw, prompt)
            if is_repetitive(content):
                log.warning(
                    "llama-cli output looks repetitive, retrying with lower temperature"
                )
                raw = self._invoke(prompt, system, grammar_path, max_tokens, RETRY_TEMP)
                content = self._content(raw, prompt)
                if is_repetitive(content):
                    raise LLMError("summary_repetition", "Модель зациклилась при генерации")
            if not content:
                raise LLMError("summary_failed", "Модель вернула пустой ответ")
            return content
        finally:
            if grammar_path is not None:
                grammar_path.unlink(missing_ok=True)

    # ---------- internals ----------

    def _build_args(
        self,
        prompt: str,
        system: str | None,
        grammar_path: Path | None,
        max_tokens: int,
        temperature: float,
    ) -> list[str]:
        args = [
            str(self.binary),
            "-m",
            str(self.model_path),
            "--jinja",
            "-c",
            str(CONTEXT_SIZE),
            "-t",
            str(self.threads),
            "--temp",
            f"{temperature:.2f}",
            "--top-p",
            TOP_P,
            "--repeat-penalty",
            REPEAT_PENALTY,
            "-n",
            str(max_tokens),
            "--no-display-prompt",
            "--log-disable",
            "-rea",
            "off",
            "-st",
        ]
        if system:
            args.extend(["-sys", system])
        args.extend(["-p", prompt])
        if grammar_path is not None:
            args.extend(["--grammar-file", str(grammar_path)])
        return args

    def _invoke(
        self,
        prompt: str,
        system: str | None,
        grammar_path: Path | None,
        max_tokens: int,
        temperature: float,
    ) -> str:
        raw, returncode, stderr = self._run_once(
            prompt, system, grammar_path, max_tokens, temperature
        )
        if returncode != 0 and grammar_path is not None:
            # грамматика несовместима/не распарсилась — деградируем до prompt-only,
            # невалидный JSON дальше исправит repair/fallback пайплайна.
            log.warning("llama-cli grammar failed, retrying without grammar")
            raw, returncode, stderr = self._run_once(
                prompt, system, None, max_tokens, temperature
            )
        if returncode != 0:
            lines = (stderr or "").strip().splitlines()
            tail = lines[-1][:MAX_STDERR_CHARS] if lines else "код возврата"
            raise LLMError("summary_failed", f"llama-cli завершился с ошибкой: {tail}")
        return raw

    def _run_once(
        self,
        prompt: str,
        system: str | None,
        grammar_path: Path | None,
        max_tokens: int,
        temperature: float,
    ) -> tuple[str, int, str]:
        args = self._build_args(prompt, system, grammar_path, max_tokens, temperature)
        try:
            process = subprocess.Popen(
                args,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except FileNotFoundError as exc:
            raise LLMError("llama_cli_missing", f"llama-cli не найден: {self.binary}") from exc
        except OSError as exc:  # pragma: no cover - права/битый бинарь
            raise LLMError(
                "llama_cli_missing", f"Не удалось запустить llama-cli: {exc}"
            ) from exc
        with self._lock:
            self._process = process
        try:
            try:
                stdout, stderr = process.communicate(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                self._terminate(process)
                try:
                    stdout, stderr = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:  # pragma: no cover - ядро не убило
                    stdout, stderr = "", ""
                raise LLMTimeout(f"Модель не ответила за {int(self.timeout)} с") from None
        finally:
            with self._lock:
                self._process = None
        if self._cancelled.is_set():
            raise LLMCancelled
        return stdout or "", int(process.returncode or 0), stderr or ""

    @staticmethod
    def _content(raw: str, prompt: str) -> str:
        """Отрезает баннер/эхо prompt интерфейса llama-cli, оставляя ответ."""
        text = raw
        needle = (prompt or "").strip()
        if needle:
            index = text.rfind(needle)
            if index >= 0:
                text = text[index + len(needle) :]
        for marker in _STDOUT_CUT_MARKERS:
            index = text.find(marker)
            if index >= 0:
                text = text[:index]
        return strip_thinking(text)

    def _terminate(self, process: subprocess.Popen[str] | None) -> None:
        if process is not None and process.poll() is None:
            try:
                process.kill()
            except OSError:  # pragma: no cover
                pass

    def _write_grammar(self, grammar: str | None) -> Path | None:
        if not grammar:
            return None
        tmp_dir = getattr(self.config, "tmp_dir", None)
        if tmp_dir is not None:
            try:
                Path(tmp_dir).mkdir(parents=True, exist_ok=True)
            except OSError:  # pragma: no cover - read-only data dir
                tmp_dir = None
        try:
            handle, name = tempfile.mkstemp(
                prefix="summary-grammar-",
                suffix=".gbnf",
                dir=str(tmp_dir) if tmp_dir is not None else None,
            )
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                stream.write(grammar)
        except OSError:
            # read-only tmp/data dir — деградируем на prompt-only + repair/fallback
            log.warning("Cannot write grammar file, falling back to prompt-only")
            return None
        return Path(name)


__all__ = ["DEFAULT_TIMEOUT", "LlamaCliClient"]
