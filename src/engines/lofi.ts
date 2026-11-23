// Port of Felucca-Engines' eng_lofi.c (MIT): a chip voice with wave RAM, quantised amplitude and a stepped envelope. See NOTICE.
import { clamp, mulq15, oscSine, oscTri, pitchInc, voiceAmp } from "./dsp";
import { CTL, EngineDef, EngVoice, F, FS, P_E0, P_E1, P_E2, P_E3, P_E4, P_E5, P_E6, P_E7, P_REL, ParamDesc, Track, Vmod } from "./types";

const N_CHIP = ["4BIT", "4B/2", "8BIT", "1BIT", "STEP"];
const N_RWAVE = ["PLS", "TRI", "SAW", "NOIS", "WRAM"];
const N_RARP = ["OFF", "OCT", "MAJ", "MIN"];
const CHIP_8BIT = 2, CHIP_STEP = 4;
const RW_TRI = 1, RW_SAW = 2, RW_NOIS = 3, RW_WRAM = 4;
const N_WRAM = ["SQ50", "SQ25", "SQ12", "SINE", "TRI", "SAW", "SAW2", "BAS1", "BAS2", "ORGN", "HOLW", "VOXA", "VOXO", "VOXE", "BUZZ", "STAIR"];
/** 16 tables x 32 samples x 4 bits, two samples a byte (high nibble first). */
const WRAM: number[][] = [
  [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x89, 0xAC, 0xDE, 0xEF, 0xFF, 0xEE, 0xDC, 0xA9, 0x86, 0x53, 0x21, 0x10, 0x00, 0x11, 0x23, 0x56],
  [0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF, 0xFE, 0xDC, 0xBA, 0x98, 0x76, 0x54, 0x32, 0x10],
  [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF],
  [0x01, 0x12, 0x33, 0x45, 0x56, 0x77, 0x89, 0x9A, 0x56, 0x67, 0x88, 0x9A, 0xAB, 0xCC, 0xDE, 0xEF],
  [0xEE, 0xEF, 0xFF, 0xFF, 0xFF, 0xEE, 0xED, 0xDC, 0x11, 0x10, 0x00, 0x00, 0x00, 0x11, 0x12, 0x23],
  [0xCE, 0xFF, 0xED, 0xBA, 0x9A, 0xBD, 0xEF, 0xFE, 0xC9, 0x64, 0x21, 0x00, 0x00, 0x01, 0x24, 0x69],
  [0x8B, 0xEF, 0xED, 0xBA, 0x9A, 0xAA, 0x98, 0x77, 0x88, 0x87, 0x65, 0x55, 0x65, 0x42, 0x10, 0x14],
  [0x8D, 0xFE, 0xDD, 0xDD, 0xCD, 0xDD, 0xDE, 0xFD, 0x82, 0x01, 0x22, 0x22, 0x32, 0x22, 0x21, 0x02],
  [0x8F, 0xFC, 0xA7, 0x67, 0x89, 0x88, 0x88, 0x87, 0x88, 0x77, 0x77, 0x76, 0x78, 0x98, 0x53, 0x00],
  [0x8F, 0xEE, 0xFD, 0xDB, 0x98, 0x66, 0x66, 0x77, 0x88, 0x89, 0x99, 0x97, 0x64, 0x22, 0x01, 0x10],
  [0x7F, 0x96, 0xCF, 0xBB, 0xCC, 0xBB, 0xAA, 0x98, 0x77, 0x65, 0x54, 0x43, 0x34, 0x40, 0x39, 0x60],
  [0xF3, 0x00, 0x12, 0x22, 0x11, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22],
  [0xFF, 0xFF, 0xFF, 0xFF, 0xAA, 0xAA, 0xAA, 0xAA, 0x55, 0x55, 0x55, 0x55, 0x00, 0x00, 0x00, 0x00],
];
const Q4 = 2184; // one 4-bit step
const N_DCY = ["CONST", "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "D14", "D15", "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11", "L12", "L13", "L14", "L15"];
const WAVNUM: ParamDesc = { label: "WAV#", fmt: F.INT, min: 0, max: 127, def: 64, names: N_WRAM };
const DCY: ParamDesc = { label: "DCY", fmt: F.INT, min: 0, max: 127, def: 0, names: N_DCY };

const FRAME_Q16 = Math.floor((240 * CTL * 65536) / FS); // frames per control tick, Q16
const SWEEP_Q8 = Math.floor((256 * 44100 + FS / 2) / FS);
const VIB_INC = Math.floor((0x01000000 * 44100) / FS);
const stepPeriod = (b: number): number => (b <= 16 ? b - 1 : b - 16);
const ARPS = [[0, 0, 0], [0, 12, 0], [0, 4, 7], [0, 3, 7]];
const STEP_DUTY = [1, 2, 4, 6];

function noteOn(t: Track, v: EngVoice): void {
  v.s[0] = 0; // held sample
  v.s[1] = 0; // hold counter
  v.s[2] = 0x7fff; // LFSR
  v.s[3] = 0; // sweep, 1/4096 st
  v.s[4] = 0; // 1-pole lp state
  v.s[5] = 0; // arp counter
  v.s[6] = 15 | ((stepPeriod(t.p[P_E3] >> 2) & 15) << 4); // stepped env
  v.s[7] = 0;
}

/** CHIP = STEP: the voice amplitude is the stepped envelope, not the ADSR curve. */
function amp(t: Track, v: EngVoice, adsr: number): number {
  const b = t.p[P_E3] >> 2;
  let vol = v.s[6] & 15;
  let div = (v.s[6] >> 4) & 15;
  if (t.p[P_E0] !== CHIP_STEP) return adsr;
  if (!v.active) return 0;
  if (v.stage === 3) {
    if (v.env < Math.trunc((1 << 24) / 100) || (b >= 1 && b <= 16 && !vol)) {
      v.env = 0;
      v.stage = 0;
      v.active = 0;
      return 0;
    }
  } else {
    v.env = 1 << 24; // the release starts from full
  }
  if (!b) return 15 * Q4;
  v.s[7] += FRAME_Q16;
  while (v.s[7] >= 65536) {
    v.s[7] -= 65536;
    if (div) {
      div--;
    } else {
      div = stepPeriod(b);
      if (vol) vol--;
      else if (b > 16) vol = 15;
    }
  }
  v.s[6] = vol | (div << 4);
  return vol * Q4;
}

function render(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void {
  const p = t.p;
  const chip = p[P_E0], wave = p[P_E1];
  const stepc = chip === CHIP_STEP;
  const duty = stepc ? Math.imul(0x20000000, STEP_DUTY[(p[P_E2] >> 5) & 3]) >>> 0 : Math.imul(0x20000000, 1 + (p[P_E2] >> 5)) >>> 0;
  const crush = stepc ? 0 : p[P_E3];
  const bits = chip === CHIP_8BIT ? 8 : chip === 3 ? 1 : 4;
  const hold = 1 + Math.trunc(crush / 8) + (chip === 1 ? 1 : 0);
  let lpk = 3000 + (p[P_E7] << 8) + (m.cutoff > 0 ? m.cutoff : 0);
  const ar = p[P_E6];
  let held = v.s[0], cnt = v.s[1], lp = v.s[4];
  let ph0 = v.ph[0];
  let lfsr = v.s[2] >>> 0;
  const wr = WRAM[(p[P_E2] >> 3) & 15];
  let wdc = 0;
  if (wave === RW_WRAM) {
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += bits === 1 ? ((wr[i] >> 7) + ((wr[i] >> 3) & 1)) * 2 - 2 : (wr[i] >> 4) + (wr[i] & 15) - 15;
    wdc = bits === 1 ? Math.trunc((sum * 32767) / 32) : Math.trunc((sum * 2 * Q4) / 32);
  }
  if (v.s[3] < 4096 << 8) v.s[3] += Math.trunc(p[P_E4] / 8) * SWEEP_Q8;
  v.s[5]++;
  const pitch = m.pitch16 - (v.s[3] >> 8) + ARPS[ar & 3][Math.floor(v.s[5] / 28) % 3] * 16;
  let inc = pitchInc(clamp(pitch, 0, 2047));
  if (p[P_E5]) inc = (inc + (Math.imul(inc >>> 12, ((oscSine(v.ph[1]) >> 8) * p[P_E5]) >> 4) >> 4)) >>> 0;
  v.ph[1] += VIB_INC;
  if (lpk > 32767) lpk = 32767;
  for (let i = 0; i < n; i++) {
    if (--cnt <= 0) {
      let q = bits < 16;
      let s: number;
      cnt = hold;
      switch (wave) {
        case RW_TRI:
          if (stepc) {
            const k = ph0 >>> 27;
            s = (k < 16 ? 15 - k : k - 16) * (2 * Q4) - 15 * Q4;
            q = false;
          } else {
            s = oscTri(ph0);
          }
          break;
        case RW_SAW:
          s = (ph0 >>> 16) - 32768;
          break;
        case RW_NOIS: {
          let l = lfsr;
          if (((ph0 + Math.imul(inc, hold)) >>> 0) < ph0 || chip === 3) l = ((l >>> 1) | (((l ^ (l >>> 1)) & 1) << 14)) >>> 0;
          lfsr = l;
          s = l & 1 ? 32767 : -32768;
          break;
        }
        case RW_WRAM: {
          const k = ph0 >>> 27;
          let b = wr[k >> 1];
          b = k & 1 ? b & 15 : b >> 4;
          s = (bits === 1 ? (b >= 8 ? 32767 : -32767) : (b * 2 - 15) * Q4) - wdc;
          q = false;
          break;
        }
        default:
          s = (ph0 < duty ? 32767 : -32768) - ((duty >>> 16) - 32768);
          break;
      }
      if (q) s = ((s + (1 << (15 - bits))) >> (16 - bits)) << (16 - bits);
      if (crush > 64) s = (s >> 12) << 12;
      held = s;
    }
    ph0 = (ph0 + inc) >>> 0;
    lp += mulq15(held - lp, lpk);
    out[i] += voiceAmp(lp, m, i);
  }
  v.ph[0] = ph0;
  v.s[0] = held;
  v.s[1] = cnt;
  v.s[2] = lfsr | 0;
  v.s[4] = lp;
}

export const ENG_LOFI: EngineDef = {
  name: "LOFI",
  pageTitle: ["CHIP", "MOTN"],
  edit: [
    { label: "CHIP", fmt: F.ENUM, min: 0, max: 4, def: 0, names: N_CHIP },
    { label: "WAVE", fmt: F.ENUM, min: 0, max: 4, def: 0, names: N_RWAVE },
    { label: "DUTY", fmt: F.INT, min: 0, max: 127, def: 64 },
    { label: "CRSH", fmt: F.PCT, min: 0, max: 127, def: 0 },
    { label: "SWP", fmt: F.PCT, min: 0, max: 127, def: 0 },
    { label: "VIB", fmt: F.PCT, min: 0, max: 127, def: 0 },
    { label: "ARP", fmt: F.ENUM, min: 0, max: 3, def: 0, names: N_RARP },
    { label: "TONE", fmt: F.PCT, min: 0, max: 127, def: 127 },
  ],
  knob: [P_E1, P_E2, P_E3, P_REL],
  keep: 0x11,
  noteOn,
  render,
  amp,
  desc(t, k) {
    if (k === 2 && t.p[P_E1] === RW_WRAM) return WAVNUM;
    if (k === 3 && t.p[P_E0] === CHIP_STEP) return DCY;
    return undefined;
  },
};
