// Checks Melodee's drum kits (KIT 808, 909, CR78, FM) against reference renders of the real firmware sources compiled in a
// harness (tests/melodee-drum-harness.c, tests/melodee-drum-gold.txt): the shared helpers, then every GM note at two velocities
// and four knob sets, each of the 16 sounds to its end, and 600 random sequences (knobs, lane levels, HIT-page edits, event pitch
// and length). Every output sample of the part is hashed; any difference fails.
import { readFileSync } from "node:fs";
import { CTL } from "../src/engines/types";
import { sineI, softclip } from "../src/engines/dsp";
import { DK_808, DK_909, DK_CR78, DK_FM, MelodeeDrum } from "../src/drum/mkit";
import { Dither, pow2q16 } from "../src/drum/mdsp";
import { fmExp2f, fmExpf, fmLog2f, fmSinf, fmTanf } from "../src/drum/fastmath";
import { TANH_TAB } from "../src/drum/m909";
import { DRUM_PRESETS, DrumSynth } from "../src/drum/drumsynth";
import { drumEntries } from "../src/instruments";

const f = Math.fround;
const M32 = 0x100000000;
class Fnv {
  hi = 0xcbf29ce4;
  lo = 0x84222325;
  /** FNV-1a 64 of the four little-endian bytes of x */
  add(x: number): void {
    for (let k = 0; k < 4; k++) {
      this.lo = (this.lo ^ ((x >>> (8 * k)) & 255)) >>> 0;
      const pl = this.lo * 0x1b3;
      const carry = Math.floor(pl / M32);
      this.hi = (this.hi * 0x1b3 + carry + ((this.lo << 8) >>> 0)) % M32;
      this.lo = pl % M32;
    }
  }
  hex(): string { return this.hi.toString(16).padStart(8, "0") + this.lo.toString(16).padStart(8, "0"); }
}

const lines: string[] = [];
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bits = (x: number): number => { f32[0] = x; return u32[0]; };

// the shared helpers
{
  let h = new Fnv();
  for (let d = -3072; d <= 3072; d++) h.add(pow2q16(d));
  lines.push(`unit pow2 ${h.hex()}`); h = new Fnv();
  for (let x = -40000; x <= 40000; x += 3) h.add(softclip(x) >>> 0);
  lines.push(`unit softclip ${h.hex()}`); h = new Fnv();
  for (let ph = 0; ph < 0xffffffff - 0x100003; ph += 0x100003) h.add(sineI(ph) >>> 0);
  lines.push(`unit sine ${h.hex()}`); h = new Fnv();
  for (let k = 0; k < 1025; k++) h.add(bits(TANH_TAB[k]));
  lines.push(`unit tanh ${h.hex()}`); h = new Fnv();
  const dt = new Dither();
  for (let k = 0; k < 2000; k++) { dt.block(); for (let j = 0; j < 32; j++) h.add(dt.t[j] >>> 0); }
  lines.push(`unit dither ${h.hex()}`); h = new Fnv();
  for (let k = 0; k < 256; k++) {
    h.add(bits(fmExp2f(f(f(k - 128) / 7))));
    h.add(bits(fmTanf(f(f(k) * f(0.0061)))));
    h.add(bits(fmLog2f(f(f(f(k) * f(0.37)) + f(0.01)))));
    h.add(bits(fmExpf(f(f(k - 128) / 9))));
    h.add(bits(fmSinf(f(f(k - 128) * f(0.31)))));
  }
  lines.push(`unit fastmath ${h.hex()}`);
}

// the case generator of the harness
let rs = 0;
const rnd = (): number => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs >>> 8; };
const rn = (n: number): number => rnd() % n;

interface Ev { block: number; note: number; vel: number; pitch: number; len: number }
const KITV = [DK_808, DK_909, DK_CR78, DK_FM];
const KN = ["808", "909", "cr78", "fm"];
const SOUND_NOTE = [36, 38, 41, 45, 50, 37, 39, 42, 46, 49, 51, 64, 61, 60, 75, 70];
const V = [[0, 64, 64, 64, 64, 100, 0, 0], [0, 20, 100, 30, 110, 40, 1, 60], [0, 110, 10, 120, 5, 127, 0, 0], [0, 64, 64, 64, 64, 100, 1, 127]];
const LN127 = [127, 127, 127, 127, 127, 127, 127, 127];

function renderCase(tag: string, kit: number, e: number[], ln: number[], patch: Int8Array | null, ev: Ev[], nblocks: number): void {
  const d = new MelodeeDrum(KITV[kit], e);
  d.ln = [...ln];
  if (patch) d.patch.set(patch);
  const out = new Int32Array(CTL);
  const h = new Fnv();
  let peak = 0;
  for (let b = 0; b < nblocks; b++) {
    for (const x of ev) {
      if (x.block !== b) continue;
      d.eventPitch = x.pitch;
      d.eventLength = x.len;
      d.noteOn(x.note, x.vel);
      d.eventPitch = 0;
      d.eventLength = 0;
    }
    out.fill(0);
    d.block(out);
    for (let k = 0; k < CTL; k++) {
      h.add(out[k] >>> 0);
      peak = Math.max(peak, Math.abs(out[k]));
    }
  }
  lines.push(`${tag} ${h.hex()} ${peak}`);
}

for (let kit = 0; kit < 4; kit++) {
  for (let n = 35; n <= 81; n++)
    for (let v = 0; v < 4; v++)
      for (let c = 0; c < 2; c++)
        renderCase(`${KN[kit]}/n${n}/v${v}/${c}`, kit, V[v], LN127, null, [{ block: 0, note: n, vel: c ? 110 : 30, pitch: 0, len: 0 }], 120);
  for (let i = 0; i < 16; i++) renderCase(`${KN[kit]}/long${i}`, kit, V[0], LN127, null, [{ block: 0, note: SOUND_NOTE[i], vel: 100, pitch: 0, len: 0 }], 4500);
  for (let c = 0; c < 150; c++) {
    const np = 2 + rn(5), ne = 6 + rn(10);
    let t = 0;
    const usepatch = rn(3) === 0, uselane = rn(3) === 0;
    rs = (0x1234567 + Math.imul(c, 7919) + Math.imul(kit, 104729)) >>> 0;
    const e = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 1; i < 8; i++) e[i] = i === 6 ? rn(2) : i === 7 ? (rn(3) ? 0 : rn(128)) : rn(128);
    const ln = Array.from({ length: 8 }, () => (uselane ? rn(128) : 127));
    const patch = new Int8Array(64);
    if (usepatch)
      for (let i = 0; i < 16; i++) {
        patch[i * 4] = rn(49) - 24;
        patch[i * 4 + 1] = rn(128) - 64;
        patch[i * 4 + 2] = rn(128) - 64;
        patch[i * 4 + 3] = rn(128);
      }
    const pool: number[] = [];
    for (let i = 0; i < np; i++) pool.push(rn(5) === 0 ? 35 + rn(47) : SOUND_NOTE[rn(16)]);
    if (rn(2)) { pool[0] = 42; if (np > 1) pool[1] = 46; if (np > 2) pool[2] = 44; }
    const ev: Ev[] = [];
    for (let i = 0; i < ne; i++) {
      t += rn(24);
      const block = t;
      const note = pool[rn(np)];
      const vel = 1 + rn(127);
      const pitch = rn(4) === 0 ? rn(33) - 16 : 0;
      const len = rn(5) === 0 ? 200 + rn(8000) : 0;
      ev.push({ block, note, vel, pitch, len });
    }
    renderCase(`${KN[kit]}/seq${c}`, kit, e, ln, patch, ev, t + 200 + rn(300));
  }
}

// the instrument: the factory entries, the playable DrumSynth on each Melodee KIT, the pad maps
let bad = 0;
const must = (ok: boolean, what: string): void => { if (!ok) { bad++; console.log(`FAIL ${what}`); } };
for (const name of ["808 KIT", "909 KIT", "CR78 KIT", "FM KIT"]) must(drumEntries.some((e) => e.id === `DRUM/${name}`), `entry DRUM/${name}`);
for (const k of [12, 13, 14, 15]) {
  const ps = DRUM_PRESETS.find((x) => x.params[0] === k)!;
  const s = new DrumSynth(ps.params);
  s.noteOn(36, 110);
  s.noteOn(42, 90);
  const buf = new Float32Array(4410);
  s.render(buf, 0, 4410);
  must(buf.some((x) => Math.abs(x) > 0.02) && buf.every((x) => Math.abs(x) < 4), `DrumSynth kit ${k} sounds, within range`);
  must(s.activeVoices >= 0, `kit ${k} voices`);
}
const dk909 = new DrumSynth([13, 64, 64, 64, 64, 100, 0, 0]), dk808 = new DrumSynth([12, 64, 64, 64, 64, 100, 0, 0]);
must(dk808.mpcNote(0) === 36 && dk808.mpcNote(6) === 56 && dk808.mpcNote(11) === 70 && dk909.mpcNote(6) === 51 && dk909.mpcNote(11) === 51, "MPC pad maps");

const gold = readFileSync("tests/melodee-drum-gold.txt", "utf8").trim().split("\n");
gold.forEach((g, i) => {
  if (g !== lines[i]) {
    bad++;
    if (bad < 8) console.log(`MISMATCH\n gold ${g}\n  got ${lines[i]}`);
  }
});
if (lines.length !== gold.length) { bad++; console.log(`count: gold ${gold.length} got ${lines.length}`); }
console.log(bad ? `FAIL ${bad}/${gold.length}` : `OK ${gold.length} Melodee drum renders match`);
process.exit(bad ? 1 : 0);
