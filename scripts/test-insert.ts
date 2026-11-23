// Checks the ported insert effects against reference output of Felucca's fx.c (tests/ins-gold.txt).
import { readFileSync } from "node:fs";
import { sineI } from "../src/engines/dsp";
import { CTL } from "../src/engines/types";
import { Insert, IT_N } from "../src/fx/insert";

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
function signal(b: number, x: Int32Array): void {
  for (let i = 0; i < CTL; i++) {
    const ph = b * CTL + i;
    const env = ph % 22050 < 3000 ? 3000 - (ph % 22050) : 0;
    const s = sineI(Math.imul(ph, 97391) >>> 0) >> 1;
    x[i] = Math.imul(s + Math.trunc(rnd() / 4), env >> 4) >> 5;
    if (ph % 22050 === 0) x[i] += 60000;
  }
}
const A = [0, 60, 127, 90], B = [0, 64, 127, 30], C = [0, 64, 127, 100];
const lines: string[] = [];
for (let ty = 1; ty < IT_N; ty++) {
  for (let v = 0; v < 4; v++) {
    for (let mix = 0; mix < 2; mix++) {
      let h = 14695981039346656037n;
      const ins = new Insert();
      const p = { itype: ty, imix: mix ? 127 : 70, ia: A[v], ib: B[(v + 1) % 4], ic: C[(v + 2) % 4] };
      rs = 0x1234567;
      const x = new Int32Array(CTL);
      for (let b = 0; b < 600; b++) {
        signal(b, x);
        if (v === 3 && b === 300) p.itype = (ty % 8) + 1;
        if (v === 2 && b === 200) p.imix = 0;
        if (v === 2 && b === 400) p.imix = 127;
        if (p.itype || ins.running) ins.process(p, x, CTL);
        for (let i = 0; i < CTL; i++) h = fnv(h, x[i]);
      }
      lines.push(`ins ${ty} v${v} m${mix} ${h.toString(16).padStart(16, "0")}`);
    }
  }
}
const gold = readFileSync("tests/ins-gold.txt", "utf8").trim().split("\n");
let bad = 0;
gold.forEach((g, i) => { if (g !== lines[i]) { bad++; if (bad < 6) console.log(`MISMATCH\n gold ${g}\n  got ${lines[i]}`); } });
console.log(bad ? `FAIL ${bad}/${gold.length}` : `OK ${gold.length} insert renders match`);
process.exit(bad ? 1 : 0);
