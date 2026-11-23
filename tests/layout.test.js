import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutScene, fitCamera, hash32 } from "../static/layout.js";

function makeFixture(n = 200) {
  const nodes = [];
  const edges = [];
  let id = 0;
  // 5 sites
  for (let i = 0; i < 5; i++) {
    nodes.push({ id: `site:${id++}`, type: "site", label: `site${i}`, data: { scope: i < 3 ? "internet" : "lan" } });
  }
  // 10 agents
  for (let i = 0; i < 10; i++) {
    nodes.push({ id: `agent:${id++}`, type: "agent", label: `agent${i}` });
  }
  // 5 projects
  for (let i = 0; i < 5; i++) {
    nodes.push({ id: `project:${id++}`, type: "project", label: `proj${i}` });
  }
  // 20 folders attached to projects
  for (let i = 0; i < 20; i++) {
    const pid = nodes.filter((n) => n.type === "project")[i % 5].id;
    const fid = `folder:${id++}`;
    nodes.push({ id: fid, type: "folder", label: `folder${i}` });
    edges.push({ source: pid, target: fid, relation: "contains" });
  }
  // 120 files attached to folders
  const folderIds = nodes.filter((n) => n.type === "folder").map((n) => n.id);
  for (let i = 0; i < 120; i++) {
    const fid = `file:${id++}`;
    nodes.push({ id: fid, type: "file", label: `file${i}.txt` });
    edges.push({ source: folderIds[i % folderIds.length], target: fid, relation: "contains" });
  }
  // 40 tools attached to agents
  const agentIds = nodes.filter((n) => n.type === "agent").map((n) => n.id);
  for (let i = 0; i < 40; i++) {
    const tid = `tool:${id++}`;
    nodes.push({ id: tid, type: "tool", label: `tool${i}` });
    edges.push({ source: agentIds[i % agentIds.length], target: tid, relation: "uses" });
  }
  return { nodes, edges };
}

test("determinism: two full runs identical", () => {
  const { nodes, edges } = makeFixture();
  const a = layoutScene(nodes, edges, new Map(), new Set());
  const b = layoutScene(nodes, edges, new Map(), new Set());
  for (const [id, p] of a) {
    const q = b.get(id);
    assert.equal(p.x, q.x, `${id}.x`);
    assert.equal(p.y, q.y, `${id}.y`);
  }
});

test("no overlaps among non-pinned (tolerance 15%)", () => {
  const { nodes, edges } = makeFixture();
  const pos = layoutScene(nodes, edges, new Map(), new Set());
  const ids = [...pos.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = pos.get(ids[i]), b = pos.get(ids[j]);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const need = (a.r || 20) + (b.r || 20) + 24;
      assert.ok(d >= need * 0.85, `overlap ${ids[i]} & ${ids[j]}: ${d} < ${need * 0.85}`);
    }
  }
});

test("incremental: adding a node does not move others", () => {
  const { nodes, edges } = makeFixture();
  const prev = layoutScene(nodes, edges, new Map(), new Set());
  const next = [...nodes, { id: "file:new", type: "file", label: "new.txt" }];
  const nextEdges = [...edges, { source: nodes.find((n) => n.type === "folder").id, target: "file:new", relation: "contains" }];
  const out = layoutScene(next, nextEdges, prev, new Set());
  for (const [id, p] of prev) {
    const q = out.get(id);
    assert.equal(q.x, p.x, `${id} moved x`);
    assert.equal(q.y, p.y, `${id} moved y`);
  }
});

test("filter change does not change positions (layout is filter-agnostic)", () => {
  const { nodes, edges } = makeFixture();
  const a = layoutScene(nodes, edges, new Map(), new Set());
  const subset = nodes.filter((n) => n.type !== "file");
  const b = layoutScene(subset, edges.filter((e) => subset.some((n) => n.id === e.source) && subset.some((n) => n.id === e.target)), a, new Set());
  for (const [id, p] of a) {
    if (!b.has(id)) continue;
    const q = b.get(id);
    assert.equal(q.x, p.x);
    assert.equal(q.y, p.y);
  }
});

test("200 nodes on 1080x1920 -> fitCamera.zoom >= 0.7", () => {
  const { nodes, edges } = makeFixture(200);
  const pos = layoutScene(nodes, edges, new Map(), new Set());
  const cam = fitCamera(pos, 1080, 1920);
  assert.ok(cam.zoom >= 0.7, `zoom=${cam.zoom}`);
});

test("hash32 is stable", () => {
  assert.equal(hash32("agent:1"), hash32("agent:1"));
  assert.notEqual(hash32("agent:1"), hash32("agent:2"));
});