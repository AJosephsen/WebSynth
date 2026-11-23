// Checks the arpeggiator against hashes of the note events of Felucca's seq.c arp, compiled in a harness (tests/arp-gold.txt).
import { readFileSync } from "node:fs";
import { Arp, seedArpRng } from "../src/synth/arp";

const M = 0xffffffffffffffffn;
let rs = 0x1357bd;
const rnd = (): number => { rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs = rs >>> 0; return rs; };
let evh = 14695981039346656037n, nev = 0;
const logEv = (a: number, b: number, c: number): void => {
  for (const x of [a, b, c]) for (let k = 0; k < 4; k++) { evh ^= BigInt((x >>> (8 * k)) & 0xff); evh = (evh * 1099511628211n) & M; }
  nev++;
};
const out: string[] = [];
for (let cfg = 0; cfg < 120; cfg++) {
  const mode = 1 + (cfg % 14);
  evh = 14695981039346656037n; nev = 0;
  seedArpRng((0x2545f491 + cfg) >>> 0);
  const arp = new Arp({ on: (n, v) => logEv(1, n, v), off: (n) => logEv(2, n, 0) });
  arp.p = {
    mode, rate: cfg % 7 < 4 ? 2 + (cfg % 4) : cfg % 6, oct: 1 + (Math.floor(cfg / 3) % 4), gate: 20 + ((cfg * 11) % 100),
    swing: Math.floor(cfg / 5) % 3 ? (cfg * 7) % 60 : 0, prob: Math.floor(cfg / 7) % 4 ? 127 : 90, hold: Math.floor(cfg / 11) % 3 === 0,
    order: Math.floor(cfg / 13) % 2 === 1,
  };
  rs = (0x1357bd + Math.imul(cfg, 104729)) >>> 0;
  const held: number[] = [];
  for (let blk = 0; blk < 1500; blk++) {
    const r = rnd();
    if (blk % 29 === 3) {
      const note = 40 + ((r >>> 8) % 40);
      if (held.length < 6) { arp.add(note); if (!held.includes(note)) held.push(note); }
    }
    if (blk % 47 === 20 && held.length) {
      const j = (r >>> 9) % held.length;
      arp.remove(held[j]);
      held[j] = held[held.length - 1];
      held.pop();
    }
    arp.step(32, 22050);
    logEv(9, blk, arp.note);
  }
  out.push(`cfg ${cfg} mode ${mode} events ${nev} ${evh.toString(16).padStart(16, "0")}`);
}
const gold = readFileSync("tests/arp-gold.txt", "utf8").trimEnd().split("\n");
let bad = 0, first = "";
for (let i = 0; i < Math.max(gold.length, out.length); i++) if (gold[i] !== out[i]) { if (!first) first = `line ${i + 1}: gold ${gold[i]} ours ${out[i]}`; bad++; }
console.log(`arp: ${gold.length} configs, ${bad} differences${first ? "\n  first: " + first : ""}`);
if (bad) process.exit(1);
