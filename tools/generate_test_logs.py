"""Generate fresh Agent Atlas test logs.

Run:
    python tools/generate_test_logs.py

Then:
    python app.py --data logs/test_data --window 3600 --stale 300

Every run replaces logs/test_data/*.jsonl with fresh timestamps.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "logs" / "test_data"


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")


def session(sid: str, cwd: str, title: str, at: datetime) -> dict:
    return {
        "type": "session", "version": 3, "id": sid,
        "timestamp": iso(at), "cwd": cwd, "title": title, "titleSource": "auto",
    }


def model_change(model: str, at: datetime) -> dict:
    return {
        "type": "model_change", "id": f"m{int(at.timestamp())}",
        "parentId": None, "timestamp": iso(at),
        "runtime": {"version": "19.0.1"},
        "model": model, "role": "default",
    }


def tool_call(call_id: str, name: str, args: dict, at: datetime) -> dict:
    return {
        "type": "message", "id": f"msg_{call_id}", "parentId": None, "timestamp": iso(at),
        "runtime": {"version": "19.0.1"},
        "message": {
            "role": "assistant",
            "content": [{"type": "toolCall", "id": call_id, "name": name, "arguments": args}],
            "stopReason": "toolUse",
        },
    }


def tool_result(call_id: str, name: str, text: str, at: datetime, is_error: bool = False) -> dict:
    return {
        "type": "message", "id": f"res_{call_id}", "parentId": None, "timestamp": iso(at),
        "runtime": {"version": "19.0.1"},
        "message": {
            "role": "toolResult",
            "toolCallId": call_id,
            "toolName": name,
            "content": [{"type": "text", "text": text}],
            "isError": is_error,
        },
    }


def assistant_final(text: str, at: datetime) -> dict:
    return {
        "type": "message", "id": f"final_{int(at.timestamp())}", "parentId": None, "timestamp": iso(at),
        "runtime": {"version": "19.0.1"},
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "stopReason": "endTurn",
        },
    }


def build_active(now: datetime) -> list[dict]:
    return [
        session("01-test-active", r"D:\Projects\Alpha", "Active build", now - timedelta(seconds=180)),
        model_change("openai-codex/gpt-6.1-terra", now - timedelta(seconds=180)),
        tool_call("call_a1", "bash", {"command": "ls src/"}, now - timedelta(seconds=170)),
        tool_result("call_a1", "bash", "app.py\nmain.py\nutils.py", now - timedelta(seconds=165)),
        tool_call("call_a2", "read", {"path": "src/main.py:1-50"}, now - timedelta(seconds=160)),
        tool_result("call_a2", "read", "import os\n...", now - timedelta(seconds=155)),
        tool_call("call_a3", "edit", {"path": "src/main.py", "old_string": "x", "new_string": "y"}, now - timedelta(seconds=150)),
        tool_result("call_a3", "edit", "ok", now - timedelta(seconds=145)),
        tool_call("call_a4", "write", {"path": "src/app.py", "content": "..."}, now - timedelta(seconds=30)),
        tool_result("call_a4", "write", "written", now - timedelta(seconds=25)),
    ]


def build_idle(now: datetime) -> list[dict]:
    return [
        session("01-test-idle", r"D:\Projects\Beta", "Docs update", now - timedelta(seconds=240)),
        model_change("anthropic/claude-opus-4-5", now - timedelta(seconds=240)),
        tool_call("call_b1", "read", {"path": "docs/README.md:1-100"}, now - timedelta(seconds=230)),
        tool_result("call_b1", "read", "# README\n...", now - timedelta(seconds=225)),
        tool_call("call_b2", "write", {"path": "docs/README.md", "content": "# New README"}, now - timedelta(seconds=200)),
        tool_result("call_b2", "write", "ok", now - timedelta(seconds=195)),
        assistant_final("Done updating docs.", now - timedelta(seconds=90)),
    ]


def build_sleeping(now: datetime) -> list[dict]:
    return [
        session("01-test-sleeping", r"D:\Projects\Alpha", "Old session", now - timedelta(seconds=900)),
        model_change("openai-codex/gpt-6.1-terra", now - timedelta(seconds=900)),
        tool_call("call_c1", "bash", {"command": "curl https://api.github.com/repos/foo/bar"}, now - timedelta(seconds=880)),
        tool_result("call_c1", "bash", "200 OK", now - timedelta(seconds=875)),
        assistant_final("Finished.", now - timedelta(seconds=600)),
    ]


def build_error(now: datetime) -> list[dict]:
    return [
        session("01-test-error", r"D:\Projects\Gamma", "Failing job", now - timedelta(seconds=120)),
        model_change("google/gemini-3-pro", now - timedelta(seconds=120)),
        tool_call("call_d1", "bash", {"command": "curl http://192.168.1.10:8080/status"}, now - timedelta(seconds=100)),
        tool_result("call_d1", "bash", "connection refused", now - timedelta(seconds=90), is_error=True),
        tool_call("call_d2", "bash", {"command": "python -c 'raise ValueError'"}, now - timedelta(seconds=70)),
        tool_result("call_d2", "bash", "Traceback...", now - timedelta(seconds=60), is_error=True),
    ]


def build_stale(now: datetime) -> list[dict]:
    return [
        session("01-test-stale", r"D:\Projects\Delta", "Stale session", now - timedelta(seconds=500)),
        model_change("openai-codex/gpt-6.1-terra", now - timedelta(seconds=500)),
        tool_call("call_e1", "bash", {"command": "curl http://localhost:8000/health"}, now - timedelta(seconds=420)),
        tool_result("call_e1", "bash", "ok", now - timedelta(seconds=415)),
        tool_call("call_e2", "read", {"path": "src/util.py:1-20"}, now - timedelta(seconds=410)),
        tool_result("call_e2", "read", "x=1", now - timedelta(seconds=400)),
    ]


def build_unknown(now: datetime) -> list[dict]:
    return [
        session("01-test-unknown", r"D:\Projects\Zeta", "Mystery agent", now - timedelta(seconds=60)),
        tool_call("call_f1", "read", {"path": "notes.txt:1-10"}, now - timedelta(seconds=45)),
        tool_result("call_f1", "read", "notes", now - timedelta(seconds=40)),
    ]


def build_parent(now: datetime) -> list[dict]:
    sid = "01-test-parent"
    return [
        session(sid, r"D:\Projects\Alpha", "Parent orchestrator", now - timedelta(seconds=200)),
        model_change("openai-codex/gpt-6.1-terra", now - timedelta(seconds=200)),
        tool_call("call_p1", "bash", {"command": "echo orchestrator"}, now - timedelta(seconds=180)),
        tool_result("call_p1", "bash", "orchestrator", now - timedelta(seconds=175)),
        tool_call("call_p2", "read", {"path": "src/plan.md:1-20"}, now - timedelta(seconds=20)),
        tool_result("call_p2", "read", "plan", now - timedelta(seconds=15)),
    ]


def build_child(now: datetime, parent_path: str) -> list[dict]:
    return [
        # OMP: session.parentSession — путь к файлу родителя
        {
            "type": "session", "version": 3, "id": "01-test-child",
            "timestamp": iso(now - timedelta(seconds=170)),
            "cwd": r"D:\Projects\Alpha",
            "title": "Child worker", "titleSource": "auto",
            "parentSession": parent_path,
        },
        model_change("openai-codex/gpt-6.1-terra", now - timedelta(seconds=170)),
        tool_call("call_ch1", "write", {"path": "src/child_out.py", "content": "print(1)"}, now - timedelta(seconds=160)),
        tool_result("call_ch1", "write", "ok", now - timedelta(seconds=155)),
        assistant_final("Child done.", now - timedelta(seconds=10)),
    ]


def main() -> int:
    now = datetime.now(timezone.utc)
    builders = {
        "test-active.jsonl": build_active,
        "test-idle.jsonl": build_idle,
        "test-sleeping.jsonl": build_sleeping,
        "test-error.jsonl": build_error,
        "test-stale.jsonl": build_stale,
        "test-unknown.jsonl": build_unknown,
        "test-parent.jsonl": build_parent,
    }
    for name, fn in builders.items():
        write_jsonl(OUT / name, fn(now))
    # Child ссылается на родителя относительным путём — так же, как в реальных OMP-логах
    write_jsonl(OUT / "test-child.jsonl", build_child(now, "test-parent.jsonl"))
    print(f"Wrote {len(builders) + 1} files to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())