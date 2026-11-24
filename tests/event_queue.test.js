import { test } from "node:test";
import assert from "node:assert/strict";
import { EventQueue } from "../static/event_queue.js";

test("dedup by event_id", () => {
  const q = new EventQueue(10);
  assert.equal(q.push({ event_id: 1 }), true);
  assert.equal(q.push({ event_id: 1 }), false);
  assert.equal(q.push({ event_id: 2 }), true);
  assert.equal(q.push({ event_id: 0 }), false);
  assert.equal(q.drain().length, 2);
});

test("bounded overflow drops oldest", () => {
  const q = new EventQueue(3);
  q.push({ event_id: 1 });
  q.push({ event_id: 2 });
  q.push({ event_id: 3 });
  q.push({ event_id: 4 });
  const items = q.drain();
  assert.deepEqual(items.map((e) => e.event_id), [2, 3, 4]);
  assert.equal(q.droppedCount, 1);
});

test("resetForSnapshot advances lastId", () => {
  const q = new EventQueue(10);
  q.push({ event_id: 5 });
  q.resetForSnapshot(10);
  assert.equal(q.push({ event_id: 8 }), false);
  assert.equal(q.push({ event_id: 11 }), true);
});

test("resetForSnapshot can lower lastId (server restart)", () => {
  const q = new EventQueue(10);
  q.push({ event_id: 999 });
  q.resetForSnapshot(3);
  assert.equal(q.push({ event_id: 2 }), false);
  assert.equal(q.push({ event_id: 4 }), true);
});