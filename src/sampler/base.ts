// Shared parts of the sample engines (Felucca's eng_sample.c, GPL-3.0-only): the sample data, zones, IMA ADPCM
// decoding and the missing-sample sine. See NOTICE.
import { clamp, mulq15, pitchInc, sineI, voiceAmp } from "../engines/dsp";
import { Vmod } from "../engines/types";
import { SMP_DATA_B64, SMP_SETS, SMP_ZONES } from "./data";

function b64(s: string): Uint8Array {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lut = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) lut[A.charCodeAt(i)] = i;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (lut[s.charCodeAt(i)] << 18) | (lut[s.charCodeAt(i + 1)] << 12) | ((lut[s.charCodeAt(i + 2)] & 63) << 6) | (lut[s.charCodeAt(i + 3)] & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

const SMP_BUILTIN = b64(SMP_DATA_B64);
/** User sample slots (eng_sample.c): three slots, each up to 81,408 bytes of IMA ADPCM, placed after the built-in data. */
export const SMP_USER_CAP = 0x14000 - 512;
export const SMP_USER_SLOTS = 3;
export const SMP_DATA = new Uint8Array(SMP_BUILTIN.length + SMP_USER_SLOTS * SMP_USER_CAP);
SMP_DATA.set(SMP_BUILTIN);
export const SMP_NSETS = SMP_SETS.length;
export const SMP_NALL = SMP_NSETS + SMP_USER_SLOTS;
export const SMP_ALL_NAMES = [...SMP_SETS.map((s) => s.name), "USR1", "USR2", "USR3"];

export interface Zone { off: number; n: number; ls: number; le: number; rate: number; root16: number; pred: number; idx: number; lo: number; hi: number; looped: number }
const toZone = (z: readonly number[]): Zone => ({ off: z[0], n: z[1], ls: z[2], le: z[3], rate: z[4], root16: z[5], pred: z[6], idx: z[7], lo: z[8], hi: z[9], looped: z[10] });
export const ZONES: Zone[] = SMP_ZONES.map(toZone);
export const EMPTY_ZONE: Zone = { off: 0, n: 0, ls: 0, le: 0, rate: 0, root16: 0, pred: 0, idx: 0, lo: 0, hi: 0, looped: 0 };

export const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
export const IMA_IDX = [-1, -1, -1, -1, 2, 4, 6, 8];

/** 2^(d16 / 192) in Q16 (d16 >= -3072). */
export function pow2q16(d16: number): number {
  const u = d16 + 192 * 16;
  const oct = Math.floor(u / 192);
  const r = Math.floor(pitchInc(1600 + (u % 192)) / (pitchInc(1600) >>> 16));
  return oct >= 16 ? (r << (oct - 16)) >>> 0 : r >>> (16 - oct);
}

/** The user slots' zones (their data offsets rebased onto SMP_DATA) and how many each holds (0: empty or invalid). */
export const usrZone: Zone[][] = Array.from({ length: SMP_USER_SLOTS }, () => Array.from({ length: 16 }, () => ({ ...EMPTY_ZONE })));
export const usrNz = [0, 0, 0];
/** +1 per slot scan (GRAIN's seek index follows uploads). */
export const userGen = { n: 0 };
const scanHooks: ((k: number, valid: boolean) => void)[] = [];
/** Registers a callback run when a slot changes (SLICE builds its slice table there). */
export function onUserScan(fn: (k: number, valid: boolean) => void): void { scanHooks.push(fn); }

/** A user slot's contents: zones with data offsets relative to its ADPCM data, and the data (IMA ADPCM, 4 bit). */
export interface UserSlot { zones: Zone[]; data: Uint8Array }

/** (Re)reads slot k: a valid slot makes its zones usable; an unusable one leaves every zone empty (smp_user_scan). */
export function loadUserSlot(k: number, slot: UserSlot | null): boolean {
  userGen.n++;
  usrNz[k] = 0;
  for (const h of scanHooks) h(k, false);
  let nz = 0;
  const zt: Zone[] = [];
  if (slot && slot.zones.length >= 1 && slot.zones.length <= 16 && slot.data.length <= SMP_USER_CAP) {
    const base = SMP_BUILTIN.length + k * SMP_USER_CAP;
    nz = slot.zones.length;
    for (const z0 of slot.zones) {
      const z = { ...z0 };
      if (z.off > slot.data.length || z.n > 2 * SMP_USER_CAP || z.off + ((z.n + 1) >> 1) > slot.data.length || !z.rate || z.rate > 4 << 16 || z.ls > z.le || z.le >= z.n || z.lo > z.hi) { nz = 0; break; }
      z.off += base;
      zt.push(z);
    }
    if (nz) {
      SMP_DATA.fill(0, base, base + SMP_USER_CAP);
      SMP_DATA.set(slot.data, base);
    }
  }
  for (let i = 0; i < 16; i++) usrZone[k][i] = i < nz ? zt[i] : { ...EMPTY_ZONE };
  if (!nz) return false;
  usrNz[k] = nz;
  for (const h of scanHooks) h(k, true);
  return true;
}

/** Set si has no sample data: an empty or invalid user slot, a built-in set without data. */
export const smpSetMissing = (si: number): boolean => (si < SMP_NSETS ? !ZONES[SMP_SETS[si].z0].n : !usrNz[(si - SMP_NSETS) % SMP_USER_SLOTS]);

/** A missing sample plays a plain sine at the note's pitch instead (state: phase, last output). */
export function smpSine(out: Int32Array, n: number, m: Vmod, d16: number, lp: number, st: { ph: number; y: number }): void {
  let p = st.ph;
  const inc = pitchInc(clamp(m.pitch16 + d16, 0, 2047));
  let s = st.y;
  for (let i = 0; i < n; i++, p = (p + inc) >>> 0) {
    s += mulq15((sineI(p) >> 1) - s, lp);
    out[i] += voiceAmp(s, m, i) << 1;
  }
  st.ph = p;
  st.y = s;
}
