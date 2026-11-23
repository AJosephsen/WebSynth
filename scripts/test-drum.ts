// Checks the ported drum voices against reference output of Felucca's drum_voice.c (tests/drum-gold.txt).
import { readFileSync } from "node:fs";
import { CTL } from "../src/engines/types";
import {
  DV_KTYPE, DV_NKIT, DV_NLANE, DVT_COUNT, DVT_HATC, DvCoef, DvMetal, DvVoice, dvChoke, dvDefault, dvInit, dvMetalRun, dvMetalTune, dvRun, dvSetup,
  dvTrigger, dvUsesMetal,
} from "../src/drum/dv";

const M = 0xffffffffffffffffn;
const fnv = (h: bigint, v: number): bigint => {
  const x = v >>> 0;
  for (let k = 0; k < 4; k++) { h ^= BigInt((x >>> (8 * k)) & 0xff); h = (h * 1099511628211n) & M; }
  return h;
};

function runCase(tag: string, type: number, variant: number): string {
  const p = dvDefault(type);
  if (variant === 1) {
    p.decay += 20; p.tone += 30; p.extra = Math.min(127, p.extra + 40); p.accent = 90; p.tune = 20; p.level = 127;
  } else if (variant === 2) {
    p.decay = 5; p.tone = 120; p.extra = 3; p.accent = 127; p.tune = -30; p.level = 60;
  }
  const c = new DvCoef(), v = new DvVoice(), mb = new DvMetal();
  const y = new Int32Array(CTL), m = new Int32Array(CTL);
  let h = 14695981039346656037n;
  let peak = 0;
  dvSetup(c, p);
  dvInit(v, type);
  if (dvUsesMetal(c.type)) dvMetalTune(mb, c);
  dvTrigger(v);
  for (let b = 0; b < 90; b++) {
    if (b === 40) dvTrigger(v);
    if (b === 60 && c.type === DVT_HATC) dvChoke(v);
    if (dvUsesMetal(c.type) && (v.live || v.trig)) dvMetalRun(mb, m, CTL);
    dvRun(c, v, m, y, CTL);
    for (let i = 0; i < CTL; i++) { h = fnv(h, y[i]); peak = Math.max(peak, Math.abs(y[i])); }
  }
  return `${tag} v${variant} ${h.toString(16).padStart(16, "0")} ${peak}`;
}

const lines: string[] = [];
for (let variant = 0; variant < 3; variant++) {
  for (let t = 0; t < DVT_COUNT; t++) lines.push(runCase(`own${t}`, t, variant));
  for (let kit = 1; kit <= DV_NKIT; kit++) for (let lane = 0; lane < DV_NLANE; lane++) lines.push(runCase(`kit${kit}/${lane}`, DV_KTYPE(kit, lane), variant));
}
const gold = readFileSync("tests/drum-gold.txt", "utf8").trim().split("\n");
let bad = 0;
gold.forEach((g, i) => { if (g !== lines[i]) { bad++; if (bad < 6) console.log(`MISMATCH\n gold ${g}\n  got ${lines[i]}`); } });
console.log(bad ? `FAIL ${bad}/${gold.length}` : `OK ${gold.length} drum renders match`);
process.exit(bad ? 1 : 0);
