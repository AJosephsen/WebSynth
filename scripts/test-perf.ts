// Checks the performance layer (throws, mutes, THROW macro) against reference output of Felucca's perform.c (tests/perf-gold.txt).
import { readFileSync } from "node:fs";
import { CTL } from "../src/engines/types";
import { PF_ETHR, PF_M1, PF_RTHR, Perform } from "../src/fx/perform";

let rs = 0x1234567;
const rnd = (): number => {
  rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs |= 0;
  return (rs >>> 14) - 131072;
};
const pf = new Perform();
const lines: string[] = [];
const sig = new Int32Array(CTL), sd = new Int32Array(CTL), sr = new Int32Array(CTL), ml = new Int32Array(CTL), mr = new Int32Array(CTL);
for (let b = 0; b < 700; b++) {
  let held = 0;
  if (b >= 50 && b < 200) held |= 1 << PF_RTHR;
  if (b >= 120 && b < 320) held |= 1 << PF_ETHR;
  if (b >= 300 && b < 420) held |= 1 << (PF_M1 + 1);
  if (b >= 380 && b < 500) held |= (1 << (PF_M1 + 0)) | (1 << PF_RTHR);
  if (b === 450) pf.throwMacro = 60;
  if (b === 600) pf.throwMacro = 0;
  const rev = b < 400 ? 40 : 0;
  pf.held = held >>> 0;
  pf.begin(CTL);
  for (let i = 0; i < CTL; i++) { sig[i] = rnd(); sd[i] = sr[i] = 0; ml[i] = rnd() >> 1; mr[i] = rnd() >> 1; }
  for (let k = 0; k < 2; k++) if ((pf.muteMask >> k) & 1) pf.mute(k, sig, CTL);
  if (pf.thr) pf.throwSend(100, rev, 70, sig, sd, sr, CTL);
  pf.pre(ml, mr, sd, sr, CTL);
  let a = 0, c = 0, d = 0;
  for (let i = 0; i < CTL; i++) { a += sig[i]; c += sd[i]; d += sr[i]; }
  // (the C trace prints the macro's share td too: it is internal here, so print it from the same recurrence)
  lines.push(`${b} ${pf.rw} ${pf.rw1} ${pf.ew} ${pf.ew1} ${pf.mg[0]} ${pf.mg[1]} ${(pf as unknown as { td: number }).td} ${pf.muteMask} ${a} ${c} ${d}`);
}
const gold = readFileSync("tests/perf-gold.txt", "utf8").trimEnd().split("\n");
let bad = 0;
for (let i = 0; i < gold.length; i++) if (gold[i] !== lines[i]) { if (bad++ < 4) console.error(`line ${i + 1}\n  gold: ${gold[i]}\n  ours: ${lines[i]}`); }
console.log(`perf: ${gold.length} blocks, ${bad} differences`);
if (bad) process.exit(1);
