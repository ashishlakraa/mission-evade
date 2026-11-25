// Sound, synthesised with the Web Audio API (no audio files).
//
// Sound only presents the simulation: it reads World events and positions and never
// changes them. Guards do not hear footsteps; only decoys and radio calls make noise
// in the simulation (see World.emitNoise).
//
// Browsers only allow sound after a click or key press, so unlock() runs on the first one.
// The audio context itself is made while loading (prepare), because making it can take a
// third of a second and would freeze the first run.

const FALLOFF = 8;                 // cells at which a guard's sound fades out
const PLAYER_STRIDE = 0.62;        // cells per footstep
const GUARD_STRIDE = 0.7;

// Which cue an event plays, or null. Pure, so tests can cover it.
export function cueFor(e) {
  switch (e.type) {
    case 'throw': return 'throw';
    case 'ring': return 'ring';
    case 'spotted': return 'alert';
    case 'state':
      if (e.to === 'SUSPICIOUS' && e.from === 'PATROL') return 'suspicion';
      if (e.to === 'INVESTIGATE' && e.from === 'PATROL') return 'investigate';
      if (e.to === 'PATROL') return 'calm';
      return null;                 // CHASE is covered by 'spotted'
    case 'exit-locked': return 'locked';
    case 'exit-open': return 'open';
    case 'caught': return 'caught';
    case 'escaped': return 'escaped';
    default: return null;
  }
}

// 0..1 loudness of a sound `d` cells from the player.
export const loudness = (d) => Math.max(0, 1 - d / FALLOFF) ** 2;

export class Sound {
  constructor({ muted = false, volume = 0.7 } = {}) {
    this.muted = muted;
    this.volume = volume;
    this.ctx = null;
    this.played = {};              // cue name → times played, for the automated checks
    this.walk = new Map();         // who → { x, y, d } distance walked since the last step
    this.beat = 0;
    this.playing = false;
  }

  // ---------- set up ----------

  prepare() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch { return; }   // no audio device: the game plays silently
      const c = this.ctx;
      this.master = c.createGain();
      const limit = c.createDynamicsCompressor();
      limit.threshold.value = -10;
      limit.ratio.value = 6;
      this.master.connect(limit);
      limit.connect(c.destination);
      this.game = c.createGain();   // sounds inside the facility: silent while paused
      this.ui = c.createGain();     // menus, results
      this.game.connect(this.master);
      this.ui.connect(this.master);
      this.game.gain.value = this.playing ? 1 : 0;
      this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = this.noise.getChannelData(0);
      let seed = 1;
      for (let i = 0; i < d.length; i++) { seed = (seed * 16807) % 2147483647; d[i] = (seed / 2147483647) * 2 - 1; }
      this.applyVolume();
    }
  }

  unlock() {
    this.prepare();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume().catch(() => {});
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  applyVolume() {
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
  }
  setMuted(v) { this.muted = v; this.applyVolume(); }
  setVolume(v) { this.volume = Math.min(1, Math.max(0, v)); this.applyVolume(); }

  // Sounds of the facility are only heard during a run.
  setPlaying(v) {
    this.playing = v;
    if (this.ctx) this.game.gain.setTargetAtTime(v ? 1 : 0, this.ctx.currentTime, 0.03);
  }

  // The tab was hidden or shown again.
  setHidden(hidden) {
    if (!this.ctx) return;
    (hidden ? this.ctx.suspend() : this.ctx.resume()).catch(() => {});
  }

  resetRun() { this.walk.clear(); this.beat = 0; }

  // ---------- per frame ----------

  // Play what happened since the last frame.
  events(list, world) {
    for (const e of list) {
      const cue = cueFor(e);
      if (cue) this.cue(cue, { pan: this.panOf(e, world), near: e.x == null ? 1 : loudness(this.dist(e, world)) });
    }
  }

  // Footsteps, and a heartbeat while a guard is chasing.
  frame(world, dt) {
    if (!this.ready) return;
    const p = world.player;
    if (this.walked('player', p.x, p.y, PLAYER_STRIDE)) this.cue('step');
    let chased = false;
    for (const g of world.guards) {
      if (g.bb.alerted) chased = true;
      if (!this.walked(g, g.x, g.y, GUARD_STRIDE)) continue;
      const near = loudness(this.dist(g, world));
      if (near > 0.02) this.cue('guard-step', { pan: this.panOf(g, world), near });
    }
    this.beat = chased ? this.beat - dt : 0;
    if (chased && this.beat <= 0) { this.beat = 0.46; this.cue('heartbeat'); }
  }

  walked(who, x, y, stride) {
    const w = this.walk.get(who);
    if (!w) { this.walk.set(who, { x, y, d: 0 }); return false; }
    w.d += Math.hypot(x - w.x, y - w.y);
    w.x = x;
    w.y = y;
    if (w.d < stride) return false;
    w.d %= stride;
    return true;
  }

  dist(e, world) { return Math.hypot(e.x - world.player.x, e.y - world.player.y); }
  panOf(e, world) { return e.x == null ? 0 : Math.max(-0.8, Math.min(0.8, (e.x - world.player.x) / FALLOFF)); }

  // ---------- cues ----------

  cue(name, { pan = 0, near = 1 } = {}) {
    if (!this.ready || this.muted) return;
    this.played[name] = (this.played[name] || 0) + 1;
    const out = this.game;
    switch (name) {
      case 'step': this.hiss({ out, f: 900, q: 0.8, dur: 0.06, gain: 0.1, type: 'bandpass' }); break;
      case 'guard-step':
        this.hiss({ out, f: 320, q: 1.2, dur: 0.09, gain: 0.34 * near, pan, type: 'bandpass' });
        this.tone({ out, f: 95, to: 60, dur: 0.07, gain: 0.22 * near, pan });
        break;
      case 'throw': this.hiss({ out, f: 500, to: 2600, q: 1.5, dur: 0.22, gain: 0.16, pan, type: 'bandpass' }); break;
      case 'ring':
        for (const [f, g] of [[1318, 0.16], [2637, 0.07], [3520, 0.04]]) this.tone({ out, f, dur: 0.42, gain: g * (0.35 + 0.65 * near), pan });
        break;
      case 'suspicion': this.tone({ out, f: 392, to: 523, dur: 0.2, gain: 0.13, pan, type: 'triangle' }); break;
      case 'investigate': this.tone({ out, f: 330, to: 294, dur: 0.22, gain: 0.08 * (0.4 + 0.6 * near), pan, type: 'triangle' }); break;
      case 'calm': this.tone({ out, f: 294, to: 262, dur: 0.2, gain: 0.05, pan }); break;
      case 'alert':
        [0, 0.11, 0.22].forEach((at, i) => this.tone({ out, f: i % 2 ? 622 : 880, dur: 0.1, at, gain: 0.16, pan, type: 'square', cut: 2400 }));
        break;
      case 'heartbeat':
        this.tone({ out, f: 70, to: 45, dur: 0.12, gain: 0.3 });
        this.tone({ out, f: 62, to: 40, dur: 0.12, at: 0.15, gain: 0.2 });
        break;
      case 'locked':
        this.tone({ out, f: 196, dur: 0.1, gain: 0.12, pan, type: 'square', cut: 900 });
        this.tone({ out, f: 147, dur: 0.16, at: 0.1, gain: 0.12, pan, type: 'square', cut: 900 });
        break;
      case 'open':
        this.tone({ out, f: 523, dur: 0.1, gain: 0.09, pan, type: 'triangle' });
        this.tone({ out, f: 784, dur: 0.18, at: 0.1, gain: 0.09, pan, type: 'triangle' });
        break;
      // Results play on the menu bus, so they are heard once the run has ended.
      case 'caught':
        this.tone({ out: this.ui, f: 330, to: 82, dur: 0.6, gain: 0.2, type: 'sawtooth', cut: 1200 });
        this.hiss({ out: this.ui, f: 300, dur: 0.25, gain: 0.2 });
        break;
      case 'escaped': this.arp([523, 659, 784, 1047], 0.09, 0.14); break;
      case 'restart': this.arp([294, 247], 0.16, 0.12); break;
      case 'mission-won': this.arp([523, 659, 784, 1047, 1319, 1568], 0.13, 0.15); break;
      case 'mission-lost': this.arp([392, 349, 311, 262, 196], 0.2, 0.15); break;
      case 'click': this.tone({ out: this.ui, f: 660, dur: 0.05, gain: 0.07, type: 'triangle' }); break;
      default: break;
    }
  }

  arp(notes, gap, gain) { notes.forEach((f, i) => this.tone({ out: this.ui, f, dur: 0.3, at: i * gap, gain, type: 'triangle' })); }

  // One enveloped oscillator.
  tone({ out, f, to = null, dur, at = 0, gain, pan = 0, type = 'sine', cut = 0 }) {
    const c = this.ctx, t = c.currentTime + at;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    let node = o;
    if (cut) {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cut;
      node.connect(lp);
      node = lp;
    }
    node.connect(this.envelope(out, t, dur, gain, pan));
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // One enveloped burst of filtered noise.
  hiss({ out, f, to = null, q = 0.7, dur, at = 0, gain, pan = 0, type = 'lowpass' }) {
    const c = this.ctx, t = c.currentTime + at;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const flt = c.createBiquadFilter();
    flt.type = type;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f, t);
    if (to) flt.frequency.exponentialRampToValueAtTime(to, t + dur);
    s.connect(flt);
    flt.connect(this.envelope(out, t, dur, gain, pan));
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }

  envelope(out, t, dur, gain, pan) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + Math.min(0.012, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (pan && c.createStereoPanner) {   // Safari before 14.1 has no panner
      const p = c.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(out);
    } else g.connect(out);
    return g;
  }
}
