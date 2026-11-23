// The step sequencer of one track, a port of Felucca's seq.c (GPL-3.0-only): its own length, step division, swing and gate
// (polymeter), NOTE / TIE / REST steps with accent, slide (legato with glide), ratchets, nudge (QUANTIZE OFF) and the
// chance or condition of a step. It advances in blocks of CTL samples, as the firmware does. See NOTICE.
import { clamp } from "../engines/dsp";
import { divSamples } from "../synth/arp";

export const ST_NOTE = 0, ST_TIE = 1, ST_REST = 2;
export const COND_FIRST = 102, NCOND = 11, COND_FILL = 10, COND_NFILL = 11;
export const COND_NAMES = ["1:2", "2:2", "1:3", "2:3", "3:3", "1:4", "2:4", "3:4", "4:4", "FILL", "!FILL"];
const COND_LOOPS = 12;
const COND_A = [1, 2, 1, 2, 3, 1, 2, 3, 4], COND_B = [2, 2, 3, 3, 3, 4, 4, 4, 4];
const NUDGE_DIV = 16;
const SEQ_REP = 1 << 16, SEQ_ROLLED = 1 << 17, SEQ_MISS = 1 << 18;

/** A step. Chance and conditions share one byte as in the firmware: 0 always, 1..100 percent, 101 never, 102.. a condition. */
export interface SeqStep {
  notes: number[];
  /** ST_NOTE, ST_TIE (the note goes on) or ST_REST. */
  time: number;
  accent?: boolean;
  slide?: boolean;
  /** Hits of the step, 1..4. */
  ratchet?: number;
  /** Timing in 1/16 of the step, -8..7 (heard with QUANTIZE OFF). */
  nudge?: number;
  /** Velocity, 0 = the default 96. */
  vel?: number;
  probability?: number;
  /** The gate in steps, overriding the track's GATE (a long note held over several steps). */
  gate?: number;
}

export interface SeqParams {
  /** Length in steps. */
  len: number;
  /** The step division (a note value: ARP_RATES order). */
  div: number;
  /** The track's swing, 0..100 (the song's is added). */
  swing: number;
  /** GATE: 0..127, 64 is half a step. */
  gate: number;
  /** QUANTIZE: 1 plays every step on its start; 0 plays its nudge. */
  quantize: number;
}
export const defaultSeqParams = (): SeqParams => ({ len: 16, div: 2, swing: 0, gate: 115, quantize: 1 });

export interface SeqOutput {
  on(note: number, vel: number): void;
  off(note: number): void;
  /** The next legato note glides (a step's slide). */
  slide(on: boolean): void;
}

let rngState = 0x2545f491;
function rng(): number {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return rngState >>> 0;
}
export function seedSeqRng(s: number): void { rngState = s >>> 0; }

const stepCond = (s: SeqStep): number => { const p = s.probability ?? 0; return p >= COND_FIRST && p < COND_FIRST + NCOND ? p - COND_FIRST + 1 : 0; };
const stepChance = (s: SeqStep): number => { const p = s.probability ?? 0; return !p ? 100 : p <= 100 ? p : p === 101 ? 0 : 100; };
const isEmpty = (s: SeqStep): boolean => s.notes.length === 0;

export class TrackSeq {
  p: SeqParams = defaultSeqParams();
  /** The song's swing (G_SWING), 0..100. */
  globalSwing = 0;
  steps: SeqStep[] = [];
  playing = false;
  idx = 0;
  pos = 0;
  /** Samples a pattern change carries into its first step. */
  carry = 0;
  /** FILL is held (conditions FILL / !FILL). */
  fill = false;
  /** The matrix's TIME: samples a step plays late (0: on time). */
  timeHook?: (note: number, vel: number, period: number) => number;
  /** Called as a step is entered (index within the track). */
  onStep?: (idx: number) => void;
  private n = 0;
  private notes: number[] = [];
  private hold = false;
  private off = 0;
  private ratLeft = 0;
  private ndLate = 0;
  private ndEarly = 0;
  private ndFired = 0;
  private condLoop = 0;
  private slideOn = false;
  /** Notes held by a step's own long gate (older songs): they end on their timer, whatever the steps after do. */
  private longs: { notes: number[]; left: number }[] = [];

  constructor(private readonly out: SeqOutput) {}

  /** Notes the sequencer holds on. */
  get sounding(): number { return this.n; }

  private get len(): number { return this.p.len > 0 ? this.p.len : 1; }
  private stepAt(i: number): SeqStep { return this.steps[i] ?? EMPTY; }

  private trackSwing(): number { return clamp(this.p.swing + this.globalSwing, 0, 100); }
  private stepSamples(period: number, idx: number): number {
    const sw = Math.trunc((this.trackSwing() * period) / 250);
    return period + (idx & 1 ? -sw : sw);
  }

  /** Every track from its step 0, together. */
  start(): void {
    this.idx = this.len - 1;
    this.pos = 0x7fffffff;
    this.carry = 0;
    this.ratLeft = 0;
    this.ndLate = this.ndEarly = 0;
    this.ndFired = 0;
    this.condLoop = 0;
    this.playing = true;
  }

  /** A new pattern (a song section) begins: step 0 fires on the next block, `carry` samples in. */
  top(carry: number): void {
    this.idx = this.len - 1;
    this.pos = 0x7fffffff;
    this.carry = carry;
    this.ratLeft = 0;
    this.ndLate = this.ndEarly = 0;
    this.ndFired = 0;
    this.condLoop = 0;
  }

  stop(): void {
    this.release();
    for (const l of this.longs) for (const x of l.notes) this.out.off(x);
    this.longs = [];
    this.playing = false;
    this.ndLate = this.ndEarly = 0;
  }

  private release(): void {
    for (let i = 0; i < this.n; i++) this.out.off(this.notes[i]);
    this.n = 0;
    this.hold = false;
    this.slideOn = false;
    this.out.slide(false);
  }

  private condMiss(s: SeqStep, idx: number): boolean {
    const c = stepCond(s);
    if (c >= COND_FILL) return (c === COND_FILL) !== this.fill;
    if (!c) return false;
    const loop = this.condLoop + (idx < this.idx ? 1 : 0);
    return loop % COND_B[c - 1] !== COND_A[c - 1] - 1;
  }
  private miss(s: SeqStep, idx: number): boolean {
    if ((s.probability ?? 0) >= COND_FIRST) return this.condMiss(s, idx);
    return stepChance(s) < 100 && rng() % 100 >= stepChance(s);
  }

  private step(s: SeqStep, idx: number, period: number, skip: number): void {
    const sg = this.p.gate;
    let gate = s.gate !== undefined ? Math.round(period * s.gate) : Math.floor((period * sg) / 128);
    const vel = s.accent ? 127 : s.vel ? s.vel : 96;
    const slideIn = this.hold && this.n > 0 && !(skip & SEQ_REP);
    const nextTie = this.stepAt((idx + 1) % this.len).time === ST_TIE;
    const hits = s.ratchet && s.ratchet > 1 ? Math.min(4, s.ratchet) : 1;
    if (!(skip & SEQ_REP)) {
      this.ratLeft = 0;
      if (skip & SEQ_MISS || (!(skip & SEQ_ROLLED) && this.miss(s, idx))) { this.release(); return; }
    }
    if (s.time === ST_TIE) {
      if (this.n) {
        this.off = gate + Math.floor(period / 2);
        this.hold = !!s.slide || nextTie;
      }
      return;
    }
    if (s.time === ST_REST || isEmpty(s)) { this.release(); return; }
    if (hits > 1) {
      const part = Math.floor(this.stepSamples(period, idx) / hits);
      gate = s.gate !== undefined ? Math.round(part * s.gate) : Math.floor((part * sg) / 128);
      if (!(skip & SEQ_REP)) this.ratLeft = hits - 1;
    }
    if (s.gate !== undefined && s.gate > 1) { // a long gate: its own timer (the notes need no later step to end them)
      this.release();
      for (const x of s.notes) this.out.on(x, vel);
      this.longs.push({ notes: [...s.notes], left: Math.round(period * s.gate) });
      return;
    }
    const nn: number[] = [];
    let sk = 0;
    for (let i = 0; i < s.notes.length; i++) {
      sk |= ((skip >> i) & 1) << nn.length;
      nn.push(s.notes[i]);
    }
    this.slideOn = slideIn;
    this.out.slide(slideIn);
    if (!slideIn) this.release();
    for (let i = 0; i < nn.length; i++) if (!((sk >> i) & 1)) this.out.on(nn[i], vel);
    if (slideIn) {
      for (let i = 0; i < this.n; i++) if (!nn.includes(this.notes[i])) this.out.off(this.notes[i]);
    }
    this.n = 0;
    for (let i = 0; i < nn.length; i++) if (!((sk >> i) & 1)) this.notes[this.n++] = nn[i];
    this.off = gate;
    this.hold = hits === 1 && (!!s.slide || nextTie);
  }

  private nudgeOf(s: SeqStep): number {
    if (this.p.quantize || s.time !== ST_NOTE || isEmpty(s) || (s.ratchet ?? 1) !== 1) return 0;
    return s.nudge ?? 0;
  }
  private timeOf(idx: number, period: number): number {
    const s = this.stepAt(idx);
    const vel = s.accent ? 127 : s.vel ? s.vel : 96;
    if (s.time !== ST_NOTE || isEmpty(s) || (s.ratchet ?? 1) !== 1) return 0;
    return this.timeHook ? this.timeHook(s.notes[0], vel, period) : 0;
  }
  private play(idx: number, period: number): void {
    const s = this.stepAt(idx);
    this.step(s, idx, period, this.miss(s, idx) ? SEQ_MISS : SEQ_ROLLED);
  }
  private playOn(period: number): void {
    const h = this.timeOf(this.idx, period);
    if (h) this.ndLate = h + 1;
    else this.play(this.idx, period);
  }
  private ndDue(period: number, len: number, curLen: number, n: number): void {
    if (this.ndLate !== 0 && (this.pos >= this.ndLate - 1 || this.pos >= curLen)) {
      this.ndLate = 0;
      this.play(this.idx, period);
    }
    if (this.ndEarly !== 0 && this.pos >= this.ndEarly - 1 && this.pos !== 0x7fffffff + n) {
      const nx = (this.idx + 1) % len;
      this.ndEarly = 0;
      this.ndFired = nx + 1;
      this.play(nx, period);
    }
  }
  private ndStart(period: number, len: number): void {
    const nx = (this.idx + 1) % len;
    let d = 0;
    this.ndEarly = 0;
    if (this.ndFired === this.idx + 1) {
      // it played early
    } else {
      const h = this.timeOf(this.idx, period);
      d = this.nudgeOf(this.stepAt(this.idx));
      if (d > 0 || h) this.ndLate = Math.floor(((d > 0 ? d : 0) * period) / NUDGE_DIV) + h + 1;
      else this.play(this.idx, period);
    }
    this.ndFired = 0;
    d = this.nudgeOf(this.stepAt(nx));
    if (d < 0) {
      let at = this.stepSamples(period, this.idx);
      const back = Math.floor((-d * period) / NUDGE_DIV);
      at = (at > back ? at - back : 0) + 1;
      this.ndEarly = at < this.ndLate ? this.ndLate : at;
    }
  }
  private enter(top: boolean, len: number): void {
    void len;
    if (!this.idx) this.condLoop = top || this.condLoop + 1 >= COND_LOOPS ? 0 : this.condLoop + 1;
    this.onStep?.(this.idx);
  }
  private ratchet(period: number): void {
    const s = this.stepAt(this.idx);
    const hits = s.ratchet && s.ratchet > 1 ? Math.min(4, s.ratchet) : 1;
    if (this.ratLeft >= hits) { this.ratLeft = 0; return; }
    if (this.pos < (hits - this.ratLeft) * Math.floor(this.stepSamples(period, this.idx) / hits)) return;
    this.ratLeft--;
    this.step(s, this.idx, period, SEQ_REP);
  }

  /** The samples one pass through the pattern takes (the swung lengths of its steps). */
  patternSamples(quarter: number): number {
    const period = divSamples(this.p.div, quarter);
    let t = 0;
    for (let i = 0; i < this.len; i++) t += this.stepSamples(period, i);
    return t;
  }

  /** Advances the track by n samples at a tempo whose quarter note is `quarter` samples. */
  tick(n: number, quarter: number): void {
    if (this.longs.length) {
      for (const l of this.longs) l.left -= n;
      for (const l of this.longs) if (l.left <= 0) for (const x of l.notes) this.out.off(x);
      this.longs = this.longs.filter((l) => l.left > 0);
    }
    if (this.n && !this.hold) {
      if (this.off <= n) this.release();
      else this.off -= n;
    }
    if (!this.playing) return;
    const period = divSamples(this.p.div, quarter);
    const len = this.len;
    this.pos = (this.pos + n) >>> 0;
    for (;;) {
      const curLen = this.stepSamples(period, this.idx);
      if (this.ndLate | this.ndEarly) this.ndDue(period, len, curLen, n);
      if (this.pos < curLen && this.pos !== 0x7fffffff + n) break;
      const top = this.pos >= 0x7fffffff;
      this.pos = top ? this.carry : this.pos - curLen;
      this.idx = (this.idx + 1) % len;
      this.enter(top, len);
      if (this.p.quantize && !this.ndFired) this.playOn(period);
      else this.ndStart(period, len);
    }
    if (this.ratLeft) this.ratchet(period);
  }
}

const EMPTY: SeqStep = { notes: [], time: ST_REST };
