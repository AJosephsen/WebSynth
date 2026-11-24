// Checks the PUNCH-IN FX (27 master effects) against hashes of Melodee's real punch.c compiled in a harness (tests/punch-harness.c,
// tests/punch-gold.txt): every effect at four tempi, with the song playing and stopped and two block patterns, plus random runs of
// key presses, song requests, restarts, tempo and transport jumps and resets; per scenario a running hash of every output sample.
import { readFileSync } from "node:fs";
import { sineI } from "../src/engines/dsp";
import { CTL, FS } from "../src/engines/types";
import { PUNCH_NFX, Punch, punchFxOfKey, punchKeyOfFx } from "../src/fx/punch";

let rs = 1;
const urnd = (): number => {
  rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs |= 0;
  return (rs >>> 0) >>> 17;
};
const fnv = (h: number, v: number): number => {
  v >>>= 0;
  for (let k = 0; k < 4; k++) h = Math.imul((h ^ ((v >>> (8 * k)) & 255)) >>> 0, 16777619) >>> 0;
  return h;
};
let ampShift = 0;
let sigL = 0, sigR = 0;
function signalAt(s: number): void {
  const env = s % 9000 < 4000 ? 4000 - (s % 9000) : 0;
  const a = sineI(Math.imul(s, 97391) >>> 0) >> 1, b = sineI((Math.imul(s, 41011) + 5555) >>> 0) >> 1;
  const nl = Math.trunc(((Math.imul(s, 2654435761 | 0) >>> 17) - 16384) / 4);
  const nr = Math.trunc(((Math.imul((Math.imul(s, 40503) + 7) | 0, 2246822519 | 0) >>> 17) - 16384) / 4);
  let x = Math.imul(a + nl, env >> 4) >> 5, y = Math.imul(b + nr, env >> 4) >> 5;
  if (s % 9000 === 0) { x += 12000; y -= 9000; }
  if (s % 20011 === 0) { x += 90000; y += 70000; }
  sigL = (x * 4) << ampShift; sigR = (y * 4) << ampShift;
}
const PAT = [[32, 32, 32, 32, 32, 32, 32, 32], [32, 7, 32, 1, 16, 32, 31, 5]];
const hex8 = (h: number): string => h.toString(16).padStart(8, "0");

const out: string[] = [];
function scen(name: string, seed: number, mode: number, fx0: number, bpm0: number, playing0: number, pattern: number, nblocks: number, amp: number): void {
  let h = 2166136261, sample = 0, nb = 0, nxt = 40;
  let req = -1, keybit = false, sreq = -1, sbuf = false, playing = playing0 !== 0;
  let bpm = bpm0, sgate = 0, patI = 0, hClock = 0;
  rs = (Math.imul(seed, 2654435761 | 0) + 12345) | 0; if (!rs) rs = 1;
  ampShift = amp;
  const p = new Punch();
  const l = new Int32Array(CTL), r = new Int32Array(CTL);
  out.push(`== ${name}`);
  let blk = 0;
  for (; blk < nblocks; blk++) {
    let doReset = false;
    if (mode === 0) {
      if (blk === 40) { req = fx0; keybit = true; }
      if (blk === Math.floor((nblocks * 2) / 3)) { req = -1; keybit = false; }
    } else if (blk >= nxt) {
      const c = urnd() % 12;
      nxt = blk + 1 + (urnd() % (c < 3 ? 40 : 260));
      if (c < 4) { req = urnd() % 27; keybit = true; }
      else if (c < 6) { req = -1; keybit = false; }
      else if (c === 6) { sreq = (urnd() % 28) - 1; sbuf = sreq >= 0 && (urnd() & 1) !== 0; }
      else if (c === 7) { sgate++; p.songGate = sgate; }
      else if (c === 8) bpm = 50 + (urnd() % 150);
      else if (c === 9) { playing = !playing; hClock = (urnd() * 3) >>> 0; }
      else if (c === 10) { sreq = -1; sbuf = false; }
      else doReset = true;
    }
    const beat = Math.floor((FS * 60) / bpm);
    if (hClock >= beat) hClock %= beat;
    p.beat = beat; p.playing = playing; p.clock = hClock;
    p.req = req; p.keyHeld = keybit;
    p.songReq = sreq; p.songBuffered = sbuf;
    if (doReset) p.reset();
    const n = PAT[pattern][patI++ & 7];
    for (let i = 0; i < n; i++) { signalAt(sample + i); l[i] = sigL; r[i] = sigR; }
    p.process(l, r, n);
    if (playing) { hClock += n; while (hClock >= beat) hClock -= beat; }
    sample += n;
    for (let i = 0; i < n; i++) { h = fnv(h, l[i]); h = fnv(h, r[i]); }
    if (++nb % 64 === 0) out.push(`${blk} ${hex8(h)}`);
  }
  out.push(`end ${blk} ${hex8(h)} g=${p.g} cur=${p.cur}`);
}
const BPMS = [60, 120, 174, 240];
let cfg = 0;
for (let fx = 0; fx < 27; fx++)
  for (let b = 0; b < 4; b++)
    for (let pl = 0; pl < 2; pl++)
      for (let pat = 0; pat < 2; pat++) {
        scen(`fx${fx} bpm${BPMS[b]} play${pl} pat${pat}`, fx * 8 + b * 2 + pl + 1, 0, fx, BPMS[b], pl, pat, pat ? 1100 : 1500, (fx + b) % 5 === 4 ? 2 : 0);
        cfg++;
      }
for (let s = 0; s < 120; s++) {
  scen(`random${s}`, 1000 + s, 1, -1, 90 + s, s & 1, s % 2, 2400, s % 7 === 6 ? 2 : 0);
  cfg++;
}
out.push(`configs ${cfg}`);

const gold = readFileSync("tests/punch-gold.txt", "utf8").trimEnd().split("\n");
let bad = 0, firstBad = "";
for (let i = 0; i < Math.max(gold.length, out.length); i++) {
  if (gold[i] !== out[i]) {
    if (!firstBad) { let sec = ""; for (let j = i; j >= 0; j--) if (gold[j]?.startsWith("== ")) { sec = gold[j]; break; } firstBad = `line ${i + 1} (${sec}): gold ${gold[i]} ours ${out[i]}`; }
    bad++;
  }
}
for (let k = 0; k < PUNCH_NFX; k++) if (punchFxOfKey(punchKeyOfFx(k)) !== k) { console.log(`punch: key map of effect ${k} broken`); process.exit(1); }
console.log(`punch: ${cfg} scenarios, ${gold.length} lines, ${bad} differences${firstBad ? "\n  first: " + firstBad : ""}`);
if (bad) process.exit(1);
