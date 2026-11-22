import { Algorithm, algorithms } from "./algorithms";
import { Envelope } from "./envelope";
import { Operator } from "./operator";

export interface OperatorPatch {
  ratio: number; // frequency ratio to the note
  level: number; // output level; for modulators this is the index in cycles
  env: [attack: number, decay: number, sustain: number, release: number];
}

export interface Patch {
  name: string;
  algorithm: number;
  feedback: number; // in cycles
  ops: OperatorPatch[]; // 6 entries
}

/** Six-operator FM voice. */
export class Voice {
  private readonly ops: Operator[];
  private readonly envs: Envelope[];
  private readonly out = new Float32Array(6);
  private fb = [0, 0];
  private algo: Algorithm;
  patch: Patch;

  constructor(sampleRate: number, patch: Patch) {
    this.patch = patch;
    this.algo = algorithms[patch.algorithm];
    this.ops = patch.ops.map(() => new Operator(sampleRate));
    this.envs = patch.ops.map((o) => new Envelope(sampleRate, ...o.env));
  }

  noteOn(freq: number): void {
    this.patch.ops.forEach((p, i) => {
      this.ops[i].frequency = freq * p.ratio;
      this.ops[i].level = p.level;
      this.ops[i].reset();
      this.envs[i].gateOn();
    });
    this.fb = [0, 0];
  }

  noteOff(): void {
    for (const e of this.envs) e.gateOff();
  }

  get active(): boolean {
    return this.algo.carriers.some((c) => this.envs[c].active);
  }

  next(): number {
    const { mods, carriers, feedback } = this.algo;
    for (let i = 5; i >= 0; i--) {
      let pm = 0;
      for (const m of mods[i]) pm += this.out[m];
      if (i === feedback) pm += this.patch.feedback * 0.5 * (this.fb[0] + this.fb[1]);
      const y = this.ops[i].next(pm) * this.envs[i].next();
      this.out[i] = y;
      if (i === feedback) { this.fb[1] = this.fb[0]; this.fb[0] = y; }
    }
    let sum = 0;
    for (const c of carriers) sum += this.out[c];
    return sum / Math.sqrt(carriers.length);
  }
}
