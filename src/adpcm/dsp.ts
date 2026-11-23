// The DSP of the ADPCM engine (Felucca's adpcm_dsp.c, a C port of snes_spc's SPC_DSP.cpp: LGPL-2.1-or-later): a voice's BRR
// decoding, its 4-point Gaussian interpolation, ADSR / GAIN envelopes on a shared rate counter, the noise generator and the
// echo with its 8-tap FIR, bit for bit. See NOTICE.
import { ADP_GAUSS } from "./data";

export const ADP_CTR_RANGE = 30720;
export const SE_RELEASE = 0, SE_ATTACK = 1, SE_DECAY = 2, SE_SUSTAIN = 3;
export const ADP_CTR_RATE = [ADP_CTR_RANGE + 1, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1];
const ADP_CTR_OFS = [1,0,1040,536,0,1040,536,0,1040,536,0,1040,536,0,1040,536,0,1040,536,0,1040,536,0,1040,536,0,1040,536,0,1040,0,0];

/** One voice (SPC_DSP::voice_t and its registers). */
export class AdpChv {
  buf = new Int16Array(24);
  ram: Uint8Array = new Uint8Array(0);
  start = 0;
  brrAddr = 0;
  interpPos = 0;
  env = 0;
  hiddenEnv = 0;
  bufPos = 0; brrOffset = 0; konDelay = 0; envMode = 0;
  adsr0 = 0; adsr1 = 0; gain = 0;
}

/** The echo (SPC_DSP echo_22 .. echo_30, one channel). */
export class AdpEcho {
  hist = new Int16Array(16);
  hpos = 0;
  off = 0; len = 0;
  in = 0; wr = 0;
}

/** 0: the rate fires on this sample. */
export const adpCtr = (counter: number, rate: number): number => ((counter + ADP_CTR_OFS[rate]) >>> 0) % ADP_CTR_RATE[rate];

export const adpClamp16 = (x: number): number => (((x << 16) >> 16) !== x ? (x >> 31) ^ 0x7fff : x);

/** SPC_DSP misc_30: the noise, when its rate fires. */
export function adpNoiseStep(noise: number): number {
  const fb = (noise << 13) ^ (noise << 14);
  return (fb & 0x4000) ^ (noise >> 1);
}

function interp(v: AdpChv): number {
  const off = (v.interpPos >>> 4) & 0xff;
  const f = 255 - off, r = off;
  const b = (v.interpPos >> 12) + v.bufPos;
  const buf = v.buf;
  let o = (ADP_GAUSS[f] * buf[b]) >> 11;
  o += (ADP_GAUSS[f + 256] * buf[b + 1]) >> 11;
  o += (ADP_GAUSS[r + 256] * buf[b + 2]) >> 11;
  o = (o << 16) >> 16;
  o += (ADP_GAUSS[r] * buf[b + 3]) >> 11;
  return adpClamp16(o) & ~1;
}

/** SPC_DSP::run_envelope */
function envelope(v: AdpChv, fire: number): void {
  let env = v.env, rate: number, data = v.adsr1;
  if (v.envMode === SE_RELEASE) {
    env -= 0x8;
    v.env = env < 0 ? 0 : env;
    return;
  }
  if (v.adsr0 & 0x80) {
    if (v.envMode >= SE_DECAY) {
      env--;
      env -= env >> 8;
      rate = data & 0x1f;
      if (v.envMode === SE_DECAY) rate = ((v.adsr0 >> 3) & 0x0e) + 0x10;
    } else {
      rate = (v.adsr0 & 0x0f) * 2 + 1;
      env += rate < 31 ? 0x20 : 0x400;
    }
  } else {
    data = v.gain;
    const mode = data >> 5;
    if (mode < 4) {
      env = data * 0x10;
      rate = 31;
    } else {
      rate = data & 0x1f;
      if (mode === 4) env -= 0x20;
      else if (mode < 6) {
        env--;
        env -= env >> 8;
      } else {
        env += 0x20;
        if (mode > 6 && (v.hiddenEnv >>> 0) >= 0x600) env += 0x8 - 0x20;
      }
    }
  }
  if (env >> 8 === data >> 5 && v.envMode === SE_DECAY) v.envMode = SE_SUSTAIN;
  v.hiddenEnv = (env << 16) >> 16;
  if (env >>> 0 > 0x7ff) {
    env = env < 0 ? 0 : 0x7ff;
    if (v.envMode === SE_ATTACK) v.envMode = SE_DECAY;
  }
  if ((fire >>> rate) & 1) v.env = (env << 16) >> 16;
}

/** SPC_DSP::decode_brr */
function decode(v: AdpChv, header: number, byte: number): void {
  let nyb = byte * 0x100 + v.ram[v.brrAddr + v.brrOffset + 1];
  const shift = header >> 4, filter = header & 0x0c;
  const buf = v.buf;
  let pos = v.bufPos;
  const end = pos + 4;
  v.bufPos = v.bufPos + 4 >= 12 ? 0 : v.bufPos + 4;
  for (; pos < end; pos++, nyb <<= 4) {
    let s = (((nyb << 16) >> 16) >> 12);
    const p1 = buf[pos + 11], p2 = buf[pos + 10] >> 1;
    s = (s * (1 << shift)) >> 1;
    if (shift >= 0xd) s = s < 0 ? -0x800 : 0;
    if (filter >= 8) {
      s += p1;
      s -= p2;
      if (filter === 8) {
        s += p2 >> 4;
        s += (p1 * -3) >> 6;
      } else {
        s += (p1 * -13) >> 7;
        s += (p2 * 3) >> 4;
      }
    } else if (filter) {
      s += p1 >> 1;
      s += -p1 >> 5;
    }
    s = (adpClamp16(s) * 2) << 16 >> 16;
    buf[pos + 12] = s;
    buf[pos] = s;
  }
}

/**
 * One sample of a voice (SPC_DSP voice_V2 .. V4): its output before the volume. fire: the rates that fire; noise: the noise
 * register; pitch: the 14-bit register; non: noise instead of the sample; koff: a key-off now.
 */
export function adpTick(v: AdpChv, fire: number, noise: number, pitch: number, non: boolean, koff: boolean): number {
  const next = v.start;
  let header = v.ram[v.brrAddr];
  const byte = v.ram[v.brrAddr + v.brrOffset];
  if (v.konDelay) {
    if (v.konDelay === 5) {
      v.brrAddr = next;
      v.brrOffset = 1;
      v.bufPos = 0;
      header = 0;
    }
    v.env = v.hiddenEnv = 0;
    v.konDelay--;
    v.interpPos = v.konDelay & 3 ? 0x4000 : 0;
    pitch = 0;
  }
  let out = non ? (noise * 2 << 16) >> 16 : interp(v);
  out = ((out * v.env) >> 11) & ~1;
  if ((header & 3) === 1) {
    v.envMode = SE_RELEASE;
    v.env = 0;
  }
  if (koff) v.envMode = SE_RELEASE;
  if (!v.konDelay) envelope(v, fire);
  if (v.interpPos >= 0x4000) {
    decode(v, header, byte);
    v.brrOffset += 2;
    if (v.brrOffset >= 9) {
      v.brrAddr = header & 1 ? next : v.brrAddr + 9;
      v.brrOffset = 1;
    }
  }
  v.interpPos = (v.interpPos & 0x3fff) + pitch;
  if (v.interpPos > 0x7fff) v.interpPos = 0x7fff;
  return out;
}

/**
 * One sample of the echo (SPC_DSP echo_22 .. echo_30, one channel): read the line into the FIR, feed the voices' sum (ein) plus the
 * FIR's output at EFB back into the same place, step on. Returns the FIR's output at EVOL. edl: 0..15 (taken at position 0).
 */
export function adpEchoTick(e: AdpEcho, buf: Int16Array, ein: number, evol: number, efb: number, fir: ArrayLike<number>, edl: number, wr: boolean): number {
  let off = e.off;
  e.hpos = (e.hpos + 1) & 7;
  const h = e.hpos;
  const hist = e.hist;
  hist[h] = hist[h + 8] = buf[off] >> 1;
  const f = (i: number): number => (hist[h + i + 1] * fir[i]) >> 6;
  let l = f(0) + f(1) + f(2) + f(3) + f(4) + f(5) + f(6);
  l = (l << 16) >> 16;
  l += (f(7) << 16) >> 16;
  l = adpClamp16(l) & ~1;
  const w = adpClamp16(ein + (((l * efb) >> 7) << 16 >> 16)) & ~1;
  if (!off) e.len = edl * 512;
  if (++off >= e.len) off = 0;
  if (wr) buf[e.off] = w;
  e.off = off;
  e.in = l;
  e.wr = wr ? w : 0;
  return ((l * evol) >> 7) << 16 >> 16;
}
