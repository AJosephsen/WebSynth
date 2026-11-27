// An acoustic snare and tom model (written for this project from the published methods; not a port of any firmware). A hit excites the modes of a
// circular membrane, struck near its centre: the ideal-membrane ratios 1, 1.593, 2.136, 2.296 ... of the batter head, a resonant head tuned a little
// away from it (the beating of a real tom), and a few damped shell modes. The pitch starts high and falls in tens of milliseconds, more with a harder hit
// (tension modulation), the higher modes decay faster, and a stick transient of filtered noise opens the sound. The snare drum adds the wires: noise through
// a band-pass whose level follows the head's movement and then rattles on for a while. The kick is a muted bass drum: one deep, quickly damped head with a
// soft beater. GM notes 35 / 36 (kick), 37 (side stick), 38 / 40 (snare), 41 43 45 47 48 50 (toms). The drums share a gated room: a short dense reverb fed by the
// hits whose tail is cut off hard after a hold time (the gated drum sound of the eighties).
// TUNE, TONE (the stick and the upper modes), DECY, SNAP (the wires), ACC (velocity response), KICK (the pitch fall), DRV (the shell), GATE (the hold of the gated
// room, 0 = off, up to 0.4 s) and ROOM (its level) are the kit's knobs.
import { FS } from "../engines/types";
import type { Synth } from "../synth/synth";

export const DK_ACOUSTIC = 16;
const RATIO = [1, 1.593, 2.136, 2.296, 2.653, 2.918, 3.156, 3.501];
const AMP = [1, 0.55, 0.38, 0.3, 0.2, 0.16, 0.12, 0.08];
const TOM_HZ: Record<number, number> = { 41: 82, 43: 98, 45: 117, 47: 139, 48: 156, 50: 175 };
const TOM_TAU: Record<number, number> = { 41: 0.42, 43: 0.36, 45: 0.31, 47: 0.27, 48: 0.24, 50: 0.21 };
const TWO_PI = Math.PI * 2;

interface Mode { f: number; amp: number; decay: number; env: number; ph: number }
class Hit {
  active = false;
  note = 0;
  t = 0;
  modes: Mode[] = [];
  shell: Mode[] = [];
  bend = 0;
  bendDecay = 0;
  bendEnv = 0;
  snare = false;
  wires = 0;
  wireDecay = 0;
  wireEnv = 0;
  follow = 0;
  stick = 0;
  stickDecay = 0;
  rim = false;
  hp1 = 0; lp1 = 0; lp2 = 0; hp2 = 0;
  vel = 1;
  age = 0;
}

export class AcousticDrums implements Synth {
  gain = 1;
  readonly keyKit = true;
  readonly voiceMode = 0;
  private hits = Array.from({ length: 12 }, () => new Hit());
  private rng = 0x2545f491;
  private gateLeft = 0;
  private gateEnv = 0;
  private rev = new GatedRoom();
  private n = 0;
  /** KIT, TUNE, TONE, DECY, SNAP, ACC, KICK, DRV. */
  params: number[];

  constructor(params: number[]) { this.params = [...params]; }
  setParams(p: number[]): void { this.params = [...p]; }
  get activeVoices(): number { return this.hits.filter((h) => h.active).length; }
  private gateSamples(): number { return Math.round(((this.params[8] ?? 0) / 127) * 0.4 * FS); }
  private noise(): number { let x = this.rng; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rng = x >>> 0; return (this.rng / 2147483648) - 1; }

  noteOn(note: number, velocity = 100): void {
    const isTom = note in TOM_HZ, isSnare = note === 38 || note === 40, isRim = note === 37, isKick = note === 35 || note === 36;
    if (!isTom && !isSnare && !isRim && !isKick) return;
    const p = this.params;
    const tune = Math.pow(2, ((p[1] ?? 64) - 64) / 64), tone = (p[2] ?? 64) / 127, dec = Math.pow(2, ((p[3] ?? 64) - 64) / 48);
    const wires = (p[4] ?? 90) / 127, sens = (p[5] ?? 80) / 127, bendK = (p[6] ?? 64) / 127, shellK = (p[7] ?? 40) / 127;
    const v = Math.pow(Math.max(1, Math.min(127, velocity)) / 127, 1 - 0.55 * sens);
    let h = this.hits.find((x) => x.active && x.note === note) ?? this.hits.find((x) => !x.active);
    if (!h) h = this.hits.reduce((a, b) => (a.age < b.age ? a : b));
    h.active = true; h.note = note; h.t = 0; h.vel = v; h.age = ++this.n; h.rim = isRim; h.snare = isSnare;
    h.modes = []; h.shell = [];
    h.hp1 = h.lp1 = h.lp2 = h.hp2 = 0; h.follow = 0; h.wireEnv = 1;
    this.gateLeft = this.gateSamples();
    if (isKick) { // a muted bass drum: a deep head that is damped at once, a soft beater, a little fall in pitch
      const f = (note === 35 ? 50 : 55) * tune;
      for (const [r, a, t] of [[1, 1, 0.1], [1.593, 0.25, 0.04], [2.136, 0.1, 0.025]]) h.modes.push({ f: f * r, amp: a * (r === 1 ? 1 : 0.4 + 0.6 * v), decay: Math.exp(-1 / (t * dec * FS)), env: 1, ph: 0 });
      h.shell.push({ f: 95 * tune, amp: 0.25 * shellK * (0.4 + 0.6 * v), decay: Math.exp(-1 / (0.05 * FS)), env: 1, ph: 0.3 });
      h.bend = (0.05 + 0.1 * bendK) * (0.3 + 0.7 * v); h.bendDecay = Math.exp(-1 / (0.03 * FS)); h.bendEnv = 1;
      h.stick = 0.3 * (0.3 + 0.7 * tone) * (0.4 + 0.6 * v); h.stickDecay = Math.exp(-1 / (0.004 * FS)); h.wires = 0;
      return;
    }
    if (isRim) { // a side stick: a click and two short wooden modes
      for (const [f, a, t] of [[1650, 1, 0.012], [3100, 0.6, 0.008], [880, 0.5, 0.02]]) h.modes.push({ f: f * tune, amp: a * (0.4 + 0.6 * v), decay: Math.exp(-1 / (t * FS)), env: 1, ph: 0 });
      h.stick = 1.1 * v; h.stickDecay = Math.exp(-1 / (0.0007 * FS)); h.bend = 0; h.wires = 0;
      return;
    }
    const f0 = (isSnare ? (note === 40 ? 198 : 184) : TOM_HZ[note]) * tune;
    const tau1 = (isSnare ? 0.11 : TOM_TAU[note]) * dec;
    const bright = 0.35 + 0.65 * tone;
    // the batter head and the resonant head (tuned a little off it)
    for (let head = 0; head < 2; head++) {
      const detune = head === 0 ? 1 : isSnare ? 1.07 : 0.955;
      for (let k = 0; k < RATIO.length; k++) {
        const hz = f0 * RATIO[k] * detune;
        if (hz > 9000) continue;
        const tau = tau1 / (1 + 0.85 * k) * (head ? 0.8 : 1);
        const a = AMP[k] * (k ? bright * (0.5 + 0.5 * v) : 1) * (head ? 0.42 : 1);
        h.modes.push({ f: hz, amp: a, decay: Math.exp(-1 / (tau * FS)), env: 1, ph: k * 0.7 });
      }
    }
    if (shellK > 0.01) for (const [f, t, a] of [[isSnare ? 240 : 190 * (f0 / 117), 0.05, 0.5], [isSnare ? 410 : 330 * (f0 / 117), 0.035, 0.3]]) h.shell.push({ f, amp: a * shellK * (0.4 + 0.6 * v), decay: Math.exp(-1 / (t * FS)), env: 1, ph: 0.4 });
    h.bend = (0.025 + 0.11 * bendK) * (0.3 + 0.7 * v); h.bendDecay = Math.exp(-1 / (0.045 * FS)); h.bendEnv = 1;
    h.stick = (0.35 + 0.65 * tone) * (0.4 + 0.6 * v); h.stickDecay = Math.exp(-1 / (0.0022 * FS));
    h.wires = isSnare ? wires * (0.35 + 0.65 * v) : 0; h.wireDecay = Math.exp(-1 / (0.19 * dec * FS));
  }

  noteOff(): void { /* the hit is the envelope */ }
  allOff(): void { for (const h of this.hits) h.active = false; }

  render(out: Float32Array, start: number, n: number): void {
    const g = this.gain * 0.95, p = this.params, roomK = (p[9] ?? 0) / 127, gated = (p[8] ?? 0) > 0;
    if (!this.hits.some((h) => h.active) && this.gateEnv < 1e-4 && !this.rev.ringing()) return;
    for (let i = 0; i < n; i++) {
      let dry = 0;
      for (const h of this.hits) if (h.active) dry += this.voice(h) * (0.45 + 0.55 * h.vel);
      const d = Math.tanh(dry * 1.1) * g;
      out[start + i] += d;
      if (roomK > 0) {
        // the gate: open while it is held after the last hit, then closed in about 12 ms
        if (this.gateLeft > 0) { this.gateLeft--; this.gateEnv = 1; } else this.gateEnv = gated ? Math.max(0, this.gateEnv - 1 / (0.012 * FS)) : 1;
        out[start + i] += this.rev.process(d) * this.gateEnv * roomK * 0.9;
      }
    }
  }

  /** One sample of a hit (before the velocity scale); ends the hit when it has died away. */
  private voice(h: Hit): number {
    let s = 0;
    const fm = 1 + h.bend * h.bendEnv;
    for (const m of h.modes) {
      m.ph += (TWO_PI * m.f * fm) / FS;
      if (m.ph > TWO_PI) m.ph -= TWO_PI;
      s += Math.sin(m.ph) * m.amp * m.env;
      m.env *= m.decay;
    }
    let shell = 0;
    for (const m of h.shell) { m.ph += (TWO_PI * m.f) / FS; shell += Math.sin(m.ph) * m.amp * m.env; m.env *= m.decay; }
    h.bendEnv *= h.bendDecay;
    const head = s * 0.28 + shell * 0.2;
    let y = head;
    if (h.stick > 1e-4) { // the stick: noise through a high-pass
      const nz = this.noise();
      h.hp1 += 0.45 * (nz - h.hp1);
      y += (nz - h.hp1) * h.stick * 0.55;
      h.stick *= h.stickDecay;
    }
    if (h.rim) y = y * 1.4;
    if (h.wires > 0) { // the snare wires: noise through a band-pass, rattling with the head, then on by themselves
      const nz = this.noise();
      h.lp1 += 0.62 * (nz - h.lp1);
      h.hp2 += 0.1 * (h.lp1 - h.hp2);
      const band = h.lp1 - h.hp2;
      h.follow = Math.max(Math.abs(head) * 3.2, h.follow * 0.9992);
      h.wireEnv *= h.wireDecay;
      y += band * h.wires * 0.55 * (0.62 * Math.min(1, h.follow) + 0.38 * h.wireEnv);
    }
    h.t++;
    const quiet = !h.modes.length || h.modes[0].env < 5e-4;
    if (quiet && h.stick < 1e-3 && (!h.wires || h.wireEnv < 1e-3) && h.t > 800) h.active = false;
    return y;
  }
}

/** A short dense room: four combs and two all-passes (Schroeder), 20-45 ms long, for the gated reverb. */
class GatedRoom {
  private readonly comb = [0.0297, 0.0371, 0.0411, 0.0437].map((t) => ({ buf: new Float32Array(Math.round(t * FS)), i: 0, lp: 0 }));
  private readonly ap = [0.005, 0.0017].map((t) => ({ buf: new Float32Array(Math.round(t * FS)), i: 0 }));
  private quiet = 0;
  process(x: number): number {
    let y = 0;
    for (const c of this.comb) {
      const o = c.buf[c.i];
      c.lp += 0.45 * (o - c.lp); // the highs die first
      c.buf[c.i] = x * 0.5 + c.lp * 0.8;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    y *= 0.35;
    for (const a of this.ap) {
      const o = a.buf[a.i];
      const w = y + o * 0.5;
      a.buf[a.i] = w;
      y = o - w * 0.5;
      a.i = (a.i + 1) % a.buf.length;
    }
    this.quiet = Math.abs(y) < 1e-5 && Math.abs(x) < 1e-5 ? this.quiet + 1 : 0;
    return y;
  }
  ringing(): boolean { return this.quiet < 20000; }
}
