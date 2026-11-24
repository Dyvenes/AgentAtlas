// Computes 7 visual states from backend snapshot + event facts.
// Not a source of truth: GraphStore holds the actual graph; this is derived.

const COMPLETED_AFTER_MS = 5000;   // child, idle > 5s => Completed
const SLEEPING_AFTER_MS = 60000;   // any, idle > 60s => Sleeping

/**
 * @param {object} snapshot  full graph {nodes, edges, ...}
 * @param {object} opts      { now?: number, pendingToolCallIds?: Set<string>, expandedSet?: Set<string> }
 * @returns {Map<string, {state: string, pendingToolCallId?: string}>}
 */
export function resolveStates(snapshot, opts = {}) {
  const now = opts.now ?? Date.now();
  const pendingByAgent = opts.pendingByAgent ?? new Map();
  const result = new Map();

  const nodes = snapshot.nodes || [];
  const edges = snapshot.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const childrenOf = new Map();
  for (const e of edges) {
    if (e.relation !== "spawns") continue;
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source).push(e.target);
  }

  for (const n of nodes) {
    if (n.type !== "agent") continue;
    const ageMs = n.last_event ? now - n.last_event * 1000 : Infinity;
    let state = "Waiting";

    if (n.status === "error") {
      state = "Error";
    } else if (n.status === "active") {
      const pending = pendingByAgent.get(n.id);
      state = (pending && pending.size > 0) ? "Calling tool" : "Waiting";
    } else if (n.status === "idle") {
      const isChild = !!n.parent_agent_id;
      if (isChild && ageMs > COMPLETED_AFTER_MS) state = "Completed";
      else if (ageMs > SLEEPING_AFTER_MS) state = "Sleeping";
      else state = "Idle";
    } else if (n.status === "sleeping") {
      state = "Sleeping";
    } else if (n.status === "unknown") {
      state = "Idle";
    }
    result.set(n.id, { state });
  }

  for (const n of nodes) {
    if (n.type !== "agent") continue;
    const kids = childrenOf.get(n.id) || [];
    const hasActiveChild = kids.some((kidId) => {
      const s = result.get(kidId)?.state;
      return s === "Waiting" || s === "Calling tool";
    });
    if (hasActiveChild && result.get(n.id)?.state === "Waiting") {
      result.set(n.id, { state: "Delegating" });
    }
  }

  return result;
}

export const STATE_PRIORITY = [
  "Error",
  "Calling tool",
  "Delegating",
  "Waiting",
  "Completed",
  "Idle",
  "Sleeping",
];