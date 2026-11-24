import { truncateLabel, isCollapsed, orbitPosition, computeActiveEdgeKeys } from "./model.js";
import { hash32 } from "./layout.js";
import { route } from "./edge_router.js";

const NS = "http://www.w3.org/2000/svg";

const PROVIDER_COLORS = {
  anthropic: "#d97757",
  openai: "#10a37f",
  google: "#4285f4",
  meta: "#0866ff",
  mistral: "#ff7000",
  cohere: "#39c4b7",
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function sprite(type, node, extra = {}) {
  const g = document.createElementNS(NS, "g");
  if (type === "agent") {
    const provider = String(node.provider || "").toLowerCase();
    const color = PROVIDER_COLORS[provider] || "#EDF5FF";
    const known = Boolean(node.provider);
    // Диамонд-основание
    g.append(el("path", { d: "M-30,10 L0,26 L30,10 L0,-6 Z", fill: "rgba(82,230,255,0.08)", stroke: "rgba(82,230,255,0.35)", "stroke-width": 1 }));
    if (known) {
      g.append(el("rect", { x: -20, y: -22, width: 40, height: 32, rx: 6, fill: color, opacity: 0.9, stroke: "#080B19", "stroke-width": 1.5 }));
      const txt = el("text", { x: 0, y: -2, "text-anchor": "middle", "font-size": 14, "font-weight": 700, fill: "#080B19" });
      txt.textContent = provider.slice(0, 2).toUpperCase();
      g.append(txt);
      if (extra.ordinal && extra.total > 1) {
        const ord = el("text", { x: 22, y: 22, "text-anchor": "middle", "font-size": 9, fill: "#EDF5FF", opacity: 0.75 });
        ord.textContent = `#${extra.ordinal}`;
        g.append(ord);
      }
    } else {
      g.append(el("rect", { x: -18, y: -20, width: 36, height: 30, rx: 8, fill: "#162343", stroke: "#52E6FF", "stroke-width": 1.2 }));
      g.append(el("circle", { cx: -7, cy: -6, r: 2.5, fill: "#52E6FF" }));
      g.append(el("circle", { cx: 7, cy: -6, r: 2.5, fill: "#52E6FF" }));
      g.append(el("line", { x1: 0, y1: -20, x2: 0, y2: -28, stroke: "#52E6FF", "stroke-width": 1.2 }));
      g.append(el("circle", { cx: 0, cy: -30, r: 2, fill: "#FF67D8" }));
    }
    const aura = el("circle", { r: 38, fill: "url(#agentAura)", class: "aura" });
    g.prepend(aura);
  } else if (type === "project") {
    for (let i = 0; i < 3; i++) {
      g.append(el("path", {
        d: `M-28,${6 + i * 6} L0,${20 + i * 6} L28,${6 + i * 6} L0,${-8 + i * 6} Z`,
        fill: `rgba(159,139,255,${0.65 - i * 0.15})`,
        stroke: "rgba(159,139,255,0.9)",
        "stroke-width": 1,
      }));
    }
  } else if (type === "folder") {
    g.append(el("path", { d: "M-26,4 L0,16 L26,4 L0,-8 Z", fill: "rgba(255,210,122,0.85)", stroke: "#FFD27A", "stroke-width": 1 }));
    g.append(el("path", { d: "M-26,4 L-26,-10 L-8,-10 L-3,-16 L26,-16 L26,4 L0,16 Z", fill: "rgba(255,210,122,0.35)", stroke: "#FFD27A", "stroke-width": 1 }));
  } else if (type === "file") {
    g.append(el("path", { d: "M-22,8 L0,20 L22,8 L0,-4 Z", fill: "rgba(237,245,255,0.9)", stroke: "#52E6FF", "stroke-width": 1 }));
    g.append(el("path", { d: "M-22,8 L-22,-14 L10,-14 L22,-6 L22,8 L0,20 Z", fill: "rgba(237,245,255,0.55)", stroke: "#52E6FF", "stroke-width": 1 }));
    g.append(el("path", { d: "M10,-14 L10,-6 L22,-6 Z", fill: "rgba(82,230,255,0.4)" }));
    const ext = node.extension || "";
    if (ext) {
      const t = el("text", { x: 0, y: 6, "text-anchor": "middle", "font-size": 8, fill: "#080B19", "font-weight": 700 });
      t.textContent = ext.toUpperCase();
      g.append(t);
    }
  } else if (type === "tool") {
    g.append(el("polygon", { points: "0,-22 19,-11 19,11 0,22 -19,11 -19,-11", fill: "rgba(255,103,216,0.18)", stroke: "#FF67D8", "stroke-width": 1.2 }));
    g.append(el("circle", { cx: 0, cy: -4, r: 5, fill: "none", stroke: "#FF67D8", "stroke-width": 1.5 }));
    g.append(el("rect", { x: -1.5, y: -2, width: 3, height: 12, fill: "#FF67D8" }));
  } else if (type === "site") {
    g.append(el("circle", { r: 18, fill: "rgba(82,230,255,0.12)", stroke: "#52E6FF", "stroke-width": 1 }));
    g.append(el("ellipse", { rx: 18, ry: 7, fill: "none", stroke: "#52E6FF", "stroke-width": 0.8 }));
    g.append(el("ellipse", { rx: 7, ry: 18, fill: "none", stroke: "#52E6FF", "stroke-width": 0.8 }));
  }
  return g;
}

function edgePath(a, b) {
  const dy = b.y - a.y;
  const c1x = a.x + (b.x - a.x) * 0.5;
  const c1y = a.y + dy * 0.45;
  const c2x = c1x;
  const c2y = b.y - dy * 0.45;
  if (Math.abs(dy) < 20) {
    return `M${a.x},${a.y} C${a.x},${a.y - 60} ${b.x},${b.y - 60} ${b.x},${b.y}`;
  }
  return `M${a.x},${a.y} C${c1x},${c1y} ${c2x},${c2y} ${b.x},${b.y}`;
}

function getTranslate(el) {
  const t = el.getAttribute?.("transform") || "";
  const m = t.match(/translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
}

export function buildDefs(svg) {
  const defs = el("defs");
  defs.append(el("radialGradient", { id: "agentAura" }, [
    el("stop", { offset: "0%", "stop-color": "#52E6FF", "stop-opacity": 0.55 }),
    el("stop", { offset: "100%", "stop-color": "#52E6FF", "stop-opacity": 0 }),
  ]));
  defs.append(el("radialGradient", { id: "mist" }, [
    el("stop", { offset: "0%", "stop-color": "#162343", "stop-opacity": 0.9 }),
    el("stop", { offset: "100%", "stop-color": "#162343", "stop-opacity": 0 }),
  ]));
    defs.append(el("filter", { id: "glow", x: "-20%", y: "-20%", width: "140%", height: "140%" }, [
    el("feGaussianBlur", { stdDeviation: "2", result: "coloredBlur" }),
    el("feMerge", {}, [
      el("feMergeNode", { in: "coloredBlur" }),
      el("feMergeNode", { in: "SourceGraphic" }),
    ]),
  ]));
  defs.append(el("filter", { id: "impulseGlow", x: "-50%", y: "-50%", width: "200%", height: "200%" }, [
    el("feGaussianBlur", { stdDeviation: "1.5", result: "blur" }),
    el("feMerge", {}, [
      el("feMergeNode", { in: "blur" }),
      el("feMergeNode", { in: "SourceGraphic" }),
    ]),
  ]));
  svg.append(defs);
}

/**
 * Дифференциальный рендер:
 * - при изменении topology пересобирает слои
 * - при обновлении статусов только обновляет классы
 */
export class SceneRenderer {
  constructor(svg) {
    this.svg = svg;
    buildDefs(svg);
    this.islandLayer = el("g", { class: "islands", "pointer-events": "none" });
    this.cloudLayer = el("g", { class: "clouds" });
    this.edgeLayer = el("g", { class: "edges" });
    this.impulseLayer = el("g", { class: "impulses" });
    this.nodeLayer = el("g", { class: "nodes" });
    this.completionLayer = el("g", { class: "completions", "pointer-events": "none" });
    svg.append(this.islandLayer, this.cloudLayer, this.edgeLayer, this.impulseLayer, this.nodeLayer, this.completionLayer);
    this.topologyKey = "";
    this.nodeEls = new Map();
    this.edgeEls = new Map();
    this.positions = new Map();
    this.impulseEls = new Map();
    this.activeEdgeKeys = new Set();
    this.reducedMotion = false;
    this._orbitState = new Map();   // childId → { parentId, idx }
    this._orbitRaf = 0;
  }

  setCamera(camera) {
    this.svg.setAttribute("viewBox", `0 0 ${camera.viewW} ${camera.viewH}`);
    const t = `translate(${camera.tx},${camera.ty}) scale(${camera.zoom})`;
    this.islandLayer.setAttribute("transform", t);
    this.cloudLayer.setAttribute("transform", t);
    this.edgeLayer.setAttribute("transform", t);
    this.impulseLayer.setAttribute("transform", t);
    this.nodeLayer.setAttribute("transform", t);
    this.completionLayer.setAttribute("transform", t);
  }

  update(snapshot, positions, opts = {}) {
    const { expandedSet = new Set(), reducedMotion = false, onSelect, states = new Map(), removed = new Set() } = opts;
    this.positions = positions;

    const MAX_FILES = 400;
    const MAX_FOLDERS = 200;
    const MAX_EDGES = 2500;

    const files = snapshot.nodes.filter((n) => n.type === "file")
      .sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0)).slice(0, MAX_FILES);
    const folders = snapshot.nodes.filter((n) => n.type === "folder")
      .sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0)).slice(0, MAX_FOLDERS);
    const keepIds = new Set([
      ...snapshot.nodes.filter((n) => !["file", "folder"].includes(n.type)).map((n) => n.id),
      ...files.map((n) => n.id),
      ...folders.map((n) => n.id),
    ]);
    const nodes = snapshot.nodes.filter((n) => keepIds.has(n.id));

    let edges = snapshot.edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target));
    if (edges.length > MAX_EDGES) {
      const priority = { spawns: 0, works_in: 1, contains: 2, uses: 3, writes: 4, requests: 5 };
      edges = [...edges]
        .sort((a, b) => (priority[a.relation] ?? 9) - (priority[b.relation] ?? 9))
        .slice(0, MAX_EDGES);
    }

    const byId = new Map(nodes.map((n) => [n.id, n]));

    const obstacles = nodes
      .filter((n) => n.type === "project")
      .map((n) => {
        const p = positions.get(n.id);
        return p ? { x: p.x, y: p.y, r: p.r || 52 } : null;
      })
      .filter(Boolean);
    this._obstacles = obstacles;

    const cmap = new Map();
    for (const e of edges) {
      if (e.relation !== "spawns") continue;
      if (!cmap.has(e.source)) cmap.set(e.source, []);
      cmap.get(e.source).push(e.target);
    }

    // Compute collapsed orbit positions
    const orbitFor = new Map();
    const orbitIndex = new Map();
    for (const n of nodes) {
      if (n.type !== "agent") continue;
      const parentEdge = edges.find((e) => e.target === n.id && e.relation === "spawns");
      if (!parentEdge) continue;
      const parent = byId.get(parentEdge.source);
      if (!parent) continue;
      if (!isCollapsed(n, true, expandedSet)) continue;
      const idx = orbitIndex.get(parent.id) || 0;
      orbitIndex.set(parent.id, idx + 1);
      const parentPos = positions.get(parent.id);
      if (!parentPos) continue;
      const p = orbitPosition(parentPos, idx, 6, performance.now(), reducedMotion);
      if (p) orbitFor.set(n.id, p);
    }

    // Hide collapsed nodes fully
    const hidden = new Set();
    for (const n of nodes) {
      if (orbitFor.has(n.id)) {
        hidden.add(n.id);
        continue;
      }
      const parentEdge = edges.find((e) => e.target === n.id && e.relation === "spawns");
      if (parentEdge) {
        const parent = byId.get(parentEdge.source);
        if (parent && isCollapsed(n, true, expandedSet)) {
          // Hidden because parent is visible but child collapsed elsewhere
          const pPos = positions.get(parent.id);
          if (pPos && !expandedSet.has(n.id)) {
            // orbit handled above; if beyond 6, just hide
            hidden.add(n.id);
          }
        }
      }
    }

    // Topology key: node ids + edge triples
    const key = nodes.map((n) => n.id).join("|") + "#" + edges.map((e) => `${e.source}>${e.target}:${e.relation}`).join("|") + "@" + [...expandedSet].sort().join(",") + "!" + [...removed].sort().join(",");

    // Сброс импульсов, если изменился reducedMotion
    if (this.reducedMotion !== reducedMotion) {
      this.reducedMotion = reducedMotion;
      for (const dots of this.impulseEls.values()) dots.forEach((d) => d.remove());
      this.impulseEls.clear();
      this.activeEdgeKeys = new Set();
    }

    if (key !== this.topologyKey) {
      this.topologyKey = key;
      this._rebuild(nodes, edges, byId, positions, orbitFor, hidden, onSelect, states, removed, obstacles);
    } else {
      this._updateStates(nodes, orbitFor, hidden, states);
    }
    this._updateImpulses(nodes, edges);
  }

  _rebuild(nodes, edges, byId, positions, orbitFor, hidden, onSelect, states = new Map(), removed = new Set(), obstacles = []) {
    this.stopOrbitAnimation();
    this._orbitState.clear();    
    this.impulseLayer.replaceChildren();
    this.impulseEls.clear();
    this.activeEdgeKeys.clear();
    this.edgeLayer.replaceChildren();   
    this.nodeLayer.replaceChildren();
    this.cloudLayer.replaceChildren();
    this.nodeEls.clear();
    this.edgeEls.clear();

    this.islandLayer.replaceChildren();
    this._buildIslands(nodes, edges, byId, positions);


    // Provider ordinals for identical emblems (plan: "порядковый номер, стабильный по agent.id")
    const agentOrdinals = new Map();
    const providerCounts = new Map();
    {
      const byProvider = new Map();
      for (const n of nodes) {
        if (n.type !== "agent" || !n.provider) continue;
        if (!byProvider.has(n.provider)) byProvider.set(n.provider, []);
        byProvider.get(n.provider).push(n);
        providerCounts.set(n.provider, (providerCounts.get(n.provider) || 0) + 1);
      }
      for (const list of byProvider.values()) {
        list.sort((a, b) => a.id.localeCompare(b.id));
        list.forEach((n, i) => agentOrdinals.set(n.id, i + 1));
      }
    }



    // Clouds: internet / lan / localhost — постоянные зоны (§3.3), видны даже без серверов
    this.cloudLayer.append(this._cloud(500, 150, 460, 110, "#52E6FF"));
    this.cloudLayer.append(this._cloud(500, 480, 320, 80, "#9F8BFF"));
    this.cloudLayer.append(this._cloud(500, 640, 280, 70, "#FF67D8"));

    // Edges
    // Edges — collapsed children re-anchor to their orbit position
    // Edges — collapsed children re-anchor to their orbit position
    const pairCounts = new Map();    
    for (const e of edges) {
      let a = positions.get(e.source);
      let b = positions.get(e.target);
      
      if (!b && orbitFor.has(e.target) && positions.has(e.source)) {
        b = orbitFor.get(e.target);
      }
      if (!a && orbitFor.has(e.source) && positions.has(e.target)) {
        a = orbitFor.get(e.source);
      }
      if (!a || !b) continue;
      const srcHidden = hidden.has(e.source) && !orbitFor.has(e.source);
      const dstHidden = hidden.has(e.target) && !orbitFor.has(e.target);
      if (srcHidden || dstHidden) continue;
      if (removed.has(e.source) || removed.has(e.target)) continue;
      const isSpawn = e.relation === "spawns";

      const pairKey = `${e.source}>${e.target}`;
      const parallelIndex = pairCounts.get(pairKey) || 0;
      pairCounts.set(pairKey, parallelIndex + 1);

      const routed = route(a, b, obstacles, parallelIndex);
      const path = el("path", {
        d: routed.d,
        class: `edge ${e.relation}${isSpawn && orbitFor.has(e.target) ? " spawns-collapsed" : ""}`,
        "data-source": e.source,
        "data-target": e.target,
      });
      this.edgeLayer.append(path);
      this.edgeEls.set(`${e.source}>${e.target}:${e.relation}`, path);
    }

    // Nodes
    for (const n of nodes) {
      if (hidden.has(n.id) || removed.has(n.id)) continue;
      const p = positions.get(n.id);
      if (!p) continue;
      const resolved = states.get(n.id)?.state;
      const g = el("g", {
        class: `node type-${n.type} status-${n.status || "unknown"}${n.stale ? " stale" : ""}`,
        "data-state": resolved || (n.type === "agent" ? "Idle" : ""),
        transform: `translate(${p.x},${p.y})`,
        tabindex: 0,
        role: "button",
        "aria-label": `${n.type}: ${n.label}`,
        "data-id": n.id,
      });

      const inner = el("g", { class: "drift" });
      const seed = hash32(n.id);
      const amp = 3 + (seed % 4);                   // 3–6 ед.
      const dur = 5 + ((seed >> 8) % 500) / 100;    // 5–9 s
      const delay = -((seed >> 16) % 900) / 100;    // -0 … -9 s
      inner.style.setProperty("--amp", `${amp}px`);
      inner.style.setProperty("--dur", `${dur}s`);
      inner.style.setProperty("--delay", `${delay}s`);

      inner.append(sprite(n.type, n, {
        ordinal: agentOrdinals.get(n.id),
        total: n.provider ? (providerCounts.get(n.provider) || 0) : 0,
      }));
      const showLabel = n.type !== "agent" || !n.provider;
      if (showLabel) {
        const label = el("text", { class: "label", y: 48, "text-anchor": "middle" });
        label.textContent = truncateLabel(n.label);
        inner.append(label);
      }
      const staleBadge = el("text", { class: "stale-badge", x: 22, y: -22, "text-anchor": "middle" });
      staleBadge.textContent = n.stale ? "?" : "";
      inner.append(staleBadge);
      if (n.status === "ended") {
        const check = el("text", { class: "ended-check", x: 22, y: -22, "text-anchor": "middle" });
        check.textContent = "✓";
        inner.append(check);
      }
      if (n.status === "error") {
        const bang = el("text", { class: "error-bang", x: 22, y: -22, "text-anchor": "middle" });
        bang.textContent = "!";
        inner.append(bang);
      }
      g.append(inner);
      this.nodeLayer.append(g);
      this.nodeEls.set(n.id, g);
    }

    // Orbit satellites (beyond visible children)
    // Orbit satellites (beyond visible children)
    // Orbit satellites
    this._orbitState.clear();
    for (const [childId, orbit] of orbitFor) {
      if (!orbit) continue;
      if (removed.has(childId)) continue;
      const child = byId.get(childId);
      const childState = states.get(childId)?.state;

      const parentEdge = edges.find((e) => e.target === childId && e.relation === "spawns");
      if (!parentEdge) continue;
      let idx = 0;
      for (const otherChild of orbitFor.keys()) {
        if (otherChild === childId) break;
        const oe = edges.find((e) => e.target === otherChild && e.relation === "spawns");
        if (oe && oe.source === parentEdge.source) idx++;
      }
      const g = el("g", {
        class: `orbit-satellite status-${child.status}`,
        "data-state": childState || "",
        transform: `translate(${orbit.x},${orbit.y})`,
        "data-orbit": childId,
        tabindex: 0,
        role: "button",
        "aria-label": `child of ${parentEdge.source}: ${child.label}`,
      });
      g.append(el("circle", { r: 6, fill: "#52E6FF", opacity: 0.7 }));
      g.addEventListener("click", () => { if (onSelect) onSelect(childId); });
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (onSelect) onSelect(childId);
        }
      });
      this.nodeLayer.append(g);
      this._orbitState.set(childId, { parentId: parentEdge.source, idx });
    }
    if (this._orbitState.size > 0) this.startOrbitAnimation();
    else this.stopOrbitAnimation();
  }

  _cloud(cx, cy, w, h, color) {
    const g = el("g", { class: "cloud", opacity: 0.5 });
    g.append(el("ellipse", { cx, cy, rx: w / 2, ry: h / 2, fill: color, opacity: 0.08 }));
    g.append(el("ellipse", { cx: cx - w / 4, cy: cy - 10, rx: w / 3, ry: h / 2.4, fill: color, opacity: 0.06 }));
    g.append(el("ellipse", { cx: cx + w / 4, cy: cy - 10, rx: w / 3, ry: h / 2.4, fill: color, opacity: 0.06 }));
    g.append(el("ellipse", { cx, cy, rx: w / 2, ry: h / 2, fill: "none", stroke: color, "stroke-width": 0.8, opacity: 0.5 }));
    return g;
  }

  _updateStates(nodes, orbitFor, hidden, states = new Map()) {
    for (const n of nodes) {
      const g = this.nodeEls.get(n.id);
      if (!g) continue;
      g.classList.remove("status-active", "status-idle", "status-sleeping", "status-ended", "status-error", "status-unknown");
      g.classList.add(`status-${n.status || "unknown"}`);
      g.classList.toggle("stale", Boolean(n.stale));
      const resolved = states.get(n.id)?.state;
      if (resolved) g.setAttribute("data-state", resolved);
      const badge = g.querySelector(".stale-badge");
      if (badge) badge.textContent = n.stale ? "?" : "";
    }
    for (const [childId] of orbitFor) {
      const sat = this.nodeLayer.querySelector(`[data-orbit="${CSS.escape(childId)}"]`);
      const resolved = states.get(childId)?.state;
      if (sat && resolved) sat.setAttribute("data-state", resolved);
    }
  }

  _updateImpulses(nodes, edges) {
    // --- Найти активные рёбра: только по реальным незавершённым вызовам ---
    const activeKeys = computeActiveEdgeKeys(nodes, edges);
    const newActiveKeys = new Set();
    for (const key of activeKeys) {
      if (this.edgeEls.has(key)) newActiveKeys.add(key);
    }

    // --- Снять импульсы и active-класс с рёбер, которые больше не активны ---
    for (const key of this.activeEdgeKeys) {
      if (newActiveKeys.has(key)) continue;
      const path = this.edgeEls.get(key);
      if (path) path.classList.remove("active");
      const dots = this.impulseEls.get(key);
      if (dots) {
        for (const d of dots) d.remove();
        this.impulseEls.delete(key);
      }
    }

    // --- Добавить импульсы и active-класс новым активным рёбрам ---
    for (const key of newActiveKeys) {
      const path = this.edgeEls.get(key);
      if (!path) continue;
      path.classList.add("active");
      if (this.reducedMotion) continue;
      if (this.impulseEls.has(key)) continue;    // уже анимируется
      const d = path.getAttribute("d");
      if (!d) continue;
      const dots = [];
      for (let i = 0; i < 3; i++) {
        const dot = el("circle", {
          r: 2.5,
          fill: "#52E6FF",
          "pointer-events": "none",
          "data-impulse": key,
        });
        dot.append(el("animateMotion", {
          dur: "1.8s",
          repeatCount: "indefinite",
          path: d,
          begin: `${(-i * 0.6).toFixed(2)}s`,
        }));
        this.impulseLayer.append(dot);
        dots.push(dot);
      }
      this.impulseEls.set(key, dots);
    }

    this.activeEdgeKeys = newActiveKeys;
  }

    _buildIslands(nodes, edges, byId, positions) {
    const projects = nodes.filter((n) => n.type === "project");
    if (projects.length === 0) return;

    // memberCount: папки, файлы и агенты проекта (у всех есть project_id)
    const memberCount = new Map();
    for (const n of nodes) {
      const pid = n.project_id;
      if (pid) memberCount.set(pid, (memberCount.get(pid) || 0) + 1);
    }

    for (const p of projects) {
      const pos = positions.get(p.id);
      if (!pos) continue;
      const count = Math.max(1, memberCount.get(p.id) || 0);
      const R = 60 + 14 * Math.sqrt(count);
      const variant = "crystal_floating_platform";
      const w = R * 3.2;
      const h = R * 1.2;
      this.islandLayer.append(el("image", {
        href: `/static/sprites/${variant}.webp`,
        x: pos.x - w / 2,
        y: pos.y + 30 - h / 2,
        width: w,
        height: h,
        preserveAspectRatio: "xMidYMid meet",
        opacity: 0.5,
        "pointer-events": "none",
      }));
    }
  }

  startOrbitAnimation() {
    if (this._orbitRaf) return;
    const tick = () => {
      if (document.hidden) {
        this._orbitRaf = 0;
        return;
      }
      this._tickOrbits();
      this._orbitRaf = requestAnimationFrame(tick);
    };
    this._orbitRaf = requestAnimationFrame(tick);
  }

  stopOrbitAnimation() {
    if (this._orbitRaf) {
      cancelAnimationFrame(this._orbitRaf);
      this._orbitRaf = 0;
    }
  }

  _tickOrbits() {
    if (this._orbitState.size === 0) return;
    const now = performance.now();
    for (const [childId, state] of this._orbitState) {
      const parentPos = this.positions.get(state.parentId);
      if (!parentPos) continue;
      const p = orbitPosition(parentPos, state.idx, 6, now, this.reducedMotion);
      if (!p) continue;
      const g = this.nodeLayer.querySelector(`[data-orbit="${CSS.escape(childId)}"]`);
      if (g) g.setAttribute("transform", `translate(${p.x},${p.y})`);
      // Обновить ребро spawns к орбите
      const edgeKey = `${state.parentId}>${childId}:spawns`;
      const edge = this.edgeEls.get(edgeKey);
      if (edge) {
        const a = this.positions.get(state.parentId);
        if (a) edge.setAttribute("d", route(a, p, this._obstacles || []).d);
      }
    }
  }

  playCompletion(childId, parentId, onDone) {
    if (this.reducedMotion) {
      if (onDone) onDone();
      return;
    }
    const childEl = this.nodeEls.get(childId)
      || this.nodeLayer.querySelector(`[data-orbit="${CSS.escape(childId)}"]`);
    const start = childEl ? getTranslate(childEl) : null;
    const parentPos = this.positions.get(parentId);
    if (!start || !parentPos) {
      if (onDone) onDone();
      return;
    }
    const end = parentPos;
    const path = `M${start.x},${start.y} L${end.x},${end.y}`;

    const N = 6;
    const particles = [];
    for (let i = 0; i < N; i++) {
      const c = el("circle", {
        r: 4,
        fill: "#52E6FF",
        class: "completion-particle",
      });
      const begin = `${(i * 0.03).toFixed(2)}s`;
      c.append(el("animateMotion", {
        path, dur: "0.6s", begin, fill: "remove",
      }));
      c.append(el("animate", {
        attributeName: "opacity",
        from: "1", to: "0", dur: "0.6s", begin, fill: "remove",
      }));
      this.completionLayer.append(c);
      particles.push(c);
    }

    if (childEl) {
      childEl.style.transition = "opacity 400ms ease-out";
      childEl.style.opacity = "0";
    }

    setTimeout(() => {
      for (const p of particles) p.remove();
      if (onDone) onDone();
    }, 650);
  }

  toggleEdgeActive(sourceId, targetId, active) {
    for (const [key, path] of this.edgeEls) {
      if (key.startsWith(`${sourceId}>${targetId}:`) || key.startsWith(`${targetId}>${sourceId}:`)) {
        path.classList.toggle("active", active);
      }
    }
  }
}