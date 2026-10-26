from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/api", tags=["events"])

HEARTBEAT_SECONDS = 15


@router.get("/events")
async def events(request: Request) -> StreamingResponse:
    bus = request.app.state.bus

    async def stream():
        async with bus.subscribe() as queue:
            hello = {
                "type": "hello",
                "ts": "",
                "payload": {"subscribers": bus.subscriber_count},
            }
            yield f"event: hello\ndata: {json.dumps(hello, ensure_ascii=False)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                yield (
                    f"event: {event['type']}\n"
                    f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                )

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Referrer-Policy": "no-referrer",
        },
    )
