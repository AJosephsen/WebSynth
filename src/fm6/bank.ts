// WebSynth factory bank: original voices written for this project (GPL-3.0-only), as readable operator settings.
// Operators are listed OP1..OP6; the 155-byte voice stores them sixth first. Algorithms use DX7 numbering:
//   1: 2>1  6>5>4>3 (carriers 1,3)        5: 2>1  4>3  6>5 (carriers 1,3,5)      22: 6>3,4,5  2>1 (carriers 1,3,4,5)
//   31: 6>5 (carriers 1..5)               32: six carriers
import { FP } from "./patch";

type Rates = [number, number, number, number];

interface OpSpec {
  r: Rates; // EG rates 1..4
  l: Rates; // EG levels 1..4
  ol: number; // output level 0..99; 0 = silent
  fc: number; // coarse frequency (0 = 0.5, 1 = 1, 2 = 2, ...)
  ff: number; // fine frequency 0..99
  det: number; // detune 0..14, 7 = centre
  kvs: number; // velocity sensitivity 0..7
  rs: number; // rate scaling 0..7
  ams: number; // LFO amplitude sensitivity 0..3
}

const op = (o: Partial<OpSpec> = {}): OpSpec => ({
  r: [99, 99, 99, 99], l: [99, 99, 99, 0], ol: 0, fc: 1, ff: 0, det: 7, kvs: 0, rs: 0, ams: 0, ...o,
});

interface VoiceOpts {
  fb?: number; pr?: Rates; pl?: Rates;
  lfs?: number; lfd?: number; lpmd?: number; lamd?: number; lfw?: number; lpms?: number; trnsp?: number;
}

function voice(name: string, alg: number, ops: OpSpec[], o: VoiceOpts = {}): Uint8Array {
  if (ops.length !== 6 || alg < 1 || alg > 32 || name.length > 10) throw new Error(`bad voice ${name}`);
  const v = new Uint8Array(FP.SIZE);
  [...ops].reverse().forEach((s, k) => {
    const b = k * FP.OP;
    v.set([...s.r, ...s.l], b);
    v[b + FP.BP] = 39; // break point C3, no level scaling
    v[b + FP.RS] = s.rs;
    v[b + FP.AMS] = s.ams;
    v[b + FP.KVS] = s.kvs;
    v[b + FP.OL] = s.ol;
    v[b + FP.FC] = s.fc;
    v[b + FP.FF] = s.ff;
    v[b + FP.DET] = s.det;
  });
  v.set(o.pr ?? [99, 99, 99, 99], FP.PR1);
  v.set(o.pl ?? [50, 50, 50, 50], FP.PL1);
  v[FP.ALG] = alg - 1;
  v[FP.FB] = o.fb ?? 0;
  v[FP.OKS] = 1;
  v[FP.LFS] = o.lfs ?? 35;
  v[FP.LFD] = o.lfd ?? 0;
  v[FP.LPMD] = o.lpmd ?? 0;
  v[FP.LAMD] = o.lamd ?? 0;
  v[FP.LKS] = 1;
  v[FP.LFW] = o.lfw ?? 4;
  v[FP.LPMS] = o.lpms ?? 3;
  v[FP.TRNSP] = o.trnsp ?? 24;
  for (let i = 0; i < 10; i++) v[FP.NAME + i] = (name.padEnd(10)[i] ?? " ").charCodeAt(0);
  return v;
}

const R = (a: number, b: number, c: number, d: number): Rates => [a, b, c, d];

export const bankVoices: Uint8Array[] = [
  // ---- keys ----
  voice("CLAV", 5, [
    op({ r: R(99, 45, 25, 70), l: R(99, 70, 0, 0), ol: 99, kvs: 3, rs: 3 }),
    op({ r: R(99, 75, 45, 70), l: R(99, 30, 0, 0), ol: 80, fc: 3, kvs: 5, rs: 3 }),
    op({ r: R(99, 45, 25, 70), l: R(99, 70, 0, 0), ol: 92, det: 8, kvs: 3, rs: 3 }),
    op({ r: R(99, 80, 50, 70), l: R(99, 25, 0, 0), ol: 76, fc: 5, kvs: 5, rs: 3 }),
    op(), op(),
  ], { fb: 4 }),
  voice("HARPSI", 5, [
    op({ r: R(99, 40, 25, 70), l: R(99, 75, 0, 0), ol: 99, kvs: 2, rs: 3 }),
    op({ r: R(99, 80, 50, 70), l: R(99, 25, 0, 0), ol: 74, fc: 4, kvs: 4, rs: 3 }),
    op({ r: R(99, 40, 25, 70), l: R(99, 75, 0, 0), ol: 88, fc: 2, kvs: 2, rs: 3 }),
    op({ r: R(99, 80, 50, 70), l: R(99, 20, 0, 0), ol: 70, fc: 6, kvs: 4, rs: 3 }),
    op(), op(),
  ], { fb: 3 }),
  voice("WURLI", 5, [
    op({ r: R(97, 30, 25, 60), l: R(99, 80, 0, 0), ol: 98, kvs: 2, rs: 2 }),
    op({ r: R(95, 55, 35, 60), l: R(99, 60, 0, 0), ol: 66, kvs: 6, rs: 2 }),
    op({ r: R(97, 30, 25, 60), l: R(99, 80, 0, 0), ol: 80, det: 8, kvs: 2, rs: 2 }),
    op({ r: R(99, 70, 40, 60), l: R(99, 30, 0, 0), ol: 56, fc: 7, kvs: 6, rs: 2 }),
    op(), op(),
  ], { fb: 5, lfs: 30, lamd: 8, lpmd: 0 }),
  voice("PIANO", 1, [
    op({ r: R(99, 35, 22, 65), l: R(99, 85, 0, 0), ol: 99, kvs: 3, rs: 3 }),
    op({ r: R(99, 50, 30, 65), l: R(99, 55, 0, 0), ol: 78, kvs: 6, rs: 3 }),
    op({ r: R(99, 30, 20, 65), l: R(99, 85, 0, 0), ol: 92, det: 8, kvs: 3, rs: 3 }),
    op({ r: R(99, 55, 35, 65), l: R(99, 55, 0, 0), ol: 70, kvs: 5, rs: 3 }),
    op({ r: R(99, 70, 40, 65), l: R(99, 40, 0, 0), ol: 66, fc: 14, kvs: 7, rs: 3 }),
    op({ r: R(99, 70, 40, 65), l: R(99, 40, 0, 0), ol: 60, kvs: 4, rs: 3 }),
  ], { fb: 2 }),
  // ---- mallets and bells ----
  voice("VIBES", 5, [
    op({ r: R(99, 38, 25, 45), l: R(99, 85, 0, 0), ol: 99, kvs: 2, rs: 2, ams: 1 }),
    op({ r: R(99, 70, 40, 60), l: R(99, 30, 0, 0), ol: 62, fc: 4, kvs: 4, rs: 3 }),
    op({ r: R(99, 38, 25, 45), l: R(99, 85, 0, 0), ol: 90, det: 8, kvs: 2, rs: 2, ams: 1 }),
    op({ r: R(99, 70, 40, 60), l: R(99, 30, 0, 0), ol: 50, fc: 10, kvs: 4, rs: 3 }),
    op(), op(),
  ], { lfs: 33, lamd: 30, lfw: 4 }),
  voice("TUBULAR", 5, [
    op({ r: R(99, 30, 20, 30), l: R(99, 85, 0, 0), ol: 99, kvs: 1 }),
    op({ r: R(99, 38, 25, 35), l: R(99, 75, 0, 0), ol: 78, fc: 3, ff: 50, kvs: 3 }),
    op({ r: R(99, 32, 20, 30), l: R(99, 85, 0, 0), ol: 88, fc: 2, ff: 40, kvs: 1 }),
    op({ r: R(99, 40, 25, 35), l: R(99, 70, 0, 0), ol: 70, fc: 5, ff: 40, kvs: 3 }),
    op({ r: R(99, 34, 22, 32), l: R(99, 80, 0, 0), ol: 70, fc: 4, ff: 30, kvs: 1 }),
    op({ r: R(99, 42, 28, 35), l: R(99, 65, 0, 0), ol: 60, fc: 7, ff: 10, kvs: 3 }),
  ], { fb: 0 }),
  voice("KALIMBA", 5, [
    op({ r: R(99, 45, 30, 60), l: R(99, 55, 0, 0), ol: 99, kvs: 3, rs: 3 }),
    op({ r: R(99, 80, 50, 70), l: R(99, 5, 0, 0), ol: 70, fc: 5, kvs: 5, rs: 3 }),
    op({ r: R(99, 50, 35, 60), l: R(99, 40, 0, 0), ol: 80, fc: 4, kvs: 3, rs: 3 }),
    op({ r: R(99, 85, 60, 70), l: R(99, 0, 0, 0), ol: 62, fc: 9, kvs: 5, rs: 3 }),
    op(), op(),
  ]),
  voice("GLOCK", 5, [
    op({ r: R(99, 42, 30, 35), l: R(99, 60, 0, 0), ol: 99, fc: 1, kvs: 2 }),
    op({ r: R(99, 55, 35, 40), l: R(99, 40, 0, 0), ol: 70, fc: 7, ff: 20, kvs: 4 }),
    op({ r: R(99, 42, 30, 35), l: R(99, 60, 0, 0), ol: 80, fc: 3, ff: 15, kvs: 2 }),
    op({ r: R(99, 58, 38, 40), l: R(99, 35, 0, 0), ol: 62, fc: 11, kvs: 4 }),
    op(), op(),
  ]),
  // ---- bass ----
  voice("SLAP BASS", 1, [
    op({ r: R(99, 55, 30, 70), l: R(99, 75, 55, 0), ol: 99, kvs: 3 }),
    op({ r: R(99, 70, 40, 70), l: R(99, 40, 15, 0), ol: 84, kvs: 6 }),
    op({ r: R(99, 50, 30, 70), l: R(99, 70, 50, 0), ol: 92, fc: 0 }),
    op({ r: R(99, 70, 40, 70), l: R(99, 45, 20, 0), ol: 78, kvs: 5 }),
    op({ r: R(99, 80, 50, 70), l: R(99, 30, 0, 0), ol: 70, fc: 3, kvs: 5 }),
    op({ r: R(99, 80, 50, 70), l: R(99, 30, 0, 0), ol: 64 }),
  ], { fb: 5 }),
  voice("SYN BASS", 1, [
    op({ r: R(99, 60, 45, 75), l: R(99, 90, 80, 0), ol: 99, kvs: 2 }),
    op({ r: R(99, 55, 40, 75), l: R(99, 55, 35, 0), ol: 86, kvs: 4 }),
    op({ r: R(99, 60, 45, 75), l: R(99, 90, 80, 0), ol: 70, fc: 0 }),
    op({ r: R(99, 60, 45, 75), l: R(99, 70, 50, 0), ol: 72 }),
    op({ r: R(99, 60, 45, 75), l: R(99, 70, 50, 0), ol: 70 }),
    op({ r: R(99, 60, 45, 75), l: R(99, 70, 50, 0), ol: 78 }),
  ], { fb: 7 }),
  voice("SUB BASS", 5, [
    op({ r: R(99, 30, 25, 70), l: R(99, 95, 90, 0), ol: 99, kvs: 1 }),
    op({ r: R(99, 40, 30, 70), l: R(99, 60, 40, 0), ol: 60, kvs: 3 }),
    op({ r: R(99, 30, 25, 70), l: R(99, 95, 90, 0), ol: 80, fc: 0 }),
    op({ r: R(99, 40, 30, 70), l: R(99, 40, 20, 0), ol: 40 }),
    op(), op(),
  ]),
  // ---- brass and reeds ----
  voice("TRUMPET", 1, [
    op({ r: R(70, 45, 40, 60), l: R(99, 94, 90, 0), ol: 99, kvs: 2 }),
    op({ r: R(55, 40, 38, 60), l: R(99, 85, 80, 0), ol: 78, kvs: 4 }),
    op({ r: R(70, 45, 40, 60), l: R(99, 90, 85, 0), ol: 86, det: 8, kvs: 2 }),
    op({ r: R(50, 40, 35, 60), l: R(99, 88, 82, 0), ol: 76, kvs: 4 }),
    op({ r: R(60, 40, 35, 60), l: R(99, 85, 80, 0), ol: 70 }),
    op({ r: R(60, 40, 35, 60), l: R(99, 85, 80, 0), ol: 72 }),
  ], { fb: 6, lfs: 35, lfd: 45, lpmd: 8, lpms: 3 }),
  voice("HORNS", 5, [
    op({ r: R(50, 40, 40, 55), l: R(99, 92, 90, 0), ol: 98, kvs: 1 }),
    op({ r: R(40, 38, 38, 55), l: R(95, 80, 75, 0), ol: 70, kvs: 3 }),
    op({ r: R(52, 40, 40, 55), l: R(99, 92, 90, 0), ol: 90, det: 9 }),
    op({ r: R(42, 38, 38, 55), l: R(95, 80, 75, 0), ol: 66, kvs: 3 }),
    op({ r: R(50, 40, 40, 55), l: R(99, 92, 90, 0), ol: 84, det: 5 }),
    op({ r: R(40, 38, 38, 55), l: R(95, 80, 75, 0), ol: 62, kvs: 3 }),
  ], { fb: 5, lfs: 33, lfd: 50, lpmd: 5 }),
  voice("OBOE", 5, [
    op({ r: R(70, 50, 45, 65), l: R(99, 94, 92, 0), ol: 99, kvs: 1 }),
    op({ r: R(65, 50, 45, 65), l: R(99, 78, 74, 0), ol: 70, fc: 2, kvs: 3 }),
    op({ r: R(70, 50, 45, 65), l: R(99, 94, 92, 0), ol: 70, fc: 2, det: 8 }),
    op({ r: R(65, 50, 45, 65), l: R(99, 70, 66, 0), ol: 60, fc: 3, kvs: 3 }),
    op(), op(),
  ], { fb: 4, lfs: 36, lfd: 55, lpmd: 6 }),
  // ---- strings, pads, voices ----
  voice("STRINGS", 32, [
    op({ r: R(45, 30, 40, 40), l: R(99, 95, 90, 0), ol: 86, det: 5 }),
    op({ r: R(45, 30, 40, 40), l: R(99, 95, 90, 0), ol: 86, det: 9 }),
    op({ r: R(40, 30, 40, 40), l: R(99, 95, 90, 0), ol: 80, fc: 2, det: 6 }),
    op({ r: R(40, 30, 40, 40), l: R(99, 95, 90, 0), ol: 78, fc: 2, det: 8 }),
    op({ r: R(40, 30, 40, 40), l: R(99, 95, 90, 0), ol: 70, det: 4 }),
    op({ r: R(40, 30, 40, 40), l: R(99, 95, 90, 0), ol: 70, det: 10 }),
  ], { fb: 6, lfs: 30, lfd: 60, lpmd: 4, lpms: 2 }),
  voice("WARM PAD", 22, [
    op({ r: R(35, 30, 40, 38), l: R(99, 95, 90, 0), ol: 90, det: 6 }),
    op({ r: R(35, 30, 40, 38), l: R(85, 80, 75, 0), ol: 50 }),
    op({ r: R(35, 30, 40, 38), l: R(99, 95, 90, 0), ol: 84, det: 9 }),
    op({ r: R(35, 30, 40, 38), l: R(99, 95, 90, 0), ol: 80, fc: 2, det: 5 }),
    op({ r: R(35, 30, 40, 38), l: R(99, 95, 90, 0), ol: 72, fc: 2, det: 10 }),
    op({ r: R(30, 30, 40, 38), l: R(80, 75, 70, 0), ol: 56 }),
  ], { fb: 3, lfs: 28, lfd: 60, lpmd: 4, lpms: 2 }),
  voice("CHOIR", 5, [
    op({ r: R(40, 35, 40, 45), l: R(99, 95, 92, 0), ol: 98 }),
    op({ r: R(38, 35, 40, 45), l: R(90, 80, 76, 0), ol: 64, fc: 3, ff: 10 }),
    op({ r: R(40, 35, 40, 45), l: R(99, 95, 92, 0), ol: 86, det: 9 }),
    op({ r: R(38, 35, 40, 45), l: R(85, 75, 70, 0), ol: 58, fc: 5, ff: 5 }),
    op({ r: R(40, 35, 40, 45), l: R(99, 95, 92, 0), ol: 76, fc: 2, det: 5 }),
    op({ r: R(38, 35, 40, 45), l: R(80, 70, 65, 0), ol: 50 }),
  ], { fb: 2, lfs: 32, lfd: 60, lpmd: 5 }),
  // ---- organs ----
  voice("ROCK ORG", 32, [
    op({ r: R(99, 99, 99, 90), l: R(99, 99, 99, 0), ol: 92, fc: 0 }),
    op({ r: R(99, 99, 99, 90), l: R(99, 99, 99, 0), ol: 88 }),
    op({ r: R(99, 99, 99, 90), l: R(99, 99, 99, 0), ol: 84, fc: 3 }),
    op({ r: R(99, 99, 99, 90), l: R(99, 99, 99, 0), ol: 72, fc: 4 }),
    op({ r: R(99, 99, 99, 90), l: R(99, 99, 99, 0), ol: 60, fc: 6 }),
    op({ r: R(99, 70, 50, 90), l: R(99, 0, 0, 0), ol: 80, fc: 8 }),
  ], { fb: 2, lfs: 40, lamd: 0, lpmd: 2 }),
  voice("PIPE ORG", 32, [
    op({ r: R(70, 99, 99, 60), l: R(99, 99, 99, 0), ol: 90, fc: 0 }),
    op({ r: R(70, 99, 99, 60), l: R(99, 99, 99, 0), ol: 90 }),
    op({ r: R(70, 99, 99, 60), l: R(99, 99, 99, 0), ol: 82, fc: 2 }),
    op({ r: R(70, 99, 99, 60), l: R(99, 99, 99, 0), ol: 78, fc: 3 }),
    op({ r: R(70, 99, 99, 60), l: R(99, 99, 99, 0), ol: 70, fc: 4 }),
    op({ r: R(70, 99, 99, 60), l: R(99, 99, 99, 0), ol: 62, fc: 6 }),
  ], { fb: 1 }),
  // ---- plucks ----
  voice("NYLON GTR", 5, [
    op({ r: R(99, 50, 30, 60), l: R(99, 60, 0, 0), ol: 99, kvs: 3, rs: 3 }),
    op({ r: R(99, 70, 40, 65), l: R(99, 25, 0, 0), ol: 72, fc: 2, kvs: 5, rs: 3 }),
    op({ r: R(99, 52, 30, 60), l: R(99, 55, 0, 0), ol: 78, fc: 2, kvs: 3, rs: 3 }),
    op({ r: R(99, 75, 45, 65), l: R(99, 20, 0, 0), ol: 66, fc: 3, kvs: 5, rs: 3 }),
    op(), op(),
  ], { fb: 3 }),
  voice("HARP", 5, [
    op({ r: R(99, 42, 28, 55), l: R(99, 70, 0, 0), ol: 99, kvs: 2, rs: 3 }),
    op({ r: R(99, 70, 40, 60), l: R(99, 30, 0, 0), ol: 66, fc: 3, kvs: 4, rs: 3 }),
    op({ r: R(99, 44, 28, 55), l: R(99, 68, 0, 0), ol: 84, fc: 2, kvs: 2, rs: 3 }),
    op({ r: R(99, 72, 42, 60), l: R(99, 25, 0, 0), ol: 58, fc: 5, kvs: 4, rs: 3 }),
    op(), op(),
  ]),
  // ---- leads ----
  voice("SAW LEAD", 1, [
    op({ r: R(90, 50, 99, 70), l: R(99, 95, 95, 0), ol: 99, kvs: 1 }),
    op({ r: R(90, 50, 99, 70), l: R(99, 80, 75, 0), ol: 86, fc: 1 }),
    op({ r: R(90, 50, 99, 70), l: R(99, 95, 95, 0), ol: 92, det: 9 }),
    op({ r: R(90, 50, 99, 70), l: R(99, 80, 75, 0), ol: 70 }),
    op({ r: R(90, 50, 99, 70), l: R(99, 80, 75, 0), ol: 62 }),
    op({ r: R(90, 50, 99, 70), l: R(99, 80, 75, 0), ol: 80 }),
  ], { fb: 7, lfs: 36, lfd: 50, lpmd: 8, lpms: 3 }),
  voice("SQR LEAD", 5, [
    op({ r: R(95, 50, 99, 70), l: R(99, 97, 97, 0), ol: 99, kvs: 1 }),
    op({ r: R(95, 50, 99, 70), l: R(99, 85, 82, 0), ol: 70, fc: 3, kvs: 2 }),
    op({ r: R(95, 50, 99, 70), l: R(99, 97, 97, 0), ol: 88, det: 8 }),
    op({ r: R(95, 50, 99, 70), l: R(99, 85, 82, 0), ol: 64, fc: 3, kvs: 2 }),
    op(), op(),
  ], { fb: 6, lfs: 36, lfd: 55, lpmd: 6 }),
  voice("FLUTE", 5, [
    op({ r: R(60, 50, 50, 60), l: R(99, 94, 92, 0), ol: 96, kvs: 1 }),
    op({ r: R(70, 60, 50, 60), l: R(95, 40, 30, 0), ol: 40, fc: 1, kvs: 3 }),
    op({ r: R(60, 50, 50, 60), l: R(99, 90, 88, 0), ol: 70, fc: 2, det: 8 }),
    op({ r: R(70, 60, 50, 60), l: R(90, 30, 20, 0), ol: 34, fc: 3 }),
    op(), op(),
  ], { fb: 2, lfs: 38, lfd: 60, lpmd: 4, lpms: 2 }),
];
