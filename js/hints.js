// One-line hints during a player's first run. No DOM here, so tests can cover it.
// Each hint waits for the moment it is useful, shows once, and goes away when the
// player has done it or has had time to read it.

const nearest = (w) => Math.min(Infinity, ...w.guards.map((g) => Math.hypot(g.x - w.player.x, g.y - w.player.y)));
const walked = (w) => Math.hypot(w.player.x - w.grid.start.x - 0.5, w.player.y - w.grid.start.y - 0.5);

// In order of importance: an earlier hint replaces a later one.
export const HINTS = [
  { id: 'locked', when: (w) => !w.exitOpen, done: (w, t) => t > 5 || (t > 2 && w.exitOpen),
    key: 'The exit is locked (red) while any guard is alert. Break line of sight and wait.' },
  { id: 'move', when: () => true, done: (w) => walked(w) > 1.5,
    key: 'Move with W A S D or the arrow keys', touch: 'Move with the arrow pad' },
  { id: 'decoy', when: (w) => nearest(w) < 5.5 && w.decoysLeft > 0, done: (w, t) => t > 7 || w.decoyLog.length > 0,
    key: 'Press Space to throw a decoy ahead of you: guards go to the noise', touch: 'Tap Decoy to throw one ahead of you: guards go to the noise' },
  { id: 'goal', when: (w) => walked(w) > 1.5, done: (w, t) => t > 4,
    key: 'Reach the glowing green exit at the bottom right' },
  { id: 'cone', when: (w) => walked(w) > 3, done: (w, t) => t > 5,
    key: 'Stay out of the coloured cones: they show what each guard can see' },
];

export class Hints {
  constructor() { this.shown = new Set(); this.now = null; this.t = 0; }

  // The hint to show this frame, or null.
  update(world, dt, touch = false) {
    if (this.now) {
      this.t += dt;
      if (this.now.done(world, this.t)) this.now = null;
    }
    const rank = this.now ? HINTS.indexOf(this.now) : HINTS.length;
    const next = HINTS.find((h, i) => i < rank && !this.shown.has(h.id) && h.when(world));
    if (next) { this.now = next; this.t = 0; this.shown.add(next.id); }
    return this.now ? (touch && this.now.touch) || this.now.key : null;
  }
}
