// Deterministic hash + RNG. NO Math.random.
export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GOLDEN = 2.399963229728653;

function jitter(id, amount) {
  const r = mulberry32(hash32(id));
  return (r() - 0.5) * 2 * amount;
}

// Зоны — мягкие, не сетка. Координаты — экранные (1000×1600 база).
const ZONE = {
  sites: 150,
  lan: 480,
  localhost: 640,
  agents: 860,
  projects: 1280,
  folders: 1440,
  files: 1560,
};

function goldenSpiral(items, cx, cy, k, minGap) {
  const placed = [];
  for (let i = 0; i < items.length; i++) {
    const angle = i * GOLDEN;
    const radius = Math.sqrt(i + 0.5) * k;
    let x = cx + Math.cos(angle) * radius;
    let y = cy + Math.sin(angle) * radius * 0.7; // слегка сжато для изометрии
    for (let iter = 0; iter < 80; iter++) {
      let moved = false;
      for (const p of placed) {
        const dx = x - p.x, dy = y - p.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const need = p.r + minGap;
        if (d < need) {
          const push = (need - d) / 2 + 0.5;
          x += (dx / d) * push;
          y += (dy / d) * push;
          moved = true;
        }
      }
      if (!moved) break;
    }
    placed.push({ x, y, r: minGap / 2, id: items[i].id });
  }
  return placed;
}

function resolveCollisions(pos, pinned, iterations = 80) {
  const ids = [...pos.keys()].sort();
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      if (pinned.has(ids[i])) continue;
      const a = pos.get(ids[i]);
      for (let j = i + 1; j < ids.length; j++) {
        const b = pos.get(ids[j]);
        const dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const need = (a.r || 20) + (b.r || 20) + 24;
        if (d < need) {
          const push = (need - d) / 2;
          const ux = dx / d, uy = dy / d;
          if (!pinned.has(ids[i])) { a.x += ux * push; a.y += uy * push; }
          if (!pinned.has(ids[j])) { b.x -= ux * push; b.y -= uy * push; }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

function buildParentMap(edges) {
  const parentOf = new Map();
  for (const e of edges) {
    if (e.relation === "contains" || e.relation === "uses" || e.relation === "spawns") {
      if (!parentOf.has(e.target)) parentOf.set(e.target, e.source);
    }
  }
  return parentOf;
}

function walkUpToProject(startId, byId, parentOf) {
  let cur = startId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) return null;
    if (node.type === "project") return node;
    if (node.data?.project_id && byId.has(node.data.project_id)) {
      return byId.get(node.data.project_id);
    }
    cur = parentOf.get(cur);
  }
  return null;
}

/**
 * Чистая функция. previous: Map<id, Point>, pinned: Set<id>.
 * Возвращает Map<id, Point>. Детерминизм гарантирован mulberry32(hash32(id)).
 */
 function findAgentProject(agentId, byId, edges) {
  const childrenOf = new Map();
  for (const e of edges) {
    if (!["uses", "writes", "contains", "spawns"].includes(e.relation)) continue;
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source).push(e.target);
  }
  const visited = new Set([agentId]);
  const queue = [agentId];
  while (queue.length) {
    const cur = queue.shift();
    const node = byId.get(cur);
    if (node?.type === "project") return node;
    for (const child of childrenOf.get(cur) || []) {
      if (visited.has(child)) continue;
      visited.add(child);
      queue.push(child);
    }
  }
  return null;
}


export function layoutScene(nodes, edges, previous = new Map(), pinned = new Set()) {
  const pos = new Map();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parentOf = buildParentMap(edges);

  const agents = nodes.filter((n) => n.type === "agent").sort((a, b) => a.id.localeCompare(b.id));
  const projects = nodes.filter((n) => n.type === "project").sort((a, b) => a.id.localeCompare(b.id));
  const sites = nodes.filter((n) => n.type === "site").sort((a, b) => a.id.localeCompare(b.id));

  const projectMembers = new Map(projects.map((p) => [p.id, []]));
  const orphans = [];
  for (const n of nodes) {
    if (n.type === "project" || n.type === "agent" || n.type === "site") continue;
    const project = walkUpToProject(n.id, byId, parentOf);
    if (project && projectMembers.has(project.id)) projectMembers.get(project.id).push(n);
    else orphans.push(n);
  }

  if (previous.size === 0) {
    // --- Полная раскладка ---
    sites.forEach((s, i) => {
      const x = 500 + (i - (sites.length - 1) / 2) * 140;
      pos.set(s.id, { x, y: ZONE.sites + jitter(s.id, 20), r: 24 });
    });

    // Сопоставить агента с проектом через рёбра
    const agentProject = new Map();
    for (const agent of agents) {
      const project = findAgentProject(agent.id, byId, edges);
      if (project) agentProject.set(agent.id, project.id);
    }
    const agentsByProject = new Map();
    const freeAgents = [];
    for (const a of agents) {
      const pid = agentProject.get(a.id);
      if (pid && projectMembers.has(pid)) {
        if (!agentsByProject.has(pid)) agentsByProject.set(pid, []);
        agentsByProject.get(pid).push(a);
      } else {
        freeAgents.push(a);
      }
    }

    // Стабильная сетка: cols фиксирован, проекты занимают ячейки по порядку id.
    // При добавлении/удалении проекта существующие НЕ сдвигаются.
    const cols = 4;
    const cellW = 300;
    const cellH = 500;
    const gridStartX = 500 - ((cols - 1) * cellW) / 2;
    const gridStartY = ZONE.projects;

    const occupied = new Set();
    const projectCells = new Map();
    projects.forEach((p) => {
      let col = 0, row = 0;
      while (occupied.has(`${col},${row}`)) {
        col++;
        if (col >= cols) { col = 0; row++; }
      }
      occupied.add(`${col},${row}`);
      projectCells.set(p.id, { col, row });
    });

    projects.forEach((p) => {
      const { col, row } = projectCells.get(p.id);
      const cx = gridStartX + col * cellW + jitter(p.id, 30);
      const cy = gridStartY + row * cellH + jitter(p.id, 30);

      pos.set(p.id, { x: cx, y: cy, r: 52 });

      const members = projectMembers.get(p.id) || [];
      const folders = members.filter((m) => m.type === "folder");
      const files = members.filter((m) => m.type === "file");
      const tools = members.filter((m) => m.type === "tool");

      folders.forEach((f, j) => {
        const angle = (j / Math.max(1, folders.length)) * Math.PI * 2 + jitter(f.id, 0.2);
        const radius = 70 + (j % 2) * 20;
        pos.set(f.id, {
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius * 0.6 + 20,
          r: 24,
        });
      });

      const filesByFolder = new Map();
      for (const f of files) {
        const pp = parentOf.get(f.id) || p.id;
        if (!filesByFolder.has(pp)) filesByFolder.set(pp, []);
        filesByFolder.get(pp).push(f);
      }
      for (const [folderId, list] of filesByFolder) {
        const fp = pos.get(folderId) || { x: cx, y: cy, r: 24 };
        list.forEach((f, j) => {
          const angle = (j / Math.max(1, list.length)) * Math.PI * 2 + jitter(f.id, 0.4);
          const radius = 42 + jitter(f.id, 8);
          pos.set(f.id, {
            x: fp.x + Math.cos(angle) * radius,
            y: fp.y + Math.sin(angle) * radius * 0.6,
            r: 14,
          });
        });
      }

      tools.forEach((t, j) => {
        const angle = (j / Math.max(1, tools.length)) * Math.PI * 2;
        const radius = 90;
        pos.set(t.id, {
          x: cx + Math.cos(angle) * radius,
          y: cy + 80 + Math.sin(angle) * 20,
          r: 18,
        });
      });

      // Агенты проекта — над проектом, с выравниванием по X
      const pAgents = agentsByProject.get(p.id) || [];
      const perRow = 4;
      pAgents.forEach((a, j) => {
        const arow = Math.floor(j / perRow);
        const acol = j % perRow;
        const rowSize = Math.min(perRow, pAgents.length - arow * perRow);
        const ax = cx + (acol - (rowSize - 1) / 2) * 70 + jitter(a.id, 5);
        const ay = cy - 160 - arow * 70 + jitter(a.id, 6);
        pos.set(a.id, { x: ax, y: ay, r: 28 });
      });
    });

    // Свободные агенты (без проекта) — полосой сверху
    freeAgents.forEach((a, i) => {
      const perRow = 10;
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const rowSize = Math.min(perRow, freeAgents.length - row * perRow);
      const x = 500 + (col - (rowSize - 1) / 2) * 80 + jitter(a.id, 6);
      const y = ZONE.agents + row * 80 + jitter(a.id, 8);
      pos.set(a.id, { x, y, r: 28 });
    });

    // Сироты (файлы/папки без проекта)
    orphans.forEach((n, i) => {
      const angle = i * GOLDEN;
      const radius = 90 + Math.sqrt(i) * 26;
      pos.set(n.id, {
        x: 500 + Math.cos(angle) * radius,
        y: ZONE.projects + 400 + Math.sin(angle) * radius * 0.7,
        r: 18,
      });
    });

    const projectsPinned = new Set([...pinned, ...projects.map((p) => p.id)]);
    resolveCollisions(pos, projectsPinned);
    return pos;
  }

  // --- Инкрементально: сохранить существующие позиции ---
  for (const [id, p] of previous) {
    if (byId.has(id)) pos.set(id, { ...p });
  }
  const fresh = [];

  // Стабильная сетка — те же константы, что в полной ветке
  const cols = 4;
  const cellW = 300;
  const cellH = 500;
  const gridStartX = 500 - ((cols - 1) * cellW) / 2;
  const gridStartY = ZONE.projects;

  // Определяем занятые ячейки по существующим проектам
  const occupied = new Set();
  for (const p of projects) {
    const prev = previous.get(p.id);
    if (!prev) continue;
    const col = Math.round((prev.x - gridStartX) / cellW);
    const row = Math.round((prev.y - gridStartY) / cellH);
    occupied.add(`${col},${row}`);
  }

  // Фаза A: проекты — существующие из previous, новые в свободную ячейку
  for (const p of projects) {
    if (pos.has(p.id)) continue;
    let col = 0, row = 0;
    while (occupied.has(`${col},${row}`)) {
      col++;
      if (col >= cols) { col = 0; row++; }
    }
    occupied.add(`${col},${row}`);
    const x = gridStartX + col * cellW + jitter(p.id, 30);
    const y = gridStartY + row * cellH + jitter(p.id, 30);
    pos.set(p.id, { x, y, r: 52 });
    fresh.push(p.id);
  }

  // Фаза B: остальные узлы
  for (const n of nodes) {
    if (pos.has(n.id)) continue;
    const parent = parentOf.get(n.id);
    const pp = parent ? pos.get(parent) : null;
    let x, y, r;
    if (pp) {
      const angle = jitter(n.id, Math.PI);
      const radius = (pp.r || 30) + 44 + jitter(n.id, 16);
      x = pp.x + Math.cos(angle) * radius;
      y = pp.y + Math.sin(angle) * radius * 0.7;
      r = n.type === "agent" ? 34 : n.type === "project" ? 52 : 18;
    } else if (n.type === "agent") {
      const idx = agents.findIndex((a) => a.id === n.id);
      x = 500 + (idx - (agents.length - 1) / 2) * 100;
      y = ZONE.agents + jitter(n.id, 14);
      r = 34;
    } else if (n.type === "site") {
      x = 500 + jitter(n.id, 300);
      y = ZONE.sites + jitter(n.id, 20);
      r = 24;
    } else {
      // Папки/файлы/тулы без проекта — в orphans-зону
      x = 500 + jitter(n.id, 260);
      y = ZONE.projects + 120 + jitter(n.id, 160);
      r = 18;
    }
    pos.set(n.id, { x, y, r });
    fresh.push(n.id);
  }
  // Коллизия только для новых (не двигаем существующие).
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (const fid of fresh) {
      if (pinned.has(fid)) continue;
      if (fid.startsWith("project:")) continue;   // ← здесь fid ОК
      const a = pos.get(fid);
      for (const [oid, b] of pos) {
        if (oid === fid) continue;
        const dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const need = (a.r || 20) + (b.r || 20) + 24;
        if (d < need) {
          const push = need - d;
          a.x += (dx / d) * push;
          a.y += (dy / d) * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return pos;
}

export function fitCamera(positions, viewportW, viewportH, padding = 70) {
  if (positions.size === 0) return { zoom: 1, tx: viewportW / 2, ty: viewportH / 2 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x - (p.r || 0));
    maxX = Math.max(maxX, p.x + (p.r || 0));
    minY = Math.min(minY, p.y - (p.r || 0));
    maxY = Math.max(maxY, p.y + (p.r || 0));
  }
  const w = Math.max(1, maxX - minX + padding * 2);
  const h = Math.max(1, maxY - minY + padding * 2);
  const zoom = Math.min(viewportW / w, viewportH / h);
  const tx = viewportW / 2 - ((minX + maxX) / 2) * zoom;
  const ty = viewportH / 2 - ((minY + maxY) / 2) * zoom;
  return { zoom, tx, ty };
}