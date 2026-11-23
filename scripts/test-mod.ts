// Checks the ported modulation matrix and track LFO against reference output of Felucca's mod.c and voice.c
// (tests/mod-gold.txt, a trace of blocks and voices).
import { readFileSync } from "node:fs";
import { clamp, mulq15, pitchInc } from "../src/engines/dsp";
import {
  EngVoice, P_ATAMT, P_ATDST, P_CHOR, P_COUNT, P_DIST, P_DLY, P_E0, P_ED_FLT, P_ED_PIT, P_ED_SHP, P_LD_AMP, P_LD_FLT, P_LD_PIT,
  P_LD_SHP, P_LFADE, P_LPOL, P_LRATE, P_LSYNC, P_LWAVE, P_M1SRC, P_PAN, P_REV, Track, Vmod,
} from "../src/engines/types";
import {
  MD_AMP, MD_CHO, MD_CUT, MD_DEPTH, MD_DIST, MD_E1, MD_PAN, MD_PITCH, MD_RATE, MD_REV, MD_SHP, MD_TIME, MD_VEL, MD_VIB,
  MS_AT, MS_ENV, MS_EXPR, MS_KEY, MS_LFO, MS_MODW, MS_RAND, MS_SH, MS_SLEW, MS_VEL, Modulator, lfoTick,
} from "../src/mod/mod";

// the C harness numbers the parameters its own way: name them for the trace
const CID = new Map<number, number>([
  [P_LRATE, 1], [P_LWAVE, 2], [P_LFADE, 4], [P_LD_PIT, 5], [P_LD_FLT, 6], [P_LD_SHP, 7], [P_LD_AMP, 8], [P_ED_FLT, 9], [P_ED_PIT, 10],
  [P_ED_SHP, 11], [P_DIST, 12], [P_CHOR, 13], [P_DLY, 14], [P_REV, 15], [P_PAN, 16],
]);
for (let k = 0; k < 12; k++) CID.set(P_M1SRC + k, 18 + k);
CID.set(P_LSYNC, 30); CID.set(P_LPOL, 32); CID.set(P_ATDST, 33); CID.set(P_ATAMT, 34);
for (let k = 0; k < 8; k++) CID.set(P_E0 + k, 35 + k);

const EDIT = [[0, 127], [-64, 63], [0, 127], [0, 15], [0, 127], [-12, 12], [0, 127], [0, 1]];
const NV = 4;
const out: string[] = [];
const pr = (s: string): void => { out.push(s); };

let t: Track, mod: Modulator;
function init(): void {
  t = new Track();
  t.v = Array.from({ length: NV }, () => new EngVoice());
  t.edit = EDIT.map(([min, max]) => ({ label: "", fmt: 0, min, max, def: 0 }));
  t.exOff = 0;
  t.lfoFade = 32767;
  mod = new Modulator(t);
}
const slot = (k: number, s: number, d: number, a: number): void => { t.p[P_M1SRC + 3 * k] = s; t.p[P_M1SRC + 3 * k + 1] = d; t.p[P_M1SRC + 3 * k + 2] = a; };

function noteOn(vi: number, note: number, vel: number): void {
  const v = t.v[vi];
  vel = mod.note(note, vel);
  v.note = note; v.active = 1;
  v.mvel = t.mVel; v.mrnd = t.mRnd;
  t.mVi = vi;
  v.envOut = 0;
  pr(`NOTE ${note} vel=${vel} key=${t.mKey} rnd=${t.mRnd}`);
  v.mvel = vel;
}

function block(b: number): void {
  const keep = Int16Array.from(t.p);
  mod.begin();
  const w = mod.w;
  let lfo = mulq15(t.lfoVal, t.lfoFade);
  if (w.on && w.ldep < 32767) lfo = mulq15(lfo, w.ldep);
  lfoTick(t);
  let line = `B${b} on=${w.on} lfo=${lfo} fade=${t.lfoFade} ldep=${w.on ? w.ldep : 0} pit=${w.on ? w.pit : 0} cut=${w.on ? w.cut : 0} shp=${w.on ? w.shp : 0} gain=${w.on ? w.gain : 0} nv=${w.on ? w.nv : 0} nk=${w.on ? w.nk : 0}`;
  const ch: [number, number][] = [];
  for (let j = 0; j < P_COUNT; j++) if (t.p[j] !== keep[j]) ch.push([CID.get(j)!, t.p[j]]);
  ch.sort((a, b) => a[0] - b[0]);
  for (const [id, v] of ch) line += ` p${id}=${v}`;
  pr(line);
  for (let vi = 0; vi < NV; vi++) {
    const v = t.v[vi];
    if (!v.active) continue;
    const env = 32767 - ((b * 211 + vi * 5000) % 32768);
    const m: Vmod = { envq15: env, amp1: mulq15(env, 100 * 258), amp0: 0, pitch16: 0, inc: 0, cutoff: 0, shape: 0, fine: 7 };
    if (t.p[P_LD_AMP]) m.amp1 = mulq15(m.amp1, 32767 - mulq15(t.p[P_LPOL] ? lfo : (lfo + 32768) >> 1, t.p[P_LD_AMP] * 258));
    m.amp0 = v.envOut;
    v.envOut = m.amp1;
    const pitch = v.note * 16 + ((lfo * t.p[P_LD_PIT] * 3) >> 15) + ((m.envq15 * t.p[P_ED_PIT] * 3) >> 15);
    m.pitch16 = clamp(pitch, 0, 2047);
    m.inc = pitchInc(m.pitch16);
    m.inc = (m.inc + Math.imul(m.inc >>> 12, m.fine)) >>> 0;
    m.cutoff = ((lfo * t.p[P_LD_FLT]) >> 7) + ((m.envq15 * t.p[P_ED_FLT]) >> 7);
    m.shape = (64 << 8) + ((lfo * t.p[P_LD_SHP]) >> 7) + ((m.envq15 * t.p[P_ED_SHP]) >> 7);
    if (w.on) mod.voice(v, m, m.fine);
    pr(`  v${vi} p16=${m.pitch16} inc=${m.inc} cut=${m.cutoff} shp=${m.shape} a0=${m.amp0} a1=${m.amp1} eo=${v.envOut}`);
  }
  if (w.on) mod.end();
}

function run(name: string, cfg: () => void, nb: number): void {
  init();
  cfg();
  pr(`== ${name}`);
  for (let b = 0; b < nb; b++) {
    if (b === 0) noteOn(0, 60, 100);
    if (b === 9) noteOn(1, 72, 40);
    if (b === 30) noteOn(0, 48, 127);
    if (b === 13) t.mw = 90;
    if (b === 20) mod.midi(0xd0, 55, 0);
    if (b === 24) mod.midi(0xb0, 11, 50);
    if (b === 40) mod.midi(0xb0, 121, 0);
    block(b);
  }
}

function lfoFixed(): void {
  const p = t.p;
  p[P_LRATE] = 90; p[P_LWAVE] = 0; p[P_LFADE] = 60; p[P_LD_PIT] = 20; p[P_LD_FLT] = 30; p[P_LD_SHP] = -25; p[P_LD_AMP] = 40;
  p[P_ED_PIT] = 10; p[P_ED_FLT] = -20; p[P_ED_SHP] = 15; t.lfoFade = 0;
}

run("lfo-fixed", lfoFixed, 50);
run("tri-uni", () => {
  lfoFixed(); t.p[P_LWAVE] = 1; t.p[P_LPOL] = 1; t.p[P_LRATE] = 110;
  slot(0, MS_LFO, MD_CUT, 40); slot(1, MS_ENV, MD_PITCH, -30); slot(2, MS_LFO, MD_AMP, 30);
}, 50);
run("saw-sh", () => {
  t.p[P_LRATE] = 125; t.p[P_LWAVE] = 2;
  slot(0, MS_SH, MD_PITCH, 33); slot(1, MS_SLEW, MD_SHP, -50); slot(2, MS_SH, MD_PAN, 40); slot(3, MS_SLEW, MD_E1, 64);
}, 70);
run("sqr-perv", () => {
  t.p[P_LRATE] = 120; t.p[P_LWAVE] = 3; t.p[P_PAN] = 10; t.p[P_DIST] = 20; t.p[P_REV] = 90; t.p[P_E0 + 2] = 5;
  slot(0, MS_VEL, MD_DIST, 50); slot(1, MS_KEY, MD_REV, -64); slot(2, MS_RAND, MD_E1 + 2, 60); slot(3, MS_LFO, MD_PAN, 63);
  t.p[P_ATDST] = MD_CHO; t.p[P_ATAMT] = 40;
}, 50);
run("sh-wave", () => {
  t.p[P_LRATE] = 124; t.p[P_LWAVE] = 4; t.p[P_LFADE] = 100; t.lfoFade = 0; t.p[P_LD_PIT] = 30;
  slot(0, MS_MODW, MD_DEPTH, 64); slot(1, MS_EXPR, MD_AMP, -40); slot(2, MS_ENV, MD_RATE, 30); slot(3, MS_VEL, MD_AMP, 50);
  t.p[P_ATDST] = MD_VIB; t.p[P_ATAMT] = 30;
}, 70);
run("sync", () => {
  t.p[P_LSYNC] = 6; t.p[P_LWAVE] = 0; t.p[P_LD_PIT] = 25; t.p[P_LPOL] = 0;
  slot(0, MS_ENV, MD_DEPTH, -64); slot(1, MS_LFO, MD_SHP, 50); slot(2, MS_KEY, MD_PITCH, 20); slot(3, MS_RAND, MD_CUT, -40);
  t.p[P_LRATE] = 60;
}, 70);
run("note", () => {
  t.p[P_LRATE] = 80;
  slot(0, MS_RAND, MD_VEL, 40); slot(1, MS_LFO, MD_TIME, 64); slot(2, MS_KEY, MD_VEL, -20); t.p[P_LD_PIT] = 10;
}, 50);
pr("== time");
init();
t.p[P_LRATE] = 80;
slot(0, MS_RAND, MD_VEL, 40); slot(1, MS_LFO, MD_TIME, 64); slot(2, MS_KEY, MD_VEL, -20); t.p[P_LD_PIT] = 10;
for (let i = 0; i < 10; i++) {
  t.lfoVal = i * 6000 - 20000;
  pr(`t${i} ${mod.time(60 + i, 100, 5000 + i * 700)}`);
}
void MD_SHP; void MD_PITCH; void MD_REV; void MD_AMP; void MD_PAN; void MD_TIME; void MD_VEL; void MS_AT; void MS_RAND;

const gold = readFileSync("tests/mod-gold.txt", "utf8").trimEnd().split("\n");
let bad = 0;
for (let i = 0; i < Math.max(gold.length, out.length); i++) {
  if (gold[i] !== out[i]) {
    if (bad++ < 5) console.error(`line ${i + 1}\n  gold: ${gold[i]}\n  ours: ${out[i]}`);
  }
}
console.log(`mod: ${gold.length} lines, ${bad} differences`);
if (bad) process.exit(1);
