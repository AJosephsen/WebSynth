// Checks the ported effects against reference output of Felucca's fx.c (tests/fx-gold.txt).
import { readFileSync } from "node:fs";
import { sineI } from "../src/engines/dsp";
import { CTL } from "../src/engines/types";
import { Dist, FxBus, FxSettings, Master } from "../src/fx/fx";

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
    x[i] = Math.imul(s + Math.trunc(rnd() / 4), env >> 4) >> 8;
    if (ph % 22050 === 0) x[i] += 60000;
  }
}
const hex = (h: bigint) => h.toString(16).padStart(16, "0");
const lines: string[] = [];
for (let sc = 0; sc < 5; sc++) {
  let hw = 14695981039346656037n, hs = 14695981039346656037n, hm = 14695981039346656037n;
  const bus = new FxBus();
  const master = new Master();
  rs = 0x1234567;
  const st: FxSettings = { bpm: 120, dtime: sc === 3 ? 11 : 1, dfdbk: 60, dcolor: 70, dmix: 90, rtype: sc < 3 ? sc : 2, rsize: sc === 4 ? 20 : 90, rdamp: 60, crate: 40, cdepth: 60 };
  const rt = st.rtype;
  const c = new Int32Array(CTL), d = new Int32Array(CTL), r = new Int32Array(CTL), wet = new Int32Array(CTL), l = new Int32Array(CTL), rr = new Int32Array(CTL);
  for (let b = 0; b < 1400; b++) {
    signal(b, c);
    for (let i = 0; i < CTL; i++) { d[i] = c[i] >> 1; r[i] = c[i]; l[i] = c[i]; rr[i] = c[i]; }
    if (sc === 3 && b === 700) bus.throwAmount = 20000;
    if (sc === 4 && b === 600) st.rtype = 0;
    if (sc === 4 && b === 900) st.rtype = 1;
    bus.process(st, c, d, r, wet, CTL);
    if (bus.side) bus.sideMix(l, rr, CTL);
    for (let i = 0; i < CTL; i++) {
      let lo = (((l[i] + wet[i]) >> 2) * 4096) >> 10;
      let ro = (((rr[i] + wet[i]) >> 2) * 4096) >> 10;
      hw = fnv(hw, wet[i]);
      if (bus.side) hs = fnv(hs, bus.sd[i]);
      [lo, ro] = master.process(lo, ro);
      hm = fnv(fnv(hm, lo), ro);
    }
  }
  lines.push(`buses ${sc} rt=${rt} ${hex(hw)} side ${hex(hs)} master ${hex(hm)}`);
}
for (const amt of [1, 30, 80, 127]) {
  let h = 14695981039346656037n;
  const dist = new Dist();
  rs = 0x1234567;
  const x = new Int32Array(CTL);
  for (let b = 0; b < 400; b++) {
    signal(b, x);
    dist.process(amt, x, CTL);
    for (let i = 0; i < CTL; i++) h = fnv(h, x[i]);
  }
  lines.push(`dist ${amt} ${hex(h)}`);
}
const gold = readFileSync("tests/fx-gold.txt", "utf8").trim().split("\n");
let bad = 0;
gold.forEach((g, i) => { if (g !== lines[i]) { bad++; console.log(`MISMATCH\n gold ${g}\n  got ${lines[i]}`); } });
console.log(bad ? `FAIL ${bad}/${gold.length}` : `OK ${gold.length} effect renders match`);
process.exit(bad ? 1 : 0);
