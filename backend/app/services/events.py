"""Шина SSE-событий (A5)."""
from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

log = logging.getLogger(__name__)


class EventBus:
    def __init__(self, max_queue: int = 256) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._max_queue = max_queue
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    @contextlib.asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[dict[str, Any]]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._max_queue)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    def publish_threadsafe(self, event_type: str, payload: dict[str, Any]) -> None:
        """Публикация из фонового потока/процесса."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self.publish, event_type, payload)

    def publish(self, event_type: str, payload: dict[str, Any]) -> None:
        event = {
            "type": event_type,
            "ts": datetime.now(UTC).isoformat(timespec="seconds"),
            "payload": payload,
        }
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                log.warning("SSE subscriber queue full, dropping event %s", event_type)
