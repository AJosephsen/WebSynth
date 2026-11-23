// Checks the ported Felucca engines (VOICE, PHYS, GRAIN) against reference renders of the C code (tests/*-gold.txt).
import { readFileSync } from "node:fs";
import { renderPhrase } from "../src/engines/minihost";
import { EngineDef } from "../src/engines/types";
import { Preset } from "../src/engines/presets";
import { FORMANT_PRESETS } from "../src/engines/presets-felucca";
import { ENG_FORMANT } from "../src/engines/formant";

const ENGS: { id: string; e: EngineDef; presets: Preset[]; gold: string }[] = [
  { id: "voice", e: ENG_FORMANT, presets: FORMANT_PRESETS, gold: "tests/voice-gold.txt" },
];
const hex = (h: bigint) => h.toString(16).padStart(16, "0");
let total = 0, bad = 0;
for (const { id, e, presets, gold } of ENGS) {
  const lines: string[] = [];
  presets.forEach((pr, j) => {
    const r = renderPhrase(e, pr, 0, false);
    lines.push(`${id}/${j} ${hex(r.hash)} ${r.peak} ${pr.name}`);
  });
  for (let k = 0; k < 8; k++) {
    const lo = e.edit[k].min, hi = e.edit[k].max;
    const step = Math.trunc((hi - lo) / 6) || 1;
    for (let v = lo; v <= hi; v += step) {
      const pr = { e: e.edit.map((d) => d.def), env: [0, 0, 0, 40] };
      pr.e[k] = v;
      const r = renderPhrase(e, pr, 0, false);
      lines.push(`${id}/e${k}=${v} ${hex(r.hash)} ${r.peak}`);
    }
  }
  const g = readFileSync(gold, "utf8").trim().split("\n");
  g.forEach((l, i) => {
    total++;
    if (l !== lines[i]) { bad++; if (bad < 6) console.log(`MISMATCH ${id}\n gold ${l}\n  got ${lines[i]}`); }
  });
  if (g.length !== lines.length) { bad++; console.log(`${id}: ${lines.length} renders, gold has ${g.length}`); }
}
console.log(bad ? `FAIL ${bad}/${total}` : `OK ${total} Felucca engine renders match`);
process.exit(bad ? 1 : 0);
