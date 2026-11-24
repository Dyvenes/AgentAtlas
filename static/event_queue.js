// Bounded, dedup by event_id, ordered by event_id.
// Snapshot resets lastId to snapshot.last_event_id (server is source of truth).

const MAX_SIZE = 500;

export class EventQueue {
  constructor(maxSize = MAX_SIZE) {
    this.maxSize = maxSize;
    this.items = [];
    this.lastId = 0;
    this.droppedCount = 0;
  }

  push(ev) {
    if (typeof ev?.event_id !== "number") return false;
    if (ev.event_id <= this.lastId) return false;
    this.lastId = ev.event_id;
    this.items.push(ev);
    while (this.items.length > this.maxSize) {
      this.items.shift();
      this.droppedCount++;
    }
    return true;
  }

  drain() {
    const out = this.items;
    this.items = [];
    return out;
  }

  resetForSnapshot(snapshotEventId) {
    if (typeof snapshotEventId === "number") {
      this.lastId = snapshotEventId;
    }
    this.items = [];
  }
}