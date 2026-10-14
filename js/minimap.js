// 2D debug map. Shows what the 3D view hides: the cells A* expanded on each
// guard's most recent search, the resulting path, cones, the memory heat map,
// and learned watch points.

const COLORS = {
  floor: '#cfd5dc', wall: '#3c4552', grid: 'rgba(60,69,82,.12)',
  exit: '#2fbf68', start: 'rgba(47,124,246,.35)',
  player: '#2f7cf6', guard: '#d2453f', learn: '#9b6cff',
  heat: [242, 201, 76], heatHot: [226, 62, 68],
  searched: { A: 'rgba(47,124,246,.20)', B: 'rgba(155,108,255,.22)' },
};
const STATE = { PATROL: '#3f8ee8', SUSPICIOUS: '#f0b232', INVESTIGATE: '#f07f2b', CHASE: '#e23e44' };

export class MiniMap {
  constructor(canvas, grid) {
    this.canvas = canvas;
    this.grid = grid;
    this.ctx = canvas.getContext('2d');
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || 280;
    this.cell = w / this.grid.w;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(this.cell * this.grid.h * dpr);
    this.canvas.style.height = `${this.cell * this.grid.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(world, { heat, showHeat, showSearch, focus }) {
    const { ctx, grid } = this;
    const s = this.cell;
    if (Math.abs(this.canvas.clientWidth / grid.w - s) > 0.5) this.resize();
    ctx.clearRect(0, 0, grid.w * s, grid.h * s);

    let maxHeat = 0;
    if (showHeat && heat) for (const v of heat) maxHeat = Math.max(maxHeat, v);

    for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) {
      if (grid.isWall(x, y)) { ctx.fillStyle = COLORS.wall; ctx.fillRect(x * s, y * s, s, s); continue; }
      ctx.fillStyle = COLORS.floor;
      ctx.fillRect(x * s, y * s, s, s);
      if (maxHeat > 0) {
        const h = heat[grid.idx(x, y)] / maxHeat;
        if (h > 0.04) {
          const c = COLORS.heat.map((v, i) => Math.round(v + (COLORS.heatHot[i] - v) * h));
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${0.25 + h * 0.6})`;
          ctx.fillRect(x * s, y * s, s, s);
        }
      }
    }

    // Cells expanded by A* in each guard's latest search.
    if (showSearch) {
      for (const g of world.guards) {
        if (focus && g.id !== focus) continue;
        const closed = g.lastSearch?.closed;
        if (!closed) continue;
        ctx.fillStyle = COLORS.searched[g.id] || 'rgba(120,120,120,.18)';
        for (let i = 0; i < closed.length; i++) {
          if (!closed[i]) continue;
          const x = i % grid.w, y = (i / grid.w) | 0;
          ctx.fillRect(x * s + 1, y * s + 1, s - 2, s - 2);
        }
      }
    }

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= grid.w; x++) { ctx.moveTo(x * s + 0.5, 0); ctx.lineTo(x * s + 0.5, grid.h * s); }
    for (let y = 0; y <= grid.h; y++) { ctx.moveTo(0, y * s + 0.5); ctx.lineTo(grid.w * s, y * s + 0.5); }
    ctx.stroke();

    ctx.fillStyle = COLORS.start;
    ctx.fillRect(grid.start.x * s, grid.start.y * s, s, s);
    ctx.fillStyle = COLORS.exit;
    ctx.fillRect(grid.exit.x * s + 1, grid.exit.y * s + 1, s - 2, s - 2);

    for (const g of world.guards) {
      const col = STATE[g.state] || STATE.PATROL;
      // cone
      const P = world.params, half = (P.coneAngle * Math.PI) / 360;
      ctx.beginPath();
      ctx.moveTo(g.x * s, g.y * s);
      for (let i = 0; i <= 24; i++) {
        const a = g.face - half + (2 * half * i) / 24;
        const d = grid.rayDistance(g.x, g.y, a, P.coneRange);
        ctx.lineTo((g.x + Math.cos(a) * d) * s, (g.y + Math.sin(a) * d) * s);
      }
      ctx.closePath();
      ctx.fillStyle = col + '44';
      ctx.fill();
      // path
      if (g.bb.path.length) {
        ctx.beginPath();
        ctx.moveTo(g.x * s, g.y * s);
        for (const q of g.bb.path) ctx.lineTo(q.x * s, q.y * s);
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // learned watch point
      const wp = g.patrol.find((p) => p.watch);
      if (wp) {
        ctx.strokeStyle = COLORS.learn;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(wp.x * s, wp.y * s, s * 0.38, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = COLORS.guard;
      ctx.beginPath();
      ctx.arc(g.x * s, g.y * s, s * 0.34, 0, Math.PI * 2);
      ctx.fill();
    }

    const p = world.player;
    ctx.fillStyle = COLORS.player;
    ctx.beginPath();
    ctx.arc(p.x * s, p.y * s, s * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }
}
