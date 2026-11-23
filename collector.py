from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


@dataclass
class FileState:
    path: Path
    offset: int = 0
    identity: tuple[int, int] | None = None


def discover_jsonl_files(dirs: list[Path]) -> list[Path]:
    files: list[Path] = []
    for directory in dirs:
        if directory.is_file() and directory.suffix == ".jsonl":
            files.append(directory)
        elif directory.exists():
            files.extend(sorted(directory.rglob("*.jsonl")))
    unique: list[Path] = []
    seen: set[Path] = set()
    for path in files:
        resolved = path.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(resolved)
    return unique


class LogCollector:
    def __init__(self, paths: list[Path] | None = None) -> None:
        self._session_ids: dict[Path, str] = {}
        self.states: dict[Path, FileState] = {}
        self.events: list[dict] = []
        if paths:
            self.set_paths(paths)

    def set_paths(self, paths: list[Path]) -> None:
        for path in paths:
            resolved = path.resolve()
            if resolved not in self.states:
                self.states[resolved] = FileState(resolved)

    def drain(self) -> list[dict]:
        out = self.events
        self.events = []
        return out

    def scan(self, initial: bool = False) -> None:
        for state in self.states.values():
            try:
                stat = state.path.stat()
            except FileNotFoundError:
                continue
            identity = (stat.st_dev, stat.st_ino)
            if state.identity is not None and identity != state.identity:
                state.offset = 0
            state.identity = identity
            if stat.st_size < state.offset:
                state.offset = 0
            with state.path.open("r", encoding="utf-8", errors="replace") as fh:
                fh.seek(state.offset)
                while True:
                    line = fh.readline()
                    if not line:
                        break
                    state.offset += len(line.encode("utf-8", errors="replace"))
                    if self._parse(line) is not None:
                        pass  # parse уже будет вызван ниже                    
                    record = self._parse(line)
                    if record:
                        # Pre-register session ids so agent.parent and agent events share canonical id.
                        if isinstance(record, dict):
                            if record.get("type") == "session" and record.get("id"):
                                self._session_ids[state.path] = str(record["id"])
                            elif record.get("type") == "session_meta":
                                payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
                                sid = payload.get("id")
                                if sid:
                                    self._session_ids[state.path] = str(sid)
                        at = extract_timestamp(record) or now
                        self.events.extend(self._events(record, state.path, at))

    @staticmethod
    def _parse(line: str) -> dict | None:
        try:
            value = json.loads(line.strip())
        except (json.JSONDecodeError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def _events(self, record: dict, source: Path, at: float) -> list[dict]:
        events: list[dict] = []

        # Для OMP первая строка type:"session" даёт канонический agent_id (id из файла).
        # Все последующие события файла должны эмититься с этим id, а не с именем файла.
        if isinstance(record, dict) and record.get("type") == "session" and record.get("id"):
            self._session_ids[source] = str(record["id"])
        canonical = self._session_ids.get(source) or source.stem

        def agent_source(_at: float) -> str:
            return canonical

        model, provider = find_model(record)
        cwd = find_cwd(record)

        if model or provider or cwd:
            events.append(self.agent_event("agent.metadata", at, source, model=model, provider=provider, cwd=cwd))

        parent_id = find_codex_parent(record) or find_omp_parent(record, source)
        if parent_id and parent_id != canonical:
            events.append(self.agent_event("agent.parent", at, source, parent_agent_id=parent_id))

        if find_payload_type(record) == "taskstarted" or find_value(record, "type") == "taskstarted":
            events.append(self.agent_event("agent.active", at, source, reason="turn_started"))
        if find_payload_type(record) == "taskcomplete" or find_value(record, "type") == "taskcomplete":
            events.append(self.agent_event("agent.idle", at, source, reason="turn_complete"))

        tool = find_tool_call(record)
        if tool:
            events.append(self.agent_event("tool.started", at, source, tool=tool["name"], call_id=tool["call_id"], **tool["target"]))
            events.append(self.agent_event("agent.active", at, source, reason="tool_call"))

        if find_value(record, "customType") == "tool_execution_start":
            events.append(self.agent_event("agent.active", at, source, reason="tool_execution"))

        msg = record.get("message") if isinstance(record.get("message"), dict) else None
        if msg is not None:
            role = msg.get("role")
            if role == "assistant":
                stop = msg.get("stopReason")
                if stop == "toolUse":
                    events.append(self.agent_event("agent.active", at, source, reason="turn_tool_use"))
                elif not stop:
                    events.append(self.agent_event("agent.active", at, source, reason="assistant"))
                else:
                    events.append(self.agent_event("agent.idle", at, source, reason=f"turn_{stop}"))
            elif role == "toolResult":
                if msg.get("isError") is True:
                    events.append(self.agent_event("agent.error", at, source))
                else:
                    events.append(self.agent_event("agent.active", at, source, reason="tool_result"))
        elif is_tool_result(record):
            if find_value(record, "isError") is True:
                events.append(self.agent_event("agent.error", at, source))
            else:
                events.append(self.agent_event("agent.active", at, source, reason="tool_result"))

        return events

    @staticmethod
    def event(kind: str, at: float, source: Path, **data: Any) -> dict:
        return {"kind": kind, "at": at, "source": source.name, **{k: v for k, v in data.items() if v not in (None, "")}}

    def agent_event(self, kind: str, at: float, source: Path, **data: Any) -> dict:
        canonical = self._session_ids.get(source) or source.stem
        return {"kind": kind, "at": at, "source": canonical, **{k: v for k, v in data.items() if v not in (None, "")}}


def extract_timestamp(record: Any) -> float | None:
    if not isinstance(record, dict):
        return None
    for key in ("timestamp", "startedAt", "completedAt", "createdAt"):
        parsed = parse_timestamp(record.get(key))
        if parsed is not None:
            return parsed
    for value in record.values():
        parsed = extract_timestamp(value)
        if parsed is not None:
            return parsed
    return None


def parse_timestamp(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        number = float(value)
        return number / 1000 if number > 1e12 else number
    if isinstance(value, str):
        text = value.strip()
        try:
            return float(text)
        except ValueError:
            pass
        try:
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            return datetime.fromisoformat(text).timestamp()
        except ValueError:
            return None
    return None


def find_model(value: Any) -> tuple[Any, Any]:
    model = find_key(value, {"model", "modelId", "model_name"})
    provider = find_key(value, {"provider", "modelprovider", "modelProvider"})
    if not provider and isinstance(model, str) and "/" in model:
        prefix, _, rest = model.partition("/")
        if prefix and rest:
            provider = prefix
            model = rest
    return model, provider


def find_payload_type(value: Any) -> Any:
    if isinstance(value, dict) and isinstance(value.get("payload"), dict):
        return value["payload"].get("type")
    return None


def find_value(value: Any, key: str) -> Any:
    return find_key(value, {key})


def find_key(value: Any, keys: set[str]) -> Any:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in keys and item not in (None, "", []):
                return item
        for item in value.values():
            found = find_key(item, keys)
            if found is not None:
                return found
    elif isinstance(value, list):
        for item in value:
            found = find_key(item, keys)
            if found is not None:
                return found
    return None

def find_tool_call(value: Any) -> dict | None:
    if isinstance(value, dict):
        if value.get("type") in ("toolCall", "function_call") or value.get("customType") == "tool_execution_start":
            name = value.get("name") or value.get("toolName")
            call_id = (
                value.get("id")
                or value.get("toolCallId")
                or value.get("callid")
                or value.get("call_id")
            )
            target = extract_target(value)
            data = value.get("data")
            if isinstance(data, dict):
                name = name or data.get("toolName")
                call_id = call_id or data.get("toolCallId")
                if not (target.get("path") or target.get("url") or target.get("command")):
                    target = extract_target(data)
            if name:
                return {"name": str(name), "call_id": str(call_id or name), "target": target}
        for item in value.values():
            found = find_tool_call(item)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = find_tool_call(item)
            if found:
                return found
    return None

def extract_target(value: Any) -> dict:
    args = value.get("arguments") or value.get("input") or value.get("args")
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            args = {}
    if not isinstance(args, dict):
        args = {}
    return {
        "path": args.get("path") or args.get("file_path") or args.get("filePath"),
        "url": args.get("url") or args.get("uri"),
        "command": args.get("command"),
    }


def is_tool_result(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("role") == "toolResult":
        return True
    return any(is_tool_result(item) for item in value.values() if isinstance(item, (dict, list)))

def find_cwd(value: Any) -> Any:
    return find_key(value, {"cwd", "workingDirectory", "working_dir", "workdir"})


_SESSION_ID_CACHE: dict[str, str] = {}


def find_codex_parent(record: dict) -> str | None:
    """Codex: session_meta.payload.source.subagent.thread_spawn.parent_thread_id.
    Ищем рекурсивно на любом уровне, не угадываем."""
    if not isinstance(record, dict):
        return None
    value = find_key(record, {"parent_thread_id"})
    if value:
        return str(value)
    # Защита от случая, когда parent_thread_id завёрнут в thread_spawn
    spawn = find_key(record, {"thread_spawn"})
    if isinstance(spawn, dict):
        pid = spawn.get("parent_thread_id") or spawn.get("parentThreadId")
        if pid:
            return str(pid)
    return None

def find_codex_id(record: dict) -> str | None:
    if not isinstance(record, dict):
        return None
    if record.get("type") != "session_meta":
        return None
    payload = record.get("payload")
    if isinstance(payload, dict):
        sid = payload.get("id") or payload.get("session_id")
        if sid:
            return str(sid)
    return None
    


def find_omp_parent(record: dict, source: Path) -> str | None:
    """OMP: session.parentSession — путь к родительскому JSONL.
    Id родителя берём из первой type:"session" строки файла."""
    if not isinstance(record, dict) or record.get("type") != "session":
        return None
    parent_path = record.get("parentSession")
    if not parent_path:
        return None
    text = str(parent_path).replace("\\", "/").strip()
    candidates = [
        Path(text),
        source.parent / text,
        source.parent / Path(text).name,
    ]
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if not resolved.exists() or not resolved.is_file():
            continue
        key = str(resolved)
        if key in _SESSION_ID_CACHE:
            return _SESSION_ID_CACHE[key]
        try:
            with resolved.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(obj, dict) and obj.get("type") == "session" and obj.get("id"):
                        _SESSION_ID_CACHE[key] = str(obj["id"])
                        return str(obj["id"])
        except OSError:
            continue
    return None