from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
from collections import deque
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from collector import LogCollector, discover_jsonl_files
from graph import GraphBuilder

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    args = parse_args()
    settings.update(resource_window=args.window, stale_after=args.stale, idle_after=args.idle, tool_ttl=args.tool_ttl)
    dirs = resolve_data_dirs(args.data or [".codex", ".omp"])
    collector.set_paths(discover_jsonl_files(dirs))
    collector.scan(initial=True)
    builder.apply(collector.drain())
    task = asyncio.create_task(poll(dirs))
    background_tasks.add(task)  # без ссылки задачу может собрать GC
    task.add_done_callback(background_tasks.discard)
    try:
        yield
    finally:
        task.cancel()


ROOT = Path(__file__).resolve().parent
app = FastAPI(lifespan=lifespan)
collector = LogCollector([])
builder = GraphBuilder()
connections: set[WebSocket] = set()
background_tasks: set[asyncio.Task] = set()
log = logging.getLogger("agent_atlas")

# События моложе LIVE_WINDOW секунд фронт может анимировать; более старые — история
# (например, новый файл журнала, прочитанный с нуля), её анимировать нельзя.
LIVE_WINDOW = 10.0
# Кольцевой буфер для повторной доставки после reconnect (клиент шлёт {"type":"resume","since":N}).
recent_events: deque[dict] = deque(maxlen=2000)
settings = {"resource_window": 0.0, "stale_after": 60.0, "idle_after": 300.0, "tool_ttl": 20.0}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Agent Atlas")
    parser.add_argument("--data", action="append", default=[], help="Папка данных агента: .codex, .omp и т. п.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=41735)
    parser.add_argument("--window", type=float, default=0, help="0 — показывать все узлы; больше 0 — только ресурсы за N секунд")
    parser.add_argument("--stale", type=float, default=60)
    parser.add_argument("--idle", type=float, default=60, help="Секунды после idle до статуса sleeping")
    parser.add_argument("--tool-ttl", type=float, default=20, dest="tool_ttl",
                        help="Сколько секунд инструмент остаётся на сцене после последнего вызова; 0 — не скрывать")
    return parser.parse_args()


def resolve_data_dirs(values: list[str]) -> list[Path]:
    result = []
    for raw in values:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            local = ROOT / path
            home = Path.home() / path
            path = local if local.exists() else home
        result.append(path)
    return result

async def broadcast(payload: dict) -> None:
    text = json.dumps(payload, ensure_ascii=False)
    targets = list(connections)
    results = await asyncio.gather(*(ws.send_text(text) for ws in targets), return_exceptions=True)
    for ws, result in zip(targets, results):
        if isinstance(result, Exception):
            connections.discard(ws)


def current_snapshot() -> dict:
    snapshot = builder.snapshot(
        resource_window=settings["resource_window"],
        stale_after=settings["stale_after"],
        idle_after=settings["idle_after"],
        tool_ttl=settings["tool_ttl"],
    )
    snapshot["last_event_id"] = collector.event_counter
    return snapshot


async def poll(dirs: list[Path]) -> None:
    while True:
        try:
            collector.set_paths(discover_jsonl_files(dirs))
            collector.scan()
            events = collector.drain()
            if events:
                now = time.time()
                builder.apply(events)
                # Сначала события — чтобы фронт успел записать pending до snapshot
                for ev in events:
                    ev["live"] = now - ev["at"] <= LIVE_WINDOW
                    recent_events.append(ev)
                    await broadcast({"type": "event", **ev})
            await broadcast({"type": "snapshot", **current_snapshot()})
        except asyncio.CancelledError:
            raise
        except Exception:
            # Ошибка одного прохода не должна останавливать опрос навсегда.
            log.exception("poll iteration failed")
        await asyncio.sleep(1)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/graph")
async def graph() -> dict:
    return current_snapshot()


@app.websocket("/ws")
async def ws(socket: WebSocket) -> None:
    await socket.accept()
    connections.add(socket)
    await socket.send_text(json.dumps({"type": "snapshot", **current_snapshot()}, ensure_ascii=False))
    try:
        while True:
            text = await socket.receive_text()
            try:
                message = json.loads(text)
                since = int(message.get("since") or 0) if message.get("type") == "resume" else None
            except (ValueError, TypeError, AttributeError):
                continue
            if since is None:
                continue
            now = time.time()
            for ev in list(recent_events):
                if ev["event_id"] > since:
                    out = {"type": "event", **ev, "live": now - ev["at"] <= LIVE_WINDOW, "replay": True}
                    await socket.send_text(json.dumps(out, ensure_ascii=False))
    except WebSocketDisconnect:
        pass
    finally:
        connections.discard(socket)


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


if __name__ == "__main__":
    import uvicorn
    args = parse_args()
    uvicorn.run(app, host=args.host, port=args.port)