from __future__ import annotations

import argparse
import asyncio
import json
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
    settings.update(resource_window=args.window, stale_after=args.stale, idle_after=args.idle)
    dirs = resolve_data_dirs(args.data or [".codex", ".omp"])
    collector.set_paths(discover_jsonl_files(dirs))
    collector.scan(initial=True)
    builder.apply(collector.drain())
    asyncio.create_task(poll(dirs))
    yield


ROOT = Path(__file__).resolve().parent
app = FastAPI(lifespan=lifespan)
collector = LogCollector([])
builder = GraphBuilder()
connections: set[WebSocket] = set()
settings = {"resource_window": 0.0, "stale_after": 60.0, "idle_after": 300.0}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Agent Atlas")
    parser.add_argument("--data", action="append", default=[], help="Папка данных агента: .codex, .omp и т. п.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=41735)
    parser.add_argument("--window", type=float, default=0, help="0 — показывать все узлы; больше 0 — только ресурсы за N секунд")
    parser.add_argument("--stale", type=float, default=60)
    parser.add_argument("--idle", type=float, default=60, help="Секунды после idle до статуса sleeping")
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
    dead = []
    for ws in connections:
        try:
            await ws.send_text(text)
        except Exception:
            dead.append(ws)
    for ws in dead:
        connections.discard(ws)


async def poll(dirs: list[Path]) -> None:
    while True:
        collector.set_paths(discover_jsonl_files(dirs))
        collector.scan()
        events = collector.drain()
        if events:
            builder.apply(events)
            # Сначала события — чтобы фронт успел записать pending до snapshot
            for ev in events:
                await broadcast({"type": "event", **ev})

        snapshot = builder.snapshot(
            resource_window=settings["resource_window"],
            stale_after=settings["stale_after"],
            idle_after=settings["idle_after"],
        )
        snapshot["last_event_id"] = collector.event_counter
        await broadcast({"type": "snapshot", **snapshot})
        await asyncio.sleep(1)



@app.get("/")
async def index() -> FileResponse:
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/graph")
async def graph() -> dict:
    return builder.snapshot(
        resource_window=settings["resource_window"],
        stale_after=settings["stale_after"],
        idle_after=settings["idle_after"],
    )


@app.websocket("/ws")
async def ws(socket: WebSocket) -> None:
    await socket.accept()
    connections.add(socket)
    snap = builder.snapshot(
        resource_window=settings["resource_window"],
        stale_after=settings["stale_after"],
        idle_after=settings["idle_after"],
    )
    snap["last_event_id"] = collector.event_counter
    await socket.send_text(json.dumps({"type": "snapshot", **snap}, ensure_ascii=False))
    try:
        while True:
            await socket.receive_text()
    except WebSocketDisconnect:
        connections.discard(socket)


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


if __name__ == "__main__":
    import uvicorn
    args = parse_args()
    uvicorn.run(app, host=args.host, port=args.port)