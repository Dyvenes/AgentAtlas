// Ambient dust particles behind the scene.
// - <=64 particles (plan requirement)
// - pre-rasterized radial gradients cached once
// - respects prefers-reduced-motion: clear + stop
// - stops on hidden tab (owned by app.js)

const MAX_PARTICLES = 64;

export class DustField {
  constructor(canvas, { count = 48, reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.count = Math.min(count, MAX_PARTICLES);
    this.reducedMotion = reducedMotion;
    this.particles = [];
    this.sprites = {};
    this.W = 0;
    this.H = 0;
    this.running = false;
    this._raf = 0;
    this._lastTime = 0;
    this._resize();
    this._buildSprites();
    this._seed();
    window.addEventListener("resize", () => this._resize());
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width = this.W + "px";
    this.canvas.style.height = this.H + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _buildSprites() {
    const colors = {
      cyan: [82, 230, 255],
      pink: [255, 103, 216],
      violet: [159, 139, 255],
    };
    for (const [name, [r, g, b]] of Object.entries(colors)) {
      const size = 16;
      const off = document.createElement("canvas");
      off.width = size;
      off.height = size;
      const oc = off.getContext("2d");
      const grad = oc.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
      grad.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, 0.35)`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      oc.fillStyle = grad;
      oc.fillRect(0, 0, size, size);
      this.sprites[name] = off;
    }
  }

  _seed() {
    // Math.random is OK here: particles are ephemeral and visual only,
    // not node positions (layout.js owns determinism).
    const palette = ["cyan", "cyan", "cyan", "pink", "violet"];
    this.particles = [];
    for (let i = 0; i < this.count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.02 + Math.random() * 0.06;
      this.particles.push({
        x: Math.random() * this.W,
        y: Math.random() * this.H,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 4 + Math.random() * 6,
        alpha: 0.22 + Math.random() * 0.35,
        color: palette[Math.floor(Math.random() * palette.length)],
        twinkle: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.3 + Math.random() * 0.5,
      });
    }
  }

  setReducedMotion(value) {
    this.reducedMotion = value;
    if (value) {
      this._clear();
      this.stop();
    }
  }

  start() {
    if (this.reducedMotion || this.running) return;
    this.running = true;
    this._lastTime = performance.now();
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  stop() {
    this.running = false;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }

  _clear() {
    this.ctx.clearRect(0, 0, this.W, this.H);
  }

  _tick(now) {
    if (!this.running || this.reducedMotion) return;
    const dt = Math.min(32, now - this._lastTime) / 1000;
    this._lastTime = now;

    this._clear();
    for (const p of this.particles) {
      p.x += p.vx * dt * 20;
      p.y += p.vy * dt * 20;
      p.twinkle += p.twinkleSpeed * dt;

      if (p.x < -20) p.x = this.W + 20;
      else if (p.x > this.W + 20) p.x = -20;
      if (p.y < -20) p.y = this.H + 20;
      else if (p.y > this.H + 20) p.y = -20;

      const sprite = this.sprites[p.color];
      if (!sprite) continue;
      const s = p.size;
      const tw = 0.75 + Math.sin(p.twinkle) * 0.25;
      this.ctx.globalAlpha = p.alpha * tw;
      this.ctx.drawImage(sprite, p.x - s / 2, p.y - s / 2, s, s);
    }
    this.ctx.globalAlpha = 1;

    this._raf = requestAnimationFrame((t) => this._tick(t));
  }
}