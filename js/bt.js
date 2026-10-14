// A small behavior tree library.
//
// Every tick returns SUCCESS, FAILURE or RUNNING.
// - Selector:   tries children in priority order; the first that does not FAIL wins.
//               Lower-priority children are halted, so an interrupted branch resets cleanly.
// - Sequence:   runs children in order every tick (reactive); stops at the first non-SUCCESS.
// - MemSequence: remembers which child is RUNNING and continues from it next tick.
// - Condition:  a yes/no question about the world.
// - Action:     does something; may take many ticks (RUNNING).
//
// Each node records the status and tick it last ran, which the debug panel draws live.

export const Status = Object.freeze({ SUCCESS: 'SUCCESS', FAILURE: 'FAILURE', RUNNING: 'RUNNING' });
const { SUCCESS, FAILURE, RUNNING } = Status;

let nextId = 1;

export class BTNode {
  constructor(kind, name, children = []) {
    this.id = nextId++;
    this.kind = kind;
    this.name = name;
    this.children = children;
    this.status = null;   // status from the last tick this node ran
    this.tickId = -1;     // which tick that was
    this.running = false; // was RUNNING when last ticked
  }
  tick(ctx) {
    const s = this.run(ctx);
    this.status = s;
    this.tickId = ctx.tickId;
    this.running = s === RUNNING;
    return s;
  }
  // Stop this subtree and clear any remembered progress.
  halt(ctx) {
    if (this.running) this.onHalt(ctx);
    this.running = false;
    this.reset();
    for (const c of this.children) c.halt(ctx);
  }
  run() { return FAILURE; }
  onHalt() {}
  reset() {}
}

export class Selector extends BTNode {
  constructor(name, children) { super('selector', name, children); }
  run(ctx) {
    const ch = this.children;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i].tick(ctx);
      if (s !== FAILURE) {
        for (let j = i + 1; j < ch.length; j++) ch[j].halt(ctx);
        return s;
      }
    }
    return FAILURE;
  }
}

export class Sequence extends BTNode {
  constructor(name, children) { super('sequence', name, children); }
  run(ctx) {
    const ch = this.children;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i].tick(ctx);
      if (s !== SUCCESS) {
        for (let j = i + 1; j < ch.length; j++) ch[j].halt(ctx);
        return s;
      }
    }
    return SUCCESS;
  }
}

export class MemSequence extends BTNode {
  constructor(name, children) {
    super('memsequence', name, children);
    this.index = 0;
    for (const c of children) c.parentMem = this; // lets the debug view mark finished steps
  }
  reset() { this.index = 0; }
  run(ctx) {
    const ch = this.children;
    while (this.index < ch.length) {
      const s = ch[this.index].tick(ctx);
      if (s === RUNNING) return RUNNING;
      if (s === FAILURE) { this.index = 0; return FAILURE; }
      this.index++;
    }
    this.index = 0;
    return SUCCESS;
  }
}

export class Condition extends BTNode {
  constructor(name, fn) { super('condition', name); this.fn = fn; }
  run(ctx) { return this.fn(ctx) ? SUCCESS : FAILURE; }
}

export class Action extends BTNode {
  constructor(name, fn, onHalt) { super('action', name); this.fn = fn; if (onHalt) this.onHalt = onHalt; }
  run(ctx) { return this.fn(ctx); }
}

export const sel = (name, ...c) => new Selector(name, c);
export const seq = (name, ...c) => new Sequence(name, c);
export const memSeq = (name, ...c) => new MemSequence(name, c);
export const cond = (name, fn) => new Condition(name, fn);
export const act = (name, fn, onHalt) => new Action(name, fn, onHalt);

export function walk(node, fn, depth = 0) {
  fn(node, depth);
  for (const c of node.children) walk(c, fn, depth + 1);
}
