// Grid representation of the room, plus exact grid ray casting.
// Ray casting uses Amanatides–Woo DDA traversal: it visits every cell a
// segment passes through, so sight never leaks through a wall or a corner gap.

export class Grid {
  constructor(rows) {
    this.h = rows.length;
    this.w = rows[0].length;
    this.walls = new Uint8Array(this.w * this.h);
    this.start = null;
    this.exit = null;
    for (let y = 0; y < this.h; y++) {
      if (rows[y].length !== this.w) {
        throw new Error(`Map row ${y} has length ${rows[y].length}, expected ${this.w}`);
      }
      for (let x = 0; x < this.w; x++) {
        const c = rows[y][x];
        if (c === '#') this.walls[y * this.w + x] = 1;
        else if (c === 'S') this.start = { x, y };
        else if (c === 'E') this.exit = { x, y };
      }
    }
    if (!this.start || !this.exit) throw new Error('Map needs one S (start) and one E (exit)');
    this.rows = rows.slice();
  }

  idx(x, y) { return y * this.w + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  isWall(x, y) { return !this.inBounds(x, y) || this.walls[y * this.w + x] === 1; }
  isWalkable(x, y) { return !this.isWall(x, y); }

  freeCells() {
    const out = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (!this.walls[y * this.w + x]) out.push({ x, y });
    }
    return out;
  }

  // Nearest walkable cell to (x, y), breadth-first.
  nearestWalkable(x, y) {
    x = Math.max(0, Math.min(this.w - 1, Math.floor(x)));
    y = Math.max(0, Math.min(this.h - 1, Math.floor(y)));
    if (this.isWalkable(x, y)) return { x, y };
    const seen = new Uint8Array(this.w * this.h);
    const q = [[x, y]];
    seen[this.idx(x, y)] = 1;
    while (q.length) {
      const [cx, cy] = q.shift();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (!this.inBounds(nx, ny) || seen[this.idx(nx, ny)]) continue;
        if (this.isWalkable(nx, ny)) return { x: nx, y: ny };
        seen[this.idx(nx, ny)] = 1;
        q.push([nx, ny]);
      }
    }
    return null;
  }

  // True when the segment (ax,ay)→(bx,by) crosses no wall cell.
  // At an exact diagonal corner crossing, either neighbouring wall blocks sight.
  lineOfSight(ax, ay, bx, by) {
    let x = Math.floor(ax), y = Math.floor(ay);
    const ex = Math.floor(bx), ey = Math.floor(by);
    if (this.isWall(x, y) || this.isWall(ex, ey)) return false;
    const dx = bx - ax, dy = by - ay;
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? x + 1 - ax : ax - x) * tdx : Infinity;
    let tmy = dy !== 0 ? (dy > 0 ? y + 1 - ay : ay - y) * tdy : Infinity;
    for (let n = 0; (x !== ex || y !== ey) && n < 1024; n++) {
      if (tmx < tmy) {
        if (tmx > 1) break;
        tmx += tdx; x += stepX;
      } else if (tmy < tmx) {
        if (tmy > 1) break;
        tmy += tdy; y += stepY;
      } else {
        if (tmx > 1) break;
        if (this.isWall(x + stepX, y) || this.isWall(x, y + stepY)) return false;
        tmx += tdx; tmy += tdy; x += stepX; y += stepY;
      }
      if (this.isWall(x, y)) return false;
    }
    return true;
  }

  // Distance from (ox,oy) along `angle` to the first wall, capped at maxDist.
  rayDistance(ox, oy, angle, maxDist) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let x = Math.floor(ox), y = Math.floor(oy);
    if (this.isWall(x, y)) return 0;
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const tdx = Math.abs(dx) > 1e-12 ? Math.abs(1 / dx) : Infinity;
    const tdy = Math.abs(dy) > 1e-12 ? Math.abs(1 / dy) : Infinity;
    let tmx = Math.abs(dx) > 1e-12 ? (dx > 0 ? x + 1 - ox : ox - x) * tdx : Infinity;
    let tmy = Math.abs(dy) > 1e-12 ? (dy > 0 ? y + 1 - oy : oy - y) * tdy : Infinity;
    for (let n = 0; n < 512; n++) {
      let t;
      if (tmx < tmy) { t = tmx; tmx += tdx; x += stepX; }
      else if (tmy < tmx) { t = tmy; tmy += tdy; y += stepY; }
      else {
        t = tmx;
        if (t >= maxDist) return maxDist;
        if (this.isWall(x + stepX, y) || this.isWall(x, y + stepY)) return t;
        tmx += tdx; tmy += tdy; x += stepX; y += stepY;
      }
      if (t >= maxDist) return maxDist;
      if (this.isWall(x, y)) return t;
    }
    return maxDist;
  }

  // Segment is clear for a body of radius r: the centre line and both edge lines see through.
  clearPath(ax, ay, bx, by, r) {
    if (!this.lineOfSight(ax, ay, bx, by)) return false;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return true;
    const nx = (-dy / len) * r, ny = (dx / len) * r;
    return this.lineOfSight(ax + nx, ay + ny, bx + nx, by + ny)
        && this.lineOfSight(ax - nx, ay - ny, bx - nx, by - ny);
  }
}
