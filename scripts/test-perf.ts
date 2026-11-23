// Checks the performance layer (buffer effects, filters, CRUSH, FLANGER, PHASER, throws, mutes, macros) against hashes of
// the real perform.c compiled in a harness (tests/perf-gold.txt: per scenario, a hash of every second block).
import { readFileSync } from "node:fs";
import { sineI } from "../src/engines/dsp";
import { CTL } from "../src/engines/types";
import {
  PF_ETHR, PF_FLG, PF_FRZ, PF_HPF, PF_LPF, PF_M1, PF_ODN, PF_OUP, PF_PHS, PF_R16, PF_R32, PF_R8, PF_REV, PF_RTHR, PF_TAPE, Perform,
  resetPerformRng,
} from "../src/fx/perform";

const M = 0xffffffffffffffffn;
const fnv = (h: bigint, v: number): bigint => {
  const x = v >>> 0;
  for (let k = 0; k < 4; k++) { h ^= BigInt((x >>> (8 * k)) & 0xff); h = (h * 1099511628211n) & M; }
  return h;
};
let rs = 0x1234567;
const rnd = (): number => {
  rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs |= 0;
  return (rs >>> 17) - 16384;
};
function signal(b: number, l: Int32Array, r: Int32Array): void {
  for (let i = 0; i < CTL; i++) {
    const ph = b * CTL + i;
    const env = ph % 9000 < 4000 ? 4000 - (ph % 9000) : 0;
    const s = sineI(Math.imul(ph, 97391) >>> 0) >> 1, s2 = sineI((Math.imul(ph, 41011) + 5555) >>> 0) >> 1;
    l[i] = Math.imul(s + Math.trunc(rnd() / 4), env >> 4) >> 5;
    r[i] = Math.imul(s2 + Math.trunc(rnd() / 4), env >> 4) >> 5;
    if (ph % 9000 === 0) { l[i] += 12000; r[i] -= 9000; }
  }
}
const B = (e: number): number => 1 << e;
interface Scen { name: string; held: number; k: number[]; bpm: number; playing: boolean }
const S: Scen[] = [
  { name: "idle", held: 0, k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "R8", held: B(PF_R8), k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "R16", held: B(PF_R16), k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "R32", held: B(PF_R32), k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "REV", held: B(PF_REV), k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "R16-stopped", held: B(PF_R16), k: [0, 0, 0, 0], bpm: 160, playing: false },
  { name: "LPF", held: B(PF_LPF), k: [0, 0, 0, 0], bpm: 240, playing: true },
  { name: "HPF", held: B(PF_HPF), k: [0, 0, 0, 0], bpm: 240, playing: true },
  { name: "TAPE", held: B(PF_TAPE), k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "FRZ", held: B(PF_FRZ), k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "OUP", held: B(PF_OUP), k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "ODN", held: B(PF_ODN), k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "OUP-shimmer", held: B(PF_OUP), k: [0, 0, 0, 60], bpm: 160, playing: true },
  { name: "FLG", held: B(PF_FLG), k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "PHS", held: B(PF_PHS), k: [0, 0, 0, 40], bpm: 160, playing: true },
  { name: "knobs", held: 0, k: [-50, 60, 30, 0], bpm: 160, playing: true },
  { name: "knob-hp", held: 0, k: [70, 0, 0, 0], bpm: 160, playing: true },
  { name: "stack", held: B(PF_R16) | B(PF_LPF) | B(PF_FLG) | B(PF_PHS), k: [0, 40, 0, 20], bpm: 160, playing: true },
  { name: "buf-switch", held: B(PF_R8) | B(PF_FRZ), k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "bpm120", held: B(PF_R8), k: [0, 0, 0, 0], bpm: 120, playing: true },
  { name: "RTHR", held: B(PF_RTHR), k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "ETHR+knob3", held: B(PF_ETHR), k: [0, 0, 50, 0], bpm: 160, playing: true },
  { name: "mutes", held: B(PF_M1) | B(PF_M1 + 1), k: [0, 0, 0, 0], bpm: 160, playing: true },
  { name: "everything", held: B(PF_R32) | B(PF_HPF) | B(PF_PHS) | B(PF_RTHR) | B(PF_M1), k: [30, 20, 20, 30], bpm: 140, playing: true },
  { name: "tape-slow", held: B(PF_TAPE), k: [0, 0, 0, 0], bpm: 60, playing: true },
];

const out: string[] = [];
const l = new Int32Array(CTL), r = new Int32Array(CTL), t0 = new Int32Array(CTL), t1 = new Int32Array(CTL), sd = new Int32Array(CTL), sr = new Int32Array(CTL);
for (const sc of S) {
  rs = 0x1234567;
  resetPerformRng();
  const pf = new Perform();
  pf.bpm = sc.bpm;
  pf.playing = sc.playing;
  pf.start();
  out.push(`== ${sc.name}`);
  for (let b = 0; b < 640; b++) {
    let held = b >= 40 && b < 420 ? sc.held : 0;
    if (sc.name === "buf-switch" && b >= 200 && b < 420) held = B(PF_FRZ);
    pf.held = held >>> 0;
    for (let i = 0; i < 4; i++) pf.k[i] = b >= 40 && b < 520 ? sc.k[i] : 0;
    signal(b, l, r);
    for (let i = 0; i < CTL; i++) { t0[i] = l[i] >> 1; t1[i] = r[i] >> 1; sd[i] = sr[i] = 0; }
    const on = pf.begin(CTL);
    if (pf.muteMask & 1) pf.mute(0, t0, CTL);
    if (pf.muteMask & 2) pf.mute(1, t1, CTL);
    if (pf.thr) { pf.throwSend(100, 30, 50, t0, sd, sr, CTL); pf.throwSend(80, 0, 20, t1, sd, sr, CTL); }
    if (on) { pf.pre(l, r, sd, sr, CTL); pf.block(l, r, CTL); }
    if (b % 2 === 0) {
      let h = 14695981039346656037n;
      for (let i = 0; i < CTL; i++) { h = fnv(h, l[i]); h = fnv(h, r[i]); h = fnv(h, t0[i]); h = fnv(h, t1[i]); h = fnv(h, sd[i]); h = fnv(h, sr[i]); }
      out.push(`${b} ${h.toString(16).padStart(16, "0")}`);
    }
  }
}
const gold = readFileSync("tests/perf-gold.txt", "utf8").trimEnd().split("\n");
let bad = 0, firstBad = "";
for (let i = 0; i < Math.max(gold.length, out.length); i++) {
  if (gold[i] !== out[i]) {
    if (!firstBad) { let sec = ""; for (let j = i; j >= 0; j--) if (gold[j]?.startsWith("== ")) { sec = gold[j]; break; } firstBad = `line ${i + 1} (${sec}): gold ${gold[i]} ours ${out[i]}`; }
    bad++;
  }
}
console.log(`perf: ${gold.length} lines, ${bad} differences${firstBad ? "\n  first: " + firstBad : ""}`);
if (bad) process.exit(1);
