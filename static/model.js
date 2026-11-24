// Завершённый потомок теперь исчезает через 5 с (state_resolver: Completed → playCompletion).
// Сворачивание в «спутник» в эти 5 с давало лишь мерцание, поэтому по умолчанию выключено.
// Чтобы вернуть орбиты, поставьте true.
export const COLLAPSE_CHILDREN = false;

export function isCollapsed(child, parentInScene, expandedSet) {
  if (!COLLAPSE_CHILDREN) return false;
  if (!parentInScene) return false;
  if (child.stale) return false;
  if (child.lifecycle_known !== true) return false;
  if (!["idle", "sleeping", "ended"].includes(child.status)) return false;
  return !expandedSet.has(child.id);
}

export function orbitPosition(parentPos, index, maxVisible = 6, now = 0, reducedMotion = false) {
  if (index >= maxVisible) return null;
  const radius = (parentPos.r || 30) + 22;
  const base = (index / maxVisible) * Math.PI * 2;
  const angle = reducedMotion ? base : base + now * 0.0005;
  return {
    x: parentPos.x + Math.cos(angle) * radius,
    y: parentPos.y + Math.sin(angle) * radius * 0.45,
  };
}

export function childrenMap(edges) {
  const map = new Map();
  for (const e of edges) {
    if (e.relation !== "spawns") continue;
    if (!map.has(e.source)) map.set(e.source, []);
    map.get(e.source).push(e.target);
  }
  return map;
}

export function countDescendants(id, cmap) {
  let n = 0;
  const stack = [...(cmap.get(id) || [])];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    n++;
    stack.push(...(cmap.get(cur) || []));
  }
  return n;
}

export function activeDescendantCount(id, cmap, statusMap) {
  let n = 0;
  const stack = [...(cmap.get(id) || [])];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (statusMap.get(cur) === "active") n++;
    stack.push(...(cmap.get(cur) || []));
  }
  return n;
}

export function truncateLabel(label, max = 22) {
  const s = String(label ?? "");
  return [...s].length <= max ? s : [...s].slice(0, max).join("") + "…";
}
/**
 * Рёбра, по которым сейчас идёт передача (§7): только пока вызов инструмента не завершён.
 *  uses            агент → инструмент      — у инструмента есть незавершённый вызов
 *  writes/requests инструмент → цель       — то же
 *  spawns          родитель → потомок      — потомок активен
 * Структурные связи (works_in, contains) никогда не «пульсируют».
 * @returns {Set<string>} ключи вида "source>target:relation"
 */
export function computeActiveEdgeKeys(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hotTools = new Set(
    nodes.filter((n) => n.type === "tool" && n.pending_calls > 0).map((n) => n.id),
  );
  const keys = new Set();
  for (const e of edges) {
    let active = false;
    if (e.relation === "uses") active = hotTools.has(e.target);
    else if (e.relation === "writes" || e.relation === "requests") active = hotTools.has(e.source);
    else if (e.relation === "spawns") active = byId.get(e.target)?.status === "active";
    if (active) keys.add(`${e.source}>${e.target}:${e.relation}`);
  }
  return keys;
}