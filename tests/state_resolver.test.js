import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStates } from "../static/state_resolver.js";

const NOW = 1000000;

function snap(nodes, edges = []) {
  return {
    nodes: nodes.map((n) => ({
      last_event: NOW / 1000 - (n.ageSec || 0),
      stale: false,
      lifecycle_known: true,
      ...n,
    })),
    edges,
  };
}

test("active without pending tool = Waiting", () => {
  const s = snap([{ id: "a1", type: "agent", status: "active", ageSec: 5 }]);
  const r = resolveStates(s, { now: NOW });
  assert.equal(r.get("a1").state, "Waiting");
});

test("active with pending tool = Calling tool", () => {
  const s = snap([{ id: "a1", type: "agent", status: "active", ageSec: 5 }]);
  const r = resolveStates(s, {
    now: NOW,
    pendingByAgent: new Map([["a1", new Set(["call_x"])]]),
  });
  assert.equal(r.get("a1").state, "Calling tool");
});

test("idle < 60s = Idle", () => {
  const s = snap([{ id: "a1", type: "agent", status: "idle", ageSec: 10 }]);
  const r = resolveStates(s, { now: NOW });
  assert.equal(r.get("a1").state, "Idle");
});

test("idle > 60s = Sleeping", () => {
  const s = snap([{ id: "a1", type: "agent", status: "idle", ageSec: 90 }]);
  const r = resolveStates(s, { now: NOW });
  assert.equal(r.get("a1").state, "Sleeping");
});

test("child idle > 5s = Completed", () => {
  const s = snap([
    { id: "a1", type: "agent", status: "active", ageSec: 2 },
    {
      id: "a2", type: "agent", status: "idle", ageSec: 8,
      parent_agent_id: "a1",
    },
  ], [{ source: "a1", target: "a2", relation: "spawns" }]);
  const r = resolveStates(s, { now: NOW });
  assert.equal(r.get("a2").state, "Completed");
});

test("root idle > 5s stays Idle (not Completed)", () => {
  const s = snap([{ id: "a1", type: "agent", status: "idle", ageSec: 8 }]);
  const r = resolveStates(s, { now: NOW });
  assert.equal(r.get("a1").state, "Idle");
});

test("parent of active child = Delegating", () => {
  const s = snap([
    { id: "a1", type: "agent", status: "active", ageSec: 2 },
    {
      id: "a2", type: "agent", status: "active", ageSec: 3,
      parent_agent_id: "a1",
    },
  ], [{ source: "a1", target: "a2", relation: "spawns" }]);
  const r = resolveStates(s, { now: NOW });
  assert.equal(r.get("a1").state, "Delegating");
  assert.equal(r.get("a2").state, "Waiting");
});

test("error wins over everything", () => {
  const s = snap([{ id: "a1", type: "agent", status: "error", ageSec: 5 }]);
  const r = resolveStates(s, {
    now: NOW,
    pendingByAgent: new Map([["a1", new Set(["call_x"])]]),
  });
  assert.equal(r.get("a1").state, "Error");
});