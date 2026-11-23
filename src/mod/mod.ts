// The modulation matrix and the track LFO, a port of Felucca's mod.c and the LFO of voice.c (GPL-3.0-only). See NOTICE.
// Four slots (SRC -> DST by AMT, -64..63) plus the aftertouch slot, added to the fixed LFO / ENV routings.
import { clamp, mulq15, oscSine, oscTri, pitchInc } from "../engines/dsp";
import { ENV_LIN } from "../engines/felucca-tables";
import {
  EngVoice, FS, P_ATAMT, P_ATDST, P_CHOR, P_DIST, P_DLY, P_E0, P_LD_PIT, P_LFADE, P_LPHASE, P_LPOL, P_LRATE, P_LSYNC,
  P_LTRIG, P_LWAVE, P_M1SRC, P_PAN, P_REV, Track, Vmod,
} from "../engines/types";
import { LFO_INC } from "../fx/tables";

export const MS_OFF = 0, MS_LFO = 1, MS_ENV = 2, MS_VEL = 3, MS_KEY = 4, MS_RAND = 5, MS_MODW = 6, MS_AT = 7, MS_EXPR = 8,
  MS_SH = 9, MS_SLEW = 10, MS_N = 11;
export const MD_OFF = 0, MD_PITCH = 1, MD_CUT = 2, MD_SHP = 3, MD_AMP = 4, MD_PAN = 5, MD_DIST = 6, MD_CHO = 7, MD_DLY = 8,
  MD_REV = 9, MD_RATE = 10, MD_VIB = 11, MD_E1 = 12, MD_DEPTH = 20, MD_VEL = 21, MD_TIME = 22, MD_N = 23;

export const N_MSRC = ["OFF", "LFO", "ENV", "VEL", "KEY", "RAND", "MODW", "AT", "EXPR", "S&H", "SLEW"];
export const N_MDST = ["OFF", "PITCH", "CUT", "SHP", "AMP", "PAN", "DIST", "CHO", "DLY", "REV", "RATE", "VIB", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "DEPTH", "VEL", "TIME"];
export const N_LWAVE = ["SIN", "TRI", "SAW", "SQR", "S&H"];
export const N_LSYNC = ["OFF", "4BAR", "2BAR", "1/1", "1/2", "1/4", "1/8", "8T", "1/16", "16T", "1/32"];
const LSYNC_DIV = [0, 9, 8, 7, 6, 0, 1, 4, 2, 5, 3];
const DIV_DEN = [1, 2, 4, 8, 3, 6];

const NMSLOT = 4;
const NMSLOT_ALL = 5;
const isVoiceSrc = (s: number): boolean => s >= MS_ENV && s <= MS_RAND;
const isBipolar = (s: number): boolean => s === MS_LFO || s === MS_KEY || s === MS_RAND || s >= MS_SH;
const isEngineDst = (d: number): boolean => d >= MD_E1 && d < MD_E1 + 8;

/** Range of the track parameters the matrix can move besides the engine's E1..E8. */
function range(t: Track, id: number): [number, number] {
  if (id >= P_E0 && id < P_E0 + 8) {
    const d = t.edit[id - P_E0];
    return d ? [d.min, d.max] : [0, 127];
  }
  if (id === P_PAN || id === P_LD_PIT) return [-64, 63];
  return [0, 127];
}

function modParam(d: number): number {
  if (isEngineDst(d)) return P_E0 + d - MD_E1;
  switch (d) {
    case MD_PAN: return P_PAN;
    case MD_DIST: return P_DIST;
    case MD_CHO: return P_CHOR;
    case MD_DLY: return P_DLY;
    case MD_REV: return P_REV;
    case MD_RATE: return P_LRATE;
    default: return P_LD_PIT; // MD_VIB
  }
}

/** The modulation state of a part while its block renders (mod.c modw_t). */
export class ModW {
  on = 0; amp = 0; nv = 0; nk = 0;
  pit = 0; cut = 0; shp = 0; gain = 0; ldep = 0;
  vsrc = new Uint8Array(NMSLOT_ALL);
  vdst = new Uint8Array(NMSLOT_ALL);
  vamt = new Int8Array(NMSLOT_ALL);
  kid = new Uint8Array(NMSLOT_ALL);
  keep = new Int16Array(NMSLOT_ALL);
  off = new Int32Array(NMSLOT_ALL);
}

let modSeed = 0x2545f491;
/** RAND of a note-on: xorshift32, bipolar (its own generator). */
function modRand(): number {
  modSeed ^= modSeed << 13;
  modSeed ^= modSeed >>> 17;
  modSeed ^= modSeed << 5;
  return (modSeed >>> 16) << 16 >> 16;
}
export function resetModRand(): void { modSeed = 0x2545f491; }

export const modKey = (note: number): number => clamp((note - 60) * 512, -32767, 32767);

/** S&H: the value of the LFO's cycle (0 before its first one ends). */
export function modSh(t: Track): number {
  return t.lfoRnd ? (t.lfoRnd >>> 16) - 32768 : 0;
}

function modTsrc(t: Track, s: number, lfo: number): number {
  switch (s) {
    case MS_SH: return modSh(t);
    case MS_SLEW: return t.lfoPrev + (Math.imul(modSh(t) - t.lfoPrev, t.lfoPh >>> 17) >> 15);
    case MS_LFO: return lfo;
    case MS_ENV: return t.mEnv;
    case MS_VEL: return t.mVel * 258;
    case MS_KEY: return modKey(t.mKey);
    case MS_RAND: return t.mRnd;
    case MS_MODW: return t.mw * 258;
    case MS_AT: return t.at * 258;
    default: return (127 - t.exOff) * 258;
  }
}

/** AMP: the gain (Q15) of source x (bipolar: as 0..1) at amount a. */
function modGain(s: number, x: number, a: number): number {
  const u = isBipolar(s) ? (x + 32768) >> 1 : x;
  return clamp(32767 - (a > 0 ? Math.imul(32767 - u, a) >> 6 : Math.imul(u, -a) >> 6), 0, 32767);
}

/** DEPTH: the track LFO's gain (Q15) from the DEPTH slots. */
function modDepth(t: Track, lfo: number): number {
  const p = t.p;
  let g = 32767;
  for (let k = 0; k < NMSLOT; k++) {
    const s = p[P_M1SRC + 3 * k];
    if (p[P_M1SRC + 3 * k + 1] === MD_DEPTH && p[P_M1SRC + 3 * k + 2] && s && s < MS_N) {
      g = mulq15(g, modGain(s === MS_LFO && p[P_LPOL] ? MS_ENV : s, modTsrc(t, s, lfo), p[P_M1SRC + 3 * k + 2]));
    }
  }
  if (p[P_ATDST] === MD_DEPTH && p[P_ATAMT]) g = mulq15(g, modGain(MS_AT, modTsrc(t, MS_AT, lfo), p[P_ATAMT]));
  return g;
}

const slotSrc = (p: Int16Array, k: number): number => (k < NMSLOT ? p[P_M1SRC + 3 * k] : MS_AT);
const slotDst = (p: Int16Array, k: number): number => (k < NMSLOT ? p[P_M1SRC + 3 * k + 1] : p[P_ATDST]);
const slotAmt = (p: Int16Array, k: number): number => (k < NMSLOT ? p[P_M1SRC + 3 * k + 2] : p[P_ATAMT]);
const slotCount = (p: Int16Array): number => NMSLOT + (p[P_ATDST] && p[P_ATAMT] ? 1 : 0);

/** The matrix of one track: its modulated state (mw) and the functions mod_begin / mod_voice / mod_end. */
export class Modulator {
  readonly w = new ModW();

  constructor(readonly t: Track) {}

  private readonly acc = { pit: 0, cut: 0, shp: 0, gain: 32767 };

  private voiceAdd(w: { pit: number; cut: number; shp: number; gain: number }, s: number, d: number, x: number, a: number): void {
    if (d === MD_PITCH) w.pit += Math.imul(Math.imul(x, a), 3) >> 15;
    else if (d === MD_CUT) w.cut += Math.imul(x, a) >> 7;
    else if (d === MD_SHP) w.shp += Math.imul(x, a) >> 7;
    else w.gain = mulq15(w.gain, modGain(s, x, a));
  }

  private slot(lfo: number, s: number, d: number, a: number): void {
    const t = this.t, w = this.w, p = t.p;
    if (!s || !d || !a || s >= MS_N || d >= MD_DEPTH) return;
    if (d <= MD_AMP) {
      w.amp |= d === MD_AMP ? 1 : 0;
      if (isVoiceSrc(s)) {
        w.vsrc[w.nv] = s;
        w.vdst[w.nv] = d;
        w.vamt[w.nv++] = a;
      } else {
        this.voiceAdd(w, s === MS_LFO && p[P_LPOL] ? MS_ENV : s, d, modTsrc(t, s, lfo), a);
      }
      return;
    }
    const id = modParam(d);
    const [mn, mx] = range(t, id);
    const x = modTsrc(t, s, lfo);
    let j = 0;
    while (j < w.nk && w.kid[j] !== id) j++;
    if (j === w.nk) {
      w.kid[j] = id;
      w.keep[j] = p[id];
      w.off[j] = 0;
      w.nk++;
    }
    w.off[j] += Math.imul((Math.imul(x, a)) >> 6, mx - mn) >> 15;
  }

  /** Before a part's block: the per-track offsets, the per-block destinations into t.p. False: nothing active. */
  begin(): boolean {
    const t = this.t, p = t.p, w = this.w;
    const at = !!(p[P_ATDST] && p[P_ATAMT] && p[P_ATDST] < MD_VEL);
    w.on = 0;
    let k = 0;
    for (; k < NMSLOT; k++) {
      if (p[P_M1SRC + 3 * k] && p[P_M1SRC + 3 * k + 1] && p[P_M1SRC + 3 * k + 2] && p[P_M1SRC + 3 * k + 1] < MD_VEL) break;
    }
    if (k === NMSLOT && !at) return false;
    let lfo = mulq15(t.lfoVal, t.lfoFade);
    w.on = 1;
    w.amp = 0;
    w.nv = w.nk = 0;
    w.pit = w.cut = w.shp = 0;
    w.gain = 32767;
    w.ldep = modDepth(t, lfo);
    if (w.ldep < 32767) lfo = mulq15(lfo, w.ldep);
    for (; k < NMSLOT; k++) this.slot(lfo, p[P_M1SRC + 3 * k], p[P_M1SRC + 3 * k + 1], p[P_M1SRC + 3 * k + 2]);
    if (at) this.slot(lfo, MS_AT, p[P_ATDST], p[P_ATAMT]);
    for (let j = 0; j < w.nk; j++) {
      const id = w.kid[j];
      const [mn, mx] = range(t, id);
      p[id] = clamp(w.keep[j] + w.off[j], mn, mx);
    }
    return true;
  }

  /** After the part's block: the stored values back. */
  end(): void {
    const w = this.w, p = this.t.p;
    for (let j = 0; j < w.nk; j++) p[w.kid[j]] = w.keep[j];
    w.on = 0;
  }

  /** A voice's modulation, onto its Vmod as the host made it. */
  voice(v: EngVoice, m: Vmod, fine: number): void {
    const t = this.t, w = this.w, acc = this.acc;
    const env = m.envq15;
    acc.pit = w.pit; acc.cut = w.cut; acc.shp = w.shp; acc.gain = w.gain;
    if (v === t.v[t.mVi]) t.mEnv = env; // ENV of the latest note, for the per-block destinations
    for (let k = 0; k < w.nv; k++) {
      const s = w.vsrc[k];
      const x = s === MS_ENV ? env : s === MS_VEL ? v.mvel * 258 : s === MS_KEY ? modKey(v.note) : v.mrnd;
      this.voiceAdd(acc, s, w.vdst[k], x, w.vamt[k]);
    }
    const pit = acc.pit, cut = acc.cut, shp = acc.shp, gain = acc.gain;
    if (pit) {
      m.pitch16 = clamp(m.pitch16 + pit, 0, 2047);
      m.inc = pitchInc(m.pitch16);
      if (fine) m.inc = (m.inc + Math.imul(m.inc >>> 12, fine)) >>> 0;
    }
    m.cutoff = clamp(m.cutoff + cut, -150 * 256, 150 * 256);
    m.shape = clamp(m.shape + shp, -62 * 256, 190 * 256);
    if (w.amp) {
      m.amp1 = mulq15(m.amp1, gain);
      v.envOut = m.amp1;
    }
  }

  /** A slot on destination d (VEL, TIME) is active. */
  has(d: number): boolean {
    const p = this.t.p;
    for (let k = 0; k < slotCount(p); k++) {
      if (slotDst(p, k) === d && slotAmt(p, k) && slotSrc(p, k) > 0 && slotSrc(p, k) < MS_N) return true;
    }
    return false;
  }

  /** The slots on destination d (VEL, TIME) at a note of velocity vel, RAND rnd. */
  private atNote(d: number, note: number, vel: number, rnd: number): number {
    const t = this.t, p = t.p;
    let sum = 0;
    let lfo = mulq15(t.lfoVal, t.lfoFade);
    const g = modDepth(t, lfo);
    if (g < 32767) lfo = mulq15(lfo, g);
    for (let k = 0; k < slotCount(p); k++) {
      const s = slotSrc(p, k), a = slotAmt(p, k);
      if (slotDst(p, k) !== d || !a || !s || s >= MS_N) continue;
      const x = s === MS_VEL ? vel * 258 : s === MS_KEY ? modKey(note) : s === MS_RAND ? rnd : modTsrc(t, s, lfo);
      if (d === MD_VEL) {
        sum += Math.imul(Math.imul(x, a) >> 6, 127) >> 15;
      } else {
        let u = isBipolar(s) && !(s === MS_LFO && p[P_LPOL]) ? (x + 32768) >> 1 : x;
        u = clamp(u, 0, 32767);
        sum += a > 0 ? Math.imul(u, a) >> 6 : Math.imul(32767 - u, -a) >> 6;
      }
    }
    return sum;
  }

  /** A note-on: the per-voice sources of the latest note; returns the velocity it plays at. */
  note(note: number, vel: number): number {
    const t = this.t;
    const r = modRand();
    if (this.has(MD_VEL)) vel = clamp(vel + this.atNote(MD_VEL, note, vel, r), 1, 127);
    t.mVel = vel;
    t.mKey = note;
    t.mRnd = r;
    return vel;
  }

  /** TIME on a step: how late it plays, in samples (0: on time). */
  time(note: number, vel: number, period: number): number {
    const mx = Math.floor((period * 7) / 16);
    if (!this.has(MD_TIME)) return 0;
    const q = clamp(this.atNote(MD_TIME, note, vel, modRand()), 0, 32767);
    const d = Math.floor((q * Math.floor((FS * 30) / 1000)) / 32768);
    return d < mx ? d : mx;
  }

  /** A MIDI controller (status 0xD0 aftertouch, 0xB0 CC1 / CC11 / CC121). */
  midi(st: number, d1: number, d2: number): void {
    const t = this.t;
    if (st === 0xd0) t.at = d1;
    else if (st === 0xb0) {
      if (d1 === 1) t.mw = d2;
      else if (d1 === 11) t.exOff = 127 - d2;
      else if (d1 === 121) t.mw = t.at = t.exOff = 0;
    }
  }
}

// ---- the track LFO (voice.c) ----

function lfoRand(t: Track): number {
  let s = t.lfoRnd ? t.lfoRnd : 0x9e3779b9;
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return s >>> 0;
}

function lfoWave(t: Track, ph: number): number {
  switch (t.p[P_LWAVE]) {
    case 1: return oscTri(ph);
    case 2: return (ph >>> 16) - 32768;
    case 3: return ph < 0x80000000 ? 32767 : -32767;
    case 4: return (t.lfoRnd >>> 16) - 32768;
    default: return oscSine(ph);
  }
}

/** The phase advance of a synced LFO: one cycle lasts the note value of the tempo. */
function lfoSyncInc(t: Track, bpm: number): number {
  const quarter = Math.floor((FS * 60) / bpm);
  const div = LSYNC_DIV[t.p[P_LSYNC] % LSYNC_DIV.length];
  let cyc = div < 6 ? Math.floor(quarter / DIV_DEN[div]) : div < 10 ? (quarter << (div - 5)) >>> 0 : Math.floor(quarter / DIV_DEN[div % 6]);
  cyc = cyc || 1;
  const q = Math.floor(0xffffffff / cyc);
  const r = 0xffffffff % cyc;
  return (Math.imul(q, 32) + Math.floor((r * 32 + 32) / cyc)) >>> 0;
}

/** One block of the track LFO. */
export function lfoTick(t: Track, bpm = 120): void {
  const old = t.lfoPh;
  t.lfoPh = (t.lfoPh + (t.p[P_LSYNC] ? lfoSyncInc(t, bpm) : LFO_INC[t.p[P_LRATE] & 127])) >>> 0;
  if (t.lfoPh < old) {
    t.lfoPrev = modSh(t) << 16 >> 16;
    t.lfoRnd = lfoRand(t);
  }
  t.lfoVal = lfoWave(t, t.lfoPh);
  if (t.p[P_LPOL]) t.lfoVal = (t.lfoVal + 32768) >> 1;
  if (t.lfoFade < 32767) {
    const step = ENV_LIN[t.p[P_LFADE] & 127] >> 9;
    t.lfoFade = t.p[P_LFADE] ? clamp(t.lfoFade + (step || 1), 0, 32767) : 32767;
  }
}

/** Note-on of the LFO: restart the phase unless FREE, fade in again. */
export function lfoNoteOn(t: Track): void {
  if (!t.p[P_LTRIG]) t.lfoPh = (t.p[P_LPHASE] << 25) >>> 0;
  t.lfoFade = 0;
}
