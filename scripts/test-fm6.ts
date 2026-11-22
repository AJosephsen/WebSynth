// Compares the port against reference output of Felucca's fm6_core.c (tests/fm6-gold.txt).
import { readFileSync } from "node:fs";
import { exp2, freq, sin } from "../src/fm6/math";
import { CTL } from "../src/fm6/tables";
import { Op, render } from "../src/fm6/core";

const got: string[] = [];
for (const x of [-100000000, -5000000, 0, 12345678, 50857777, 60000000, 80000000, 100000000, 200000000])
  got.push(`m ${x} ${exp2(x)} ${freq(x)}`);
for (let ph = 0; ph < 1 << 24; ph += 1234567) got.push(`s ${ph} ${sin(ph)}`);
for (let alg = 0; alg < 32; alg++) {
  const ops: Op[] = Array.from({ length: 6 }, (_, k) => ({
    levelIn: (14 << 24) + (k % 3) * (1 << 22) - (k < 3 ? 0 : 1 << 23),
    gainOut: 0,
    phase: k * 100000,
    freq: freq(50857777 + (k + 1) * (1 << 22)),
  }));
  const fb = new Int32Array(2);
  const out = new Int32Array(CTL);
  let sum = 0;
  let last = [0, 0, 0];
  for (let b = 0; b < 8; b++) {
    out.fill(0);
    if (!render(out, ops, alg, fb, 3)) got.push("silent");
    for (const v of out) sum += v;
    last = [out[0], out[17], out[31]];
  }
  got.push(`a ${alg} ${sum} ${last.join(" ")}`);
}
const gold = readFileSync("tests/fm6-gold.txt", "utf8").trim().split("\n");
let bad = 0;
gold.forEach((g, i) => { if (g !== got[i]) { bad++; if (bad < 6) console.log(`MISMATCH\n gold ${g}\n  got ${got[i]}`); } });
console.log(bad ? `FAIL ${bad}/${gold.length}` : `OK ${gold.length} lines match`);
process.exit(bad ? 1 : 0);
