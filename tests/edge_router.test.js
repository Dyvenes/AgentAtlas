import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../static/edge_router.js";

test("no obstacles -> straight cubic like before", () => {
  const r = route({ x: 100, y: 100 }, { x: 100, y: 300 }, []);
  assert.ok(r.d.startsWith("M100,100"));
  assert.ok(r.d.includes("C"));
});

test("obstacle between -> path detours visibly", () => {
  const a = { x: 100, y: 100 };
  const b = { x: 100, y: 400 };
  const obstacle = { x: 100, y: 250, r: 60 };
  const r = route(a, b, [obstacle]);
  // Quadratic: M ax,ay Q wx,wy bx,by
  assert.ok(r.d.includes("Q"), `expected quadratic, got ${r.d}`);
  const nums = r.d.match(/-?\d+\.?\d*/g).map(Number);
  const wx = nums[2];
  // Waypoint отстоит от линии (x=100) на DETOUR = r + 80 = 140
  assert.ok(Math.abs(wx - 100) >= 100, `waypoint should shift far, got wx=${wx}`);
});

test("parallel edges -> separated paths", () => {
  const a = { x: 100, y: 100 };
  const b = { x: 100, y: 400 };
  const r0 = route(a, b, [], 0);
  const r1 = route(a, b, [], 1);
  assert.notEqual(r0.d, r1.d);
});

test("deterministic: same input -> same output", () => {
  const a = { x: 100, y: 100 };
  const b = { x: 400, y: 100 };
  const obs = [{ x: 250, y: 100, r: 50 }];
  assert.equal(route(a, b, obs).d, route(a, b, obs).d);
});