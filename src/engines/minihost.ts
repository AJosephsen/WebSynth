// Port of Felucca-Engines' tests/fe_host.c (MIT): a minimal voice host used to check the engines
// against the reference renders. See NOTICE.
import { clamp, pitchInc } from "./dsp";
import { CTL, EngineDef, EngVoice, NVOICE, P_ATK, P_E0, P_FTYPE, P_REL, Track, Vmod } from "./types";
import { Preset } from "./presets";

let vage = 0;

function voiceOn(t: Track, e: EngineDef, v: EngVoice, note: number, fine: number): void {
  const sounding = v.active && v.stage !== 0;
  const ph = Uint32Array.from(v.ph);
  const s = Int32Array.from(v.s);
  v.note = note;
  v.vel = 100;
  v.gate = 1;
  v.active = 1;
  v.stage = 1;
  v.age = ++vage;
  v.pitch16 = v.pitchCur = note * 16;
  v.fine = fine;
  if (!sounding) v.env = v.envOut = 0;
  e.noteOn(t, v);
  if (sounding) {
    v.ph.set(ph);
    for (let k = 0; k < 8; k++) if (k !== 2 && k !== 3 && (e.keep >> k) & 1) v.s[k] = s[k];
  }
}

/** A plain envelope once per block: attack in 4 blocks, sustain 3/4, release by 1/16 a block. */
function envTick(v: EngVoice): number {
  if (!v.active) return 0;
  switch (v.stage) {
    case 1:
      v.env += 1 << 22;
      if (v.env >= 1 << 24) { v.env = 1 << 24; v.stage = 2; }
      break;
    case 2:
      v.env -= (v.env - (3 << 22)) >> 3;
      break;
    case 3:
      v.env -= v.env >> 4;
      if (v.env < Math.trunc((1 << 24) / 1000)) { v.env = 0; v.stage = 0; v.active = 0; }
      break;
  }
  return v.env >> 9;
}

const NBLK = 240;

export interface RenderResult { hash: bigint; peak: number }

/** The reference phrase: renders a preset and returns an FNV-1a 64 hash of the output and its peak. */
export function renderPhrase(e: EngineDef, pr: Pick<Preset, "e" | "env">, ftype: number, reset = true): RenderResult {
  const t = new Track();
  const out = new Int32Array(CTL);
  const last = new Int32Array(NVOICE);
  let h = 14695981039346656037n;
  let peak = 0;
  if (reset) e.reset?.();
  vage = 0;
  for (let k = 0; k < 8; k++) t.p[P_E0 + k] = pr.e[k];
  t.p[P_ATK] = pr.env[0];
  t.p[P_REL] = pr.env[3];
  t.p[P_FTYPE] = ftype;
  const M = 0xffffffffffffffffn;
  for (let b = 0; b < NBLK; b++) {
    if (b === 0) voiceOn(t, e, t.v[0], 43, 0);
    if (b === 30) voiceOn(t, e, t.v[1], 62, 23);
    if (b === 70) voiceOn(t, e, t.v[0], 50, 0);
    if (b === 100) voiceOn(t, e, t.v[2], 79, -17);
    if (b === 150) for (const v of t.v) if (v.active) { v.gate = 0; v.stage = 3; }
    e.block?.(t);
    out.fill(0);
    for (let k = 0; k < NVOICE; k++) {
      const v = t.v[k];
      if (!v.active) continue;
      let a = envTick(v);
      if (e.amp) a = e.amp(t, v, a);
      if (!v.active) continue;
      const base = pitchInc(clamp(v.pitch16, 0, 2047));
      const m: Vmod = {
        pitch16: v.pitch16,
        inc: (base + Math.imul(base >>> 12, v.fine)) >>> 0,
        fine: v.fine,
        amp0: last[k],
        amp1: a,
        envq15: a,
        cutoff: ((b % 96) - 48) * 128,
        shape: (64 << 8) + ((b % 64) - 32) * 256,
      };
      last[k] = a;
      e.render(t, v, out, CTL, m);
    }
    for (let i = 0; i < CTL; i++) {
      const x = out[i] >>> 0;
      const a = out[i] < 0 ? -out[i] : out[i];
      for (let k = 0; k < 4; k++) {
        h ^= BigInt((x >>> (8 * k)) & 0xff);
        h = (h * 1099511628211n) & M;
      }
      if (a > peak) peak = a;
    }
  }
  return { hash: h, peak };
}
