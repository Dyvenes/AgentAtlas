"""Тесты backend: python -m unittest discover -s tests -p "test_*.py" -v

Только стандартная библиотека; FastAPI для collector/graph не нужен.
"""
from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collector import LogCollector, extract_patch_paths  # noqa: E402
from graph import GraphBuilder, classify_address, project_key, site_key  # noqa: E402

TS = "2026-11-24T10:00:{:02d}Z"


def dump(*records: dict, newline: str = "\n") -> bytes:
    return "".join(json.dumps(r, ensure_ascii=False) + newline for r in records).encode("utf-8")


def omp_session(sid: str = "omp-1", cwd: str = "D:\\proj\\alpha", parent: str | None = None) -> dict:
    rec = {"type": "session", "id": sid, "timestamp": TS.format(0), "cwd": cwd}
    if parent:
        rec["parentSession"] = parent
    return rec


def omp_assistant(calls: list[dict], sec: int = 1, stop: str = "toolUse") -> dict:
    return {
        "type": "message", "timestamp": TS.format(sec),
        "message": {"role": "assistant", "stopReason": stop, "content": calls},
    }


def omp_call(cid: str, name: str, **args) -> dict:
    return {"type": "toolCall", "id": cid, "name": name, "arguments": args}


def omp_result(cid: str, sec: int = 2, error: bool = False) -> dict:
    return {
        "type": "message", "timestamp": TS.format(sec),
        "message": {"role": "toolResult", "toolCallId": cid, "isError": error},
    }


class CollectorBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.collector = LogCollector([])

    def write(self, name: str, data: bytes, mode: str = "wb") -> Path:
        path = self.dir / name
        with path.open(mode) as fh:
            fh.write(data)
        self.collector.set_paths([path])
        return path

    def scan(self) -> list[dict]:
        self.collector.scan()
        return self.collector.drain()


class ScanTests(CollectorBase):
    def test_record_without_timestamp_does_not_crash(self):
        self.write("a.jsonl", dump({"type": "session", "id": "s1"}, {"type": "event_msg", "payload": {"type": "task_started"}}))
        events = self.scan()
        self.assertIn("agent.active", [e["kind"] for e in events])

    def test_partial_line_is_not_lost(self):
        full = dump(omp_session())
        second = json.dumps(omp_assistant([omp_call("c1", "read", path="a.py")]), ensure_ascii=False)
        path = self.write("a.jsonl", full + second[:25].encode())  # писатель не дописал строку
        first = self.scan()
        self.assertFalse([e for e in first if e["kind"] == "tool.started"])
        with path.open("ab") as fh:
            fh.write(second[25:].encode() + b"\n")
        later = self.scan()
        self.assertEqual([e["call_id"] for e in later if e["kind"] == "tool.started"], ["c1"])

    def test_last_line_without_newline_is_consumed_when_valid(self):
        data = dump(omp_session(), omp_assistant([omp_call("c1", "read", path="a.py")])).rstrip(b"\n")
        self.write("a.jsonl", data)
        self.assertEqual(len([e for e in self.scan() if e["kind"] == "tool.started"]), 1)
        self.assertEqual(self.scan(), [])  # повторно не читается

    def test_crlf_offsets_stay_correct(self):
        path = self.write("a.jsonl", dump(omp_session(), omp_assistant([omp_call("c1", "read", path="a")]), newline="\r\n"))
        self.assertEqual(len([e for e in self.scan() if e["kind"] == "tool.started"]), 1)
        with path.open("ab") as fh:
            fh.write(dump(omp_assistant([omp_call("c2", "read", path="b")], sec=3), newline="\r\n"))
        later = self.scan()
        self.assertEqual([e["call_id"] for e in later if e["kind"] == "tool.started"], ["c2"])


class ToolEventTests(CollectorBase):
    def test_omp_parallel_tool_calls_all_reported(self):
        self.write("a.jsonl", dump(
            omp_session(),
            omp_assistant([omp_call("c1", "read", path="a.py"), omp_call("c2", "write", path="b.py")]),
            omp_result("c1"), omp_result("c2", sec=3),
        ))
        events = self.scan()
        started = [e["call_id"] for e in events if e["kind"] == "tool.started"]
        completed = [e["call_id"] for e in events if e["kind"] == "tool.completed"]
        self.assertEqual(started, ["c1", "c2"])
        self.assertEqual(completed, ["c1", "c2"])

    def test_codex_custom_tool_call_and_output_share_call_id(self):
        patch = "*** Begin Patch\n*** Update File: src/a.py\n@@\n-x\n+y\n*** Add File: src/b.py\n+z\n*** End Patch"
        self.write("c.jsonl", dump(
            {"type": "session_meta", "timestamp": TS.format(0), "payload": {"id": "cdx-1", "cwd": "D:\\proj\\alpha"}},
            {"type": "response_item", "timestamp": TS.format(1),
             "payload": {"type": "custom_tool_call", "name": "apply_patch", "id": "ctc_item", "call_id": "call_9", "input": patch}},
            {"type": "response_item", "timestamp": TS.format(2),
             "payload": {"type": "custom_tool_call_output", "call_id": "call_9", "output": "ok"}},
        ))
        events = self.scan()
        started = [e for e in events if e["kind"] == "tool.started"]
        self.assertEqual(len(started), 1)
        self.assertEqual(started[0]["call_id"], "call_9")  # не "ctc_item"
        self.assertEqual(started[0]["tool"], "apply_patch")
        self.assertEqual(started[0]["path"], "src/a.py")
        self.assertEqual(started[0]["paths"], ["src/a.py", "src/b.py"])
        self.assertEqual([e["call_id"] for e in events if e["kind"] == "tool.completed"], ["call_9"])

    def test_codex_function_call_prefers_call_id_over_id(self):
        self.write("c.jsonl", dump(
            {"type": "session_meta", "timestamp": TS.format(0), "payload": {"id": "cdx-2"}},
            {"type": "response_item", "timestamp": TS.format(1),
             "payload": {"type": "function_call", "name": "shell", "id": "fc_item", "call_id": "call_1",
                         "arguments": json.dumps({"command": "ls"})}},
        ))
        started = [e for e in self.scan() if e["kind"] == "tool.started"]
        self.assertEqual(started[0]["call_id"], "call_1")
        self.assertEqual(started[0]["command"], "ls")

    def test_tool_execution_start_does_not_duplicate_tool_started(self):
        self.write("a.jsonl", dump(
            omp_session(),
            omp_assistant([omp_call("c1", "bash", command="ls")]),
            {"type": "custom", "customType": "tool_execution_start", "timestamp": TS.format(2),
             "data": {"toolName": "bash", "toolCallId": "c1"}},
        ))
        started = [e for e in self.scan() if e["kind"] == "tool.started"]
        self.assertEqual(len(started), 1)

    def test_turn_markers_with_and_without_underscore(self):
        self.write("c.jsonl", dump(
            {"type": "session_meta", "timestamp": TS.format(0), "payload": {"id": "cdx-3"}},
            {"type": "event_msg", "timestamp": TS.format(1), "payload": {"type": "task_started"}},
            {"type": "event_msg", "timestamp": TS.format(2), "payload": {"type": "task_complete"}},
            {"type": "event_msg", "timestamp": TS.format(3), "payload": {"type": "turn_aborted"}},
        ))
        events = self.scan()
        reasons = [(e["kind"], e.get("reason")) for e in events if e["kind"] in {"agent.active", "agent.idle"}]
        self.assertEqual(reasons, [
            ("agent.active", "turn_started"),
            ("agent.idle", "turn_complete"),
            ("agent.idle", "turn_aborted"),
        ])

    def test_patch_path_parser(self):
        text = "*** Begin Patch\n*** Delete File: old.py\n*** Update File: a.py\n*** Move to: b.py\n*** End Patch"
        self.assertEqual(extract_patch_paths(text), ["old.py", "a.py", "b.py"])
        self.assertEqual(extract_patch_paths(None), [])


def agent_events(source="s1", cwd="D:\\proj\\alpha", at=1000.0, **extra):
    return [{"kind": "agent.metadata", "at": at, "source": source, "cwd": cwd, **extra}]


class GraphTests(unittest.TestCase):
    def snapshot(self, builder: GraphBuilder, window: float = 0, now_offset: float = 0.0) -> dict:
        return builder.snapshot(resource_window=window)

    def test_project_exists_from_cwd_without_any_write(self):
        b = GraphBuilder()
        b.apply(agent_events())
        snap = b.snapshot(resource_window=0)
        project = next(n for n in snap["nodes"] if n["type"] == "project")
        agent = next(n for n in snap["nodes"] if n["type"] == "agent")
        self.assertEqual(project["label"], "alpha")
        self.assertEqual(agent["project_id"], project["id"])
        self.assertEqual(agent["cwd"], "D:\\proj\\alpha")
        self.assertIn((agent["id"], project["id"], "works_in"), {(e["source"], e["target"], e["relation"]) for e in snap["edges"]})

    def test_several_agents_share_one_project(self):
        b = GraphBuilder()
        b.apply(agent_events("s1") + agent_events("s2", cwd="d:/PROJ/alpha/"))  # другой регистр и слэши
        snap = b.snapshot(resource_window=0)
        self.assertEqual(len([n for n in snap["nodes"] if n["type"] == "project"]), 1)
        self.assertEqual(len([e for e in snap["edges"] if e["relation"] == "works_in"]), 2)

    def test_agent_moves_to_new_cwd_keeps_single_works_in(self):
        b = GraphBuilder()
        b.apply(agent_events(cwd="D:/a") + agent_events(cwd="D:/b", at=1001.0))
        edges = [e for e in b.snapshot(resource_window=0)["edges"] if e["relation"] == "works_in"]
        self.assertEqual(len(edges), 1)
        self.assertTrue(edges[0]["target"].endswith("d:/b"))

    def test_write_tool_files_land_in_agent_project_case_insensitive(self):
        b = GraphBuilder()
        b.apply(agent_events(cwd="D:\\Proj\\Alpha"))
        b.apply([{"kind": "tool.started", "at": 1001.0, "source": "s1", "tool": "apply_patch",
                  "call_id": "c1", "path": "d:/proj/alpha/src/a.py", "paths": ["d:/proj/alpha/src/b.py"]}])
        snap = b.snapshot(resource_window=0)
        files = [n for n in snap["nodes"] if n["type"] == "file"]
        self.assertEqual(sorted(f["label"] for f in files), ["a.py", "b.py"])
        self.assertEqual({f["project_id"] for f in files}, {"project:d:/proj/alpha"})
        self.assertEqual(len([n for n in snap["nodes"] if n["type"] == "project"]), 1)

    def test_prune_window_zero_keeps_everything(self):
        b = GraphBuilder()
        b.apply(agent_events(at=1.0))
        b.apply([{"kind": "tool.started", "at": 1.0, "source": "s1", "tool": "write", "call_id": "c1", "path": "a.py"}])
        snap = b.snapshot(resource_window=0)
        self.assertTrue([n for n in snap["nodes"] if n["type"] == "file"])
        self.assertTrue([n for n in snap["nodes"] if n["type"] == "tool"])

    def test_prune_removes_stale_resources_but_not_projects_or_structural_edges(self):
        b = GraphBuilder()
        old = time.time() - 10_000
        b.apply(agent_events("child", at=old))
        b.apply([{"kind": "agent.parent", "at": old, "source": "child", "parent_agent_id": "root"}])
        b.apply([{"kind": "tool.started", "at": old, "source": "child", "tool": "write", "call_id": "c1", "path": "a.py"}])
        snap = b.snapshot(resource_window=600)
        types = {n["type"] for n in snap["nodes"]}
        self.assertIn("project", types)
        self.assertNotIn("file", types)
        self.assertNotIn("tool", types)
        relations = {e["relation"] for e in snap["edges"]}
        self.assertTrue({"spawns", "works_in"} <= relations)

    def test_unused_project_is_pruned_after_window(self):
        b = GraphBuilder()
        b._ensure_project("d:/orphan", time.time() - 10_000, display="D:/orphan")
        snap = b.snapshot(resource_window=600)
        self.assertFalse([n for n in snap["nodes"] if n["type"] == "project"])

    def test_call_tool_released_on_completion(self):
        b = GraphBuilder()
        b.apply(agent_events())
        b.apply([{"kind": "tool.started", "at": 1001.0, "source": "s1", "tool": "bash", "call_id": "c1"},
                 {"kind": "tool.completed", "at": 1002.0, "source": "s1", "call_id": "c1", "is_error": False}])
        self.assertNotIn("c1", b.call_tool)
        self.assertEqual(b.nodes["tool:bash"]["last_completed_at"], 1002.0)

    def test_sites_are_per_host_not_per_url(self):
        b = GraphBuilder()
        b.apply(agent_events())
        b.apply([
            {"kind": "tool.started", "at": 1001.0, "source": "s1", "tool": "fetch", "call_id": "1", "url": "https://api.github.com/repos/a/b"},
            {"kind": "tool.started", "at": 1002.0, "source": "s1", "tool": "fetch", "call_id": "2", "url": "https://api.github.com/repos/c/d?x=1"},
            {"kind": "tool.started", "at": 1003.0, "source": "s1", "tool": "bash", "call_id": "3", "command": "curl http://localhost:3000/health"},
        ])
        sites = sorted(n["id"] for n in b.snapshot(resource_window=0)["nodes"] if n["type"] == "site")
        self.assertEqual(sites, ["site:internet:api.github.com", "site:localhost:localhost:3000"])

    def test_site_and_project_helpers(self):
        self.assertEqual(site_key("http://10.0.0.5:8080/x"), "10.0.0.5:8080")
        self.assertEqual(classify_address("10.0.0.5:8080"), "lan")
        self.assertEqual(classify_address("https://example.com"), "internet")
        self.assertEqual(project_key("D:\\Proj\\A\\"), "d:/proj/a")
        self.assertEqual(project_key("/home/User/A"), "/home/User/A")

    def test_idle_reason_exposed_for_waiting_vs_aborted(self):
        b = GraphBuilder()
        now = time.time()
        b.apply(agent_events(at=now))
        b.apply([{"kind": "agent.idle", "at": now, "source": "s1", "reason": "turn_aborted"}])
        agent = next(n for n in b.snapshot(resource_window=0)["nodes"] if n["type"] == "agent")
        self.assertEqual(agent["status"], "idle")
        self.assertEqual(agent["last_reason"], "turn_aborted")


class EndToEndTests(CollectorBase):
    def test_collector_to_graph_codex_patch(self):
        self.write("c.jsonl", dump(
            {"type": "session_meta", "timestamp": TS.format(0), "payload": {"id": "cdx-1", "cwd": "D:\\proj\\alpha"}},
            {"type": "response_item", "timestamp": TS.format(1),
             "payload": {"type": "custom_tool_call", "name": "apply_patch", "call_id": "call_9",
                         "input": "*** Begin Patch\n*** Update File: src/a.py\n*** End Patch"}},
        ))
        builder = GraphBuilder()
        builder.apply(self.scan())
        snap = builder.snapshot(resource_window=0)
        self.assertTrue([n for n in snap["nodes"] if n["type"] == "file" and n["label"] == "a.py"])
        self.assertTrue([e for e in snap["edges"] if e["relation"] == "works_in"])


if __name__ == "__main__":
    unittest.main()