// Patch layout and formats (fm6_core.c FP_*, eng_fm6.c fm6_unpack/fm6_sanitize). See NOTICE.
// A voice is the 155-byte DX7 single-voice layout: six 21-byte operators (the sixth first), then the voice.
export const FP = {
  R1: 0, L1: 4, BP: 8, LD: 9, RD: 10, LC: 11, RC: 12, RS: 13, AMS: 14, KVS: 15, OL: 16, MODE: 17, FC: 18, FF: 19,
  DET: 20, OP: 21,
  PR1: 126, PL1: 130, ALG: 134, FB: 135, OKS: 136, LFS: 137, LFD: 138, LPMD: 139, LAMD: 140, LKS: 141, LFW: 142,
  LPMS: 143, TRNSP: 144, NAME: 145, SIZE: 155,
} as const;

const OPMAX = [99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 3, 3, 7, 3, 7, 99, 1, 31, 99, 14];
const VMAX = [99, 99, 99, 99, 99, 99, 99, 99, 31, 7, 1, 99, 99, 99, 99, 1, 5, 7, 48];

function max(i: number): number {
  if (i < 126) return OPMAX[i % 21];
  if (i < FP.NAME) return VMAX[i - 126];
  return 126;
}

function sanitize(v: Uint8Array): void {
  for (let i = 0; i < FP.SIZE; i++) {
    if (i >= FP.NAME) v[i] = v[i] < 32 || v[i] > 126 ? 32 : v[i];
    else if (v[i] > max(i)) v[i] = max(i);
  }
}

/** 128-byte packed record (as in a 32-voice bank) -> 155-byte voice. */
export function unpack(b: ArrayLike<number>): Uint8Array {
  const v = new Uint8Array(FP.SIZE);
  for (let k = 0; k < 6; k++) {
    const o = k * 17;
    const d = k * FP.OP;
    for (let i = 0; i < 11; i++) v[d + i] = b[o + i] & 0x7f;
    v[d + FP.LC] = b[o + 11] & 3;
    v[d + FP.RC] = (b[o + 11] >> 2) & 3;
    v[d + FP.RS] = b[o + 12] & 7;
    v[d + FP.DET] = (b[o + 12] >> 3) & 15;
    v[d + FP.AMS] = b[o + 13] & 3;
    v[d + FP.KVS] = (b[o + 13] >> 2) & 7;
    v[d + FP.OL] = b[o + 14] & 0x7f;
    v[d + FP.MODE] = b[o + 15] & 1;
    v[d + FP.FC] = (b[o + 15] >> 1) & 31;
    v[d + FP.FF] = b[o + 16] & 0x7f;
  }
  for (let i = 0; i < 9; i++) v[FP.PR1 + i] = b[102 + i] & 0x7f; // pitch EG, algorithm
  v[FP.ALG] &= 31;
  v[FP.FB] = b[111] & 7;
  v[FP.OKS] = (b[111] >> 3) & 1;
  for (let i = 0; i < 4; i++) v[FP.LFS + i] = b[112 + i] & 0x7f;
  v[FP.LKS] = b[116] & 1;
  v[FP.LFW] = (b[116] >> 1) & 7;
  v[FP.LPMS] = (b[116] >> 4) & 7;
  v[FP.TRNSP] = b[117] & 0x7f;
  for (let i = 0; i < 10; i++) v[FP.NAME + i] = b[118 + i] & 0x7f;
  sanitize(v);
  return v;
}

export function patchName(v: Uint8Array): string {
  return String.fromCharCode(...v.slice(FP.NAME, FP.NAME + 10)).trimEnd();
}

/**
 * Reads DX7 SysEx: a 32-voice bank (F0 43 0n 09 20 00 ... 4096 bytes ... cs F7) or a single voice
 * (F0 43 0n 00 01 1B ... 155 bytes ... cs F7). Returns the voices as 155-byte patches.
 */
export function parseSysex(data: Uint8Array): Uint8Array[] {
  const voices: Uint8Array[] = [];
  for (let s = 0; s < data.length; s++) {
    if (data[s] !== 0xf0 || data[s + 1] !== 0x43) continue;
    const fmt = data[s + 3];
    if (fmt === 0x09 && data.length >= s + 6 + 4096) {
      for (let k = 0; k < 32; k++) voices.push(unpack(data.subarray(s + 6 + k * 128, s + 6 + (k + 1) * 128)));
      s += 6 + 4096;
    } else if (fmt === 0x00 && data.length >= s + 6 + 155) {
      const v = Uint8Array.from(data.subarray(s + 6, s + 6 + 155));
      sanitize(v);
      voices.push(v);
      s += 6 + 155;
    }
  }
  return voices;
}
