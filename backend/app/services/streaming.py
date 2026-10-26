"""Range-стриминг видеофайлов (M5)."""
from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

CHUNK = 64 * 1024
_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class RangeNotSatisfiable(ValueError):
    def __init__(self, size: int) -> None:
        super().__init__(f"range not satisfiable for size {size}")
        self.size = size


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    if not header:
        return None
    match = _RANGE_RE.fullmatch(header.strip())
    if not match or (not match.group(1) and not match.group(2)):
        raise RangeNotSatisfiable(size)
    if not match.group(1):
        length = int(match.group(2))
        if length <= 0:
            raise RangeNotSatisfiable(size)
        start = max(0, size - length)
        end = size - 1
    else:
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else size - 1
    if start >= size or start > end:
        raise RangeNotSatisfiable(size)
    return start, min(end, size - 1)


def iter_file(path: Path, start: int, end: int) -> Iterator[bytes]:
    remaining = end - start + 1
    with path.open("rb") as handle:
        handle.seek(start)
        while remaining > 0:
            chunk = handle.read(min(CHUNK, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk
