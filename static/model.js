export function isCollapsed(child, parentInScene, expandedSet) {
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