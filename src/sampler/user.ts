// Building a user sample slot from WAV files: the web editor's pipeline of Felucca (tools/sampleio.py, GPL-3.0-only): read any
// PCM / float WAV, mix to mono, resample to 22.05 kHz, normalise to a peak of 30000, encode as IMA ADPCM and split the keyboard
// between the files' root notes. See NOTICE.
import { IMA_IDX, IMA_STEP, UserSlot, Zone } from "./base";

export const SLOT_RATE = 22050;
export const SLOT_ZONES = 16;
export const SLOT_MAX_DATA = 0x14000 - 512;

interface Chunks { [id: string]: { o: number; n: number } }

function wavChunks(d: DataView): Chunks {
  const tag = (o: number): string => String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));
  if (d.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  const out: Chunks = {};
  let i = 12;
  while (i + 8 <= d.byteLength) {
    const id = tag(i), n = d.getUint32(i + 4, true);
    if (!(id in out)) out[id] = { o: i + 8, n };
    i += 8 + n + (n & 1);
  }
  return out;
}

/** PCM 8 / 16 / 24 / 32 bit or float, any channel count, mixed to mono: [rate, samples in -1..1]. A truncated data chunk is fine. */
export function readAnyWav(buf: ArrayBuffer): [number, number[]] {
  const d = new DataView(buf);
  const ch = wavChunks(d);
  if (!ch["fmt "]) throw new Error("WAV without a fmt chunk");
  const o = ch["fmt "].o;
  let tag = d.getUint16(o, true);
  const nch = d.getUint16(o + 2, true), sr = d.getUint32(o + 4, true), bits = d.getUint16(o + 14, true);
  if (tag === 0xfffe) tag = d.getUint16(o + 24, true);
  const bps = bits >> 3;
  if ((tag !== 1 && tag !== 3) || !bps || !nch) throw new Error(`unsupported WAV format (tag ${tag}, ${bits} bit)`);
  const data = ch["data"] ?? { o: 0, n: 0 };
  const frame = bps * nch;
  const nfr = Math.floor(Math.min(data.n, d.byteLength - data.o) / frame);
  const val = (p: number): number => {
    if (tag === 3) return bps === 4 ? d.getFloat32(p, true) : d.getFloat64(p, true);
    if (bps === 2) return d.getInt16(p, true) / 32768;
    if (bps === 3) return ((d.getUint8(p) << 8 | d.getUint8(p + 1) << 16 | d.getUint8(p + 2) << 24) | 0) / 2147483648;
    if (bps === 4) return d.getInt32(p, true) / 2147483648;
    return (d.getUint8(p) - 128) / 128;
  };
  const out: number[] = new Array(nfr);
  for (let f = 0; f < nfr; f++) {
    const p = data.o + f * frame;
    if (nch === 1) out[f] = val(p);
    else if (nch === 2) out[f] = (val(p) + val(p + bps)) / 2;
    else {
      let acc = 0;
      for (let c = 0; c < nch; c++) acc += val(p + c * bps);
      out[f] = acc / nch;
    }
  }
  return [sr, out];
}

/** Crude anti-alias (a moving average over the ratio), then linear interpolation. */
export function resample(x: number[], sr: number, to: number): number[] {
  if (sr === to) return x;
  if (sr > to) {
    const k = Math.max(1, Math.round(sr / to));
    if (k === 2) {
      const y: number[] = [];
      for (let i = 0; i + 1 < x.length; i++) y.push((x[i] + x[i + 1]) / 2);
      x = x.length ? [...y, x[x.length - 1] / 2] : [];
    } else if (k > 1) {
      const y: number[] = new Array(x.length);
      for (let i = 0; i < x.length; i++) {
        let acc = 0;
        for (let j = i; j < Math.min(x.length, i + k); j++) acc += x[j];
        y[i] = acc / k;
      }
      x = y;
    }
  }
  const step = sr / to, last = x.length - 1, out: number[] = [];
  let p = 0;
  while (p < last) {
    const i = Math.trunc(p), f = p - i;
    out.push(x[i] * (1 - f) + x[i + 1] * f);
    p += step;
  }
  return out;
}

const peakOf = (x: number[], floor = 1e-9): number => { let m = floor; for (const v of x) if (Math.abs(v) > m) m = Math.abs(v); return m; };

/** Mono float to int16, peak normalised to 30000. */
export function toInt16(x: number[]): number[] {
  const pk = peakOf(x);
  return x.map((v) => Math.max(-32768, Math.min(32767, Math.trunc((v / pk) * 30000))));
}

/** IMA ADPCM, 4 bit, low nibble first, from predictor 0 / index 0: [bytes, [predictor, index] at loopStart]. */
export function imaEncode(samples: number[], loopStart: number): [Uint8Array, [number, number]] {
  let pred = 0, idx = 0, atLoop: [number, number] = [0, 0];
  const nib: number[] = [];
  samples.forEach((x, n) => {
    if (n === loopStart) atLoop = [pred, idx];
    const step = IMA_STEP[idx];
    let diff = x - pred, code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    let vd = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; vd += step; }
    if (diff >= step >> 1) { code |= 2; diff -= step >> 1; vd += step >> 1; }
    if (diff >= step >> 2) { code |= 1; vd += step >> 2; }
    pred = code & 8 ? pred - vd : pred + vd;
    pred = Math.max(-32768, Math.min(32767, pred));
    idx = Math.max(0, Math.min(88, idx + IMA_IDX[code & 7]));
    nib.push(code);
  });
  if (nib.length & 1) nib.push(0);
  const out = new Uint8Array(nib.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = nib[2 * i] | (nib[2 * i + 1] << 4);
  return [out, atLoop];
}

/** Sorted root notes to key ranges: each zone reaches halfway to its neighbours, the outer ones to the ends. */
export function keySplit(roots: number[]): [number, number][] {
  const n = roots.length;
  return roots.map((r, j): [number, number] => [j === 0 ? 0 : ((roots[j - 1] + r) >> 1) + 1, j === n - 1 ? 127 : (r + roots[j + 1]) >> 1]);
}

/** "C4" / "F#3" / "Bb2" in a file name, C4 = 60 (as the web editor), clamped to 0..127. */
export function noteFromName(name: string, def = 60): number {
  const m = /(?<![A-Za-z])([A-G])([#b]?)(-?\d)(?!\d)/.exec(name);
  if (!m) return def;
  const pc = "C D EF G A B".indexOf(m[1]) + ({ "#": 1, b: -1, "": 0 } as Record<string, number>)[m[2]];
  return Math.max(0, Math.min(127, (Number(m[3]) + 1) * 12 + pc));
}

export interface SampleFile { name: string; samples: number[]; /** at SLOT_RATE */ root: number; lo?: number; hi?: number }

/** WAV bytes to a sample file: mono, 22.05 kHz, normalised; the root note comes from the file name. */
export function sampleFromWav(name: string, buf: ArrayBuffer): SampleFile {
  const [sr, x] = readAnyWav(buf);
  return { name, samples: toInt16(resample(x, sr, SLOT_RATE)), root: noteFromName(name) };
}

/** Builds a user slot from up to 16 files (the keyboard is split between their roots unless lo / hi are given). */
export function buildUserSlot(files: SampleFile[]): UserSlot {
  const zs: { off: number; n: number; root: number; lo?: number; hi?: number; pred: number; idx: number }[] = [];
  const chunks: Uint8Array[] = [];
  let len = 0;
  for (const f of files) {
    const [adp, st] = imaEncode(f.samples, 0);
    zs.push({ off: len, n: f.samples.length, root: f.root, lo: f.lo, hi: f.hi, pred: st[0], idx: st[1] });
    chunks.push(adp);
    len += adp.length;
  }
  if (len > SLOT_MAX_DATA) throw new Error(`too long: ${len} bytes of ADPCM, a slot holds ${SLOT_MAX_DATA} (${((SLOT_MAX_DATA * 2) / SLOT_RATE).toFixed(1)} s in all)`);
  if (zs.length < 1 || zs.length > SLOT_ZONES) throw new Error(`1..${SLOT_ZONES} files per slot`);
  zs.sort((a, b) => a.root - b.root);
  keySplit(zs.map((z) => z.root)).forEach(([lo, hi], i) => { if (zs[i].lo === undefined) { zs[i].lo = lo; zs[i].hi = hi; } });
  const rate = Math.round((SLOT_RATE / 44100) * 65536);
  const data = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { data.set(c, o); o += c.length; }
  const zones: Zone[] = zs.map((z) => ({ off: z.off, n: z.n, ls: 0, le: z.n - 1, rate, root16: z.root * 16, pred: z.pred, idx: z.idx, lo: z.lo!, hi: z.hi!, looped: 0 }));
  return { zones, data };
}
