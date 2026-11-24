// Edge routing with obstacle avoidance.
// Deterministic: no random. Input/output are pure functions.

const MARGIN = 24;          // безопасный зазор вокруг obstacle
const PARALLEL_SHIFT = 20;  // сдвиг между параллельными рёбрами

/**
 * Расстояние от точки P до отрезка AB.
 */
function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Пересекает ли отрезок A→B окружность (cx, cy, r).
 */
function segmentIntersectsCircle(ax, ay, bx, by, cx, cy, r) {
  return pointSegmentDistance(cx, cy, ax, ay, bx, by) < r;
}

/**
 * Перпендикуляр к A→B, нормализованный.
 */
function normal(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

/**
 * Cubic Bézier с одной контрольной точкой сдвига в середине.
 * a, b — концы. offset — сдвиг перпендикулярно на середине.
 */
function cubicVia(a, b, offset) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const n = normal(a.x, a.y, b.x, b.y);
  const cx = mx + n.x * offset;
  const cy = my + n.y * offset;
  // Две контрольные точки: 1/4 и 3/4 пути, сдвинутые в сторону cx,cy
  const c1x = a.x + (cx - a.x) * 0.5;
  const c1y = a.y + (cy - a.y) * 0.5;
  const c2x = b.x + (cx - b.x) * 0.5;
  const c2y = b.y + (cy - b.y) * 0.5;
  return `M${a.x.toFixed(2)},${a.y.toFixed(2)} C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
}

/**
 * Выбрать сдвиг: максимальное перекрытие obstacle с прямой A→B.
 * Возвращает offset (0 если нет пересечений).
 */
function requiredOffset(a, b, obstacles) {
  let maxOffset = 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;

  for (const o of obstacles) {
    if (o.r == null) continue;
    const effectiveR = o.r + MARGIN;
    if (!segmentIntersectsCircle(a.x, a.y, b.x, b.y, o.x, o.y, effectiveR)) continue;

    // Насколько нужно сдвинуть, чтобы прямая прошла на расстоянии ≥ effectiveR
    const dist = pointSegmentDistance(o.x, o.y, a.x, a.y, b.x, b.y);
    const needed = effectiveR - dist;
    if (needed > maxOffset) maxOffset = needed;
  }

  if (maxOffset === 0) return 0;
  // Сдвиг по нормали на нужное расстояние + небольшой запас
  return maxOffset + 20;
}

/**
 * Главная функция. 
 * @param {{x,y}} a
 * @param {{x,y}} b
 * @param {Array<{x,y,r}>} obstacles
 * @param {number} parallelIndex  0 для первого ребра A→B, 1 для второго, и т.д.
 */
export function route(a, b, obstacles = [], parallelIndex = 0) {
  // Найти ближайшее блокирующее препятствие
  let blocker = null;
  let blockerDist = Infinity;
  for (const o of obstacles) {
    if (!o || o.r == null) continue;
    // Ребро, начинающееся или заканчивающееся в самом препятствии (агент → проект,
    // проект → папка), не должно огибать собственный конец.
    if (Math.hypot(o.x - a.x, o.y - a.y) <= o.r || Math.hypot(o.x - b.x, o.y - b.y) <= o.r) continue;
    const d = pointSegmentDistance(o.x, o.y, a.x, a.y, b.x, b.y);
    const threshold = (o.r || 0) + MARGIN;
    if (d < threshold && d < blockerDist) {
      blocker = o;
      blockerDist = d;
    }
  }

  // Нет препятствия — прямой cubic как раньше (+ параллельный сдвиг)
  if (!blocker) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const shift = parallelIndex === 0
      ? 0
      : (parallelIndex % 2 === 1 ? 1 : -1) * Math.ceil(parallelIndex / 2) * PARALLEL_SHIFT;
    const a2 = { x: a.x + nx * shift, y: a.y + ny * shift };
    const b2 = { x: b.x + nx * shift, y: b.y + ny * shift };
    const dy2 = b2.y - a2.y;
    if (Math.abs(dy2) < 20) {
      return { d: `M${a2.x.toFixed(2)},${a2.y.toFixed(2)} C${a2.x.toFixed(2)},${(a2.y - 60).toFixed(2)} ${b2.x.toFixed(2)},${(b2.y - 60).toFixed(2)} ${b2.x.toFixed(2)},${b2.y.toFixed(2)}` };
    }
    const c1x = a2.x + (b2.x - a2.x) * 0.5;
    const c1y = a2.y + dy2 * 0.45;
    const c2x = c1x;
    const c2y = b2.y - dy2 * 0.45;
    return { d: `M${a2.x.toFixed(2)},${a2.y.toFixed(2)} C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${b2.x.toFixed(2)},${b2.y.toFixed(2)}` };
  }

  // Обход: quadratic через waypoint на свободной стороне препятствия
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  // Сторона, противоположная препятствию
  const ox = blocker.x - a.x;
  const oy = blocker.y - a.y;
  const side = (nx * ox + ny * oy) > 0 ? -1 : 1;

  // Большой отступ — waypoint далеко от препятствия, середина quadratic смещена на DETOUR/2
  const DETOUR = (blocker.r || 40) + 80 + parallelIndex * PARALLEL_SHIFT;
  const wx = blocker.x + side * nx * DETOUR;
  const wy = blocker.y + side * ny * DETOUR;

  return { d: `M${a.x.toFixed(2)},${a.y.toFixed(2)} Q${wx.toFixed(2)},${wy.toFixed(2)} ${b.x.toFixed(2)},${b.y.toFixed(2)}` };
}