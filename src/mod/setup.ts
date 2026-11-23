// A track's modulation settings: the LFO, its fixed routings and the matrix (Felucca's LFO / LFO DEST / ENV DEST pages and MOD).
import { MD_N, MS_N } from "./mod";

export interface ModSlot { src: number; dst: number; amt: number }

export interface ModSetup {
  rate: number; // 0..127, LFO RATE
  wave: number; // 0..4 SIN TRI SAW SQR S&H
  phase: number; // 0..127, the start phase at a note
  fade: number; // 0..127, fade-in time
  sync: number; // 0 OFF, 1..10 a note value of the tempo
  trig: number; // 0 NOTE (restarts), 1 FREE
  pol: number; // 0 BI, 1 UNI
  ldPit: number; ldFlt: number; ldShp: number; // -64..63, LFO DEST
  ldAmp: number; // 0..127
  edPit: number; edShp: number; // -64..63, ENV DEST (ENV to filter is the instrument's)
  slots: ModSlot[]; // 4
  atDst: number; atAmt: number; // the aftertouch slot
}

export const defaultMod = (): ModSetup => ({
  rate: 60, wave: 0, phase: 0, fade: 0, sync: 0, trig: 0, pol: 0, ldPit: 0, ldFlt: 0, ldShp: 0, ldAmp: 0, edPit: 0, edShp: 0,
  slots: Array.from({ length: 4 }, () => ({ src: 0, dst: 0, amt: 0 })), atDst: 0, atAmt: 0,
});

export function cloneMod(m: ModSetup): ModSetup {
  return { ...m, slots: m.slots.map((s) => ({ ...s })) };
}

/** Clamps a modulation setup from storage or a file; undefined when it holds nothing but defaults. */
export function sanitizeMod(raw: unknown): ModSetup | undefined {
  const r = raw as Partial<ModSetup> | null | undefined;
  if (!r || typeof r !== "object") return undefined;
  const d = defaultMod();
  const c = (x: unknown, lo: number, hi: number, def: number): number => (typeof x === "number" && isFinite(x) ? Math.round(Math.min(hi, Math.max(lo, x))) : def);
  const m: ModSetup = {
    rate: c(r.rate, 0, 127, d.rate), wave: c(r.wave, 0, 4, 0), phase: c(r.phase, 0, 127, 0), fade: c(r.fade, 0, 127, 0),
    sync: c(r.sync, 0, 10, 0), trig: c(r.trig, 0, 1, 0), pol: c(r.pol, 0, 1, 0),
    ldPit: c(r.ldPit, -64, 63, 0), ldFlt: c(r.ldFlt, -64, 63, 0), ldShp: c(r.ldShp, -64, 63, 0), ldAmp: c(r.ldAmp, 0, 127, 0),
    edPit: c(r.edPit, -64, 63, 0), edShp: c(r.edShp, -64, 63, 0),
    slots: d.slots.map((_, i) => {
      const s = Array.isArray(r.slots) ? r.slots[i] : undefined;
      return { src: c(s?.src, 0, MS_N - 1, 0), dst: c(s?.dst, 0, MD_N - 1, 0), amt: c(s?.amt, -64, 63, 0) };
    }),
    atDst: c(r.atDst, 0, MD_N - 1, 0), atAmt: c(r.atAmt, -64, 63, 0),
  };
  return JSON.stringify(m) === JSON.stringify(d) ? undefined : m;
}
