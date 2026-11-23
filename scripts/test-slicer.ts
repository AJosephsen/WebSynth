// Checks the SLICER insert against hashes of Felucca's slicer.c compiled in a harness (tests/slicer-gold.txt).
import { readFileSync } from "node:fs";
import { sineI } from "../src/engines/dsp";
import { CTL } from "../src/engines/types";
import { Slicer, SlicerSetting } from "../src/fx/slicer";

const M = 0xffffffffffffffffn;
const fnv = (h: bigint, v: number): bigint => {
  const x = v >>> 0;
  for (let k = 0; k < 4; k++) { h ^= BigInt((x >>> (8 * k)) & 0xff); h = (h * 1099511628211n) & M; }
  return h;
};
let rs = 0x1234567;
const rnd = (): number => { rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs |= 0; return (rs >>> 17) - 16384; };
const out: string[] = [];
const x = new Int32Array(CTL);
for (let cfg = 0; cfg < 96; cfg++) {
  const sl = new Slicer();
  const s: SlicerSetting = { mode: 1 + (cfg % 2), pat: 1 + (cfg % 16), rate: Math.floor(cfg / 2) % 6, depth: 40 + ((cfg * 13) % 88) };
  const swing = cfg % 3 ? (cfg * 7) % 60 : 0;
  const gswing = cfg % 5 === 0 ? 20 : 0;
  const bpm = 80 + ((cfg * 11) % 120);
  rs = (0x1234567 + Math.imul(cfg, 31337)) | 0;
  const mode0 = s.mode, pat0 = s.pat;
  sl.start();
  let h = 14695981039346656037n;
  for (let b = 0; b < 1500; b++) {
    const silent = b % 97 > 90;
    if (b === 500) s.mode = 0;
    if (b === 520) s.mode = mode0;
    if (b === 900) s.pat = 1 + ((cfg + 5) % 16);
    for (let i = 0; i < CTL; i++) {
      const ph = b * CTL + i;
      x[i] = silent ? 0 : Math.imul((sineI(Math.imul(ph, 97391) >>> 0) >> 1) + Math.trunc(rnd() / 8), ph % 11025 < 6000 ? 1 : 0);
    }
    sl.process(s, silent ? null : x, CTL, bpm, Math.min(100, swing + gswing));
    for (let i = 0; i < CTL; i++) h = fnv(h, x[i]);
  }
  void pat0;
  out.push(`cfg ${cfg} mode ${s.mode} pat ${s.pat} rate ${s.rate} depth ${s.depth} ${h.toString(16).padStart(16, "0")}`);
}
const gold = readFileSync("tests/slicer-gold.txt", "utf8").trimEnd().split("\n");
let bad = 0, first = "";
for (let i = 0; i < gold.length; i++) {
  const g = gold[i].split(" ");
  if (g.slice(0, 10).join(" ") !== out[i].split(" ").slice(0, 10).join(" ")) { bad++; continue; }
  if (g[10] !== out[i].split(" ")[10]) { if (!first) first = `line ${i + 1}: gold ${gold[i]} ours ${out[i]}`; bad++; }
}
console.log(`slicer: ${gold.length} configs, ${bad} differences${first ? "\n  first: " + first : ""}`);
if (bad) process.exit(1);
