import { layoutScene, fitCamera } from "./layout.js";
import { DustField } from "./dust.js";
import { SceneRenderer } from "./render.js";
import { truncateLabel, childrenMap, countDescendants, activeDescendantCount } from "./model.js";

const svg = document.getElementById("scene");
const tooltip = document.getElementById("tooltip");
const card = document.getElementById("card");
const drawer = document.getElementById("drawer");
const drawerBody = document.getElementById("drawer-body");
const drawerClose = document.getElementById("drawer-close");
const menuBtn = document.getElementById("menu-btn");
const menuPanel = document.getElementById("menu-panel");
const searchInput = document.getElementById("search-input");
const fitBtn = document.getElementById("fit-btn");
const accessibleList = document.getElementById("accessible-list");

const statNodes = document.getElementById("stat-nodes");
const statEdges = document.getElementById("stat-edges");
const statWindow = document.getElementById("stat-window");

const renderer = new SceneRenderer(svg);
let snapshot = { nodes: [], edges: [] };
let positions = new Map();
let previousPositions = new Map();
let expandedSet = new Set();
let selectedId = null;
let topologyKey = "";

// Camera: "fit" = automatic, "manual" = user has zoomed/panned.
let cameraMode = "fit";
let cameraState = null;
let drag = null;

// Search: null = inactive, Set<id> = matching ids.
let searchMatches = null;

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function topologySignature(snap) {
  return snap.nodes.map((n) => n.id).sort().join("|") + "#" +
    snap.edges.map((e) => `${e.source}>${e.target}:${e.relation}`).sort().join("|");
}

function applyCamera() {
  if (!cameraState) return;
  renderer.setCamera({
    ...cameraState,
    viewW: window.innerWidth,
    viewH: window.innerHeight,
  });
}

function fitView() {
  cameraState = fitCamera(positions, window.innerWidth, window.innerHeight);
  cameraMode = "fit";
  applyCamera();
}

function applySnapshot(snap) {
  snapshot = snap;
  const sig = topologySignature(snap);
  if (sig !== topologyKey) {
    topologyKey = sig;
    previousPositions = positions;
    positions = layoutScene(snap.nodes, snap.edges, previousPositions, new Set());
    if (cameraMode === "fit" || !cameraState) {
      cameraState = fitCamera(positions, window.innerWidth, window.innerHeight);
    }
  }
  if (!cameraState) {
    cameraState = fitCamera(positions, window.innerWidth, window.innerHeight);
  }
  applyCamera();
  renderer.update(snap, positions, {
    expandedSet,
    reducedMotion: prefersReducedMotion,
    onSelect: selectNode,
  });
  if (searchMatches) applySearchHighlight();
  refreshCard();
  refreshAccessibleList();
  updateMenuStats(snap);
}

function updateMenuStats(snap) {
  statNodes.textContent = String(snap.nodes.length);
  statEdges.textContent = String(snap.edges.length);
  const w = snap.resource_window;
  statWindow.textContent = w ? `${Math.round(w / 60)} мин` : "—";
}

function selectNode(id) {
  selectedId = id;
  const node = snapshot.nodes.find((n) => n.id === id);
  if (!node) return;
  const parentEdge = snapshot.edges.find((e) => e.target === id && e.relation === "spawns");
  if (parentEdge && !expandedSet.has(id) && !node.stale
      && ["idle", "sleeping", "ended"].includes(node.status)) {
    expandedSet.add(id);
    renderer.update(snapshot, positions, {
      expandedSet,
      reducedMotion: prefersReducedMotion,
      onSelect: selectNode,
    });
  }
  refreshCard();
  refreshDrawer();
}

function deselect() {
  selectedId = null;
  card.hidden = true;
  drawer.hidden = true;
}

function refreshCard() {
  if (!selectedId) { card.hidden = true; return; }
  const node = snapshot.nodes.find((n) => n.id === selectedId);
  if (!node) { card.hidden = true; return; }
  const p = positions.get(node.id);
  const cam = cameraState;
  if (!p || !cam) { card.hidden = true; return; }
  const sx = p.x * cam.zoom + cam.tx;
  const sy = p.y * cam.zoom + cam.ty;
  card.hidden = false;
  card.style.left = `${Math.min(window.innerWidth - 260, Math.max(20, sx + 30))}px`;
  card.style.top = `${Math.min(window.innerHeight - 120, Math.max(20, sy - 40))}px`;
  const cmap = childrenMap(snapshot.edges);
  const total = countDescendants(node.id, cmap);
  const active = activeDescendantCount(node.id, cmap, new Map(snapshot.nodes.map((n) => [n.id, n.status])));
  const lines = [
    `<b>${escapeHtml(node.label)}</b>`,
    `<span class="muted">${node.type}${node.status ? " · " + node.status : ""}${node.stale ? " · нет свежих данных" : ""}</span>`,
  ];
  if (node.type === "agent" && (node.model || node.provider)) {
    lines.push(`<span class="muted">${escapeHtml(node.provider || "")} ${escapeHtml(node.model || "")}</span>`);
  }
  if (node.type === "file" && node.extension) lines.push(`<span class="muted">${escapeHtml(node.extension)}</span>`);
  if (total > 0) lines.push(`<span class="muted">Дочерние агенты: ${total} (${active} активных)</span>`);
  card.innerHTML = lines.join("<br>");
}

function refreshDrawer() {
  if (!selectedId) { drawer.hidden = true; return; }
  const node = snapshot.nodes.find((n) => n.id === selectedId);
  if (!node) { drawer.hidden = true; return; }
  drawer.hidden = false;
  drawerBody.innerHTML = Object.entries(node)
    .map(([k, v]) => `<div class="kv"><span>${escapeHtml(k)}</span><code>${escapeHtml(JSON.stringify(v))}</code></div>`)
    .join("");
}

function refreshAccessibleList() {
  accessibleList.innerHTML = snapshot.nodes.map((n) => {
    const p = positions.get(n.id);
    const style = p ? "" : "display:none";
    return `<li role="listitem"><button data-id="${escapeHtml(n.id)}" style="position:absolute;${style}" aria-label="${escapeHtml(n.type + ": " + n.label)}">${escapeHtml(truncateLabel(n.label))}</button></li>`;
  }).join("");
  accessibleList.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => selectNode(b.dataset.id));
  });
}

function applySearchHighlight() {
  for (const [id, g] of renderer.nodeEls) {
    if (searchMatches === null) {
      g.classList.remove("search-match", "search-dim");
    } else if (searchMatches.has(id)) {
      g.classList.remove("search-dim");
      g.classList.add("search-match");
    } else {
      g.classList.remove("search-match");
      g.classList.add("search-dim");
    }
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Tooltip
svg.addEventListener("mousemove", (e) => {
  if (drag) { tooltip.hidden = true; return; }
  const target = e.target.closest?.(".node");
  if (!target) { tooltip.hidden = true; return; }
  const node = snapshot.nodes.find((n) => n.id === target.dataset.id);
  if (!node) { tooltip.hidden = true; return; }
  tooltip.hidden = false;
  tooltip.style.left = `${e.clientX + 14}px`;
  tooltip.style.top = `${e.clientY + 14}px`;
  tooltip.textContent = node.label + (node.stale ? " — нет свежих данных" : "");
});
svg.addEventListener("mouseleave", () => { tooltip.hidden = true; });

// Pan + zoom
svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (!cameraState) return;
  const rect = svg.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newZoom = Math.max(0.15, Math.min(5, cameraState.zoom * factor));
  if (newZoom === cameraState.zoom) return;
  const worldX = (mx - cameraState.tx) / cameraState.zoom;
  const worldY = (my - cameraState.ty) / cameraState.zoom;
  cameraState = {
    zoom: newZoom,
    tx: mx - worldX * newZoom,
    ty: my - worldY * newZoom,
  };
  cameraMode = "manual";
  applyCamera();
  refreshCard();
}, { passive: false });

svg.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest?.(".node") || e.target.closest?.(".orbit-satellite")) return;
  if (!cameraState) return;
  drag = { sx: e.clientX, sy: e.clientY, tx: cameraState.tx, ty: cameraState.ty };
  svg.setPointerCapture(e.pointerId);
  svg.classList.add("panning");
});

svg.addEventListener("pointermove", (e) => {
  if (!drag || !cameraState) return;
  cameraState = {
    zoom: cameraState.zoom,
    tx: drag.tx + (e.clientX - drag.sx),
    ty: drag.ty + (e.clientY - drag.sy),
  };
  cameraMode = "manual";
  applyCamera();
  refreshCard();
});

svg.addEventListener("pointerup", (e) => {
  if (!drag) return;
  svg.releasePointerCapture(e.pointerId);
  drag = null;
  svg.classList.remove("panning");
});

svg.addEventListener("pointercancel", () => {
  drag = null;
  svg.classList.remove("panning");
});

// Menu
menuBtn.addEventListener("click", () => {
  menuPanel.hidden = !menuPanel.hidden;
  if (!menuPanel.hidden) searchInput.focus();
});

fitBtn.addEventListener("click", () => {
  fitView();
  refreshCard();
});

searchInput.addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    searchMatches = null;
    applySearchHighlight();
    return;
  }
  searchMatches = new Set();
  for (const n of snapshot.nodes) {
    const hay = [(n.label || ""), (n.id || ""), (n.provider || ""), (n.model || "")].join(" ").toLowerCase();
    if (hay.includes(q)) searchMatches.add(n.id);
  }
  applySearchHighlight();
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchInput.value = "";
    searchMatches = null;
    applySearchHighlight();
    e.stopPropagation();
  }
});

drawerClose.addEventListener("click", deselect);

document.addEventListener("click", (e) => {
  if (!menuPanel.hidden && !menuPanel.contains(e.target) && e.target !== menuBtn) {
    menuPanel.hidden = true;
  }
  // Deselect when clicking outside card/drawer/menu on the scene
  if (selectedId && svg.contains(e.target)
      && !e.target.closest?.(".node")
      && !e.target.closest?.(".orbit-satellite")) {
    if (!drag) deselect();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") deselect();
});

// WebSocket
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => applySnapshot(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connect, 1500);
}
fetch("/api/graph").then((r) => r.json()).then(applySnapshot);
connect();

// Ambient dust (canvas behind the SVG)
const dust = new DustField(document.getElementById("dust"), {
  count: 48,
  reducedMotion: prefersReducedMotion,
});

let raf = 0;
function tick() {
  if (document.hidden) { raf = 0; return; }
  raf = requestAnimationFrame(tick);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    svg.pauseAnimations?.();
    dust.stop();
    renderer.stopOrbitAnimation();
  } else {
    if (!raf) raf = requestAnimationFrame(tick);
    svg.unpauseAnimations?.();
    if (!prefersReducedMotion) dust.start();
    renderer.startOrbitAnimation();
  }
});
raf = requestAnimationFrame(tick);

if (!prefersReducedMotion) dust.start();

const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
motionQuery.addEventListener("change", (e) => {
  dust.setReducedMotion(e.matches);
});

// Resize
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (cameraMode === "fit") {
      fitView();
    } else {
      applyCamera();
    }
    refreshCard();
  }, 120);
});