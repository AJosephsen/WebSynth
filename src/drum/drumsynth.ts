// A drum kit synth around Felucca's drum voices (eng_drum.c, GPL-3.0-only): eight mono lanes, the General MIDI drum
// map, the kits and the knobs (TUNE, TONE, DECY, SNAP, ACC, KICK, DRV). The kits 808, 909, CR78 and FM are Melodee's
// (mkit.ts, GPL-3.0-only). See NOTICE.
import { clamp, mulq15, softKnee, softclip, voiceAmp } from "../engines/dsp";
import { CTL, Vmod } from "../engines/types";
import type { Synth } from "../synth/synth";
import {
  DV_BELL, DV_CLAP, DV_HATC, DV_HATO, DV_KICK, DV_KTYPE, DV_NLANE, DV_RIM, DV_SNARE, DV_TOM, DVT_PUNCH, DVT_ROUND, DvCoef, DvMetal, DvParam, DvVoice, dvChoke,
  dvDefault, dvInit, dvMetalRun, dvMetalTune, dvRun, dvRunType, dvSetup, dvTrigger, dvUsesMetal,
} from "./dv";
import { DK_808, DK_909, DK_CR78, DK_FM, MelodeeDrum, drumMpcNote } from "./mkit";

/** KIT values (stored): STD, then the model kits; 1..3 are retired aliases; 12..15 are Melodee's kits (TR-808, TR-909, CR-78, FM). */
export const DK_NAMES = ["STD", "66", "10", "77", "80", "10", "66", "55", "77", "DEEP", "TIGHT", "PERC", "808", "909", "CR78", "FM", "ACOUSTIC"];
/** the stored KIT of each Melodee kit, and the kit number the engine (mkit.ts) knows it by */
const MEL_KITS: Record<number, number> = { 12: DK_808, 13: DK_909, 14: DK_CR78, 15: DK_FM };
const DK_80 = 4;
const DK_PLAYS = [0, 6, 5, 8, 4, 5, 6, 7, 8, 9, 10, 11];
const DV_TYPE_LANE = [DV_KICK, DV_KICK, DV_SNARE, DV_CLAP, DV_HATC, DV_HATO, DV_TOM, DV_TOM, DV_RIM, DV_RIM, DV_BELL, DV_BELL];
/** General MIDI notes 35..81 -> [the drum (DVT_*), semitones from its designed pitch]. */
const DRUM_GM: number[][] = [[0, -2], [0, 0], [8, 0], [2, 0], [3, 0], [2, 2], [6, -7], [4, 0], [6, -4], [4, -2], [6, 0], [5, 0], [6, 3], [6, 5], [11, 0], [6, 8], [11, -3], [11, 2], [10, 5], [4, 5], [11, 4], [10, 0], [11, 1], [9, -12], [11, -2], [7, 5], [7, 2], [7, 0], [7, 0], [7, -5], [6, 10], [6, 7], [10, 7], [10, 3], [4, 3], [4, 7], [9, 7], [9, 5], [4, -4], [4, -6], [9, 0], [9, -4], [9, -7], [7, 7], [7, 3], [10, 12], [10, 12]];

/** Display names of the eight lanes. */
export const LANE_NAMES = ["KICK", "SNARE", "CLAP", "HAT CL", "HAT OP", "TOM", "RIM", "BELL"];

/** The drum a note plays (GM note, folded into 35..81) and its semitones. */
function gm(params: number[], note: number): { role: number; st: number } {
  const n = note >= 35 && note <= 81 ? note : 36 + ((note + 120 - 36) % 12);
  const t = DRUM_GM[n - 35][0];
  const st = DRUM_GM[n - 35][1];
  const kit = DK_PLAYS[clamp(params[0], 0, DK_NAMES.length - 1)];
  if (kit >= DK_80) return { role: DV_KTYPE(kit - DK_80 + 1, DV_TYPE_LANE[t]), st };
  return { role: t === DVT_PUNCH && params[6] > 0 ? DVT_ROUND : t, st };
}

/** The lane a note strikes. */
export function drumLane(note: number): number {
  const n = note >= 35 && note <= 81 ? note : 36 + ((note + 120 - 36) % 12);
  return DV_TYPE_LANE[DRUM_GM[n - 35][0]];
}

class Lane {
  key: DvParam | null = null;
  c = new DvCoef();
  v = new DvVoice();
  mb = new DvMetal();
  role = 0;
  st = 0;
  vel = 100;
}

const same = (a: DvParam, b: DvParam): boolean =>
  a.type === b.type && a.decay === b.decay && a.tone === b.tone && a.extra === b.extra && a.level === b.level && a.accent === b.accent && a.tune === b.tune;

export class DrumSynth implements Synth {
  gain = 1;
  /** KIT, TUNE, TONE, DECY, SNAP, ACC, KICK, DRV (Felucca's E0..E7). */
  params: number[];
  laneLevel = new Array<number>(DV_NLANE).fill(100);
  private lanes = Array.from({ length: DV_NLANE }, () => new Lane());
  private buf = new Int32Array(CTL);
  private pos = CTL;
  private y = new Int32Array(CTL);
  private mb = new Int32Array(CTL);
  /** The part when its KIT is one of Melodee's. */
  private md: MelodeeDrum | null = null;

  constructor(params: number[]) {
    this.params = [...params];
    this.pick();
  }

  setParams(params: number[]): void {
    this.params = [...params];
    this.pick();
  }

  /** Melodee's engine for a Melodee KIT (new when the kit changes: another kit starts from rest), else none. */
  private pick(): void {
    const kit = MEL_KITS[this.params[0]];
    if (kit === undefined) { this.md = null; return; }
    if (!this.md || this.md.kit !== kit) {
      this.md = new MelodeeDrum(kit, this.params);
      this.laneLevel.fill(127);
      this.pos = CTL;
    }
    this.md.p = [kit, ...this.params.slice(1)];
  }

  get activeVoices(): number {
    return this.md ? (this.md.active ? 1 : 0) : this.lanes.filter((l) => l.v.live || l.v.trig).length;
  }

  /** The GM note of MPC pad 0..15 (drum_mpc_note: the 808's pad map, the 909's on KIT 909). */
  mpcNote(pad: number): number {
    return drumMpcNote(this.md?.kit ?? DK_808, pad);
  }

  noteOn(note: number, velocity = 100): void {
    if (this.md) { this.md.noteOn(note, velocity); return; }
    const { role, st } = gm(this.params, note);
    const lane = drumLane(note);
    const L = this.lanes[lane];
    if (L.role !== role || L.v.type !== dvRunType(role)) {
      dvInit(L.v, role);
      L.key = null;
      L.role = role;
    }
    L.st = st;
    L.vel = clamp(velocity, 1, 127);
    dvTrigger(L.v);
    if (lane === DV_HATC && this.lanes[DV_HATO].v.live) dvChoke(this.lanes[DV_HATO].v);
  }

  noteOff(): void { /* the hit is the envelope */ }
  allOff(): void { /* hits ring out */ }

  private block(): void {
    const p = this.params;
    this.buf.fill(0);
    const drv = p[7];
    let g = 0, mk = 0;
    if (drv > 0) {
      g = 4096 + Math.trunc((drv * 3 * 4096) / 127);
      mk = Math.floor((19661 * 32768) / softclip((19661 * g) >> 12));
    }
    this.lanes.forEach((L, li) => {
      if (!L.v.live && !L.v.trig) return;
      const k = dvDefault(L.role);
      k.decay = clamp(k.decay + p[3] - 64, 0, 127);
      k.tone = clamp(k.tone + p[2] - 64, 0, 127);
      k.extra = clamp(k.extra + p[4] - 64, 0, 127);
      const acc = clamp(p[5] * L.vel * 4, 0, 65536);
      k.accent = clamp(acc >> 9, 0, 127);
      k.tune = L.st * 16 + (p[1] - 64) * 3;
      if (!L.key || !same(k, L.key)) {
        dvSetup(L.c, k);
        L.key = k;
        if (dvUsesMetal(L.c.type)) dvMetalTune(L.mb, L.c);
      }
      if (dvUsesMetal(L.c.type) && (L.v.live || L.v.trig)) dvMetalRun(L.mb, this.mb, CTL);
      dvRun(L.c, L.v, this.mb, this.y, CTL);
      // the hit's amplitude: its velocity, held; the lane's LEVEL (square law) on it
      let amp = mulq15(32767, L.vel * 258);
      const lv = clamp(this.laneLevel[li], 0, 127);
      if (lv < 127) {
        const gl = lv * lv * 2 + (lv * lv >> 6);
        amp = ((amp >> 4) * gl) >> 11;
      }
      const m: Vmod = { amp0: amp, amp1: amp, pitch16: 0, inc: 0, cutoff: 0, shape: 0, envq15: 0, fine: 0 };
      for (let i = 0; i < CTL; i++) {
        let s = this.y[i];
        if (g) s = Math.imul(softclip(Math.imul(s, g) >> 12), mk) >> 15;
        this.buf[i] += voiceAmp(softKnee(s + (s >> 2), 24000), m, i) << 1;
      }
    });
  }

  readonly keyKit = true;

  render(out: Float32Array, start: number, n: number): void {
    if (this.activeVoices === 0 && this.pos >= CTL) return;
    for (let i = 0; i < n; i++) {
      if (this.pos >= CTL) {
        if (this.activeVoices === 0) return;
        if (this.md) {
          this.buf.fill(0);
          this.md.ln = this.laneLevel;
          this.md.block(this.buf);
        } else this.block();
        this.pos = 0;
      }
      out[start + i] += (this.buf[this.pos++] / 32768) * 0.6 * this.gain;
    }
  }
}

/** Felucca's four drum presets (E0..E7 = KIT TUNE TONE DECY SNAP ACC KICK DRV), plus one per model kit. */
export const DRUM_PRESETS: { name: string; params: number[]; fx: number[] }[] = [
  { name: "DRUM KIT", params: [0, 64, 70, 64, 64, 100, 0, 0], fx: [0, 0, 0, 20] },
  { name: "DEEP KIT", params: [9, 64, 64, 64, 64, 100, 0, 0], fx: [0, 0, 0, 28] },
  { name: "TIGHT KIT", params: [10, 64, 64, 56, 64, 100, 0, 16], fx: [0, 0, 0, 8] },
  { name: "PERC KIT", params: [11, 64, 64, 64, 64, 100, 0, 0], fx: [0, 0, 0, 24] },
  { name: "80 KIT", params: [4, 64, 64, 64, 64, 100, 0, 0], fx: [0, 0, 0, 20] },
  { name: "10 KIT", params: [5, 64, 64, 64, 64, 100, 0, 0], fx: [0, 0, 0, 20] },
  { name: "66 KIT", params: [6, 64, 64, 64, 64, 100, 0, 0], fx: [0, 0, 0, 20] },
  { name: "55 KIT", params: [7, 64, 64, 64, 64, 100, 0, 0], fx: [0, 0, 0, 20] },
  { name: "77 KIT", params: [8, 64, 64, 64, 64, 100, 0, 0], fx: [0, 0, 0, 20] },
  { name: "808 KIT", params: [12, 64, 64, 64, 64, 100, 0, 0], fx: [0, 0, 0, 20] },
  { name: "909 KIT", params: [13, 64, 64, 64, 64, 100, 0, 0], fx: [0, 0, 0, 20] },
  { name: "CR78 KIT", params: [14, 64, 64, 64, 64, 100, 0, 0], fx: [0, 0, 0, 20] },
  { name: "FM KIT", params: [15, 64, 64, 64, 64, 100, 0, 0], fx: [0, 0, 0, 20] },
  // the acoustic snare and toms: TUNE TONE DECY SNAP (wires) ACC (velocity response) KICK (pitch fall) DRV (shell)
  { name: "ACOUSTIC", params: [16, 64, 70, 64, 90, 80, 64, 40], fx: [0, 0, 0, 20] },
  { name: "ACOUSTIC FUSION", params: [16, 76, 90, 50, 105, 90, 50, 25], fx: [0, 0, 0, 12] },
  { name: "ACOUSTIC ROOM", params: [16, 60, 55, 84, 70, 70, 90, 95], fx: [0, 0, 0, 40] },
];
