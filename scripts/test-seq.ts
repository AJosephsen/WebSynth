// Checks the track sequencer (polymeter timing, swing, ties, slides, ratchets, nudge, chance and conditions, TIME) against
// hashes of the note events of Felucca's seq.c compiled in a harness (tests/seq-gold.txt).
import { readFileSync } from "node:fs";
import { SeqStep, ST_NOTE, ST_REST, ST_TIE, TrackSeq, COND_FIRST, NCOND, seedSeqRng } from "../src/seq/trackseq";

const M = 0xffffffffffffffffn;
let rs = 0x9e3779b9;
const rnd = (): number => { rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs = rs >>> 0; return rs; };
let evh = 14695981039346656037n, nev = 0;
const logEv = (a: number, b: number, c: number): void => {
  for (const x of [a, b, c]) for (let k = 0; k < 4; k++) { evh ^= BigInt((x >>> (8 * k)) & 0xff); evh = (evh * 1099511628211n) & M; }
  nev++;
};
const out: string[] = [];
for (let cfg = 0; cfg < 150; cfg++) {
  rs = (0x9e3779b9 + Math.imul(cfg, 7919)) >>> 0;
  seedSeqRng((0x2545f491 + cfg) >>> 0);
  evh = 14695981039346656037n; nev = 0;
  let slide = false;
  const seq = new TrackSeq({ on: (n, v) => logEv(1, n, v | (slide ? 256 : 0)), off: (n) => logEv(2, n, 0), slide: (on) => { slide = on; } });
  const len = 1 + (rnd() % 32);
  const div = cfg % 5 === 0 ? rnd() % 10 : 2 + (rnd() % 3);
  const swing = cfg % 3 ? rnd() % 70 : 0;
  const gswing = cfg % 4 ? 0 : rnd() % 40;
  const gate = 30 + (rnd() % 98);
  const quantize = cfg % 2;
  const timeOn = cfg % 7 === 0;
  seq.p = { len, div, swing, gate, quantize };
  seq.globalSwing = gswing;
  seq.timeHook = (note, _vel, period) => (timeOn ? (note * 37) % (Math.floor(period / 3) + 1) : 0);
  const steps: SeqStep[] = [];
  for (let i = 0; i < len; i++) {
    const r = rnd();
    const nn = r % 3 === 0 ? 0 : 1 + ((r >>> 4) % 4);
    const notes: number[] = [];
    for (let k = 0; k < nn; k++) notes.push(36 + (rnd() % 48));
    const time = (r >>> 8) % 7 === 0 ? ST_REST : (r >>> 8) % 7 === 1 ? ST_TIE : ST_NOTE;
    const st: SeqStep = { notes, time, accent: (r >>> 12) % 4 === 0, slide: (r >>> 14) % 4 === 0, ratchet: (r >>> 16) % 6 === 0 ? 1 + ((r >>> 20) % 4) : 1 };
    if ((r >>> 18) % 3 === 0) st.nudge = (rnd() % 16) - 8;
    st.vel = (r >>> 22) % 3 ? 20 + (rnd() % 108) : 0;
    st.probability = (r >>> 24) % 5 === 0 ? 1 + (rnd() % 100) : (r >>> 24) % 7 === 0 ? COND_FIRST + (rnd() % NCOND) : 0;
    steps.push(st);
  }
  seq.steps = steps;
  seq.start();
  for (let blk = 0; blk < 4000; blk++) {
    seq.fill = blk >= 1500 && blk < 2500;
    seq.tick(32, 22050);
    logEv(9, seq.idx, seq.sounding);
  }
  out.push(`cfg ${cfg} len ${len} div ${div} sw ${swing} gate ${gate} qnt ${quantize} events ${nev} ${evh.toString(16).padStart(16, "0")}`);
}
const gold = readFileSync("tests/seq-gold.txt", "utf8").trimEnd().split("\n");
let bad = 0, first = "";
for (let i = 0; i < Math.max(gold.length, out.length); i++) if (gold[i] !== out[i]) { if (!first) first = `line ${i + 1}:\n  gold ${gold[i]}\n  ours ${out[i]}`; bad++; }
console.log(`seq: ${gold.length} configs, ${bad} differences${first ? "\n  first: " + first : ""}`);
if (bad) process.exit(1);
