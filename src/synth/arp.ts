// The arpeggiator of Felucca's seq.c (GPL-3.0-only): the held keys play one at a time (or as a chord) in time with the
// tempo. Modes UP DN UPDN RND ORD REPEAT DNUP UP+8 CONV DIVG PINKY THUMB WALK CHORD, over OCT octaves, with a rate (a note
// value), gate, swing, probability, HOLD (latch) and ORDER (as played). See NOTICE.
import { clamp } from "../engines/dsp";

export const ARP_MODES = ["OFF", "UP", "DN", "UPDN", "RND", "ORD", "REPEAT", "DNUP", "UP+8", "CONV", "DIVG", "PINKY", "THUMB", "WALK", "CHORD"];
/** The rates: a note value of the tempo (fx.c N_DIV: 1/4 1/8 1/16 1/32 8T 16T, then 1/2 1/1 2BAR 4BAR). */
export const ARP_RATES = ["1/4", "1/8", "1/16", "1/32", "8T", "16T", "1/2", "1/1", "2BAR", "4BAR"];
const AM_UP8 = 8, AM_CHORD = 14;
const DIV_DEN = [1, 2, 4, 8, 3, 6];

export interface ArpParams {
  mode: number; rate: number; oct: number; gate: number; swing: number; prob: number; hold: boolean; order: boolean;
}
export const defaultArp = (): ArpParams => ({ mode: 0, rate: 2, oct: 1, gate: 64, swing: 0, prob: 127, hold: false, order: false });

let rngState = 0x2545f491;
function rng(): number {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return rngState >>> 0;
}
export function seedArpRng(s: number): void { rngState = s >>> 0; }

/** The samples of one division (fx.c div_samples) for a quarter note of `quarter` samples. */
export function divSamples(div: number, quarter: number): number {
  return div < 6 ? Math.floor(quarter / DIV_DEN[div]) : div < 10 ? (quarter << (div - 5)) >>> 0 : Math.floor(quarter / DIV_DEN[div % 6]);
}

export class Arp {
  p: ArpParams = defaultArp();
  held: number[] = [];
  private phys = 0;
  pos = 0;
  idx = 0;
  private off = 0;
  note = 0;
  private readonly ch = [0, 0, 0];
  private walk = 0;

  constructor(private readonly out: { on(note: number, vel: number): void; off(note: number): void }) {}

  /** A key down: it joins the held notes. */
  add(note: number): void {
    if (this.p.hold && this.phys === 0) this.held = [];
    this.phys++;
    if (this.held.includes(note)) return;
    if (this.held.length < 16) this.held.push(note);
    if (this.held.length === 1) {
      this.pos = 0xfffffff;
      this.idx = 0xffffffff;
    }
  }

  remove(note: number): void {
    if (this.phys) this.phys--;
    if (this.p.hold) return;
    this.held = this.held.filter((n) => n !== note);
  }

  private chordOff(): void {
    for (let i = 0; i < 3; i++) if (this.ch[i]) { this.out.off(this.ch[i]); this.ch[i] = 0; }
  }
  private silenceNotes(): void {
    if (this.ch[0] | this.ch[1] | this.ch[2]) this.chordOff();
    this.out.off(this.note);
    this.note = 0;
  }
  /** The sounding arp note(s) end. */
  stopNotes(): void { this.silenceNotes(); }

  private chord(list: number[], n: number): void {
    const o = this.idx % (this.p.oct > 0 ? this.p.oct : 1);
    let top = 0;
    if (n > 4) n = 4;
    for (let i = 0; i < n; i++) {
      const nt = clamp(list[i] + 12 * o, 0, 127);
      if (nt === 127 && top++) continue;
      if (!this.note) this.note = nt; else this.ch[i - 1] = nt;
      this.out.on(nt, 100);
    }
  }

  private pick(list: number[], len: number): number {
    const i = this.idx, m = this.p.mode;
    if (m === AM_UP8 && len < 64) list[len++] = clamp(list[0] + 12 * this.p.oct, 0, 127);
    const cyc = len > 1 ? 2 * len - 2 : 1;
    let k = i % cyc;
    switch (m) {
      case 2: return len - 1 - (i % len);
      case 3: return k < len ? k : cyc - k;
      case 7: return k < len ? len - 1 - k : k - (len - 1);
      case 4: return rng() % len;
      case 9:
      case 10:
        k = i % len;
        if (m === 10) k = len - 1 - k;
        return k & 1 ? len - 1 - Math.floor(k / 2) : Math.floor(k / 2);
      case 11: return len < 2 ? 0 : k & 1 ? len - 1 : Math.floor(k / 2);
      case 12: return len < 2 ? 0 : k & 1 ? 1 + Math.floor(k / 2) : 0;
      case 13: {
        let w = this.walk;
        if (!i) w = 0;
        else if (w >= len) w = len - 1;
        else if (len > 1) w = !w ? 1 : w === len - 1 ? w - 1 : (rng() >>> 7) & 1 ? w + 1 : w - 1;
        this.walk = w;
        return w;
      }
      default: return i % len;
    }
  }

  /** The note list: the held notes (sorted or as played) over OCT octaves; cnt: the distinct held notes. */
  private list(): { list: number[]; len: number; cnt: number } {
    const list: number[] = [];
    let n = 0, last = 0, len = 0;
    for (const x of this.held) {
      last = x;
      let j = 0;
      while (j < n && list[j] !== x) j++;
      if (j === n) list[n++] = x;
    }
    if (!this.p.order && this.p.mode !== 5) {
      for (let i = 1; i < n; i++) {
        for (let j = i; j > 0 && list[j - 1] > list[j]; j--) { const x = list[j]; list[j] = list[j - 1]; list[j - 1] = x; }
      }
    }
    for (let o = 0; o < this.p.oct; o++) for (let i = 0; i < n && len < 64; i++) list[len++] = clamp(list[i] + 12 * o, 0, 127);
    if (n && this.p.mode === 6) { list[0] = last; len = 1; }
    return { list, len, cnt: n };
  }

  private fire(period: number): void {
    const { list, len, cnt } = this.list();
    if (!len) { if (this.note) this.stop(); return; }
    this.idx = (this.idx + 1) >>> 0;
    const j = this.p.mode === AM_CHORD ? 0 : this.pick(list, len);
    if (this.note) this.stop();
    if ((rng() & 127) <= this.p.prob) {
      this.off = Math.floor((period * this.p.gate) / 128);
      if (this.p.mode === AM_CHORD) { this.chord(list, cnt); return; }
      this.note = list[j];
      this.out.on(this.note, 100);
    }
  }
  private stop(): void {
    if (this.ch[0] | this.ch[1] | this.ch[2]) this.chordOff();
    this.out.off(this.note);
    this.note = 0;
  }

  /** Advances the arp by n samples (the tempo's quarter note is `quarter` samples). */
  step(n: number, quarter: number): void {
    if (this.note) {
      if (this.off <= n) this.stop();
      else this.off -= n;
    }
    if (!this.p.mode || !this.held.length) {
      if (!this.held.length && this.note) this.stop();
      return;
    }
    const period = divSamples(this.p.rate, quarter);
    const sw = Math.trunc((this.p.swing * period) / 250);
    this.pos = (this.pos + n) >>> 0;
    if (this.pos < period + (this.idx & 1 ? sw : -sw) && this.pos !== 0xfffffff + n) return;
    this.pos = 0;
    this.fire(period);
  }
}
