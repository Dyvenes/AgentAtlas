from __future__ import annotations

import ipaddress
import time
from urllib.parse import urlparse
import re as _re
_URL_RE = _re.compile(r'\bhttps?://[^\s"\'<>`\)\]]+')

WRITE_TOOLS = {"write", "edit", "patch", "create", "delete", "move", "rename"}

class GraphBuilder:
    """Хранит текущую рабочую сцену, а не всю историю журналов."""

    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}
        self.edges: dict[tuple[str, str, str], dict] = {}
        self.agent_state: dict[str, dict] = {}

    def apply(self, events: list[dict]) -> None:
        for item in events:
            at = float(item["at"])
            agent = self.agent_node(item["source"], at)
            kind = item["kind"]

            if kind == "agent.metadata":
                state = self.agent_state.setdefault(agent["id"], {})
                if item.get("model"):
                    state["model"] = item["model"]
                if item.get("provider"):
                    state["provider"] = item["provider"]
                if item.get("cwd"):
                    state["cwd"] = item["cwd"]
                state["last_event"] = at
            elif kind in {"agent.parent", "agent.spawned"}:
                parent_raw = item.get("parent_agent_id")
                if not parent_raw:
                    continue
                parent_node = self.ensure(
                    f"agent:{parent_raw}", "agent", parent_raw, {"source": parent_raw},
                )
                parent_node["last_seen"] = at
                if not self._would_cycle(parent_node["id"], agent["id"]):
                    agent.setdefault("data", {})["parent_agent_id"] = parent_node["id"]
                    self.link(parent_node["id"], agent["id"], "spawns", at)
            elif kind in {"agent.active", "agent.idle", "agent.error", "agent.ended"}:
                state = self.agent_state.setdefault(agent["id"], {})
                state["last_event"] = at
                state["lifecycle_known"] = True
                state["status"] = {
                    "agent.active": "active",
                    "agent.idle": "idle",
                    "agent.error": "error",
                    "agent.ended": "ended",
                }[kind]
                if kind == "agent.active":
                    state["last_activity"] = at

            elif kind == "tool.started":
                self.add_tool(item, agent, at)

    def agent_node(self, source: str, at: float) -> dict:
        node = self.ensure(f"agent:{source}", "agent", source, {"source": source})
        node["last_seen"] = at
        return node

    def add_tool(self, item: dict, agent: dict, at: float) -> None:
        tool_name = str(item.get("tool") or "tool").lower()
        # Один узел на тип инструмента глобально (15–20 узлов, не 15646)
        tool_id = f"tool:{tool_name}"
        tool = self.ensure(tool_id, "tool", tool_name, {"tool": tool_name})
        tool["last_seen"] = at
        self.link(agent["id"], tool_id, "uses", at)

        # Файлы создают только реальные write-tools, а не find/read/grep/ls
        if item.get("path") and tool_name in WRITE_TOOLS:
            target = self.path_nodes(str(item["path"]), at, agent)
            if target:
                self.link(tool_id, target, "writes", at)

        # Сайты создают все тулы (bash curl, fetch, etc.) — но URL-фильтр (Патч 3) отсеет мусор
        if item.get("url"):
            site = self.site_node(str(item["url"]), at)
            if site:
                self.link(tool_id, site["id"], "requests", at)
        if item.get("command"):
            for address in extract_addresses(str(item["command"])):
                site = self.site_node(address, at)
                if site:
                    self.link(tool_id, site["id"], "requests", at)

    def path_nodes(self, raw: str, at: float, agent: dict | None = None) -> str | None:
        raw = _clean_path(raw)
        parts = [p for p in raw.replace("\\", "/").split("/") if p and p not in {".", ".."}]
        if not parts:
            return None
        # Windows-корень вида "D:" — не файл, а листинг диска
        if len(parts) == 1 and len(parts[0]) <= 2 and parts[0].endswith(":"):
            return None
        project = self.project_for(agent, raw, at)
        parent = project["id"]
        accumulated = ""
        for part in parts[:-1]:
            accumulated = f"{accumulated}/{part}" if accumulated else part
            folder_id = f"folder:{project['id']}:{accumulated}"
            folder = self.ensure(
                folder_id, "folder", part,
                {"path": accumulated, "project_id": project["id"]},
            )
            folder["last_seen"] = at
            self.link(parent, folder["id"], "contains", at)
            parent = folder["id"]
        name = parts[-1]
        ext = ("." + name.rsplit(".", 1)[-1]) if "." in name else ""
        file_id = f"file:{project['id']}:{raw}"
        file_node = self.ensure(
            file_id, "file", name,
            {"path": raw, "project_id": project["id"], "extension": ext},
        )
        file_node["last_seen"] = at
        self.link(parent, file_node["id"], "contains", at)
        return file_node["id"]

    def project_for(self, agent: dict | None, raw: str, at: float) -> dict:
        cwd = None
        if agent:
            cwd = self.agent_state.get(agent["id"], {}).get("cwd")
        if cwd:
            cwd_norm = str(cwd).replace("\\", "/").rstrip("/")
            raw_norm = str(raw).replace("\\", "/")
            is_abs = raw_norm.startswith("/") or (len(raw_norm) > 1 and raw_norm[1] == ":")
            if is_abs:
                if raw_norm == cwd_norm or raw_norm.startswith(cwd_norm + "/"):
                    return self._ensure_project(cwd_norm, at)
            else:
                # относительный путь — считаем, что он под cwd
                return self._ensure_project(cwd_norm, at)
        return self._ensure_project("none", at, label="Workspace")

    def _ensure_project(self, key: str, at: float, label: str | None = None) -> dict:
        if label is None:
            base = key.rsplit("/", 1)[-1] if "/" in key else key
            label = base if base and base != "none" else "Workspace"
        project = self.ensure(f"project:{key}", "project", label, {})
        project["last_seen"] = at
        return project

    def site_node(self, address: str, at: float) -> dict:
        scope = classify_address(address)
        node = self.ensure(
            f"site:{scope}:{address}", "site", address,
            {"address": address, "scope": scope},
        )
        node["last_seen"] = at
        return node

    def ensure(self, node_id: str, kind: str, label: str, data: dict) -> dict:
        node = self.nodes.setdefault(
            node_id, {"id": node_id, "type": kind, "label": label, **data}
        )
        node.update({k: v for k, v in data.items() if v is not None})
        return node

    def link(self, source: str, target: str, relation: str, at: float) -> None:
        edge = self.edges.setdefault(
            (source, target, relation),
            {"source": source, "target": target, "relation": relation},
        )
        edge["last_seen"] = at

    def _would_cycle(self, parent_id: str, child_id: str) -> bool:
        # Ребро parent→child создаст цикл, если child уже достижим из parent.
        seen: set[str] = set()
        stack = [parent_id]
        while stack:
            cur = stack.pop()
            if cur == child_id:
                return True
            if cur in seen:
                continue
            seen.add(cur)
            for (s, t, rel) in self.edges:
                if s == cur and rel == "spawns":
                    stack.append(t)
        return False

    def snapshot(
        self,
        resource_window: float = 600,
        stale_after: float = 60,
        idle_after: float = 300,
    ) -> dict:
        now = time.time()
        self.prune(now, resource_window)
        nodes = []
        for node in self.nodes.values():
            copy = dict(node)
            if node["type"] == "agent":
                state = self.agent_state.get(node["id"], {})
                status, stale = self.semantic_status(state, now, stale_after, idle_after)
                copy.update(
                    parent_agent_id=node.get("data", {}).get("parent_agent_id") or node.get("parent_agent_id"),                    
                    model=state.get("model"),
                    provider=state.get("provider"),
                    status=status,
                    stale=stale,
                    lifecycle_known=bool(state.get("lifecycle_known")),
                    last_event=state.get("last_event"),
                    last_activity=state.get("last_activity"),
                )
            nodes.append(copy)
        return {
            "generated_at": now,
            "resource_window": resource_window,
            "stale_after": stale_after,
            "idle_after": idle_after,
            "nodes": sorted(nodes, key=lambda n: n["id"]),
            "edges": sorted(self.edges.values(), key=lambda e: (e["source"], e["target"], e["relation"])),
        }

    def prune(self, now: float, resource_window: float) -> None:
        for node_id, node in list(self.nodes.items()):
            if node["type"] == "agent":
                continue
            if now - node.get("last_seen", 0) > resource_window:
                del self.nodes[node_id]
        for key, edge in list(self.edges.items()):
            source, target, _ = key
            if source not in self.nodes or target not in self.nodes:
                del self.edges[key]
                continue
            if now - edge.get("last_seen", 0) > resource_window:
                del self.edges[key]

    @staticmethod
    def semantic_status(
        state: dict, now: float, stale_after: float, idle_after: float
    ) -> tuple[str, bool]:
        """(semantic_status, stale_flag). Семантика не «додумывается»."""
        if not state:
            return "unknown", False
        status = state.get("status", "unknown")
        last = state.get("last_event")
        if last is None:
            return "unknown", False
        age = now - last
        stale = age > stale_after
        if status == "idle" and age > idle_after:
            return "sleeping", stale
        return status, stale


def classify_address(address: str) -> str:
    host = urlparse(address).hostname or address.split("/")[0]
    if host in {"localhost", "::1"} or host.startswith("127."):
        return "localhost"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return "internet"
    return "lan" if ip.is_private or ip.is_loopback or ip.is_link_local else "internet"


def extract_addresses(text: str) -> list[str]:
    result: list[str] = []
    for match in _URL_RE.finditer(text):
        result.append(match.group(0))
    for word in text.replace('"', " ").replace("'", " ").split():
        cleaned = word.rstrip(",.;:)")
        if cleaned != word and is_ip(cleaned):
            result.append(cleaned)
        elif is_ip(word):
            result.append(word)
    return result

def is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False

import re

_LINE_RANGE_RE = re.compile(r"^(.*?)(?::\d+(?:-\d+)?)?$")

def _clean_path(raw: str) -> str:
    text = str(raw).strip()
    m = _LINE_RANGE_RE.match(text)
    return m.group(1) if m and m.group(1) else text