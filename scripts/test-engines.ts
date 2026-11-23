// Checks the ported engines against the 122 reference renders of Felucca-Engines (tests/engines-golden.txt).
import { readFileSync } from "node:fs";
import { renderPhrase } from "../src/engines/minihost";
import { EngineDef } from "../src/engines/types";
import { ANALOG_PRESETS, Preset } from "../src/engines/presets";
import { ENG_ANALOG } from "../src/engines/analog";

const ENGS: { id: string; e: EngineDef; presets: Preset[] }[] = [
  { id: "analog", e: ENG_ANALOG, presets: ANALOG_PRESETS },
];
const only = process.argv[2];
const lines: string[] = [];
const hex = (h: bigint) => h.toString(16).padStart(16, "0");
for (const { id, e, presets } of ENGS) {
  presets.forEach((pr, j) => {
    const r = renderPhrase(e, pr, 0);
    lines.push(`${id}/${j} ${hex(r.hash)} ${r.peak} ${pr.name}`);
  });
}
presets_ft: for (const { id, e, presets } of ENGS) {
  if (id !== "analog") continue;
  presets.forEach((pr, j) => {
    for (let ft = 1; ft <= 2; ft++) {
      const r = renderPhrase(e, pr, ft);
      lines.push(`analog/${j}/ftype${ft} ${hex(r.hash)} ${r.peak} ${pr.name}`);
    }
  });
  break presets_ft;
}
for (const { id, e } of ENGS) {
  const pr = { e: e.edit.map((d) => d.def), env: [0, 0, 0, 40] };
  for (let v = e.edit[0].min; v <= e.edit[0].max; v++) {
    pr.e[0] = v;
    const r = renderPhrase(e, pr, 0);
    lines.push(`${id}/e0=${v} ${hex(r.hash)} ${r.peak}`);
  }
}
const gold = readFileSync("tests/engines-golden.txt", "utf8").trim().split("\n");
const want = new Map(gold.map((l) => [l.split(" ")[0], l]));
let bad = 0, n = 0;
for (const l of lines) {
  if (only && !l.startsWith(only)) continue;
  n++;
  const g = want.get(l.split(" ")[0]);
  if (g !== l) { bad++; if (bad < 6) console.log(`MISMATCH\n gold ${g}\n  got ${l}`); }
}
console.log(bad ? `FAIL ${bad}/${n}` : `OK ${n} engine renders match`);
process.exit(bad ? 1 : 0);
