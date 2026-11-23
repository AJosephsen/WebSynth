// Checks the voice layer (POLY / MONO / LEGATO / UNISON allocation, priorities, glide, detune) against hashes of the voice
// state after random note streams, from Felucca's voice.c compiled in a harness (tests/voice-layer-gold.txt).
import { readFileSync } from "node:fs";
import { EngVoice, P_ALLOC, P_DETUNE, P_GLIDE, P_GLMODE, P_PRIO, P_VOICE, Track } from "../src/engines/types";
import { VoiceEngine, VoiceLayer } from "../src/synth/voicelayer";

const M = 0xffffffffffffffffn;
const fnv = (h: bigint, v: number): bigint => {
  const x = v >>> 0;
  for (let k = 0; k < 4; k++) { h ^= BigInt((x >>> (8 * k)) & 0xff); h = (h * 1099511628211n) & M; }
  return h;
};
let rs = 0x2468ace;
const rnd = (): number => { rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs = rs >>> 0; return rs; };

const stub = (t: Track, v: EngVoice): void => { void t; v.ph[0] = Math.imul(0x11111111, v.note + 1) >>> 0; v.s[0] = 100 + v.note; v.s[4] = 4; v.s[5] = 5; };
const ENG: VoiceEngine[] = [
  { poly: 0, sampled: false, keep: 0xf3, noteOn: stub },
  { poly: 3, sampled: false, keep: 0x03, noteOn: stub },
  { poly: 0, sampled: true, keep: 0xff, noteOn: stub },
];
const out: string[] = [];
const modes = [0, 1, 2, 3];
for (let cfg = 0; cfg < 48; cfg++) {
  const t = new Track();
  t.v = Array.from({ length: 8 }, () => new EngVoice());
  const e = ENG[cfg % 3 === 1 ? 1 : cfg % 3 === 2 ? 2 : 0];
  t.p[P_VOICE] = modes[Math.floor(cfg / 3) % 4];
  t.p[P_GLIDE] = Math.floor(cfg / 12) % 2 ? 40 : 0;
  t.p[P_GLMODE] = Math.floor(cfg / 24) % 2;
  t.p[P_PRIO] = cfg % 3;
  t.p[P_ALLOC] = Math.floor(cfg / 5) % 2;
  t.p[P_DETUNE] = (cfg * 3) % 128;
  const layer = new VoiceLayer(t, t.v, e, (note, vel) => { t.mVel = vel; t.mRnd = (note * 77) << 16 >> 16; return vel; });
  rs = (0x2468ace + cfg * 7919) >>> 0;
  out.push(`== cfg ${cfg} engine ${cfg % 3 === 1 ? 1 : cfg % 3 === 2 ? 2 : 0} voice ${t.p[P_VOICE]} glide ${t.p[P_GLIDE]} glmode ${t.p[P_GLMODE]} prio ${t.p[P_PRIO]} alloc ${t.p[P_ALLOC]} detune ${t.p[P_DETUNE]}`);
  const held: number[] = [];
  for (let ev = 0; ev < 400; ev++) {
    const r = rnd(), act = r % 10;
    if (ev % 150 === 77) layer.slideGlide = r & 1;
    if (act < 5 || held.length === 0) {
      const note = 36 + ((r >>> 8) % 48), vel = 20 + ((r >>> 16) % 108);
      layer.noteOn(note, vel);
      if (!held.includes(note) && held.length < 16) held.push(note);
    } else if (act < 9) {
      const j = (r >>> 8) % held.length, note = held[j];
      layer.noteOff(note);
      held[j] = held[held.length - 1];
      held.pop();
    } else if (ev % 40 === 9) {
      layer.allOff();
      held.length = 0;
    }
    if (ev % 3 === 0) {
      for (const v of t.v) {
        if (v.active && v.stage === 3 && (rnd() & 3) === 0) { v.active = 0; v.stage = 0; v.env = 0; }
        if (v.active && v.stage === 1) v.stage = 2;
        if (v.pitchCur !== v.pitch16) {
          const d = v.pitch16 - v.pitchCur, st = v.gstep ? v.gstep : 40;
          v.pitchCur += d > 0 ? (d < st ? d : st) : -d < st ? d : -st;
        }
      }
    }
    let h = 14695981039346656037n;
    for (let i = 0; i < 8; i++) {
      const v = t.v[i];
      for (const x of [v.note, v.vel, v.gate, v.active, v.stage, v.side, v.env, v.pitch16, v.pitchCur, v.gstep, v.fine, v.ph[0], v.s[0], v.age, v.mvel, v.mrnd, v.s[4]]) h = fnv(h, x);
    }
    for (const x of [layer.nmono, layer.monoNote, layer.rr, layer.spAlt, t.lfoPh, t.lfoFade]) h = fnv(h, x);
    for (let i = 0; i < 8; i++) h = fnv(h, layer.monoStack[i]);
    out.push(`${ev} ${h.toString(16).padStart(16, "0")}`);
  }
}
const gold = readFileSync("tests/voice-layer-gold.txt", "utf8").trimEnd().split("\n");
let bad = 0, first = "";
for (let i = 0; i < Math.max(gold.length, out.length); i++) if (gold[i] !== out[i]) { if (!first) first = `line ${i + 1}: gold ${gold[i]} ours ${out[i]}`; bad++; }
console.log(`voice layer: ${gold.length} lines, ${bad} differences${first ? "\n  first: " + first : ""}`);
if (bad) process.exit(1);
