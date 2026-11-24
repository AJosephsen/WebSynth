// Port of the DRUM engine of Melodee (eng_drum.c, with the voice path of voice.c it plays through; GPL-3.0-only, Copyright (C) 2026
// Kerem Kilic; retained Felucca portions Copyright (C) 2026 Leo Kuroshita, Hügelton Instruments): the kits KIT 808 (drum_808.c),
// KIT 909 (x0x/drum909.c), KIT CR78 (drum_cr78.c) and KIT FM (drum_fm.c). Eight lanes per part (one voice each; a lane kit is one
// voice), the General MIDI drum map, closed hats choking open ones, a hit's velocity and ACC, the lane levels, DRV and the HIT
// page's four edits per drum. KIT SID (drum_sid.c) is not ported. See NOTICE.
import { clamp, mulq15, softclip } from "../engines/dsp";
import { CTL } from "../engines/types";
import { Dr8, Dr8Scratch, dr8Hit, dr8Ins, dr8Run, DR_CH, DR_OH } from "./m808";
import { D9_BD, D9_CH, D9_CP, D9_CR, D9_HT, D9_LT, D9_MS, D9_MT, D9_NUM, D9_OH, D9_RD, D9_RS, D9_SD, D9_SPECS, Drum909, d9Ceil, envExp } from "./m909";
import { DV_NLANE, DlkPart } from "./mlanes";
import { Dither, dr8Level, drExp, drLp1, mulShr, softKneeI, voiceAmpD } from "./mdsp";
import { fmClampf, fmExp2f } from "./fastmath";

export const DK_808 = 4, DK_909 = 5, DK_SID = 6, DK_CR78 = 7, DK_FM = 8;
export const DV_KICK = 0, DV_SNARE = 1, DV_CLAP = 2, DV_HATC = 3, DV_HATO = 4, DV_TOM = 5, DV_RIM = 6, DV_BELL = 7;
const DVT_PUNCH = 0, DVT_ROUND = 1, DVT_SNARE = 2, DVT_CLAP = 3, DVT_HATC = 4, DVT_HATO = 5, DVT_TOM = 6, DVT_CONGA = 7, DVT_RIM = 8, DVT_CLAVE = 9, DVT_BELL = 10, DVT_CYM = 11;
const DV_TYPE_LANE = [DV_KICK, DV_KICK, DV_SNARE, DV_CLAP, DV_HATC, DV_HATO, DV_TOM, DV_TOM, DV_RIM, DV_RIM, DV_BELL, DV_BELL];

/** General MIDI notes 35..81 -> [the drum (DVT_*), semitones from its designed pitch] */
const DRUM_GM: number[][] = [
  [DVT_PUNCH, -2], [DVT_PUNCH, 0], [DVT_RIM, 0], [DVT_SNARE, 0], [DVT_CLAP, 0], [DVT_SNARE, 2],
  [DVT_TOM, -7], [DVT_HATC, 0], [DVT_TOM, -4], [DVT_HATC, -2], [DVT_TOM, 0], [DVT_HATO, 0],
  [DVT_TOM, 3], [DVT_TOM, 5], [DVT_CYM, 0], [DVT_TOM, 8], [DVT_CYM, -3], [DVT_CYM, 2],
  [DVT_BELL, 5], [DVT_HATC, 5], [DVT_CYM, 4], [DVT_BELL, 0], [DVT_CYM, 1], [DVT_CLAVE, -12],
  [DVT_CYM, -2], [DVT_CONGA, 5], [DVT_CONGA, 2], [DVT_CONGA, 0], [DVT_CONGA, 0], [DVT_CONGA, -5],
  [DVT_TOM, 10], [DVT_TOM, 7], [DVT_BELL, 7], [DVT_BELL, 3], [DVT_HATC, 3], [DVT_HATC, 7],
  [DVT_CLAVE, 7], [DVT_CLAVE, 5], [DVT_HATC, -4], [DVT_HATC, -6], [DVT_CLAVE, 0], [DVT_CLAVE, -4],
  [DVT_CLAVE, -7], [DVT_CONGA, 7], [DVT_CONGA, 3], [DVT_BELL, 12], [DVT_BELL, 12],
];
const gmFold = (note: number): number => (note >= 35 && note <= 81 ? note : 36 + ((note + 120 - 36) % 12));

/** the drum of a note (DVT_*) and its semitones; KICK picks the kick */
function drumGm(p: ArrayLike<number>, note: number): { role: number; st: number } {
  const e = DRUM_GM[gmFold(note) - 35];
  return { role: e[0] === DVT_PUNCH && p[6] > 0 ? DVT_ROUND : e[0], st: e[1] };
}
/** the lane a GM note strikes */
export const mdrumLane = (note: number): number => DV_TYPE_LANE[DRUM_GM[gmFold(note) - 35][0]];

/** drum_sound_of's map from the 808's instruments to the sound numbers (D9_* and 11..15) */
const SOUND_OF_DR = [D9_BD, D9_SD, D9_LT, D9_MT, D9_HT, 11, 12, 13, D9_RS, 14, D9_CP, 15, D9_RD, D9_CR, D9_OH, D9_CH];

export function drum909Ins(note: number): number {
  if (note === 49 || note === 52 || note === 55 || note === 57) return D9_CR;
  if (note === 51 || note === 53 || note === 59 || note === 56) return D9_RD;
  switch (mdrumLane(note)) {
    case DV_KICK: return D9_BD;
    case DV_SNARE: return D9_SD;
    case DV_CLAP: return D9_CP;
    case DV_HATC: return D9_CH;
    case DV_HATO: return D9_OH;
    case DV_RIM: return D9_RS;
    default: return note < 45 ? D9_LT : note < 48 ? D9_MT : D9_HT;
  }
}

/** the GM note of each of the 16 sounds, and their names (eng_drum.c) */
export const DRUM_SOUND_NOTE = [36, 38, 41, 45, 50, 37, 39, 42, 46, 49, 51, 64, 61, 60, 75, 70];
export const DRUM_SOUND_NAME = ["KICK", "SNARE", "TOM L", "TOM M", "TOM H", "RIM", "CLAP", "HAT C", "HAT O", "CRASH", "RIDE", "CONGL", "CONGM", "CONGH", "CLAVE", "MARAC"];
export const DRUM_CR78_NAME = ["KICK", "SNARE", "TOM L", "TOM M", "TOM H", "RIM", "TAMB", "HAT C", "HAT O", "CYMB", "BELL", "CONGA", "BONGL", "BONGH", "CLAVE", "MARAC"];
const PAD_808 = [D9_BD, D9_SD, D9_CP, D9_RS, D9_CH, D9_OH, D9_RD, D9_CR, D9_LT, D9_MT, D9_HT, 15, 11, 12, 13, 14];
const PAD_909 = [D9_BD, D9_SD, D9_CP, D9_RS, D9_CH, D9_OH, D9_RD, D9_CR, D9_LT, D9_MT, D9_HT, D9_RD, D9_BD, D9_SD, D9_CH, D9_OH];
/** drum_sound_note: the GM note of a sound (the 808's bell is its cowbell, GM 56) */
export const drumSoundNote = (kit: number, sound: number): number => (kit !== DK_909 && sound === D9_RD ? 56 : DRUM_SOUND_NOTE[sound]);
/** drum_mpc_note: MPC pad 0..15 (pads 01..16 from the bottom left) -> GM note; sound identities, independent of scale and octave */
export const drumMpcNote = (kit: number, pad: number): number => drumSoundNote(kit, (kit === DK_909 ? PAD_909 : PAD_808)[pad & 15]);

class Voice {
  active = 0; gate = 0; stage = 0; note = 0; vel = 0; age = 0; envOut = 0;
  s0 = 0; s1 = 0; s2 = 0; s3 = 0; s5 = 0;
}
class Lane8 {
  r = new Dr8();
  owner = 0;
  role = 0;
  sound = 0;
  st = 0;
}

const NVOICE = 16;

/** One part of DRUM on one of the Melodee kits, block by block as track_render plays it. */
export class MelodeeDrum {
  /** KIT_808, 909, CR78 or FM (DK_*) */
  readonly kit: number;
  /** E0..E7: KIT TUNE TONE DECY SNAP ACC KICK DRV (KICK is CR78's HATS) */
  p: number[];
  /** the eight lane levels (127 = the original gain) */
  ln = new Array<number>(DV_NLANE).fill(127);
  /** the HIT page: four edits (pitch -24..24, decay -64..63, character -64..63, level 0..127 down) of each of the 16 drums */
  patch = new Int8Array(64);
  /** the pitch (semitones) and length (samples, 0 = the drum's own) the next hit takes (a sequencer step's) */
  eventPitch = 0;
  eventLength = 0;
  readonly dither = new Dither();
  private v = Array.from({ length: NVOICE }, () => new Voice());
  private vage = 0;
  private rr = 0;
  private lanes = Array.from({ length: DV_NLANE }, () => new Lane8());
  private sc = new Dr8Scratch();
  private d9 = new Drum909();
  private owner9 = new Uint8Array(D9_NUM);
  private nz9 = 0;
  private dlk: DlkPart;
  private y = new Int32Array(CTL);
  private f = new Float32Array(CTL);

  constructor(kit: number, p: number[]) {
    this.kit = kit;
    this.p = [...p];
    this.p[0] = kit;
    this.dlk = new DlkPart(kit === DK_CR78);
  }

  private get is909(): boolean { return this.kit === DK_909; }
  private get isLane(): boolean { return this.kit >= DK_CR78; }
  private get np(): number { return this.isLane ? 1 : DV_NLANE; }

  get active(): boolean { return this.v.some((x) => x.active); }

  private pc(sound: number): Int8Array { return this.patch.subarray(sound * 4, sound * 4 + 4); }

  // ------------------------------------------------------------------ voices (voice.c)
  private reuse(note: number): Voice | null {
    if (this.isLane) return this.v[0].active ? this.v[0] : null;
    if (this.is909) {
      const o = this.owner9[drum909Ins(note)];
      return o && o <= NVOICE && this.v[o - 1].active && this.v[o - 1].s2 === DK_909 ? this.v[o - 1] : null;
    }
    const lane = mdrumLane(note);
    const o = this.lanes[lane].owner;
    if (!o || o > NVOICE) return null;
    const v = this.v[o - 1];
    return v.active && v.s0 === lane ? v : null;
  }

  private alloc(note: number): Voice {
    const r = this.reuse(note);
    if (r) return r;
    const np = this.np;
    for (let i = 0; i < np; i++) if (this.v[i].active && this.v[i].note === note) return this.v[i];
    let best = np;
    for (let i = 0; i < np && best === np; i++) {
      const k = (this.rr + i) % np;
      if (!this.v[k].active) best = k;
    }
    this.rr = ((best === np ? this.rr : best) + 1) % np;
    if (best < np) return this.v[best];
    let low = np;
    for (let i = 0; i < np; i++) if (this.v[i].gate && (low === np || this.v[i].note < this.v[low].note)) low = i;
    for (let i = 0; i < np; i++) if (!this.v[i].gate && this.v[i].stage !== 4 && (best === np || this.v[i].age < this.v[best].age)) best = i;
    if (best === np) for (let i = 0; i < np; i++) if (i !== low && (best === np || this.v[i].age < this.v[best].age)) best = i;
    return this.v[best === np ? 0 : best];
  }

  /** a hit: GM note at velocity 1..127 */
  noteOn(note: number, vel: number): void {
    vel = clamp(vel | 0, 1, 127);
    const v = this.alloc(note);
    const sounding = v.active && v.stage !== 0;
    v.note = note;
    v.vel = vel;
    v.gate = 1;
    v.active = 1;
    v.stage = 1;
    v.age = ++this.vage;
    if (!sounding) v.envOut = 0;
    this.drumNoteOn(v, note, vel);
  }

  // ------------------------------------------------------------------ eng_drum.c
  private drumNoteOn(v: Voice, note: number, vel: number): void {
    const p = this.p;
    v.s3 = this.eventLength;
    v.s5 = this.eventLength !== 0 ? 1 : 0;
    if (this.isLane) {
      v.s2 = this.kit;
      v.s5 = 0;
      const { role, st } = drumGm(p, note);
      const lane = DV_TYPE_LANE[role];
      const sound = SOUND_OF_DR[dr8Ins(note, role)] & 15;
      this.dlk.hit(lane, sound, vel, st, this.pc(sound), p, this.eventPitch, this.eventLength);
      v.envOut = 32767;
      return;
    }
    const idx = this.v.indexOf(v);
    if (this.is909) {
      const ins = drum909Ins(note);
      const o = idx + 1;
      for (let j = 0; j < D9_NUM; j++) if (this.owner9[j] === o) this.owner9[j] = 0;
      this.owner9[ins] = o;
      v.s0 = mdrumLane(note);
      v.s1 = ins;
      v.s2 = DK_909;
      this.values909(ins, this.eventPitch, vel);
      v.envOut = 32767;
      return;
    }
    v.s2 = DK_808;
    const { role, st } = drumGm(p, note);
    const lane = DV_TYPE_LANE[role];
    let L = this.lanes[v.s0 & (DV_NLANE - 1)];
    if (L.owner === idx + 1) L.owner = 0;
    L = this.lanes[lane];
    L.st = st;
    L.owner = idx + 1;
    v.s0 = lane;
    L.role = role;
    const ins = dr8Ins(note, role);
    L.sound = SOUND_OF_DR[ins];
    const c = this.pc(L.sound);
    const local = this.values808(L.sound);
    L.r.decay = c[1];
    L.r.pitch = (c[0] + this.eventPitch) * 16;
    dr8Hit(L.r, ins, vel, local);
    v.envOut = mulq15(127 * 258, dr8Level(vel, p[5]));
    if (lane === DV_HATC && ins === DR_CH) {
      const o = this.lanes[DV_HATO];
      if (o.r.on && o.r.ins === DR_OH) o.r.choke = 1;
    }
  }

  /** drum808_values: the part's knobs with the HIT page's edits of the sound */
  private values808(sound: number): number[] {
    const q = [...this.p];
    const c = this.pc(sound);
    q[3] = clamp(q[3] + c[1], 0, 127);
    if (sound === D9_SD) q[4] = clamp(q[4] + c[2], 0, 127);
    return q;
  }

  /** drum909_values: the panel of the struck drum from the knobs and the HIT page, then its trigger */
  private values909(ins: number, pitch: number, vel: number): void {
    const f = Math.fround;
    const d = this.d9;
    const p = this.p;
    const c = this.pc(ins);
    const specs = D9_SPECS[ins];
    for (let j = 0; j < specs.length; j++) {
      const s = specs[j];
      let value = s.def;
      if (s.field === 1 || s.field === 9 || (ins >= D9_RS && s.field === 0)) value += c[2] + (s.field === 9 ? 0 : p[2] - 64);
      if (s.field === 9) value += p[4] - 64;
      if (s.field === 8) value += p[2] - 64;
      d.setPanel(ins, j, value);
    }
    const ratio = fmExp2f(f(f(f(c[0] + pitch) / 12) + f(f(f(p[1] - 64) * 3) / 192)));
    const decay = fmExp2f(f(f(c[1] + p[3] - 64) / 24));
    if (ins <= D9_HT) {
      const DEC = [1380, 320, 1700, 1050, 1100];
      const b = d.bt[ins];
      b.decay = f(DEC[ins] * decay);
      if (ins === D9_SD) {
        b.tune = f(b.tune * ratio);
        b.tune2 = f(325 * ratio);
        b.noiseDecay = f(f(1200 * fmExp2f(f(f(p[2] - 64) / 24))) * decay);
      } else if (ins !== D9_BD) b.tune = f(b.tune * ratio);
    } else if (ins === D9_RS) {
      d.rim.tune = f(d.rim.tune * ratio);
      d.rim.tune2 = f(220 * ratio);
      d.rim.decay = f(40 * decay);
      d.rimRetune();
    } else if (ins === D9_CP) {
      d.clap.tune = f(d.clap.tune * ratio);
      d.clap.tailDecay = f(d.clap.tailDecay * decay);
      d.clapRetune();
    } else {
      const s = d.smp[ins - D9_CH];
      s.pitch = f(s.pitch * ratio);
      s.decay = f(s.decay * decay);
      d.smpRate(ins - D9_CH);
    }
    d.prep(ins);
    d.accent = f(f(2 * f(dr8Level(vel, p[5]))) / f(dr8Level(vel, 100)));
    if (ins === D9_BD && p[6]) d.bt[0].attack = f(d.bt[0].attack * f(0.5));
    d.trigger(ins, f(f(vel) / 127));
    if (ins === D9_SD) {
      const b = d.bt[1];
      b.decay = f(340 * decay);
      envExp(b.amp, f(0.00001), f(b.decay * D9_MS));
      b.mute = d9Ceil(f(f(f(b.noiseDecay + b.decay) + 60) * D9_MS));
    }
    if (ins === D9_RS) {
      d.rim.decay = f(200 * decay);
      envExp(d.rim.amp, f(0.00001), f(d.rim.decay * D9_MS));
      d.rim.mute = d9Ceil(f(f(d.rim.decay + 20) * D9_MS));
    }
    if (ins === D9_BD) {
      const b = d.bt[0];
      b.bdBase = f(b.bdBase * ratio);
      b.bdDf = f(b.bdDf * f(ratio * (p[6] ? f(0.5) : 1)));
      b.pitch.v = f(b.pitch.v * ratio);
    }
  }

  /** drum_amp: the voice's amplitude (0 ends it) */
  private amp(v: Voice, idx: number): number {
    const p = this.p;
    if (this.isLane) {
      if (v.s2 === p[0] && this.dlk.tick()) return Math.trunc((32767 * 127) / (v.vel ? v.vel : 1));
      v.active = v.gate = v.stage = 0;
      return 0;
    }
    if (v.s5 && v.s3 <= 0) {
      v.active = v.gate = v.stage = 0;
      return 0;
    }
    if (this.is909 && v.s2 === DK_909) {
      const ins = v.s1;
      if (ins < D9_NUM && this.owner9[ins] === idx + 1 && this.d9.live(ins)) return Math.trunc((32767 * 127) / (v.vel ? v.vel : 1));
      v.active = v.gate = v.stage = 0;
      return 0;
    }
    const L = this.laneOf(v, idx);
    if (!v.active) return 0;
    if (!L || !L.r.on) {
      v.active = v.gate = v.stage = 0;
      return 0;
    }
    return mulShr(Math.trunc((32767 * 127) / (v.vel ? v.vel : 1)), dr8Level(v.vel, p[5]), 15) | 0;
  }

  private laneOf(v: Voice, idx: number): Lane8 | null {
    if (this.kit >= DK_909 || v.s2 >= DK_909) return null;
    const L = this.lanes[v.s0 & (DV_NLANE - 1)];
    return L.owner === idx + 1 ? L : null;
  }

  /** one block of the part (CTL samples) added into out, as track_render plays it */
  block(out: Int32Array): void {
    this.dither.block();
    if (this.is909) this.nz9 = this.d9.noiseBlock(CTL);
    if (!this.v.some((x) => x.active)) return;
    for (let i = 0; i < NVOICE; i++) {
      const v = this.v[i];
      if (!v.active) continue;
      const env = this.amp(v, i);
      const amp1 = mulq15(env, v.vel * 258);
      const amp0 = v.envOut;
      v.envOut = amp1;
      this.render(v, i, out, amp0, amp1);
    }
  }

  private render(v: Voice, idx: number, out: Int32Array, amp0: number, amp1: number): void {
    const p = this.p;
    const n = CTL;
    if (this.isLane) {
      if (v.s2 === p[0]) this.dlk.render(out, n, amp0, amp1, p, this.ln, this.dither.t);
      return;
    }
    const L = this.laneOf(v, idx);
    const y = this.y;
    if (!L && !this.is909) return;
    if (this.is909) {
      const f = this.f;
      f.fill(0);
      this.d9.renderVoice(v.s1, this.nz9, f, n);
      for (let i = 0; i < n; i++) y[i] = Math.fround(fmClampf(f[i], -2, 2) * 12000) | 0;
    } else {
      const q = this.values808(L!.sound);
      dr8Run(L!.r, q, y, n, this.sc);
    }
    if (v.s5) {
      const left = v.s3 >>> 0;
      for (let i = 0; i < n; i++) y[i] = i >= left ? 0 : left - i < 64 ? Math.trunc(Math.imul(y[i], left - i) / 64) : y[i];
      v.s3 = left > n ? left - n : 0;
    }
    const drv = p[7];
    let g = 0, mk = 0;
    if (drv > 0) {
      g = 4096 + Math.trunc((drv * 3 * 4096) / 127);
      mk = Math.floor((19661 * 32768) / softclip((19661 * g) >> 12)) | 0;
    }
    const sound = this.is909 ? v.s1 : L!.sound;
    const c = this.pc(sound);
    if (!this.is909 && sound !== D9_SD && c[2]) {
      const value = c[2];
      const k = drLp1(drExp(4000, value, 24));
      const r = L!.r;
      for (let i = 0; i < n; i++) {
        r.color = (r.color + (mulShr(y[i] - r.color, k, 14) | 0)) | 0;
        y[i] = value < 0 ? r.color : (y[i] + (Math.imul(y[i] - r.color, value) >> 6)) | 0;
      }
    }
    const lv = Math.trunc(Math.imul(clamp(this.ln[v.s0 & (DV_NLANE - 1)], 0, 127), 127 - c[3]) / 127);
    if (lv !== 127) {
      const lg = Math.trunc(Math.imul(Math.imul(lv, lv), 32767) / (127 * 127));
      amp0 = mulq15(amp0, lg);
      amp1 = mulq15(amp1, lg);
    }
    for (let i = 0; i < n; i++) {
      let s = y[i];
      if (g) s = Math.imul(softclip(Math.imul(s, g) >> 12), mk) >> 15;
      s = voiceAmpD(softKneeI((s + (s >> 2)) | 0, 24000), amp0, amp1, i, this.dither.t);
      out[i] += s << 1;
    }
  }
}
