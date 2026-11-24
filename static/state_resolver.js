// Вычисляет визуальные состояния агентов из snapshot + фактов о вызовах инструментов.
// Не источник истины: GraphStore хранит граф, это производная.
//
// Состояния (спецификация §6, §10.3):
//   Error        — backend сообщил status === "error" (stopReason === "error")
//   Delegating   — есть живая дочерняя сессия
//   Calling tool — есть незавершённый вызов инструмента (tool.started без tool.completed)
//   Thinking     — агент активен, незавершённых вызовов нет, данные свежие
//   Waiting      — ход завершён (turn_stop / turn_complete), сессия ждёт следующий ввод
//   Completed    — ТОЛЬКО у дочернего агента: idle дольше 5 с. Корневые не завершаются никогда.
//   Idle         — прерванный ход, неизвестный жизненный цикл, устаревшие данные
//   Sleeping     — давно неактивен (визуальное приглушение, не «завершён»)

const COMPLETED_AFTER_MS = 5000;   // потомок, idle > 5 с => Completed
const WAITING_WINDOW_MS = 60000;   // после завершённого хода «ждёт ввод» столько времени

const BUSY_STATES = new Set(["Thinking", "Calling tool", "Delegating", "Waiting"]);

/**
 * @param {object} snapshot  полный граф {nodes, edges, ...}
 * @param {object} opts      { now?: number (мс), pendingByAgent?: Map<agentId, Set<callId>> }
 * @returns {Map<string, {state: string}>}
 */
export function resolveStates(snapshot, opts = {}) {
  const now = opts.now ?? Date.now();
  const pendingByAgent = opts.pendingByAgent ?? new Map();
  const result = new Map();

  const nodes = snapshot.nodes || [];
  const edges = snapshot.edges || [];

  const childrenOf = new Map();
  for (const e of edges) {
    if (e.relation !== "spawns") continue;
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source).push(e.target);
  }

  for (const n of nodes) {
    if (n.type !== "agent") continue;
    result.set(n.id, { state: baseState(n, now, pendingByAgent.get(n.id)) });
  }

  // Делегирование: обход снизу вверх, чтобы активный внук делал «Delegating» и ребёнка, и родителя.
  const done = new Set();
  const visiting = new Set();
  const settle = (id) => {
    if (done.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const kids = (childrenOf.get(id) || []).filter((k) => result.has(k));
    for (const k of kids) settle(k);
    visiting.delete(id);
    done.add(id);

    const current = result.get(id)?.state;
    if (!current || current === "Error") return;
    if (kids.some((k) => BUSY_STATES.has(result.get(k).state))) {
      result.set(id, { state: "Delegating" });
    }
  };
  for (const id of result.keys()) settle(id);

  return result;
}

function baseState(n, now, pending) {
  const ageMs = n.last_event ? now - n.last_event * 1000 : Infinity;
  const isChild = Boolean(n.parent_agent_id);
  // Snapshot (n.pending_calls) — источник истины и переживает перезагрузку страницы;
  // набор из событий даёт мгновенную реакцию между снимками.
  const hasPending = Boolean((pending && pending.size > 0) || n.pending_calls > 0);

  switch (n.status) {
    case "error":
      return "Error";
    case "active":
      if (hasPending) return "Calling tool";   // долгий вызов без событий — всё ещё Calling tool
      return n.stale ? "Idle" : "Thinking";
    case "idle":
    case "sleeping":
    case "ended": {
      if (isChild && ageMs > COMPLETED_AFTER_MS) return "Completed";
      if (n.status === "sleeping") return "Sleeping";
      if (n.status === "ended") return "Idle";
      const reason = typeof n.last_reason === "string" ? n.last_reason : "";
      const turnEnded = reason.startsWith("turn_") && reason !== "turn_aborted";
      return turnEnded && ageMs <= WAITING_WINDOW_MS ? "Waiting" : "Idle";
    }
    default:
      return "Idle";
  }
}

export const STATE_PRIORITY = [
  "Error",
  "Delegating",
  "Calling tool",
  "Thinking",
  "Waiting",
  "Completed",
  "Idle",
  "Sleeping",
];