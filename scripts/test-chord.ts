// Checks the chord keys against hashes of Felucca's chord.c compiled in a harness (tests/chord-gold.txt).
import { readFileSync } from "node:fs";
import { chordMake } from "../src/synth/chord";

const M = 0xffffffffffffffffn;
const fnv = (h: bigint, v: number): bigint => {
  const x = v >>> 0;
  for (let k = 0; k < 4; k++) { h ^= BigInt((x >>> (8 * k)) & 0xff); h = (h * 1099511628211n) & M; }
  return h;
};
const out: string[] = [];
for (let kit = 0; kit < 2; kit++) {
  for (let vm = 0; vm < 4; vm += kit ? 3 : 1) {
    for (let mode = 0; mode <= 10; mode++) {
      let h = 14695981039346656037n;
      for (let voic = 0; voic < 5; voic++)
        for (let scale = 0; scale < 16; scale++)
          for (let root = 0; root < 12; root += 5)
            for (let note = 0; note < 128; note++) {
              const c = chordMake({ chrd: mode, voic, root, scale, voice: vm, kit: !!kit }, note);
              h = fnv(h, c.notes.length); h = fnv(h, c.root); h = fnv(h, c.mask);
              for (let i = 0; i < 4; i++) h = fnv(h, c.notes[i] ?? 0);
            }
      out.push(`kit ${kit} vm ${vm} mode ${mode} ${h.toString(16).padStart(16, "0")}`);
    }
  }
}
const gold = readFileSync("tests/chord-gold.txt", "utf8").trimEnd().split("\n");
let bad = 0, first = "";
for (let i = 0; i < Math.max(gold.length, out.length); i++) if (gold[i] !== out[i]) { if (!first) first = `line ${i + 1}: gold ${gold[i]} ours ${out[i]}`; bad++; }
console.log(`chords: ${gold.length} lines, ${bad} differences${first ? "\n  first: " + first : ""}`);
if (bad) process.exit(1);
