from __future__ import annotations

import ipaddress
import time
from urllib.parse import urlparse
import re as _re
_URL_RE = _re.compile(r'\bhttps?://[^\s"\'<>`\)\]]+')

WRITE_TOOLS = {"write", "edit", "patch", "apply_patch", "create", "delete", "move", "rename"}
# Структурные связи живут, пока живы оба конца, и не удаляются по времени.
STRUCTURAL_RELATIONS = {"spawns", "works_in"}
MAX_TRACKED_CALLS = 5000
MAX_PENDING_PER_AGENT = 200
# Вызов без tool_result старше этого возраста считается потерянным: иначе убитый агент
# или недостающий результат закрепили бы инструмент на сцене навсегда.
PENDING_MAX_AGE = 900.0

class GraphBuilder:
    """Хранит текущую рабочую сцену, а не всю историю журналов."""

    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}
        self.edges: dict[tuple[str, str, str], dict] = {}
        self.agent_state: dict[str, dict] = {}
        self.call_tool: dict[str, str] = {}
        # Незавершённые вызовы по агентам: источник истины для состояния Calling tool.
        self.agent_pending: dict[str, dict[str, float]] = {}

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
                    self.bind_project(agent["id"], str(item["cwd"]), at)
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
                if item.get("reason"):
                    state["last_reason"] = item["reason"]
                if kind == "agent.idle" or (kind == "agent.error" and item.get("reason") != "tool_error"):
                    self.agent_pending.pop(agent["id"], None)
                if kind == "agent.active":
                    state["last_activity"] = at

            elif kind == "tool.started":
                self.add_tool(item, agent, at)
                call_id = str(item.get("call_id") or "")
                if call_id:
                    pending = self.agent_pending.setdefault(agent["id"], {})
                    pending[call_id] = at
                    while len(pending) > MAX_PENDING_PER_AGENT:
                        pending.pop(next(iter(pending)))
            elif kind == "tool.completed":
                call_id = str(item.get("call_id") or "")
                pending = self.agent_pending.get(agent["id"])
                if pending is not None:
                    pending.pop(call_id, None)
                    if not pending:
                        del self.agent_pending[agent["id"]]
                tool_node_id = self.call_tool.pop(call_id, None)
                if tool_node_id and tool_node_id in self.nodes:
                    node = self.nodes[tool_node_id]
                    node["last_completed_at"] = at
                    node["last_seen"] = max(node.get("last_seen", 0), at)
                    if item.get("is_error"):
                        node["last_is_error"] = True

    def agent_node(self, source: str, at: float) -> dict:
        node = self.ensure(f"agent:{source}", "agent", source, {"source": source})
        node["last_seen"] = at
        return node

    def add_tool(self, item: dict, agent: dict, at: float) -> None:
        tool_name = str(item.get("tool") or "tool").lower()
        # Узел инструмента принадлежит агенту (§3.5, §7.3): параллельные агенты не сливаются
        # в одну связь. Живёт, пока идёт вызов, и недолго после него (см. prune, tool_ttl).
        owner = agent["id"].split(":", 1)[-1]
        tool_id = f"tool:{owner}:{tool_name}"
        tool = self.ensure(tool_id, "tool", tool_name, {"tool": tool_name, "agent_id": agent["id"]})
        tool["last_seen"] = at
        self.link(agent["id"], tool_id, "uses", at)
        call_id = str(item.get("call_id") or "")
        if call_id:
            self.call_tool[call_id] = tool_id
            while len(self.call_tool) > MAX_TRACKED_CALLS:
                self.call_tool.pop(next(iter(self.call_tool)))

        # Файлы создают только реальные write-tools, а не find/read/grep/ls
        if tool_name in WRITE_TOOLS:
            paths = [str(item["path"])] if item.get("path") else []
            paths += [str(p) for p in (item.get("paths") or []) if str(p) not in paths]
            for raw_path in paths:
                target = self.path_nodes(raw_path, at, agent)
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
            key = project_key(cwd)
            raw_norm = project_key(raw)
            is_abs = raw_norm.startswith("/") or (len(raw_norm) > 1 and raw_norm[1] == ":")
            if is_abs:
                if raw_norm == key or raw_norm.startswith(key + "/"):
                    return self._ensure_project(key, at, display=str(cwd))
            else:
                # относительный путь — считаем, что он под cwd
                return self._ensure_project(key, at, display=str(cwd))
        return self._ensure_project("none", at, label="Workspace")

    def bind_project(self, agent_id: str, cwd: str, at: float) -> dict:
        """Проект существует независимо от записей: агент с cwd сразу привязан к своему проекту.
        В V1 один агент — один проект, поэтому прежнее ребро works_in заменяется."""
        project = self._ensure_project(project_key(cwd), at, display=cwd)
        for key in [k for k in self.edges if k[0] == agent_id and k[2] == "works_in" and k[1] != project["id"]]:
            del self.edges[key]
        self.link(agent_id, project["id"], "works_in", at)
        self.agent_state.setdefault(agent_id, {})["project_id"] = project["id"]
        return project

    def _ensure_project(
        self, key: str, at: float, label: str | None = None, display: str | None = None
    ) -> dict:
        if label is None:
            source = (display or key).replace("\\", "/").rstrip("/")
            base = source.rsplit("/", 1)[-1] if "/" in source else source
            label = base if base and base != "none" else "Workspace"
        data = {"path": display.replace("\\", "/").rstrip("/")} if display else {}
        project = self.ensure(f"project:{key}", "project", label, data)
        project["last_seen"] = at
        return project

    def site_node(self, address: str, at: float) -> dict:
        scope = classify_address(address)
        key = site_key(address)
        node = self.ensure(
            f"site:{scope}:{key}", "site", key,
            {"address": key, "scope": scope,
             "last_url": address if "://" in address else None},
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
        tool_ttl: float = 0,
    ) -> dict:
        now = time.time()
        self.prune(now, resource_window, tool_ttl)
        tool_pending = self.pending_by_tool(now)
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
                    last_reason=state.get("last_reason"),
                    pending_calls=len(self.live_pending(node["id"], now)),
                    cwd=state.get("cwd"),
                    project_id=state.get("project_id"),
                )
            elif node["type"] == "tool":
                copy["pending_calls"] = tool_pending.get(node["id"], 0)
            nodes.append(copy)
        return {
            "generated_at": now,
            "resource_window": resource_window,
            "stale_after": stale_after,
            "idle_after": idle_after,
            "tool_ttl": tool_ttl,
            "nodes": sorted(nodes, key=lambda n: n["id"]),
            "edges": sorted(self.edges.values(), key=lambda e: (e["source"], e["target"], e["relation"])),
        }

    def live_pending(self, agent_id: str, now: float) -> list[str]:
        calls = self.agent_pending.get(agent_id, {})
        return [cid for cid, started in calls.items() if now - started <= PENDING_MAX_AGE]

    def pending_by_tool(self, now: float | None = None) -> dict[str, int]:
        """tool node id -> число незавершённых вызовов."""
        now = time.time() if now is None else now
        counts: dict[str, int] = {}
        for agent_id in self.agent_pending:
            for call_id in self.live_pending(agent_id, now):
                tool_id = self.call_tool.get(call_id)
                if tool_id:
                    counts[tool_id] = counts.get(tool_id, 0) + 1
        return counts

    def prune(self, now: float, resource_window: float, tool_ttl: float = 0) -> None:
        """tool_ttl > 0 — инструмент без незавершённых вызовов исчезает через tool_ttl секунд.
        resource_window <= 0 — остальное по времени не удаляется."""
        pending_tools = set(self.pending_by_tool(now))
        if tool_ttl > 0:
            for node_id, node in list(self.nodes.items()):
                if node["type"] != "tool" or node_id in pending_tools:
                    continue
                if now - node.get("last_seen", 0) > tool_ttl:
                    del self.nodes[node_id]

        if resource_window > 0:
            used_projects = {t for (s, t, rel) in self.edges if rel == "works_in" and s in self.nodes}
            for node_id, node in list(self.nodes.items()):
                if node["type"] == "agent" or node_id in pending_tools:
                    continue
                if node["type"] == "project" and node_id in used_projects:
                    continue  # проект живёт, пока с ним связана хотя бы одна сессия
                if now - node.get("last_seen", 0) > resource_window:
                    del self.nodes[node_id]

        for key, edge in list(self.edges.items()):
            source, target, relation = key
            if source not in self.nodes or target not in self.nodes:
                del self.edges[key]
                continue
            if resource_window <= 0 or relation in STRUCTURAL_RELATIONS:
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


def split_host(address: str) -> tuple[str, int | None]:
    text = address.strip()
    parsed = urlparse(text if "://" in text else "//" + text)
    host = parsed.hostname or text.split("/")[0]
    try:
        port = parsed.port
    except ValueError:
        port = None
    return host, port


def site_key(address: str) -> str:
    host, port = split_host(address)
    return f"{host}:{port}" if port else host


def project_key(path: str) -> str:
    """Ключ проекта: прямые слэши, без хвостового; пути Windows (D:/...) без учёта регистра."""
    key = str(path).replace("\\", "/").rstrip("/")
    if len(key) >= 2 and key[1] == ":":
        key = key.lower()
    return key


def classify_address(address: str) -> str:
    host, _ = split_host(address)
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